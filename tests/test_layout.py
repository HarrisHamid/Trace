import os

import pytest

from backend.trace.parser import GraphBuilder
from backend.trace.parser.layout import PAD_BOTTOM, PAD_TOP, PAD_X, TAB_BASE, TAB_LEFT, TAB_PER_CHAR

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(ROOT, "tests", "fixtures")
TARGET = os.path.join(ROOT, "third_party", "fastapi-template")


@pytest.fixture(scope="module", params=["fixtures", "target"])
def graph(request):
    if request.param == "fixtures":
        return GraphBuilder(FIXTURES, ".").build()[0]
    if not os.path.isdir(TARGET):
        pytest.skip("target repo not cloned")
    return GraphBuilder(TARGET, "backend").build()[0]


def plates(graph):
    """The same boxes web/src/lib/scene.ts draws."""
    names = {n["id"]: n["name"] for n in graph["nodes"] if n["type"] == "module"}
    groups: dict[str, list[dict]] = {}
    for n in graph["nodes"]:
        if n["type"] == "external":
            groups.setdefault("__external__", []).append(n)
        elif n["type"] != "module":
            groups.setdefault(n["module"], []).append(n)
    names["__external__"] = "outside"
    boxes = {}
    for module, members in groups.items():
        xs, ys = [n["x"] for n in members], [n["y"] for n in members]
        tab = TAB_BASE + TAB_PER_CHAR * len(names[module]) + TAB_LEFT * 2
        x1 = min(xs) - PAD_X
        boxes[module] = (x1, min(ys) - PAD_TOP, max(max(xs) + PAD_X, x1 + tab), max(ys) + PAD_BOTTOM)
    return boxes


def test_every_node_has_its_own_position(graph):
    points = [(n["x"], n["y"]) for n in graph["nodes"]]
    assert None not in {p[0] for p in points} | {p[1] for p in points}
    assert len(set(points)) == len(points)


def test_plates_do_not_overlap(graph):
    boxes = sorted(plates(graph).items())
    for index, (a, box_a) in enumerate(boxes):
        for b, box_b in boxes[index + 1 :]:
            apart = box_a[2] <= box_b[0] or box_b[2] <= box_a[0] or box_a[3] <= box_b[1] or box_b[3] <= box_a[1]
            assert apart, f"{a} overlaps {b}"


def test_no_foreign_node_sits_on_a_plate(graph):
    boxes = plates(graph)
    for n in graph["nodes"]:
        if n["type"] == "module":
            continue
        home = "__external__" if n["type"] == "external" else n["module"]
        for module, (x1, y1, x2, y2) in boxes.items():
            if module != home:
                assert not (x1 <= n["x"] <= x2 and y1 <= n["y"] <= y2), f"{n['id']} is on {module}"


def test_a_route_sits_beside_its_handler(graph):
    nodes = {n["id"]: n for n in graph["nodes"]}
    for e in graph["edges"]:
        if e["type"] == "routes_to":
            route, handler = nodes[e["source"]], nodes[e["target"]]
            if route["module"] == handler["module"]:
                assert handler["x"] > route["x"] and handler["y"] <= route["y"]
