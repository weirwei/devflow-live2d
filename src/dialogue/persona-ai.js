export const DEFAULT_PERSONA_MODEL = process.env.DEVFLOW_DIALOGUE_MODEL?.trim() || "gpt-5-mini";
export const DEFAULT_PERSONA_API_URL =
  process.env.DEVFLOW_DIALOGUE_API_URL?.trim() || "https://api.openai.com/v1/chat/completions";
export const DEFAULT_PERSONA_TIMEOUT_MS = 8_000;

function firstLine(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split("\n")[0]
    .trim();
}

function truncate(text, maxLength = 120) {
  const normalized = firstLine(text);
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function getPersonaDialogueConfig(env = process.env) {
  const apiKey =
    env.DEVFLOW_DIALOGUE_API_KEY?.trim() ||
    env.OPENAI_API_KEY?.trim() ||
    "";
  const apiUrl = env.DEVFLOW_DIALOGUE_API_URL?.trim() || DEFAULT_PERSONA_API_URL;
  const model = env.DEVFLOW_DIALOGUE_MODEL?.trim() || DEFAULT_PERSONA_MODEL;
  const timeoutMs = Number(env.DEVFLOW_DIALOGUE_TIMEOUT_MS || DEFAULT_PERSONA_TIMEOUT_MS);

  return {
    enabled: Boolean(apiKey),
    apiKey,
    apiUrl,
    model,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PERSONA_TIMEOUT_MS,
  };
}

function normalizeApiUrl(value, fallback = DEFAULT_PERSONA_API_URL) {
  const trimmed = String(value || "").trim();
  return trimmed || fallback;
}

export function createDefaultPersonaDialogueSettings(env = process.env) {
  const envConfig = getPersonaDialogueConfig(env);
  return {
    enabled: envConfig.enabled,
    apiKey: "",
    model: envConfig.model,
    apiUrl: envConfig.apiUrl,
    timeoutMs: envConfig.timeoutMs,
  };
}

export function normalizePersonaDialogueSettings(input = {}, fallback = createDefaultPersonaDialogueSettings()) {
  const next = input && typeof input === "object" ? input : {};
  return {
    enabled: typeof next.enabled === "boolean" ? next.enabled : fallback.enabled,
    apiKey: typeof next.apiKey === "string" ? next.apiKey.trim() : fallback.apiKey,
    model: typeof next.model === "string" && next.model.trim() ? next.model.trim() : fallback.model,
    apiUrl: normalizeApiUrl(next.apiUrl, fallback.apiUrl),
    timeoutMs:
      Number.isFinite(Number(next.timeoutMs)) && Number(next.timeoutMs) > 0
        ? Number(next.timeoutMs)
        : fallback.timeoutMs,
  };
}

export function resolvePersonaDialogueConfig(settings = {}, env = process.env) {
  const envConfig = getPersonaDialogueConfig(env);
  const normalized = normalizePersonaDialogueSettings(
    settings,
    createDefaultPersonaDialogueSettings(env),
  );
  const apiKey = normalized.apiKey || envConfig.apiKey;

  return {
    enabled: Boolean(normalized.enabled && apiKey),
    apiKey,
    apiUrl: normalizeApiUrl(normalized.apiUrl, envConfig.apiUrl),
    model: normalized.model || envConfig.model,
    timeoutMs: normalized.timeoutMs || envConfig.timeoutMs,
    configured: Boolean(apiKey),
  };
}

export function buildPersonaDialoguePrompt(input = {}) {
  const category = firstLine(input.category || "idle");
  const project = truncate(input.project || "", 80);
  const task = truncate(input.task || "", 100);
  const rawType = firstLine(input.rawType || input.eventType || "");
  const message = truncate(input.message || "", 120);

  const hints = {
    idle: "当前没有新事件，像在工位边轻声自言自语。",
    request: "刚收到新请求，像接住一件新事情时的短句反应。",
    success: "刚完成一步，像轻松确认进展的短句。",
    error: "刚遇到异常或失败，像稳住节奏时的短句。",
    disconnect: "连接刚断开，像盯着链路时的短句。",
    reconnect: "连接刚恢复，像重新接上节奏时的短句。",
    thinking: "像短暂思考时的喃喃自语。",
    working: "像继续盯着手头工作的短句。",
  };

  const contextLines = [
    category ? `场景: ${category}` : "",
    rawType ? `事件类型: ${rawType}` : "",
    project ? `项目: ${project}` : "",
    task ? `任务: ${task}` : "",
    message ? `事实描述: ${message}` : "",
  ].filter(Boolean);

  return [
    "请为一个桌面 Live2D 桌宠生成一句中文闲聊台词。",
    "要求:",
    "1. 只输出一句中文，不要解释，不要引号，不要 markdown。",
    "2. 长度控制在 10 到 28 个汉字，尽量自然，像 backstage 员工口吻，但不要提“办公室世界观”设定。",
    "3. 语气要像一个冷静、靠谱、轻微吐槽感的同伴，不要太夸张，不要卖萌。",
    "4. 只能说主观短句，不能编造工具结果、文件路径或未提供的事实。",
    "5. 如果上下文信息很少，也只输出一句泛化但自然的话。",
    hints[category] ? `场景提示: ${hints[category]}` : "",
    contextLines.length > 0 ? `上下文:\n${contextLines.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function sanitizePersonaDialogueText(text, fallback = "") {
  const codeBlockCollapsed = String(text || "").replace(
    /```(?:\w+)?\n?([\s\S]*?)```/g,
    (_match, inner = "") => ` ${inner} `,
  );
  const normalized = codeBlockCollapsed
    .replace(/\s+/g, " ")
    .trim();

  const first = (normalized.split("\n")[0]?.trim() || "").replace(
    /^["'“”‘’]+|["'“”‘’]+$/g,
    "",
  );
  if (!first) return firstLine(fallback);

  const stripped = first
    .replace(/^答[:：]\s*/, "")
    .replace(/^输出[:：]\s*/, "")
    .trim();

  const limited = stripped.length > 48 ? `${stripped.slice(0, 47)}…` : stripped;
  return limited || firstLine(fallback);
}
