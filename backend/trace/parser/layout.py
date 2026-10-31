"""Baked layout: where every node sits on the map, computed once so it looks identical on every run.

Each module becomes a plate. Plates flow down columns in call order, so an answer reads from the routes on the left
towards the libraries on the right. The UI draws plates around their members, so a module's members must stay together
and plates must not overlap. The whole map has to fit a wide frame: past a certain size the camera's minimum zoom clips
it, and well before that the plate names and labels drop out.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass

import networkx as nx

# These mirror PAD and TAB in web/src/lib/scene.ts, which draws the plates from the positions baked here.
PAD_X, PAD_TOP, PAD_BOTTOM = 110, 92, 70
TAB_LEFT, TAB_BASE, TAB_PER_CHAR = 22, 44, 9.2

COLUMN, ROW = 260, 100  # room for a route's label card under its node, and for the belts between rows
EXTERNAL_COLUMN, EXTERNAL_ROW = 170, 62
PLATE_GAP = 70
ASPECT = 2.0  # the space the map gets between the top bar and the ask bar
PLATE_SHAPE = 0.7  # below 1 a module packs taller than wide, which leaves more of the width for call order
METHOD_ROWS = 6  # a class's methods hang under it, wrapping after this many rows
FLOW_EDGES = {"calls", "routes_to", "injects"}


@dataclass
class Block:
    """A group of nodes that read together: a route beside its handler, or a class above its methods."""

    cells: dict[str, tuple[int, int]]  # node id -> (column, row)

    @property
    def cols(self) -> int:
        return max(c for c, _ in self.cells.values()) + 1

    @property
    def rows(self) -> int:
        return max(r for _, r in self.cells.values()) + 1


@dataclass
class Plate:
    module: str
    name: str
    cells: dict[str, tuple[int, int]]
    cols: int
    rows: int
    column: float
    row: float
    x: float = 0
    y: float = 0

    @property
    def width(self) -> float:
        tab = TAB_BASE + TAB_PER_CHAR * len(self.name) + TAB_LEFT * 2
        return max((self.cols - 1) * self.column + 2 * PAD_X, tab)

    @property
    def height(self) -> float:
        return (self.rows - 1) * self.row + PAD_TOP + PAD_BOTTOM


def _blocks(members: list[dict], edges: list[dict]) -> list[Block]:
    ids = {n["id"] for n in members}
    routes_of: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        if e["type"] == "routes_to" and e["source"] in ids and e["target"] in ids:
            routes_of[e["target"]].append(e["source"])

    placed: set[str] = set()
    blocks: list[tuple[tuple, Block]] = []
    by_line = sorted(members, key=lambda n: (n["line_start"], n["id"]))

    for node in by_line:  # a class first, so the methods of a class don't go on to form blocks of their own
        if node["type"] != "class" or node["id"] in placed:
            continue
        inside = [n for n in by_line if n["id"].startswith(node["id"] + ".") and n["id"] not in placed]
        cells = {node["id"]: (0, 0)}
        for index, member in enumerate(inside):
            cells[member["id"]] = (index // METHOD_ROWS, 1 + index % METHOD_ROWS)
        placed.update(cells)
        blocks.append(((node["line_start"], node["id"]), Block(cells)))

    for node in by_line:
        if node["id"] in placed or node["id"] not in routes_of:
            continue
        routes = sorted(routes_of[node["id"]])
        cells = {route: (0, row) for row, route in enumerate(routes)}
        cells[node["id"]] = (1, 0)
        placed.update(cells)
        blocks.append(((node["line_start"], node["id"]), Block(cells)))

    for node in by_line:
        if node["id"] not in placed:
            blocks.append(((node["line_start"], node["id"]), Block({node["id"]: (0, 0)})))
    return [block for _, block in sorted(blocks, key=lambda item: item[0])]


def _pack(blocks: list[Block]) -> tuple[dict[str, tuple[int, int]], int, int]:
    """Shelf packing: blocks fill a row left to right, then start the next one below."""
    area = sum(b.cols * b.rows for b in blocks)
    limit = max(max(b.cols for b in blocks), math.ceil(math.sqrt(area * PLATE_SHAPE)))
    cells: dict[str, tuple[int, int]] = {}
    col = top = shelf = width = 0
    for block in blocks:
        if col and col + block.cols > limit:
            top += shelf
            col = shelf = 0
        for nid, (c, r) in block.cells.items():
            cells[nid] = (col + c, top + r)
        col += block.cols
        width = max(width, col)
        shelf = max(shelf, block.rows)
    return cells, width, top + shelf


def _ranks(modules: list[str], edges: list[dict], module_of: dict[str, str]) -> dict[str, int]:
    """A module's column: how many modules deep it is in the call flow. Cycles share a column."""
    flow = nx.DiGraph()
    flow.add_nodes_from(modules)
    for e in edges:
        a, b = module_of.get(e["source"]), module_of.get(e["target"])
        if e["type"] in FLOW_EDGES and a in flow and b in flow and a != b:
            flow.add_edge(a, b)
    dag = nx.condensation(flow)
    depth: dict[int, int] = {}
    for c in nx.lexicographical_topological_sort(dag, key=lambda c: min(dag.nodes[c]["members"])):
        depth[c] = max((depth[p] + 1 for p in dag.predecessors(c)), default=0)
    return {m: depth[c] for c in dag.nodes for m in dag.nodes[c]["members"]}


def _flow(plates: list[Plate], limit: float) -> tuple[float, float]:
    """Fill columns down to `limit`, in order. Returns the overall width and height."""
    x = y = width = height = 0.0
    for plate in plates:
        if y and y + plate.height > limit:
            x += width + PLATE_GAP
            y = width = 0.0
        plate.x, plate.y = x, y
        y += plate.height + PLATE_GAP
        width = max(width, plate.width)
        height = max(height, plate.y + plate.height)
    return x + width, height


def _place(plates: list[Plate], ranks: dict[str, int]) -> None:
    """Keep call order, and try column heights until the map best fills the frame."""
    ordered = sorted(plates, key=lambda p: (ranks[p.module], p.module))
    tallest = max(p.height for p in ordered)
    total = sum(p.height + PLATE_GAP for p in ordered)
    steps = max(1, math.ceil((total - tallest) / 50))

    def scale(limit: float) -> tuple[float, float]:
        width, height = _flow(ordered, limit)
        return max(width / ASPECT, height), limit

    _, best = min(scale(tallest + step * 50) for step in range(steps + 1))
    _flow(ordered, best)


def bake_layout(nodes: list[dict], edges: list[dict]) -> None:
    """Set `x` and `y` on every node, in place. Same input, same output."""
    module_of = {n["id"]: n["module"] for n in nodes}
    modules = sorted(n["id"] for n in nodes if n["type"] == "module")
    names = {n["id"]: n["name"] for n in nodes if n["type"] == "module"}
    members: dict[str, list[dict]] = defaultdict(list)
    externals: list[dict] = []
    for n in nodes:
        if n["type"] == "external":
            externals.append(n)
        elif n["type"] != "module":
            members[n["module"]].append(n)

    plates = []
    for module in modules:
        if members[module]:
            cells, cols, rows = _pack(_blocks(members[module], edges))
            plates.append(Plate(module, names[module], cells, cols, rows, COLUMN, ROW))
    ranks = _ranks(modules, edges, module_of)

    if externals:
        ordered = sorted(externals, key=lambda n: (n["module"], n["name"]))
        cols = max(1, math.ceil(math.sqrt(len(ordered) / 1.4)))
        cells = {n["id"]: (i % cols, i // cols) for i, n in enumerate(ordered)}
        rows = (len(ordered) - 1) // cols + 1
        plates.append(Plate("__external__", "outside", cells, cols, rows, EXTERNAL_COLUMN, EXTERNAL_ROW))
        ranks["__external__"] = max(ranks.values(), default=0) + 1

    if plates:
        _place(plates, ranks)

    by_id = {n["id"]: n for n in nodes}
    for plate in plates:
        for nid, (col, row) in plate.cells.items():
            by_id[nid]["x"] = round(plate.x + PAD_X + col * plate.column, 1)
            by_id[nid]["y"] = round(plate.y + PAD_TOP + row * plate.row, 1)
        if plate.module in by_id:
            by_id[plate.module]["x"] = round(plate.x, 1)
            by_id[plate.module]["y"] = round(plate.y, 1)

    # Modules with no members get no plate and draw nothing. They still need a place of their own for wiring lines.
    bottom = max((p.y + p.height for p in plates), default=0) + PLATE_GAP
    empty = [m for m in modules if not members[m]]
    for index, module in enumerate(empty):
        by_id[module]["x"] = float(index * COLUMN)
        by_id[module]["y"] = float(bottom)
