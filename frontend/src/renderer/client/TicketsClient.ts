export interface TicketsClient {
  fetchJson(path: string): Promise<{ ok: boolean; status: number; data: unknown }>;
  onBackendCrashed(cb: (code: number | null) => void): void;
}
