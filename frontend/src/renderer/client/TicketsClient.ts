export interface TicketsClient {
  fetchJson(
    path: string,
    init?: RequestInit,
    timeoutMs?: number
  ): Promise<{ ok: boolean; status: number; data: unknown }>;
  onBackendCrashed(cb: (code: number | null) => void): void;
}
