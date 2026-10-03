#!/usr/bin/env bash
# Starts the three local chains used by every Anvil test and simulation:
# home (Ethereum Sepolia stand-in) 8545/31337, arb 8546/31338, base 8547/31339.
# Funds every wallet from .env so local runs use the same addresses as testnets.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."
mkdir -p .anvil

start() {
  local name="$1" port="$2" chain_id="$3"
  if curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "http://127.0.0.1:${port}" >/dev/null; then
    echo "${name} already running on ${port}"
  else
    anvil --port "$port" --chain-id "$chain_id" --block-time 1 --silent >".anvil/${name}.log" 2>&1 &
    echo $! >".anvil/${name}.pid"
    for _ in $(seq 1 50); do
      curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "http://127.0.0.1:${port}" >/dev/null && break
      sleep 0.1
    done
    echo "${name} started on ${port} (chain id ${chain_id})"
  fi
  for var in DEPLOYER_ADDRESS ATTACKER_ADDRESS WEAKBRIDGE_VERIFIER_ADDRESS SAFE_SIGNER_1_ADDRESS SAFE_SIGNER_2_ADDRESS SAFE_SIGNER_3_ADDRESS; do
    addr="$(grep -E "^${var}=" .env | cut -d= -f2- || true)"
    [ -n "$addr" ] && cast rpc --rpc-url "http://127.0.0.1:${port}" anvil_setBalance "$addr" 0x56BC75E2D63100000 >/dev/null
  done
}

start home 8545 31337
start arb 8546 31338
start base 8547 31339
