const STATUS_MOTION = {
  calm: "idleWave",
  attentive: "acknowledge",
  alert: "greet",
  focus: "workLoop",
  thinking: "ponder",
  happy: "celebrate",
};

function moodFromTaskStatus(status) {
  if (["doing", "in_progress", "running", "active"].includes(status)) return "focus";
  if (["done", "completed", "success"].includes(status)) return "happy";
  if (["todo", "queued", "pending"].includes(status)) return "attentive";
  return "attentive";
}

function emotionFromKind(kind, taskStatus) {
  if (kind === "request") return "alert";
  if (kind === "task") return moodFromTaskStatus(taskStatus);
  if (kind === "work") return "focus";
  if (kind === "thinking") return "thinking";
  if (kind === "work-result") return "happy";
  if (kind === "usage") return "attentive";
  if (kind === "error") return "alert";
  if (kind === "dialogue") return "calm";
  return "calm";
}

export function createInitialAvatarState() {
  return {
    mood: "calm",
    motion: STATUS_MOTION.calm,
    expression: "calm",
    task: "",
    lastEventType: "bootstrap",
    source: "bootstrap",
    updatedAt: Date.now(),
  };
}

export function reduceNormalizedEvent(previousState, event) {
  const base = previousState || createInitialAvatarState();
  const mood = emotionFromKind(event.kind, event.task.status);
  const nextTask = event.task.title || base.task;

  return {
    ...base,
    mood,
    motion: STATUS_MOTION[mood] || STATUS_MOTION.calm,
    expression: mood,
    task: nextTask,
    lastEventType: event.rawType,
    source: event.source,
    updatedAt: event.timestamp || Date.now(),
  };
}
