import { contextBridge, ipcRenderer } from "electron";

// Safe bridge between the isolated renderer and the main process.
// Extend this surface as the app grows rather than enabling nodeIntegration
// in the renderer.

contextBridge.exposeInMainWorld("appInfo", {
  getVersion: (): string => process.env.npm_package_version ?? "0.0.0",
});

// Backend fetch wrapper — renderer never receives the raw base URL.
contextBridge.exposeInMainWorld("backend", {
  fetch: async (path: string, init?: RequestInit): Promise<Response> => {
    const base: string = await ipcRenderer.invoke("backend-url");
    return fetch(`${base}${path}`, init);
  },
});
