.PHONY: setup dev-api dev-api-real dev-web build-web test test-web lint schemas eval

setup:
	uv sync
	cd web && npm install

dev-api:
	uv run uvicorn backend.trace.api:create_app --factory --reload --reload-dir backend --port 8000

dev-api-real:
	TRACE_DATA_DIR=data/fastapi-template TRACE_SOURCE_DIR=third_party/fastapi-template \
		uv run uvicorn backend.trace.api:create_app --factory --reload --reload-dir backend --port 8000

dev-web:
	cd web && npm run dev

build-web:
	cd web && npm run build

test:
	uv run pytest

test-web:
	cd web && node --test scripts/filegraph.check.ts scripts/run.check.ts

lint:
	uv run ruff check .
	cd web && npm run lint

schemas:
	uv run python scripts/export_schemas.py

eval:
	uv run python -m eval.run_eval --score
	uv run python -m eval.run_eval --score-repair
