import { app, BrowserWindow, dialog, ipcMain, screen } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";
import { spawn, ChildProcess } from "child_process";

// Module-level child process reference so shutdown can kill it.
let backendChild: ChildProcess | null = null;
let backendPort: number | null = null;

// ---------------------------------------------------------------------------
// resolveBackendBinary — pure, no side effects, fully testable.
// ---------------------------------------------------------------------------
export function resolveBackendBinary(): string {
  const ext = process.platform === "win32" ? ".exe" : "";

  if (!app.isPackaged) {
    // Development: binary lives in backend-bin/<platform>/
    let platformDir: string;
    switch (process.platform) {
      case "win32":
        platformDir = "windows";
        break;
      case "darwin":
        platformDir = "mac";
        break;
      default:
        platformDir = "linux";
        break;
    }
    // __dirname is dist/main/ at runtime; backend-bin is at repo root (two up)
    return path.join(
      __dirname,
      "../../backend-bin",
      platformDir,
      `workboard-backend${ext}`
    );
  }

  // Packaged: electron-builder places the binary via extraResources
  return path.join(
    process.resourcesPath,
    "backend",
    `workboard-backend${ext}`
  );
}

// ---------------------------------------------------------------------------
// spawnBackend — spawns the binary, waits for BACKEND_PORT=<n> handshake.
// ---------------------------------------------------------------------------
export function spawnBackend(): Promise<number> {
  return new Promise((resolve, reject) => {
    const binaryPath = resolveBackendBinary();

    if (!fs.existsSync(binaryPath)) {
      reject(new Error(`Backend binary not found: ${binaryPath}`));
      return;
    }

    const child = spawn(binaryPath, [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    backendChild = child;

    let handshakeDone = false;

    const timer = setTimeout(() => {
      if (!handshakeDone) {
        handshakeDone = true;
        child.kill();
        reject(new Error("Backend handshake timed out after 5 s"));
      }
    }, 5000);

    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line: string) => {
      const match = line.match(/^BACKEND_PORT=(\d+)$/);
      if (match && !handshakeDone) {
        handshakeDone = true;
        clearTimeout(timer);
        rl.close();
        resolve(parseInt(match[1], 10));
      }
    });

    child.on("exit", (code) => {
      if (!handshakeDone) {
        handshakeDone = true;
        clearTimeout(timer);
        reject(new Error(`Backend exited with code ${code} before handshake`));
      } else {
        // Post-startup crash: broadcast to all renderer windows
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("backend-crashed", code);
          }
        });
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      // Log stderr for debugging but don't fail on it
      console.error("[backend stderr]", data.toString());
    });
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle("backend-url", () => {
  return `http://127.0.0.1:${backendPort}`;
});

ipcMain.handle("appInfo.getVersion", () => {
  return app.getVersion();
});

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
export function createWindow(): void {
  const { height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: 360,
    height,
    x: 0,
    y: 0,
    icon: path.join(__dirname, "../../assets/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

// ---------------------------------------------------------------------------
// App startup — guarded so that importing this module in tests does not boot
// Electron (vitest does not have a real app.whenReady).
// ---------------------------------------------------------------------------
async function bootstrap(): Promise<void> {
  try {
    backendPort = await spawnBackend();
    console.log(`Backend running on port ${backendPort}`);
  } catch (err) {
    dialog.showErrorBox(
      "Backend failed to start",
      String(err instanceof Error ? err.message : err)
    );
    app.quit();
    return;
  }

  createWindow();

  // macOS: re-create window when dock icon is clicked and no windows are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

// Quit when all windows are closed, except on macOS.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Kill backend on quit.
app.on("before-quit", () => {
  if (backendChild) {
    backendChild.kill();
  }
});

// Guard: only run startup code when not under test (vitest sets VITEST env var).
if (!process.env.VITEST) {
  app.whenReady().then(bootstrap);
}
