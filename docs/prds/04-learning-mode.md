# Learning mode

> Status: deferred on 2026-11-01. Graphify (`06-graphify.md`) takes its place in this submission and in the video. Nothing below is built.

The design notes are kept in `.claude/idea-product.md`, section 5: fog of war, one tap-check per node with skip allowed, a progress bar,
pre-generated `checks.json` with decoys taken from the graph, and progress kept in localStorage.

What already exists for it, and is left in place:

- `learningMode`, `nodeStates` and their setters in `web/src/store.ts`
- `GET /api/checks` and the mock `checks.json`
- The `NodeState` names in `docs/prds/03-ui.md`

If it returns, pitch it as onboarding to a codebase, because "AI for education" chatbots are on the hackathon's avoid list.
