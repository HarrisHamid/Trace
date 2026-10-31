.PHONY: setup dev-api dev-web build-web test lint schemas

setup:
	uv sync
	cd web && npm install

dev-api:
	uv run uvicorn backend.trace.api:create_app --factory --reload --reload-dir backend --port 8000

dev-web:
	cd web && npm run dev

build-web:
	cd web && npm run build

test:
	uv run pytest

lint:
	uv run ruff check .
	cd web && npm run lint

schemas:
	uv run python scripts/export_schemas.py
