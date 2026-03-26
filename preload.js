import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "./src/ipc-channels.js";

const desktopAPI = {
  getOverlayState: () => ipcRenderer.invoke(IPC_CHANNELS.GET_STATE),
  updateOverlayState: (partialState) =>
    ipcRenderer.invoke(IPC_CHANNELS.UPDATE_STATE, partialState),
  openOverlayMenu: () => ipcRenderer.invoke(IPC_CHANNELS.OPEN_MENU),
  quitApp: () => ipcRenderer.invoke(IPC_CHANNELS.QUIT),
  readTextFile: (relativePath) => ipcRenderer.invoke(IPC_CHANNELS.READ_TEXT_FILE, relativePath),
  onPlayMotion: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.PLAY_MOTION, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PLAY_MOTION, handler);
  },
  onOverlayState: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(IPC_CHANNELS.STATE_BROADCAST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.STATE_BROADCAST, handler);
  },
};

contextBridge.exposeInMainWorld("desktopAPI", desktopAPI);
