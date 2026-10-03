#!/usr/bin/env bash
# Brings up three private Anvil chains for the Judge load test (home 28545/31337, arb 28546/31338,
# base 28547/31339: same chain ids and selectors as demo/anvil-up.sh, own ports so other workstreams'
# restarts of the shared chains cannot wipe them), deploys the real KIRCHHOFF suite on each with
# contracts/script/Deploy.s.sol, and two LogEmitters on arb standing in for the CCIP pool and OnRamp
# (no CCIP on Anvil). Then load/anvil/setup.ts registers the spec, posts a CONSERVED epoch per chain
# and emits the source debit.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
KEY=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 # Anvil dev account #9 (public test key)
ADDR=0xa0Ee7A142d267C1f36714E4a8F75612F20a79720

deploy() {
  local alias="$1" port="$2" role="$3"
  # Deploy.s.sol may only write under deployments/ (foundry fs_permissions); the record is moved out right after.
  # forge locks contracts/cache per chain id, which other workstreams' deploys to the shared Anvils also take.
  local try
  for try in 1 2 3 4 5 6 7 8 9 10; do
    if (cd "$ROOT/contracts" && DEPLOYER_PRIVATE_KEY=$KEY NETWORK="judge-load-$alias" ROLE=$role \
      ISSUER_SAFE_ADDRESS=$ADDR WEAKBRIDGE_VERIFIER=$ADDR REGISTRY_TIMELOCK_SECONDS=600 STALENESS_SECONDS=86400 \
      forge script script/Deploy.s.sol --rpc-url "http://127.0.0.1:$port" --broadcast --slow -q >"$HERE/out/deploy-$alias.log" 2>&1); then
      break
    fi
    grep -q "lock acquisition failed" "$HERE/out/deploy-$alias.log" || { cat "$HERE/out/deploy-$alias.log" >&2; exit 1; }
    echo "forge cache busy for $alias, retry $try" >&2
    sleep 5
  done
  mv "$ROOT/deployments/judge-load-$alias.json" "$HERE/out/$alias.json"
  echo "deployed suite on $alias ($port)"
}
mkdir -p "$HERE/out"
for spec in home:28545:31337 arb:28546:31338 base:28547:31339; do
  IFS=: read -r alias port chain <<<"$spec"
  if ! cast chain-id --rpc-url "http://127.0.0.1:$port" >/dev/null 2>&1; then
    nohup anvil --port "$port" --chain-id "$chain" --block-time 1 --silent >"$HERE/out/anvil-$alias.log" 2>&1 &
    echo $! >"$HERE/out/anvil-$alias.pid"
    until cast chain-id --rpc-url "http://127.0.0.1:$port" >/dev/null 2>&1; do sleep 0.2; done
  fi
done
# The Judge batches its reads through canonical Multicall3, which is live on every public testnet but not on a
# fresh Anvil: copy the runtime code from Ethereum Sepolia.
MULTICALL3=0xcA11bde05977b3631167028862bE2a173976CA11
MC_CODE=$(cast code $MULTICALL3 --rpc-url "${MULTICALL3_SOURCE_RPC:-https://ethereum-sepolia-rpc.publicnode.com}")
[ "${#MC_CODE}" -gt 100 ] || { echo "could not fetch Multicall3 code" >&2; exit 1; }
for port in 28545 28546 28547; do cast rpc anvil_setCode $MULTICALL3 "$MC_CODE" --rpc-url "http://127.0.0.1:$port" >/dev/null; done

deploy home 28545 home
deploy arb 28546 remote
deploy base 28547 remote

# Two emitters on arb (the source chain of the load-test message): pool stand-in and OnRamp stand-in.
OUT=$(forge create "$HERE/LogEmitter.sol:LogEmitter" --root "$HERE" --contracts "$HERE" --rpc-url http://127.0.0.1:28546 --private-key $KEY --broadcast --json)
POOL=$(echo "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["deployedTo"])')
OUT=$(forge create "$HERE/LogEmitter.sol:LogEmitter" --root "$HERE" --contracts "$HERE" --rpc-url http://127.0.0.1:28546 --private-key $KEY --broadcast --json)
ONRAMP=$(echo "$OUT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["deployedTo"])')
printf '{"pool":"%s","onRamp":"%s"}\n' "$POOL" "$ONRAMP" >"$HERE/out/emitters.json"
echo "emitters pool=$POOL onRamp=$ONRAMP"
