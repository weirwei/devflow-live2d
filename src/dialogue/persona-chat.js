import { getPersonaLines } from "./persona-lines.js";

export const PERSONA_EVENT_COOLDOWN_MS = 10_000;
export const PERSONA_IDLE_COOLDOWN_MS = 45_000;
export const PERSONA_IDLE_THRESHOLD_MS = 30_000;
export const PERSONA_STRONG_EVENT_BLOCK_MS = 3_200;
export const PERSONA_POLL_INTERVAL_MS = 1_000;

const EVENT_CATEGORY_BY_RAW_TYPE = {
  "request.created": "request",
  "tool.completed": "success",
  "task.completed": "success",
  disconnect: "disconnect",
  error: "error",
};

const MOOD_BY_CATEGORY = {
  idle: "calm",
  working: "calm",
  thinking: "thinking",
  success: "happy",
  error: "alert",
  disconnect: "alert",
  reconnect: "attentive",
  request: "attentive",
};

function pickNextLine(lines, previousLine, rng = Math.random) {
  if (!Array.isArray(lines) || lines.length === 0) return "";
  if (lines.length === 1) return lines[0];

  const candidates = lines.filter((line) => line && line !== previousLine);
  const pool = candidates.length > 0 ? candidates : lines;
  const index = Math.floor(Math.max(0, Math.min(0.999999, rng())) * pool.length);
  return pool[index] || pool[0] || "";
}

function createPersonaPayload(category, text, now) {
  if (!text) return null;
  return {
    text,
    tone: "neutral",
    channel: "persona",
    category,
    mood: MOOD_BY_CATEGORY[category] || "calm",
    createdAt: now,
  };
}

export class PersonaChatController {
  constructor(options = {}) {
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.rng = typeof options.rng === "function" ? options.rng : Math.random;
    this.idleThresholdMs = Number.isFinite(options.idleThresholdMs)
      ? options.idleThresholdMs
      : PERSONA_IDLE_THRESHOLD_MS;
    this.idleCooldownMs = Number.isFinite(options.idleCooldownMs)
      ? options.idleCooldownMs
      : PERSONA_IDLE_COOLDOWN_MS;
    this.eventCooldownMs = Number.isFinite(options.eventCooldownMs)
      ? options.eventCooldownMs
      : PERSONA_EVENT_COOLDOWN_MS;
    this.strongEventBlockMs = Number.isFinite(options.strongEventBlockMs)
      ? options.strongEventBlockMs
      : PERSONA_STRONG_EVENT_BLOCK_MS;

    const initialNow = this.now();
    this.hasEverConnected = false;
    this.lastRealEventAt = initialNow;
    this.lastIdleAt = 0;
    this.lastEventChatAt = 0;
    this.lastStrongEventAt = 0;
    this.lastSpokenLine = "";
    this.wasDisconnected = false;
  }

  reset(now = this.now()) {
    this.lastRealEventAt = now;
    this.lastIdleAt = 0;
    this.lastEventChatAt = 0;
    this.lastStrongEventAt = 0;
    this.lastSpokenLine = "";
    this.wasDisconnected = false;
    this.hasEverConnected = false;
  }

  noteQueueActivity(kind, now = this.now()) {
    if (kind === "strong") {
      this.lastStrongEventAt = now;
    }
  }

  handleEvent(event, options = {}) {
    const now = options.now ?? this.now();
    const isConnected = options.isConnected ?? this.hasEverConnected;
    const canSpeak = options.canSpeak !== false;
    const rawType = String(event?.rawType || event?.eventType || "").trim().toLowerCase();

    if (rawType && rawType !== "connected") {
      this.lastRealEventAt = now;
    }

    if (!canSpeak) {
      if (rawType === "disconnect" || rawType === "error") {
        this.wasDisconnected = true;
      }
      if (rawType === "connected") {
        this.hasEverConnected = true;
      }
      return null;
    }

    if (rawType === "connected") {
      const shouldReconnect = this.wasDisconnected && this.hasEverConnected;
      this.hasEverConnected = true;
      this.wasDisconnected = false;
      if (!shouldReconnect) return null;
      return this.issueCategory("reconnect", now, "event");
    }

    if (!isConnected && !this.hasEverConnected) {
      if (rawType === "disconnect" || rawType === "error") {
        this.wasDisconnected = true;
      }
      return null;
    }

    if (rawType === "disconnect" || rawType === "error") {
      this.wasDisconnected = true;
    }

    const category = EVENT_CATEGORY_BY_RAW_TYPE[rawType];
    if (!category) return null;
    return this.issueCategory(category, now, "event");
  }

  tick(options = {}) {
    const now = options.now ?? this.now();
    const isConnected = options.isConnected ?? false;
    const canSpeak = options.canSpeak !== false;

    if (!isConnected || !this.hasEverConnected || !canSpeak) {
      return null;
    }

    if (now - this.lastStrongEventAt < this.strongEventBlockMs) {
      return null;
    }

    if (now - this.lastRealEventAt < this.idleThresholdMs) {
      return null;
    }

    if (now - this.lastIdleAt < this.idleCooldownMs) {
      return null;
    }

    return this.issueCategory("idle", now, "idle");
  }

  issueCategory(category, now, mode) {
    const lines = getPersonaLines(category);
    if (lines.length === 0) return null;

    if (mode === "event" && now - this.lastEventChatAt < this.eventCooldownMs) {
      return null;
    }

    if (mode === "idle" && now - this.lastIdleAt < this.idleCooldownMs) {
      return null;
    }

    const text = pickNextLine(lines, this.lastSpokenLine, this.rng);
    if (!text) return null;

    this.lastSpokenLine = text;
    if (mode === "event") {
      this.lastEventChatAt = now;
    }
    if (mode === "idle") {
      this.lastIdleAt = now;
    }

    return createPersonaPayload(category, text, now);
  }
}

const RECENT_EVENTS_MAX = 6;

export class RecentEventTracker {
  constructor(maxSize = RECENT_EVENTS_MAX) {
    this.maxSize = maxSize;
    this.events = [];
  }

  push(normalized) {
    if (!normalized) return;
    const summary = String(
      normalized.message || normalized.rawType || "",
    ).trim();
    if (!summary) return;
    this.events.push({
      type: normalized.rawType || "",
      summary: summary.slice(0, 60),
      ts: normalized.timestamp || Date.now(),
    });
    if (this.events.length > this.maxSize) {
      this.events.splice(0, this.events.length - this.maxSize);
    }
  }

  summarize() {
    if (this.events.length === 0) return "";
    return this.events
      .map((e) => e.summary)
      .join("；");
  }
}

export function buildPersonaRequestContext(personaItem, normalizedEvent = null, recentContext = "") {
  return {
    category: personaItem?.category || "",
    fallbackText: personaItem?.text || "",
    rawType: normalizedEvent?.rawType || "",
    message: normalizedEvent?.message || "",
    project: normalizedEvent?.project || "",
    task: normalizedEvent?.task?.title || normalizedEvent?.task?.detail || "",
    recentContext: typeof recentContext === "string" ? recentContext : "",
  };
}
