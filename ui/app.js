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
import {
  PersonaChatController,
  PERSONA_POLL_INTERVAL_MS,
  buildPersonaRequestContext,
  RecentEventTracker,
} from "../src/dialogue/persona-chat.js";
import { deriveStatusBubble } from "../src/status-bubble.js";
import {
  LIVE2D_MODEL_CATALOG,
  getLive2DModelById,
  resolveModelEventBehavior,
} from "../src/live2d-model-catalog.js";
import {
  resolveAvatarInterrupt,
  shouldHoldAvatarState,
} from "../src/avatar/interruptPolicy.js";

const DEFAULT_PROTOCOL_BASE_URL = "http://127.0.0.1:4317";
const MIN_WINDOW_CONTENT_HEIGHT = 360;
const LIVE2D_BASE_AVATAR_HEIGHT = 620;
const LIVE2D_MIN_AVATAR_HEIGHT = 520;
const LIVE2D_MAX_AVATAR_HEIGHT = 760;
const SHELL_VERTICAL_PADDING = 24;
const PERSONA_MOTION_BY_MOOD = {
  calm: "idleWave",
  attentive: "acknowledge",
  alert: "greet",
  thinking: "ponder",
  happy: "celebrate",
};
const PREVIEW_AVATAR_HOLD_MS = 2200;

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
    modelCatalog: LIVE2D_MODEL_CATALOG,
    layoutBase: {
      runtimeWidth: 1.1,
      centerX: 0.45,
      centerY: 0.12,
      scale: 1,
    },
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
let personaTickTimer = null;
let personaGenerationInFlight = false;
let previewReplaySeq = 0;
const dialogueQueue = new DialogueQueue({
  maxSize: 40,
  defaultDurationMs: 3800,
});
const assistantQueue = new DialogueQueue({
  maxSize: 80,
  defaultDurationMs: 5200,
});
const personaController = new PersonaChatController();
const recentEvents = new RecentEventTracker();

const elements = {
  shell: document.querySelector("#shell"),
  bubble: document.querySelector("#bubble"),
  bubbleStatus: document.querySelector("#bubbleStatus"),
  bubbleProject: document.querySelector("#bubbleProject"),
  bubbleText: document.querySelector("#bubbleText"),
  avatarStage: document.querySelector("#avatarStage"),
  avatarShell: document.querySelector("#avatarShell"),
};

let bubbleLayoutFrame = 0;
let windowSizeFrame = 0;
let lastSyncedWindowSize = { width: 0, height: 0 };
let windowDragState = null;
let pendingWindowSizeSyncAfterDrag = false;

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function stopCustomWindowDrag() {
  if (!windowDragState) return;
  const finalPosition = windowDragState.lastPosition;
  if (windowDragState.target?.hasPointerCapture?.(windowDragState.pointerId)) {
    windowDragState.target.releasePointerCapture(windowDragState.pointerId);
  }
  if (windowDragState.frame) cancelAnimationFrame(windowDragState.frame);
  document.removeEventListener("pointermove", handleCustomWindowDragMove);
  document.removeEventListener("pointerup", stopCustomWindowDrag);
  document.removeEventListener("pointercancel", stopCustomWindowDrag);
  windowDragState = null;
  if (finalPosition && typeof window.desktopAPI?.setWindowPosition === "function") {
    void window.desktopAPI
      .setWindowPosition({ ...finalPosition, persist: true })
      .catch((error) => {
        console.warn("Window position persist failed.", error);
      });
  }
  if (pendingWindowSizeSyncAfterDrag) {
    pendingWindowSizeSyncAfterDrag = false;
    scheduleWindowContentSizeSync();
  }
}

function handleCustomWindowDragMove(event) {
  if (
    !windowDragState ||
    !windowDragState.ready ||
    typeof window.desktopAPI?.setWindowPosition !== "function"
  ) {
    return;
  }
  const nextX = windowDragState.windowX + event.screenX - windowDragState.pointerX;
  const nextY = windowDragState.windowY + event.screenY - windowDragState.pointerY;
  windowDragState.lastPosition = { x: nextX, y: nextY };
  if (windowDragState.frame) cancelAnimationFrame(windowDragState.frame);
  windowDragState.frame = requestAnimationFrame(() => {
    if (!windowDragState) return;
    void window.desktopAPI
      .setWindowPosition({ x: nextX, y: nextY, persist: false })
      .catch((error) => {
        console.warn("Window position update failed.", error);
      });
  });
}

async function startCustomWindowDrag(event) {
  if (event.button !== 0 || typeof window.desktopAPI?.getWindowFrame !== "function") return;
  event.preventDefault();
  event.stopPropagation();
  stopCustomWindowDrag();
  event.currentTarget?.setPointerCapture?.(event.pointerId);
  windowDragState = {
    target: event.currentTarget,
    pointerId: event.pointerId,
    pointerX: event.screenX,
    pointerY: event.screenY,
    windowX: 0,
    windowY: 0,
    frame: 0,
    lastPosition: null,
    ready: false,
  };
  document.addEventListener("pointermove", handleCustomWindowDragMove);
  document.addEventListener("pointerup", stopCustomWindowDrag, { once: true });
  document.addEventListener("pointercancel", stopCustomWindowDrag, { once: true });
  const frame = await window.desktopAPI.getWindowFrame();
  if (!windowDragState || windowDragState.pointerId !== event.pointerId) return;
  windowDragState.windowX = Number(frame?.x) || 0;
  windowDragState.windowY = Number(frame?.y) || 0;
  windowDragState.ready = true;
}

function scheduleWindowContentSizeSync() {
  if (windowSizeFrame) cancelAnimationFrame(windowSizeFrame);
  windowSizeFrame = requestAnimationFrame(() => {
    windowSizeFrame = 0;
    if (typeof window.desktopAPI?.syncWindowContentSize !== "function") return;
    if (windowDragState) {
      pendingWindowSizeSyncAfterDrag = true;
      return;
    }

    const bubbleRect = elements.bubble.getBoundingClientRect();
    const bubbleVisible = elements.bubble.classList.contains("bubble--visible");
    const usingLive2D = appState.runtime.id !== "mock";
    const tuningScale = (Number(appState.avatarTuning.scale) || 100) / 100;
    const avatarHeight = usingLive2D
      ? clampNumber(
          LIVE2D_BASE_AVATAR_HEIGHT * tuningScale,
          LIVE2D_MIN_AVATAR_HEIGHT,
          LIVE2D_MAX_AVATAR_HEIGHT,
        )
      : 420;
    const bubbleHeight = bubbleVisible ? bubbleRect.height + 18 : 0;
    const shellHeight = Math.ceil(
      Math.max(MIN_WINDOW_CONTENT_HEIGHT, avatarHeight + bubbleHeight + SHELL_VERTICAL_PADDING),
    );
    document.documentElement.style.setProperty("--avatar-fit-height", `${Math.ceil(avatarHeight)}px`);
    document.documentElement.style.setProperty("--shell-fit-height", `${shellHeight}px`);

    const shellRect = elements.shell.getBoundingClientRect();
    const width = Math.ceil(Math.max(420, shellRect.width + 24));
    const height = Math.ceil(Math.max(MIN_WINDOW_CONTENT_HEIGHT, shellHeight + 24));
    if (
      Math.abs(width - lastSyncedWindowSize.width) < 2 &&
      Math.abs(height - lastSyncedWindowSize.height) < 2
    ) {
      return;
    }
    lastSyncedWindowSize = { width, height };
    void window.desktopAPI.syncWindowContentSize({ width, height }).catch((error) => {
      console.warn("Window size sync failed.", error);
    });
  });
}

function applyAvatarTransformVariables() {
  const root = document.documentElement;
  const usingLive2D = appState.runtime.id !== "mock";
  const visualScale = usingLive2D ? 1 : appState.avatarTuning.scale / 100;

  root.style.setProperty("--avatar-scale", String(visualScale));
  root.style.setProperty("--avatar-offset-x", `${appState.avatarTuning.offsetX}px`);
  root.style.setProperty("--avatar-offset-y", `${appState.avatarTuning.offsetY}px`);
  root.style.setProperty("--avatar-tilt-x", `${appState.interaction.tiltX}deg`);
  root.style.setProperty("--avatar-tilt-y", `${appState.interaction.tiltY}deg`);
}

function applyLive2DLayoutTuning() {
  if (appState.runtime.id === "mock") return;

  const baseLayout = appState.runtime.layoutBase || {};
  const baseRuntimeWidth = Number(baseLayout.runtimeWidth) || 1.1;
  const manifestScale = Number(baseLayout.scale) || 1;
  const tuningScale = (Number(appState.avatarTuning.scale) || 100) / 100;
  const nextLayout = {
    runtimeWidth: baseRuntimeWidth * manifestScale * tuningScale,
    centerX: Number(baseLayout.centerX) || 0.45,
    centerY: Number(baseLayout.centerY) || 0.12,
  };

  window.DevflowLive2DModelLayout = nextLayout;
  window.BackstageLive2DModelLayout = nextLayout;
}

function updateBubbleLayout() {
  const shellRect = elements.shell.getBoundingClientRect();
  const avatarRect = elements.avatarShell.getBoundingClientRect();
  const bubbleRect = elements.bubble.getBoundingClientRect();
  const viewportPadding = 14;
  const bubbleGap = appState.runtime.id === "mock" ? -6 : 10;
  const visualAnchorRatio = appState.runtime.id === "mock" ? 0.2 : 0.55;
  const minTop = viewportPadding;
  const maxTop = Math.max(
    minTop,
    shellRect.height - bubbleRect.height - viewportPadding,
  );
  const visualTop =
    avatarRect.top - shellRect.top + avatarRect.height * visualAnchorRatio;
  const desiredTop = visualTop - bubbleRect.height - bubbleGap;
  const bubbleTop = Math.min(maxTop, Math.max(minTop, desiredTop));

  document.documentElement.style.setProperty("--bubble-top", `${Math.round(bubbleTop)}px`);
}

function scheduleBubbleLayout() {
  if (bubbleLayoutFrame) cancelAnimationFrame(bubbleLayoutFrame);
  bubbleLayoutFrame = requestAnimationFrame(() => {
    bubbleLayoutFrame = 0;
    updateBubbleLayout();
  });
}

function resolveModelAvatarState(avatarState) {
  const model = getLive2DModelById(
    appState.runtime.selectedModelId,
    appState.runtime.modelCatalog,
  );
  return {
    ...avatarState,
    motion:
      avatarState.motion === null
        ? null
        : model?.motions?.[avatarState.motion] ||
          avatarState.motion ||
          model?.defaults?.motion ||
          "Idle",
    expression:
      model?.expressions?.[avatarState.expression] ||
      model?.expressions?.[avatarState.mood] ||
      (typeof avatarState.expression === "string"
        ? avatarState.expression
        : model?.defaults?.expression || avatarState.mood),
  };
}

async function renderAvatarFrame() {
  if (!appState.adapter) return;
  const resolvedAvatarState = resolveModelAvatarState(appState.avatarState);
  await appState.adapter.setState({
    avatarState: resolvedAvatarState,
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
  scheduleBubbleLayout();
  scheduleWindowContentSizeSync();
}

function renderAll() {
  elements.shell.classList.add("shell--panel-hidden");
  applyAvatarTransformVariables();
  applyLive2DLayoutTuning();
  renderRuntimeMode();
  renderBubble();
  scheduleBubbleLayout();
  scheduleWindowContentSizeSync();
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

function isAvatarInterruptBlocked(now = Date.now()) {
  return Boolean(
    appState.avatarInterruptGuard &&
      Number.isFinite(appState.avatarInterruptGuard.until) &&
      appState.avatarInterruptGuard.until > now,
  );
}

function applyPersonaMoodHint(personaItem) {
  if (!personaItem?.mood) return false;
  if (isAvatarInterruptBlocked(personaItem.createdAt || Date.now())) {
    return false;
  }

  const nextMood = personaItem.mood;
  appState.avatarState = {
    ...appState.avatarState,
    mood: nextMood,
    motion: PERSONA_MOTION_BY_MOOD[nextMood] || PERSONA_MOTION_BY_MOOD.calm,
    expression: nextMood,
    lastEventType: `persona.${personaItem.category || "chat"}`,
    source: "persona",
    updatedAt: personaItem.createdAt || Date.now(),
  };
  return true;
}

function modelBehaviorForEvent(normalized) {
  const model = getLive2DModelById(
    appState.runtime.selectedModelId,
    appState.runtime.modelCatalog,
  );
  return resolveModelEventBehavior(model, normalized.rawType);
}

function applyNormalizedEventToAvatar(normalized) {
  const now = normalized.timestamp || Date.now();
  const nextAvatarState = reduceNormalizedEvent(appState.avatarState, normalized);
  const behavior = modelBehaviorForEvent(normalized);
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

  if (Number.isFinite(behavior.holdMs) && behavior.holdMs > 0) {
    const guard = {
      kind: normalized.kind,
      until: now + behavior.holdMs,
    };
    appState.avatarInterruptGuard = guard;
    scheduleAvatarInterruptRelease(guard);
  }

  appState.avatarState = {
    ...nextAvatarState,
    mood: behavior.mood || nextAvatarState.mood,
    motion: behavior.motion === null ? null : behavior.motion || nextAvatarState.motion,
    motionIndex: undefined,
    expression:
      typeof behavior.expression === "string"
        ? behavior.expression
        : nextAvatarState.expression,
  };
  return true;
}

function canPersonaSpeakNow() {
  if (!appState.hasEverConnected) return false;
  if (assistantQueue.hasChannel("dialogue")) return false;
  return true;
}

function enqueuePersonaBubble(personaItem) {
  if (!personaItem?.text || assistantQueue.hasChannel("dialogue")) {
    return false;
  }

  const lines = Array.isArray(personaItem.lines) && personaItem.lines.length > 0
    ? personaItem.lines
    : splitAssistantMessage(personaItem.text);
  const applied = applyPersonaMoodHint(personaItem);

  for (const line of lines) {
    assistantQueue.enqueue(
      { text: line, tone: "neutral", channel: "persona" },
      { durationMs: 3200 },
    );
  }

  if (applied) {
    void renderAvatarFrame();
  }

  return true;
}

async function maybeGeneratePersonaLine(personaItem, normalizedEvent = null) {
  if (!personaItem?.text || personaGenerationInFlight) {
    return personaItem;
  }

  const generator = window.desktopAPI?.generatePersonaDialogue;
  if (typeof generator !== "function") {
    return personaItem;
  }

  personaGenerationInFlight = true;
  try {
    const context = buildPersonaRequestContext(
      personaItem,
      normalizedEvent,
      recentEvents.summarize(),
    );
    const response = await generator(context);
    if (response?.ok) {
      const lines = Array.isArray(response.lines) && response.lines.length > 0
        ? response.lines
        : typeof response.text === "string" && response.text.trim()
          ? [response.text.trim()]
          : null;
      if (lines) {
        return { ...personaItem, text: lines[0], lines };
      }
    }
  } catch (error) {
    console.warn("Persona dialogue generation failed, using fallback line.", error);
  } finally {
    personaGenerationInFlight = false;
  }

  return personaItem;
}

function maybeQueuePersonaFromEvent(normalized) {
  const personaItem = personaController.handleEvent(normalized, {
    isConnected: appState.connected,
    canSpeak: canPersonaSpeakNow(),
  });

  if (personaItem) {
    void maybeGeneratePersonaLine(personaItem, normalized).then((resolvedItem) => {
      enqueuePersonaBubble(resolvedItem);
    });
  }
}

function pushBubble(normalized) {
  recentEvents.push(normalized);
  const behavior = modelBehaviorForEvent(normalized);
  const statusItem = deriveStatusBubble(normalized);
  if (statusItem) {
    dialogueQueue.enqueue({
      ...statusItem,
      tone: behavior.bubbleTone || statusItem.tone,
      channel: behavior.bubbleChannel || statusItem.channel,
    });
    if (shouldHoldAvatarState(normalized)) {
      personaController.noteQueueActivity("strong", normalized.timestamp || Date.now());
    }
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

  maybeQueuePersonaFromEvent(normalized);
}

function stopPersonaTicker() {
  if (!personaTickTimer) return;
  clearInterval(personaTickTimer);
  personaTickTimer = null;
}

function startPersonaTicker() {
  stopPersonaTicker();
  personaTickTimer = setInterval(() => {
    const personaItem = personaController.tick({
      isConnected: appState.connected,
      canSpeak: canPersonaSpeakNow(),
    });
    if (personaItem) {
      void maybeGeneratePersonaLine(personaItem).then((resolvedItem) => {
        enqueuePersonaBubble(resolvedItem);
      });
    }
  }, PERSONA_POLL_INTERVAL_MS);
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
    modelCatalog: config.modelCatalog || LIVE2D_MODEL_CATALOG,
    layoutBase: {
      runtimeWidth: config.manifest?.model?.runtimeWidth ?? 1.1,
      centerX: config.manifest?.model?.centerX ?? 0.45,
      centerY: config.manifest?.model?.centerY ?? 0.12,
      scale: config.manifest?.model?.scale ?? 1,
    },
  };

  if (config.ok && config.adapterScript) {
    await import(/* @vite-ignore */ `../${config.adapterScript}`);
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
      scheduleBubbleLayout();
      void renderAvatarFrame();
    },
  });
  controller.mount();

  elements.avatarShell.addEventListener("pointerdown", (event) => {
    void startCustomWindowDrag(event).catch((error) => {
      console.warn("Window drag start failed.", error);
    });
  });
}

function bindViewportLayout() {
  window.addEventListener("resize", scheduleBubbleLayout);
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
    const previewSeq = ++previewReplaySeq;
    appState.avatarInterruptGuard = null;
    clearAvatarInterruptTimer();
    const nextMood = payload.mood || "calm";
    const nextMotion = payload.motion || "idleWave";
    const nextMotionIndex = Number.isInteger(payload.motionIndex) ? payload.motionIndex : 0;
    const nextExpression = payload.expression || nextMood;
    const model = getLive2DModelById(
      appState.runtime.selectedModelId,
      appState.runtime.modelCatalog,
    );

    const applyPreviewState = (avatarPatch) => {
      appState.avatarState = {
        ...appState.avatarState,
        ...avatarPatch,
        lastEventType: "tray.preview",
        source: payload.source || "tray-preview",
        updatedAt: Date.now(),
      };
      void renderAvatarFrame();
    };

    const resetMotion = model?.defaults?.motion || "Idle";
    const shouldResetBeforePreview = nextMotion !== resetMotion;
    if (shouldResetBeforePreview) {
      applyPreviewState({
        mood: model?.defaults?.mood || "calm",
        motion: resetMotion,
        motionIndex: 0,
        expression: model?.defaults?.expression || "",
      });
    }

    const applyRequestedPreview = () => {
      if (previewSeq !== previewReplaySeq) return;
      applyPreviewState({
        mood: nextMood,
        motion: nextMotion,
        motionIndex: nextMotionIndex,
        expression: nextExpression,
      });
      const guard = {
        kind: "preview",
        until: Date.now() + PREVIEW_AVATAR_HOLD_MS,
      };
      appState.avatarInterruptGuard = guard;
      scheduleAvatarInterruptRelease(guard);
    };

    if (shouldResetBeforePreview) {
      setTimeout(applyRequestedPreview, 80);
    } else {
      applyRequestedPreview();
    }

    appState.bubble = {
      ...appState.bubble,
      status: payload.previewStatus || `${model.name} 行为预览`,
      text: payload.previewText || payload.label || nextMotion,
      tone: "neutral",
      channel: "system",
    };

    renderBubble();
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
  startPersonaTicker();
  bindBubbleQueue();
  bindAssistantQueue();
  await initializeDesktopState();
  await initializeRuntime();
  bindInteractions();
  bindViewportLayout();
  bindAvatarBehaviorPreview();
  renderAll();
  connectEvents();
}

init().catch((error) => {
  stopPersonaTicker();
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
