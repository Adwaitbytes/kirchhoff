SHELL := /bin/bash
export PATH := $(HOME)/.foundry/bin:$(HOME)/.cre/bin:$(HOME)/.bun/bin:$(PATH)

.PHONY: check-creds wallets secrets install build lint typecheck test coverage contracts-test anvil deploy-local deploy-testnets e2e reset

check-creds:
	@node scripts/check-creds.mjs

wallets:
	@bash scripts/make-wallets.sh

secrets:
	@bash scripts/make-secrets.sh

install:
	pnpm install --frozen-lockfile
	cd contracts && npm ci

build:
	pnpm -r build
	cd contracts && forge build

lint:
	pnpm -r lint
	cd contracts && forge fmt --check

typecheck:
	pnpm -r typecheck

test:
	pnpm -r test
	cd contracts && forge test

coverage:
	pnpm --filter @kirchhoff/engine coverage

contracts-test:
	cd contracts && forge test -vv

anvil:
	bash demo/anvil-up.sh

deploy-local:
	pnpm --filter @kirchhoff/demo deploy-all --network local

deploy-testnets:
	pnpm --filter @kirchhoff/demo deploy-all --network testnet

e2e:
	pnpm --filter @kirchhoff/demo e2e --network testnet

reset:
	pnpm --filter @kirchhoff/demo reset --network testnet
