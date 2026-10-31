"""Graph contract: what the parser emits and what the agent tools and UI read."""

from collections import Counter
from typing import Literal, Self

from pydantic import Field, model_validator

from .base import Contract

NodeType = Literal["module", "class", "function", "route", "dependency", "external"]
EdgeType = Literal["calls", "imports", "inherits", "routes_to", "injects", "implements", "uncertain"]


class Node(Contract):
    id: str = Field(description='"module.path:qualname". Module nodes are just "module.path".')
    type: NodeType
    name: str
    file: str = Field(description='Repo-relative path. External stubs use "<external>".')
    line_start: int = Field(ge=0, description="1-based. External stubs use 0.")
    line_end: int = Field(ge=0, description="1-based, inclusive. External stubs use 0.")
    module: str
    signature: str | None = None
    docstring: str | None = None
    x: float | None = Field(default=None, description="Baked layout position.")
    y: float | None = Field(default=None, description="Baked layout position.")


class Edge(Contract):
    source: str
    target: str
    type: EdgeType
    line: int | None = None
    resolved: bool = Field(description="False when the parser could not prove the target.")
    note: str | None = None


class GraphStats(Contract):
    nodes_by_type: dict[NodeType, int]
    edges_by_type: dict[EdgeType, int]
    calls_resolved: int = Field(ge=0, description="Call sites proven to reach a node in the repo.")
    calls_uncertain: int = Field(ge=0, description="Call sites the parser could not resolve.")
    calls_external: int = Field(ge=0, description="Call sites leaving the repo. Not part of the rate.")
    call_resolution_rate: float | None = Field(
        description="calls_resolved / (calls_resolved + calls_uncertain), rounded to 4 places. Null with no such calls."
    )

    @model_validator(mode="after")
    def rate_matches_formula(self) -> Self:
        internal = self.calls_resolved + self.calls_uncertain
        expected = round(self.calls_resolved / internal, 4) if internal else None
        if self.call_resolution_rate != expected:
            raise ValueError(f"call_resolution_rate must be {expected}, got {self.call_resolution_rate}")
        return self


class Graph(Contract):
    repo: str
    commit_sha: str
    nodes: list[Node]
    edges: list[Edge]
    stats: GraphStats

    @model_validator(mode="after")
    def node_ids_are_unique(self) -> Self:
        dupes = sorted(nid for nid, n in Counter(node.id for node in self.nodes).items() if n > 1)
        if dupes:
            raise ValueError(f"duplicate node ids: {dupes}")
        return self
