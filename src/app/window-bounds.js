const DEFAULT_OVERLAY_WIDTH = 420;
const DEFAULT_OVERLAY_HEIGHT = 720;
const WINDOW_MIN_WIDTH = 320;
const WINDOW_MIN_HEIGHT = 420;
const WINDOW_MAX_WIDTH = 1400;
const WINDOW_MAX_HEIGHT = 1800;
const WINDOW_COORD_LIMIT = 10000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function safeNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function toRect(input = {}, fallback = {}) {
  return {
    x: Number.isFinite(Number(input.x)) ? Number(input.x) : fallback.x ?? 0,
    y: Number.isFinite(Number(input.y)) ? Number(input.y) : fallback.y ?? 0,
    width: Math.max(
      0,
      Number.isFinite(Number(input.width)) ? Number(input.width) : fallback.width ?? 0,
    ),
    height: Math.max(
      0,
      Number.isFinite(Number(input.height)) ? Number(input.height) : fallback.height ?? 0,
    ),
  };
}

export function normalizeWindowBounds(input = null, fallback = null) {
  if (!input || typeof input !== "object") {
    return fallback ? { ...fallback } : null;
  }

  const base = fallback ?? {
    x: 0,
    y: 0,
    width: DEFAULT_OVERLAY_WIDTH,
    height: DEFAULT_OVERLAY_HEIGHT,
  };

  return {
    x: safeNumber(input.x, base.x, -WINDOW_COORD_LIMIT, WINDOW_COORD_LIMIT),
    y: safeNumber(input.y, base.y, -WINDOW_COORD_LIMIT, WINDOW_COORD_LIMIT),
    width: safeNumber(input.width, base.width, WINDOW_MIN_WIDTH, WINDOW_MAX_WIDTH),
    height: safeNumber(input.height, base.height, WINDOW_MIN_HEIGHT, WINDOW_MAX_HEIGHT),
  };
}

export function createCenteredWindowBounds(workArea = {}) {
  const rect = toRect(workArea, {
    x: 0,
    y: 0,
    width: DEFAULT_OVERLAY_WIDTH,
    height: DEFAULT_OVERLAY_HEIGHT,
  });

  return {
    width: DEFAULT_OVERLAY_WIDTH,
    height: DEFAULT_OVERLAY_HEIGHT,
    x: Math.round(rect.x + (rect.width - DEFAULT_OVERLAY_WIDTH) / 2),
    y: Math.round(rect.y + (rect.height - DEFAULT_OVERLAY_HEIGHT) / 2),
  };
}

export function rectanglesIntersect(left, right) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

export function isWindowBoundsVisible(bounds, workAreas = []) {
  if (!bounds) return false;
  if (!Array.isArray(workAreas) || workAreas.length === 0) return true;

  return workAreas.some((workArea) =>
    rectanglesIntersect(bounds, toRect(workArea, bounds)),
  );
}

export function resolveWindowBounds(savedBounds, options = {}) {
  const { primaryWorkArea = {}, workAreas = [] } = options;
  const fallback = createCenteredWindowBounds(primaryWorkArea);
  const candidate = normalizeWindowBounds(savedBounds, fallback);
  if (!candidate) return fallback;
  return isWindowBoundsVisible(candidate, workAreas) ? candidate : fallback;
}

export function sameWindowBounds(left, right) {
  if (!left || !right) return left === right;
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
