import {
  createInitialAvatarState,
  reduceNormalizedEvent,
  eventToBubble,
} from "../src/avatar-state.js";
import { normalizeProtocolEvent } from "../src/event-mapping/normalizeEvent.js";
import { Live2DAdapter } from "../src/live2d-adapter.js";
import { resolveRuntimeConfig } from "../src/live2d-config.js";
import { InteractionController } from "../src/interaction-controller.js";
import { DialogueQueue } from "../src/dialogue-queue.js";

const DEFAULT_PROTOCOL_BASE_URL = "http://127.0.0.1:4317";

const appState = {
  protocolBaseUrl: DEFAULT_PROTOCOL_BASE_URL,
  connected: false,
  eventSource: null,
  avatarState: createInitialAvatarState(),
  adapter: null,
  runtime: {
    id: "mock",
    selectedModelId: "",
    selectedModelName: "Unknown",
  },
  avatarTuning: {
    scale: 100,
    offsetX: 0,
    offsetY: 0,
  },
  interaction: {
    pointerX: 0,
    pointerY: 0,
    tiltX: 0,
    tiltY: 0,
    hover: false,
  },
  bubble: {
    text: "Waiting for protocol events...",
    tone: "neutral",
    channel: "system",
  },
};

let runtimeSwitching = false;
const dialogueQueue = new DialogueQueue({
  maxSize: 40,
  defaultDurationMs: 3800,
});

const elements = {
  shell: document.querySelector("#shell"),
  bubble: document.querySelector("#bubble"),
  bubbleText: document.querySelector("#bubbleText"),
  avatarStage: document.querySelector("#avatarStage"),
  avatarShell: document.querySelector("#avatarShell"),
};

function applyAvatarTransformVariables() {
  const root = document.documentElement;
  root.style.setProperty("--avatar-scale", String(appState.avatarTuning.scale / 100));
  root.style.setProperty("--avatar-offset-x", `${appState.avatarTuning.offsetX}px`);
  root.style.setProperty("--avatar-offset-y", `${appState.avatarTuning.offsetY}px`);
  root.style.setProperty("--avatar-tilt-x", `${appState.interaction.tiltX}deg`);
  root.style.setProperty("--avatar-tilt-y", `${appState.interaction.tiltY}deg`);
}

async function renderAvatarFrame() {
  if (!appState.adapter) return;
  await appState.adapter.setState({
    avatarState: appState.avatarState,
    interactionState: appState.interaction,
  });
}

function renderRuntimeMode() {
  const usingLive2D = appState.runtime.id !== "mock";
  elements.avatarStage.classList.toggle("avatar-stage--live2d", usingLive2D);
  elements.avatarShell.classList.toggle("avatar-shell--live2d", usingLive2D);
}

function renderBubble() {
  const hasText = Boolean(appState.bubble.text && appState.bubble.text.trim());
  elements.bubble.dataset.tone = appState.bubble.tone || "neutral";
  elements.bubble.dataset.channel = appState.bubble.channel || "system";
  elements.bubbleText.textContent = hasText
    ? appState.bubble.text
    : "Waiting for protocol events...";
  elements.bubble.classList.toggle("bubble--visible", hasText);
  elements.bubble.classList.toggle("bubble--hidden", !hasText);
}

function renderAll() {
  elements.shell.classList.add("shell--panel-hidden");
  applyAvatarTransformVariables();
  renderRuntimeMode();
  renderBubble();
  void renderAvatarFrame();
}

function pushBubble(normalized) {
  dialogueQueue.enqueue(eventToBubble(normalized));
}

function connectEvents() {
  if (appState.eventSource) {
    appState.eventSource.close();
    appState.eventSource = null;
  }

  const source = new EventSource(`${appState.protocolBaseUrl}/events`);
  appState.eventSource = source;

  source.addEventListener("connected", () => {
    appState.connected = true;
    pushBubble(
      normalizeProtocolEvent({
        eventType: "connected",
        source: "system",
        payload: { summary: "Connected to protocol events." },
      }),
    );
    renderAll();
  });

  source.addEventListener("message", (event) => {
    try {
      const parsed = JSON.parse(event.data);
      const normalized = normalizeProtocolEvent(parsed);
      appState.avatarState = reduceNormalizedEvent(appState.avatarState, normalized);
      pushBubble(normalized);
      void renderAvatarFrame();
    } catch (error) {
      console.error("Failed to parse protocol event payload.", error);
    }
  });

  source.onerror = () => {
    appState.connected = false;
    pushBubble(
      normalizeProtocolEvent({
        eventType: "disconnect",
        source: "system",
        payload: { summary: "Lost protocol connection. Retrying..." },
      }),
    );
    renderAll();
  };
}

async function initializeRuntime() {
  const config = await resolveRuntimeConfig();
  appState.runtime = {
    id: config.runtimeId,
    selectedModelId: config.selectedModel.id,
    selectedModelName: config.selectedModel.name,
  };

  if (config.ok && config.adapterScript) {
    await import(`../${config.adapterScript}`);
  }

  appState.adapter = new Live2DAdapter({ container: elements.avatarShell });
  try {
    await appState.adapter.initialize({
      runtimeId: config.runtimeId,
      manifest: config.manifest,
      interactionState: appState.interaction,
    });
  } catch (error) {
    console.warn("Runtime initialization failed, falling back to mock.", error);
    appState.runtime.id = "mock";
    await appState.adapter.initialize({
      runtimeId: "mock",
      manifest: null,
      interactionState: appState.interaction,
    });
  }
}

async function switchRuntimeForSelectedModel() {
  if (runtimeSwitching) return;
  runtimeSwitching = true;
  try {
    appState.adapter?.destroy();
    appState.adapter = null;
    await initializeRuntime();
    renderAll();
  } finally {
    runtimeSwitching = false;
  }
}

function bindInteractions() {
  const controller = new InteractionController({
    target: elements.avatarShell,
    onState: (next) => {
      appState.interaction = { ...appState.interaction, ...next };
      applyAvatarTransformVariables();
      void renderAvatarFrame();
    },
  });
  controller.mount();
}

function bindBubbleQueue() {
  dialogueQueue.subscribe((item) => {
    if (!item) {
      appState.bubble = {
        text: "",
        tone: "neutral",
        channel: "system",
      };
      renderBubble();
      return;
    }

    appState.bubble = {
      text: item.text,
      tone: item.tone,
      channel: item.channel,
    };
    renderBubble();
  });
}

function bindMotionPreview() {
  window.desktopAPI?.onPlayMotion?.(({ groupName, index } = {}) => {
    if (!groupName || !appState.adapter) return;
    void appState.adapter.playMotion(groupName, index);
  });
}

async function initializeDesktopState() {
  if (!window.desktopAPI) return;
  const sharedState = await window.desktopAPI.getOverlayState();
  appState.protocolBaseUrl = sharedState.protocolBaseUrl || appState.protocolBaseUrl;
  appState.avatarTuning = {
    ...appState.avatarTuning,
    ...(sharedState.avatarTuning || {}),
  };

  window.desktopAPI.onOverlayState((nextState) => {
    let shouldReconnect = false;

    if (nextState.protocolBaseUrl && nextState.protocolBaseUrl !== appState.protocolBaseUrl) {
      appState.protocolBaseUrl = nextState.protocolBaseUrl;
      shouldReconnect = true;
    }
    if (nextState.avatarTuning) {
      appState.avatarTuning = { ...appState.avatarTuning, ...nextState.avatarTuning };
    }

    const nextModelId = nextState.selectedModelId;
    const currentModelId = appState.runtime.selectedModelId;
    if (nextModelId && nextModelId !== currentModelId) {
      void switchRuntimeForSelectedModel();
      return;
    }

    if (shouldReconnect) {
      connectEvents();
    }
    renderAll();
  });
}

async function init() {
  bindBubbleQueue();
  await initializeDesktopState();
  await initializeRuntime();
  bindInteractions();
  bindMotionPreview();
  renderAll();
  connectEvents();
}

init().catch((error) => {
  console.error(error);
  appState.avatarState = {
    ...createInitialAvatarState(),
    mood: "alert",
    expression: "alert",
    motion: "shake",
  };
  appState.bubble = {
    text: "Failed to initialize the desktop overlay.",
    tone: "warning",
    channel: "error",
  };
  renderAll();
});
