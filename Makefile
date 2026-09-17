# Entry point for every command in this project: `make help`.

SHELL       := /bin/bash
TMUX_SOCKET := fleet-poc

.DEFAULT_GOAL := help
.PHONY: help install typecheck lint build test smoke check start package clean distclean

help: ## List available commands
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (Electron, xterm.js, TypeScript, esbuild, ESLint)
	npm install

typecheck: install ## Type-check every source and test file (tsc --noEmit, strict)
	npm run typecheck

lint: install ## Lint every source and test file (ESLint, typescript-eslint)
	npm run lint

build: install ## Compile every entry point with esbuild: main, preload, renderer, tests
	npm run build

test: build ## Unit tests: arbiter state machine, fake clock and fake timers
	npm test

smoke: build ## End-to-end: real tmux control mode, real HTTP hooks, real SQLite
	npm run smoke

check: typecheck lint test smoke ## Everything a change must pass before it lands

start: build ## Launch the Electron app and its fleet of Claude Code sessions
	npm start

package: build ## Build the macOS disk image into release/ (ad-hoc signed, arm64)
	npm run package

clean: ## Kill the POC tmux server and drop generated run artifacts
	-tmux -L $(TMUX_SOCKET) kill-server 2>/dev/null
	rm -rf dist release run/*.settings.json run/fleet.db run/fleet.db-shm run/fleet.db-wal

distclean: clean ## clean, plus node_modules
	rm -rf node_modules
