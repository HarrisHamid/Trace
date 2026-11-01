# Graphify

> Status: built, 2026-11-01. It replaces learning mode for this submission and is in the demo video. The first version drew a file as
> dots with caller and callee lanes. The author rejected it, because the point is to see the file's own code taken apart. This spec
> describes the rebuild. Results are at the end.

## Goal

From the Code panel, one button takes a file apart. The plain file appears, boxes and titles land on each function, the blocks move
out into a graph, and arrows draw in, each leaving from the line that makes the call.

## Decisions

- **Frontend only.** No parser, contract, API or model change, and no new dependency. Shiki and Framer Motion were already there.
- **Everything comes from the parser and the file.** Blocks are real line ranges, arrows are real edges, and `Edge.line` is the start of each arrow. No model is involved, and the word "verified" appears nowhere.
- **Every line that isn't blank lands in exactly one block.** Lines outside any node become blocks of module code, titled `imports`, by the constants they assign, `file docstring` or `module code`.
- **A route is shown on its handler,** as the block's subtitle, because the two share lines.
- **A class with methods** is cut into its own lines plus one block per method, inside a dashed frame.
- **DOM, not Cytoscape.** Code has to be real text. Sizes are fixed in model units, so a line's position is worked out in `web/src/lib/fileblocks.ts` without measuring the page.
- **Route:** `#/app/file/<path>`, each segment encoded. The hash is the single source of truth, so links, refresh and browser Back work.

## Other files

Only 13 of 59 resolved call sites stay inside one file, and `crud.py` has one. So the page also shows the boundary, as code where it can:

- **Callees in other files:** real code blocks on the right, cut to 12 lines, with their own Graphify button.
- **Callers:** one card per file on the left, listing the functions. Clicking one opens that file with the function lit.
- **Calls outside the repo:** listed in the block's header (`uses session.add, session.commit +1`), not drawn.
- **A target the parser could not prove:** a dashed card, with a dashed blue arrow.

## Layout

Depth is the longest path from a block nothing in the file calls. Columns run left to right by depth, with callers before them and
other files after. Tall columns wrap, and the page tries a range of column heights and keeps the one that draws largest.

## Interaction

| Action | Result |
|---|---|
| Hover a block | Its arrows brighten and its calling lines are marked |
| Click a block | Unrelated blocks dim, and the camera frames it and everything it touches |
| Click empty space, or the block again | Clears it, and the camera returns to the whole page |
| Wheel, drag | Zoom and pan |
| Replay | Runs the take-apart again |
| Escape, `back to map`, browser Back | Returns to the map in module focus |

## Animation

From the map: 650ms fly to the plate (skipped if already there), 320ms plunge, 200ms fade into the file. Then: 450ms hold on the plain
file, boxes and titles staggered at 45ms a block (0.5s to 1.1s), a spring out to the graph with the camera following, and arrows
drawing in. A link or a refresh shows the finished page at once, and so does reduced motion.

## Limits

This shows structure, not execution. `Edge.line` is source order and must never be presented as runtime order. Constants and values passed as arguments have no arrows.

## Merge gate results (2026-11-01)

| Check | Result |
|---|---|
| `make test`, `make test-web`, ruff, `tsc`, `npm run build` | Pass |
| `npm run lint` | One warning, already there before this work (`button.tsx`) |
| Graphify button from the map on `authenticate` | Plays through, lands with `authenticate` lit and its calling lines marked |
| `crud`, `utils`, `deps`, `models`, `core/config`, `routes/users` | Viewed on the real graph |
| `api/main.py`, an empty `__init__.py`, an unknown path | Blocks for the first, a message and link back for the others |
| Graphify on a block from another file | Opens that file |
| Mock `services/users.py` | Class frames show, and the unproven `self.rehash` is dashed |
| Cached `how-does-login-work` after a round trip | Same result: 12 verified, 4 unverified, 1 gap |

**Not checked:** this rebuild at 1280px, real reduced motion, and the animation at full speed by eye. `routes/users` and `models` are readable only after zooming in, and `core/config` is one tall column.
