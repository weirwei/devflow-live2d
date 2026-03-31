export const DEFAULT_PERSONA_MODEL = process.env.DEVFLOW_DIALOGUE_MODEL?.trim() || "gpt-5-mini";
export const DEFAULT_PERSONA_API_URL =
  process.env.DEVFLOW_DIALOGUE_API_URL?.trim() || "https://api.openai.com/v1/chat/completions";
export const DEFAULT_PERSONA_TIMEOUT_MS = 30_000;
export const PERSONA_PROVIDERS = ["openai-compatible"];

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

function normalizeProvider(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  return PERSONA_PROVIDERS.includes(trimmed) ? trimmed : "openai-compatible";
}

export function createDefaultPersonaDialogueSettings(env = process.env) {
  const envConfig = getPersonaDialogueConfig(env);
  return {
    enabled: envConfig.enabled,
    provider: "openai-compatible",
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
    provider: normalizeProvider(next.provider || fallback.provider),
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
  const provider = normalized.provider;
  const apiKey = normalized.apiKey || envConfig.apiKey;
  const configured = Boolean(apiKey);

  return {
    enabled: Boolean(normalized.enabled && configured),
    provider,
    apiKey,
    apiUrl: normalizeApiUrl(normalized.apiUrl, envConfig.apiUrl),
    model: normalized.model || envConfig.model,
    timeoutMs: normalized.timeoutMs || envConfig.timeoutMs,
    configured,
  };
}

export function buildPersonaDialoguePrompt(input = {}) {
  const category = firstLine(input.category || "idle");
  const project = truncate(input.project || "", 80);
  const task = truncate(input.task || "", 100);
  const rawType = firstLine(input.rawType || input.eventType || "");
  const message = truncate(input.message || "", 120);

  const hints = {
    idle: "当前没有新事件，像无聊到快融化、东张西望找乐子的样子。",
    request: "刚收到新请求，像被突然叫去干活、痛苦但又不得不爬起来的反应。",
    success: "刚完成一步，像得意洋洋想邀功的小表情。",
    error: "刚遇到异常或失败，像踩到坑之后委屈巴巴但又不服气。",
    disconnect: "连接刚断开，像突然掉线、慌张又搞笑的反应。",
    reconnect: "连接刚恢复，像失而复得、大喜过望的样子。",
    thinking: "像歪头思考时冒出的奇怪脑洞。",
    working: "像埋头干活时忍不住碎碎念吐槽的样子。",
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
    "2. 长度控制在 10 到 28 个汉字，尽量自然口语化。",
    "3. 语气要像一个古灵精怪、爱搞怪、偶尔犯傻但很可爱的小伙伴，可以用夸张的语气、颜文字风格的表达、无厘头的吐槽，但不要太油腻。",
    "4. 只能说主观短句，不能编造工具结果、文件路径或未提供的事实。",
    "5. 如果上下文信息很少，也只输出一句搞怪但自然的话。",
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
