# Task Plan: Add Persona Small Talk To Live2D Desktop

## Goal
Add a local single-persona small-talk layer to `devflow-live2d` so the desktop avatar can produce backstage-style banter and short reactions without changing `devflow-protocol`.

## Phases
- [x] Phase 1: Plan and setup
- [x] Phase 2: Inspect renderer, queue, and backstage reference dialogue logic
- [x] Phase 3: Implement persona dialogue modules and queue read helpers
- [x] Phase 4: Wire persona dialogue into the renderer event flow
- [x] Phase 5: Verify with tests and syntax checks

## Key Questions
1. How should local persona chat avoid interrupting real assistant dialogue bubbles?
2. Which idle/event triggers belong in the desktop client instead of protocol or pixel-office?
3. How much avatar mood linkage is enough without creating a second state machine?

## Decisions Made
- Keep persona chat fully local to the renderer and do not emit fake protocol events.
- Use a single avatar persona inspired by backstage staff tone instead of multi-employee casting.
- Reuse `assistantQueue` for persona dialogue pages and block persona chatter while real assistant dialogue is active.

## Errors Encountered

## Status
**Completed** - Persona chat is implemented locally in the renderer and verified with passing tests.
