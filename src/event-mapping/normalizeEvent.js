function truncate(text, maxLength = 140) {
  if (typeof text !== "string") return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function pickMessage(entry, payload) {
  return truncate(
    entry.payload?.summary ||
      entry.payload?.message ||
      entry.payload?.result ||
      entry.payload?.detail ||
      payload.summary ||
      payload.message ||
      payload.result ||
      payload.detail ||
      payload.output ||
      "",
  );
}

function pickTaskSnapshot(task, fallbackMessage) {
  const data = asObject(task);
  const title = truncate(data.subject || data.title || fallbackMessage || "");
  const detail = truncate(data.description || data.detail || "");
  const status = String(data.status || "").trim().toLowerCase();

  return {
    id: String(data.id || "").trim(),
    title,
    detail,
    status,
  };
}

function pickUsageSnapshot(payload) {
  const data = asObject(payload.data || payload.usage || payload);
  const inputTokens = Number(data.inputTokens || data.input_tokens || 0);
  const outputTokens = Number(data.outputTokens || data.output_tokens || 0);
  const cacheReadTokens = Number(data.cacheReadTokens || data.cached_input_tokens || 0);
  const contextWindow = Number(data.contextWindow || data.model_context_window || 0);
  const lastTurnContext = Number(data.lastTurnContext || data.last_turn_context || 0);

  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    cacheReadTokens: Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0,
    contextWindow: Number.isFinite(contextWindow) ? contextWindow : 0,
    lastTurnContext: Number.isFinite(lastTurnContext) ? lastTurnContext : 0,
  };
}

function normalizeKind(type) {
  if (type === "request.created") return "request";
  if (type === "task.created" || type === "task.updated" || type === "task.assigned") return "task";
  if (type === "task.completed") return "work-result";
  if (type === "tool.started") return "work";
  if (type === "tool.completed") return "work-result";
  if (type === "assistant.message") return "dialogue";
  if (type === "usage.updated") return "usage";
  if (type === "connected") return "connection";
  if (type === "disconnect" || type === "error") return "error";
  return "other";
}

export function normalizeProtocolEvent(entry = {}) {
  const payload = asObject(entry.payload);
  const kind = normalizeKind(String(entry.eventType || "").trim().toLowerCase());
  const message = pickMessage(entry, payload);
  const task = pickTaskSnapshot(entry.task, message);
  const usage = pickUsageSnapshot(payload);

  return {
    kind,
    rawType: String(entry.eventType || "unknown"),
    source: String(entry.source || "protocol"),
    timestamp: entry.timestamp ? Date.parse(entry.timestamp) || Date.now() : Date.now(),
    message,
    task,
    usage,
    raw: entry,
  };
}
