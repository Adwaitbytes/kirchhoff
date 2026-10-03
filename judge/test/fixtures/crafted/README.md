Crafted, not captured. Built from the chainlink-ccv policy hook spec examples
(verifier/policy_hook_openapi_v1.yaml and verifier/docs/policy_hook.md @ d7b7b63): the docs elide
hashes and addresses (`0x9f2b...3e4`), so those are filled with the spec's full `example` values or
synthetic padded addresses. The selectors are the spec's own examples, not KIRCHHOFF chains, so the
Judge must PASS them as out of scope. Every file must validate against EvaluateRequest
(test/schema.test.ts) and is replayed against a running Judge in test/replay.test.ts.
