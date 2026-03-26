export class DialogueQueue {
  constructor(options = {}) {
    this.maxSize = Number.isFinite(options.maxSize) ? options.maxSize : 30;
    this.defaultDurationMs = Number.isFinite(options.defaultDurationMs)
      ? options.defaultDurationMs
      : 3800;
    this.items = [];
    this.listeners = new Set();
    this.currentTimer = null;
    this.currentItem = null;
  }

  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    listener(this.currentItem);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) {
      listener(this.currentItem);
    }
  }

  enqueue(item, options = {}) {
    if (!item || typeof item.text !== "string") return;
    const text = item.text.trim();
    if (!text) return;

    const durationMs = Number.isFinite(options.durationMs)
      ? options.durationMs
      : this.defaultDurationMs;

    this.items.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text,
      tone: item.tone || "neutral",
      channel: item.channel || "system",
      durationMs,
      createdAt: Date.now(),
    });

    if (this.items.length > this.maxSize) {
      this.items.splice(0, this.items.length - this.maxSize);
    }

    if (!this.currentItem) {
      this.shift();
    }
  }

  shift() {
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }

    const next = this.items.shift() || null;
    this.currentItem = next;
    this.emit();

    if (!next) return;

    this.currentTimer = setTimeout(() => {
      this.currentTimer = null;
      this.shift();
    }, next.durationMs);
  }
}
