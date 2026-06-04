// Type declarations for the contextBridge surfaces exposed by preload.ts.

interface Window {
  appInfo: {
    getVersion: () => string;
  };
  backend: {
    fetch: (path: string, init?: RequestInit) => Promise<Response>;
  };
}
