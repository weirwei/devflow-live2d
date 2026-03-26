# Live2D assets

This directory is where you place your licensed Cubism Web SDK integration files and model assets.

## Why these files are not committed

Live2D Cubism Core is not published on GitHub and is distributed through the official Cubism SDK for Web package. Model assets also vary by license and ownership. Because of that, this repository only ships the integration seam and a mock avatar fallback.

Official references:

- [Cubism SDK for Web](https://docs.live2d.com/en/cubism-sdk-manual/cubism-sdk-for-web/)
- [About Models (Web)](https://docs.live2d.com/en/cubism-sdk-manual/model-web/)
- [Cubism Web Framework](https://github.com/Live2D/CubismWebFramework)
- [Cubism Web Samples](https://github.com/Live2D/CubismWebSamples)

## Expected layout

```text
assets/live2d/
  manifest.json
  adapters/
    cubism-official-adapter.js
  models/
    your-model/
      your-model.model3.json
      your-model.moc3
      motions/
      expressions/
      textures/
```

## Manifest contract

Copy `manifest.example.json` to `manifest.json` and adjust the paths to match your local SDK adapter and model.

The desktop app reads this file at startup. If it is missing or invalid, the app falls back to the mock avatar.

## Adapter template

You can start from:

- `assets/live2d/adapters/cubism-official-adapter.example.js`

Then copy it to the path used by `sdk.adapterScript` in your manifest and replace the stub logic with your actual Cubism Web SDK integration.

## Official SDK import path

When you download the official Cubism SDK for Web package from Live2D, import it into this app with:

```bash
cd apps/live2d-desktop
npm run import:official-sdk -- /absolute/path/to/CubismSdkForWeb
```

That copies:

- `Core/` -> `vendor/live2d-sdk/Core/`
- `Framework/` -> `vendor/live2d-sdk/Framework/`
