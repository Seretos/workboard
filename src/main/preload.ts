import { contextBridge } from "electron";

// Minimal, safe bridge between the isolated renderer and the main process.
// Exposes only an app-version getter for now; extend this surface as the app
// grows rather than enabling nodeIntegration in the renderer.
contextBridge.exposeInMainWorld("appInfo", {
  getVersion: (): string => process.env.npm_package_version ?? "0.0.0",
});
