# Task Plan: Bundle Live2D Desktop As A macOS App

## Goal
Package `devflow-live2d` as a macOS app that bundles `devflow-protocol`, starts it automatically, and exposes menu controls for Codex bridge plus Claude global plugin install/uninstall.

## Phases
- [x] Phase 1: Inspect current desktop app, sibling projects, and existing install scripts
- [x] Phase 2: Design bundled runtime layout and process lifecycle
- [x] Phase 3: Implement main-process service manager and tray menu actions
- [x] Phase 4: Add packaging scripts/config to include protocol and plugin resources
- [ ] Phase 5: Verify startup flow, syntax, and packaging assumptions

## Key Questions
1. How should the packaged app locate bundled `devflow-protocol`, bridge scripts, and installer assets in dev vs packaged mode?
2. Which dependencies can be assumed on the host machine for the first version: `bun`, `python3`, `jq`, and Claude CLI/plugin directories?
3. How should menu state reflect running/stopped child processes and install status without adding a heavy UI?

## Decisions Made
- Reuse sibling repositories and existing install/uninstall scripts instead of inventing a second plugin installer.
- Start `devflow-protocol` automatically with the desktop app; make Codex bridge explicitly toggleable from the tray menu.
- Avoid calling the packaged `devflow-protocol/install.sh` directly because it writes state into its own script directory; instead the desktop app now performs plugin deployment and settings mutation itself.
- Replace the Python Codex bridge runtime with a Bun-based local bridge so the packaged app only needs bundled `bun` and `jq`.

## Errors Encountered

## Status
**Phase 5** - Running validation for syntax, resource bundling, and packaging assumptions.
