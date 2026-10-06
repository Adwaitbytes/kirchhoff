# Backtest over kETH's real testnet history (PRD 2.M3, 6.LC3)

Testnet simulation. Spec: `docs/kETH.testnet.resolved.yaml` (engine/specs/kETH.yaml with the testnet addresses);
its spec hash `0x22c75309594e0a07596c003695911bb61b1618c9519c1e6d32175ab719915dfe` equals the hash active onchain in KirchhoffRegistry.
Run on 2026-10-06 with `ai/src/backtest.ts` `backtestYaml` from each ledger's creation block, 126 s.

## Coverage

| Chain | From block | To block | Debits | Credits | Matched |
| --- | --- | --- | --- | --- | --- |
| ethereum-testnet-sepolia | 11838878 | 11852492 | 0 | 3 | 0 |
| ethereum-testnet-sepolia-arbitrum-1 | 315496675 | 316199847 | 0 | 0 | 0 |
| ethereum-testnet-sepolia-base-1 | 47652331 | 47740194 | 0 | 0 | 0 |

## Breaches flagged

| Reason | Block | Transaction | Amount |
| --- | --- | --- | --- |
| DEBIT_NOT_FOUND | 11850716 | `0x8ae4c560898dd8134a43ce5be36e2bba93e9c38d173e89950f49b381f26ff539` | 116,500 kETH |
| DEBIT_NOT_FOUND | 11851057 | `0x333b9b41a3faaa6db5ca45cb3a32f3a220375bef6a9c16025b480f158e2c61f2` | 116,500 kETH |
| DEBIT_NOT_FOUND | 11852412 | `0xebf5a265ed8645c583e128a3e2cad3334cf4434e8e3d7ca615076cf6642f9e44` | 116,500 kETH |
| LOOP_DEFICIT | 11852492 | `0x0000000000000000000000000000000000000000000000000000000000000000` | 116,500 kETH |

Every DEBIT_NOT_FOUND row is one of the three Kelp Replay forgeries (a WeakBridge credit signed by its single key with
no burn): true positives. The LOOP_DEFICIT row is the pinned state while the forged 116,500 kETH sat outside the
escrow, also a true positive. False BROKEN verdicts: **0**.

Limit: this testnet history contains no legitimate bridge transfers yet, so it shows that every forgery is caught,
while zero false flags on valid traffic is established by the engine's 10,000-sequence property test and the seven
Anvil scenarios (normal round trip and in-flight across an epoch included).
