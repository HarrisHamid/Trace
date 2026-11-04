"""The agent run: investigate with tools, make one structured-output call, validate, then one bounded repair."""

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from openai import APIError, AsyncOpenAI
from pydantic import ValidationError

from backend.trace.schemas import MAX_TOOL_CALLS, PathStep
from backend.trace.schemas.events import (
    Done,
    ErrorEvent,
    Event,
    FinalPath,
    NodeVisited,
    RepairFinished,
    RepairStarted,
    RunStarted,
    ToolCall,
    ToolResult,
)
from backend.trace.tools import GraphIndex, run_tool, tool_schemas
from backend.trace.validator import (
    DraftPath,
    DraftRepair,
    apply_repair,
    clean_draft,
    find_flagged,
    is_better,
    repair_brief,
    repair_issues,
    validate_path,
)

logger = logging.getLogger(__name__)

INVESTIGATE_PROMPT = f"""You explain a Python codebase by walking its call graph.

Work only from what the tools return. You have at most {MAX_TOOL_CALLS} tool calls, so plan them. Start from a route or a
named function, follow real edges, and read the source of the nodes that matter. Stop calling tools once you can answer."""

ANSWER_PROMPT = """Write the final path through the graph that answers the question.

- Use exact node ids that a tool returned, in the order execution moves through them.
- Each step must be joined to the previous one by an edge you saw. A class and its method have no edge between them, so
  go straight to the method.
- Repeat a node only when execution really returns to it.
- A path may end at an external library call.
- Write for a developer reading the code. Do not mention tools, the graph or what you did not fetch.
- Give each claim a short quote copied exactly from read_source. Use "" when you have no quote.
- If you could not trace a link, say so plainly rather than guessing.
- Your claims are checked against the graph and the source."""

REPAIR_PROMPT = """The validator checked your path and flagged the items in the data below. Fix what you can, using only
the sources given.

- claims: find the one line or short passage that proves the sentence exactly as written. Give its claim_id and the quote,
  copied exactly, from 12 to 200 characters long. Set at_previous_step to true if the text is in the previous step's
  source, such as the line that calls this step, and to false if it is in the claim's own step.
- gaps: pick the bridge that execution really passes through between the two steps. Give its gap_id, its node_id and a one
  or two sentence explanation for a developer reading the code.
- Leave out anything you cannot prove. It stays flagged, and that is the right result. Do not attach a line that only
  mentions the same words.
- You cannot change a sentence, delete a step or delete a claim. Your fixes are checked the same way as before.

"""

NOT_RUN = '{"error": "Not run: the tool call limit was reached."}'

REPAIR_TIMEOUT_SECONDS = 45


def _output_format(name: str, schema: type[DraftPath | DraftRepair]) -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {"name": name, "strict": True, "schema": schema.model_json_schema()},
    }


async def _investigate(
    messages: list[dict[str, Any]], client: AsyncOpenAI, model: str, index: GraphIndex
) -> AsyncIterator[Event]:
    used = 0
    visited: set[str] = set()
    tools = tool_schemas()
    while used < MAX_TOOL_CALLS:
        response = await client.chat.completions.create(model=model, messages=messages, tools=tools)
        message = response.choices[0].message
        if not message.tool_calls:
            return
        messages.append(message.model_dump(exclude_none=True))
        for call in message.tool_calls:
            if used >= MAX_TOOL_CALLS:
                messages.append({"role": "tool", "tool_call_id": call.id, "content": NOT_RUN})
                continue
            call_index = used
            used += 1
            name, raw_args = call.function.name, call.function.arguments
            yield ToolCall(type="tool_call", name=name, args=_shown_args(raw_args), call_index=call_index)
            outcome = run_tool(index, name, raw_args)
            messages.append({"role": "tool", "tool_call_id": call.id, "content": outcome.content})
            yield ToolResult(type="tool_result", call_index=call_index, summary=outcome.summary)
            for node_id, reason in outcome.visited.items():
                if node_id not in visited:
                    visited.add(node_id)
                    yield NodeVisited(type="node_visited", node_id=node_id, reason=reason)


def _shown_args(raw_args: str) -> dict[str, Any]:
    """Arguments for the UI log. Malformed JSON is shown as text; run_tool reports it to the model."""
    try:
        parsed = json.loads(raw_args or "{}")
    except json.JSONDecodeError:
        return {"raw": raw_args}
    return parsed if isinstance(parsed, dict) else {"raw": raw_args}


def json_object(content: str) -> str:
    """The JSON object in a reply. The model sometimes writes a sentence before it despite the response format."""
    start, end = content.find("{"), content.rfind("}")
    return content[start : end + 1] if 0 <= start < end else content


async def _answer(messages: list[dict[str, Any]], client: AsyncOpenAI, model: str) -> DraftPath:
    messages.append({"role": "user", "content": ANSWER_PROMPT})
    response_format = _output_format("final_path", DraftPath)
    response = await client.chat.completions.create(model=model, messages=messages, response_format=response_format)
    content = response.choices[0].message.content or ""
    draft = DraftPath.model_validate_json(json_object(content))
    messages.append({"role": "assistant", "content": content})
    return draft


async def _repair(
    messages: list[dict[str, Any]],
    draft: DraftPath,
    first: list[PathStep],
    client: AsyncOpenAI,
    model: str,
    index: GraphIndex,
) -> AsyncIterator[Event]:
    """One extra model call with no tools. The first answer is already on screen, so nothing here may end the run."""
    try:
        flagged = find_flagged(draft, first, index)
        if not flagged.claims and not flagged.gaps:
            return
        issues = repair_issues(draft, flagged)
        yield RepairStarted(type="repair_started", issues=issues, left_alone=flagged.left_alone)
        content = REPAIR_PROMPT + json.dumps(repair_brief(draft, flagged, index), ensure_ascii=False)
        messages.append({"role": "user", "content": content})
        one_try = client.with_options(timeout=REPAIR_TIMEOUT_SECONDS, max_retries=0)
        async with asyncio.timeout(REPAIR_TIMEOUT_SECONDS):
            response = await one_try.chat.completions.create(
                model=model, messages=messages, response_format=_output_format("path_repair", DraftRepair)
            )
        repair = DraftRepair.model_validate_json(json_object(response.choices[0].message.content or ""))
        repaired = validate_path(apply_repair(draft, flagged, repair, index), index)
    except Exception:
        logger.exception("Repair failed, so the first answer stands")
        yield RepairFinished(type="repair_finished", outcome="failed", steps=[])
        return
    if is_better(first, repaired):
        yield RepairFinished(type="repair_finished", outcome="accepted", steps=repaired)
    else:
        yield RepairFinished(type="repair_finished", outcome="no_improvement", steps=[])


# Enough of a file's contents to start from without a search, without crowding out the question.
MAX_LISTED_NODES = 40


def scoped_question(question: str, file: str | None, index: GraphIndex) -> str:
    """The question as the model sees it. Asked from a file's page, it names that file and what the file defines."""
    if not file:
        return question
    defined = [node for node in index.graph.nodes if node.file == file and node.type != "module"]
    if not defined:
        return question
    listing = "\n".join(
        f"- {node.id} ({node.type}, lines {node.line_start}-{node.line_end})" for node in defined[:MAX_LISTED_NODES]
    )
    more = f"\n- and {len(defined) - MAX_LISTED_NODES} more" if len(defined) > MAX_LISTED_NODES else ""
    return (
        f"I am looking at {file}. Answer about this file: start from the nodes it defines, and follow edges out of it "
        f"only as far as the question needs.\n\nNodes in {file}:\n{listing}{more}\n\nQuestion: {question}"
    )


async def run_agent(
    question: str, *, client: AsyncOpenAI, model: str, index: GraphIndex, file: str | None = None
) -> AsyncIterator[Event]:
    yield RunStarted(type="run_started")
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": INVESTIGATE_PROMPT},
        {"role": "user", "content": scoped_question(question, file, index)},
    ]
    try:
        async for event in _investigate(messages, client, model, index):
            yield event
        draft = clean_draft(await _answer(messages, client, model), index)
        steps = validate_path(draft, index)
        if steps:
            yield FinalPath(type="final_path", steps=steps)
            async for event in _repair(messages, draft, steps, client, model, index):
                yield event
        else:
            yield ErrorEvent(type="error", message="No step in the model's answer names a node in the graph.")
    except APIError as error:
        logger.exception("Model call failed")
        yield ErrorEvent(type="error", message=f"The model call failed: {type(error).__name__}.")
    except ValidationError:
        logger.exception("Model returned an answer that does not fit the schema")
        yield ErrorEvent(type="error", message="The model's answer did not fit the expected format.")
    yield Done(type="done")
