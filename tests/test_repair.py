"""The repair round in plain code. The tests named after a way to game the score are the point of this file."""

import json
from pathlib import Path

import pytest

from backend.trace.schemas import Claim, PathStep, event_adapter
from backend.trace.tools import GraphIndex
from backend.trace.validator import (
    DraftClaim,
    DraftPath,
    DraftRepair,
    DraftStep,
    apply_repair,
    clean_draft,
    find_flagged,
    is_better,
    repair_brief,
    repair_issues,
    validate_path,
)
from backend.trace.validator.repair import ClaimFix, GapFix, bridges

ROOT = Path(__file__).resolve().parents[1]
MOCK = ROOT / "data" / "mock"
ROUTE = "taskboard.api.auth:POST /api/login"
LOGIN = "taskboard.api.auth:login"
AUTHENTICATE = "taskboard.services.users:UserService.authenticate"
VERIFY = "taskboard.core.security:verify_password"
BCRYPT = "passlib.hash:bcrypt.verify"
QUOTE = "user = users.authenticate(form.email, form.password)"


@pytest.fixture
def index():
    return GraphIndex.load(MOCK / "graph.json", MOCK / "source")


def step(node_id, *claims):
    return DraftStep(node_id=node_id, explanation="why", claims=[DraftClaim(text=t, quote=q) for t, q in claims])


def checked(index, *steps):
    draft = clean_draft(DraftPath(steps=list(steps)), index)
    return draft, validate_path(draft, index), find_flagged(draft, validate_path(draft, index), index)


def fix(claim_id, quote=QUOTE, at_previous_step=False):
    return ClaimFix(claim_id=claim_id, quote=quote, at_previous_step=at_previous_step)


def patch(claims=(), gaps=()):
    return DraftRepair(claims=list(claims), gaps=list(gaps))


def nodes(path):
    return [s.node_id for s in path.steps]


def test_a_claim_on_a_repo_step_is_flagged_with_the_reason(index):
    _, _, flagged = checked(index, step(LOGIN, ("No quote.", ""), ("Short.", "abc"), ("Wrong.", "not in the source at all")))
    assert [c.id for c in flagged.claims] == ["c0.0", "c0.1", "c0.2"]
    assert [c.problem for c in flagged.claims] == [
        "It has no quote.",
        "Its quote is under 12 characters.",
        "Its quote is not in this node's source.",
    ]


def test_a_claim_on_a_library_step_is_left_alone_and_counted(index):
    _, _, flagged = checked(index, step(VERIFY), step(BCRYPT, ("It hashes.", "")))
    assert (flagged.claims, flagged.gaps, flagged.left_alone) == ([], [], 1)


def test_a_gap_with_a_bridge_is_flagged(index):
    _, _, flagged = checked(index, step(ROUTE), step(AUTHENTICATE))
    assert [(g.id, g.bridges) for g in flagged.gaps] == [("g1", (LOGIN,))]


def test_a_gap_with_no_bridge_is_left_alone_and_counted(index):
    _, _, flagged = checked(index, step(ROUTE), step(BCRYPT))
    assert (flagged.gaps, flagged.left_alone) == ([], 1)


def test_a_bridge_is_a_repo_node_never_a_shared_library_call(index):
    assert BCRYPT not in bridges(VERIFY, "taskboard.core.security:hash_password", set(), index)


def test_a_node_already_on_the_path_is_the_only_bridge_offered(index):
    assert bridges(ROUTE, AUTHENTICATE, {LOGIN, ROUTE}, index) == (LOGIN,)


def test_the_brief_holds_the_failure_and_the_source_of_the_step_and_the_one_before(index):
    draft, _, flagged = checked(index, step(ROUTE), step(AUTHENTICATE, ("Called with the form.", "made up")))
    brief = repair_brief(draft, flagged, index)
    assert brief["claims"][0]["failed_quote"] == "made up"
    assert brief["claims"][0]["previous_step_node"] == ROUTE
    assert {ROUTE, AUTHENTICATE, LOGIN} == set(brief["sources"])


def test_the_brief_never_offers_library_source(index):
    draft, _, flagged = checked(index, step(ROUTE), step(BCRYPT, ("It hashes.", "")), step(LOGIN, ("Claim.", "")))
    assert BCRYPT not in repair_brief(draft, flagged, index)["sources"]


def test_issues_read_as_the_user_will_see_them_in_path_order(index):
    draft, _, flagged = checked(index, step(ROUTE), step(AUTHENTICATE, ("A claim.", "")))
    issues = repair_issues(draft, flagged)
    assert [(i.kind, i.node_id) for i in issues] == [("gap", AUTHENTICATE), ("claim", AUTHENTICATE)]
    assert "No edge" in issues[0].text


def test_a_quote_fixes_a_claim_and_the_validator_marks_it(index):
    draft, first, flagged = checked(index, step(LOGIN, ("Checks the password.", "")))
    repaired = validate_path(apply_repair(draft, flagged, patch([fix("c0.0")]), index), index)
    assert first[0].claims[1].status == "unverified"
    assert (repaired[0].claims[1].status, repaired[0].claims[1].quote) == ("verified", QUOTE)


def test_a_claim_can_move_to_the_previous_step_when_the_proof_is_there(index):
    draft, _, flagged = checked(index, step(LOGIN), step(AUTHENTICATE, ("Login passes the form.", QUOTE)))
    mended = apply_repair(draft, flagged, patch([fix("c1.0", at_previous_step=True)]), index)
    assert [c.text for c in mended.steps[0].claims] == ["Login passes the form."]
    assert mended.steps[1].claims == []
    assert validate_path(mended, index)[0].claims[1].status == "verified"


def test_a_quote_that_fails_leaves_the_claim_where_it_was(index):
    draft, _, flagged = checked(index, step(LOGIN), step(AUTHENTICATE, ("Login passes the form.", "")))
    bad = fix("c1.0", quote="this text is in neither step", at_previous_step=True)
    assert apply_repair(draft, flagged, patch([bad]), index) == draft


def test_game_a_patch_cannot_change_a_sentence(index):
    assert "text" not in ClaimFix.model_fields
    with pytest.raises(ValueError, match="text"):
        ClaimFix(claim_id="c0.0", quote=QUOTE, at_previous_step=False, text="An easy claim.")


def test_game_a_patch_has_no_status_field():
    for model in (ClaimFix, GapFix, DraftRepair):
        assert "status" not in model.model_fields
        assert "status" not in json.dumps(model.model_json_schema())


def test_game_a_patch_has_no_way_to_delete():
    assert set(DraftRepair.model_fields) == {"claims", "gaps"}
    assert set(ClaimFix.model_fields) == {"claim_id", "quote", "at_previous_step"}
    assert set(GapFix.model_fields) == {"gap_id", "node_id", "explanation"}


def test_game_a_fix_cannot_touch_a_claim_that_was_not_flagged(index):
    draft, _, flagged = checked(index, step(LOGIN, ("Good.", QUOTE), ("Bad.", "")))
    assert [c.id for c in flagged.claims] == ["c0.1"]
    assert apply_repair(draft, flagged, patch([fix("c0.0", quote="def login(form")]), index) == draft


def test_game_a_claim_on_a_library_cannot_be_moved_onto_its_caller(index):
    source = index.node_source(index.nodes[VERIFY])
    call_site = next(line.strip() for line in source.splitlines() if "bcrypt.verify" in line)
    draft, _, flagged = checked(index, step(VERIFY), step(BCRYPT, ("bcrypt rejects a bad hash.", "")))
    moved = fix("c1.0", quote=call_site, at_previous_step=True)
    assert apply_repair(draft, flagged, patch([moved]), index) == draft


def test_game_a_claim_cannot_be_moved_onto_a_library_step(index):
    draft, _, flagged = checked(index, step(VERIFY), step(BCRYPT), step(VERIFY, ("Claim.", "")))
    assert apply_repair(draft, flagged, patch([fix("c2.0", at_previous_step=True)]), index) == draft


def test_game_a_bridge_not_on_the_list_is_ignored(index):
    draft, _, flagged = checked(index, step(ROUTE), step(AUTHENTICATE))
    stray = GapFix(gap_id="g1", node_id=VERIFY, explanation="A node worth points on the eval.")
    assert apply_repair(draft, flagged, patch(gaps=[stray]), index) == draft


def test_game_a_bridge_cannot_be_added_where_there_was_no_gap(index):
    draft, _, flagged = checked(index, step(LOGIN, ("Claim.", "")))
    stray = GapFix(gap_id="g0", node_id=VERIFY, explanation="Extra.")
    assert apply_repair(draft, flagged, patch(gaps=[stray]), index) == draft


def test_game_a_bridge_adds_no_model_claims_so_the_denominator_stays_fixed(index):
    draft, first, flagged = checked(index, step(ROUTE), step(AUTHENTICATE, ("A claim.", "")))
    bridge = GapFix(gap_id="g1", node_id=LOGIN, explanation="Login calls the service.")
    repaired = validate_path(apply_repair(draft, flagged, patch(gaps=[bridge]), index), index)
    assert sum(len(s.claims) - 1 for s in repaired) == sum(len(s.claims) - 1 for s in first)


def test_the_same_id_twice_applies_once(index):
    draft, _, flagged = checked(index, step(LOGIN, ("Claim.", "")))
    mended = apply_repair(draft, flagged, patch([fix("c0.0"), fix("c0.0", quote="something else")]), index)
    assert mended.steps[0].claims[0].quote == QUOTE


def test_a_bridge_needs_an_explanation(index):
    draft, _, flagged = checked(index, step(ROUTE), step(AUTHENTICATE))
    assert apply_repair(draft, flagged, patch(gaps=[GapFix(gap_id="g1", node_id=LOGIN, explanation=" ")]), index) == draft


def path_step(node_id, *statuses):
    claims = [Claim(text="where", status="verified")]
    claims += [Claim(text=f"{node_id} claim {n}", status=s) for n, s in enumerate(statuses)]
    return PathStep(node_id=node_id, explanation="why", claims=claims)


def gap_step(node_id):
    return PathStep(node_id=node_id, explanation="why", claims=[Claim(text="no edge", status="gap")])


def test_more_verified_is_better():
    assert is_better([path_step("a", "unverified")], [path_step("a", "verified")])


def test_fewer_gaps_is_better():
    assert is_better([path_step("a"), gap_step("b")], [path_step("a"), path_step("x"), path_step("b")])


def test_no_change_is_not_better():
    assert not is_better([path_step("a", "unverified")], [path_step("a", "unverified")])


def test_game_a_shorter_path_is_rejected_even_with_a_better_score():
    first = [path_step("a", "verified"), path_step("b", "unverified")]
    assert not is_better(first, [path_step("a", "verified")])


def test_game_a_path_that_swaps_a_node_is_rejected():
    assert not is_better([path_step("a", "unverified")], [path_step("b", "verified")])


def test_game_dropping_a_claim_is_rejected_even_when_the_share_rises():
    first = [path_step("a", "verified", "unverified")]
    assert not is_better(first, [path_step("a", "verified")])


def test_game_rewording_a_claim_is_rejected():
    reworded = path_step("a", "verified")
    reworded.claims[1].text = "An easy sentence."
    assert not is_better([path_step("a", "unverified")], [reworded])


def test_a_new_gap_is_rejected_even_if_a_claim_was_fixed():
    first = [path_step("a", "unverified"), path_step("b")]
    worse = [path_step("a", "verified"), gap_step("b")]
    assert not is_better(first, worse)


def recording(name):
    path = ROOT / "data" / "fastapi-template" / "answers" / name
    events = [event_adapter.validate_json(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return next(event for event in events if event.type == "final_path").steps


def as_draft(steps):
    """A recording drops failed quotes, so a claim comes back with whatever quote survived."""
    rebuilt = [
        DraftStep(
            node_id=s.node_id,
            explanation=s.explanation,
            claims=[DraftClaim(text=c.text, quote=c.quote or "") for c in s.claims[1:]],
        )
        for s in steps
    ]
    return DraftPath(steps=rebuilt)


def test_the_login_recording_flags_its_four_claims_and_the_skipped_authenticate():
    index = GraphIndex.load(ROOT / "data" / "fastapi-template" / "graph.json", Path("/nonexistent"))
    steps = recording("how-does-login-work.jsonl")
    flagged = find_flagged(as_draft(steps), steps, index)
    assert len(flagged.claims) == 4
    assert [g.bridges for g in flagged.gaps] == [("app.crud:authenticate",)]
    assert flagged.left_alone == 0


def test_the_create_item_recording_sends_only_what_can_be_fixed():
    index = GraphIndex.load(ROOT / "data" / "fastapi-template" / "graph.json", Path("/nonexistent"))
    steps = recording("what-happens-when-a-signed-in-user-creates-an-item.jsonl")
    flagged = find_flagged(as_draft(steps), steps, index)
    assert (len(flagged.claims), len(flagged.gaps), flagged.left_alone) == (1, 3, 5)
    assert all(g.bridges == ("app.api.routes.items:create_item",) for g in flagged.gaps)
