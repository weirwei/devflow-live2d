(() => {
  if (window.desktopAPI || !window.__TAURI__) return;

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.desktopAPI = {
    getOverlayState: () => invoke("get_overlay_state"),
    updateOverlayState: (partialState) => invoke("update_overlay_state", { partialState }),
    openOverlayMenu: () => invoke("open_overlay_menu"),
    quitApp: () => invoke("quit_app"),
    generatePersonaDialogue: (payload) => invoke("generate_persona_dialogue", { payload }),
    onPreviewAvatarState: (callback) => {
      let unlisten = null;
      listen("overlay:previewAvatarState", (event) => callback(event.payload)).then((dispose) => {
        unlisten = dispose;
      });
      return () => {
        if (unlisten) unlisten();
      };
    },
    onOverlayState: (callback) => {
      let unlisten = null;
      listen("overlay-state", (event) => callback(event.payload)).then((dispose) => {
        unlisten = dispose;
      });
      return () => {
        if (unlisten) unlisten();
      };
    },
  };
})();
