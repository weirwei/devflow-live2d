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

function toUiAssetPath(appRelativePath) {
  return `../${appRelativePath}`;
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

async function createOfficialAdapter({ container, manifest }) {
  const basePath = manifest?.model?.basePath;
  const modelJson = manifest?.model?.modelJson;

  if (!basePath || !modelJson) {
    throw new Error("Manifest is missing model.basePath or model.modelJson.");
  }

  const modelDefinition = await readJson(`${basePath}/${modelJson}`);
  const firstTexture = modelDefinition?.FileReferences?.Textures?.[0];

  if (!firstTexture) {
    throw new Error("No texture found in the official demo model.");
  }

  const preview = ensurePreviewNodes(container);
  preview.src = toUiAssetPath(`${basePath}/${firstTexture}`);

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

      if (eyes) {
        eyes.textContent = "";
      }

      if (mouth) {
        mouth.textContent = "";
      }
    },
  };
}

window.DevflowLive2DOfficialAdapter = createOfficialAdapter;
window.BackstageLive2DOfficialAdapter = createOfficialAdapter;
