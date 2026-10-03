# Judge chaos run (PRD section 17 "Chaos", light)

Checks the Judge against PRD section 14's failure table and INTERFACES.md Revision 2: anything the
Judge cannot confirm is HTTP 503 (the verifier retries), never FAIL (the verifier drops FAIL for good).

## Local run: `judge/scripts/chaos.sh`

Stub chains (`load/stub-chains.ts`: three chains, two providers each, with a control port that kills or
breaks one provider, or makes every ledger stale) and a real Judge process. Real output, 2026-10-04:

```
baseline                                     -> HTTP 200 in 0.010670s  {"decision":"PASS","message_id":"0x9f2b...d3e4","reason":"OK kETH CONSERVED delta=0 epoch=4182"}
kill home RPC provider 2                     -> HTTP 503 in 0.008235s  {"error":"PENDING_ATTESTATION kETH destination status read failed, retry"}
home RPC provider 2 back                     -> HTTP 200 in 0.005529s  {"decision":"PASS","message_id":"0x9f2b...d3e4","reason":"OK kETH CONSERVED delta=0 epoch=4182"}
arb RPC provider 1 returns errors            -> HTTP 503 in 0.005105s  {"error":"PENDING_ATTESTATION kETH source status read failed, retry"}
both arb providers down                      -> HTTP 503 in 0.006618s  {"error":"PENDING_ATTESTATION kETH source status read failed, retry"}
pause W2 (every ledger stale), fail_closed   -> HTTP 200 in 0.005560s  {"decision":"FAIL","message_id":"0x9f2b...d3e4","reason":"STATUS_STALE kETH no fresh epoch, fail_closed"}
W2 resumes (fresh epoch)                     -> HTTP 200 in 0.003899s  {"decision":"PASS","message_id":"0x9f2b...d3e4","reason":"OK kETH CONSERVED delta=0 epoch=4182"}
kill the Judge                               -> no answer (connection refused): the verifier reads this as "verdict unknown" and retries
Judge restarted (retry answers)              -> HTTP 200 in 0.010865s  {"decision":"PASS","message_id":"0x9f2b...d3e4","reason":"OK kETH CONSERVED delta=0 epoch=4182"}
```

(Message ids shortened here; the script prints them in full.) Every PENDING is logged as one JSON line
with the per-provider evidence, e.g.:

```
{"level":"info","msg":"verdict pending, verifier will retry","messageId":"0x9f2b...d3e4","decision":"PENDING",
 "reasonCode":"PENDING_ATTESTATION","reason":"PENDING_ATTESTATION kETH destination status read failed, retry",
 "latencyMs":7.37,"evidence":{...,"destination":[{"status":1,"delta":"0","stale":false,"epochId":"4182","epochReason":0},
 {"error":"HTTP request failed."}],...}}
```

## Against PRD section 14

| Failure (PRD 14) | Expected | Observed |
| --- | --- | --- |
| Lying or eclipsed RPC (threat 5): one provider down, erroring or disagreeing | `PENDING_ATTESTATION`, liveness delay, no loss | 503 on kill and on errors (above); disagreement on status, staleness, debit, taint and frozen flags is covered in `test/evaluate.test.ts` "PENDING paths". A verdict that does not depend on the disputed read still stands (`keeps a definitive FAIL when providers only disagree on a later step`) |
| CRE workflow stops (W2 paused) | Status goes stale; the spec's `on_stale` applies | `STATUS_STALE kETH no fresh epoch, fail_closed` (kETH spec is `fail_closed`); `fail_open` passes (`evaluate.test.ts`) |
| Judge unreachable | Verifier gets no verdict, message is not signed, replayed later | Connection refused. Per the policy hook spec, "a 4xx, a 5xx, a timeout, an unreachable host ... is read as verdict unknown and the message is retried, not dropped"; the cell logs `Policy hook verdict unavailable, scheduling retry` and counts `verifier_message_transitions_total{stage="policy",outcome="policy_unavailable"}`. After the restart the same message (same `message_id`, the Judge is deterministic) gets its verdict |
| Slow RPC | Answer inside the verifier's 5 s call timeout | 2 s budget: a hung provider answers 503 at 2.0 s (`test/budget.test.ts`) |

## In the k3d cell

See `ccv/STATUS.md` section "Judge in the cell" for the same kill-the-Judge check against the cell's
`judge` Service (scaled to 0: no endpoints, the verifier's call gets connection refused, which it retries).
The verifier only calls the hook for messages naming our CCV, which needs the resolver deployment listed
there, so the cell-side retry log line is quoted from the policy hook guide rather than observed.
