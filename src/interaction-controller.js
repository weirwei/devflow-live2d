function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class InteractionController {
  constructor(options = {}) {
    this.target = options.target || null;
    this.onState = typeof options.onState === "function" ? options.onState : () => {};
    this.maxTilt = Number.isFinite(options.maxTilt) ? options.maxTilt : 10;
    this.maxPointer = Number.isFinite(options.maxPointer) ? options.maxPointer : 1;
    this.lastState = {
      pointerX: 0,
      pointerY: 0,
      tiltX: 0,
      tiltY: 0,
      hover: false,
    };
    this.boundMove = (event) => this.handlePointerMove(event);
    this.boundLeave = () => this.handlePointerLeave();
    this.boundEnter = () => this.handlePointerEnter();
    this.boundClick = (event) => this.handleClick(event);
  }

  mount() {
    if (!this.target) return;
    this.target.addEventListener("pointermove", this.boundMove);
    this.target.addEventListener("pointerleave", this.boundLeave);
    this.target.addEventListener("pointerenter", this.boundEnter);
    this.target.addEventListener("click", this.boundClick);
  }

  unmount() {
    if (!this.target) return;
    this.target.removeEventListener("pointermove", this.boundMove);
    this.target.removeEventListener("pointerleave", this.boundLeave);
    this.target.removeEventListener("pointerenter", this.boundEnter);
    this.target.removeEventListener("click", this.boundClick);
  }

  update(next = {}) {
    this.lastState = { ...this.lastState, ...next };
    this.onState(this.lastState);
  }

  handlePointerEnter() {
    this.update({ hover: true });
  }

  handlePointerLeave() {
    this.update({
      pointerX: 0,
      pointerY: 0,
      tiltX: 0,
      tiltY: 0,
      hover: false,
    });
  }

  handlePointerMove(event) {
    if (!this.target) return;
    const rect = this.target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const normalizedX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const normalizedY = ((event.clientY - rect.top) / rect.height) * 2 - 1;

    const pointerX = clamp(normalizedX, -this.maxPointer, this.maxPointer);
    const pointerY = clamp(normalizedY, -this.maxPointer, this.maxPointer);
    const tiltY = clamp(pointerX * this.maxTilt, -this.maxTilt, this.maxTilt);
    const tiltX = clamp(pointerY * -this.maxTilt, -this.maxTilt, this.maxTilt);

    this.update({ pointerX, pointerY, tiltX, tiltY, hover: true });
  }

  handleClick(event) {
    if (!this.target) return;
    const customEvent = new CustomEvent("avatar-interaction", {
      detail: {
        type: "click",
        clientX: event.clientX,
        clientY: event.clientY,
      },
    });
    this.target.dispatchEvent(customEvent);
  }
}
