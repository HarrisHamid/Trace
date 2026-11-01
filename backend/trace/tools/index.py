"""Read-only view of one graph and its source files. Shared by the agent tools and the validator."""

from collections import defaultdict
from pathlib import Path

from backend.trace.schemas import Edge, Graph, Node

NO_SOURCE_TYPES = {"external", "unresolved"}


class GraphIndex:
    def __init__(self, graph: Graph, source_root: Path) -> None:
        self.graph = graph
        self.source_root = source_root.resolve()
        self.nodes: dict[str, Node] = {node.id: node for node in graph.nodes}
        self.outgoing: dict[str, list[Edge]] = defaultdict(list)
        self.incoming: dict[str, list[Edge]] = defaultdict(list)
        for edge in graph.edges:
            self.outgoing[edge.source].append(edge)
            self.incoming[edge.target].append(edge)

    @classmethod
    def load(cls, graph_path: Path, source_root: Path) -> GraphIndex:
        return cls(Graph.model_validate_json(graph_path.read_text(encoding="utf-8")), source_root)

    def edges_between(self, first: str, second: str) -> list[Edge]:
        """Edges joining two nodes, the first-to-second direction listed first."""
        forward = [edge for edge in self.outgoing[first] if edge.target == second]
        backward = [edge for edge in self.outgoing[second] if edge.target == first]
        return forward + backward

    def file_lines(self, file: str) -> list[str] | None:
        path = (self.source_root / file).resolve()
        if not path.is_relative_to(self.source_root) or not path.is_file():
            return None
        return path.read_text(encoding="utf-8").splitlines()

    def node_source(self, node: Node) -> str | None:
        """The original text of a node's lines, or None if it has no source in the repo."""
        if node.type in NO_SOURCE_TYPES:
            return None
        lines = self.file_lines(node.file)
        if lines is None:
            return None
        return "\n".join(lines[node.line_start - 1 : node.line_end])
