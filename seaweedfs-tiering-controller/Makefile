.PHONY: dev build run-ctrl run-collector migrate migrate-pg migrate-ch seed test fmt lint web-dev web-build clean

# docker compose service names (matches docker-compose.yml). Override if you
# rename the services or run against an external DB.
PG_SVC ?= postgres
CH_SVC ?= clickhouse

# ---------- Local dev ----------
dev:
	docker compose up -d postgres clickhouse
	@echo "waiting for DBs..." && sleep 4
	$(MAKE) migrate
	@echo "PG: localhost:5432  CH: localhost:9000"
	@echo "run 'make run-ctrl' and 'make web-dev' in two terminals"

build:
	go build -o bin/controller ./cmd/controller
	go build -o bin/collector ./cmd/collector

run-ctrl:
	go run ./cmd/controller --config config/config.dev.yaml

run-collector:
	go run ./cmd/collector --config config/config.dev.yaml

# ---------- DB ----------
# Migrations run via `docker compose exec` so no local psql / clickhouse-client
# is required. ON_ERROR_STOP=1 makes a single failure abort the whole batch.
migrate: migrate-pg migrate-ch

migrate-pg:
	@for f in migrations/pg/*.sql; do \
	  printf ">> %-50s " "$$f"; \
	  if docker compose exec -T $(PG_SVC) psql -U tier -d tiering -v ON_ERROR_STOP=1 -q < $$f >/dev/null 2>&1; then \
	    echo "OK"; \
	  else \
	    echo "FAIL"; exit 1; \
	  fi; \
	done

migrate-ch:
	@for f in migrations/clickhouse/*.sql; do \
	  printf ">> %-50s " "$$f"; \
	  if docker compose exec -T $(CH_SVC) clickhouse-client --multiquery < $$f >/dev/null 2>&1; then \
	    echo "OK"; \
	  else \
	    echo "FAIL"; exit 1; \
	  fi; \
	done

seed:
	go run ./cmd/controller seed

# ---------- QA ----------
test:
	go test ./... -race -count=1

fmt:
	gofmt -w .
	cd web && pnpm prettier --write .

lint:
	go vet ./...
	cd web && pnpm lint

# ---------- Web ----------
web-dev:
	cd web && pnpm install && pnpm dev

web-build:
	cd web && pnpm install && pnpm build

clean:
	rm -rf bin web/.next web/node_modules
	docker compose down -v
