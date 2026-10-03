#!/usr/bin/env bash
# Generates testnet-only keys into .env for any wallet variable that is still empty.
# Prints addresses only. Keys never leave .env.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
[ -f .env ] || cp .env.example .env

set_var() {
  local name="$1" value="$2"
  if grep -q "^${name}=" .env; then
    sed -i '' "s|^${name}=.*|${name}=${value}|" .env
  else
    printf '%s=%s\n' "$name" "$value" >> .env
  fi
}

get_var() { grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }

for name in DEPLOYER ATTACKER WEAKBRIDGE_VERIFIER SAFE_SIGNER_1 SAFE_SIGNER_2 SAFE_SIGNER_3; do
  key_var="${name}_PRIVATE_KEY"
  addr_var="${name}_ADDRESS"
  key="$(get_var "$key_var")"
  if [ -z "$key" ]; then
    key="$(cast wallet new --json | python3 -c 'import json,sys; print((lambda d: (d.get("data", d) if isinstance(d, dict) else d))(json.load(sys.stdin))[0]["private_key"])')"
    set_var "$key_var" "$key"
  fi
  addr="$(cast wallet address --private-key "$key")"
  set_var "$addr_var" "$addr"
  printf '%-22s %s\n' "$name" "$addr"
done

if [ -z "$(get_var CRE_ETH_PRIVATE_KEY)" ]; then
  set_var CRE_ETH_PRIVATE_KEY "$(get_var DEPLOYER_PRIVATE_KEY | sed 's/^0x//')"
fi
