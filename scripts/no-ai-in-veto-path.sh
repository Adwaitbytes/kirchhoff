#!/usr/bin/env bash
# PRD section 11 principle 1: no AI in the veto path. Fails if engine/, judge/, contracts/ or
# workflows/ import an AI SDK, call a model provider, or depend on @kirchhoff/ai.
set -euo pipefail
cd "$(dirname "$0")/.."

dirs=()
for d in engine judge contracts workflows; do [ -d "$d" ] && dirs+=("$d"); done
[ ${#dirs[@]} -eq 0 ] && { echo "no-ai-in-veto-path: no veto-path directories found"; exit 0; }

# Package names, hosts and env names of model providers and AI SDKs.
pattern='@kirchhoff/ai|@anthropic-ai/|anthropic\.com|api\.anthropic|openrouter|OPENROUTER_|ANTHROPIC_API_KEY|ANTHROPIC_MODEL|from ["'"'"']openai["'"'"']|require\(["'"'"']openai["'"'"']\)|api\.openai\.com|@ai-sdk/|from ["'"'"']ai["'"'"']|langchain|@google/generative-ai|generativelanguage\.googleapis|cohere-ai|mistralai|ollama|chat/completions|/v1/messages'

matches="$(grep -RInE "$pattern" "${dirs[@]}" \
  --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' --include='*.cjs' --include='*.go' \
  --include='*.sol' --include='*.json' --include='*.yaml' --include='*.yml' --include='*.toml' \
  --exclude-dir=node_modules --exclude-dir=out --exclude-dir=cache --exclude-dir=coverage --exclude-dir=dist --exclude-dir=lib \
  --exclude-dir=broadcast --exclude='pnpm-lock.yaml' --exclude='package-lock.json' || true)"

if [ -n "$matches" ]; then
  echo "no-ai-in-veto-path: AI/provider usage found in the veto path:" >&2
  echo "$matches" >&2
  exit 1
fi
echo "no-ai-in-veto-path: OK (${dirs[*]} contain no AI SDK or model provider usage)"
