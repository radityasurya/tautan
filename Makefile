# Makefile — local dev loop for tautan. `make help` for the list.
#
# `make dev` frees the dev ports, starts the Hub (Bun, --watch) and the web dev server
# (Vite HMR), exposes the UI over the tailnet with `tailscale serve`, and prints the URLs.
# Ctrl-C stops both. The Hub is reached through Vite's /api proxy, so only the UI port
# needs a tailnet mapping.

SHELL := /bin/bash
.DEFAULT_GOAL := help

PNPM     ?= pnpm
UI_PORT  ?= 5173
HUB_PORT ?= 7700
TS_PORT  ?= 5173
TS_HOST  ?= $(shell tailscale status --json 2>/dev/null | jq -r '.Self.DNSName' | sed 's/\.$$//')
# Smart replies provider: zai (key from ZAI_API_KEY or ~/.config/zai/api-key), anthropic
# (ANTHROPIC_API_KEY), or off. Every other TAUTAN_* variable in the README passes through
# from your shell as it is, e.g. `TAUTAN_SUGGEST_MODEL=glm-5.3 make dev`.
TAUTAN_SUGGEST ?= zai

.PHONY: help install dev stop kill-ports test check build

help: ## List targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN{FS=":.*?## "}{printf "  %-12s %s\n", $$1, $$2}'

install: ## Install dependencies
	$(PNPM) install

kill-ports: ## Free the dev ports (UI + Hub) from any leftover process
	@for p in $(UI_PORT) $(HUB_PORT); do \
		pids=$$(lsof -ti tcp:$$p 2>/dev/null); \
		[ -z "$$pids" ] && continue; \
		echo "  freeing port $$p (leftover pids: $$pids)"; \
		kill $$pids 2>/dev/null || true; \
		sleep 0.3; \
		kill -9 $$pids 2>/dev/null || true; \
	done

dev: kill-ports ## Hub + web (Vite HMR) + tailscale serve. Ctrl-C stops both.
	@[ -d node_modules ] || (echo "installing deps…"; $(PNPM) install)
	@tailscale serve --bg --https=$(TS_PORT) http://127.0.0.1:$(UI_PORT) >/dev/null 2>&1 \
		|| echo "  (tailscale serve unavailable — the tailnet URL may not work)"
	@echo ""
	@echo "  local:    http://127.0.0.1:$(UI_PORT)/"
	@echo "  tailnet:  https://$(TS_HOST):$(TS_PORT)/   (open this on the phone)"
	@echo "  hub api:  http://127.0.0.1:$(HUB_PORT)/api/state"
	@echo "  replies:  $(TAUTAN_SUGGEST)   (turn on Settings → Smart replies; make dev TAUTAN_SUGGEST=off to stop)"
	@echo ""
	@trap 'trap - INT TERM EXIT; echo; echo "  stopping dev stack…"; kill 0 2>/dev/null' INT TERM EXIT; \
		TAUTAN_PORT=$(HUB_PORT) TAUTAN_SUGGEST=$(TAUTAN_SUGGEST) bun --watch server/main.ts & \
		$(PNPM) exec vite --port $(UI_PORT) & \
		wait

stop: kill-ports ## Stop leftovers and remove the tailscale serve mapping
	@tailscale serve --https=$(TS_PORT) off >/dev/null 2>&1 || true
	@echo "  stopped"

test: ## Unit and contract tests (bun test)
	$(PNPM) test

check: ## Typecheck + build
	$(PNPM) typecheck && $(PNPM) build

build: ## Build the web app to dist/web
	$(PNPM) build
