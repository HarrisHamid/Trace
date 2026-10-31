"""Export the contracts to docs/contracts/*.schema.json. Pass --check to fail on drift instead of writing."""

import json
import sys
from pathlib import Path

from backend.trace.schemas import ChecksFile, Graph, event_adapter

OUT_DIR = Path(__file__).resolve().parents[1] / "docs" / "contracts"


def render() -> dict[str, str]:
    schemas = {
        "graph": Graph.model_json_schema(),
        "events": {"title": "AgentEvent", **event_adapter.json_schema()},
        "checks": ChecksFile.model_json_schema(),
    }
    return {f"{name}.schema.json": json.dumps(schema, indent=2) + "\n" for name, schema in schemas.items()}


def main() -> int:
    rendered = render()
    if "--check" in sys.argv:
        stale = [name for name, text in rendered.items() if not _matches(OUT_DIR / name, text)]
        if stale:
            print(f"stale contracts: {stale}. Run scripts/export_schemas.py", file=sys.stderr)
            return 1
        return 0
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, text in rendered.items():
        (OUT_DIR / name).write_text(text, encoding="utf-8")
        print(f"wrote {OUT_DIR / name}")
    return 0


def _matches(path: Path, text: str) -> bool:
    return path.exists() and path.read_text(encoding="utf-8") == text


if __name__ == "__main__":
    raise SystemExit(main())
