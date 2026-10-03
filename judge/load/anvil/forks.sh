#!/usr/bin/env bash
# Provider 2 for the Anvil load test: one Anvil fork per chain (ports 28555-28557) of the provider-1 node, taken
# after setup.ts so it holds the same contracts, spec, epochs and debit. Run after setup.sh and setup.ts.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
for spec in 28545:28555:31337 28546:28556:31338 28547:28557:31339; do
  IFS=: read -r origin port chain <<<"$spec"
  # Interval mining off on the origin: a block mined mid-request stalls reads, and nothing here needs new blocks.
  cast rpc evm_setIntervalMining 0 --rpc-url "http://127.0.0.1:$origin" >/dev/null
  cast chain-id --rpc-url "http://127.0.0.1:$port" >/dev/null 2>&1 && continue
  nohup anvil --port "$port" --chain-id "$chain" --fork-url "http://127.0.0.1:$origin" --silent >"$HERE/out/anvil-fork-$port.log" 2>&1 &
  echo $! >"$HERE/out/anvil-fork-$port.pid"
  until cast chain-id --rpc-url "http://127.0.0.1:$port" >/dev/null 2>&1; do sleep 0.2; done
done
echo "forks up on 28555-28557"
