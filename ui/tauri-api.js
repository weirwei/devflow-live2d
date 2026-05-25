(() => {
  if (window.desktopAPI || !window.__TAURI__) return;

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.desktopAPI = {
    getOverlayState: () => invoke("get_overlay_state"),
    updateOverlayState: (partialState) => invoke("update_overlay_state", { partialState }),
    openOverlayMenu: () => invoke("open_overlay_menu"),
    quitApp: () => invoke("quit_app"),
    getWindowFrame: () => invoke("get_window_frame"),
    setWindowPosition: (position) => invoke("set_window_position", { position }),
    syncWindowContentSize: (size) => invoke("sync_window_content_size", { size }),
    readTextFile: async (relativePath) => {
      const response = await fetch(`../${relativePath}`);
      if (response.ok) return response.text();
      return invoke("read_text_file", { relativePath });
    },
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
