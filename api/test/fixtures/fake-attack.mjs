// Emits demo/src/events.ts StepEvent JSON lines exactly as `pnpm --filter @kirchhoff/demo attack` does.
const H = (c) => `0x${c.repeat(64)}`;
const emit = (e) => process.stdout.write(`${JSON.stringify({ label: "Testnet simulation", network: "local", at: new Date().toISOString(), ...e })}\n`);
process.stderr.write("deploying nothing, this is a fixture\n");
emit({ step: "attack", status: "started", title: "Kelp Replay (Testnet simulation)" });
emit({ step: "forge-credit", status: "started", chain: "home", title: "forge WeakBridge credit (no matching burn)" });
emit({ step: "forge-credit", status: "ok", chain: "home", title: "released kETH to attacker with no debit", txHash: H("1"), detail: { attacker: `0x${"a".repeat(40)}`, forgedId: H("2"), incidentId: H("3") } });
emit({ step: "breach", status: "started", title: "W1 BREACH -> all 3 ledgers" });
for (const [c, h] of [["home", "4"], ["arb", "5"], ["base", "6"]]) emit({ step: "breach", status: "ok", chain: c, title: `BREACH recorded on ${c}`, txHash: H(h) });
emit({ step: "quarantine", status: "started", title: "W3 QUARANTINE_APPLIED" });
emit({ step: "quarantine", status: "ok", chain: "home", title: "QUARANTINED on home", txHash: H("7") });
emit({ step: "loop-epoch", status: "ok", title: "Loop Rule deficit" });
emit({ step: "refuse-ccip", status: "refused", chain: "home", title: "CCIP transfer refused at source", revertReason: "TokenQuarantined()", txHash: H("8") });
emit({ step: "refuse-guard", status: "refused", chain: "home", title: "home transfer reverted (KirchhoffGuard)", revertReason: "SenderTainted", txHash: H("9") });
emit({ step: "refuse-borrow", status: "refused", chain: "home", title: "borrow reverted (CollateralBroken)", revertReason: "CollateralBroken()", txHash: H("b") });
emit({ step: "attack", status: "ok", title: "done" });
