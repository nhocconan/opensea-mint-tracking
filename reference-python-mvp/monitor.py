#!/usr/bin/env python3
"""Robinhood Chain OpenSea drop discovery and wallet eligibility monitor.

Uses only Python's standard library. State is stored in SQLite so repeated runs
do not re-alert or re-fetch unchanged drops unnecessarily.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


API_BASE = "https://api.opensea.io"
DROP_TYPES = ("featured", "upcoming", "recently_minted")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def require_wallet_address() -> str:
    """No wallet is baked into the code: WALLET_ADDRESS must be supplied."""
    wallet = os.getenv("WALLET_ADDRESS", "").strip()
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", wallet):
        raise SystemExit(
            "WALLET_ADDRESS is required and must be a 0x-prefixed, 40-hex-character "
            "EVM address. Copy env.example to .env and set it."
        )
    return wallet


def env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    return default if value is None else value.lower() in {"1", "true", "yes", "on"}


def pick(data: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in data:
            return data[key]
    return default


@dataclass
class Config:
    wallet: str
    chain: str
    interval_seconds: int
    db_path: Path
    api_key_file: Path
    api_key: str | None
    wallet_jwt: str | None
    wallet_pat: str | None
    webhook_url: str | None
    telegram_bot_token: str | None
    telegram_chat_id: str | None
    once: bool
    verbose: bool

    @classmethod
    def load(cls, args: argparse.Namespace) -> "Config":
        state_dir = Path(os.getenv("STATE_DIR", ".state"))
        state_dir.mkdir(parents=True, exist_ok=True)
        return cls(
            wallet=require_wallet_address(),
            chain=os.getenv("OPENSEA_CHAIN", "robinhood"),
            interval_seconds=int(os.getenv("POLL_INTERVAL_SECONDS", str(args.interval * 60))),
            db_path=state_dir / "mint-watch.sqlite3",
            api_key_file=state_dir / "opensea-key.json",
            api_key=os.getenv("OPENSEA_API_KEY"),
            wallet_jwt=os.getenv("OPENSEA_WALLET_JWT"),
            wallet_pat=os.getenv("OPENSEA_WALLET_PAT"),
            webhook_url=os.getenv("ALERT_WEBHOOK_URL"),
            telegram_bot_token=os.getenv("TELEGRAM_BOT_TOKEN"),
            telegram_chat_id=os.getenv("TELEGRAM_CHAT_ID"),
            once=args.once,
            verbose=args.verbose,
        )


class ApiError(RuntimeError):
    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(f"OpenSea HTTP {status}: {message}")
        self.status = status
        self.body = body


class OpenSeaClient:
    def __init__(self, config: Config):
        self.config = config
        self.managed_instant_key = config.api_key is None
        self.api_key_expires_at = float("inf") if config.api_key else 0.0
        self.api_key = config.api_key or self._load_or_create_instant_key()
        self.wallet_token = config.wallet_jwt
        self.wallet_token_expiry = 0.0

    def _raw_request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        authenticated: bool = False,
        include_api_key: bool = True,
    ) -> dict[str, Any]:
        headers = {"Accept": "application/json", "User-Agent": "robinhood-mint-watch/0.1"}
        if include_api_key and self.managed_instant_key and time.time() > self.api_key_expires_at - 3600:
            self.api_key = self._load_or_create_instant_key(force=True)
        if include_api_key and getattr(self, "api_key", None):
            headers["X-API-KEY"] = self.api_key
        if authenticated:
            token = self._get_wallet_token()
            if not token:
                raise ApiError(401, "wallet auth missing; set OPENSEA_WALLET_PAT or OPENSEA_WALLET_JWT")
            headers["Authorization"] = f"Bearer {token}"
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(API_BASE + path, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read().decode()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode(errors="replace")
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = raw
            if exc.code == 429:
                retry = exc.headers.get("Retry-After", "60")
                raise ApiError(exc.code, f"rate limited; retry after {retry}s", parsed) from exc
            raise ApiError(exc.code, str(parsed), parsed) from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"network error: {exc.reason}") from exc

    def _load_or_create_instant_key(self, force: bool = False) -> str:
        path = self.config.api_key_file
        if path.exists() and not force:
            try:
                cached = json.loads(path.read_text())
                expires_at = datetime.fromisoformat(cached["expires_at"].replace("Z", "+00:00"))
                if expires_at.timestamp() > time.time() + 3600:
                    self.api_key_expires_at = expires_at.timestamp()
                    return cached["api_key"]
            except (KeyError, ValueError, json.JSONDecodeError):
                pass
        data = self._raw_request("POST", "/api/v2/auth/keys", include_api_key=False)
        key = pick(data, "api_key", "apiKey")
        if not key:
            raise RuntimeError("OpenSea did not return an instant API key")
        expiry_text = pick(data, "expires_at", "expiresAt")
        if expiry_text:
            self.api_key_expires_at = datetime.fromisoformat(str(expiry_text).replace("Z", "+00:00")).timestamp()
        else:
            self.api_key_expires_at = time.time() + 6 * 24 * 3600
        path.write_text(json.dumps(data, indent=2))
        path.chmod(0o600)
        return key

    def _get_wallet_token(self) -> str | None:
        if self.wallet_token and (not self.config.wallet_pat or time.time() < self.wallet_token_expiry - 300):
            return self.wallet_token
        if not self.config.wallet_pat:
            return self.wallet_token
        data = self._raw_request(
            "POST",
            "/api/v2/auth/tokens/exchange",
            body={"subjectToken": self.config.wallet_pat, "subjectTokenType": "ACCESS_TOKEN"},
            authenticated=False,
            include_api_key=False,
        )
        self.wallet_token = pick(data, "accessToken", "access_token", "token")
        expires_in = int(pick(data, "expiresIn", "expires_in", default=43200))
        self.wallet_token_expiry = time.time() + expires_in
        return self.wallet_token

    def get_drops(self, drop_type: str, chain: str, limit: int = 100) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        cursor: str | None = None
        for _ in range(10):
            query: dict[str, Any] = {"type": drop_type, "limit": limit, "chains": chain}
            if cursor:
                query["cursor"] = cursor
            path = "/api/v2/drops?" + urllib.parse.urlencode(query)
            try:
                data = self._raw_request("GET", path)
            except ApiError as exc:
                # New chains occasionally land before their enum is documented.
                if exc.status == 400 and chain:
                    query.pop("chains", None)
                    data = self._raw_request("GET", "/api/v2/drops?" + urllib.parse.urlencode(query))
                else:
                    raise
            page = pick(data, "drops", "results", default=[])
            results.extend(item for item in page if isinstance(item, dict))
            cursor = pick(data, "next", "next_cursor", "nextCursor")
            if not cursor:
                break
        return results

    def get_drop(self, slug: str) -> dict[str, Any]:
        return self._raw_request("GET", "/api/v2/drops/" + urllib.parse.quote(slug, safe=""))

    def get_eligibility(self, slug: str) -> dict[str, Any]:
        return self._raw_request(
            "GET",
            "/api/v2/drops/" + urllib.parse.quote(slug, safe="") + "/eligibility",
            authenticated=True,
        )


class Store:
    def __init__(self, path: Path):
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS drops (
              slug TEXT PRIMARY KEY,
              name TEXT, chain TEXT, source_type TEXT,
              raw_json TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS checks (
              slug TEXT NOT NULL, wallet TEXT NOT NULL, checked_at TEXT NOT NULL,
              eligible INTEGER NOT NULL, raw_json TEXT NOT NULL,
              PRIMARY KEY (slug, wallet)
            );
            CREATE TABLE IF NOT EXISTS alerts (
              alert_key TEXT PRIMARY KEY, sent_at TEXT NOT NULL
            );
            """
        )

    def upsert_drop(self, slug: str, name: str, chain: str, source_type: str, raw: dict[str, Any]) -> bool:
        now = utc_now()
        existing = self.db.execute("SELECT 1 FROM drops WHERE slug=?", (slug,)).fetchone()
        self.db.execute(
            """INSERT INTO drops(slug,name,chain,source_type,raw_json,first_seen,last_seen)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(slug) DO UPDATE SET name=excluded.name, chain=excluded.chain,
               source_type=excluded.source_type, raw_json=excluded.raw_json, last_seen=excluded.last_seen""",
            (slug, name, chain, source_type, json.dumps(raw), now, now),
        )
        self.db.commit()
        return existing is None

    def record_check(self, slug: str, wallet: str, eligible: bool, raw: dict[str, Any]) -> None:
        self.db.execute(
            """INSERT INTO checks(slug,wallet,checked_at,eligible,raw_json) VALUES(?,?,?,?,?)
               ON CONFLICT(slug,wallet) DO UPDATE SET checked_at=excluded.checked_at,
               eligible=excluded.eligible, raw_json=excluded.raw_json""",
            (slug, wallet.lower(), utc_now(), int(eligible), json.dumps(raw)),
        )
        self.db.commit()

    def should_alert(self, key: str) -> bool:
        return self.db.execute("SELECT 1 FROM alerts WHERE alert_key=?", (key,)).fetchone() is None

    def mark_alerted(self, key: str) -> None:
        self.db.execute("INSERT OR IGNORE INTO alerts(alert_key,sent_at) VALUES(?,?)", (key, utc_now()))
        self.db.commit()


def drop_slug(item: dict[str, Any]) -> str | None:
    value = pick(item, "collection_slug", "collectionSlug", "slug")
    return str(value) if value else None


def drop_name(item: dict[str, Any], slug: str) -> str:
    return str(pick(item, "collection_name", "collectionName", "name", default=slug))


def drop_chain(item: dict[str, Any]) -> str:
    chain = pick(item, "chain", "chain_name", "chainName", default="")
    if isinstance(chain, dict):
        chain = pick(chain, "identifier", "name", "slug", default="")
    return str(chain).lower()


def stage_rows(data: dict[str, Any]) -> list[dict[str, Any]]:
    stages = pick(data, "stages", "eligibility", "results", default=[])
    if isinstance(stages, dict):
        stages = pick(stages, "stages", "results", default=[])
    return [row for row in stages if isinstance(row, dict)]


def eligible_stages(data: dict[str, Any]) -> list[dict[str, Any]]:
    rows = stage_rows(data)
    return [row for row in rows if pick(row, "isEligible", "is_eligible", "eligible", default=False)]


def send_alert(config: Config, text: str) -> None:
    print(text, flush=True)
    if config.webhook_url:
        payload = json.dumps({"text": text, "content": text}).encode()
        request = urllib.request.Request(
            config.webhook_url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=20):
            pass
    if config.telegram_bot_token and config.telegram_chat_id:
        url = f"https://api.telegram.org/bot{config.telegram_bot_token}/sendMessage"
        payload = urllib.parse.urlencode({"chat_id": config.telegram_chat_id, "text": text}).encode()
        request = urllib.request.Request(url, data=payload, method="POST")
        with urllib.request.urlopen(request, timeout=20):
            pass


def run_cycle(config: Config, client: OpenSeaClient, store: Store) -> dict[str, int]:
    stats = {"found": 0, "new": 0, "checked": 0, "eligible": 0, "errors": 0}
    candidates: dict[str, tuple[str, dict[str, Any]]] = {}
    for kind in DROP_TYPES:
        for item in client.get_drops(kind, config.chain):
            slug = drop_slug(item)
            if not slug:
                continue
            chain = drop_chain(item)
            # If server rejected chain filtering, keep only identifiable Robinhood rows.
            if chain and config.chain not in chain and chain not in {"4663", "robinhood_chain"}:
                continue
            candidates[slug] = (kind, item)

    stats["found"] = len(candidates)
    for slug, (kind, item) in sorted(candidates.items()):
        name = drop_name(item, slug)
        is_new = store.upsert_drop(slug, name, drop_chain(item) or config.chain, kind, item)
        stats["new"] += int(is_new)
        if config.verbose:
            print(f"DISCOVERED {kind:16} {slug}")
        if not (config.wallet_jwt or config.wallet_pat):
            continue
        try:
            eligibility = client.get_eligibility(slug)
            hits = eligible_stages(eligibility)
            store.record_check(slug, config.wallet, bool(hits), eligibility)
            stats["checked"] += 1
            if not hits:
                continue
            stats["eligible"] += 1
            for index, stage in enumerate(hits):
                label = str(pick(stage, "label", "name", "stageName", "stage_type", default=f"stage-{index}"))
                alert_key = f"{config.wallet.lower()}:{slug}:{label}"
                if not store.should_alert(alert_key):
                    continue
                price = pick(stage, "price", "mintPrice", "mint_price", default="?")
                maximum = pick(stage, "maxPerWallet", "max_per_wallet", "max", default="?")
                message = (
                    f"WHITELIST HIT: {name}\n"
                    f"Stage: {label} | Price: {price} | Max/wallet: {maximum}\n"
                    f"Wallet: {config.wallet}\n"
                    f"Mint: https://opensea.io/collection/{slug}/overview"
                )
                send_alert(config, message)
                store.mark_alerted(alert_key)
        except ApiError as exc:
            stats["errors"] += 1
            print(f"WARN eligibility {slug}: {exc}", file=sys.stderr)
    print(json.dumps({"at": utc_now(), **stats}), flush=True)
    return stats


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Monitor Robinhood Chain OpenSea drops and wallet eligibility")
    parser.add_argument("--interval", type=int, default=5, help="polling interval in minutes (default: 5)")
    parser.add_argument("--once", action="store_true", help="run one cycle and exit")
    parser.add_argument("--verbose", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = Config.load(args)
    client = OpenSeaClient(config)
    store = Store(config.db_path)
    while True:
        try:
            run_cycle(config, client, store)
        except Exception as exc:  # keep daemon alive, while surfacing the failure
            print(f"ERROR {utc_now()} {exc}", file=sys.stderr, flush=True)
            if config.once:
                return 1
        if config.once:
            return 0
        time.sleep(config.interval_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
