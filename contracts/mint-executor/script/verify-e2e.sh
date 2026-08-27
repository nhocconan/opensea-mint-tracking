#!/usr/bin/env bash
# End-to-end verification of the real custody stack (ADR 0004 Phase 2):
# deploys MintExecutor + a fake mint target to a fresh local anvil, wires
# owner/operator/allowlist exactly as production onboarding would, then
# runs verify-e2e.ts — which uses the REAL packages/signing +
# packages/providers code (not mocks, not Solidity-only tests) to sign and
# broadcast both a legitimate mint and a malicious recipient-redirect
# attempt, asserting the legitimate one succeeds on-chain and the
# malicious one genuinely reverts on-chain.
#
# Requires: anvil, forge, cast (foundryup), tsx (pnpm -w exec tsx).
# Usage: from contracts/mint-executor/, run: bash script/verify-e2e.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(cd ../.. && pwd)"

RPC_URL="http://127.0.0.1:8546"
OWNER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
OPERATOR_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

echo "== starting a fresh anvil on $RPC_URL =="
anvil --port 8546 --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
sleep 1

OWNER_ADDR=$(cast wallet address --private-key "$OWNER_KEY")
OPERATOR_ADDR=$(cast wallet address --private-key "$OPERATOR_KEY")
echo "owner=$OWNER_ADDR operator=$OPERATOR_ADDR"

echo "== deploying MintExecutor =="
EXECUTOR=$(forge create src/MintExecutor.sol:MintExecutor \
  --rpc-url "$RPC_URL" --private-key "$OWNER_KEY" --broadcast --json \
  --constructor-args "$OWNER_ADDR" | jq -r .deployedTo)
echo "executor=$EXECUTOR"

echo "== deploying FakeMintTarget =="
TARGET=$(forge create test/MintExecutor.t.sol:FakeMintTarget \
  --rpc-url "$RPC_URL" --private-key "$OWNER_KEY" --broadcast --json | jq -r .deployedTo)
echo "target=$TARGET"

MINT_SELECTOR=$(cast sig "mint(address,uint256)")

echo "== configuring: setOperator, setAllowlist, fund 2 ETH =="
cast send "$EXECUTOR" "setOperator(address)" "$OPERATOR_ADDR" \
  --rpc-url "$RPC_URL" --private-key "$OWNER_KEY" >/dev/null
cast send "$EXECUTOR" "setAllowlist(address,bytes4,bool,uint256,uint256)" \
  "$TARGET" "$MINT_SELECTOR" true 4 5000000000000000000 \
  --rpc-url "$RPC_URL" --private-key "$OWNER_KEY" >/dev/null
cast send "$EXECUTOR" --value 2ether --rpc-url "$RPC_URL" --private-key "$OWNER_KEY" >/dev/null

echo "== running verify-e2e.ts against the real packages/signing + packages/providers code =="
RPC_URL="$RPC_URL" OWNER_ADDRESS="$OWNER_ADDR" EXECUTOR_ADDRESS="$EXECUTOR" \
  TARGET_ADDRESS="$TARGET" OPERATOR_KEY="$OPERATOR_KEY" \
  npx --prefix "$REPO_ROOT" tsx "$(pwd)/script/verify-e2e.ts"
