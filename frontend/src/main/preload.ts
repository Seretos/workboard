import { contextBridge, ipcRenderer } from "electron";

// Safe bridge between the isolated renderer and the main process.
// Extend this surface as the app grows rather than enabling nodeIntegration
// in the renderer.

contextBridge.exposeInMainWorld("appInfo", {
  getVersion: (): string => process.env.npm_package_version ?? "0.0.0",
});

// Backend fetch wrapper — renderer never receives the raw base URL.
//
// Returns a PLAIN, structuredClone-able result rather than a `Response`:
// a `Response` cannot cross the contextBridge intact (its `ok`/`status`
// getters live on `Response.prototype` and are dropped, leaving the
// renderer with `undefined`). So we read the body here and hand back a
// flat `{ ok, status, data }` object the renderer can use directly.
contextBridge.exposeInMainWorld("backend", {
  fetchJson: async (
    path: string,
    init?: RequestInit
  ): Promise<{ ok: boolean; status: number; data: unknown }> => {
    const base: string = await ipcRenderer.invoke("backend-url");
    const res = await fetch(`${base}${path}`, init);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  },
});
