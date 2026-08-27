#!/usr/bin/env bash
# Generate local secrets into .env — never overwrites existing values (PRD §16).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example"
fi

gen_key() { openssl rand -base64 32 | tr -d '\n'; }

ensure_var() {
  local name="$1" value key
  value="$(grep -E "^${name}=" .env | head -1 | cut -d= -f2- || true)"
  if [ -z "${value}" ]; then
    key="$(gen_key)"
    if grep -qE "^${name}=" .env; then
      if sed --version >/dev/null 2>&1; then
        sed -i "s|^${name}=.*|${name}=${key}|" .env
      else
        sed -i '' "s|^${name}=.*|${name}=${key}|" .env
      fi
    else
      printf '%s=%s\n' "${name}" "${key}" >> .env
    fi
    echo "generated ${name}"
  else
    echo "${name} already set — left untouched"
  fi
}

ensure_var APP_ENCRYPTION_KEY
ensure_var BETTER_AUTH_SECRET

echo
echo "Next steps:"
echo "  scripts/env-setup.sh --mode=dev"
echo "  scripts/start-dev.sh    # or scripts/start-prod.sh"
echo "  make token              # one-time /setup bootstrap token"
echo "  open http://localhost:3960/setup"
