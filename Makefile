# Entry point for every command in this project: `make help`.

SHELL       := /bin/bash
TMUX_SOCKET := fleet-poc
SOURCES     := $(shell find src test -name '*.js' 2>/dev/null)

.DEFAULT_GOAL := help
.PHONY: help install build lint test smoke check start clean distclean

help: ## List available commands
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (Electron, xterm.js)
	npm install

build: install lint ## No bundler: install dependencies, then check every source file
	@echo "build ok — Electron runs the sources directly"

lint: ## Parse every JS source file (syntax check, no external linter)
	@for f in $(SOURCES); do node --check "$$f" || exit 1; done
	@echo "lint ok — $(words $(SOURCES)) files"

test: ## Unit tests: arbiter state machine, fake clock and fake timers
	npm test

smoke: ## End-to-end: real tmux control mode, real HTTP hooks, real SQLite
	npm run smoke

check: lint test smoke ## Everything a change must pass before it lands

start: ## Launch the Electron app and its fleet of Claude Code sessions
	npm start

clean: ## Kill the POC tmux server and drop generated run artifacts
	-tmux -L $(TMUX_SOCKET) kill-server 2>/dev/null
	rm -rf run/*.settings.json run/fleet.db run/fleet.db-shm run/fleet.db-wal

distclean: clean ## clean, plus node_modules
	rm -rf node_modules
