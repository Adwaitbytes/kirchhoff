GOAL
Build KIRCHHOFF end to end, exactly as specified in docs/PRD.md, and ship it: contracts deployed and verified on 3 testnets, CRE workflows running, the Judge live in a CCV cell (or Fallback B enforcing live), Mission Control deployed, the Kelp Replay working end to end with real transactions, the repo pushed to GitHub, the demo video recorded, and the deck built. The PRD is the single source of truth. Every section, table, rule, reason code, screen, state, test, and checklist in it gets built or explicitly resolved. Nothing is skipped silently.

You are the lead engineer and you run the whole team. Spin up parallel sub-agents matching the PRD's team split (contracts, demo contracts, CRE, engine, CCV/infra, frontend, frontend/design, AI + API) and coordinate them. Work fast and relentlessly. Do not stop, do not ask for approval between steps, do not report "done" until the Definition of Done is fully true.

========================================
STEP 0: CREDENTIALS FIRST (the only human handoff)
========================================
Read the whole PRD, then write CREDENTIALS_NEEDED.md with every account, key, and resource required, each with: why it's needed, free or paid, exact steps to get it, and the .env variable name. Cover at minimum:
- CRE account and CLI login; CRE deploy access status
- 3 deployer wallets with testnet ETH and LINK on Ethereum Sepolia, Arbitrum Sepolia, Base Sepolia
- Two independent RPC providers per chain
- Cloud VM (or local k3d if no VM) for k3s and the CCV cell(s)
- Postgres instance
- Vercel account/token and GitHub repo access
- Anthropic API key (model via env var)
- Blockscout / Etherscan-family API keys for contract verification and Spec Copilot
- Testnet Safe (issuer multisig) and its signer keys
- Telegram / Slack webhook for the Notifier
Also write HUMAN_TASKS.md for things only a person can do (e.g. asking Chainlink mentors the PRD's open questions in section 19, the CCV testnet registration steps, CRE live deploy access).
Create .env.example and a `make check-creds` command that prints a green/red table.

Then DO NOT WAIT. Build everything that doesn't need a missing credential, using local Anvil chains and mocks. If a credential is missing later, use the Claude Chrome MCP to retrieve it from the user's logged-in dashboards where possible. Secrets go only into .env and CI/Vercel secrets, never into the repo, logs, or commits.

========================================
DEFINITION OF DONE
========================================
1. PRD_TRACEABILITY.md maps every PRD requirement (by section) to code, test, and status: DONE, FALLBACK USED (with reason), or CUT (only items in the PRD's cut list, in its order, with reason). Zero unmapped requirements.
2. The "never cut" set is complete and working: W1, W2, ConservationLedger, the Judge or Fallback B, Circuit Map, Verdict Stream, Kelp Replay.
3. All production and demo contracts from section 7 deployed and verified on all 3 testnets; addresses in README and deployments/*.json.
4. @kirchhoff/engine at 100% branch coverage; fast-check property test with 10,000 sequences passes with every forgery flagged and zero false flags.
5. All 4 CRE workflows simulate green against public testnets (and deployed live if access exists); configs generated only by engine/compile.ts.
6. Judge implements every step in section 9 with HMAC verification, two-RPC agreement, 2s budget, all reason codes, p99 under 300ms under k6 at 100 rps. Running in at least 1 CCV cell, or Fallback B (KirchhoffTokenPool) enforcing live on CCIP lanes. Fallback B is built regardless.
7. The six scripted scenarios in section 17 pass on Anvil and the Kelp Replay passes `demo/e2e.ts` on public testnets 3 times in a row: BREACH on 3 chains, CCIP refusal, Guard revert, borrow revert, incident created.
8. Mission Control and every screen in section 12 built to the design tokens, motion rules, all 5 states, accessibility rules, and stage mode, deployed on Vercel. Every number links to an explorer tx or onchain read. Playwright flows pass.
9. Indexer, REST API, WebSocket, SDK, and MCP server from section 13 working; AI features from section 11 with provenance, no write powers, and the injection eval passing.
10. `demo/deploy-all`, `demo/attack-kelp-replay`, `demo/reset` (under 3 minutes) all work.
11. Demo video recorded in stage mode following section 15's 2:30 script (at least 3 takes, best one kept), and the 8-slide .pptx deck with the video embedded.
12. Repo pushed to GitHub with a strong README (architecture diagram, deployed addresses, CRE workflow ids, how to reproduce the Kelp Replay), CI green, clean commit history.
13. SUBMISSION.md filled with the PRD's submission checklist and the Chainlink-track paragraph on exactly how CRE and CCIP are used.

========================================
EXECUTION ORDER (follow the PRD's hard gates)
========================================
1. Monorepo scaffold exactly as section 8's layout, pnpm workspaces + Foundry, CI (lint, test, coverage gates), pre-commit hooks.
2. Hour-4-equivalent gate: freeze contract interfaces from section 7. Everyone codes against them.
3. Engine first (pure TS, bigint only, no Date.now, no randomness, no network), with full tests, because workflows, Judge, and backtester share it.
4. Contracts + Foundry tests (unit, fuzz, invariant, replay rejection) on Anvil with a mock KeystoneForwarder. Then deploy and verify on 3 testnets.
5. Demo contracts + deploy/seed/attack/reset scripts.
6. W1 and W2, then W3 and W4. Simulate locally against 3 Anvil chains, then against public testnets.
7. Fallback B (KirchhoffTokenPool) immediately after contracts, guaranteeing a live refusal.
8. Judge + CCV cell via the CCV Starter Kit Helm chart. Read the policy hook OpenAPI v1 spec in the chainlink-ccv repo first and match it exactly. If testnet CCV registration isn't confirmed, Fallback B becomes primary and you say so honestly in the README and deck.
9. Indexer, API, WebSocket, SDK, MCP.
10. Frontend: Mission Control hero first on live data, then Attack Lab, Incident Room, Status Page, Onboarding, Verifier Ops, Integrations.
11. AI: Spec Copilot, Incident Narrator (template fallback per cut list), Ask KIRCHHOFF, Topology Scout.
12. Full Kelp Replay end to end on testnets. Then code freeze: bugs only.
13. Record video, build deck, finalize README and submission docs, push.

========================================
NON-NEGOTIABLE RULES FROM THE PRD
========================================
- No AI anywhere in the veto path. Verdicts come only from deterministic engine math over consensus/onchain data.
- Contracts accept CRE data only from the KeystoneForwarder and the registered workflow; reports carry chainSelector and ledger address; a CRE report alone can never clear BROKEN.
- In-flight amounts come from message matching, never snapshot timing.
- Every demo element is labeled "Testnet simulation"; the forged message is a WeakBridge single-key signature, and the README says so plainly.
- Never fabricate numbers. Latency and metrics in the deck are measured, not assumed.
- No em dashes in any user-facing copy.

========================================
QUALITY BAR
========================================
- Before every commit: lint, typecheck, tests green. Never push a broken main.
- If something fails, find the root cause and fix it. Try a different approach after two failed attempts. Never paper over with longer timeouts or swallowed errors.
- Verify every external API, event signature, and SDK method against the real docs or source (Chainlink CRE docs, CCV Starter Kit, chainlink-ccv repo) before coding against it. Do not guess interfaces.
- UI must look screen-recording ready without edits: check every screen in a real browser at 1920x1080 in stage mode, light and dark.
- Final self-review: read PRD_TRACEABILITY.md against the PRD section by section as a skeptical Chainlink judge and fix every gap.

========================================
FINAL DELIVERABLE
========================================
When everything is true, print a short summary: live URL, GitHub repo, deployed addresses per chain, CRE workflow ids, CCV path used (live cell or Fallback B), test and coverage results, measured latencies, video and deck paths, and the remaining HUMAN_TASKS.md items.