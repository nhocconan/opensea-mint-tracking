# Host boot units

Docker's restart policies only restart containers that were **running** when the
daemon stopped. They do not cover:

- containers left in `created` state by a `docker compose up` that was
  interrupted (OS upgrade, reboot, dropped SSH session);
- containers left in `exited` state by a deliberate `docker compose stop`
  (`unless-stopped` only);
- the one-shot `migrate` service, which `web` and `worker` gate on via
  `depends_on: service_completed_successfully`;
- a container whose process is alive but **wedged** — "Up" forever, doing
  nothing.

On 2026-09-15 an OS upgrade rebooted the host mid-deploy. `postgres`, `valkey`
and Traefik came back on their own; `web`, `worker` and `migrate` were sitting
in `created` and never started, so osmint.dic.app was down until someone ran
`docker compose up -d` by hand.

These units re-run `docker compose up -d` at boot, which is idempotent, re-runs
`migrate`, and honours the `depends_on` ordering the daemon ignores.

## Units

| Unit | Covers |
|---|---|
| `hoodmint-ingress.service` | Traefik + socket-proxy (`balancer` project) |
| `hoodmint-radar.service` | postgres, valkey, migrate, web, worker |
| `carvnode.service` | CARV verifier node (earning workload) |
| `carvnode-watchdog.timer` | restarts the verifier if it wedges |

## Install

    cd /home/web/opensea-tools
    sudo install -m 0644 infra/systemd/*.service infra/systemd/*.timer /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now hoodmint-ingress.service hoodmint-radar.service \
                               carvnode.service carvnode-watchdog.timer

The watchdog script stays in this repo and is referenced by absolute path, so
`git pull` updates it without a re-install.

## Verify

    systemctl show hoodmint-radar.service -p Result -p ExecStartPost   # Result=success, status=0
    systemctl show carvnode.service      -p Result -p ExecStartPost   # Result=success, status=0
    systemctl list-timers carvnode-watchdog.timer
    tail -20 /var/log/carvnode-watchdog.log

**journald on this host runs `Storage=none`** (`/etc/systemd/journald.conf`), so
`journalctl -u ...` returns "No journal files were found" and `systemctl status`
shows no command output. Verify units by `Result=` / `ExecStartPost status=` as
above, and read the watchdog's own log file — not the journal.

## Notes

- `ExecStart` uses `--no-build`: boot must never block on an image build. A
  missing image fails the unit loudly instead of silently serving nothing.
  Deploys still build explicitly.
- `hoodmint-*` units use `ExecStop=... stop -t 30`, not `down`, so volumes and
  networks survive and the app gets a graceful SIGTERM instead of the SIGKILL
  (exit 137) seen during the unplanned reboot.
- `carvnode.service` deliberately has **no** `ExecStop`. It earns money, so a
  `daemon-reload` or unit restart must not be able to take it offline. Stop it
  by hand: `docker compose -p carv -f /home/carv/docker-compose.yml stop`.
- `hoodmint-radar` is ordered `After=hoodmint-ingress` because
  `traefik-network` is declared `external: true` and is created by the
  ingress stack.

## The CARV liveness signal

`restart: always` only reacts to the process dying. The verifier's real
"I am earning" signal is the chain-cursor line the worker emits every ~5s:

    {"caller":"worker/chain.go:322", ... "msg":"chain [arbitrum] query: start block N, end block M"}

`carvnode-watchdog.sh` restarts the container when that line is absent for 10
minutes. It skips containers younger than the window (boot grace) and honours
`/run/carvnode-watchdog.pause` so it never fights an operator during
maintenance:

    sudo touch /run/carvnode-watchdog.pause     # pause (cleared on reboot)
    sudo rm /run/carvnode-watchdog.pause        # resume

Every decision is appended to `/var/log/carvnode-watchdog.log`, which the script
self-caps at 1 MB (no logrotate dependency — the disk is already 87% full).
Without it a 3am restart would leave no trace, because journald discards
everything.

The units reference the script by absolute path inside this repo, so `git pull`
updates watchdog behaviour with no re-install and no `daemon-reload`.

Node address, for cross-checking earnings on the CARV dashboard:
`0x150D46d36EBaF6767073BDd19BA83ec5409a6b61`.
