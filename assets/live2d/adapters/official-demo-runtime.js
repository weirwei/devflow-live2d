async function readJson(relativePath) {
  let text;
  if (window.desktopAPI?.readTextFile) {
    text = await window.desktopAPI.readTextFile(relativePath);
  } else {
    const response = await fetch(`../${relativePath}`);
    if (!response.ok) {
      throw new Error(`Failed to load ${relativePath}: ${response.status}`);
    }
    text = await response.text();
  }
  return JSON.parse(text);
}

async function fileExists(relativePath) {
  try {
    if (window.desktopAPI?.readTextFile) {
      await window.desktopAPI.readTextFile(relativePath);
    } else {
      const response = await fetch(`../${relativePath}`, { method: "HEAD" });
      if (!response.ok) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function toUiAssetPath(appRelativePath) {
  return `../${appRelativePath}`;
}

function toAppRootUrl() {
  return new URL("../../../", import.meta.url);
}

function toRuntimeModuleUrl(appRelativePath) {
  return new URL(appRelativePath, toAppRootUrl()).href;
}

function ensureScriptLoaded(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-live2d-runtime-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed to load script: ${src}`)), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    if (src.endsWith(".js") && !src.includes("/Core/")) {
      script.type = "module";
    }
    script.dataset.live2dRuntimeSrc = src;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true }
    );
    script.addEventListener(
      "error",
      () => reject(new Error(`Failed to load script: ${src}`)),
      { once: true }
    );
    document.head.appendChild(script);
  });
}

function ensurePreviewNodes(container) {
  let preview = container.querySelector("[data-live2d-preview]");
  if (!preview) {
    preview = document.createElement("img");
    preview.setAttribute("data-live2d-preview", "true");
    preview.className = "avatar-shell__preview";
    preview.alt = "Official Live2D demo preview";
    container.appendChild(preview);
  }
  return preview;
}

function ensureRuntimeRoot(container) {
  let root = container.querySelector("[data-live2d-runtime-root]");
  if (!root) {
    root = document.createElement("div");
    root.setAttribute("data-live2d-runtime-root", "true");
    root.className = "avatar-shell__runtime";
    container.appendChild(root);
  }
  return root;
}

async function createPreviewFallback(container, manifest) {
  const modelDefinition = await readJson(`${manifest.model.basePath}/${manifest.model.modelJson}`);
  const firstTexture = modelDefinition?.FileReferences?.Textures?.[0];

  if (!firstTexture) {
    throw new Error("No texture found in the official demo model.");
  }

  const preview = ensurePreviewNodes(container);
  preview.src = toUiAssetPath(`${manifest.model.basePath}/${firstTexture}`);

  return {
    async setState(state) {
      container.dataset.mood = state.mood;
      container.dataset.motion = state.motion;

      const badge = container.querySelector("[data-avatar-badge]");
      const eyes = container.querySelector("[data-avatar-eyes]");
      const mouth = container.querySelector("[data-avatar-mouth]");

      if (badge) {
        badge.textContent = `${manifest.model.name}: ${state.motion}`;
      }

      if (eyes) eyes.textContent = "";
      if (mouth) mouth.textContent = "";
    },
    destroy() {
      preview.removeAttribute("src");
      preview.remove();
    },
  };
}

async function createOfficialAdapter({ container, manifest }) {
  const runtimeModulePath = "official-demo-runtime/dist/main.js";
  const runtimeBuilt = await fileExists(runtimeModulePath);

  if (!runtimeBuilt) {
    return createPreviewFallback(container, manifest);
  }

  const root = ensureRuntimeRoot(container);
  root.replaceChildren();
  const baseUrl = toRuntimeModuleUrl("official-demo-runtime/dist/");
  const modelLayout = {
    runtimeWidth: manifest.model?.runtimeWidth,
    centerX: manifest.model?.centerX,
    centerY: manifest.model?.centerY,
  };
  const modelConfig = {
    resourcesRoot: manifest.model?.runtimeResourcesRoot,
    modelJson: manifest.model?.runtimeModelJson || manifest.model?.modelJson,
  };
  window.DevflowLive2DBaseUrl = baseUrl;
  window.BackstageLive2DBaseUrl = baseUrl;
  window.DevflowLive2DModelLayout = modelLayout;
  window.BackstageLive2DModelLayout = modelLayout;
  window.DevflowLive2DModelConfig = modelConfig;
  window.BackstageLive2DModelConfig = modelConfig;
  await ensureScriptLoaded(toRuntimeModuleUrl("official-demo-runtime/dist/Core/live2dcubismcore.js"));
  await ensureScriptLoaded(toRuntimeModuleUrl(runtimeModulePath));

  const runtimeApi = window.DevflowEmbeddedLive2D || window.BackstageEmbeddedLive2D;
  if (!runtimeApi || typeof runtimeApi.initialize !== "function") {
    throw new Error("Official runtime did not expose an embedded Live2D initialize() API.");
  }

  if (typeof runtimeApi.dispose === "function") {
    runtimeApi.dispose();
  }

  if (
    typeof runtimeApi.playMotion !== "function" &&
    window.Live2DOverlayBridge &&
    typeof window.Live2DOverlayBridge.playMotion === "function"
  ) {
    runtimeApi.playMotion = window.Live2DOverlayBridge.playMotion.bind(window.Live2DOverlayBridge);
  }

  if (typeof runtimeApi.playMotion !== "function") {
    runtimeApi.playMotion = (groupName, _index = 0) => {
      if (typeof runtimeApi.setState === "function") {
        runtimeApi.setState({
          mood: container.dataset.mood || "calm",
          expression: container.dataset.mood || "calm",
          motion: groupName,
        });
      }
    };
  }

  runtimeApi.initialize({ mountElement: root });

  return {
    async setState(state) {
      container.dataset.mood = state.mood;
      container.dataset.motion = state.motion;

      const badge = container.querySelector("[data-avatar-badge]");
      if (badge) {
        badge.textContent = `${manifest.model.name}: ${state.motion}`;
      }

      if (typeof runtimeApi.setState === "function") {
        runtimeApi.setState(state);
      }
    },
    destroy() {
      if (typeof runtimeApi.dispose === "function") {
        runtimeApi.dispose();
      }
      root.replaceChildren();
      root.remove();
    },
  };
}

window.DevflowLive2DOfficialAdapter = createOfficialAdapter;
window.BackstageLive2DOfficialAdapter = createOfficialAdapter;
