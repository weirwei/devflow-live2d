export const AVATAR_INTERRUPT_HOLD_MS = 1600;

const STRONG_EVENT_KINDS = new Set(["request", "work-result", "error"]);

export function shouldHoldAvatarState(event) {
  return STRONG_EVENT_KINDS.has(String(event?.kind || "").trim().toLowerCase());
}

export function resolveAvatarInterrupt(activeGuard, event, now = Date.now()) {
  const guardActive = activeGuard && Number.isFinite(activeGuard.until) && activeGuard.until > now;
  const strongEvent = shouldHoldAvatarState(event);

  if (strongEvent) {
    return {
      apply: true,
      guard: {
        kind: event.kind,
        until: now + AVATAR_INTERRUPT_HOLD_MS,
      },
    };
  }

  if (guardActive) {
    return {
      apply: false,
      guard: activeGuard,
    };
  }

  return {
    apply: true,
    guard: null,
  };
}
