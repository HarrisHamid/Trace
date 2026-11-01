"""The tools the agent calls. Each returns JSON for the model and a one-line summary for the UI."""

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from backend.trace.schemas import Edge, Node

from .index import GraphIndex

MAX_SEARCH_RESULTS = 10
MAX_NEIGHBORS = 40
MAX_SOURCE_LINES = 120
MAX_INJECTION_DEPTH = 5


class ToolArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SearchNodes(ToolArgs):
    query: str = Field(min_length=1, description="Words to match against node names, ids and docstrings.")


class FindRoutes(ToolArgs):
    query: str = Field(default="", description='Filter on method or path, such as "login". Empty lists every route.')


class NodeArg(ToolArgs):
    node_id: str = Field(description='An exact node id, such as "app.api.deps:get_current_user".')


class GetNeighbors(NodeArg):
    direction: Literal["callers", "callees", "both"] = Field(
        default="callees", description="callers: edges into the node. callees: edges out of it."
    )


@dataclass
class ToolOutcome:
    content: str
    summary: str
    visited: dict[str, str] = field(default_factory=dict)


def _outcome(data: dict[str, Any], summary: str, visited: dict[str, str] | None = None) -> ToolOutcome:
    return ToolOutcome(json.dumps(data, ensure_ascii=False), summary, visited or {})


def _error(message: str) -> ToolOutcome:
    return _outcome({"error": message}, message)


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _brief(node: Node) -> dict[str, Any]:
    return {"node_id": node.id, "type": node.type, "signature": node.signature, "file": node.file}


def _unknown_node(node_id: str) -> ToolOutcome:
    return _error(f"No node {node_id!r}. Use search_nodes to find the exact id.")


def _search_score(node: Node, words: list[str]) -> int:
    name, node_id, docstring = node.name.lower(), node.id.lower(), (node.docstring or "").lower()
    score = 0
    for word in words:
        if word == name:
            score += 8
        elif word in name:
            score += 4
        elif word in node_id:
            score += 2
        elif word in docstring:
            score += 1
    return score


def search_nodes(index: GraphIndex, args: SearchNodes) -> ToolOutcome:
    words = args.query.lower().split()
    scored = [(_search_score(node, words), node) for node in index.nodes.values()]
    # External and unresolved stubs only appear when nothing in the repo matches.
    in_repo = [pair for pair in scored if pair[0] and pair[1].file != "<external>" and pair[1].type != "unresolved"]
    matches = sorted(in_repo or [pair for pair in scored if pair[0]], key=lambda pair: (-pair[0], pair[1].id))
    shown = [node for _, node in matches[:MAX_SEARCH_RESULTS]]
    names = ", ".join(node.name for node in shown[:3])
    count = "1 match" if len(matches) == 1 else f"{len(matches)} matches"
    summary = f"{count}: {names}." if shown else "No matches."
    return _outcome({"matches": [_brief(node) for node in shown], "total": len(matches)}, summary)


def find_routes(index: GraphIndex, args: FindRoutes) -> ToolOutcome:
    query = args.query.lower()
    routes = [node for node in index.nodes.values() if node.type == "route" and query in node.name.lower()]
    rows = [
        {
            "node_id": route.id,
            "handler": next((e.target for e in index.outgoing[route.id] if e.type == "routes_to"), None),
        }
        for route in sorted(routes, key=lambda node: node.id)
    ]
    return _outcome({"routes": rows}, f"{_plural(len(rows), 'route')} found.")


def get_node(index: GraphIndex, args: NodeArg) -> ToolOutcome:
    node = index.nodes.get(args.node_id)
    if node is None:
        return _unknown_node(args.node_id)
    data = {
        **_brief(node),
        "line_start": node.line_start,
        "line_end": node.line_end,
        "docstring": node.docstring,
        "edges_out": len(index.outgoing[node.id]),
        "edges_in": len(index.incoming[node.id]),
    }
    return _outcome(data, f"{node.name}, {node.type} in {node.file}.", {node.id: "The agent looked this node up."})


def _edge_row(edge: Edge, other_id: str, index: GraphIndex) -> dict[str, Any]:
    other = index.nodes[other_id]
    return {
        "node_id": other_id,
        "type": other.type,
        "edge": edge.type,
        "line": edge.line,
        "resolved": edge.resolved,
        "note": edge.note,
    }


def _neighbor_rows(index: GraphIndex, node_id: str, direction: str) -> list[dict[str, Any]]:
    rows = []
    if direction in ("callees", "both"):
        rows += [{"direction": "out", **_edge_row(e, e.target, index)} for e in index.outgoing[node_id]]
    if direction in ("callers", "both"):
        rows += [{"direction": "in", **_edge_row(e, e.source, index)} for e in index.incoming[node_id]]
    # Code in the repo first: externals are numerous and rarely the next step.
    return sorted(rows, key=lambda row: (row["type"] == "external", row["line"] or 0))


def get_neighbors(index: GraphIndex, args: GetNeighbors) -> ToolOutcome:
    node = index.nodes.get(args.node_id)
    if node is None:
        return _unknown_node(args.node_id)
    rows = _neighbor_rows(index, node.id, args.direction)
    in_repo = sum(row["type"] != "external" for row in rows)
    summary = f"{_plural(len(rows), 'edge')} from {node.name}, {in_repo} inside the repo."
    reason = f"The agent checked the {args.direction} of this node."
    data = {"neighbors": rows[:MAX_NEIGHBORS], "total": len(rows)}
    return _outcome(data, summary, {node.id: reason})


def follow_injections(index: GraphIndex, args: NodeArg) -> ToolOutcome:
    node = index.nodes.get(args.node_id)
    if node is None:
        return _unknown_node(args.node_id)
    links, seen, frontier = [], {node.id}, [node.id]
    for _ in range(MAX_INJECTION_DEPTH):
        reached = []
        for current in frontier:
            for edge in index.outgoing[current]:
                if edge.type == "injects":
                    links.append({"from": edge.source, "to": edge.target, "line": edge.line, "note": edge.note})
                    if edge.target not in seen:
                        seen.add(edge.target)
                        reached.append(edge.target)
        frontier = reached
    summary = f"{_plural(len(links), 'injection')} reached from {node.name}."
    return _outcome({"chain": links}, summary, {node.id: "The agent followed this node's dependency injections."})


def read_source(index: GraphIndex, args: NodeArg) -> ToolOutcome:
    node = index.nodes.get(args.node_id)
    if node is None:
        return _unknown_node(args.node_id)
    source = index.node_source(node)
    if source is None:
        return _error(f"{node.name} has no source in this repo.")
    lines = source.splitlines()
    data = {
        "file": node.file,
        "start_line": node.line_start,
        "source": "\n".join(lines[:MAX_SOURCE_LINES]),
        "truncated": len(lines) > MAX_SOURCE_LINES,
    }
    return _outcome(data, f"Read {_plural(len(lines), 'line')} of {node.name}.", {node.id: "The agent read this source."})


@dataclass(frozen=True)
class Tool:
    description: str
    args: type[ToolArgs]
    run: Callable[[GraphIndex, Any], ToolOutcome]


TOOLS: dict[str, Tool] = {
    "search_nodes": Tool("Find nodes in the code graph by name, id or docstring.", SearchNodes, search_nodes),
    "find_routes": Tool("List HTTP routes and the handler each one calls.", FindRoutes, find_routes),
    "get_node": Tool("Get a node's signature, docstring, file, lines and edge counts.", NodeArg, get_node),
    "get_neighbors": Tool("List a node's edges: what it calls, and what calls it.", GetNeighbors, get_neighbors),
    "follow_injections": Tool("Walk the FastAPI Depends chain from a node.", NodeArg, follow_injections),
    "read_source": Tool("Read a node's source text from the original file.", NodeArg, read_source),
}


def tool_schemas() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {"name": name, "description": tool.description, "parameters": tool.args.model_json_schema()},
        }
        for name, tool in TOOLS.items()
    ]


def run_tool(index: GraphIndex, name: str, raw_args: str) -> ToolOutcome:
    tool = TOOLS.get(name)
    if tool is None:
        return _error(f"No tool named {name!r}.")
    try:
        args = tool.args.model_validate_json(raw_args or "{}")
    except ValidationError as error:
        problems = "; ".join(f"{'.'.join(map(str, e['loc'])) or 'args'}: {e['msg']}" for e in error.errors())
        return _error(f"Bad arguments for {name}: {problems}")
    return tool.run(index, args)
