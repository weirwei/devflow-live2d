function mapBubbleTone(kind) {
  if (kind === "error") return "warning";
  if (kind === "work-result") return "success";
  if (kind === "request") return "alert";
  if (kind === "thinking") return "thinking";
  if (kind === "usage") return "neutral";
  return "neutral";
}

export function deriveStatusBubble(event) {
  if (!event || event.rawType === "assistant.message") {
    return null;
  }

  const parts = [];
  for (const value of [event.message, event.task?.title, event.task?.detail]) {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) continue;
    if (parts.includes(text)) continue;
    parts.push(text);
  }

  if (parts.length === 0) {
    const fallback = typeof event.rawType === "string" ? event.rawType.trim() : "";
    if (!fallback) {
      return null;
    }
    parts.push(fallback);
  }

  return {
    text: parts.join(" · "),
    tone: mapBubbleTone(event.kind),
    channel: event.kind || "system",
  };
}
