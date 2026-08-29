.PHONY: help up down logs ps test lint typecheck verify format migrate migration seed reset-dev backup restore backup-test smoke bootstrap token vapid-keys wallet-keys start-dev stop-dev start-prod stop-prod env-setup

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

env-setup: ## Step-by-step .env doctor (MODE=dev|prod)
	@bash scripts/env-setup.sh --mode=$(or $(MODE),dev)

start-dev: ## Start the full local stack (stores + web + worker) on :3960+
	@bash scripts/start-dev.sh

stop-dev: ## Stop all HoodMint dev containers/processes (volumes stay intact)
	@bash scripts/stop-dev.sh

start-prod: ## Start Docker production posture on :3960
	@bash scripts/start-prod.sh

stop-prod: ## Stop the production-posture compose stack
	@bash scripts/stop-prod.sh

bootstrap: ## Generate .env secrets (never overwrites existing values)
	@bash scripts/bootstrap.sh

up: ## Build and start the full stack
	docker compose up --build -d

down: ## Stop the stack and remove containers
	docker compose down

logs: ## Follow service logs
	docker compose logs -f --tail=100

ps: ## Show service status
	docker compose ps

test: ## Run unit and contract tests
	pnpm test

lint: ## Run Biome lint
	pnpm lint

typecheck: ## Run TypeScript project build (strict)
	pnpm typecheck

format: ## Format the codebase with Biome
	pnpm format

verify: ## All merge gates except e2e/integration (fast local gate)
	pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && docker compose config --quiet

migrate: ## Apply committed SQL migrations
	pnpm migrate

migration: ## Generate a migration from schema changes: make migration name=add_foo
	@if [ -z "$(name)" ]; then echo "usage: make migration name=add_foo"; exit 2; fi
	pnpm --filter @hoodmint/db run migration:generate --name=$(name)

seed: ## Insert deterministic demo data (PRD §19)
	pnpm seed

reset-dev: ## Drop volumes and restart clean (destructive: dev data only)
	docker compose down -v || true
	docker compose up --build -d

backup: ## Encrypted full backup (PostgreSQL + .env + compose + secrets) to backups/, verified
	@bash scripts/backup.sh

restore: ## Restore a backup (safety dump, stop web/worker, pg_restore, row-count verify): make restore file=backups/xxx.tar.zst.gpg
	@if [ -z "$(file)" ]; then echo "usage: make restore file=backups/hoodmint-<ts>.tar.zst.gpg [args='--dry-run|--config|--yes']"; exit 2; fi
	@bash scripts/restore.sh "$(file)" $(args)

backup-test: ## Rehearse backup+restore end-to-end against a throwaway postgres (prod is only read)
	@bash scripts/backup-restore-test.sh

smoke: ## Clean-start Docker smoke test: boot, wait healthy, probe endpoints
	@bash scripts/smoke.sh

token: ## Print a one-time /setup bootstrap token (LOCAL DEV — needs env + reachable DB)
	pnpm bootstrap-token

token-prod: ## Print a one-time /setup bootstrap token for the DOCKERIZED prod stack
	bash scripts/prod-token.sh

vapid-keys: ## Generate a VAPID keypair for the Web Push alert channel (run once)
	pnpm vapid-keys

wallet-keys: ## Generate the X25519 keypair that seals managed minting keys (worker-only decrypt)
	pnpm wallet-keys
