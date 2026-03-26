import { createRuntime, registerRuntime } from "./runtime-registry.js";

function renderMockFace(container, avatarState) {
  const eyes = container.querySelector("[data-avatar-eyes]");
  const mouth = container.querySelector("[data-avatar-mouth]");
  const badge = container.querySelector("[data-avatar-badge]");

  if (eyes) {
    const eyeMap = {
      calm: "◕ ◕",
      attentive: "• •",
      alert: "⊙ ⊙",
      focus: "⌐■ ■",
      thinking: "◔ ◔",
      happy: "^ ^",
    };
    eyes.textContent = eyeMap[avatarState.expression] || eyeMap.calm;
  }

  if (mouth) {
    const mouthMap = {
      calm: "﹏",
      attentive: "–",
      alert: "o",
      focus: "_",
      thinking: "~",
      happy: "ᴗ",
    };
    mouth.textContent = mouthMap[avatarState.expression] || mouthMap.calm;
  }

  if (badge) {
    badge.textContent = avatarState.motion || "idleWave";
  }
}

registerRuntime("mock", async ({ container }) => {
  return {
    async setAvatarState(avatarState) {
      container.dataset.mood = avatarState.mood;
      container.dataset.motion = avatarState.motion;
      renderMockFace(container, avatarState);
    },
    async playMotion(groupName, index = 0) {
      const previewName = `${groupName}:${index}`;
      container.dataset.motion = previewName;
      renderMockFace(container, {
        mood: container.dataset.mood || "calm",
        expression: container.dataset.mood || "calm",
        motion: previewName,
      });
    },
    destroy() {},
  };
});

registerRuntime("external-official", async ({ container, manifest }) => {
  const adapterFactory =
    window.DevflowLive2DOfficialAdapter || window.BackstageLive2DOfficialAdapter;
  if (typeof adapterFactory !== "function") {
    throw new Error(
      "No official Live2D adapter is available. Load a valid adapter script in manifest.sdk.adapterScript.",
    );
  }

  const delegate = await adapterFactory({ container, manifest });
  if (!delegate || typeof delegate.setState !== "function") {
    throw new Error("Official adapter must return { setState(state) }.");
  }

  return {
    async setAvatarState(avatarState) {
      container.dataset.mood = avatarState.mood;
      container.dataset.motion = avatarState.motion;
      await delegate.setState(avatarState);
    },
    async playMotion(groupName, index = 0) {
      const previewName = `${groupName}:${index}`;
      container.dataset.motion = previewName;
      if (typeof delegate.playMotion === "function") {
        await delegate.playMotion(groupName, index);
        return;
      }
      await delegate.setState({
        mood: container.dataset.mood || "calm",
        expression: container.dataset.mood || "calm",
        motion: previewName,
      });
    },
    destroy() {
      if (typeof delegate.destroy === "function") {
        delegate.destroy();
      }
    },
  };
});

export class Live2DAdapter {
  constructor(options = {}) {
    this.container = options.container || null;
    this.runtime = null;
  }

  async initialize({ runtimeId, manifest, interactionState }) {
    if (!this.container) {
      throw new Error("Live2DAdapter requires a target container.");
    }
    this.runtime = await createRuntime(runtimeId, {
      container: this.container,
      manifest,
      interactionState,
    });
  }

  async setState({ avatarState, interactionState }) {
    if (!this.runtime) return;
    await this.runtime.setAvatarState(avatarState, interactionState);
    if (typeof this.runtime.setInteractionState === "function") {
      this.runtime.setInteractionState(interactionState);
    }
  }

  async playMotion(groupName, index = 0) {
    if (!this.runtime || typeof this.runtime.playMotion !== "function") return;
    await this.runtime.playMotion(groupName, index);
  }

  destroy() {
    if (this.runtime && typeof this.runtime.destroy === "function") {
      this.runtime.destroy();
    }
    this.runtime = null;
  }
}
