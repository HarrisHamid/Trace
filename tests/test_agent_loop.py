"""The loop against a scripted fake model. Nothing here calls Meta."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import openai
import pytest

from backend.trace.agent import loop, run_agent
from backend.trace.agent.loop import json_object, scoped_question
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
        self.options = []
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def with_options(self, **options):
        self.options.append(options)
        return self

    async def create(self, **request):
        self.requests.append({**request, "messages": list(request["messages"])})
        next_reply = self.replies.pop(0)
        if next_reply == "hang":
            await asyncio.sleep(60)
        if isinstance(next_reply, Exception):
            raise next_reply
        return next_reply


async def run(client):
    index = GraphIndex.load(MOCK / "graph.json", MOCK / "source")
    return [event async for event in run_agent("how does login work?", client=client, model="m", index=index)]


@pytest.mark.anyio
async def test_a_sentence_before_the_answer_json_is_ignored():
    prose = reply(content="I've charted the path.\n" + answer(LOGIN).choices[0].message.content)
    events = await run(FakeClient(reply(content="done"), prose))
    assert "final_path" in types(events) and "error" not in types(events)


def test_a_reply_with_no_json_object_is_left_alone_so_it_still_fails():
    assert json_object("no json here") == "no json here"
    assert json_object('x {"a": 1} y') == '{"a": 1}'


def test_a_question_from_a_file_names_the_file_and_what_it_defines():
    index = GraphIndex.load(MOCK / "graph.json", MOCK / "source")
    message = scoped_question("what does this do?", index.nodes[LOGIN].file, index)
    assert message.startswith(f"I am looking at {index.nodes[LOGIN].file}.")
    assert f"- {LOGIN} (" in message
    assert message.endswith("Question: what does this do?")


def test_a_question_without_a_file_or_from_an_unknown_file_is_unchanged():
    index = GraphIndex.load(MOCK / "graph.json", MOCK / "source")
    assert scoped_question("q", None, index) == "q"
    assert scoped_question("q", "nowhere.py", index) == "q"


@pytest.mark.anyio
async def test_the_file_reaches_the_model():
    client = FakeClient(reply(content="done"), answer(LOGIN))
    index = GraphIndex.load(MOCK / "graph.json", MOCK / "source")
    file = index.nodes[LOGIN].file
    [event async for event in run_agent("q", client=client, model="m", index=index, file=file)]
    assert client.requests[0]["messages"][1]["content"].startswith(f"I am looking at {file}.")


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


VERIFY = "taskboard.core.security:verify_password"
AUTHENTICATE = "taskboard.services.users:UserService.authenticate"
BCRYPT = "passlib.hash:bcrypt.verify"
QUOTE = "user = users.authenticate(form.email, form.password)"


def path_reply(*steps):
    return reply(content=json.dumps({"steps": list(steps)}))


def draft_step(node_id, *claims):
    return {"node_id": node_id, "explanation": "why", "claims": [{"text": t, "quote": q} for t, q in claims]}


def repair_reply(claims=(), gaps=()):
    return reply(content=json.dumps({"claims": list(claims), "gaps": list(gaps)}))


FLAGGED = path_reply(draft_step(LOGIN, ("Checks the password.", "")))
FIX = {"claim_id": "c0.0", "quote": QUOTE, "at_previous_step": False}


def outcome(events):
    return next(event for event in events if event.type == "repair_finished")


@pytest.mark.anyio
async def test_a_clean_answer_makes_no_extra_call_and_streams_as_before():
    client = FakeClient(reply(content="done"), path_reply(draft_step(LOGIN, ("Checks the password.", QUOTE))))
    events = await run(client)
    assert types(events) == ["run_started", "final_path", "done"]
    assert len(client.requests) == 2


@pytest.mark.anyio
async def test_a_claim_on_a_library_is_not_worth_a_call():
    client = FakeClient(reply(content="done"), path_reply(draft_step(VERIFY), draft_step(BCRYPT, ("It hashes.", ""))))
    assert types(await run(client)) == ["run_started", "final_path", "done"]
    assert len(client.requests) == 2


@pytest.mark.anyio
async def test_a_repair_is_one_call_with_no_tools_and_the_first_answer_comes_first():
    client = FakeClient(reply(content="done"), FLAGGED, repair_reply([FIX]))
    events = await run(client)
    assert types(events) == ["run_started", "final_path", "repair_started", "repair_finished", "done"]
    assert len(client.requests) == 3
    request = client.requests[-1]
    assert "tools" not in request and "response_format" in request
    assert request["response_format"]["json_schema"]["name"] == "path_repair"
    assert QUOTE in request["messages"][-1]["content"]


@pytest.mark.anyio
async def test_the_repair_call_has_one_try_and_a_short_limit():
    client = FakeClient(reply(content="done"), FLAGGED, repair_reply([FIX]))
    await run(client)
    assert client.options == [{"timeout": loop.REPAIR_TIMEOUT_SECONDS, "max_retries": 0}]


@pytest.mark.anyio
async def test_the_validator_sets_the_status_of_a_repaired_claim():
    events = await run(FakeClient(reply(content="done"), FLAGGED, repair_reply([FIX])))
    first = next(event for event in events if event.type == "final_path")
    assert first.steps[0].claims[1].status == "unverified"
    repaired = outcome(events)
    assert repaired.outcome == "accepted"
    assert (repaired.steps[0].claims[1].status, repaired.steps[0].claims[1].quote) == ("verified", QUOTE)


@pytest.mark.anyio
async def test_there_is_only_one_round_even_if_something_stays_flagged():
    two = path_reply(draft_step(LOGIN, ("One.", ""), ("Two.", "")))
    client = FakeClient(reply(content="done"), two, repair_reply([FIX]))
    events = await run(client)
    assert outcome(events).outcome == "accepted"
    assert len(client.requests) == 3


@pytest.mark.anyio
async def test_a_repair_that_fixes_nothing_keeps_the_first_answer():
    events = await run(FakeClient(reply(content="done"), FLAGGED, repair_reply()))
    assert (outcome(events).outcome, outcome(events).steps) == ("no_improvement", [])


@pytest.mark.anyio
@pytest.mark.parametrize(
    "bad",
    [
        openai.APIConnectionError(request=httpx.Request("POST", "https://example.test")),
        reply(content="not json"),
        reply(content=None),
        SimpleNamespace(choices=[]),
    ],
    ids=["api error", "bad json", "empty", "no choices"],
)
async def test_a_failed_repair_never_loses_the_answer_or_shows_an_error(bad):
    events = await run(FakeClient(reply(content="done"), FLAGGED, bad))
    assert types(events) == ["run_started", "final_path", "repair_started", "repair_finished", "done"]
    assert (outcome(events).outcome, outcome(events).steps) == ("failed", [])


@pytest.mark.anyio
async def test_a_repair_that_hangs_is_cut_off(monkeypatch):
    monkeypatch.setattr(loop, "REPAIR_TIMEOUT_SECONDS", 0.01)
    events = await run(FakeClient(reply(content="done"), FLAGGED, "hang"))
    assert outcome(events).outcome == "failed"
    assert types(events)[-1] == "done"


@pytest.mark.anyio
async def test_a_cancelled_run_stays_cancelled():
    index = GraphIndex.load(MOCK / "graph.json", MOCK / "source")
    client = FakeClient(reply(content="done"), FLAGGED, "hang")

    async def drain():
        async for _ in run_agent("q", client=client, model="m", index=index):
            pass

    task = asyncio.create_task(drain())
    await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.anyio
async def test_a_gap_can_be_closed_with_a_bridge():
    gap_path = path_reply(draft_step(ROUTE), draft_step(AUTHENTICATE))
    fix = {"gap_id": "g1", "node_id": LOGIN, "explanation": "login calls the service."}
    client = FakeClient(reply(content="done"), gap_path, repair_reply(gaps=[fix]))
    events = await run(client)
    assert [step.node_id for step in outcome(events).steps] == [ROUTE, LOGIN, AUTHENTICATE]
    assert all(claim.status == "verified" for step in outcome(events).steps for claim in step.claims)
