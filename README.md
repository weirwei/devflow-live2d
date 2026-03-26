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
