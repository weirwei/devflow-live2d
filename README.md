# devflow-live2d

**Languages:** English | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

![Devflow Live2D desktop overlay demo](docs/demo.png)

`devflow-live2d` is the macOS Live2D desktop overlay client for Devflow. It runs on Electron and maps `devflow-protocol` runtime events into avatar state, motions, expressions, and speech bubbles.

## Features

- macOS desktop overlay and tray menu
- Live2D official runtime adapter and fallback renderer path
- Multi-model catalog, currently bundled with the `nito-runtime` model set
- Protocol event mapping for avatar motions, expressions, moods, and bubble styles
- Codex bridge: reads `~/.codex/sessions/**/rollout-*.jsonl` and forwards events to the local protocol service
- Install and uninstall entry points for the Claude global `devflow-protocol` plugin
- Optional AI persona dialogue generation, with the API key kept in the main process

## Scope

This repository is responsible for the desktop client and Live2D presentation layer. It does not own:

- raw Claude/Codex event parsing
- shared protocol storage, ingestion, or service implementation
- pixel-office character and world logic

## Requirements

- macOS
- Node.js and npm
- `python3`, used by the Codex bridge
- For packaging, the sibling directory `../devflow-protocol-go` must exist and contain `bin/devflow-protocol` and `claude-plugin/`

## Install and Develop

```bash
npm install
npm run dev
```

Common scripts:

```bash
npm run doctor
npm test
npm run dist:mac
```

- `npm run doctor` checks the Live2D manifest, adapter, default model JSON, and official runtime resources.
- `npm test` checks the main JavaScript files for syntax errors and runs the Bun tests.
- `npm run dist:mac` prepares bundled protocol resources and then uses `electron-builder` to output macOS `dmg` and `zip` artifacts.

## Local Protocol Service

Protocol service repository: [weirwei/devflow-protocol-go](https://github.com/weirwei/devflow-protocol-go)

The default protocol URL is:

```text
http://127.0.0.1:4317
```

Override it with an environment variable:

```bash
DEVFLOW_PROTOCOL_URL=http://127.0.0.1:4317 npm run dev
```

The packaged app starts the bundled `devflow-protocol-go` from app resources. The tray menu can start or stop the Codex bridge. The bridge starts with `--backfill-recent-minutes 20`, so recent Codex activity is replayed into the avatar shortly after startup.

## Packaging

```bash
npm install
npm run dist:mac
```

Before packaging, `scripts/prepare-bundle-resources.mjs` copies the protocol binary and `claude-plugin` from the sibling `../devflow-protocol-go` repository into:

```text
build-resources/bundle/devflow-protocol-go
```

Packaging fails if the protocol repository or build artifacts are missing. Build `bin/devflow-protocol` in the `devflow-protocol-go` repository first.

## AI Persona Dialogue Config

AI persona dialogue is configured at:

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

You can also provide defaults through environment variables:

```bash
DEVFLOW_DIALOGUE_API_KEY=YOUR_API_KEY \
DEVFLOW_DIALOGUE_MODEL=gpt-5-mini \
npm run dev
```

Related environment variables:

- `DEVFLOW_DIALOGUE_API_KEY`
- `DEVFLOW_DIALOGUE_API_URL`
- `DEVFLOW_DIALOGUE_MODEL`
- `DEVFLOW_DIALOGUE_TIMEOUT_MS`

The tray menu item `AI 闲聊` reads and updates the same config file. The API key is not exposed to the renderer.

## Live2D Models

The model configuration entry point is `LIVE2D_MODEL_CONFIG_PATHS` in `src/live2d-model-catalog.js`. Bundled model files live in:

```text
assets/live2d/models/nito-runtime/
```

The bundled `nito-runtime` model set is based on the official Nito sample model from Live2D Creative Studio:

- Source: [にと | WORKS | Live2D Creative Studio](https://www.live2dcs.jp/works/nito/)
- Creator: Live2D inc.

Each `*.live2d.json` can configure:

- default motion, expression, mood, and hold timing
- protocol event behavior, such as `request.created`, `assistant.message`, and `tool.started`
- local runtime state behavior, such as `connected`, `disconnect`, and `error`
- model layout, runtime resource paths, and interaction metadata

After changing models or motion groups, run:

```bash
npm run doctor
npm test
```

## Directory Structure

```text
.
  main.js                         Electron main process, tray menu, and service orchestration
  preload.js                      Safe bridge for the renderer
  ui/                             Desktop overlay page
  src/app/                        App state and local service runtime
  src/dialogue/                   Avatar bubbles and AI persona dialogue logic
  src/avatar/                     Avatar state and interrupt policy
  src/event-mapping/              Protocol event normalization
  assets/live2d/                  Live2D manifest, adapter, and model resources
  scripts/                        Packaging prep, resource checks, and SDK import scripts
  tests/                          Behavior mapping and dialogue logic tests
```
