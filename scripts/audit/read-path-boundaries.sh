#!/usr/bin/env bash
set -euo pipefail

fail=0

if rg -n 'setInterval\(' apps/worker/src/index.ts; then
  echo "AGENTS.md anti-pattern §3: worker entrypoint must use the non-overlapping scheduler, not setInterval." >&2
  fail=1
fi

query_feed_body="$(sed -n '/export async function queryFeed/,/\/\* ── Detail/p' packages/db/src/repositories/projects.ts)"
if grep -n -E 'from mint_events|\.from\(mintEvents\)' <<<"$query_feed_body"; then
  echo "AGENTS.md anti-pattern §3: queryFeed must read worker snapshots, never aggregate mint_events." >&2
  fail=1
fi

if rg -n 'OpenSeaClient|fetchJson|resolveOpenSeaKey|getEligibility\(' apps/web/src/app --glob 'page.tsx'; then
  echo "AGENTS.md anti-pattern §3: page renders cannot call providers; enqueue worker work and read snapshots." >&2
  fail=1
fi

if rg -U -n 'catch \([^)]*\) \{[\s\S]{0,1200}await resolveOpenSeaKey' apps/worker/src/workers/discovery.ts; then
  echo "AGENTS.md anti-pattern §4: provider catch paths must not re-resolve throttled credentials." >&2
  fail=1
fi

exit "$fail"
