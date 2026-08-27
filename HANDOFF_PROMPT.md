# Prompt for local Codex GPT-5.6 Sol

Implement HoodMint Radar from this repository.

First read `AGENTS.md` and `PRD.md` completely, then inspect every existing file. Treat `PRD.md` as the acceptance contract and the Python monitor as behavioral reference, not the target architecture.

Work autonomously in implementation phases, beginning with a Docker-runnable vertical slice: bootstrap admin → configure OpenSea source → ingest real/fixture drops → render All/Live/Next/Latest → show provider health. Continue through eligibility, alerts, on-chain radar, admin/RBAC, and hardening as far as the environment permits. Keep the repository runnable after each phase.

Use GPT-5.6 Sol with high or xhigh reasoning for architecture/security-sensitive changes. Do not ask for private keys. When live OpenSea/RPC credentials are unavailable, implement and prove behavior with sanitized contract fixtures, leave explicit setup instructions, and never fabricate a successful live check.

Run and report the PRD merge gates and a clean Docker smoke test. Finish with: implemented acceptance criteria, proof commands/results, remaining gaps, security decisions, and exact next command for the owner.
