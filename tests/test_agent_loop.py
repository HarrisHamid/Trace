"""The loop against a scripted fake model. Nothing here calls Meta."""

import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import openai
import pytest

from backend.trace.agent import run_agent
from backend.trace.schemas import MAX_TOOL_CALLS
from backend.trace.tools import GraphIndex

MOCK = Path(__file__).resolve().parents[1] / "data" / "mock"
LOGIN = "taskboard.api.auth:login"
ROUTE = "taskboard.api.auth:POST /api/login"


def tool_call(name, call_id="c", **args):
    function = SimpleNamespace(name=name, arguments=json.dumps(args))
    return SimpleNamespace(id=call_id, function=function)


def reply(content=None, tool_calls=None):
    message = SimpleNamespace(
        content=content,
        tool_calls=tool_calls,
        model_dump=lambda **_: {"role": "assistant", "content": content, "calls": len(tool_calls or [])},
    )
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def answer(*node_ids):
    steps = [{"node_id": n, "explanation": "why", "claims": []} for n in node_ids]
    return reply(content=json.dumps({"steps": steps}))


class FakeClient:
    """Plays back replies. Records every request, with a copy of its messages."""

    def __init__(self, *replies):
        self.replies = list(replies)
        self.requests = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    async def create(self, **request):
        self.requests.append({**request, "messages": list(request["messages"])})
        next_reply = self.replies.pop(0)
        if isinstance(next_reply, Exception):
            raise next_reply
        return next_reply


async def run(client):
    index = GraphIndex.load(MOCK / "graph.json", MOCK / "source")
    return [event async for event in run_agent("how does login work?", client=client, model="m", index=index)]


def types(events):
    return [event.type for event in events]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_a_run_streams_the_contract_in_order():
    client = FakeClient(reply(tool_calls=[tool_call("read_source", node_id=LOGIN)]), reply(content="done"), answer(LOGIN))
    events = await run(client)
    assert types(events) == ["run_started", "tool_call", "tool_result", "node_visited", "final_path", "done"]
    assert events[1].args == {"node_id": LOGIN}


@pytest.mark.anyio
async def test_tools_and_structured_output_never_share_a_request():
    client = FakeClient(reply(tool_calls=[tool_call("get_node", node_id=LOGIN)]), reply(content="done"), answer(LOGIN))
    await run(client)
    investigate, _, final = client.requests
    assert "tools" in investigate and "response_format" not in investigate
    assert "response_format" in final and "tools" not in final


@pytest.mark.anyio
async def test_the_final_path_goes_through_the_validator():
    events = await run(FakeClient(reply(content="done"), answer(ROUTE, "made:up", LOGIN)))
    final = next(event for event in events if event.type == "final_path")
    assert [step.node_id for step in final.steps] == [ROUTE, LOGIN]


@pytest.mark.anyio
async def test_the_cap_stops_the_loop_after_eight_calls_across_turns():
    turns = [reply(tool_calls=[tool_call("get_node", call_id=str(n), node_id=LOGIN)]) for n in range(MAX_TOOL_CALLS)]
    client = FakeClient(*turns, answer(LOGIN))
    events = await run(client)
    assert types(events).count("tool_call") == MAX_TOOL_CALLS
    assert len(client.requests) == MAX_TOOL_CALLS + 1
    assert "final_path" in types(events)


@pytest.mark.anyio
async def test_the_cap_counts_calls_not_turns_and_answers_the_extras():
    calls = [tool_call("get_node", call_id=str(n), node_id=LOGIN) for n in range(MAX_TOOL_CALLS + 3)]
    client = FakeClient(reply(tool_calls=calls), answer(LOGIN))
    events = await run(client)
    assert [event.call_index for event in events if event.type == "tool_call"] == list(range(MAX_TOOL_CALLS))
    tool_replies = [m for m in client.requests[-1]["messages"] if m["role"] == "tool"]
    assert len(tool_replies) == len(calls)
    assert all("Not run" in m["content"] for m in tool_replies[MAX_TOOL_CALLS:])


@pytest.mark.anyio
async def test_a_node_is_announced_once():
    calls = [tool_call("get_node", call_id=str(n), node_id=LOGIN) for n in range(3)]
    events = await run(FakeClient(reply(tool_calls=calls), reply(content="done"), answer(LOGIN)))
    assert types(events).count("node_visited") == 1


@pytest.mark.anyio
async def test_malformed_tool_arguments_do_not_end_the_run():
    bad = tool_call("get_node")
    bad.function.arguments = "{oops"
    events = await run(FakeClient(reply(tool_calls=[bad]), reply(content="done"), answer(LOGIN)))
    assert next(event for event in events if event.type == "tool_call").args == {"raw": "{oops"}
    assert "final_path" in types(events)


@pytest.mark.anyio
async def test_an_answer_with_no_real_nodes_is_an_error_not_an_empty_path():
    events = await run(FakeClient(reply(content="done"), answer("made:up")))
    assert types(events) == ["run_started", "error", "done"]


@pytest.mark.anyio
async def test_an_answer_outside_the_schema_is_an_error():
    events = await run(FakeClient(reply(content="done"), reply(content="not json")))
    assert types(events) == ["run_started", "error", "done"]


@pytest.mark.anyio
async def test_a_model_failure_is_an_error_event_and_the_stream_ends():
    request = httpx.Request("POST", "https://example.test")
    failure = openai.APIConnectionError(request=request)
    events = await run(FakeClient(failure))
    assert types(events) == ["run_started", "error", "done"]
    assert events[1].message == "The model call failed: APIConnectionError."
