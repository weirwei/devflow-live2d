# Notes: Live2D Persona Chat

## Findings

- `devflow-live2d` already renders factual protocol bubbles and `assistant.message` dialogue, but it did not originate any local banter or persona lines.
- Backstage idle chat and personality lines live in client/product layers, not `devflow-protocol`; the local desktop client is the right place for single-avatar persona chatter.
- The active queue implementation is `src/dialogue-queue.js`; the renderer currently imports that file directly.
- Safe integration path: add a local persona controller, enqueue persona text through `assistantQueue`, and suppress persona output while real assistant dialogue is visible or queued.
- Minimal avatar linkage is enough: persona lines can nudge mood/motion briefly without changing the main event reducer or protocol schema.
