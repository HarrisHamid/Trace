"""One test per row of the rules table in docs/prds/02-agent-validator.md, on the mock graph."""

from pathlib import Path

import pytest

from backend.trace.schemas import Edge
from backend.trace.tools import GraphIndex
from backend.trace.validator import DraftClaim, DraftPath, DraftStep, validate_path

MOCK = Path(__file__).resolve().parents[1] / "data" / "mock"
ROUTE = "taskboard.api.auth:POST /api/login"
LOGIN = "taskboard.api.auth:login"
AUTHENTICATE = "taskboard.services.users:UserService.authenticate"
UNRESOLVED = "taskboard.services.users:?self.rehash"
VERIFY = "taskboard.core.security:verify_password"
BCRYPT = "passlib.hash:bcrypt.verify"
QUOTE = "user = users.authenticate(form.email, form.password)"


@pytest.fixture
def index():
    return GraphIndex.load(MOCK / "graph.json", MOCK / "source")


def step(node_id, *claims):
    return DraftStep(node_id=node_id, explanation="why", claims=[DraftClaim(text=t, quote=q) for t, q in claims])


def path(*steps):
    return DraftPath(steps=list(steps))


def test_a_step_outside_the_graph_is_dropped_and_its_neighbours_are_checked(index):
    steps = validate_path(path(step(ROUTE), step("taskboard.made:up"), step(LOGIN)), index)
    assert [s.node_id for s in steps] == [ROUTE, LOGIN]
    assert steps[1].claims[0].status == "verified"


def test_dropping_a_step_can_expose_a_gap(index):
    steps = validate_path(path(step(ROUTE), step("taskboard.made:up"), step(VERIFY)), index)
    assert steps[1].claims[0].status == "gap"


def test_a_repeated_node_is_dropped(index):
    steps = validate_path(path(step(ROUTE), step(ROUTE), step(LOGIN)), index)
    assert [s.node_id for s in steps] == [ROUTE, LOGIN]


def test_a_path_may_return_to_an_earlier_node(index):
    steps = validate_path(path(step(ROUTE), step(LOGIN), step(ROUTE)), index)
    assert [s.claims[0].status for s in steps] == ["verified", "verified", "verified"]


def test_a_resolved_edge_gives_a_verified_link_with_its_source_line(index):
    link = validate_path(path(step(ROUTE), step(LOGIN)), index)[1].claims[0]
    assert link.status == "verified"
    assert link.text == "POST /api/login routes to login at line 12."
    assert link.quote == '@router.post("/api/login")'


def test_an_edge_counts_in_either_direction(index):
    link = validate_path(path(step(LOGIN), step(ROUTE)), index)[1].claims[0]
    assert link.status == "verified"
    assert link.text.startswith("POST /api/login routes to login")


def test_an_uncertain_edge_is_a_gap(index):
    link = validate_path(path(step(AUTHENTICATE), step(UNRESOLVED)), index)[1].claims[0]
    assert link.status == "gap"
    assert "could not prove" in link.text


def test_a_resolved_flag_of_false_is_a_gap_on_any_edge_type(index):
    index.outgoing[ROUTE].append(Edge(source=ROUTE, target=VERIFY, type="calls", resolved=False))
    assert validate_path(path(step(ROUTE), step(VERIFY)), index)[1].claims[0].status == "gap"


def test_no_edge_is_a_gap(index):
    link = validate_path(path(step(ROUTE), step(VERIFY)), index)[1].claims[0]
    assert link.status == "gap"
    assert "No edge" in link.text


def test_the_first_step_always_has_a_claim(index):
    only = validate_path(path(step(LOGIN)), index)[0].claims
    assert [(c.status, c.text) for c in only] == [
        ("verified", "login is defined in taskboard/api/auth.py at line 12."),
    ]


def test_a_quote_inside_the_node_verifies_the_claim(index):
    claim = validate_path(path(step(LOGIN, ("Checks the password.", QUOTE))), index)[0].claims[1]
    assert (claim.status, claim.quote) == ("verified", QUOTE)


def test_quotes_compare_with_whitespace_collapsed(index):
    spaced = "user =   users.authenticate(form.email,\n    form.password)"
    assert validate_path(path(step(LOGIN, ("c", spaced))), index)[0].claims[1].status == "verified"


@pytest.mark.parametrize(
    "quote",
    ["", "user = ", "this text is not anywhere in the file", "router = APIRouter()"],
    ids=["none", "too short", "invented", "same file but outside the node"],
)
def test_a_claim_without_a_good_quote_is_unverified_and_shows_no_quote(index, quote):
    claim = validate_path(path(step(LOGIN, ("Claim.", quote))), index)[0].claims[1]
    assert (claim.status, claim.quote) == ("unverified", None)


def test_a_quote_is_checked_against_the_original_file_on_disk(index, tmp_path):
    (tmp_path / "taskboard" / "api").mkdir(parents=True)
    (tmp_path / "taskboard" / "api" / "auth.py").write_text("changed\n" * 40)
    moved = GraphIndex(index.graph, tmp_path)
    assert validate_path(path(step(LOGIN, ("c", QUOTE))), moved)[0].claims[1].status == "unverified"


def test_a_claim_about_a_library_without_a_quote_stays_unverified(index):
    steps = validate_path(path(step(VERIFY), step(BCRYPT, ("bcrypt checks the hash.", ""))), index)
    assert [c.status for c in steps[1].claims] == ["verified", "unverified"]


def test_a_quote_on_an_external_step_is_checked_at_the_call_site(index):
    source = index.node_source(index.nodes[VERIFY])
    call_site = next(line.strip() for line in source.splitlines() if "bcrypt.verify" in line)
    steps = validate_path(path(step(VERIFY), step(BCRYPT, ("It calls bcrypt.", call_site))), index)
    assert steps[1].claims[1].status == "verified"


def test_a_quote_cannot_verify_an_external_step_with_no_step_before_it(index):
    only = validate_path(path(step(BCRYPT, ("It hashes.", QUOTE))), index)[0]
    assert only.claims[1].status == "unverified"


def test_the_draft_has_no_status_field():
    assert "status" not in DraftClaim.model_fields
    with pytest.raises(ValueError, match="status"):
        DraftClaim(text="t", quote="q", status="verified")
