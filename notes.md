# Notes: Live2D Migration

## Findings

- Target repo currently contains a small protocol demo overlay, not the full desktop app.
- Parent repo `apps/live2d-desktop` contains the full Electron tray app, settings persistence, avatar model catalog, interaction controller, and richer renderer UI.
- Target repo already points at `DEVFLOW_PROTOCOL_URL` and has protocol-oriented event normalization/tests, which will likely replace the old Backstage viewer event pipeline.
