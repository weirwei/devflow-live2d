# Task Plan: Migrate Live2D Desktop From Backstage

## Goal
Copy the functional surface from `backstage/apps/live2d-desktop` into this project and adapt its data/protocol layer to `devflow-protocol` without compatibility shims.

## Phases
- [x] Phase 1: Plan and setup
- [x] Phase 2: Inspect source app and target protocol integration points
- [x] Phase 3: Migrate code and assets into this repo
- [x] Phase 4: Adapt protocol/event flow to `devflow-protocol`
- [x] Phase 5: Verify with tests and smoke checks
- [x] Phase 6: Review and deliver

## Key Questions
1. Which parts of `apps/live2d-desktop` are pure UI/runtime code that can be copied as-is?
2. Which source modules are coupled to Backstage viewer APIs and need to be rewritten for `devflow-protocol`?
3. Which static assets and scripts are necessary for the migrated app to run here?

## Decisions Made
- Use the parent `apps/live2d-desktop` implementation as the baseline and adapt only the protocol-facing seams.

## Errors Encountered

## Status
**Completed** - The desktop app has been migrated and verified against the current `devflow-protocol` surface.
