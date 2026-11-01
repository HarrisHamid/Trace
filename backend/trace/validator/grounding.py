"""Grounding validator: plain code, no AI. Only this module decides a claim's status.

"verified" means the edge exists or the quoted text exists. It does not prove the model's sentence about that text.
"""

import logging

from pydantic import Field

from backend.trace.schemas import Claim, Edge, Node, PathStep
from backend.trace.schemas.base import Contract
from backend.trace.tools.index import NO_SOURCE_TYPES, GraphIndex

logger = logging.getLogger(__name__)

MIN_QUOTE_CHARS = 12

EDGE_PHRASES = {
    "routes_to": "routes to",
    "calls": "calls",
    "injects": "injects",
    "implements": "implements",
    "inherits": "inherits from",
    "imports": "imports",
}


class DraftClaim(Contract):
    text: str = Field(description="One factual statement about this step.")
    quote: str = Field(description='Exact source text backing the statement, copied from read_source, or "" if none.')


class DraftStep(Contract):
    node_id: str = Field(description="An exact node id returned by a tool.")
    explanation: str = Field(description="What happens at this step, in one or two plain sentences.")
    claims: list[DraftClaim]


class DraftPath(Contract):
    """What the model returns. It has no status field: the model cannot mark its own claims."""

    steps: list[DraftStep]


def _flat(text: str) -> str:
    return " ".join(text.split())


def _location_claim(node: Node) -> Claim:
    return Claim(text=f"{node.name} is defined in {node.file} at line {node.line_start}.", status="verified")


def _edge_line(edge: Edge, index: GraphIndex) -> str | None:
    source = index.nodes[edge.source]
    lines = index.file_lines(source.file) if source.type not in NO_SOURCE_TYPES and edge.line else None
    if lines is None or edge.line > len(lines):
        return None
    return lines[edge.line - 1].strip() or None


def link_claim(previous: Node, current: Node, index: GraphIndex) -> Claim:
    """The claim for the hop into `current`, written from the graph."""
    edges = index.edges_between(previous.id, current.id)
    firm = next((edge for edge in edges if edge.resolved and edge.type != "uncertain"), None)
    if firm:
        source, target = index.nodes[firm.source], index.nodes[firm.target]
        at_line = f" at line {firm.line}" if firm.line else ""
        text = f"{source.name} {EDGE_PHRASES[firm.type]} {target.name}{at_line}."
        return Claim(text=text, quote=_edge_line(firm, index), status="verified")
    if edges:
        return Claim(text=f"The parser could not prove the link from {previous.name} to {current.name}.", status="gap")
    return Claim(text=f"No edge in the graph joins {previous.name} to {current.name}.", status="gap")


def check_claim(claim: DraftClaim, node: Node, previous: Node | None, index: GraphIndex) -> Claim:
    """External and unresolved nodes have no source, so their quotes are checked at the call site."""
    owner = previous if node.type in NO_SOURCE_TYPES else node
    source = index.node_source(owner) if owner else None
    quote = _flat(claim.quote)
    if source is None or len(quote) < MIN_QUOTE_CHARS or quote not in _flat(source):
        return Claim(text=claim.text, status="unverified")
    return Claim(text=claim.text, quote=claim.quote.strip(), status="verified")


def validate_path(draft: DraftPath, index: GraphIndex) -> list[PathStep]:
    steps: list[PathStep] = []
    previous: Node | None = None
    for step in draft.steps:
        node = index.nodes.get(step.node_id)
        if node is None:
            logger.warning("Dropped a step naming a node not in the graph: %s", step.node_id)
            continue
        if previous is not None and node.id == previous.id:
            continue
        first_claim = link_claim(previous, node, index) if previous else _location_claim(node)
        model_claims = [check_claim(claim, node, previous, index) for claim in step.claims]
        steps.append(PathStep(node_id=node.id, explanation=step.explanation, claims=[first_claim, *model_claims]))
        previous = node
    return steps
