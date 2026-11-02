"""Baked layout: where every node sits on the map, computed once so it looks identical on every run.

Each module becomes a plate. Plates flow down columns in call order, so an answer reads from the routes on the left
towards the libraries on the right. The UI draws plates around their members, so a module's members must stay together
and plates must not overlap. The whole map has to fit a wide frame: past a certain size the camera's minimum zoom clips
it, and well before that the plate names and labels drop out.

Columns are as wide as their longest label, so names fit on their plate. Sizes are map units, where 2.5 units are one
screen pixel at the zoom a normal window opens at. The plate of outside libraries is hidden until asked for, so it stands
to the right and takes no part in fitting the frame.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass

import networkx as nx

# These mirror PAD, TAB and LABEL in web/src/lib/scene.ts, which draws the plates from the positions baked here.
PAD_X, PAD_RIGHT, PAD_TOP, PAD_BOTTOM = 52, 35, 100, 80
TAB_LEFT, TAB_BASE, TAB_PER_CHAR = 22, 64, 17
LABEL_BASE, LABEL_PER_CHAR = 105, 14.85

COLUMN_GAP = 35
EMPTY_MODULE_COLUMN = 260
ROW = 75  # a label card hangs under its row's line, clear of the next row
EXTERNAL_ROW = 62
PLATE_GAP = 75
ASPECT = 2.1  # the space the map gets between the top bar and the ask bar
PLATE_SHAPE = 0.5  # below 1 a module packs taller than wide, which leaves more of the width for call order
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


def label_span(name: str) -> float:
    """How much of the map a node's label takes up, counted from the node."""
    return LABEL_BASE + LABEL_PER_CHAR * len(name)


def _column_starts(cells: dict[str, tuple[int, int]], names: dict[str, str]) -> tuple[list[float], float]:
    """Where each column starts, each as wide as its longest label, and where the last one ends."""
    widths: dict[int, float] = defaultdict(float)
    for nid, (col, _) in cells.items():
        widths[col] = max(widths[col], label_span(names[nid]))
    starts: list[float] = []
    end = 0.0
    for col in range(max(widths) + 1):
        starts.append(end + COLUMN_GAP if col else 0.0)
        end = starts[col] + widths[col]
    return starts, end


@dataclass
class Plate:
    module: str
    name: str
    cells: dict[str, tuple[int, int]]
    starts: list[float]
    span: float
    rows: int
    row: float
    x: float = 0
    y: float = 0

    @property
    def width(self) -> float:
        tab = TAB_BASE + TAB_PER_CHAR * len(self.name) + TAB_LEFT * 2
        return max(PAD_X + self.span + PAD_RIGHT, tab)

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


def _spread(plates: list[Plate], height: float) -> None:
    """Share each column's spare height out between its plates, so the map fills the frame."""
    columns: dict[float, list[Plate]] = defaultdict(list)
    for plate in plates:
        columns[plate.x].append(plate)
    for column in columns.values():
        if len(column) > 1:
            spare = height - (column[-1].y + column[-1].height)
            for index, plate in enumerate(column):
                plate.y += index * spare / (len(column) - 1)


def _outside_plate(externals: list[dict], plates: list[Plate]) -> Plate:
    """Outside libraries stand to the right of everything else, no taller than the map."""
    names = {n["id"]: n["name"] for n in externals}
    ordered = sorted(externals, key=lambda n: (n["module"], n["name"]))
    height = max((p.y + p.height for p in plates), default=0)
    fit = int((height - PAD_TOP - PAD_BOTTOM) // EXTERNAL_ROW) + 1
    rows = max(fit, math.ceil(math.sqrt(len(ordered))))
    cells = {n["id"]: (i // rows, i % rows) for i, n in enumerate(ordered)}
    starts, span = _column_starts(cells, names)
    plate = Plate("__external__", "outside", cells, starts, span, min(rows, len(ordered)), EXTERNAL_ROW)
    plate.x = max((p.x + p.width for p in plates), default=-PLATE_GAP) + PLATE_GAP
    return plate


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
    _, height = _flow(ordered, best)
    _spread(ordered, height)


def bake_layout(nodes: list[dict], edges: list[dict]) -> None:
    """Set `x` and `y` on every node, in place. Same input, same output."""
    module_of = {n["id"]: n["module"] for n in nodes}
    modules = sorted(n["id"] for n in nodes if n["type"] == "module")
    names = {n["id"]: n["name"] for n in nodes}
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
            cells, _, rows = _pack(_blocks(members[module], edges))
            starts, span = _column_starts(cells, names)
            plates.append(Plate(module, names[module], cells, starts, span, rows, ROW))

    if plates:
        _place(plates, _ranks(modules, edges, module_of))
    if externals:
        plates.append(_outside_plate(externals, plates))

    by_id = {n["id"]: n for n in nodes}
    for plate in plates:
        for nid, (col, row) in plate.cells.items():
            by_id[nid]["x"] = round(plate.x + PAD_X + plate.starts[col], 1)
            by_id[nid]["y"] = round(plate.y + PAD_TOP + row * plate.row, 1)
        if plate.module in by_id:
            by_id[plate.module]["x"] = round(plate.x, 1)
            by_id[plate.module]["y"] = round(plate.y, 1)

    # Modules with no members get no plate and draw nothing. They still need a place of their own for wiring lines.
    bottom = max((p.y + p.height for p in plates), default=0) + PLATE_GAP
    empty = [m for m in modules if not members[m]]
    for index, module in enumerate(empty):
        by_id[module]["x"] = float(index * EMPTY_MODULE_COLUMN)
        by_id[module]["y"] = float(bottom)
