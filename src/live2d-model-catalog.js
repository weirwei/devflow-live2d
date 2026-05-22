export const DEFAULT_LIVE2D_MODEL_ID = "nito";

export const PROTOCOL_EVENT_TYPES = [
  "session.started",
  "session.ended",
  "request.created",
  "assistant.message",
  "task.created",
  "task.updated",
  "task.assigned",
  "task.completed",
  "tool.started",
  "tool.completed",
  "usage.updated",
];

export const RUNTIME_EVENT_TYPES = ["connected", "disconnect", "error"];

export const LIVE2D_MODEL_CONFIG_PATHS = [
  "assets/live2d/models/nito-runtime/nito.live2d.json",
  "assets/live2d/models/nito-runtime/nico.live2d.json",
  "assets/live2d/models/nito-runtime/ni-j.live2d.json",
  "assets/live2d/models/nito-runtime/nipsilon.live2d.json",
  "assets/live2d/models/nito-runtime/nietzsche.live2d.json",
];

const DEFAULT_EVENT_BEHAVIOR = {
  motion: "Idle",
  expression: "",
  mood: "calm",
  holdMs: 0,
};

const LEGACY_MOTION_EVENTS = {
  idleWave: "session.started",
  acknowledge: "task.updated",
  greet: "request.created",
  workLoop: "tool.started",
  ponder: "usage.updated",
  celebrate: "task.completed",
  shake: "error",
};

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanString(value, fallback = "") {
  const trimmed = String(value || "").trim();
  return trimmed || fallback;
}

function cleanNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toRuntimeResourcesRoot(basePath) {
  return basePath.replace(/^assets\/live2d\/models\//, "");
}

function normalizeBehavior(input = {}, fallback = DEFAULT_EVENT_BEHAVIOR) {
  const next = asObject(input);
  return {
    motion: cleanString(next.motion, fallback.motion),
    expression: typeof next.expression === "string" ? next.expression.trim() : fallback.expression,
    mood: cleanString(next.mood, fallback.mood),
    holdMs: Math.max(0, cleanNumber(next.holdMs, fallback.holdMs || 0)),
    bubbleTone: typeof next.bubbleTone === "string" ? next.bubbleTone.trim() : fallback.bubbleTone,
    bubbleChannel:
      typeof next.bubbleChannel === "string" ? next.bubbleChannel.trim() : fallback.bubbleChannel,
  };
}

function normalizeBehaviorMap(input = {}, allowedTypes = PROTOCOL_EVENT_TYPES) {
  const source = asObject(input);
  const allowed = new Set(allowedTypes);
  const output = {};
  for (const [eventType, behavior] of Object.entries(source)) {
    if (!allowed.has(eventType)) continue;
    output[eventType] = normalizeBehavior(behavior);
  }
  return output;
}

function behaviorMapToLegacyMotions(events = {}, runtimeEvents = {}) {
  const allEvents = { ...events, ...runtimeEvents };
  const motions = {};
  for (const [legacyKey, eventType] of Object.entries(LEGACY_MOTION_EVENTS)) {
    const motion = allEvents[eventType]?.motion;
    if (motion) motions[legacyKey] = motion;
  }
  return motions;
}

function behaviorMapToLegacyExpressions(events = {}, runtimeEvents = {}) {
  const output = {};
  for (const behavior of Object.values({ ...events, ...runtimeEvents })) {
    if (!behavior?.mood || typeof behavior.expression !== "string") continue;
    if (behavior.expression) output[behavior.mood] = behavior.expression;
  }
  return output;
}

export function normalizeLive2DModelConfig(input = {}) {
  const next = asObject(input);
  const model = asObject(next.model);
  const layout = asObject(next.layout);
  const runtime = asObject(next.runtime);
  const defaults = normalizeBehavior(next.defaults);
  const events = normalizeBehaviorMap(next.events, PROTOCOL_EVENT_TYPES);
  const runtimeEvents = normalizeBehaviorMap(next.runtimeEvents, RUNTIME_EVENT_TYPES);
  const id = cleanString(next.id || model.id, DEFAULT_LIVE2D_MODEL_ID);
  const name = cleanString(next.name || model.name, id);
  const basePath = cleanString(model.basePath, `assets/live2d/models/${id}`);
  const modelJson = cleanString(model.modelJson, `${id}.model3.json`);
  const runtimeResourcesRoot = cleanString(
    runtime.resourcesRoot || model.runtimeResourcesRoot,
    toRuntimeResourcesRoot(basePath),
  );
  const runtimeModelJson = cleanString(model.runtimeModelJson, modelJson);

  return {
    version: cleanNumber(next.version, 1),
    id,
    name,
    enabled: next.enabled !== false,
    runtime: {
      engine: cleanString(runtime.engine, "external-official"),
      resourcesRoot: runtimeResourcesRoot,
    },
    model: {
      basePath,
      modelJson,
      runtimeResourcesRoot,
      runtimeModelJson,
    },
    layout: {
      runtimeWidth: cleanNumber(layout.runtimeWidth, 1.1),
      centerX: cleanNumber(layout.centerX, 0.45),
      centerY: cleanNumber(layout.centerY, 0.12),
      scale: cleanNumber(layout.scale, 1),
      offsetX: cleanNumber(layout.offsetX, 0),
      offsetY: cleanNumber(layout.offsetY, 0),
    },
    defaults,
    events,
    runtimeEvents,
    interaction: asObject(next.interaction),
    metadata: asObject(next.metadata),
    manifestModel: {
      id: cleanString(model.id, id),
      name,
      basePath,
      modelJson,
      runtimeResourcesRoot,
      runtimeModelJson,
      runtimeWidth: cleanNumber(layout.runtimeWidth, 1.1),
      centerX: cleanNumber(layout.centerX, 0.45),
      centerY: cleanNumber(layout.centerY, 0.12),
      scale: cleanNumber(layout.scale, 1),
      offsetX: cleanNumber(layout.offsetX, 0),
      offsetY: cleanNumber(layout.offsetY, 0),
    },
    motions: behaviorMapToLegacyMotions(events, runtimeEvents),
    expressions: behaviorMapToLegacyExpressions(events, runtimeEvents),
  };
}

export function createLive2DModelCatalog(configs = DEFAULT_LIVE2D_MODEL_CONFIGS) {
  return configs
    .map((config) => normalizeLive2DModelConfig(config))
    .filter((config) => config.enabled);
}

export function getLive2DModelById(modelId, catalog = LIVE2D_MODEL_CATALOG) {
  return (
    catalog.find((entry) => entry.id === modelId) ||
    catalog.find((entry) => entry.id === DEFAULT_LIVE2D_MODEL_ID) ||
    catalog[0]
  );
}

export function resolveModelEventBehavior(model, eventType) {
  const rawType = cleanString(eventType).toLowerCase();
  return (
    model?.events?.[rawType] ||
    model?.runtimeEvents?.[rawType] ||
    model?.defaults ||
    DEFAULT_EVENT_BEHAVIOR
  );
}

export const DEFAULT_LIVE2D_MODEL_CONFIGS = [
  {
    id: "nito",
    name: "Nito",
    model: {
      id: "nito-runtime",
      basePath: "assets/live2d/models/nito-runtime",
      modelJson: "nito.model3.json",
      runtimeResourcesRoot: "nito",
      runtimeModelJson: "nito.model3.json",
    },
    layout: { runtimeWidth: 1.1, centerX: 0.45, centerY: 0.12 },
    events: {
      "session.started": { motion: "Idle", mood: "calm" },
      "request.created": { motion: "FlickUp", mood: "alert", holdMs: 1600, bubbleTone: "alert" },
      "assistant.message": { motion: "Idle", mood: "calm", bubbleChannel: "dialogue" },
      "task.created": { motion: "Tap", mood: "attentive" },
      "task.updated": { motion: "Tap", mood: "focus" },
      "task.assigned": { motion: "Tap", mood: "attentive" },
      "task.completed": { motion: "Flick3", mood: "happy", holdMs: 1600, bubbleTone: "success" },
      "tool.started": { motion: "Idle", mood: "focus" },
      "tool.completed": { motion: "Flick3", mood: "happy", holdMs: 1600, bubbleTone: "success" },
      "usage.updated": { motion: "FlickDown", mood: "attentive", bubbleTone: "neutral" },
    },
    runtimeEvents: {
      connected: { motion: "Tap", mood: "attentive" },
      disconnect: { motion: "FlickUp", mood: "alert", holdMs: 1600, bubbleTone: "warning" },
      error: { motion: "Shake", mood: "alert", holdMs: 1600, bubbleTone: "warning" },
    },
  },
  {
    id: "nico",
    name: "Nico",
    model: {
      id: "nico-runtime",
      basePath: "assets/live2d/models/nito-runtime",
      modelJson: "nico.model3.json",
      runtimeResourcesRoot: "nito",
      runtimeModelJson: "nico.model3.json",
    },
    layout: { runtimeWidth: 1.08, centerX: 0.45, centerY: 0.12 },
    defaults: { motion: "Relaxed", expression: "", mood: "calm", holdMs: 0 },
    events: {
      "session.started": { motion: "Relaxed", mood: "calm" },
      "request.created": { motion: "Reject", mood: "alert", holdMs: 1600, bubbleTone: "alert" },
      "task.updated": { motion: "Happy", mood: "focus" },
      "task.assigned": { motion: "Happy", mood: "attentive" },
      "task.completed": { motion: "Happy", mood: "happy", holdMs: 1600, bubbleTone: "success" },
      "tool.started": { motion: "Relaxed", mood: "focus" },
      "tool.completed": { motion: "Happy", mood: "happy", holdMs: 1600, bubbleTone: "success" },
      "usage.updated": { motion: "Sad", mood: "attentive" },
    },
    runtimeEvents: {
      connected: { motion: "Happy", mood: "attentive" },
      error: { motion: "Reject", mood: "alert", holdMs: 1600, bubbleTone: "warning" },
    },
  },
  {
    id: "nij",
    name: "Ni-J",
    model: {
      id: "ni-j-runtime",
      basePath: "assets/live2d/models/nito-runtime",
      modelJson: "ni-j.model3.json",
      runtimeResourcesRoot: "nito",
      runtimeModelJson: "ni-j.model3.json",
    },
    layout: { runtimeWidth: 1.08, centerX: 0.45, centerY: 0.12 },
    events: {
      "request.created": { motion: "FlickUp", mood: "alert", holdMs: 1600, bubbleTone: "alert" },
      "task.updated": { motion: "Tap", mood: "focus" },
      "task.completed": { motion: "Flick3", mood: "happy", holdMs: 1600, bubbleTone: "success" },
      "tool.started": { motion: "Idle", mood: "focus" },
      "tool.completed": { motion: "Flick3", mood: "happy", holdMs: 1600, bubbleTone: "success" },
      "usage.updated": { motion: "FlickDown", mood: "attentive" },
    },
    runtimeEvents: {
      connected: { motion: "Tap", mood: "attentive" },
      error: { motion: "Shake", mood: "alert", holdMs: 1600, bubbleTone: "warning" },
    },
  },
  {
    id: "nipsilon",
    name: "Nipsilon",
    model: {
      id: "nipsilon-runtime",
      basePath: "assets/live2d/models/nito-runtime",
      modelJson: "nipsilon.model3.json",
      runtimeResourcesRoot: "nito",
      runtimeModelJson: "nipsilon.model3.json",
    },
    layout: { runtimeWidth: 1.06, centerX: 0.45, centerY: 0.12 },
    events: {
      "request.created": { motion: "FlickUp", mood: "alert", holdMs: 1600, bubbleTone: "alert" },
      "task.updated": { motion: "Tap", mood: "focus" },
      "task.completed": { motion: "Flick3", mood: "happy", holdMs: 1600, bubbleTone: "success" },
      "tool.started": { motion: "Idle", mood: "focus" },
      "tool.completed": { motion: "Flick3", mood: "happy", holdMs: 1600, bubbleTone: "success" },
      "usage.updated": { motion: "FlickDown", mood: "attentive" },
    },
    runtimeEvents: {
      connected: { motion: "Tap", mood: "attentive" },
      error: { motion: "Shake", mood: "alert", holdMs: 1600, bubbleTone: "warning" },
    },
  },
  {
    id: "nietzsche",
    name: "Nietzsche",
    model: {
      id: "nietzsche-runtime",
      basePath: "assets/live2d/models/nito-runtime",
      modelJson: "nietzsche.model3.json",
      runtimeResourcesRoot: "nito",
      runtimeModelJson: "nietzsche.model3.json",
    },
    layout: { runtimeWidth: 1.06, centerX: 0.45, centerY: 0.12 },
    events: {
      "request.created": { motion: "FlickUp", mood: "alert", holdMs: 1600, bubbleTone: "alert" },
      "task.updated": { motion: "Tap", mood: "focus" },
      "task.completed": { motion: "Flick3", mood: "happy", holdMs: 1600, bubbleTone: "success" },
      "tool.started": { motion: "Idle", mood: "focus" },
      "tool.completed": { motion: "Flick3", mood: "happy", holdMs: 1600, bubbleTone: "success" },
      "usage.updated": { motion: "FlickDown", mood: "attentive" },
    },
    runtimeEvents: {
      connected: { motion: "Tap", mood: "attentive" },
      error: { motion: "Shake", mood: "alert", holdMs: 1600, bubbleTone: "warning" },
    },
  },
];

export const LIVE2D_MODEL_CATALOG = createLive2DModelCatalog();
