import { describe, expect, it } from "bun:test";
import {
  createInitialAvatarState,
  eventToBubble,
  reduceNormalizedEvent,
} from "../src/avatar-state.js";
import { normalizeProtocolEvent } from "../src/event-mapping/normalizeEvent.js";

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

    const bubble = eventToBubble(normalized);
    expect(bubble.tone).toBe("success");
    expect(bubble.text).toBe("任务已完成。");
  });

  it("treats assistant messages as dialogue bubbles", () => {
    const normalized = normalizeProtocolEvent({
      eventType: "assistant.message",
      source: "codex",
      payload: {
        summary: "I verified the overlay is connected.",
      },
    });

    const bubble = eventToBubble(normalized);
    expect(normalized.kind).toBe("dialogue");
    expect(bubble.channel).toBe("dialogue");
    expect(bubble.text).toContain("connected");
  });

  it("uses fixed copy for task updates instead of raw payload details", () => {
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

    const bubble = eventToBubble(normalized);
    expect(bubble.text).toBe("任务有更新。");
  });
});
