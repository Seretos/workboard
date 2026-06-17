import type { TicketsClient } from "./TicketsClient";

export class BrowserTicketsClient implements TicketsClient {
  async fetchJson(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }> {
    const res = await fetch(`/api${path}`, init);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  }

  onBackendCrashed(_cb: (code: number | null) => void): void {
    // No-op: browser context has no backend process to crash.
  }
}
