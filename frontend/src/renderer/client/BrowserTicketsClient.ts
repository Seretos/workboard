import type { TicketsClient } from "./TicketsClient";

export class BrowserTicketsClient implements TicketsClient {
  async fetchJson(
    path: string,
    init?: RequestInit,
    timeoutMs?: number
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    const controller = timeoutMs !== undefined ? new AbortController() : null;
    const timeoutId =
      controller !== null ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res: Response;
    try {
      res = await fetch(`/api${path}`, { ...init, signal: controller?.signal ?? init?.signal });
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
  }

  onBackendCrashed(_cb: (code: number | null) => void): void {
    // No-op: browser context has no backend process to crash.
  }
}
