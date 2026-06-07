// Type declarations for the contextBridge surfaces exposed by preload.ts.

interface Window {
  appInfo: {
    getVersion: () => string;
  };
  backend: {
    fetchJson: (
      path: string,
      init?: RequestInit
    ) => Promise<{ ok: boolean; status: number; data: unknown }>;
    onBackendCrashed: (cb: (code: number | null) => void) => void;
  };
}
