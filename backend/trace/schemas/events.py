"""SSE event contract for an agent run. Each event's SSE name is its `type`."""

from typing import Annotated, Any, Literal

from pydantic import Field, TypeAdapter

from .base import Contract

MAX_TOOL_CALLS = 8  # documented here, enforced by the agent loop

CALL_INDEX_DOC = f"0-based position of the tool call in the run. A run makes at most {MAX_TOOL_CALLS} tool calls."

ClaimStatus = Literal["verified", "unverified", "gap"]


class Claim(Contract):
    text: str
    quote: str | None = Field(default=None, description="Source text backing the claim.")
    status: ClaimStatus = Field(
        description=(
            "Set by the validator, never by the model. verified: the edge or the quoted source text exists. "
            "unverified: nothing backs it. gap: no edge joins this step to the previous one, or that edge is unresolved."
        )
    )


class PathStep(Contract):
    node_id: str
    explanation: str
    claims: list[Claim]


class RunStarted(Contract):
    type: Literal["run_started"]


class ToolCall(Contract):
    type: Literal["tool_call"]
    name: str
    args: dict[str, Any]
    call_index: int = Field(ge=0, description=CALL_INDEX_DOC)


class ToolResult(Contract):
    type: Literal["tool_result"]
    call_index: int = Field(ge=0, description=CALL_INDEX_DOC)
    summary: str


class NodeVisited(Contract):
    type: Literal["node_visited"]
    node_id: str
    reason: str


class FinalPath(Contract):
    """The first validated answer. A later `repair_finished` may replace it, and it stays in the run either way."""

    type: Literal["final_path"]
    steps: list[PathStep]


class RepairIssue(Contract):
    kind: Literal["claim", "gap"]
    node_id: str = Field(description="The step the issue is on. A gap belongs to the step after the missing link.")
    text: str = Field(description="The flagged claim, or the validator's sentence about the gap.")


class RepairStarted(Contract):
    type: Literal["repair_started"]
    issues: list[RepairIssue] = Field(description="What was sent back to the model for its one repair round.")
    left_alone: int = Field(
        ge=0, description="Flagged items not sent back, because no fix is possible: external steps, gaps with no bridge."
    )


class RepairFinished(Contract):
    type: Literal["repair_finished"]
    outcome: Literal["accepted", "no_improvement", "failed"]
    steps: list[PathStep] = Field(description="The repaired path, set by the validator. Empty unless accepted.")


class ErrorEvent(Contract):
    type: Literal["error"]
    message: str


class Done(Contract):
    type: Literal["done"]


Event = Annotated[
    RunStarted | ToolCall | ToolResult | NodeVisited | FinalPath | RepairStarted | RepairFinished | ErrorEvent | Done,
    Field(discriminator="type"),
]
event_adapter: TypeAdapter[Event] = TypeAdapter(Event)
