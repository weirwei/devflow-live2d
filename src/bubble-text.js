export const BUBBLE_TEXT_MAX_CHARS = 105;

export function splitAssistantMessage(text, maxLength = BUBBLE_TEXT_MAX_CHARS) {
  if (typeof text !== "string") return [];
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const parts = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < Math.floor(maxLength * 0.5)) {
      cut = maxLength;
    }

    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}
