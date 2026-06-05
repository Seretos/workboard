import { app, BrowserWindow, dialog, ipcMain, screen, Tray, Menu } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";
import { spawn, ChildProcess } from "child_process";

// Module-level child process reference so shutdown can kill it.
let backendChild: ChildProcess | null = null;
let backendPort: number | null = null;

// Module-level tray reference — must persist to avoid GC collection.
let tray: Tray | null = null;

// Set to true when a real quit is in progress so the close handler does not
// intercept and hide the window instead of letting Electron destroy it.
let isQuitting = false;

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
// Window creation — right-docked Referenz panel, hidden by default.
// Uses workArea (not workAreaSize) so x/y account for taskbar position and
// non-zero display origins (e.g. left taskbar, multi-monitor setups).
// ---------------------------------------------------------------------------
export function createWindow(): BrowserWindow {
  const { x: waX, y: waY, width: waWidth, height: waHeight } =
    screen.getPrimaryDisplay().workArea;
  const panelWidth = 360;
  const win = new BrowserWindow({
    width: panelWidth,
    height: waHeight,
    x: waX + waWidth - panelWidth,
    y: waY,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    icon: path.join(__dirname, "../../assets/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Intercept OS close (Alt+F4, title-bar X on future frames, etc.) and hide
  // instead of destroying the window — the tray keeps the app alive.
  // When a real quit is in progress (isQuitting flag) we let the event through
  // so Electron can cleanly tear down the window.
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.loadFile(path.join(__dirname, "../renderer/index.html"));
  return win;
}

// ---------------------------------------------------------------------------
// Tray creation — exported for testability.
// ---------------------------------------------------------------------------
export function createTray(win: BrowserWindow): Tray {
  const iconPath = path.join(__dirname, "../../assets/icon.png");
  const t = new Tray(iconPath);
  t.setToolTip("Workboard");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Beenden",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  t.setContextMenu(contextMenu);

  const toggle = () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
    }
  };

  t.on("click", toggle);
  // Windows fires double-click as a separate event
  t.on("double-click", toggle);

  return t;
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

  const win = createWindow();
  tray = createTray(win);
}

// Window close only hides the panel — the tray keeps the app alive.
// Quitting happens via the tray context menu ("Beenden").
app.on("window-all-closed", () => {
  // Intentionally empty: do not quit when the window is closed.
});

// Kill backend on quit; also ensure isQuitting is set so the close handler
// does not block Electron's teardown sequence.
app.on("before-quit", () => {
  isQuitting = true;
  if (backendChild) {
    backendChild.kill();
  }
});

// Guard: only run startup code when not under test (vitest sets VITEST env var).
if (!process.env.VITEST) {
  app.whenReady().then(bootstrap);
}
