"""One bounded repair round, in plain code. Nothing here sets a status: repaired drafts go back through validate_path.

The model returns a patch and not a new path. A patch can add a quote to a flagged claim or a bridge node to a flagged gap.
It has no way to delete a step, delete a claim or change a sentence, so it cannot raise a score by removing hard claims.
"""

from collections import Counter
from dataclasses import dataclass
from typing import Any

from pydantic import Field

from backend.trace.schemas import Edge, PathStep
from backend.trace.schemas.base import Contract
from backend.trace.schemas.events import RepairIssue
from backend.trace.tools.graph_tools import MAX_SOURCE_LINES
from backend.trace.tools.index import NO_SOURCE_TYPES, GraphIndex

from .grounding import MIN_QUOTE_CHARS, DraftClaim, DraftPath, DraftStep, check_claim

MAX_BRIDGES = 3
UNHELPFUL_NEIGHBOURS = NO_SOURCE_TYPES | {"module"}


class ClaimFix(Contract):
    claim_id: str
    quote: str = Field(description="Exact source text proving the sentence as written, copied from the sources given.")
    at_previous_step: bool = Field(description="True if the quote is in the previous step's source, not the claim's own.")


class GapFix(Contract):
    gap_id: str
    node_id: str = Field(description="One of the bridges listed for this gap.")
    explanation: str = Field(description="What happens at this step, in one or two plain sentences.")


# What the model returns for a repair. A docstring here would be sent to the model, so this is a comment.
class DraftRepair(Contract):
    claims: list[ClaimFix]
    gaps: list[GapFix]


@dataclass(frozen=True)
class FlaggedClaim:
    id: str
    step: int
    position: int
    problem: str


@dataclass(frozen=True)
class FlaggedGap:
    id: str
    step: int
    text: str
    bridges: tuple[str, ...]


@dataclass(frozen=True)
class Flagged:
    claims: list[FlaggedClaim]
    gaps: list[FlaggedGap]
    left_alone: int


def _problem(claim: DraftClaim) -> str:
    quote = " ".join(claim.quote.split())
    if not quote:
        return "It has no quote."
    if len(quote) < MIN_QUOTE_CHARS:
        return f"Its quote is under {MIN_QUOTE_CHARS} characters."
    return "Its quote is not in this node's source."


def _is_firm(edge: Edge) -> bool:
    return edge.resolved and edge.type not in {"uncertain", "imports"}


def _firm_neighbours(node_id: str, index: GraphIndex) -> set[str]:
    out = {edge.target for edge in index.outgoing[node_id] if _is_firm(edge)}
    incoming = {edge.source for edge in index.incoming[node_id] if _is_firm(edge)}
    return {other for other in out | incoming if index.nodes[other].type not in UNHELPFUL_NEIGHBOURS}


def bridges(previous: str, current: str, on_path: set[str], index: GraphIndex) -> tuple[str, ...]:
    """Repo nodes with a firm edge to both ends. A node already on the path is the likely return hop, so it comes alone."""
    common = (_firm_neighbours(previous, index) & _firm_neighbours(current, index)) - {previous, current}
    return tuple(sorted(common & on_path) or sorted(common)[:MAX_BRIDGES])


def find_flagged(draft: DraftPath, steps: list[PathStep], index: GraphIndex) -> Flagged:
    """What the model could really fix. `draft` must be clean, so its steps line up with `steps`."""
    claims: list[FlaggedClaim] = []
    gaps: list[FlaggedGap] = []
    left_alone = 0
    on_path = {step.node_id for step in steps}
    for number, (draft_step, step) in enumerate(zip(draft.steps, steps, strict=True)):
        link, *model_claims = step.claims
        if link.status == "gap":
            found = bridges(steps[number - 1].node_id, step.node_id, on_path, index)
            if found:
                gaps.append(FlaggedGap(f"g{number}", number, link.text, found))
            else:
                left_alone += 1
        has_source = index.nodes[step.node_id].type not in NO_SOURCE_TYPES
        for position, claim in enumerate(model_claims):
            if claim.status != "unverified":
                continue
            if has_source:
                problem = _problem(draft_step.claims[position])
                claims.append(FlaggedClaim(f"c{number}.{position}", number, position, problem))
            else:
                left_alone += 1
    return Flagged(claims, gaps, left_alone)


def repair_issues(draft: DraftPath, flagged: Flagged) -> list[RepairIssue]:
    """The flagged items as the UI shows them, in path order."""
    issues = [
        (issue.step, RepairIssue(kind="gap", node_id=draft.steps[issue.step].node_id, text=issue.text))
        for issue in flagged.gaps
    ]
    issues += [
        (
            issue.step,
            RepairIssue(
                kind="claim", node_id=draft.steps[issue.step].node_id, text=draft.steps[issue.step].claims[issue.position].text
            ),
        )
        for issue in flagged.claims
    ]
    return [issue for _, issue in sorted(issues, key=lambda pair: pair[0])]


def _capped_source(node_id: str, index: GraphIndex) -> str | None:
    source = index.node_source(index.nodes[node_id])
    return None if source is None else "\n".join(source.splitlines()[:MAX_SOURCE_LINES])


def repair_brief(draft: DraftPath, flagged: Flagged, index: GraphIndex) -> dict[str, Any]:
    """The failures and the only source the model needs: each flagged step, the step before it, and each bridge."""
    claims, gaps, wanted = [], [], []
    for issue in flagged.claims:
        step = draft.steps[issue.step]
        claim = step.claims[issue.position]
        previous = draft.steps[issue.step - 1].node_id if issue.step else None
        claims.append(
            {
                "claim_id": issue.id,
                "step_node": step.node_id,
                "previous_step_node": previous,
                "sentence": claim.text,
                "problem": issue.problem,
                "failed_quote": claim.quote,
            }
        )
        wanted += [step.node_id, *([previous] if previous else [])]
    for issue in flagged.gaps:
        gaps.append(
            {
                "gap_id": issue.id,
                "from_node": draft.steps[issue.step - 1].node_id,
                "to_node": draft.steps[issue.step].node_id,
                "bridges": list(issue.bridges),
            }
        )
        wanted += issue.bridges
    sources = {node_id: _capped_source(node_id, index) for node_id in dict.fromkeys(wanted)}
    return {"claims": claims, "gaps": gaps, "sources": {key: text for key, text in sources.items() if text is not None}}


def apply_repair(draft: DraftPath, flagged: Flagged, repair: DraftRepair, index: GraphIndex) -> DraftPath:
    """Patch the draft. Only flagged ids can change, and a fix whose quote does not check out changes nothing."""
    waiting_claims = {issue.id: issue for issue in flagged.claims}
    waiting_gaps = {issue.id: issue for issue in flagged.gaps}
    claims: list[list[DraftClaim | None]] = [list(step.claims) for step in draft.steps]

    for fix in repair.claims:
        issue = waiting_claims.pop(fix.claim_id, None)
        if issue is None:
            continue
        moved = fix.at_previous_step and issue.step > 0
        target = issue.step - 1 if moved else issue.step
        mended = draft.steps[issue.step].claims[issue.position].model_copy(update={"quote": fix.quote})
        if check_claim(mended, index.nodes[draft.steps[target].node_id], index).status != "verified":
            continue
        if moved:
            claims[issue.step][issue.position] = None
            claims[target].append(mended)
        else:
            claims[issue.step][issue.position] = mended

    inserted: dict[int, DraftStep] = {}
    for fix in repair.gaps:
        gap = waiting_gaps.pop(fix.gap_id, None)
        if gap is not None and fix.node_id in gap.bridges and fix.explanation.strip():
            inserted[gap.step] = DraftStep(node_id=fix.node_id, explanation=fix.explanation, claims=[])

    steps: list[DraftStep] = []
    for number, step in enumerate(draft.steps):
        if number in inserted:
            steps.append(inserted[number])
        kept = [claim for claim in claims[number] if claim is not None]
        steps.append(step.model_copy(update={"claims": kept}))
    return DraftPath(steps=steps)


@dataclass(frozen=True)
class Measure:
    sentences: Counter[str]
    nodes: frozenset[str]
    verified: int
    gaps: int


def measure(steps: list[PathStep]) -> Measure:
    """The first claim of each step is the validator's. The rest are the model's."""
    model_claims = [claim for step in steps for claim in step.claims[1:]]
    return Measure(
        sentences=Counter(claim.text for claim in model_claims),
        nodes=frozenset(step.node_id for step in steps),
        verified=sum(claim.status == "verified" for claim in model_claims),
        gaps=sum(claim.status == "gap" for step in steps for claim in step.claims),
    )


def is_better(first: list[PathStep], repaired: list[PathStep]) -> bool:
    """Nothing lost, nothing worse, and something really improved. A patch cannot lose anything, and this proves it."""
    before, after = measure(first), measure(repaired)
    kept_everything = after.sentences == before.sentences and before.nodes <= after.nodes
    no_worse = after.verified >= before.verified and after.gaps <= before.gaps
    return kept_everything and no_worse and (after.verified > before.verified or after.gaps < before.gaps)
