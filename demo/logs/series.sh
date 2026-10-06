#!/usr/bin/env bash
# Runs the testnet Kelp Replay e2e three times in a row after the in-flight reset exits; stops at the first failure.
cd /Users/adwaitkeshari/Desktop/chainlink
export PATH="$HOME/.foundry/bin:$HOME/.cre/bin:$HOME/.bun/bin:$PATH"
while pgrep -f "reset.ts --network testnet" >/dev/null; do sleep 10; done
for n in 1 2 3; do
  echo "run $n start $(date -u +%FT%TZ)" >> demo/logs/series.txt
  if pnpm --filter @kirchhoff/demo e2e --network testnet > demo/logs/testnet-e2e-$n.log 2>&1; then
    echo "run $n PASSED $(date -u +%FT%TZ)" >> demo/logs/series.txt
  else
    echo "run $n FAILED $(date -u +%FT%TZ)" >> demo/logs/series.txt; exit 1
  fi
done
echo "series PASSED 3/3" >> demo/logs/series.txt
