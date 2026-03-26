import { getLive2DModelById } from "./live2d-model-catalog.js";
import { DEFAULT_LIVE2D_MODEL_ID } from "./live2d-model-catalog.js";

const DEFAULT_MANIFEST_PATH = "assets/live2d/manifest.json";

async function readText(path) {
  if (window.desktopAPI?.readTextFile) {
    return window.desktopAPI.readTextFile(path);
  }
  const response = await fetch(`../${path}`);
  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`);
  }
  return response.text();
}

export async function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  try {
    const text = await readText(manifestPath);
    const manifest = JSON.parse(text);
    return { ok: true, error: "", manifest, path: manifestPath };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      manifest: null,
      path: manifestPath,
    };
  }
}

export async function resolveRuntimeConfig() {
  const manifestResult = await loadManifest();
  const overlayState = window.desktopAPI?.getOverlayState
    ? await window.desktopAPI.getOverlayState()
    : { selectedModelId: DEFAULT_LIVE2D_MODEL_ID };
  const selectedModel = getLive2DModelById(overlayState?.selectedModelId);

  if (!manifestResult.ok || !manifestResult.manifest) {
    return {
      ok: false,
      error: manifestResult.error || "No manifest found.",
      runtimeId: "mock",
      adapterScript: "",
      manifest: null,
      selectedModel,
    };
  }

  const manifest = manifestResult.manifest;
  const merged = {
    ...manifest,
    model: {
      ...(manifest.model || {}),
      ...(selectedModel.manifestModel || {}),
    },
    motions: {
      ...(manifest.motions || {}),
      ...(selectedModel.motions || {}),
    },
    expressions: {
      ...(manifest.expressions || {}),
      ...(selectedModel.expressions || {}),
    },
    selectedModelId: selectedModel.id,
    selectedModelName: selectedModel.name,
  };

  return {
    ok: true,
    error: "",
    runtimeId: merged.sdk?.engine || "external-official",
    adapterScript: merged.sdk?.adapterScript || "",
    manifest: merged,
    selectedModel,
  };
}
