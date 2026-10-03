# CCV research: policy hook, HMAC, PR #1437, CCV Starter Kit

Researched 2026-10-04. Sources were read from real source, not memory:

| Source | Ref |
| --- | --- |
| `smartcontractkit/chainlink-ccv` | `main` @ `d7b7b63b977151f3b775927217906dc8a513b2f3` (2026-10-02) |
| `smartcontractkit/chainlink-ccv-starter-kit` (off-chain kit, Helm) | `main` @ `247db90` (2026-09-24); latest chart release `ccv-cell v0.8.0` (2026-09-24) |
| `smartcontractkit/chainlink-ccv-starter-kit-contracts` (on-chain kit) | `main` @ `b742757` (2026-09-25) |
| `smartcontractkit/documentation` (source of docs.chain.link) | `main` @ `2c185d0` (2026-10-02), `src/content/ccip/v2/ccv-starter-kit/**` |

## TL;DR for engineers (read this first)

1. **The spec path has not moved.** `verifier/policy_hook_openapi_v1.yaml` exists on `main`. OpenAPI 3.0.3, `info.version: 1.0.0`, single operation `POST /v1/evaluate` (operationId `policy-evaluate`). Reproduced verbatim below.
2. **The request carries everything the Judge needs, including `source_tx_hash` and the token `amount`.** PRD open question 2 is answered YES: `source_tx_hash` (required), `message.token_transfer.amount` (decimal string), `source_pool_address`, `source_token_address`, `dest_token_address`, `token_receiver`, `message.sender`, `source_block_number`, `finalized_block_number`, `block_depth`, plus optional `fee_token`, `fee_token_amount`, `source_block_timestamp`, and the decoded `message.finality` object.
3. **The request does NOT carry the 32-byte "token amount array"**: v1 has a single optional `token_transfer` object (CCIP 2.0 OnRamp 2.0.0 reverts `CanOnlySendOneTokenPerMessage()` if `tokenAmounts.length != 1` for token messages, verified in `contracts/onRamp/OnRamp.sol`). Treat a missing `token_transfer` as a data-only message.
4. **PRD conflict (must fix in the Judge design, section 9 step 5 and step 8):** the spec and docs say *"an endpoint that cannot reach its own dependencies must return an error status rather than FAIL."* A `FAIL` is a **permanent drop** for that node; recovery is a manual operator replay (`ccv job-queue reschedule` or checkpoint rewind). So `PENDING_ATTESTATION` ("providers disagree", "source debit not yet visible") must be returned as **HTTP 5xx (retry)**, not `{"decision":"FAIL"}`. Retries use `retry_delay` (default 10s, doubling, capped at 1h, jittered 0.5x-1.5x) and are bounded by a 7-day task-queue deadline. The PRD's example `{ "decision": "FAIL", "reason": "PENDING_ATTESTATION ... replay" }` would drop the message.
5. **Time budget:** per-call timeout default 5s, max configurable 15s (PRD's 2s budget is fine). Up to 8 concurrent calls per node; batches of up to 50 messages must finish inside a 2-minute job lock.
6. **Selectors are decimal strings.** Parse `source_chain_selector` / `dest_chain_selector` as strings or `BigInt`, never `Number` (Sepolia `16015286601757825753` > 2^63).
7. **Addresses are lowercase, 0x-prefixed, left-padded to 32 bytes** (20-byte EVM address becomes 64 hex chars with 24 leading zeros). Compare after normalizing.
8. **Response:** `{"decision":"PASS"}` is matched exactly (case-sensitive); `FAIL` case-insensitively; `HOLD` is reserved and must not be returned. Echo `message_id` (recommended). `reason` max 256 chars logged, never signed.
9. **HMAC is optional** and the Helm chart (v0.8.0) does not template the policy-hook credential (see "Helm" below). Recommended setup: keep the Judge in-cluster, unauthenticated, not exposed.
10. **One FAIL withholds one signature.** A message stops only when `N - threshold + 1` nodes withhold. In a 1-of-1 or 2-of-2 test committee one FAIL is decisive; in 3-of-4 you need 2 FAILs. Since every cell runs the identical Judge, this works as the PRD assumes, as long as the Judge is deterministic.
11. **Self-serve status:** see "Is testnet CCV registration for a third-party token self-serve?" at the bottom. Short answer: **the on-chain parts are self-serve; getting the default executor to run your CCV's messages (indexer onboarding) is NOT self-serve** (email `clusersupport@smartcontract.com`, and undersized committees are not onboarded). Without onboarding, you self-execute with `ccip-cli manual-exec --verifiers grpcs://<aggregator>`.

---

## 1. Policy hook OpenAPI spec (verbatim)

URL: https://github.com/smartcontractkit/chainlink-ccv/blob/main/verifier/policy_hook_openapi_v1.yaml
Repo path: `verifier/policy_hook_openapi_v1.yaml` (345 lines). Copied byte-for-byte from commit `d7b7b63`.
Related files in the same repo: `verifier/docs/policy_hook.md` (operator guide), `verifier/docs/policy_hook_api/` (rendered model pages), `verifier/pkg/policy/` (Go client generated from the YAML), `build/devenv/fakes/pkg/policy` (fake endpoint used in e2e tests).

```yaml
components:
  schemas:
    EvaluateRequest:
      description: The context a committee verifier sends for one message. It carries the decoded CCIP message and its source-chain provenance so the endpoint does not have to fetch or decode anything itself.
      properties:
        block_depth:
          description: How far the message's block sits below finalized_block_number. Zero when the message's block is the finalized head or newer, which is the case for a message that met its finality requirement against the safe head rather than the finalized one.
          format: int64
          minimum: 0
          type: integer
        fee_token:
          description: 'Source-chain asset used to pay the message fees. Omitted when the source reader or an older queued task does not supply it. Addresses are lowercase 0x-prefixed hex, left-padded to at least 32 bytes; longer addresses retain all bytes and leading zeros. An empty address is "0x". A supplied all-zero address is preserved, including when it identifies a native fee asset.'
          type: string
        fee_token_amount:
          description: 'Total fee in the fee asset''s smallest unit, as a decimal string. Sums all emitted receipt fees, including verifier, token, executor and network fees. Omitted when receipts or any receipt amount are unavailable; a known zero fee is "0".'
          example: "1000000000000000"
          pattern: "^[0-9]+$"
          type: string
        finalized_block_number:
          description: The source chain's finalized head at the moment the message met its finality requirement. It is fixed at that point, so a message that is retried reports the head as of the original decision rather than the current one.
          format: int64
          minimum: 0
          type: integer
        message:
          $ref: "#/components/schemas/Message"
        message_id:
          description: The CCIP message ID, 32 bytes hex-encoded with an 0x prefix.
          example: "0x9f2b1c0d5e4a3b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4"
          type: string
        schema_version:
          description: The contract version of this request. Always "v1" for this release; an endpoint serving several verifier releases branches on it.
          enum:
            - v1
          type: string
        source_block_number:
          description: The source-chain block the message was emitted in.
          format: int64
          minimum: 0
          type: integer
        source_block_timestamp:
          description: The source block's timestamp in UTC (RFC 3339), when available from the source event or a matching block header already fetched by the verifier. Omitted when unavailable, including for older queued tasks. Never substitutes the discovery or finality time and does not require an additional RPC.
          example: "2026-09-09T12:34:56Z"
          format: date-time
          type: string
        source_tx_hash:
          description: Identifier of the source-chain transaction that emitted the message. It is the raw identifier bytes the source chain reported, hex-encoded with an 0x prefix, whatever the chain family's own convention is - a 32-byte EVM transaction hash and a 64-byte Solana signature both arrive here as hex, not as the chain's native rendering. An endpoint that wants to show or query the native form (base58 for Solana, for example) re-encodes these bytes itself, using source_chain_selector to know which family it is looking at.
          example: "0x4c0f2a9b8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170605f4e3"
          type: string
        verifier_id:
          description: Identifies the committee verifier node making the call.
          example: committee-verifier-1
          type: string
      required:
        - schema_version
        - verifier_id
        - message_id
        - source_tx_hash
        - source_block_number
        - finalized_block_number
        - block_depth
        - message
      type: object
    EvaluateResponse:
      description: The verdict. Returned with HTTP 200; any other status is read as "verdict unknown" and the verifier retries.
      properties:
        decision:
          description: |
            PASS signs and attests the message. FAIL drops it — it is never attested and never auto-executed, and recovery needs an operator to replay it, by rescheduling the archived job with the verifier CLI or by rewinding the verifier checkpoint. PASS is matched exactly; FAIL is matched case-insensitively, because reading a verdict as unusable only causes a retry while reading one as PASS causes a signature.

            HOLD is reserved and not implemented by this release. It is listed here so that implementing it later is an additive change rather than a breaking one for an endpoint that validates responses strictly against this enum. Do not return it: a verifier reads it as "verdict unknown" and retries the message until the task queue's deadline. To hold a message for review today, answer FAIL and replay the message once the review clears.
          enum:
            - PASS
            - FAIL
            - HOLD
          type: string
        message_id:
          description: Echo of the request's message_id. Recommended, but optional and not in the required list, because it is a safety net rather than part of the verdict and requiring it would fail an otherwise correct endpoint that omits it. Nothing else in this response ties the verdict to the message it answers, so echoing the ID lets the verifier refuse a verdict that reached it for a different message, which is what a shared cache or a proxy in front of the endpoint can produce. A mismatch is an error and retries; omitting the field skips the check. Compared case-insensitively.
          example: "0x9f2b1c0d5e4a3b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4"
          type: string
        reason:
          description: Optional explanation of a FAIL. The verifier logs it and never signs it. Values longer than 256 characters are truncated in logs.
          example: sender matched sanctions list entry OFAC-12345
          type: string
      required:
        - decision
      type: object
    Finality:
      description: The decoded finality requirement as applied by the verifier. This is the requested requirement, not the observed confirmation depth in EvaluateRequest.block_depth. Unsupported flags or flag/depth combinations fall back to full finality.
      properties:
        block_depth:
          description: Required block confirmations when mode is blockDepth, capped by full finality. Zero when mode is finalized.
          format: int32
          minimum: 0
          maximum: 65535
          type: integer
        mode:
          description: blockDepth waits for the requested confirmations or full finality, whichever comes first. finalized waits for the finalized head, or the safe head when safe is true.
          enum:
            - blockDepth
            - finalized
          type: string
        safe:
          description: True only for a supported safe-head requirement, with mode finalized and block_depth zero. If the source chain has no safe head, the verifier waits for full finality instead.
          type: boolean
      required:
        - mode
        - block_depth
        - safe
      type: object
    Message:
      description: |
        The decoded CCIP message. Byte fields are hex-encoded with an 0x prefix; an empty byte field is "0x".

        Chain selectors are decimal strings, not JSON numbers. They are opaque 64-bit identifiers drawn from the whole uint64 range, and a JSON number is a float64 in JavaScript and in most schema-generated clients, which is exact only to 2^53. Parsing one as a number silently loses precision - about a quarter of the registered selectors are above 2^63 alone. Parse them as strings, or as a 64-bit unsigned integer if your language has one. Counters bounded by a real chain (block numbers, sequence numbers, gas limits) are JSON numbers, because they cannot reach 2^53.
      properties:
        ccip_receive_gas_limit:
          description: Gas limit reserved for the receiver's ccipReceive call on the destination chain.
          format: int32
          minimum: 0
          type: integer
        ccv_and_executor_hash:
          description: Commits to the CCVs and executor the message requested, 32 bytes hex-encoded.
          type: string
        data:
          description: The message payload.
          type: string
        dest_blob:
          description: The destination-chain execution blob.
          type: string
        dest_chain_selector:
          description: CCIP selector of the destination chain, as a decimal string. See the schema description for why this is not a JSON number.
          example: "12922642891491394802"
          pattern: "^[0-9]+$"
          type: string
        execution_gas_limit:
          description: Gas limit reserved for execution on the destination chain.
          format: int32
          minimum: 0
          type: integer
        finality:
          $ref: "#/components/schemas/Finality"
        off_ramp_address:
          description: 'Destination-chain offRamp that will deliver the message. Addresses are lowercase 0x-prefixed hex, left-padded to at least 32 bytes; longer addresses retain all bytes and leading zeros. An empty address is "0x".'
          type: string
        on_ramp_address:
          description: 'Source-chain onRamp that emitted the message. Addresses are lowercase 0x-prefixed hex, left-padded to at least 32 bytes; longer addresses retain all bytes and leading zeros. An empty address is "0x".'
          type: string
        receiver:
          description: 'Destination-chain account that will receive the message. Addresses are lowercase 0x-prefixed hex, left-padded to at least 32 bytes; longer addresses retain all bytes and leading zeros. An empty address is "0x".'
          type: string
        sender:
          description: 'Source-chain account that sent the message; this may be an application contract rather than an end user. Addresses are lowercase 0x-prefixed hex, left-padded to at least 32 bytes; longer addresses retain all bytes and leading zeros. An empty address is "0x".'
          type: string
        sequence_number:
          description: Per-lane sequence number of the message.
          format: int64
          minimum: 0
          type: integer
        source_chain_selector:
          description: CCIP selector of the source chain, as a decimal string. See the schema description for why this is not a JSON number.
          example: "3379446385462418246"
          pattern: "^[0-9]+$"
          type: string
        token_transfer:
          $ref: "#/components/schemas/TokenTransfer"
        version:
          description: CCIP message format version.
          format: int32
          minimum: 0
          type: integer
      required:
        - version
        - source_chain_selector
        - dest_chain_selector
        - sequence_number
        - on_ramp_address
        - off_ramp_address
        - sender
        - receiver
        - data
        - dest_blob
        - execution_gas_limit
        - ccip_receive_gas_limit
        - finality
        - ccv_and_executor_hash
      type: object
    TokenTransfer:
      description: The token transfer attached to a message. Absent for a message that carries no tokens.
      properties:
        amount:
          description: Transferred amount in the token's smallest unit, as a decimal string because it does not fit a JSON number.
          example: "1000000000000000000"
          type: string
        dest_token_address:
          description: 'Destination-chain token address. Addresses are lowercase 0x-prefixed hex, left-padded to at least 32 bytes; longer addresses retain all bytes and leading zeros. An empty address is "0x".'
          type: string
        extra_data:
          description: Pool-specific data carried with the transfer.
          type: string
        source_pool_address:
          description: 'Source-chain token pool the tokens were locked or burned in. Addresses are lowercase 0x-prefixed hex, left-padded to at least 32 bytes; longer addresses retain all bytes and leading zeros. An empty address is "0x".'
          type: string
        source_token_address:
          description: 'Source-chain token address. Addresses are lowercase 0x-prefixed hex, left-padded to at least 32 bytes; longer addresses retain all bytes and leading zeros. An empty address is "0x".'
          type: string
        token_receiver:
          description: 'Destination-chain account receiving the tokens. Addresses are lowercase 0x-prefixed hex, left-padded to at least 32 bytes; longer addresses retain all bytes and leading zeros. An empty address is "0x".'
          type: string
        version:
          description: Token transfer format version.
          format: int32
          minimum: 0
          type: integer
      required:
        - version
        - amount
        - source_pool_address
        - source_token_address
        - dest_token_address
        - token_receiver
        - extra_data
      type: object
  securitySchemes:
    HmacApiKey:
      description: The API key identifying the calling verifier. Sent only when the operator has configured a credential on the verifier; a verifier with none sends no authentication headers at all.
      in: header
      name: authorization
      type: apiKey
    HmacSignature:
      description: Hex-encoded HMAC-SHA256 of the string described under HmacTimestamp, keyed by the shared secret. Compare it in constant time.
      in: header
      name: x-authorization-signature-sha256
      type: apiKey
    HmacTimestamp:
      description: |
        Milliseconds since the Unix epoch, as a decimal string. Reject a request whose timestamp is more than 15 seconds from your own clock, which is what makes a captured request unreplayable.

        The three headers are computed together. The signed string is five space-separated fields:

          POST <request-target> <sha256-hex-of-body> <api-key> <timestamp-ms>

        <request-target> is the path the request arrived on, including any query string, and "/" when the configured endpoint URL has no path. <sha256-hex-of-body> is the hex-encoded SHA-256 of the exact request body, taken before any parsing. The shared secret is hex-encoded on both sides and decoded to raw bytes before use as the HMAC key.
      in: header
      name: x-authorization-timestamp
      type: apiKey
info:
  description: |
    The contract for the custom policy hook a CCV operator plugs into their committee verifier:
    one HTTPS endpoint that answers PASS or FAIL for a single CCIP message. The operator
    implements this endpoint; the verifier is the client.

    The endpoint is the operator's own composition layer. It may run any number of internal
    checks or proxy third-party compliance, AML, or sanctions-screening providers, but it
    answers the verifier with a single binary verdict. v1 supports exactly one endpoint per
    verifier, which is what keeps the retry and drop semantics below unambiguous.

    Each committee node calls its own endpoint independently, so the committee's normal quorum
    and signing still apply on top of the verdict. A node that gets FAIL simply does not attest;
    it does not signal anything to the other nodes.

    How the verifier reads the response:

      * HTTP 200 with decision PASS — the verifier signs and attests the message exactly as it
        would with no hook configured. The signed payload and the signature are unchanged by the
        hook: nothing from this response is signed.
      * HTTP 200 with decision FAIL — the verifier drops the message. It is not attested and not
        auto-executed. Recovery requires an operator action: rescheduling the archived job with
        the verifier CLI, or rewinding the verifier's checkpoint and replaying.
      * HTTP 200 with decision HOLD — reserved, not implemented, and not to be returned. The
        value is in the enum only so that implementing it later does not break an endpoint that
        validates strictly. A verifier reads it as "verdict unknown" and retries.
      * Anything else — a 4xx, a 5xx, a timeout, an unreachable host, a body that is not a valid
        EvaluateResponse, or a response whose message_id echo names a different message — is read
        as "verdict unknown" and the message is retried, not dropped. An endpoint outage must never silently drop traffic, so an endpoint that cannot
        reach its own dependencies must return an error status rather than FAIL.

    Operational notes for implementers:

      * The call is the last check before signing. The verifier calls the endpoint only after
        the message reaches finality, after the curse and message-disablement checks pass, and
        after its own checks on the message: known source chain, supported message version,
        non-zero sender, non-empty receiver, and a receipt the verifier can sign over. A message
        that fails any of those is dropped without a call, so the endpoint is never asked about a
        message the verifier was not going to sign, and a PASS the endpoint returns is always
        about a message that would otherwise be attested.
      * Calls are idempotent from the verifier's side: a retried message is sent again with the
        same message_id, and the same verdict is expected.
      * A verifier processes a batch of messages concurrently, up to 8 in-flight calls per node.
      * The per-call timeout defaults to 5 seconds and cannot be configured above 15 seconds. A
        batch of calls has to finish inside the verifier's own job lock, and a batch that runs
        past it is reclaimed and evaluated a second time. An endpoint that needs longer than this
        has to answer from its own queue rather than hold the call open.
      * The delay before a retry defaults to 10 seconds and is jittered per message, across half
        to one and a half times the configured value. An outage stalls every message a verifier
        is holding at once, and the spread stops the whole backlog arriving in one burst on each
        retry. The delay does not grow with the number of attempts.
      * The verifier reads at most 64 KiB of response body and does not follow redirects.
      * Authentication is optional and off unless the operator configures a credential on their
        verifier. When configured, every request carries the three headers under
        securitySchemes: an API key, a millisecond timestamp, and an HMAC-SHA256 signature over
        the method, the request target, a hash of the body, the key, and the timestamp. There is
        one scheme and it is the same one the aggregator uses. An endpoint that requires it
        should answer an unsigned or badly signed request with 401, which the verifier retries.
      * To hold a message while a review is pending, answer FAIL and replay the message once it
        clears: rescheduling the archived job re-asks the endpoint, and the second call can
        answer PASS. A held-for-review outcome carried by the protocol itself is the reserved
        HOLD value above, which this release does not implement.
  title: CCV Committee Verifier Policy Hook
  version: 1.0.0
openapi: 3.0.3
paths:
  /v1/evaluate:
    post:
      description: |
        Evaluate one CCIP message and return a binary verdict.

        The operator configures a base URL as the verifier's policy_hook.base_url, and the verifier
        POSTs to that base with this operation's path appended. A base may carry a path prefix, so
        an endpoint behind a gateway that routes on one is configured as
        "https://acme.example/compliance" and serves "/compliance/v1/evaluate".
      operationId: policy-evaluate
      requestBody:
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/EvaluateRequest"
        required: true
      responses:
        "200":
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/EvaluateResponse"
          description: The verdict for this message.
        default:
          description: Any non-200 response is read as "verdict unknown". The message is retried; it is never dropped on this path. Response bodies for these statuses are not parsed.
      summary: Evaluate a message against the operator's policy
security:
  - {}
  - HmacApiKey: []
    HmacSignature: []
    HmacTimestamp: []
servers:
  - description: The operator-hosted policy endpoint, configured on the verifier as policy_hook.base_url. Must be https outside local development. A base may carry a path prefix.
    url: https://policy.example.com
```

### Example request (from `verifier/docs/policy_hook.md`)

```json
{
  "schema_version": "v1",
  "verifier_id": "acme-verifier-1",
  "message_id": "0x9f2b...3e4",
  "source_tx_hash": "0x4c0f...4e3",
  "source_block_number": 1837421,
  "source_block_timestamp": "2026-09-09T12:34:56Z",
  "fee_token": "0x0000000000000000000000001111111111111111111111111111111111111111",
  "fee_token_amount": "1000000000000000",
  "finalized_block_number": 1837436,
  "block_depth": 15,
  "message": {
    "version": 1,
    "source_chain_selector": "3379446385462418246",
    "dest_chain_selector": "12922642891491394802",
    "sequence_number": 42,
    "sender": "0x...",
    "receiver": "0x...",
    "finality": { "mode": "finalized", "block_depth": 0, "safe": false },
    "data": "0x...",
    "token_transfer": { "amount": "1000000000000000000", "...": "..." }
  }
}
```

Example verdict: `{"decision": "FAIL", "message_id": "0x9f2b...3e4", "reason": "sender matched sanctions list entry OFAC-12345"}`

### `message.finality` decoding table (from `policy_hook.md`)

| Requirement | `message.finality` |
| --- | --- |
| Full finality | `{"mode":"finalized","block_depth":0,"safe":false}` |
| N confirmations, capped by full finality | `{"mode":"blockDepth","block_depth":N,"safe":false}` |
| Safe head, falling back to full finality when unavailable | `{"mode":"finalized","block_depth":0,"safe":true}` |

### Verifier behavior summary (all from the spec + `policy_hook.md`)

| Endpoint answer | Verifier action |
| --- | --- |
| HTTP 200 `{"decision":"PASS"}` | Signs and attests, byte-identical to no hook |
| HTTP 200 `{"decision":"FAIL"}` (any case) | Drops permanently for this node. Archived with `reason` as error for 30 days. Recovery: operator replay |
| HTTP 200 `HOLD` | Reserved, not implemented: treated as verdict unknown, retried |
| Any 4xx/5xx, timeout, redirect, unparseable body, mismatched `message_id` echo | Verdict unknown: retry after `retry_delay` |

Other operational facts:

- The hook is called only **after** finality, curse checks, message-disablement checks, and the node's own checks (known source chain, supported version, non-zero sender, non-empty receiver, signable receipt).
- Calls are idempotent: a retried message has the same `message_id`; the same verdict is expected. Judge must be deterministic for a given message plus on-chain state.
- Max 8 in-flight calls per node; batch of up to 50 messages; whole batch must finish in the task queue's 2-minute lock or it is reclaimed and re-evaluated.
- Verifier reads max 64 KiB of response body; does not follow redirects.
- `base_url` must be https unless `insecure_connection = true` (local dev only). A base ending in `/v1/evaluate` or containing a query string is rejected at startup.
- **The hook runs on the standalone verifier only** (changelog `2026-09-05_policy_hook_standalone_only.md`). A verifier inside a Chainlink node rejects `[policy_hook]` at startup. The Starter Kit chart runs the standalone verifier, so this is fine for us.

Replay commands (from `policy_hook.md`):

```bash
# single message
docker exec <verifier-container> /bin/verifier ccv job-queue reschedule \
  --queue task-verifier --verifier-id <verifier-id> --message-id <message-id>
# range: stop the node first, then
docker exec <verifier-container> /bin/verifier ccv chain-statuses set-finalized-height \
  --chain-selector <selector> --verifier-id <verifier-id> --block-height <block>
```

(In Kubernetes use `kubectl exec statefulset/<release>-verifier -- /bin/verifier ccv ...`. The `kubectl` form is my adaptation: UNVERIFIED.)

---

## 2. HMAC scheme (exact)

Sources: the spec's `securitySchemes`; `verifier/docs/policy_hook.md` section "Authenticating the verifier"; implementation `protocol/common/hmac/hmac_auth.go` and `protocol/common/hmac/http_auth.go` (`SignHTTPRequest`).

Headers (all lowercase names as sent):

| Header | Value |
| --- | --- |
| `authorization` | The API key, a UUID. Raw value, **no `Bearer ` prefix** |
| `x-authorization-timestamp` | Milliseconds since Unix epoch, decimal string |
| `x-authorization-signature-sha256` | Lowercase hex HMAC-SHA256 of the string-to-sign |

String to sign: five fields joined by single spaces (`fmt.Sprintf("%s %s %s %s %s", method, fullPath, bodyHash, apiKey, timestamp)`):

```
POST <request-target> <sha256-hex-of-body> <api-key> <timestamp-ms>
```

- `<request-target>` = `req.URL.RequestURI()`: the path including any query string; `/` when the URL has no path. With a gateway prefix it is `<base_url path>/v1/evaluate`, e.g. `/compliance/v1/evaluate`.
- `<sha256-hex-of-body>` = `hex.EncodeToString(sha256(body))` over the exact raw body bytes, before parsing.
- HMAC key = `hex.DecodeString(secret)`: the secret is a hex string on both sides, decoded to raw bytes. Minimum 32 bytes (64 hex chars). `ValidateSecret` enforces this.
- Timestamp window: `DefaultTimeWindow = 15 * time.Second` (`hmac_auth.go:37`). Reject `|now - ts| > 15000 ms`.
- Compare in constant time (`hmac.Equal` in the Go reference). Answer bad or missing auth with **401** (the verifier retries it; it is not a drop).

Credential location (verifier side): the verifier **secrets file**, not the `[policy_hook]` config section:

```toml
[policy_hook]
  api_key = "3f2b7c58-6d41-4a9e-8b0c-1d2e3f405162"
  secret_key = "<64 hex characters>"
```

Set `require_auth = true` in the config section so a missing credential is fatal at boot instead of silently calling unauthenticated. Generate a pair with Go `hmac.GenerateCredentials()` (`protocol/common/hmac/hmac_auth.go:70`), or equivalently a UUIDv4 plus 32 random bytes hex.

TypeScript verification sketch (follows the scheme above; not Chainlink code):

```ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function verifyPolicyHookHmac(
  rawBody: Buffer, requestTarget: string, headers: Record<string, string | undefined>,
  expectedApiKey: string, secretHex: string, nowMs = Date.now(),
): boolean {
  const apiKey = headers["authorization"];
  const ts = headers["x-authorization-timestamp"];
  const sig = headers["x-authorization-signature-sha256"];
  if (!apiKey || !ts || !sig || apiKey !== expectedApiKey) return false;
  if (!/^\d+$/.test(ts) || Math.abs(nowMs - Number(ts)) > 15_000) return false;
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const toSign = `POST ${requestTarget} ${bodyHash} ${apiKey} ${ts}`;
  const expected = createHmac("sha256", Buffer.from(secretHex, "hex")).update(toSign).digest("hex");
  const a = Buffer.from(expected, "utf8"), b = Buffer.from(sig, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

---

## 3. PR #1437 summary

- URL: https://github.com/smartcontractkit/chainlink-ccv/pull/1437
- Title: `feat(hooks): policy hook followups`. State: **MERGED** 2026-09-10T18:27:05Z. PR body is the empty template; the substance is in `changelog/2026-09-09_policy_hook_payload.md`.
- Changes to the v1 payload:
  - Added `fee_token`, `fee_token_amount` (sum of all receipt fees: verifier, token, executor, network; decimal string; omitted if any receipt amount is unknown; known zero is `"0"`), and `source_block_timestamp` (RFC 3339 UTC; omitted if unavailable, never substituted with another time).
  - **Breaking:** `message.finality` changed from a packed integer to an object `{mode, block_depth, safe}`. Old to new: `0` -> finalized; `1..65535` -> blockDepth N; `65536` -> finalized + safe; unsupported -> finalized.
  - **Breaking:** every address field is now lowercase 0x hex left-padded to at least 32 bytes.
  - Derivation is pure and RPC-free (`policy.NewEvaluateRequest` in `verifier/pkg/policy/contract.go`), so a task replayed after restart produces the identical request.
  - Explicitly deferred: transaction-origin / end-user lookup. `sender` can be an app contract.
- Files touched include `verifier/policy_hook_openapi_v1.yaml` (+45/-12), `verifier/pkg/policy/contract.go`, `protocol/finality.go`, `verifier/docs/policy_hook.md`.

Other relevant changelogs in `changelog/`: `2026-08-27_verifier_policy_hook.md` (introduced hook), `2026-09-02_policy_hook_generated_bindings.md`, `2026-09-05_policy_endpoint_latency_histogram.md`, `2026-09-05_policy_hook_standalone_only.md`.

---

## 4. CCV Starter Kit (docs.chain.link/ccip/ccv-starter-kit)

Docs source: `src/content/ccip/v2/ccv-starter-kit/` in `smartcontractkit/documentation` (published 2026-09-25, last modified 2026-09-26/27). Support contact on the index page: `clusersupport@smartcontract.com`.

### Two kits

| Kit | Repo | What |
| --- | --- | --- |
| On-chain contracts kit | https://github.com/smartcontractkit/chainlink-ccv-starter-kit-contracts | Foundry + `make`. Deploys per chain: CREATE2 factory, `VersionedVerifierResolver` (same address on every chain), committee verifier implementation, lane config. `npm ci` installs `@chainlink/contracts-ccip` **2.0.0**; pins forge **1.8.1** (`make install`). `OUTPUT_MODE=EOA` broadcasts; `OUTPUT_MODE=SAFE` emits Safe calldata |
| Off-chain kit | https://github.com/smartcontractkit/chainlink-ccv-starter-kit | Helm chart **`ccv-cell`** at `charts/ccv-cell` (no Helm repo/OCI registry: install from the cloned path). Releases: https://github.com/smartcontractkit/chainlink-ccv-starter-kit/releases (latest `ccv-cell v0.8.0`, 2026-09-24) |

Images (public ECR): `public.ecr.aws/chainlink/chainlink-ccv-verifier` and `public.ecr.aws/chainlink/chainlink-ccv-aggregator`; chart `values.yaml` default tag `v0.13.0` for both (`repository: chainlink/chainlink-ccv-verifier`, `tag: "v0.13.0"`). Gallery: https://gallery.ecr.aws/chainlink/chainlink-ccv-verifier. Also on AWS Marketplace and Google Cloud Marketplace.

### Cell components

- One cell = **one verifier + one aggregator**, backed by Postgres (15+, TLS). Rendered as StatefulSets with `replicas: 1`.
- Postgres logical DBs: `aggregator`, `verifier`, plus `bootstrapper` (holds the signing key when using the default Postgres keystore; with cloud KMS the key never touches Postgres).
- Verifier polls source chains and signs message hashes; aggregator serves attestations over **gRPC** (listens on `:50051`); CCIP indexer reads them; executor runs on destination.
- Aggregator must be exposed with TLS, HTTP/2 + gRPC end to end, a stable public hostname, and a **publicly trusted CA cert** (Let's Encrypt via cert-manager is fine; private CA fails only when peers/indexer connect).
- Metrics are pushed over **OTLP** (no `/metrics` scrape endpoint). Deploy an OTel collector or Grafana Alloy; set `OTEL_SERVICE_NAME`. Dashboard: `grafana/ccv-cell-dashboard.json` in the off-chain kit.
- `local/` folder in the off-chain kit: docker-compose stack for experimentation (`local/docker-compose.yaml`, `local/config/`). This is the fastest hackathon path if we do not want k3s.

### Deploy order (from `evm/deploy-your-first-cell.mdx`)

1. On-chain kit: look up selectors, Router, and OnRamp per chain in the CCIP directory; deploy factory -> resolver -> verifier per chain; apply lane config. `make deployments-check` asserts resolver address parity.
2. Write `my-values.yaml` for `ccv-cell`. **Most common mistake:** `sourceVerifierAddress`, every `destinationVerifiers` entry and every `committee_verifier_addresses` entry take the **`VersionedVerifierResolver`** address, not the implementation. Using the implementation yields green pods that never attest.
3. `helm template` to read ServiceAccount names, grant them secret access, then `helm upgrade --install`.
4. Expose aggregator; read the signer address the verifier logs on first boot (`Using signer address`), then register it with the on-chain kit's `make apply-signature-configs`. This target **rejects** 1-of-1, any N-of-N, or threshold <= 2N/3 unless `ALLOW_WEAK_COMMITTEE=true` (testnet only). Smallest accepted strong committee: 3-of-4.
5. Add the policy hook.

On-chain kit command examples (from `getting-started.md`):

```bash
make install
cp .env.example .env
make seed-operator-config
make build
make discover                                         # list chains + selectors from the CCIP API
make add-chain CHAIN=sepolia SELECTOR=16015286601757825753
make deploy-verifier CHAIN=sepolia TAG=0x00010001 RPC_URL=$SEPOLIA_RPC_URL
```

Off-chain install (from `RUNBOOK.md` section 3):

```bash
helm template "$RELEASE_NAME" ./charts/ccv-cell -f "$VALUES"
helm upgrade --install "$RELEASE_NAME" ./charts/ccv-cell -n "$NAMESPACE" --create-namespace -f "$VALUES"
```

Avoid release names starting with `ccv-cell` (fullname collapse changes resource names).

### Helm values for the policy hook

From `charts/ccv-cell/values.yaml` (commented out by default, under `verifier.config`):

```yaml
verifier:
  config:
    policy_hook:
      base_url: "https://policy.example.com"   # verifier POSTs base_url + "/v1/evaluate"
      request_timeout: "5s"                    # Go duration; empty = 5s; max 15s
      retry_delay: "10s"                       # Go duration; jittered 0.5x-1.5x; empty = 10s
      insecure_connection: false               # allow plain http:// (local/test only)
      require_auth: false                      # make missing credential fatal at startup
```

Sidecar option from `RUNBOOK.md` "Policy Hooks" (Chainlink recommends a separate deployment instead):

```yaml
verifier:
  config:
    policy_hook:
      base_url: "http://localhost:1234"
      insecure_connection: true
    extraContainers:
      - name: my-policy-hook
        image: my-policy-hook:v1.2.3
```

Note: the RUNBOOK snippet nests `extraContainers` under `verifier.config`, but `values.yaml`/README list it as `verifier.extraContainers`. Use `verifier.extraContainers` (README is generated from values.yaml).

**Policy hook secret (HMAC credential) in Helm: NOT templated by chart v0.8.0.** I grepped `charts/ccv-cell/templates/**`: the verifier `externalsecret.yaml` only renders aggregator client credentials (`aggregator_api_key_%d`, `aggregator_secret_key_%d`). There is no value that writes `[policy_hook] api_key/secret_key` into the verifier secrets file. UNVERIFIED whether other secret backends (`secretproviderclass.yaml`, raw secret) let you supply a full secrets TOML that could include it. Practical decision: run the Judge in-cluster, unauthenticated, with a NetworkPolicy, exactly as the docs recommend; keep HMAC verification code in the Judge behind a flag.

In-cluster plain-http base_url (e.g. `http://judge.kirchhoff.svc:8080`) requires `insecure_connection: true` (the hook rejects non-https otherwise).

### Logging and monitoring (from `logging-and-monitoring.mdx` + `policy_hook.md`)

- Counter `verifier_message_transitions_total{stage="policy", outcome=...}`, outcomes: `policy_passed`, `policy_rejected`, `policy_unavailable`, `policy_skipped` (the last carries `reason="task_invalid"`). The four sum to messages entering the stage.
- Histogram `verifier_policy_http_request_duration_seconds` labeled with `policy_passed` / `policy_rejected` / `policy_unavailable`; buckets 1ms to 15s.
- Log lines: `Dropping task - policy hook returned FAIL` (terminal; has `messageID` and reason) and `Policy hook verdict unavailable, scheduling retry`.
- Normal startup noise: `connection refused` / `Failed to list message rules` for 15-30s until the aggregator is up; steady-state `Healthy` while waiting for finality.
- Finality wait: a default (finalized) message waits for Sepolia's `finalized` tag, **roughly 13 to 17 minutes** (from `evm/test-your-setup.mdx`). Plan demo pacing around this, or request `safe`/block-depth finality.

### Test your setup (from `evm/test-your-setup.mdx`)

Option A (our case): deploy a token + pool with the CCT Foundry tutorials (https://github.com/smartcontractkit/docs-cct-foundry), wire your CCV as a required verifier for the lane via `AdvancedPoolHooks.applyCCVConfigUpdates` (see `ccip.md`). **Point the required verifier at your resolver**; listing the implementation reverts during fee quote with no revert data.

```bash
ccip-cli send -s <sourceChain> -d <destChain> -r <sourceRouter> --to <destWallet> -t <yourToken>=<amount>
ccip-cli manual-exec <src-tx> --verifiers grpcs://<your-aggregator-host>:443     # ccip-cli >= 1.14.0
ccip-cli show <messageId> --rpcs <destRpc> --json                               # expect "status": "SUCCESS"
curl -s https://api.ccip.chain.link/v2/messages/<messageId> | jq -r '.status'
```

Option B: receiver contract that returns your resolver from `getCCVsAndFinalityConfig`, and send with `-x ccvs='["<resolver>"]'`.

Until onboarded, the public CCIP API reports your verifier as `UNKNOWN` and the message sits at `UNTOUCHED` until you self-execute.

### Onboarding to the CCIP indexer (from `onboard-to-the-indexer.mdx`)

Not self-serve. Email `clusersupport@smartcontract.com` with: display name (+ optional logo URL), website, primary contact, resolver address and chains, every aggregator read endpoint URL. Prereqs: production-sized committee ("an undersized committee, or one with no redundancy, is not onboarded"), public unauthenticated TLS aggregator read endpoints answering well under 10s, and a proven self-executed message against each aggregator. After onboarding, the indexer retries each message up to 1 hour.

### Existing testnet CCVs (from docs data `src/config/data/ccip/v1_2_0/testnet/verifiers.json`)

| Chain | Chainlink default committee | Others |
| --- | --- | --- |
| Ethereum Sepolia | `0x8f3ee3c77D2B27c32306a89D367654F959Db223D` (role default, v2.0.0; on-chain `typeAndVersion()` = `VersionedVerifierResolver 2.0.0`, verified via RPC) | Lombard `0xB55bCa19C48074a7FA693b8350785fd04034545a`, CCTP `0xE57C834a439fDfE8196b95f4Fd24Daf1e05eAbB8`, Succinct `0x901873c2349E8223798589e96D151A3D30d9c003` |
| Arbitrum Sepolia | `0x8f3ee3c77D2B27c32306a89D367654F959Db223D` | CCTP `0xE57C...AbB8`, Succinct `0x54Be0408E91FaB34CD01bA105e6BBC3232d85286` |
| Base Sepolia | `0x8f3ee3c77D2B27c32306a89D367654F959Db223D` | Lombard `0xB55b...545a`, CCTP `0xE57C...AbB8` |

---

## 5. Is testnet CCV registration for a third-party token self-serve?

**Split answer, based on the docs and contracts as of 2026-10-02:**

| Step | Self-serve? | How |
| --- | --- | --- |
| Deploy our CCV contracts (factory, resolver, committee verifier, lane config) on Sepolia / Arb Sepolia / Base Sepolia | **Yes** | On-chain kit `make` targets, our own EOA |
| Register our signer set | **Yes** (testnet weak committee needs `ALLOW_WEAK_COMMITTEE=true`) | `make apply-signature-configs` |
| Make kETH transfers require our CCV | **Yes**, if we own the token pool and its `AdvancedPoolHooks` | Deploy kETH as a CCT with V2 pools (TokenAdminRegistry self-serve flow), deploy `AdvancedPoolHooks`, call `applyCCVConfigUpdates` with `[address(0), ourResolver]` so the Chainlink default stays required too |
| Run the cell (verifier + aggregator + Judge) | **Yes** | Helm chart `ccv-cell` or the `local/` docker-compose |
| Execute messages that require our CCV | **Yes, manually** | `ccip-cli manual-exec <src-tx> --verifiers grpcs://<aggregator>:443` |
| Have the **default executor** auto-execute (indexer reads our aggregator) | **No** | Email onboarding request; undersized committees are not onboarded |

So the PRD's hour-0 question to mentors should be narrowed to: "Will you onboard a hackathon (weak, 1-to-4 cell) committee's aggregator to the testnet indexer, or should we plan on `ccip-cli manual-exec` for the demo?" Default plan: self-execute.

## UNVERIFIED items in this file

- `kubectl exec` form of the replay commands (adapted from `docker exec`).
- Whether any ccv-cell secret backend can inject the verifier `[policy_hook]` HMAC credential; none of the chart templates do it.
- Whether Chainlink will onboard a weak testnet committee to the indexer (docs say undersized committees are not onboarded; no testnet exception is documented).
- Live docs.chain.link rendering was not fetched; content was read from the docs repo source at commit `2c185d0`, which is what the site builds from.
