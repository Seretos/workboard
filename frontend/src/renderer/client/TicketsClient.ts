export interface TicketsClient {
  fetchJson(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: unknown }>;
  onBackendCrashed(cb: (code: number | null) => void): void;
}
