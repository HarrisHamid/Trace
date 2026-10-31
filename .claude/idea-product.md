# Trace — Product Spec

> Part of the Trace idea set. See `idea.md` first. **(unverified)** = not confirmed from an official source.
> "Trace" is a placeholder name; keeping it or renaming is an open decision.

## Product summary

A web app (not an extension). FastAPI backend plus a single-page React frontend. No database, no accounts.
Demo repos are **pre-indexed**; loading arbitrary repos is cut.

## Core experiences

### 1. Codebase view (the factory floor in space)
- A map drawn like a factory floor in space. **Each module is a dark plate** with a coloured tab and a one-line caption
  from its docstring. **Each function, class and route is a small labelled card** on its plate. **Calls are belts**
  that the answer's parcel rides along. Colour means module.
- Connections that only describe wiring (imports, injects, inherits, implements) are hidden until asked for.
- Fixed, **pre-baked layout** (x/y stored in graph.json) so it looks identical every run and loads instantly. No live
  layout that can shuffle on camera. Parser v2's layout step must place each module's members together, because plates
  are drawn around them.
- **Uncertain/unresolved edges are dashed.**
- Starfield, slow idle motion and a twinkle behind the chart for atmosphere. Idle motion is off under reduced motion.
- Changed on 2026-10-31 from a constellation with glowing nebulae, after the first version was hard for a non-technical
  viewer to follow. Design is in `docs/prds/03-ui.md`.

### 2. File view
- Functions and classes inside one file. Smooth zoom transition from the codebase view to the file view.
- Node granularity (methods as stars vs inside their class) is **open**.

### 3. Code panel
- Click any node to open the exact file and line in a side panel with syntax highlighting.
- Code appears **only in the side panel**, not inside nodes (proposal, not final).
- Quoted code from agent answers must match the real source (validator enforces this).

### 4. Ask the codebase (the agentic core)
- User types a question ("What happens when a user logs in?").
- The agent **walks the graph step by step** using graph tools; each step is streamed to the browser.
- UI animates the path (about 400ms per step), lights up each node, and shows the agent's explanation next to it.
- The final answer is a **path of nodes**. Each claim is marked `verified`, `unverified`, or `gap`.
  Unverified claims are visibly flagged; gaps (no real edge between consecutive nodes) are shown honestly.
- This is the one genuinely agentic feature. Eligible for the "Best Agentic Use-Case" bonus prize
  (judged on autonomy, effectiveness, practical usefulness).

### 5. Learning mode (single mechanic: fog of war)
- On/off toggle. When on, unexplored nodes go dark.
- Opening a node shows **one easy tap-check** question (multiple choice). Answer it to "light" the node.
  **Skip is allowed.**
- Progress bar shows **% understood**.
- Checks must **never bottleneck normal use**.
- Proposal (open): Skip marks a node "seen" but not "understood".
- Questions are **pre-generated offline** by the model, stored in `checks.json`, so nothing depends on live
  latency. **Decoys come from the graph, not the model**: wrong options are other functions in the same
  module. The model writes only the question wording and a one-line explanation. Code verifies the right
  answer really is a callee and the decoys really aren't. This keeps grading deterministic.
- Progress persists in localStorage.

## UI priorities (in order; cut from the bottom)

1. Question-to-path animation with the agent's explanation beside each node.
2. Smooth zoom transition between codebase view and file view.
3. Command palette (`/` or Cmd+K) to jump to any function (fuzzy search).
4. Hover cards on nodes showing signature and docstring.
5. A small celebration when a module is fully understood.

Visual states are node classes with style transitions: fog, seen, understood, visited-by-agent,
unverified.

## Explicit cuts (do not build)

PR diff mode, other languages, security analysis, voice, SAM 3.1, quests, mastery map, XP/badges, accounts,
loading arbitrary repos, Three.js/WebGL/PixiJS, React Flow, any database, auth, Next.js.

## Positioning lines (use in README, video, X post)

- "Every claim the AI makes is checked against the real call graph."
- "The graph is built by static analysis, not by an LLM. The model only navigates it."
- Avoid: "chat with your codebase", "RAG".

## Open product decisions

- Keep the name Trace?
- Does Skip count as "seen but not understood"? (proposal: yes)
- Code in nodes or side panel only? (proposal: side panel only)
- Node granularity: methods as stars or inside classes?
