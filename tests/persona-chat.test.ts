import { describe, expect, it } from "bun:test";
import { DialogueQueue } from "../src/dialogue-queue.js";
import {
  PERSONA_EVENT_COOLDOWN_MS,
  PERSONA_IDLE_COOLDOWN_MS,
  PERSONA_IDLE_THRESHOLD_MS,
  PersonaChatController,
  buildPersonaRequestContext,
} from "../src/dialogue/persona-chat.js";
import {
  buildPersonaDialoguePrompt,
  getPersonaDialogueConfig,
  parsePersonaDialogueLines,
  pickRandomMood,
  sanitizePersonaDialogueText,
} from "../src/dialogue/persona-ai.js";

function createClock(start = 100_000) {
  let now = start;
  return {
    now: () => now,
    set(value: number) {
      now = value;
    },
    advance(delta: number) {
      now += delta;
    },
  };
}

describe("PersonaChatController", () => {
  it("emits idle chatter after the idle threshold", () => {
    const clock = createClock();
    const controller = new PersonaChatController({
      now: clock.now,
      rng: () => 0,
    });

    controller.handleEvent({ rawType: "connected" }, { now: clock.now(), isConnected: true, canSpeak: true });
    controller.handleEvent(
      { rawType: "task.updated", timestamp: clock.now() },
      { now: clock.now(), isConnected: true, canSpeak: true },
    );

    clock.advance(PERSONA_IDLE_THRESHOLD_MS - 1);
    expect(controller.tick({ now: clock.now(), isConnected: true, canSpeak: true })).toBeNull();

    clock.advance(1);
    const persona = controller.tick({ now: clock.now(), isConnected: true, canSpeak: true });
    expect(persona?.category).toBe("idle");
    expect(persona?.channel).toBe("persona");
  });

  it("respects idle cooldown and resets idle timer on real events", () => {
    const clock = createClock();
    const controller = new PersonaChatController({
      now: clock.now,
      rng: () => 0,
    });

    controller.handleEvent({ rawType: "connected" }, { now: clock.now(), isConnected: true, canSpeak: true });
    controller.handleEvent({ rawType: "task.updated" }, { now: clock.now(), isConnected: true, canSpeak: true });

    clock.advance(PERSONA_IDLE_THRESHOLD_MS);
    expect(controller.tick({ now: clock.now(), isConnected: true, canSpeak: true })?.category).toBe("idle");

    clock.advance(PERSONA_IDLE_COOLDOWN_MS - 1);
    expect(controller.tick({ now: clock.now(), isConnected: true, canSpeak: true })).toBeNull();

    controller.handleEvent({ rawType: "tool.started" }, { now: clock.now(), isConnected: true, canSpeak: true });
    clock.advance(PERSONA_IDLE_THRESHOLD_MS - 1);
    expect(controller.tick({ now: clock.now(), isConnected: true, canSpeak: true })).toBeNull();
  });

  it("does not emit persona lines while speaking is blocked", () => {
    const clock = createClock();
    const controller = new PersonaChatController({
      now: clock.now,
      rng: () => 0,
    });

    controller.handleEvent({ rawType: "connected" }, { now: clock.now(), isConnected: true, canSpeak: true });
    const blocked = controller.handleEvent(
      { rawType: "tool.completed" },
      { now: clock.now(), isConnected: true, canSpeak: false },
    );

    expect(blocked).toBeNull();
    clock.advance(PERSONA_EVENT_COOLDOWN_MS);
    const allowed = controller.handleEvent(
      { rawType: "tool.completed" },
      { now: clock.now(), isConnected: true, canSpeak: true },
    );
    expect(allowed?.category).toBe("success");
  });

  it("emits disconnect once and reconnect after connection recovers", () => {
    const clock = createClock();
    const controller = new PersonaChatController({
      now: clock.now,
      rng: () => 0,
    });

    controller.handleEvent({ rawType: "connected" }, { now: clock.now(), isConnected: true, canSpeak: true });

    const disconnect = controller.handleEvent(
      { rawType: "disconnect" },
      { now: clock.now(), isConnected: false, canSpeak: true },
    );
    expect(disconnect?.category).toBe("disconnect");

    const immediateReconnect = controller.handleEvent(
      { rawType: "connected" },
      { now: clock.now(), isConnected: true, canSpeak: true },
    );
    expect(immediateReconnect).toBeNull();

    clock.advance(PERSONA_EVENT_COOLDOWN_MS);
    const secondDisconnect = controller.handleEvent(
      { rawType: "disconnect" },
      { now: clock.now(), isConnected: false, canSpeak: true },
    );
    expect(secondDisconnect?.category).toBe("disconnect");

    clock.advance(PERSONA_EVENT_COOLDOWN_MS);
    const reconnect = controller.handleEvent(
      { rawType: "connected" },
      { now: clock.now(), isConnected: true, canSpeak: true },
    );
    expect(reconnect?.category).toBe("reconnect");
  });

  it("does not repeat the same line twice in a row when a pool has alternatives", () => {
    const clock = createClock();
    let rngValue = 0;
    const controller = new PersonaChatController({
      now: clock.now,
      rng: () => rngValue,
    });

    controller.handleEvent({ rawType: "connected" }, { now: clock.now(), isConnected: true, canSpeak: true });

    const first = controller.handleEvent(
      { rawType: "request.created" },
      { now: clock.now(), isConnected: true, canSpeak: true },
    );

    clock.advance(PERSONA_EVENT_COOLDOWN_MS);
    rngValue = 0;
    const second = controller.handleEvent(
      { rawType: "request.created" },
      { now: clock.now(), isConnected: true, canSpeak: true },
    );

    expect(first?.text).toBeTruthy();
    expect(second?.text).toBeTruthy();
    expect(second?.text).not.toBe(first?.text);
  });
});

describe("DialogueQueue", () => {
  it("reports busy state and channel occupancy for current and pending items", () => {
    const queue = new DialogueQueue({ defaultDurationMs: 10_000 });

    expect(queue.isBusy()).toBe(false);
    expect(queue.hasChannel("dialogue")).toBe(false);

    queue.enqueue({ text: "assistant line", channel: "dialogue" });
    queue.enqueue({ text: "persona line", channel: "persona" });

    expect(queue.isBusy()).toBe(true);
    expect(queue.hasPending()).toBe(true);
    expect(queue.hasChannel("dialogue")).toBe(true);
    expect(queue.hasChannel("persona")).toBe(true);

    queue.clear();
    expect(queue.isBusy()).toBe(false);
    expect(queue.hasPending()).toBe(false);
    expect(queue.hasChannel("dialogue")).toBe(false);
  });
});

describe("persona AI helpers", () => {
  it("builds prompt context from persona and event data", () => {
    const payload = buildPersonaRequestContext(
      {
        category: "success",
        text: "这步收住了，节奏不错。",
      },
      {
        rawType: "tool.completed",
        message: "Updated the overlay queue.",
        project: "devflow-live2d",
        task: { title: "Ship persona chat" },
      },
    );

    expect(payload).toEqual({
      category: "success",
      fallbackText: "这步收住了，节奏不错。",
      rawType: "tool.completed",
      message: "Updated the overlay queue.",
      project: "devflow-live2d",
      task: "Ship persona chat",
      recentContext: "",
    });
  });

  it("builds a compact Chinese prompt for AI dialogue", () => {
    const prompt = buildPersonaDialoguePrompt({
      category: "idle",
      project: "devflow-live2d",
      task: "Ship persona chat",
      message: "No new protocol events",
    });

    expect(prompt).toContain("2~3 句中文闲聊台词");
    expect(prompt).toContain("场景: idle");
    expect(prompt).toContain("项目: devflow-live2d");
    expect(prompt).toContain("任务: Ship persona chat");
  });

  it("sanitizes noisy model output into a single short line", () => {
    const text = sanitizePersonaDialogueText('```txt\n"先把这段节奏稳住。"\n```', "fallback");
    expect(text).toBe("先把这段节奏稳住。");
  });

  it("falls back to provided text when model output is empty", () => {
    const text = sanitizePersonaDialogueText("", "先待命。");
    expect(text).toBe("先待命。");
  });

  it("reads AI config from environment without exposing enablement by default", () => {
    const disabled = getPersonaDialogueConfig({});
    expect(disabled.enabled).toBe(false);

    const enabled = getPersonaDialogueConfig({
      OPENAI_API_KEY: "test-key",
      DEVFLOW_DIALOGUE_MODEL: "gpt-5.1-mini",
      DEVFLOW_DIALOGUE_TIMEOUT_MS: "4000",
    });

    expect(enabled.enabled).toBe(true);
    expect(enabled.model).toBe("gpt-5.1-mini");
    expect(enabled.timeoutMs).toBe(4000);
  });

  it("parses multi-line JSON response into lines array", () => {
    const lines = parsePersonaDialogueLines(
      '{"lines":["好无聊啊","要不摸会鱼","算了还是干活吧"]}',
    );
    expect(lines).toEqual(["好无聊啊", "要不摸会鱼", "算了还是干活吧"]);
  });

  it("extracts JSON from noisy model output", () => {
    const lines = parsePersonaDialogueLines(
      'Sure! Here is the output:\n{"lines":["搞定了","给自己鼓个掌"]}\n',
    );
    expect(lines).toEqual(["搞定了", "给自己鼓个掌"]);
  });

  it("falls back to single line when response is plain text", () => {
    const lines = parsePersonaDialogueLines("好无聊啊想吃零食", "fallback");
    expect(lines).toEqual(["好无聊啊想吃零食"]);
  });

  it("uses fallback when response is empty", () => {
    const lines = parsePersonaDialogueLines("", "先待命。");
    expect(lines).toEqual(["先待命。"]);
  });

  it("limits output to 3 lines max", () => {
    const lines = parsePersonaDialogueLines(
      '{"lines":["一","二","三","四","五"]}',
    );
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("pickRandomMood returns a string", () => {
    const mood = pickRandomMood(() => 0.5);
    expect(typeof mood).toBe("string");
    expect(mood.length).toBeGreaterThan(0);
  });

  it("prompt includes mood and multi-line instruction", () => {
    const prompt = buildPersonaDialoguePrompt({
      category: "success",
      mood: "突然亢奋",
    });
    expect(prompt).toContain("当前情绪: 突然亢奋");
    expect(prompt).toContain("2~3 句中文闲聊台词");
    expect(prompt).toContain('"lines"');
  });
});
