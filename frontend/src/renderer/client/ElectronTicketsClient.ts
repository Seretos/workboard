import type { TicketsClient } from "./TicketsClient";

export class ElectronTicketsClient implements TicketsClient {
  fetchJson(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }> {
    return window.backend.fetchJson(path, init);
  }

  onBackendCrashed(cb: (code: number | null) => void): void {
    window.backend.onBackendCrashed(cb);
  }
}
