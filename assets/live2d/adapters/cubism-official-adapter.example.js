async function createOfficialAdapter({ container, manifest }) {
  const modelName = manifest?.model?.name || "Unnamed model";

  container.dataset.mood = "calm";
  container.dataset.motion = "idleWave";

  return {
    async setState(state) {
      container.dataset.mood = state.mood;
      container.dataset.motion = state.motion;

      const badge = container.querySelector("[data-avatar-badge]");
      const eyes = container.querySelector("[data-avatar-eyes]");
      const mouth = container.querySelector("[data-avatar-mouth]");

      if (badge) {
        badge.textContent = `${modelName}: ${state.motion}`;
      }

      if (eyes) {
        eyes.textContent = "◉ ◉";
      }

      if (mouth) {
        mouth.textContent = "ᴗ";
      }

      // Replace this stub with a real Cubism Web SDK implementation:
      // 1. Load the .model3.json referenced by manifest.model
      // 2. Map state.motion through manifest.motions
      // 3. Map state.expression through manifest.expressions
      // 4. Update the Cubism model parameters and motion queue
    },
  };
}

window.DevflowLive2DOfficialAdapter = createOfficialAdapter;
window.BackstageLive2DOfficialAdapter = createOfficialAdapter;
