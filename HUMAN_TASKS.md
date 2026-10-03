# Human tasks

Only a person can do these. Everything else is automated.

## Credentials and funds (see CREDENTIALS_NEEDED.md)

- [x] Seed funds: 0.05 Sepolia ETH from the Google Cloud faucet; 0.01 ETH bridged to each of Arbitrum Sepolia and Base Sepolia through the canonical bridges. CCIP fees are paid in native ETH, so LINK is optional.
- [ ] Optional headroom: import `DEPLOYER_PRIVATE_KEY` into a browser wallet and claim faucets.chain.link drips (0.5 ETH per chain). The faucet only pays a connected wallet and uses a CAPTCHA, which automation must not solve.
- [x] AI provider: OpenRouter key (Claude models), $3 cap. `ANTHROPIC_API_KEY` is not needed.
- [ ] Create a CRE account and run `cre login`.
- [x] Etherscan V2 key (taken from the logged-in Etherscan dashboard).
- [x] RPCs: Tenderly gateway (provider 1) plus publicnode (provider 2), keyless and independent.
- [x] Neon Postgres in Singapore.
- [ ] Optional: Telegram bot or Slack webhook.

## Questions for Chainlink mentors (PRD section 19)

- [ ] What are the exact steps to make kETH require our CCV on CCIP 2.0 testnet lanes? How do we onboard our aggregator to the CCIP indexer?
- [ ] Does the policy hook request carry token amounts and the source transaction hash? (We also verify this against the OpenAPI v1 spec in `chainlink-ccv`.)
- [ ] Can we get CRE live deployment during the event?
- [ ] Which confidence options does the CRE EVM Log trigger expose (latest, safe, finalized)?
- [ ] What are the CRE per-run limits on `filterLogs` block ranges and call counts?
- [ ] Which token pool interface version runs on the CCIP testnet lanes we use?
- [ ] What is the finality time on each of the three testnets?

## Registration and access

- [ ] CCV testnet registration for kETH lanes, if mentors confirm a path. Until it is confirmed, Fallback B (KirchhoffTokenPool) is the primary enforcement path, and the README and deck say so.
  - [ ] Optional: email `clusersupport@smartcontract.com` to onboard our aggregator to the CCIP indexer (display name, website, contact, resolver address and chains, aggregator URLs). Not self-serve and undersized committees are refused; without it we self-execute with `ccip-cli manual-exec`. Everything else in ccv/STATUS.md is automated.
- [ ] CRE live deploy access. Until it is granted, the workflows run with `cre workflow simulate` against public testnets, labeled as such.

## Submission (PRD section 15)

- [ ] Upload the .pptx deck (video embedded) to Google Drive.
- [ ] Submit to the main track and the Chainlink track before 11:59pm on October 7.
- [ ] Optional: record your own voiceover over the stage-mode video (captions are burned in by default).
- [ ] Optional: a second machine records a backup take in parallel.
