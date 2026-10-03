#!/usr/bin/env bash
# Generates local shared secrets (HMAC, issuer API key) into .env if they are empty.
set -euo pipefail
[ -f .env ] || cp .env.example .env
for name in JUDGE_HMAC_SECRET ISSUER_API_KEY; do
  if ! grep -qE "^${name}=.+" .env; then
    value="$(openssl rand -hex 32)"
    if grep -q "^${name}=" .env; then sed -i '' "s|^${name}=.*|${name}=${value}|" .env; else printf '%s=%s\n' "$name" "$value" >> .env; fi
    echo "generated ${name}"
  fi
done
