import {
  DEFAULT_LIVE2D_MODEL_ID,
  LIVE2D_MODEL_CATALOG,
  LIVE2D_MODEL_CONFIG_PATHS,
  createLive2DModelCatalog,
  getLive2DModelById,
} from "./live2d-model-catalog.js";

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

export async function loadModelCatalog(configPaths = LIVE2D_MODEL_CONFIG_PATHS) {
  const configs = [];
  for (const configPath of configPaths) {
    try {
      const text = await readText(configPath);
      configs.push(JSON.parse(text));
    } catch (error) {
      console.warn(`Failed to load Live2D model config ${configPath}.`, error);
    }
  }

  const catalog = createLive2DModelCatalog(configs);
  return catalog.length > 0 ? catalog : LIVE2D_MODEL_CATALOG;
}

export async function resolveRuntimeConfig() {
  const manifestResult = await loadManifest();
  const modelCatalog = await loadModelCatalog();
  const overlayState = window.desktopAPI?.getOverlayState
    ? await window.desktopAPI.getOverlayState()
    : { selectedModelId: DEFAULT_LIVE2D_MODEL_ID };
  const selectedModel = getLive2DModelById(overlayState?.selectedModelId, modelCatalog);

  if (!manifestResult.ok || !manifestResult.manifest) {
    return {
      ok: false,
      error: manifestResult.error || "No manifest found.",
      runtimeId: "mock",
      adapterScript: "",
      manifest: null,
      selectedModel,
      modelCatalog,
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
    defaults: {
      ...(manifest.defaults || {}),
      ...(selectedModel.defaults || {}),
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
    modelCatalog,
  };
}
