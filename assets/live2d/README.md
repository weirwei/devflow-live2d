# Live2D assets

**Languages:** [English](../../README.md) | [简体中文](../../README.zh-CN.md) | [日本語](../../README.ja.md)

This directory contains the Live2D integration used by the desktop overlay.
The current app intentionally ships only the `nito-runtime` model set.

## Model source

The bundled `nito-runtime` model set is based on the official Nito sample model from Live2D Creative Studio:

- Source: [にと | WORKS | Live2D Creative Studio](https://www.live2dcs.jp/works/nito/)
- Creator: Live2D inc.

## Current layout

```text
assets/live2d/
  manifest.json
  adapters/
    official-demo-runtime.js
  models/
    nito-runtime/
      nito.live2d.json
      nico.live2d.json
      ni-j.live2d.json
      nipsilon.live2d.json
      nietzsche.live2d.json
      *.model3.json
      motion/
      */*.moc3
      */*.pose3.json
      */*.cdi3.json
```

`manifest.json` still defines the default runtime adapter and default model, but the selectable model catalog is loaded from the editable `*.live2d.json` files in `models/nito-runtime/`.

## Model catalog

The active config list is defined in `src/live2d-model-catalog.js` as `LIVE2D_MODEL_CONFIG_PATHS`. It currently points only to:

- `assets/live2d/models/nito-runtime/nito.live2d.json`
- `assets/live2d/models/nito-runtime/nico.live2d.json`
- `assets/live2d/models/nito-runtime/ni-j.live2d.json`
- `assets/live2d/models/nito-runtime/nipsilon.live2d.json`
- `assets/live2d/models/nito-runtime/nietzsche.live2d.json`

Do not add another model directory unless you also add its config path and commit the model assets it references.

## Per-model behavior config

Each Live2D model variant has its own editable config file. The `events` map is keyed directly by protocol event type, while `runtimeEvents` covers local app connection states.

```json
{
  "defaults": {
    "motion": "Idle",
    "expression": "",
    "mood": "calm",
    "holdMs": 0
  },
  "events": {
    "request.created": {
      "motion": "FlickUp",
      "mood": "alert",
      "holdMs": 1600,
      "bubbleTone": "alert"
    },
    "task.completed": {
      "motion": "Flick3",
      "mood": "happy",
      "holdMs": 1600,
      "bubbleTone": "success"
    },
    "tool.started": {
      "motion": null,
      "mood": "focus"
    }
  },
  "runtimeEvents": {
    "connected": {
      "motion": "Tap",
      "mood": "attentive"
    },
    "error": {
      "motion": "Shake",
      "mood": "alert",
      "holdMs": 1600,
      "bubbleTone": "warning"
    }
  }
}
```

Supported protocol event keys are listed in `PROTOCOL_EVENT_TYPES`; local runtime event keys are listed in `RUNTIME_EVENT_TYPES`.

Set `"motion": null` when an event should update mood, expression, bubble text, and hold timing
without starting or restarting a Live2D motion. This is useful for high-frequency events such as
`tool.started` or `task.updated`, where repeatedly replaying motions can make the model jittery.

## Motion groups and preview

The tray menu `模型行为预览` reads the selected model's own `.model3.json` and displays motion groups with their array members. Clicking a member plays that exact motion index.

For Nico, the motion groups are intentionally reclassified in `nico.model3.json`:

- `Happy`
- `Relaxed`
- `Reject`
- `Sad`
- `Confused`

Nico's default motion is `Relaxed`, so runtime fallback returns to `Relaxed` instead of assuming an `Idle` group.

## Runtime resources

The official demo runtime no longer depends on duplicate files under `official-demo-runtime/dist/Resources`. The adapter points the runtime at `assets/live2d/models/`, and the model config selects the relevant `resourcesRoot`/`modelJson`.

This avoids keeping a second copy of the same model assets in the runtime output directory.

## Validation

Run these after changing model configs or `.model3.json` motion groups:

```bash
npm run doctor
npm test
```

`npm run doctor` checks the manifest, adapter, default model JSON, and bundled official runtime files. `npm test` also validates JavaScript syntax and the Live2D behavior mapping tests.
