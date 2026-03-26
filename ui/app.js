import {
  createInitialAvatarState,
  reduceNormalizedEvent,
} from "../src/avatar/avatarState.js";
import { splitAssistantMessage } from "../src/bubble-text.js";
import { normalizeProtocolEvent } from "../src/event-mapping/normalizeEvent.js";
import { Live2DAdapter } from "../src/live2d-adapter.js";
import { resolveRuntimeConfig } from "../src/live2d-config.js";
import { InteractionController } from "../src/interaction-controller.js";
import { DialogueQueue } from "../src/dialogue-queue.js";
import { deriveStatusBubble } from "../src/status-bubble.js";
import { getLive2DModelById } from "../src/live2d-model-catalog.js";
import {
  resolveAvatarInterrupt,
  shouldHoldAvatarState,
} from "../src/avatar/interruptPolicy.js";

const DEFAULT_PROTOCOL_BASE_URL = "http://127.0.0.1:4317";

const appState = {
  protocolBaseUrl: DEFAULT_PROTOCOL_BASE_URL,
  connected: false,
  hasEverConnected: false,
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
    status: "等待连接",
    project: "",
    text: "",
    tone: "neutral",
    channel: "system",
  },
  avatarInterruptGuard: null,
  avatarInterruptTimer: null,
};

let runtimeSwitching = false;
const dialogueQueue = new DialogueQueue({
  maxSize: 40,
  defaultDurationMs: 3800,
});
const assistantQueue = new DialogueQueue({
  maxSize: 80,
  defaultDurationMs: 5200,
});

const elements = {
  shell: document.querySelector("#shell"),
  bubble: document.querySelector("#bubble"),
  bubbleStatus: document.querySelector("#bubbleStatus"),
  bubbleProject: document.querySelector("#bubbleProject"),
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
  const hasStatus = Boolean(appState.bubble.status && appState.bubble.status.trim());
  const hasProject = Boolean(appState.bubble.project && appState.bubble.project.trim());
  const hasText = Boolean(appState.bubble.text && appState.bubble.text.trim());
  const isVisible = hasStatus || hasText;

  elements.bubble.dataset.tone = appState.bubble.tone || "neutral";
  elements.bubble.dataset.channel = appState.bubble.channel || "system";
  elements.bubbleStatus.textContent = hasStatus ? appState.bubble.status : "";
  elements.bubbleProject.textContent = hasProject ? appState.bubble.project : "";
  elements.bubbleText.textContent = hasText ? appState.bubble.text : "";
  elements.bubble.classList.toggle("bubble--disconnected", !appState.connected);
  elements.bubble.classList.toggle("bubble--with-status-text", hasStatus);
  elements.bubble.classList.toggle("bubble--with-project", hasProject);
  elements.bubble.classList.toggle("bubble--with-text", hasText);
  elements.bubble.classList.toggle("bubble--visible", isVisible);
  elements.bubble.classList.toggle("bubble--hidden", !isVisible);
}

function renderAll() {
  elements.shell.classList.add("shell--panel-hidden");
  applyAvatarTransformVariables();
  renderRuntimeMode();
  renderBubble();
  void renderAvatarFrame();
}

function clearAvatarInterruptTimer() {
  if (!appState.avatarInterruptTimer) return;
  clearTimeout(appState.avatarInterruptTimer);
  appState.avatarInterruptTimer = null;
}

function scheduleAvatarInterruptRelease(guard) {
  clearAvatarInterruptTimer();
  if (!guard || !Number.isFinite(guard.until)) return;

  const delay = Math.max(0, guard.until - Date.now());
  appState.avatarInterruptTimer = setTimeout(() => {
    appState.avatarInterruptTimer = null;
    const activeGuard = appState.avatarInterruptGuard;
    if (!activeGuard || activeGuard.until !== guard.until) return;
    appState.avatarInterruptGuard = null;
  }, delay);
}

function applyNormalizedEventToAvatar(normalized) {
  const now = normalized.timestamp || Date.now();
  const nextAvatarState = reduceNormalizedEvent(appState.avatarState, normalized);
  const decision = resolveAvatarInterrupt(appState.avatarInterruptGuard, normalized, now);

  if (decision.guard) {
    appState.avatarInterruptGuard = decision.guard;
    scheduleAvatarInterruptRelease(decision.guard);
  } else {
    appState.avatarInterruptGuard = null;
    clearAvatarInterruptTimer();
  }

  if (!decision.apply) {
    return false;
  }

  appState.avatarState = nextAvatarState;
  return true;
}

function pushBubble(normalized) {
  const statusItem = deriveStatusBubble(normalized);
  if (statusItem) {
    dialogueQueue.enqueue(statusItem);
  }

  if (normalized.project) {
    appState.bubble = {
      ...appState.bubble,
      project: normalized.project,
    };
  }

  if (normalized.rawType === "assistant.message" && normalized.message) {
    const pages = splitAssistantMessage(normalized.message);
    for (const page of pages) {
      assistantQueue.enqueue({
        text: page,
        tone: "neutral",
        channel: "dialogue",
      });
    }
  }
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
    appState.hasEverConnected = true;
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
      const applied = applyNormalizedEventToAvatar(normalized);
      pushBubble(normalized);
      if (applied || shouldHoldAvatarState(normalized)) {
        void renderAvatarFrame();
      }
    } catch (error) {
      console.error("Failed to parse protocol event payload.", error);
    }
  });

  source.onerror = () => {
    const wasConnected = appState.connected;
    appState.connected = false;

    if (wasConnected) {
      pushBubble(
        normalizeProtocolEvent({
          eventType: "disconnect",
          source: "system",
          payload: { summary: "Lost protocol connection. Retrying..." },
        }),
      );
    }

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
        status: appState.connected ? "" : appState.hasEverConnected ? "" : "等待连接",
        project: appState.bubble.project,
        text: appState.bubble.text,
        tone: "neutral",
        channel: "system",
      };
      renderBubble();
      return;
    }

    appState.bubble = {
      status: item.text,
      project: appState.bubble.project,
      text: appState.bubble.text,
      tone: item.tone,
      channel: item.channel,
    };
    renderBubble();
  });
}

function bindAssistantQueue() {
  assistantQueue.subscribe((item) => {
    appState.bubble = {
      ...appState.bubble,
      text: item?.text || "",
      tone: item?.tone || appState.bubble.tone,
      channel: item?.channel || appState.bubble.channel,
    };
    renderBubble();
  });
}

function bindAvatarBehaviorPreview() {
  window.desktopAPI?.onPreviewAvatarState?.((payload = {}) => {
    appState.avatarInterruptGuard = null;
    clearAvatarInterruptTimer();
    const nextMood = payload.mood || "calm";
    const nextMotion = payload.motion || "idleWave";
    const nextExpression = payload.expression || nextMood;
    const model = getLive2DModelById(appState.runtime.selectedModelId);
    const mappedMotion = model?.motions?.[nextMotion] || nextMotion;
    const mappedExpression = model?.expressions?.[nextMood] || nextExpression;

    appState.avatarState = {
      ...appState.avatarState,
      mood: nextMood,
      motion: nextMotion,
      expression: nextExpression,
      lastEventType: "tray.preview",
      source: payload.source || "tray-preview",
      updatedAt: Date.now(),
    };

    appState.bubble = {
      ...appState.bubble,
      status: `${model.name} 行为预览`,
      text: `${payload.label || nextMotion} · motion ${nextMotion} -> ${mappedMotion} · expression ${nextMood} -> ${mappedExpression}`,
      tone: "neutral",
      channel: "system",
    };

    renderAll();
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
  bindAssistantQueue();
  await initializeDesktopState();
  await initializeRuntime();
  bindInteractions();
  bindAvatarBehaviorPreview();
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
    status: "初始化失败",
    project: appState.bubble.project,
    text: "Failed to initialize the desktop overlay.",
    tone: "warning",
    channel: "error",
  };
  renderAll();
});
