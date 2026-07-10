import { app, BrowserWindow, dialog, ipcMain, screen, shell, Tray, Menu } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";
import { spawn, ChildProcess } from "child_process";

// Module-level child process reference so shutdown can kill it.
let backendChild: ChildProcess | null = null;
let backendPort: number | null = null;

// Module-level tray reference — must persist to avoid GC collection.
let tray: Tray | null = null;

// Module-level detail window reference — reused on every card click.
let detailWin: BrowserWindow | null = null;

// Buffer for a ticket that arrived while the detail window was still loading.
// At most one pending ticket is kept — a second click while loading replaces it.
let pendingDetailTicket: unknown = null;

// Tracks the URL of the ticket currently shown in the detail window.
// url is globally unique across projects (unlike numeric id which collides between repos).
// Used to implement toggle-close: clicking the same ticket again hides the window.
let currentDetailTicketUrl: string | null = null;

// Set to true when a real quit is in progress so the close handler does not
// intercept and hide the window instead of letting Electron destroy it.
let isQuitting = false;

// ---------------------------------------------------------------------------
// File logging — there was previously no persistent log output anywhere: a
// packaged/tray-launched app has no attached console, so console.log/error
// (including the relayed backend stderr) vanished into nothing. That made a
// stuck poll or worktree operation undiagnosable after the fact. This mirrors
// console output into a capped file under userData/logs so the next hang
// leaves evidence on disk.
// ---------------------------------------------------------------------------
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let logStream: fs.WriteStream | null = null;

function initLogFile(): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "main.log");
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_MAX_BYTES) {
      fs.renameSync(logPath, path.join(logDir, "main.log.1"));
    }
    logStream = fs.createWriteStream(logPath, { flags: "a" });
    logLine(`--- Workboard started (pid ${process.pid}, version ${app.getVersion()}) ---`);
  } catch (err) {
    console.error("failed to open log file:", err);
  }
}

function logLine(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  logStream?.write(line + "\n");
}

// ---------------------------------------------------------------------------
// resolveIconPath — pure, no side effects, fully testable.
// ---------------------------------------------------------------------------
export function resolveIconPath(): string {
  if (!app.isPackaged) {
    // Development: __dirname is dist/main/; assets/ is at repo root (two up)
    return path.join(__dirname, "../../assets/icon.png");
  }

  // Packaged: electron-builder copies assets/ into the app bundle via build.files
  return path.join(process.resourcesPath, "assets", "icon.png");
}

// ---------------------------------------------------------------------------
// resolveProjectsConfigPath — pure, no side effects, fully testable.
//
// Returns the config file to pin via PROJECT_ISSUES_CONFIG, or null to let
// the backend resolve it itself.
//
// Both dev and packaged modes return null: the repo-local `.seretos/` was
// removed (commit cac84da) and the backend's own resolution chain — a
// git-boundary walk then the home default `~/.seretos/projects.yml` — is
// the correct source of truth in all cases. We deliberately do NOT pin a
// path here; every user supplies their own project list.
// ---------------------------------------------------------------------------
export function resolveProjectsConfigPath(): string | null {
  return null;
}

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

    // resolveProjectsConfigPath() always returns null in both dev and packaged
    // modes, so PROJECT_ISSUES_CONFIG is never set here. The backend uses its
    // own resolution chain (git-boundary walk → ~/.seretos/projects.yml).
    const configPath = resolveProjectsConfigPath();
    const childEnv = { ...process.env };
    if (configPath !== null) {
      childEnv.PROJECT_ISSUES_CONFIG = configPath;
    }

    const child = spawn(binaryPath, [], {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
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
        // To diagnose WHY it exited: the Python traceback is on the backend's
        // stderr (logged below as "[backend stderr]"). A normally-launched
        // packaged app has no attached console, so that log is invisible —
        // run the backend binary directly to see the traceback:
        //   dev:      backend-bin/<os>/workboard-backend[.exe]
        //   packaged: release/<os>-unpacked/resources/backend/workboard-backend[.exe]
        reject(new Error(`Backend exited with code ${code} before handshake`));
      } else {
        // Post-startup crash: broadcast to all renderer windows
        logLine(`Backend exited unexpectedly with code ${code}`);
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("backend-crashed", code);
          }
        });
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      // Relay stderr (includes the backend's own INFO/WARNING log lines) into
      // the persistent log file — don't fail on it.
      logLine(`[backend stderr] ${data.toString().trimEnd()}`);
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

// Notify all renderer windows that the detail panel has been hidden by a
// non-renderer actor (OS close, tray) so they can clear the active-card border.
function notifyDetailClosed(): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send("detail-closed");
    }
  });
}

// Show the detail window with the clicked ticket's data. The window is created
// eagerly in bootstrap() so this handler just pushes data and un-hides it.
//
// Idempotent: if the window is already visible just re-send the ticket data
// (handles poll refreshes and URL switches without toggling off). Closing is
// done via the separate "hide-ticket-detail" IPC message.
//
// Guard against the first-click race: loadFile() is async, so the renderer
// may not have registered its listener yet. When the page is still loading we
// buffer the ticket and deliver it via did-finish-load instead of sending now.
// A second click while still loading overwrites the buffered ticket so only the
// most-recent data is delivered — we replace pendingDetailTicket and let the
// already-registered once() listener pick it up; no second listener is added.
ipcMain.on("open-ticket-detail", (_event, ticket) => {
  const ticketUrl: string | null = (ticket as { url?: string })?.url ?? null;
  currentDetailTicketUrl = ticketUrl;

  if (detailWin && detailWin.isVisible()) {
    // Window already visible — push updated data. No toggle-off here; use
    // "hide-ticket-detail" to close. This makes poll refreshes idempotent.
    detailWin.webContents.send("ticket-detail-data", ticket);
    return;
  }

  // Window is hidden or not yet created — open it.
  if (!detailWin) {
    detailWin = createDetailWindow();
  }
  if (detailWin.webContents.isLoading()) {
    // If no listener is registered yet (first click while loading), add one.
    // If one was already registered (second click while loading), just replace
    // the buffered ticket — the existing once() will deliver the updated value.
    const needsListener = pendingDetailTicket === null;
    pendingDetailTicket = ticket;
    if (needsListener) {
      detailWin.webContents.once("did-finish-load", () => {
        const t = pendingDetailTicket;
        pendingDetailTicket = null;
        currentDetailTicketUrl = (t as { url?: string })?.url ?? null;
        detailWin?.webContents.send("ticket-detail-data", t);
        detailWin?.show();
      });
    }
  } else {
    detailWin.webContents.send("ticket-detail-data", ticket);
    detailWin.show();
  }
});

// Hide the detail window — renderer-initiated close. No broadcast needed
// because the renderer (ElectronDetailPresenter.close()) already clears its
// own activeId synchronously before sending this message.
ipcMain.on("hide-ticket-detail", () => {
  if (detailWin && detailWin.isVisible()) {
    detailWin.hide();
    currentDetailTicketUrl = null;
  }
});

// Open a URL in the system browser — never navigate the renderer itself.
ipcMain.handle("open-external", (_event, url: string) => {
  return shell.openExternal(url);
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
    icon: resolveIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
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
// Detail window — left-docked next to the panel, hidden by default.
// Reused across card clicks so it is created eagerly in bootstrap().
// Uses the same workArea geometry as createWindow() to stay aligned.
// ---------------------------------------------------------------------------
export function createDetailWindow(): BrowserWindow {
  const { x: waX, y: waY, width: waWidth, height: waHeight } =
    screen.getPrimaryDisplay().workArea;
  const panelWidth = 360;
  const detailWidth = 480;
  const win = new BrowserWindow({
    width: detailWidth,
    height: waHeight,
    x: waX + waWidth - panelWidth - detailWidth,
    y: waY,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    icon: resolveIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Mirror the panel's close behaviour: hide instead of destroy so the tray
  // keeps the app alive. Let it through only when a real quit is in progress.
  // Clear the toggle key and broadcast "detail-closed" so the main-panel renderer
  // can clear its active-card highlight (this is a non-renderer-initiated hide —
  // e.g. Alt+F4 — so the renderer cannot clear itself synchronously).
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
      currentDetailTicketUrl = null;
      notifyDetailClosed();
    }
  });

  win.loadFile(path.join(__dirname, "../renderer/detail.html"));
  return win;
}

// ---------------------------------------------------------------------------
// Tray creation — exported for testability.
//
// getDetailWin is an optional getter that returns the current detail window
// (or null). When provided, the toggle also hides detailWin alongside the
// main panel — preventing the detail window from remaining visible on screen
// with no close affordance when the user hides the app via the tray.
// On hide: detailWin is hidden unconditionally (if visible).
// On show: the panel is restored; the user re-opens the detail by clicking a
// card, matching the simplest coherent UX and the existing toggle code's style.
// ---------------------------------------------------------------------------
export function createTray(
  win: BrowserWindow,
  getDetailWin?: () => BrowserWindow | null
): Tray {
  const t = new Tray(resolveIconPath());
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
      // Also hide the detail window so it doesn't stay stranded on screen.
      // Clear the toggle key and broadcast "detail-closed" so the renderer can
      // clear the active-card highlight (tray is a non-renderer-initiated hide).
      const dw = getDetailWin?.();
      if (dw && dw.isVisible()) {
        dw.hide();
        currentDetailTicketUrl = null;
        notifyDetailClosed();
      }
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
  initLogFile();
  try {
    backendPort = await spawnBackend();
    logLine(`Backend running on port ${backendPort}`);
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    logLine(`Backend failed to start: ${message}`);
    dialog.showErrorBox("Backend failed to start", message);
    app.quit();
    return;
  }

  const win = createWindow();
  // Eagerly create the detail window so the first card click has no perceptible
  // delay — BrowserWindow creation is slow and must not block the click handler.
  detailWin = createDetailWindow();
  tray = createTray(win, () => detailWin);
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
