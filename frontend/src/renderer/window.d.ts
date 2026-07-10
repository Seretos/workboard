// Type declarations for the contextBridge surfaces exposed by preload.ts.

interface Window {
  appInfo: {
    getVersion: () => string;
  };
  backend: {
    fetchJson: (
      path: string,
      init?: RequestInit,
      timeoutMs?: number
    ) => Promise<{ ok: boolean; status: number; data: unknown }>;
    onBackendCrashed: (cb: (code: number | null) => void) => void;
  };
  detail: {
    openTicketDetail: (ticket: unknown) => void;
    onTicketDetailData: (cb: (ticket: unknown) => void) => void;
    openExternal: (url: string) => Promise<void>;
    hideTicketDetail?: () => void;
    onDetailClosed?: (cb: () => void) => void;
  };
}
