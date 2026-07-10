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
//
// `timeoutMs`, when passed, aborts the request instead of letting it hang
// forever — a backend process that's alive but wedged (not crashed, so no
// `backend-crashed` event fires) would otherwise leave the caller waiting
// on an unresolved promise indefinitely. Omit it for calls that are
// expected to legitimately run long (e.g. worktree creation).
contextBridge.exposeInMainWorld("backend", {
  fetchJson: async (
    path: string,
    init?: RequestInit,
    timeoutMs?: number
  ): Promise<{ ok: boolean; status: number; data: unknown }> => {
    const base: string = await ipcRenderer.invoke("backend-url");
    const controller = timeoutMs !== undefined ? new AbortController() : null;
    const timeoutId =
      controller !== null ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        signal: controller?.signal ?? init?.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Backend antwortet nicht (Zeitüberschreitung nach ${(timeoutMs ?? 0) / 1000}s)`);
      }
      throw err;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  },
  onBackendCrashed: (cb: (code: number | null) => void): void => {
    ipcRenderer.on("backend-crashed", (_event, code) => cb(code as number | null));
  },
});

// Ticket detail window bridge — opens the detail panel and receives data from
// main. Kept as a separate contextBridge surface so detail.html can consume
// just this surface without pulling in the full backend surface.
contextBridge.exposeInMainWorld("detail", {
  openTicketDetail: (ticket: unknown): void => {
    ipcRenderer.send("open-ticket-detail", ticket);
  },
  onTicketDetailData: (cb: (ticket: unknown) => void): void => {
    ipcRenderer.on("ticket-detail-data", (_event, ticket) => cb(ticket));
  },
  openExternal: (url: string): Promise<void> => {
    return ipcRenderer.invoke("open-external", url);
  },
  hideTicketDetail: (): void => {
    ipcRenderer.send("hide-ticket-detail");
  },
  onDetailClosed: (cb: () => void): void => {
    ipcRenderer.on("detail-closed", () => cb());
  },
});
