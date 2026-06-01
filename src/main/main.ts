import { app, BrowserWindow } from "electron";
import * as path from "path";

// Minimal Electron main process. Creates a single window that loads the
// renderer's index.html. Paths are resolved relative to the compiled
// location in dist/main/, so renderer assets sit at ../renderer/.
function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  createWindow();

  // macOS: re-create a window when the dock icon is clicked and no other
  // windows are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS where apps stay active
// until the user explicitly quits.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
