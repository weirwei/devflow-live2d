import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerMonitor,
  screen,
  shell,
} from "electron";
import fs from "fs";
import { homedir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_LIVE2D_MODEL_ID,
  LIVE2D_MODEL_CATALOG,
  LIVE2D_MODEL_CONFIG_PATHS,
  createLive2DModelCatalog,
  getLive2DModelById,
  resolveModelEventBehavior,
} from "./src/live2d-model-catalog.js";
import { IPC_CHANNELS } from "./src/ipc-channels.js";
import {
  createCenteredWindowBounds,
  isWindowBoundsVisible,
  normalizeWindowBounds,
  resolveWindowBounds,
  sameWindowBounds,
} from "./src/app/window-bounds.js";
import { DesktopServiceRuntime } from "./src/app/service-runtime.js";
import {
  DEFAULT_PERSONA_API_URL,
  DEFAULT_PERSONA_MODEL,
  DEFAULT_PERSONA_TIMEOUT_MS,
  buildPersonaDialoguePrompt,
  createDefaultPersonaDialogueSettings,
  getPersonaDialogueConfig,
  normalizePersonaDialogueSettings,
  resolvePersonaDialogueConfig,
  parsePersonaDialogueLines,
} from "./src/dialogue/persona-ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE_NAME = "devflow-live2d-settings.json";
const DEVFLOW_CONFIG_DIR = path.join(homedir(), ".devflow", "live2d");
const DEVFLOW_CONFIG_FILE = path.join(DEVFLOW_CONFIG_DIR, "config.json");
const AVATAR_LIMIT = 220;
const SCALE_MIN = 50;
const SCALE_MAX = 150;
const DEFAULT_PROTOCOL_BASE_URL =
  process.env.DEVFLOW_PROTOCOL_URL?.trim() || "http://127.0.0.1:4317";
const OVERLAY_WIDTH = 420;
const OVERLAY_HEIGHT = 720;
const PERSONA_DIALOGUE_SYSTEM_PROMPT =
  '你是一个桌面 Live2D 桌宠的台词生成器。只输出纯 JSON，格式: {"lines":["第一句","第二句"]}。不要 markdown、不要解释。';

function loadLive2DModelCatalogFromFiles() {
  const configs = [];
  for (const configPath of LIVE2D_MODEL_CONFIG_PATHS) {
    try {
      const raw = fs.readFileSync(path.resolve(__dirname, configPath), "utf-8");
      configs.push(JSON.parse(raw));
    } catch {}
  }

  const catalog = createLive2DModelCatalog(configs);
  return catalog.length > 0 ? catalog : LIVE2D_MODEL_CATALOG;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function normalizeAvatarTuning(input = {}) {
  return {
    scale: safeNumber(
      input.scale,
      DEFAULT_STATE.avatarTuning.scale,
      SCALE_MIN,
      SCALE_MAX,
    ),
    offsetX: safeNumber(
      input.offsetX,
      DEFAULT_STATE.avatarTuning.offsetX,
      -AVATAR_LIMIT,
      AVATAR_LIMIT,
    ),
    offsetY: safeNumber(
      input.offsetY,
      DEFAULT_STATE.avatarTuning.offsetY,
      -AVATAR_LIMIT,
      AVATAR_LIMIT,
    ),
  };
}

function normalizeProtocolBaseUrl(value, fallback = DEFAULT_PROTOCOL_BASE_URL) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function resolvePersonaApiUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (/\/(chat\/completions|responses)$/.test(trimmed)) return trimmed;
  return `${trimmed.replace(/\/+$/, "")}/v1/chat/completions`;
}

function resolvePersonaDialogueErrorText(response = {}) {
  if (typeof response.error === "string" && response.error.trim()) {
    return response.error.trim();
  }
  if (typeof response.reason === "string" && response.reason.trim()) {
    return response.reason.trim();
  }
  return "AI 暂时不可用";
}

async function generatePersonaDialogueViaApi(input, config) {
  const prompt = buildPersonaDialoguePrompt(input);
  const apiUrl = resolvePersonaApiUrl(config.apiUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: PERSONA_DIALOGUE_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.92,
        max_tokens: 150,
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        text: "",
        reason: `http_${response.status}`,
        error: rawText.slice(0, 240),
      };
    }

    let content = rawText;
    try {
      const json = JSON.parse(rawText);
      const chatOut = json?.choices?.[0]?.message?.content;
      if (typeof chatOut === "string") {
        content = chatOut;
      } else if (Array.isArray(chatOut)) {
        content = chatOut
          .map((part) => (typeof part?.text === "string" ? part.text : ""))
          .join("")
          .trim();
      } else if (typeof json?.output_text === "string" && json.output_text.trim()) {
        content = json.output_text.trim();
      }
    } catch {}

    const lines = parsePersonaDialogueLines(content, input.fallbackText || "");
    if (lines.length === 0) {
      return { ok: false, text: "", lines: [], reason: "empty" };
    }

    return { ok: true, text: lines[0], lines, provider: "openai-compatible", model: config.model };
  } catch (error) {
    return {
      ok: false,
      text: "",
      reason: error?.name === "AbortError" ? "timeout" : "network",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function generatePersonaDialogue(input = {}, settings = {}, env = process.env) {
  const config = resolvePersonaDialogueConfig(settings, env);
  if (!config.enabled) {
    return { ok: false, text: "", reason: "disabled" };
  }

  return generatePersonaDialogueViaApi(input, config);
}

function createDefaultState() {
  return {
    protocolBaseUrl: DEFAULT_PROTOCOL_BASE_URL,
    clickThrough: false,
    alwaysOnTop: true,
    allWorkspaces: true,
    hidden: false,
    panelCollapsed: true,
    codexBridgeEnabled: false,
    selectedModelId: DEFAULT_LIVE2D_MODEL_ID,
    avatarTuning: {
      scale: 100,
      offsetX: 0,
      offsetY: 0,
    },
    personaDialogue: createDefaultPersonaDialogueSettings(),
    windowBounds: {
      x: 0,
      y: 0,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
    },
  };
}

const DEFAULT_STATE = createDefaultState();

function readModel3Json(model) {
  const manifestModel = model?.manifestModel || model?.model || {};
  const basePath = manifestModel.basePath;
  const modelJson = manifestModel.modelJson || manifestModel.runtimeModelJson;
  if (!basePath || !modelJson) return null;

  try {
    const modelJsonPath = path.resolve(__dirname, basePath, modelJson);
    return JSON.parse(fs.readFileSync(modelJsonPath, "utf-8"));
  } catch {
    return null;
  }
}

function motionMemberLabel(filePath = "", index = 0) {
  const fileName = path.basename(String(filePath || ""), ".motion3.json");
  return fileName.replace(/^\d+[_\s-]*/, "") || `Motion ${index + 1}`;
}

function getModelMotionGroups(model) {
  const model3 = readModel3Json(model);
  const motions = model3?.FileReferences?.Motions;
  if (!motions || typeof motions !== "object") return [];
  return Object.entries(motions)
    .filter(([motion]) => Boolean(motion))
    .map(([motion, entries]) => ({
      motion,
      members: Array.isArray(entries)
        ? entries.map((entry, index) => ({
            index,
            file: String(entry?.File || ""),
            label: motionMemberLabel(entry?.File, index),
          }))
        : [],
    }));
}

function getEventLabelsForMotion(model, motion) {
  const labels = [];
  for (const [eventType, behavior] of Object.entries(model?.events || {})) {
    if (behavior?.motion === motion) labels.push(eventType);
  }
  for (const [eventType, behavior] of Object.entries(model?.runtimeEvents || {})) {
    if (behavior?.motion === motion) labels.push(eventType);
  }
  return labels;
}

function getAvatarBehaviorPreviewOptions(model) {
  return getModelMotionGroups(model).map(({ motion, members }) => {
    const eventLabels = getEventLabelsForMotion(model, motion);
    const primaryEventType = eventLabels[0] || "";
    const behavior = primaryEventType
      ? resolveModelEventBehavior(model, primaryEventType)
      : model?.defaults || {};
    const expression = behavior.expression || model?.defaults?.expression || "";
    const mood = behavior.mood || model?.defaults?.mood || "calm";
    return {
      eventType: primaryEventType,
      mood,
      motion,
      expression,
      label: motion,
      description: motion,
      members,
    };
  });
}

function buildState(partial = {}, current = DEFAULT_STATE) {
  const model = getLive2DModelById(
    partial.selectedModelId ?? current.selectedModelId,
    loadLive2DModelCatalogFromFiles(),
  );
  const fallbackWindowBounds = current.windowBounds ?? DEFAULT_STATE.windowBounds;
  return {
    ...current,
    ...partial,
    protocolBaseUrl: normalizeProtocolBaseUrl(
      partial.protocolBaseUrl ?? current.protocolBaseUrl,
      DEFAULT_PROTOCOL_BASE_URL,
    ),
    selectedModelId: model.id,
    codexBridgeEnabled: Boolean(partial.codexBridgeEnabled ?? current.codexBridgeEnabled),
    avatarTuning: normalizeAvatarTuning({
      ...current.avatarTuning,
      ...(partial.avatarTuning || {}),
    }),
    personaDialogue: normalizePersonaDialogueSettings(
      {
        ...current.personaDialogue,
        ...(partial.personaDialogue || {}),
      },
      DEFAULT_STATE.personaDialogue,
    ),
    windowBounds: normalizeWindowBounds(partial.windowBounds, fallbackWindowBounds),
  };
}

class OverlayStateStore {
  constructor() {
    this.state = buildState();
  }

  get() {
    return {
      ...this.state,
      avatarTuning: { ...this.state.avatarTuning },
      personaDialogue: { ...this.state.personaDialogue },
      windowBounds: this.state.windowBounds ? { ...this.state.windowBounds } : null,
      selectedModel: getLive2DModelById(
        this.state.selectedModelId,
        loadLive2DModelCatalogFromFiles(),
      ),
    };
  }

  update(partial = {}) {
    this.state = buildState(partial, this.state);
    return this.get();
  }

  replace(next) {
    this.state = buildState(next, buildState());
    return this.get();
  }
}

class SettingsRepository {
  constructor(getPath) {
    this.getPath = getPath;
  }

  read() {
    try {
      const raw = fs.readFileSync(this.getPath(), "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  write(state) {
    fs.mkdirSync(path.dirname(this.getPath()), { recursive: true });
    fs.writeFileSync(this.getPath(), JSON.stringify(state, null, 2));
  }
}

class PersonaConfigRepository {
  constructor(filePath) {
    this.filePath = filePath;
  }

  read() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  write(settings) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(
        {
          personaDialogue: normalizePersonaDialogueSettings(settings),
        },
        null,
        2,
      ),
    );
  }
}

class LocalFileGateway {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  resolveSafePath(relativePath) {
    if (typeof relativePath !== "string" || !relativePath.trim()) {
      throw new Error("Path must be a non-empty string.");
    }

    const normalized = path.normalize(relativePath).replace(/\\/g, "/");
    if (path.isAbsolute(normalized) || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new Error("Path must stay inside app root.");
    }

    const absolutePath = path.resolve(this.rootDir, normalized);
    const rootWithSep = `${path.resolve(this.rootDir)}${path.sep}`;
    const absoluteResolved = path.resolve(absolutePath);
    if (absoluteResolved !== path.resolve(this.rootDir) && !absoluteResolved.startsWith(rootWithSep)) {
      throw new Error("Path escapes app root.");
    }

    return absolutePath;
  }

  readTextFile(relativePath) {
    const absolutePath = this.resolveSafePath(relativePath);
    return fs.readFileSync(absolutePath, "utf-8");
  }
}

class OverlayWindowController {
  constructor({
    rootDir,
    onFocusChange,
    onCloseRequest,
    onHideRequested,
    onReadyToShow,
    getWindowBounds,
    onWindowBoundsChange,
  }) {
    this.rootDir = rootDir;
    this.onFocusChange = onFocusChange;
    this.onCloseRequest = onCloseRequest;
    this.onHideRequested = onHideRequested;
    this.onReadyToShow = onReadyToShow;
    this.getWindowBounds = getWindowBounds;
    this.onWindowBoundsChange = onWindowBoundsChange;
    this.window = null;
    this.lastBounds = null;
    this.screenLocked = false;
    this.displayChangeTimer = null;
    this.displayListenersRegistered = false;
  }

  restoreBoundsIfNeeded() {
    if (!this.window || this.screenLocked) return;
    const savedBounds = this.getWindowBounds?.();
    if (!savedBounds) return;
    const workAreas = screen.getAllDisplays().map((d) => d.workArea);
    if (isWindowBoundsVisible(savedBounds, workAreas)) {
      const normalized = normalizeWindowBounds(savedBounds, this.lastBounds);
      if (!sameWindowBounds(normalized, this.lastBounds)) {
        this.lastBounds = normalized;
        this.window.setBounds(normalized, false);
      }
    }
  }

  create() {
    if (!this.displayListenersRegistered) {
      this.displayListenersRegistered = true;
      powerMonitor.on("lock-screen", () => {
        this.screenLocked = true;
      });
      powerMonitor.on("unlock-screen", () => {
        this.screenLocked = false;
      });
      const scheduleDisplayRecheck = () => {
        if (this.displayChangeTimer) clearTimeout(this.displayChangeTimer);
        this.displayChangeTimer = setTimeout(() => {
          this.displayChangeTimer = null;
          this.restoreBoundsIfNeeded();
        }, 1500);
      };
      screen.on("display-added", scheduleDisplayRecheck);
      screen.on("display-metrics-changed", scheduleDisplayRecheck);
    }

    const displays = screen.getAllDisplays();
    const primaryDisplay = screen.getPrimaryDisplay();
    const workAreas = displays.map((display) => display.workArea);
    const resolvedBounds = resolveWindowBounds(this.getWindowBounds?.(), {
      primaryWorkArea: primaryDisplay?.workArea,
      workAreas,
    });
    this.lastBounds = resolvedBounds;

    this.window = new BrowserWindow({
      width: resolvedBounds.width,
      height: resolvedBounds.height,
      x: resolvedBounds.x,
      y: resolvedBounds.y,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: true,
      fullscreenable: false,
      maximizable: false,
      minimizable: true,
      movable: true,
      roundedCorners: false,
      title: "Devflow Live2D Desktop",
      backgroundColor: "#00000000",
      show: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(this.rootDir, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    this.window.once("ready-to-show", () => {
      this.onReadyToShow?.();
    });

    this.window.loadFile(path.join(this.rootDir, "ui/index.html"));
    this.window.webContents.on("before-input-event", (event, input) => {
      const isCloseShortcut =
        input.type === "keyDown" &&
        (input.meta || input.control) &&
        String(input.key || "").toLowerCase() === "w";

      if (isCloseShortcut) {
        event.preventDefault();
        this.onHideRequested?.("shortcut");
      }
    });

    this.window.on("close", (event) => {
      const shouldClose = this.onCloseRequest?.() ?? true;
      if (!shouldClose) {
        event.preventDefault();
        this.onHideRequested?.("close-event");
      }
    });
    this.window.on("closed", () => {
      this.window = null;
      this.lastBounds = null;
      this.onFocusChange(false);
    });
    this.window.on("focus", () => this.onFocusChange(true));
    this.window.on("blur", () => this.onFocusChange(false));
    this.window.on("moved", () => this.handleBoundsChanged());
    this.window.on("resized", () => this.handleBoundsChanged());

    return this.window;
  }

  ensure() {
    if (!this.window) {
      return this.create();
    }
    return this.window;
  }

  broadcast(channel, payload) {
    this.window?.webContents.send(channel, payload);
  }

  handleBoundsChanged() {
    if (!this.window) return;
    const nextBounds = normalizeWindowBounds(this.window.getBounds(), this.lastBounds);
    if (!nextBounds || sameWindowBounds(nextBounds, this.lastBounds)) return;
    this.lastBounds = nextBounds;
    this.onWindowBoundsChange?.(nextBounds);
  }

  applyMode(state) {
    if (!this.window) return;

    // When the screen is locked, macOS may report only the primary display.
    // Skip bounds resolution to avoid snapping the window away from an
    // external monitor that will reappear after unlock.
    if (!this.screenLocked) {
      const resolvedBounds = resolveWindowBounds(state.windowBounds, {
        primaryWorkArea: screen.getPrimaryDisplay()?.workArea,
        workAreas: screen.getAllDisplays().map((display) => display.workArea),
      });
      if (!sameWindowBounds(resolvedBounds, this.lastBounds)) {
        this.lastBounds = resolvedBounds;
        this.window.setBounds(resolvedBounds, false);
      }
    }

    if (state.alwaysOnTop) {
      this.window.setAlwaysOnTop(true, "screen-saver");
    } else {
      this.window.setAlwaysOnTop(false);
    }

    if (process.platform === "darwin") {
      this.window.setVisibleOnAllWorkspaces(Boolean(state.allWorkspaces), {
        visibleOnFullScreen: Boolean(state.allWorkspaces),
      });
    }

    this.window.setIgnoreMouseEvents(Boolean(state.clickThrough), { forward: true });
    if (state.hidden) {
      this.window.hide();
    } else {
      this.window.showInactive();
    }
  }
}

class TrayController {
  constructor(onBuildMenu) {
    this.tray = null;
    this.onBuildMenu = onBuildMenu;
  }

  buildIcon() {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">
        <g fill="black">
          <rect x="2" y="2" width="14" height="14" rx="4"/>
          <rect x="5.2" y="6.1" width="1.8" height="1.8" rx="0.9" fill="white"/>
          <rect x="11" y="6.1" width="1.8" height="1.8" rx="0.9" fill="white"/>
          <path d="M5.5 11.1c1.2 1.4 2.3 2 3.5 2 1.2 0 2.3-.6 3.5-2" fill="none" stroke="white" stroke-width="1.4" stroke-linecap="round"/>
        </g>
      </svg>
    `.trim();

    const icon = nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    );
    icon.setTemplateImage(true);
    return icon.resize({ width: 18, height: 18 });
  }

  create() {
    this.tray = new Tray(this.buildIcon());
    if (process.platform === "darwin") {
      this.tray.setTitle("D");
    }
    this.tray.setToolTip("Devflow Live2D");
    this.tray.setIgnoreDoubleClickEvents(true);
    this.tray.on("click", () => this.showMenu());
    this.tray.on("right-click", () => this.showMenu());
  }

  ensure() {
    if (!this.tray) this.create();
  }

  showMenu() {
    if (!this.tray) return;
    this.tray.popUpContextMenu(this.onBuildMenu());
  }
}

class DesktopApp {
  constructor() {
    this.store = new OverlayStateStore();
    this.settings = new SettingsRepository(() =>
      path.join(app.getPath("userData"), SETTINGS_FILE_NAME),
    );
    this.personaConfig = new PersonaConfigRepository(DEVFLOW_CONFIG_FILE);
    this.files = new LocalFileGateway(__dirname);
    this.focused = false;
    this.isQuitting = false;
    this.overlay = new OverlayWindowController({
      rootDir: __dirname,
      onFocusChange: (focused) => {
        this.focused = focused;
        this.broadcastState();
      },
      onCloseRequest: () => this.isQuitting,
      onHideRequested: () => this.hideOverlay(),
      onReadyToShow: () => this.overlay.applyMode(this.store.get()),
      getWindowBounds: () => this.store.get().windowBounds,
      onWindowBoundsChange: (windowBounds) => {
        this.updateState({ windowBounds }, { broadcast: false });
      },
    });
    this.tray = new TrayController(() => this.buildTrayMenu());
    this.runtime = new DesktopServiceRuntime({
      app,
      rootDir: __dirname,
      protocolBaseUrl: DEFAULT_PROTOCOL_BASE_URL,
    });
    this.menuActionInFlight = false;
    this.serviceWatchTimer = null;
  }

  getPublicState() {
    const current = this.store.get();
    const personaConfig = resolvePersonaDialogueConfig(current.personaDialogue);
    return {
      ...current,
      personaDialogue: {
        enabled: current.personaDialogue.enabled,
        provider: current.personaDialogue.provider,
        model: current.personaDialogue.model,
        apiUrl: current.personaDialogue.apiUrl,
        timeoutMs: current.personaDialogue.timeoutMs,
        configured: personaConfig.configured,
      },
      platform: process.platform,
      focused: this.focused,
    };
  }

  loadSettings() {
    const stored = this.settings.read();
    if (stored) {
      this.store.replace(stored);
    }

    const personaStored = this.personaConfig.read();
    if (personaStored?.personaDialogue) {
      this.store.update({
        personaDialogue: normalizePersonaDialogueSettings(
          personaStored.personaDialogue,
          this.store.get().personaDialogue,
        ),
      });
    }
  }

  persistSettings() {
    this.settings.write(this.store.get());
    this.personaConfig.write(this.store.get().personaDialogue);
  }

  updateState(partial = {}, options = {}) {
    const { persist = true, broadcast = true } = options;
    const next = this.store.update(partial);
    this.overlay.applyMode(next);
    if (persist) this.persistSettings();
    if (broadcast) this.broadcastState();
    return this.getPublicState();
  }

  hideOverlay() {
    const state = this.store.get();
    if (state.hidden) return this.getPublicState();
    return this.updateState({ hidden: true });
  }

  broadcastState() {
    this.overlay.broadcast(IPC_CHANNELS.STATE_BROADCAST, this.getPublicState());
  }

  withMenuAction(label, action) {
    return async () => {
      if (this.menuActionInFlight) return;
      this.menuActionInFlight = true;

      try {
        await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[devflow-live2d] ${label} failed:`, message);
      } finally {
        this.menuActionInFlight = false;
        this.broadcastState();
      }
    };
  }

  async ensureWantedServices() {
    const state = this.store.get();
    if (!state.codexBridgeEnabled) return;
    if (this.runtime.getStatus().codexBridge.running) return;

    try {
      await this.runtime.startCodexBridge();
      this.broadcastState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[devflow-live2d] failed to start Codex bridge:", message);
    }
  }

  startServiceWatchdog() {
    if (this.serviceWatchTimer) return;
    this.serviceWatchTimer = setInterval(() => {
      void this.ensureWantedServices();
    }, 5000);
  }

  buildTrayMenu() {
    const state = this.store.get();
    const modelCatalog = loadLive2DModelCatalogFromFiles();
    const currentScale = state.avatarTuning.scale;
    const currentModel = getLive2DModelById(state.selectedModelId, modelCatalog);
    const currentModelId = currentModel.id;
    const presetScales = [50, 60, 70, 80, 100, 120];
    const behaviorOptions = getAvatarBehaviorPreviewOptions(currentModel);
    const personaConfig = resolvePersonaDialogueConfig(state.personaDialogue);
    const personaProvider = personaConfig.provider || "openai-compatible";
    const personaApiUrl = state.personaDialogue.apiUrl || DEFAULT_PERSONA_API_URL;
    const keyConfigured = personaConfig.configured;
    const runtimeStatus = this.runtime.getStatus();

    return Menu.buildFromTemplate([
      {
        label: state.hidden ? "显示角色" : "隐藏角色",
        click: () => this.updateState({ hidden: !state.hidden }),
      },
      { type: "separator" },
      {
        label: "始终置顶",
        type: "checkbox",
        checked: state.alwaysOnTop,
        click: () => this.updateState({ alwaysOnTop: !state.alwaysOnTop }),
      },
      {
        label: "所有桌面可见",
        type: "checkbox",
        checked: state.allWorkspaces,
        click: () => this.updateState({ allWorkspaces: !state.allWorkspaces }),
      },
      {
        label: "点击穿透",
        type: "checkbox",
        checked: state.clickThrough,
        click: () => this.updateState({ clickThrough: !state.clickThrough }),
      },
      { type: "separator" },
      {
        label: "模型",
        submenu: modelCatalog.map((model) => ({
          label: model.name,
          type: "radio",
          checked: currentModelId === model.id,
          click: () => {
            this.updateState({ selectedModelId: model.id });
          },
        })),
      },
      {
        label: "模型行为预览",
        submenu:
          behaviorOptions.length > 0
            ? behaviorOptions.map((behavior) => ({
                label: behavior.label,
                submenu:
                  behavior.members.length > 0
                    ? behavior.members.map((member) => ({
                        label: member.label,
                        click: () => {
                          console.log(
                            `[devflow-live2d] preview motion ${currentModel.id} ${behavior.motion}[${member.index}] ${member.file}`,
                          );
                          this.overlay.broadcast(IPC_CHANNELS.PREVIEW_AVATAR_STATE, {
                            mood: behavior.mood,
                            expression: behavior.expression,
                            motion: behavior.motion,
                            motionIndex: member.index,
                            source: "tray-preview",
                            label: `${behavior.description} / ${member.label}`,
                          });
                        },
                      }))
                    : [{ label: "当前分组无可用动作", enabled: false }],
              }))
            : [{ label: "当前模型无可用行为", enabled: false }],
      },
      {
        label: "角色大小",
        submenu: [
          ...presetScales.map((scale) => ({
            label: `${scale}%`,
            type: "checkbox",
            checked: currentScale === scale,
            click: () =>
              this.updateState({
                avatarTuning: {
                  ...state.avatarTuning,
                  scale,
                },
              }),
          })),
          { type: "separator" },
          {
            label: "缩小一点",
            click: () =>
              this.updateState({
                avatarTuning: {
                  ...state.avatarTuning,
                  scale: currentScale - 10,
                },
              }),
          },
          {
            label: "放大一点",
            click: () =>
              this.updateState({
                avatarTuning: {
                  ...state.avatarTuning,
                  scale: currentScale + 10,
                },
              }),
          },
        ],
      },
      {
        label: "恢复默认",
        click: () =>
          this.updateState({
            avatarTuning: { ...DEFAULT_STATE.avatarTuning },
          }),
      },
      { type: "separator" },
      {
        label: "AI 闲聊",
        submenu: [
          {
            label: "启用 AI 闲聊",
            type: "checkbox",
            checked: Boolean(state.personaDialogue.enabled && keyConfigured),
            click: () =>
              this.updateState({
                personaDialogue: {
                  ...state.personaDialogue,
                  enabled: !state.personaDialogue.enabled,
                },
              }),
          },
          {
            label: "打开配置文件夹",
            click: () => {
              fs.mkdirSync(DEVFLOW_CONFIG_DIR, { recursive: true });
              void shell.openPath(DEVFLOW_CONFIG_DIR);
            },
          },
          { type: "separator" },
          {
            label: "模型源: OpenAI 兼容 API",
            enabled: false,
          },
          {
            label: `模型: ${personaConfig.model} (配置文件)`,
            enabled: false,
          },
          ...(personaProvider === "openai-compatible"
            ? [
                {
                  label: `API URL: ${personaApiUrl.replace(/^https?:\/\//, "")}`,
                  enabled: false,
                },
              ]
            : []),
          {
            label: "重新加载配置文件",
            click: () => {
              const next = this.personaConfig.read();
              if (!next?.personaDialogue) return;
              this.updateState(
                {
                  personaDialogue: normalizePersonaDialogueSettings(
                    next.personaDialogue,
                    state.personaDialogue,
                  ),
                },
                { persist: true },
              );
            },
          },
          {
            label: "测试生成一句",
            enabled: Boolean(state.personaDialogue.enabled && keyConfigured),
            click: async () => {
              const fallbackText = "先安静一会儿，等下一条动静。";
              const response = await generatePersonaDialogue(
                {
                  category: "idle",
                  fallbackText,
                  project: "devflow-live2d",
                  task: "Persona dialogue smoke test",
                  message: "Generate one idle desktop companion line.",
                },
                state.personaDialogue,
              );

              this.overlay.broadcast(IPC_CHANNELS.PREVIEW_AVATAR_STATE, {
                mood: response.ok ? "attentive" : "calm",
                expression: response.ok ? "attentive" : "calm",
                motion: response.ok ? "acknowledge" : "idleWave",
                source: "tray-preview",
                label: response.ok ? "AI 闲聊测试" : "AI 闲聊回退",
                previewText: response.ok ? response.text : fallbackText,
                previewStatus: response.ok
                  ? "AI 闲聊测试"
                  : `${resolvePersonaDialogueErrorText(response)}，已回退本地文案`,
              });
            },
          },
        ],
      },
      { type: "separator" },
      {
        label: "后台服务",
        submenu: [
          {
            label: "devflow-protocol",
            submenu: [
              {
                label: runtimeStatus.protocol.running
                  ? `devflow-protocol 运行中（PID: ${runtimeStatus.protocol.pid}）`
                  : "devflow-protocol 未运行",
                enabled: false,
              },
              {
                label: runtimeStatus.protocol.running ? "停止 devflow-protocol" : "启动 devflow-protocol",
                enabled: true,
                click: this.withMenuAction("toggle protocol", async () => {
                  if (this.runtime.getStatus().protocol.running) {
                    await this.runtime.stopProtocol();
                  } else {
                    await this.runtime.startProtocol();
                  }
                }),
              },
            ],
          },
          {
            label: "Codex bridge",
            submenu: [
              {
                label: state.codexBridgeEnabled
                  ? runtimeStatus.codexBridge.running
                    ? `Codex bridge 已开启（PID: ${runtimeStatus.codexBridge.pid}）`
                    : "Codex bridge 已开启，等待启动"
                  : "Codex bridge 未开启",
                enabled: false,
              },
              {
                label: state.codexBridgeEnabled ? "关闭 Codex bridge" : "开启 Codex bridge",
                enabled: runtimeStatus.capabilities.python3,
                click: this.withMenuAction("toggle Codex bridge", async () => {
                  if (this.store.get().codexBridgeEnabled) {
                    this.updateState({ codexBridgeEnabled: false });
                    await this.runtime.stopCodexBridge();
                  } else {
                    this.updateState({ codexBridgeEnabled: true });
                    await this.runtime.startCodexBridge();
                  }
                }),
              },
            ],
          },
          {
            label: "Claude 全局插件",
            submenu: [
              {
                label: runtimeStatus.claudePlugin.installed
                  ? "Claude 全局插件 已安装"
                  : "Claude 全局插件 未安装",
                enabled: false,
              },
              {
                label: runtimeStatus.claudePlugin.installed ? "卸载 Claude 全局插件" : "安装 Claude 全局插件",
                enabled: runtimeStatus.capabilities.bash && runtimeStatus.capabilities.node,
                click: this.withMenuAction("toggle Claude plugin", async () => {
                  if (this.runtime.getStatus().claudePlugin.installed) {
                    await this.runtime.uninstallClaudeGlobalPlugin();
                  } else {
                    await this.runtime.installClaudeGlobalPlugin();
                  }
                }),
              },
            ],
          },
          { type: "separator" },
          {
            label: runtimeStatus.protocol.logPath,
            enabled: false,
          },
          {
            label: "打开日志目录",
            click: () => {
              fs.mkdirSync(this.runtime.getLogDir(), { recursive: true });
              void shell.openPath(this.runtime.getLogDir());
            },
          },
          ...(runtimeStatus.protocol.lastError || runtimeStatus.codexBridge.lastError
            ? [
                { type: "separator" },
                ...(runtimeStatus.protocol.lastError
                  ? [
                      {
                        label: `protocol 最近错误: ${runtimeStatus.protocol.lastError}`.slice(0, 140),
                        enabled: false,
                      },
                    ]
                  : []),
                ...(runtimeStatus.codexBridge.lastError
                  ? [
                      {
                        label: `Codex bridge 最近错误: ${runtimeStatus.codexBridge.lastError}`.slice(0, 140),
                        enabled: false,
                      },
                    ]
                  : []),
              ]
            : []),
        ],
      },
      { type: "separator" },
      {
        label: "退出",
        accelerator: "CommandOrControl+Q",
        click: () => app.quit(),
      },
    ]);
  }

  registerIpc() {
    ipcMain.handle(IPC_CHANNELS.GET_STATE, () => this.getPublicState());
    ipcMain.handle(IPC_CHANNELS.UPDATE_STATE, (_event, partialState) =>
      this.updateState(partialState || {}),
    );
    ipcMain.handle(IPC_CHANNELS.OPEN_MENU, () => {
      this.tray.showMenu();
      return this.getPublicState();
    });
    ipcMain.handle(IPC_CHANNELS.QUIT, () => {
      this.isQuitting = true;
      app.quit();
      return true;
    });
    ipcMain.handle(IPC_CHANNELS.READ_TEXT_FILE, (_event, relativePath) =>
      this.files.readTextFile(relativePath),
    );
    ipcMain.handle(IPC_CHANNELS.GENERATE_PERSONA_DIALOGUE, async (_event, payload) =>
      generatePersonaDialogue(payload || {}, this.store.get().personaDialogue),
    );
  }

  registerShortcuts() {
    globalShortcut.register("CommandOrControl+Shift+X", () => {
      this.updateState({ clickThrough: false });
    });
    globalShortcut.register("CommandOrControl+Shift+H", () => {
      const state = this.store.get();
      this.updateState({ hidden: !state.hidden });
    });
  }

  initialize() {
    this.loadSettings();
    this.overlay.ensure();
    this.tray.ensure();
    this.persistSettings();
    this.broadcastState();
    this.registerIpc();
    this.registerShortcuts();
    this.startServiceWatchdog();
    void this.runtime.startProtocol().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[devflow-live2d] failed to start devflow-protocol:", message);
    }).then(() => {
      void this.ensureWantedServices();
    });
  }
}

const desktopApp = new DesktopApp();

app.whenReady().then(() => {
  if (process.platform === "darwin") {
    app.dock.hide();
  }
  desktopApp.initialize();

  app.on("activate", () => {
    desktopApp.overlay.ensure();
    desktopApp.tray.ensure();
    desktopApp.broadcastState();
  });
});

app.on("before-quit", () => {
  desktopApp.isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  void desktopApp.runtime.shutdown();
});
