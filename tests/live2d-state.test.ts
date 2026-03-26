import { describe, expect, it } from "bun:test";
import {
  createInitialAvatarState,
  reduceNormalizedEvent,
} from "../src/avatar/avatarState.js";
import { getLive2DModelById } from "../src/live2d-model-catalog.js";
import { splitAssistantMessage } from "../src/bubble-text.js";
import { normalizeProtocolEvent } from "../src/event-mapping/normalizeEvent.js";
import { deriveStatusBubble } from "../src/status-bubble.js";
import {
  createCenteredWindowBounds,
  normalizeWindowBounds,
  resolveWindowBounds,
} from "../src/app/window-bounds.js";
import {
  AVATAR_INTERRUPT_HOLD_MS,
  resolveAvatarInterrupt,
  shouldHoldAvatarState,
} from "../src/avatar/interruptPolicy.js";

describe("normalizeProtocolEvent", () => {
  it("normalizes protocol task events into desktop-friendly shape", () => {
    const normalized = normalizeProtocolEvent({
      eventType: "task.updated",
      source: "codex-bridge",
      timestamp: "2026-03-24T21:00:00.000Z",
      task: {
        id: "task-1",
        subject: "Ship desktop overlay",
        status: "in_progress",
      },
      payload: {
        message: "Task is running.",
      },
    });

    expect(normalized.kind).toBe("task");
    expect(normalized.task.title).toBe("Ship desktop overlay");
    expect(normalized.task.status).toBe("in_progress");
  });

  it("extracts project from protocol payload", () => {
    const normalized = normalizeProtocolEvent({
      eventType: "task.updated",
      source: "codex-bridge",
      payload: {
        project: "backstage/devflow-live2d",
      },
    });

    expect(normalized.project).toBe("backstage/devflow-live2d");
  });
});

describe("avatar state projection", () => {
  it("moves to focus for active task events", () => {
    const initial = createInitialAvatarState();
    const normalized = normalizeProtocolEvent({
      eventType: "task.updated",
      source: "codex-bridge",
      timestamp: "2026-03-24T21:00:00.000Z",
      task: {
        id: "task-1",
        subject: "Ship desktop overlay",
        status: "in_progress",
      },
    });

    const next = reduceNormalizedEvent(initial, normalized);
    expect(next.mood).toBe("focus");
    expect(next.motion).toBe("workLoop");
    expect(next.task).toBe("Ship desktop overlay");
  });

  it("emits a success-toned bubble for tool completion", () => {
    const normalized = normalizeProtocolEvent({
      eventType: "tool.completed",
      source: "codex-bridge",
      timestamp: "2026-03-24T21:00:00.000Z",
      payload: {
        message: "Tool finished successfully.",
      },
    });

    const bubble = deriveStatusBubble(normalized);
    expect(bubble.tone).toBe("success");
    expect(bubble.text).toBe("Tool finished successfully.");
  });

  it("treats assistant messages as dialogue bubbles", () => {
    const normalized = normalizeProtocolEvent({
      eventType: "assistant.message",
      source: "codex",
      payload: {
        summary: "I verified the overlay is connected.",
      },
    });

    const bubble = deriveStatusBubble(normalized);
    expect(normalized.kind).toBe("dialogue");
    expect(bubble).toBeNull();
  });

  it("shows raw detail for task updates when available", () => {
    const normalized = normalizeProtocolEvent({
      eventType: "task.updated",
      source: "codex",
      task: {
        id: "task-1",
        subject: "Very long internal task title",
        status: "in_progress",
      },
      payload: {
        summary: "Verbose internal task detail that should not be shown.",
      },
    });

    const bubble = deriveStatusBubble(normalized);
    expect(bubble.text).toBe(
      "Verbose internal task detail that should not be shown. · Very long internal task title",
    );
  });
});

describe("model behavior preview mapping", () => {
  it("maps shared motion keys to model-specific motion and expression names", () => {
    const natori = getLive2DModelById("natori");
    const hiyori = getLive2DModelById("hiyori");

    expect(natori.motions.celebrate).toBe("TapBody");
    expect(natori.expressions.happy).toBe("Smile");
    expect(hiyori.motions.acknowledge).toBe("TapBody");
    expect(hiyori.expressions.happy).toBeUndefined();
  });
});

describe("avatar interrupt policy", () => {
  it("treats request, success, and error events as strong interrupts", () => {
    expect(shouldHoldAvatarState({ kind: "request" })).toBe(true);
    expect(shouldHoldAvatarState({ kind: "work-result" })).toBe(true);
    expect(shouldHoldAvatarState({ kind: "error" })).toBe(true);
    expect(shouldHoldAvatarState({ kind: "task" })).toBe(false);
  });

  it("holds weak events while a strong interrupt is active", () => {
    const now = 1_000;
    const strongDecision = resolveAvatarInterrupt(null, { kind: "request" }, now);
    const weakDecision = resolveAvatarInterrupt(strongDecision.guard, { kind: "task" }, now + 200);

    expect(strongDecision.apply).toBe(true);
    expect(strongDecision.guard.until).toBe(now + AVATAR_INTERRUPT_HOLD_MS);
    expect(weakDecision.apply).toBe(false);
    expect(weakDecision.guard).toEqual(strongDecision.guard);
  });

  it("allows weak events again after the hold window expires", () => {
    const expiredGuard = {
      kind: "request",
      until: 2_000,
    };

    const decision = resolveAvatarInterrupt(expiredGuard, { kind: "task" }, 2_001);
    expect(decision.apply).toBe(true);
    expect(decision.guard).toBeNull();
  });
});

describe("assistant bubble paging", () => {
  it("splits long assistant text into multiple pages", () => {
    const pages = splitAssistantMessage(
      "This is a long assistant message that should be split into more than one bubble page so the content can continue naturally without being clipped by the UI frame.",
      60,
    );

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join(" ")).toContain("This is a long assistant message");
  });
});

describe("window bounds persistence", () => {
  it("keeps saved bounds when they remain visible on a display", () => {
    const savedBounds = {
      x: 120,
      y: 80,
      width: 500,
      height: 760,
    };

    const resolved = resolveWindowBounds(savedBounds, {
      primaryWorkArea: { x: 0, y: 0, width: 1440, height: 900 },
      workAreas: [{ x: 0, y: 0, width: 1440, height: 900 }],
    });

    expect(resolved).toEqual(savedBounds);
  });

  it("falls back to centered bounds when saved bounds are off-screen", () => {
    const resolved = resolveWindowBounds(
      { x: 4000, y: 3000, width: 420, height: 720 },
      {
        primaryWorkArea: { x: 100, y: 50, width: 1600, height: 1000 },
        workAreas: [{ x: 100, y: 50, width: 1600, height: 1000 }],
      },
    );

    expect(resolved).toEqual(
      createCenteredWindowBounds({ x: 100, y: 50, width: 1600, height: 1000 }),
    );
  });

  it("normalizes invalid bounds values into safe ranges", () => {
    const normalized = normalizeWindowBounds(
      { x: "30", y: "bad", width: 120, height: 5000 },
      { x: 0, y: 20, width: 420, height: 720 },
    );

    expect(normalized).toEqual({
      x: 30,
      y: 20,
      width: 320,
      height: 1800,
    });
  });
});
