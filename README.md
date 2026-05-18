# devflow-live2d

`devflow-live2d` is the macOS desktop overlay app in the split architecture.

## Responsibility

- provide a macOS desktop overlay shell
- consume shared protocol events
- map events into avatar state, motion, expression, and bubbles
- host the Live2D runtime seam and fallback renderer path

## What does not belong here

- raw Claude/Codex event parsing
- shared protocol storage and ingestion
- pixel-office character and world logic

## Migration sources from the current repo

- `apps/live2d-desktop/`

## Current status

This project now includes:

- the migrated Electron tray app shell
- Live2D model catalog, runtime registry, interaction controller, and renderer UI
- bundled Live2D assets and official demo runtime output from the parent app
- protocol-native event normalization for `devflow-protocol`

This app is explicitly macOS-first.

## Bundled macOS App

The desktop app can now be packaged as a macOS app and includes a bundled copy of the sibling `devflow-protocol` project under the app resources.

### Behavior

- app launch starts `devflow-protocol` automatically
- tray menu can start and stop the Codex bridge
- tray menu can install and uninstall the Claude global `devflow-protocol` plugin

The Codex bridge tails `~/.codex/sessions/**/rollout-*.jsonl` through the
bundled `devflow-protocol-go/claude-plugin/codex/bridge_rollout.py` script and
forwards Codex runtime records into the local protocol service. The tray launch
uses `--backfill-recent-minutes 20`, so recent Codex activity appears
immediately after the bridge starts.

### Packaging

```bash
npm install
npm run dist:mac
```

The build step copies `../devflow-protocol` into `build-resources/bundle/devflow-protocol` before packaging.

### Host Requirements

The packaged app bundles project resources, but the current runtime still expects these tools to exist on the host machine:

- bundled `bun` for `devflow-protocol`, the Codex bridge, and the plugin MCP server
- bundled `jq` for Claude plugin hook scripts
- system `bash` only for invoking hook shell scripts

The build step currently copies `bun` from `/Users/weirwei/.bun/bin/bun` and `jq` from `/usr/bin/jq`. You can override those source paths with `BUN_PATH` and `JQ_PATH` before running `npm run dist:mac`.

## Persona Dialogue Config

AI persona dialogue can be configured in:

```text
~/.devflow/live2d/config.json
```

Example:

```json
{
  "personaDialogue": {
    "enabled": true,
    "apiKey": "YOUR_API_KEY",
    "model": "gpt-5-mini",
    "apiUrl": "https://api.openai.com/v1/chat/completions",
    "timeoutMs": 8000
  }
}
```

The tray menu `AI 闲聊` reads and updates the same config file. The API key stays in the main process and is not exposed to the renderer.
