"""The agent run: investigate with tools, make one structured-output call, then validate."""

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from openai import APIError, AsyncOpenAI
from pydantic import ValidationError

from backend.trace.schemas import MAX_TOOL_CALLS
from backend.trace.schemas.events import (
    Done,
    ErrorEvent,
    Event,
    FinalPath,
    NodeVisited,
    RunStarted,
    ToolCall,
    ToolResult,
)
from backend.trace.tools import GraphIndex, run_tool, tool_schemas
from backend.trace.validator import DraftPath, validate_path

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

NOT_RUN = '{"error": "Not run: the tool call limit was reached."}'


def _answer_format() -> dict[str, Any]:
    return {
        "type": "json_schema",
        "json_schema": {"name": "final_path", "strict": True, "schema": DraftPath.model_json_schema()},
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


async def _answer(messages: list[dict[str, Any]], client: AsyncOpenAI, model: str, index: GraphIndex) -> Event:
    messages.append({"role": "user", "content": ANSWER_PROMPT})
    response = await client.chat.completions.create(model=model, messages=messages, response_format=_answer_format())
    draft = DraftPath.model_validate_json(response.choices[0].message.content or "")
    steps = validate_path(draft, index)
    if not steps:
        return ErrorEvent(type="error", message="No step in the model's answer names a node in the graph.")
    return FinalPath(type="final_path", steps=steps)


async def run_agent(question: str, *, client: AsyncOpenAI, model: str, index: GraphIndex) -> AsyncIterator[Event]:
    yield RunStarted(type="run_started")
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": INVESTIGATE_PROMPT},
        {"role": "user", "content": question},
    ]
    try:
        async for event in _investigate(messages, client, model, index):
            yield event
        yield await _answer(messages, client, model, index)
    except APIError as error:
        logger.exception("Model call failed")
        yield ErrorEvent(type="error", message=f"The model call failed: {type(error).__name__}.")
    except ValidationError:
        logger.exception("Model returned an answer that does not fit the schema")
        yield ErrorEvent(type="error", message="The model's answer did not fit the expected format.")
    yield Done(type="done")
