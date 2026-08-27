import tempfile
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

import monitor


class FakeClient:
    def get_drops(self, kind, chain):
        if kind == "upcoming":
            return [{"collectionSlug": "test-drop", "collectionName": "Test Drop", "chain": "robinhood"}]
        return []

    def get_eligibility(self, slug):
        return {"stages": [{"label": "GTD", "isEligible": True, "price": "0", "maxPerWallet": 2}]}


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.config = monitor.Config(
            wallet="0x6666666666666666666666666666666666666666",
            chain="robinhood",
            interval_seconds=300,
            db_path=root / "test.sqlite3",
            api_key_file=root / "key.json",
            api_key="test",
            wallet_jwt="jwt",
            wallet_pat=None,
            webhook_url=None,
            telegram_bot_token=None,
            telegram_chat_id=None,
            once=True,
            verbose=False,
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_extracts_only_eligible_stages(self):
        data = {"results": [{"label": "WL", "eligible": True}, {"label": "Public", "eligible": False}]}
        self.assertEqual(["WL"], [x["label"] for x in monitor.eligible_stages(data)])

    @patch("monitor.send_alert")
    def test_alert_is_deduplicated(self, send):
        store = monitor.Store(self.config.db_path)
        first = monitor.run_cycle(self.config, FakeClient(), store)
        second = monitor.run_cycle(self.config, FakeClient(), store)
        self.assertEqual(1, first["new"])
        self.assertEqual(0, second["new"])
        self.assertEqual(1, first["eligible"])
        self.assertEqual(1, send.call_count)


if __name__ == "__main__":
    unittest.main()
