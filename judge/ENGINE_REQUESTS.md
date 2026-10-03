# Requests to @kirchhoff/engine (judge-core)

The Judge consumes `parseHookRequest`, `protectedTransfer`, `judge`, `evmAddress`, `resolveSpec`,
`parseSpec`, `specHash` and `DEPLOYMENTS_SCHEMA` as they are today. Nothing is blocking. These would
move logic that currently lives in the Judge's I/O shell (judge/src/evaluate.ts) into the pure core.

1. **Provider pairs for the step 7 and 8 reads.** `TokenEvaluation.frozen`, `senderTainted` and
   `sourceDebit` are single values, but the Judge reads each through two providers. Today
   `decideRobustly` runs `judge()` over every value the disputed reads could take and returns
   PENDING when the verdict depends on them. Proposed: accept `readonly [T | error, T | error]`
   for those three fields and apply the same rule inside `judge()` (a FAIL from an earlier,
   agreed step still stands; otherwise PENDING "providers disagree on <field>").

   **RESOLVED (engine).** `TokenEvaluation.frozen: ReadPair<boolean>`, `senderTainted: ReadPair<boolean>`,
   `sourceDebit: ReadPair<SourceDebitLookup>`, where `Read<T> = { ok: true; value: T } | { ok: false; error: string }`
   and `ReadPair<T> = readonly [Read<T>, Read<T>]` (both exported from `@kirchhoff/engine`). Step 7: a flag both
   providers agree is `true` FAILs `TOKEN_QUARANTINED` even if the other flag is disputed; otherwise any error or
   disagreement is PENDING `"providers disagree on frozen|senderTainted, retry"`. Step 8: both providers must
   return the same lookup (both missing, or both found with equal amounts), else PENDING
   `"providers disagree on sourceDebit, retry"`. `decideRobustly` in judge/src/evaluate.ts can go.
2. **Lane outside the spec.** A protected token sent to a destination selector the spec does not
   list is answered by the shell as `FAIL SPEC_MISMATCH "<sym> destination <sel> not in spec"`.
   Proposed: a `TokenEvaluation.laneInSpec: boolean` checked in step 3, so the core owns the code.

   **RESOLVED (engine).** `TokenEvaluation.laneInSpec: boolean` (required). Checked in step 3 right after the
   spec hash comparison: `false` is `FAIL SPEC_MISMATCH`, note `"lane not in spec"` (reason string
   `"SPEC_MISMATCH <sym> lane not in spec"`). The shell computes it (source and destination selectors both in the
   spec's chains) and passes it in.
3. **Status reason for contained tokens.** `StatusRead.reason` for BROKEN/QUARANTINED/RECOVERING is
   filled by the shell from `breachOf(activeIncident).reason` (the ledger never rewrites
   `latestEpoch` on BREACH). Worth stating in the `StatusRead` doc comment so other consumers fill
   it the same way.

   **RESOLVED (engine).** Stated in the `StatusRead` doc comment in engine/src/judge-core.ts.
