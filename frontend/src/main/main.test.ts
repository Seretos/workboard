import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Mock the `electron` module so importing main.ts doesn't need a real Electron
// runtime. We need app.isPackaged and process.resourcesPath to be controllable.
// ---------------------------------------------------------------------------
vi.mock("electron", () => {
  // BrowserWindowCtor has getAllWindows as a static method (class-level), matching
  // Electron's API. Tests that need specific return values override it after importing
  // "electron" via: (electron.BrowserWindow as any).getAllWindows = vi.fn(() => [...]).
  const BrowserWindowCtor = vi.fn().mockImplementation(() => ({
    loadFile: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => false),
    show: vi.fn(),
    hide: vi.fn(),
    // on() records handlers so tests can retrieve and invoke them.
    on: vi.fn(),
    webContents: {
      send: vi.fn(),
      isLoading: vi.fn(() => false),
      once: vi.fn(),
    },
  }));
  (BrowserWindowCtor as unknown as { getAllWindows: ReturnType<typeof vi.fn> }).getAllWindows = vi.fn(() => []);

  return {
    app: {
      isPackaged: false,
      getVersion: vi.fn(() => "0.0.0"),
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      quit: vi.fn(),
      // Default: this instance wins the lock, matching prior (lock-free)
      // behaviour for every existing test. Tests exercising the "another
      // instance is already running" path override this per-test.
      requestSingleInstanceLock: vi.fn(() => true),
    },
    BrowserWindow: BrowserWindowCtor,
    // Each Tray() call gets its own fresh instance so tests don't share state.
    Tray: vi.fn().mockImplementation(() => ({
      on: vi.fn(),
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
    })),
    Menu: {
      buildFromTemplate: vi.fn(() => ({})),
    },
    dialog: {
      showErrorBox: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(() => Promise.resolve()),
    },
    screen: {
      // Return workArea (x/y/width/height) used by the right-dock calculation.
      getPrimaryDisplay: vi.fn(() => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      })),
    },
  };
});

// ---------------------------------------------------------------------------
// Mock fs so spawnBackend tests can control existsSync without real filesystem.
// ---------------------------------------------------------------------------
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
}));

// ---------------------------------------------------------------------------
// Mock child_process so spawnBackend tests don't actually spawn a process.
// ---------------------------------------------------------------------------
vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    pid: 4242,
    kill: vi.fn(),
  })),
  execFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock readline so the rl.on("line") wiring in spawnBackend does not crash.
// ---------------------------------------------------------------------------
vi.mock("readline", () => ({
  createInterface: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Helper: import resolveBackendBinary with a controlled app.isPackaged value.
// We re-import via dynamic import after adjusting the mock each time.
// ---------------------------------------------------------------------------
describe("resolveBackendBinary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("dev + win32 → ends with backend-bin/windows/workboard-backend.exe", async () => {
    const electron = await import("electron");
    // @ts-ignore — override mock property
    electron.app.isPackaged = false;

    // Simulate win32
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const { resolveBackendBinary } = await import("./main.js");
    const result = resolveBackendBinary();

    expect(result.replace(/\\/g, "/")).toMatch(
      /backend-bin\/windows\/workboard-backend\.exe$/
    );
  });

  it("dev + linux → ends with backend-bin/linux/workboard-backend", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = false;

    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const { resolveBackendBinary } = await import("./main.js");
    const result = resolveBackendBinary();

    expect(result.replace(/\\/g, "/")).toMatch(
      /backend-bin\/linux\/workboard-backend$/
    );
    expect(result).not.toMatch(/\.exe$/);
  });

  it("packaged + darwin → equals path.join(process.resourcesPath, 'backend', 'workboard-backend')", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = true;

    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    // Provide a fake resourcesPath
    Object.defineProperty(process, "resourcesPath", {
      value: "/Applications/Workboard.app/Contents/Resources",
      configurable: true,
    });

    const { resolveBackendBinary } = await import("./main.js");
    const result = resolveBackendBinary();

    expect(result).toBe(
      path.join(
        "/Applications/Workboard.app/Contents/Resources",
        "backend",
        "workboard-backend"
      )
    );
  });

  it("unrecognised platform → linux path (no throw)", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = false;

    Object.defineProperty(process, "platform", {
      value: "freebsd",
      configurable: true,
    });

    const { resolveBackendBinary } = await import("./main.js");
    let result!: string;
    expect(() => {
      result = resolveBackendBinary();
    }).not.toThrow();

    expect(result.replace(/\\/g, "/")).toMatch(
      /backend-bin\/linux\/workboard-backend$/
    );
    expect(result).not.toMatch(/\.exe$/);
  });
});

// ---------------------------------------------------------------------------
// createWindow — BrowserWindow geometry and icon
// ---------------------------------------------------------------------------
describe("createWindow", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("constructs BrowserWindow with width 360", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    createWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ width: 360 })
    );
  });

  it("constructs BrowserWindow with icon ending in icon.png", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    createWindow();

    const calls = (electron.BrowserWindow as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const lastOpts = calls[calls.length - 1][0] as Record<string, unknown>;
    expect(typeof lastOpts.icon).toBe("string");
    expect((lastOpts.icon as string).replace(/\\/g, "/")).toMatch(/icon\.png$/);
  });

  it("calls screen.getPrimaryDisplay to get workArea", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    createWindow();

    expect(electron.screen.getPrimaryDisplay).toHaveBeenCalled();
  });

  it("constructs BrowserWindow with height from workArea (1080)", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    createWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ height: 1080 })
    );
  });

  // ---- Regression tests for right-dock, frameless, tray-only behaviour ----

  it("regression: x is right-docked (workArea.x + workArea.width - 360 = 1560)", async () => {
    const electron = await import("electron");
    // Default mock: workArea { x:0, y:0, width:1920, height:1080 } → x = 1560

    const { createWindow } = await import("./main.js");
    createWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ x: 1560 })
    );
  });

  it("regression: x accounts for non-zero workArea origin (x:100, width:1920 → 1660)", async () => {
    const electron = await import("electron");
    // Override getPrimaryDisplay for this test to simulate a left taskbar / offset display.
    (electron.screen.getPrimaryDisplay as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      workArea: { x: 100, y: 40, width: 1920, height: 1040 },
    });

    const { createWindow } = await import("./main.js");
    createWindow();

    // x = 100 + 1920 - 360 = 1660; y = 40; height = 1040
    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ x: 1660, y: 40, height: 1040 })
    );
  });

  it("regression: frame is false (frameless panel)", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    createWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ frame: false })
    );
  });

  it("regression: skipTaskbar is true", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    createWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ skipTaskbar: true })
    );
  });

  it("regression: resizable is false", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    createWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ resizable: false })
    );
  });

  it("regression: alwaysOnTop is true", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    createWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysOnTop: true })
    );
  });

  it("regression: show is false (hidden by default)", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    createWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ show: false })
    );
  });

  it("regression: webPreferences.preload points to ../preload/preload.js (electron-vite output)", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    createWindow();

    const calls = (electron.BrowserWindow as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const lastOpts = calls[calls.length - 1][0] as Record<string, unknown>;
    const webPrefs = lastOpts.webPreferences as Record<string, unknown>;
    expect(typeof webPrefs.preload).toBe("string");
    expect((webPrefs.preload as string).replace(/\\/g, "/")).toMatch(
      /preload[\\/]preload\.js$/
    );
  });

  // ---- Close-handler tests ----

  it("close handler calls event.preventDefault() and win.hide() when not quitting", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    const win = createWindow();

    // win.on is a spy; find the registered "close" handler.
    const onSpy = (win.on as ReturnType<typeof vi.fn>);
    const closeCall = onSpy.mock.calls.find((c: unknown[]) => c[0] === "close");
    expect(closeCall).toBeDefined();

    const fakeEvent = { preventDefault: vi.fn() };
    (closeCall![1] as (e: typeof fakeEvent) => void)(fakeEvent);

    expect(fakeEvent.preventDefault).toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalled();
    // Window must not be destroyed — isDestroyed() still returns false.
    expect(win.isDestroyed()).toBe(false);
  });

  it("close handler does NOT prevent default when app is quitting (Beenden)", async () => {
    const electron = await import("electron");

    const { createWindow, createTray } = await import("./main.js");
    const win = createWindow();

    // Simulate "Beenden": invoke the context-menu click to set isQuitting.
    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const MenuMock = electron.Menu as unknown as { buildFromTemplate: ReturnType<typeof vi.fn> };
    // Create the tray so the "Beenden" click handler registers.
    createTray(win as any);
    const lastTemplate = MenuMock.buildFromTemplate.mock.calls[
      MenuMock.buildFromTemplate.mock.calls.length - 1
    ][0] as Array<{ label: string; click: () => void }>;
    const beendenItem = lastTemplate.find((item) => item.label === "Beenden");
    expect(beendenItem).toBeDefined();
    // Fire "Beenden" — this sets isQuitting = true.
    beendenItem!.click();

    // Now fire the close handler — it should NOT call preventDefault.
    const onSpy = (win.on as ReturnType<typeof vi.fn>);
    const closeCall = onSpy.mock.calls.find((c: unknown[]) => c[0] === "close");
    expect(closeCall).toBeDefined();

    const fakeEvent = { preventDefault: vi.fn() };
    (closeCall![1] as (e: typeof fakeEvent) => void)(fakeEvent);

    expect(fakeEvent.preventDefault).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createTray — system tray integration
// ---------------------------------------------------------------------------
describe("createTray", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("constructs Tray with a path ending in icon.png", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    expect(TrayCtor).toHaveBeenCalled();
    const iconArg: string = TrayCtor.mock.calls[TrayCtor.mock.calls.length - 1][0];
    expect(iconArg.replace(/\\/g, "/")).toMatch(/icon\.png$/);
  });

  it("calls tray.on with 'click' to register toggle handler", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;
    const onCalls: string[] = trayInstance.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(onCalls).toContain("click");
  });

  it("calls tray.on with 'double-click' to register toggle handler", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;
    const onCalls: string[] = trayInstance.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(onCalls).toContain("double-click");
  });

  it("clicking tray shows window when hidden", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;

    // Find and invoke the click handler
    const clickCall = trayInstance.on.mock.calls.find((c: unknown[]) => c[0] === "click");
    expect(clickCall).toBeDefined();
    (clickCall![1] as () => void)();

    expect(mockWin.show).toHaveBeenCalled();
    expect(mockWin.hide).not.toHaveBeenCalled();
  });

  it("clicking tray hides window when visible", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => true),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;

    const clickCall = trayInstance.on.mock.calls.find((c: unknown[]) => c[0] === "click");
    (clickCall![1] as () => void)();

    expect(mockWin.hide).toHaveBeenCalled();
    expect(mockWin.show).not.toHaveBeenCalled();
  });

  it("double-clicking tray shows window when hidden", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;

    const dblClickCall = trayInstance.on.mock.calls.find(
      (c: unknown[]) => c[0] === "double-click"
    );
    expect(dblClickCall).toBeDefined();
    (dblClickCall![1] as () => void)();

    expect(mockWin.show).toHaveBeenCalled();
    expect(mockWin.hide).not.toHaveBeenCalled();
  });

  it("double-clicking tray hides window when visible", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => true),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;

    const dblClickCall = trayInstance.on.mock.calls.find(
      (c: unknown[]) => c[0] === "double-click"
    );
    (dblClickCall![1] as () => void)();

    expect(mockWin.hide).toHaveBeenCalled();
    expect(mockWin.show).not.toHaveBeenCalled();
  });

  it("sets tooltip to 'Workboard'", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;
    expect(trayInstance.setToolTip).toHaveBeenCalledWith("Workboard");
  });

  it("shows a disabled 'Version <x.y.z>' item above a separator, above the still-wired 'Beenden' item", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any);

    const MenuMock = electron.Menu as unknown as { buildFromTemplate: ReturnType<typeof vi.fn> };
    const lastTemplate = MenuMock.buildFromTemplate.mock.calls[
      MenuMock.buildFromTemplate.mock.calls.length - 1
    ][0] as Array<{ label?: string; type?: string; enabled?: boolean; click?: () => void }>;

    const versionIndex = lastTemplate.findIndex((item) => item.label === "Version 0.0.0");
    expect(versionIndex).toBeGreaterThanOrEqual(0);
    expect(lastTemplate[versionIndex].enabled).toBe(false);

    const beendenIndex = lastTemplate.findIndex((item) => item.label === "Beenden");
    expect(beendenIndex).toBeGreaterThan(versionIndex);

    // A separator sits between the version item and "Beenden".
    expect(lastTemplate[versionIndex + 1].type).toBe("separator");

    // "Beenden" is still present and still wired to quit.
    (electron.app.quit as ReturnType<typeof vi.fn>).mockClear();
    lastTemplate[beendenIndex].click!();
    expect(electron.app.quit).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveIconPath
// ---------------------------------------------------------------------------
describe("resolveIconPath", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("dev mode → path ends with assets/icon.png", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = false;

    const { resolveIconPath } = await import("./main.js");
    const result = resolveIconPath();

    expect(result.replace(/\\/g, "/")).toMatch(/assets\/icon\.png$/);
  });

  it("packaged mode → equals path.join(process.resourcesPath, 'assets', 'icon.png')", async () => {
    // NOTE: this path is only valid at runtime because package.json extraResources
    // includes { "from": "assets/icon.png", "to": "assets/icon.png" }.  If that
    // entry is ever removed, the tray/window icon will silently break in packaged
    // builds even though this test still passes.
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = true;

    Object.defineProperty(process, "resourcesPath", {
      value: "/Applications/Workboard.app/Contents/Resources",
      configurable: true,
    });

    const { resolveIconPath } = await import("./main.js");
    const result = resolveIconPath();

    expect(result).toBe(
      path.join(
        "/Applications/Workboard.app/Contents/Resources",
        "assets",
        "icon.png"
      )
    );
  });
});

// ---------------------------------------------------------------------------
// resolveProjectsConfigPath
// ---------------------------------------------------------------------------
describe("resolveProjectsConfigPath", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("dev mode → null (backend falls through to ~/.seretos/projects.yml)", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = false;

    const { resolveProjectsConfigPath } = await import("./main.js");
    const result = resolveProjectsConfigPath();

    expect(result).toBeNull();
  });

  it("packaged mode → null (backend falls through to ~/.seretos/projects.yml)", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = true;

    const { resolveProjectsConfigPath } = await import("./main.js");
    const result = resolveProjectsConfigPath();

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createDetailWindow — geometry and window traits
// ---------------------------------------------------------------------------
describe("createDetailWindow", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("constructs BrowserWindow with width 480 (detailWidth)", async () => {
    const electron = await import("electron");

    const { createDetailWindow } = await import("./main.js");
    createDetailWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ width: 480 })
    );
  });

  it("constructs BrowserWindow with height from workArea (1080)", async () => {
    const electron = await import("electron");

    const { createDetailWindow } = await import("./main.js");
    createDetailWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ height: 1080 })
    );
  });

  it("x is left of the panel: waX + waWidth - panelWidth - detailWidth = 1920 - 360 - 480 = 1080", async () => {
    const electron = await import("electron");
    // Default mock: workArea { x:0, y:0, width:1920, height:1080 }
    // x = 0 + 1920 - 360 - 480 = 1080

    const { createDetailWindow } = await import("./main.js");
    createDetailWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ x: 1080 })
    );
  });

  it("x accounts for non-zero workArea origin (x:100, width:1920 → 100 + 1920 - 360 - 480 = 1180)", async () => {
    const electron = await import("electron");
    (electron.screen.getPrimaryDisplay as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      workArea: { x: 100, y: 40, width: 1920, height: 1040 },
    });

    const { createDetailWindow } = await import("./main.js");
    createDetailWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ x: 1180, y: 40, height: 1040 })
    );
  });

  it("frame is false (frameless)", async () => {
    const electron = await import("electron");

    const { createDetailWindow } = await import("./main.js");
    createDetailWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ frame: false })
    );
  });

  it("alwaysOnTop is true", async () => {
    const electron = await import("electron");

    const { createDetailWindow } = await import("./main.js");
    createDetailWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysOnTop: true })
    );
  });

  it("skipTaskbar is true", async () => {
    const electron = await import("electron");

    const { createDetailWindow } = await import("./main.js");
    createDetailWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ skipTaskbar: true })
    );
  });

  it("resizable is false", async () => {
    const electron = await import("electron");

    const { createDetailWindow } = await import("./main.js");
    createDetailWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ resizable: false })
    );
  });

  it("show is false (hidden by default)", async () => {
    const electron = await import("electron");

    const { createDetailWindow } = await import("./main.js");
    createDetailWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ show: false })
    );
  });

  it("close handler calls event.preventDefault() and win.hide() when not quitting", async () => {
    const electron = await import("electron");

    const { createDetailWindow } = await import("./main.js");
    const win = createDetailWindow();

    const onSpy = win.on as ReturnType<typeof vi.fn>;
    const closeCall = onSpy.mock.calls.find((c: unknown[]) => c[0] === "close");
    expect(closeCall).toBeDefined();

    const fakeEvent = { preventDefault: vi.fn() };
    (closeCall![1] as (e: typeof fakeEvent) => void)(fakeEvent);

    expect(fakeEvent.preventDefault).toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalled();
  });

  it("close handler does NOT prevent default when app is quitting", async () => {
    const electron = await import("electron");

    const { createDetailWindow, createTray, createWindow } = await import("./main.js");
    const panelWin = createWindow();
    const detailWin = createDetailWindow();

    // Trigger isQuitting via the Beenden menu item.
    const MenuMock = electron.Menu as unknown as { buildFromTemplate: ReturnType<typeof vi.fn> };
    createTray(panelWin as any);
    const lastTemplate = MenuMock.buildFromTemplate.mock.calls[
      MenuMock.buildFromTemplate.mock.calls.length - 1
    ][0] as Array<{ label: string; click: () => void }>;
    const beendenItem = lastTemplate.find((item) => item.label === "Beenden");
    beendenItem!.click();

    const onSpy = detailWin.on as ReturnType<typeof vi.fn>;
    const closeCall = onSpy.mock.calls.find((c: unknown[]) => c[0] === "close");
    expect(closeCall).toBeDefined();

    const fakeEvent = { preventDefault: vi.fn() };
    (closeCall![1] as (e: typeof fakeEvent) => void)(fakeEvent);

    expect(fakeEvent.preventDefault).not.toHaveBeenCalled();
  });

  it("ipcMain.on is called with 'open-ticket-detail'", async () => {
    const electron = await import("electron");

    // Import the module — module-level ipcMain.on calls fire on import.
    await import("./main.js");

    const ipcMainMock = electron.ipcMain as unknown as { on: ReturnType<typeof vi.fn> };
    const registeredChannels: string[] = ipcMainMock.on.mock.calls.map(
      (c: unknown[]) => c[0] as string
    );
    expect(registeredChannels).toContain("open-ticket-detail");
  });

  it("regression: webPreferences.preload points to ../preload/preload.js (electron-vite output)", async () => {
    const electron = await import("electron");

    const { createDetailWindow } = await import("./main.js");
    createDetailWindow();

    const calls = (electron.BrowserWindow as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const lastOpts = calls[calls.length - 1][0] as Record<string, unknown>;
    const webPrefs = lastOpts.webPreferences as Record<string, unknown>;
    expect(typeof webPrefs.preload).toBe("string");
    expect((webPrefs.preload as string).replace(/\\/g, "/")).toMatch(
      /preload[\\/]preload\.js$/
    );
  });
});

// ---------------------------------------------------------------------------
// spawnBackend — env wiring
// ---------------------------------------------------------------------------
describe("spawnBackend", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("dev mode → spawn env does NOT set PROJECT_ISSUES_CONFIG", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = false;

    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    // fs.existsSync must return true so spawnBackend doesn't reject early.
    const fsMock = await import("fs");
    (fsMock.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const cpMock = await import("child_process");
    const fakeChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    // Reset first so call history from earlier tests doesn't bleed in.
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReset();
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);

    const { spawnBackend } = await import("./main.js");
    // Start but don't await — handshake never resolves in this test; we only
    // care that spawn was called with the right options.
    spawnBackend().catch(() => {});

    const spawnEnv = (cpMock.spawn as ReturnType<typeof vi.fn>).mock.calls[0][2].env;
    expect(spawnEnv).not.toHaveProperty("PROJECT_ISSUES_CONFIG");
  });

  it("packaged mode → spawn env does NOT set PROJECT_ISSUES_CONFIG", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = true;

    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const fsMock = await import("fs");
    (fsMock.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const cpMock = await import("child_process");
    const fakeChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    // Reset first so call history from earlier tests doesn't bleed in.
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReset();
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);

    const { spawnBackend } = await import("./main.js");
    spawnBackend().catch(() => {});

    const spawnEnv = (cpMock.spawn as ReturnType<typeof vi.fn>).mock.calls[0][2].env;
    expect(spawnEnv).not.toHaveProperty("PROJECT_ISSUES_CONFIG");
  });

  // -------------------------------------------------------------------------
  // Regression guard for #113: the reported "worktree creation slows
  // concurrent tickets polls to a crawl" symptom was root-caused to setup
  // subprocesses (npm install/git checkout) saturating OS-level disk/CPU,
  // fixed upstream in lib-python-worktree v0.1.11's SetupRunner, which spawns
  // setup-step subprocesses at a lowered OS scheduling/IO priority by
  // default — toggled off only when the backend process's own
  // WORKTREE_SETUP_LOWER_PRIORITY env var is set to a disabling value
  // ("", "0", "false", "no", "off"; see lib_python_worktree/setup/runner.py).
  // The backend process's env is whatever spawnBackend hands to
  // child_process.spawn(), so if spawnBackend ever stopped inheriting
  // process.env wholesale (e.g. switched to an explicit allowlist) it could
  // silently drop or override that var and disable the v0.1.11 fix. This
  // test guards spawnBackend's env-building logic directly: it must pass an
  // arbitrary ambient var through unchanged and must not force
  // WORKTREE_SETUP_LOWER_PRIORITY to a disabling value itself.
  // -------------------------------------------------------------------------
  it("spawn env inherits process.env wholesale and never disables WORKTREE_SETUP_LOWER_PRIORITY", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = false;

    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const originalMarker = process.env.WORKBOARD_TEST_MARKER;
    const originalLowerPriority = process.env.WORKTREE_SETUP_LOWER_PRIORITY;
    process.env.WORKBOARD_TEST_MARKER = "marker-value";
    process.env.WORKTREE_SETUP_LOWER_PRIORITY = "1";

    const fsMock = await import("fs");
    (fsMock.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const cpMock = await import("child_process");
    const fakeChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReset();
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);

    try {
      const { spawnBackend } = await import("./main.js");
      spawnBackend().catch(() => {});

      const spawnEnv = (cpMock.spawn as ReturnType<typeof vi.fn>).mock.calls[0][2].env;

      // Arbitrary ambient vars must flow through unchanged — proves the env
      // is built via {...process.env} rather than a hand-picked allowlist.
      expect(spawnEnv.WORKBOARD_TEST_MARKER).toBe("marker-value");
      // The priority-lowering toggle must pass through unchanged too, and
      // must never be forced to one of the disabling values by spawnBackend.
      expect(spawnEnv.WORKTREE_SETUP_LOWER_PRIORITY).toBe("1");
      expect(["", "0", "false", "no", "off"]).not.toContain(
        spawnEnv.WORKTREE_SETUP_LOWER_PRIORITY
      );
    } finally {
      if (originalMarker === undefined) {
        delete process.env.WORKBOARD_TEST_MARKER;
      } else {
        process.env.WORKBOARD_TEST_MARKER = originalMarker;
      }
      if (originalLowerPriority === undefined) {
        delete process.env.WORKTREE_SETUP_LOWER_PRIORITY;
      } else {
        process.env.WORKTREE_SETUP_LOWER_PRIORITY = originalLowerPriority;
      }
    }
  });

  // -------------------------------------------------------------------------
  // #130: the backend is a PyInstaller onefile bootloader whose real uvicorn
  // process is a grandchild. On POSIX, detaching the spawned process makes it
  // a process-group leader so killBackendTree() can signal the whole group
  // via the negative PID. Windows instead relies on `taskkill /T`, which
  // walks the process tree itself — detaching is neither needed nor used.
  // -------------------------------------------------------------------------
  it("posix: spawn is called with detached: true", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = false;

    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const fsMock = await import("fs");
    (fsMock.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const cpMock = await import("child_process");
    const fakeChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReset();
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);

    const { spawnBackend } = await import("./main.js");
    spawnBackend().catch(() => {});

    const spawnOpts = (cpMock.spawn as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(spawnOpts.detached).toBe(true);
  });

  it("win32: spawn is called with detached: false", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = false;

    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const fsMock = await import("fs");
    (fsMock.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const cpMock = await import("child_process");
    const fakeChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReset();
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);

    const { spawnBackend } = await import("./main.js");
    spawnBackend().catch(() => {});

    const spawnOpts = (cpMock.spawn as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(spawnOpts.detached).toBe(false);
  });

  // -------------------------------------------------------------------------
  // #130: the handshake-timeout branch (the setTimeout(..., 5000) that fires
  // when the backend never emits its BACKEND_PORT=<n> line) must also route
  // through killBackendTree(), not a bare child.kill() — otherwise a backend
  // that hangs before handshaking still leaks its uvicorn grandchild.
  // -------------------------------------------------------------------------
  it("handshake timeout: routes through killBackendTree (win32 taskkill fires, not bare child.kill())", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = false;

    const fsMock = await import("fs");
    (fsMock.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const cpMock = await import("child_process");
    const fakeChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      pid: 7777,
      kill: vi.fn(),
    };
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReset();
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);
    (cpMock.execFile as ReturnType<typeof vi.fn>).mockClear();

    vi.useFakeTimers();
    try {
      const { spawnBackend } = await import("./main.js");
      const promise = spawnBackend();
      // Register the expected-rejection assertion before advancing timers so
      // the rejection is never left unhandled.
      const rejection = expect(promise).rejects.toThrow("Backend handshake timed out after 5 s");

      // The readline mock's `on` never invokes its callback, so the backend
      // never "emits" BACKEND_PORT=<n> — the handshake never completes and
      // the 5 s timeout branch fires.
      await vi.advanceTimersByTimeAsync(5000);

      await rejection;

      expect(cpMock.execFile).toHaveBeenCalledWith("taskkill", ["/pid", "7777", "/T", "/F"]);
      expect(fakeChild.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// killBackendTree — #130: tray "Beenden" must tear down the entire backend
// process tree, not just the immediate bootloader process. The backend is a
// PyInstaller onefile build, so child.kill() only signals the bootloader,
// leaving the real uvicorn grandchild orphaned (this is the reported bug).
// ---------------------------------------------------------------------------
describe("killBackendTree", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("null child is a no-op: no execFile call, no throw", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const cpMock = await import("child_process");
    (cpMock.execFile as ReturnType<typeof vi.fn>).mockClear();

    const { killBackendTree } = await import("./main.js");

    expect(() => killBackendTree(null)).not.toThrow();
    expect(cpMock.execFile).not.toHaveBeenCalled();
  });

  it("win32: calls execFile('taskkill', ['/pid', pid, '/T', '/F'])", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const cpMock = await import("child_process");
    (cpMock.execFile as ReturnType<typeof vi.fn>).mockClear();

    const { killBackendTree } = await import("./main.js");
    const fakeChild = { pid: 4242, kill: vi.fn() } as unknown as import("child_process").ChildProcess;

    killBackendTree(fakeChild);

    expect(cpMock.execFile).toHaveBeenCalledWith("taskkill", ["/pid", "4242", "/T", "/F"]);
    expect((fakeChild as unknown as { kill: ReturnType<typeof vi.fn> }).kill).not.toHaveBeenCalled();
  });

  it("win32 with undefined pid: falls back to child.kill()", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const cpMock = await import("child_process");
    (cpMock.execFile as ReturnType<typeof vi.fn>).mockClear();

    const { killBackendTree } = await import("./main.js");
    const fakeKill = vi.fn();
    const fakeChild = { pid: undefined, kill: fakeKill } as unknown as import("child_process").ChildProcess;

    killBackendTree(fakeChild);

    expect(fakeKill).toHaveBeenCalled();
    expect(cpMock.execFile).not.toHaveBeenCalled();
  });

  it("win32: execFile/taskkill throwing falls back to child.kill()", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const cpMock = await import("child_process");
    (cpMock.execFile as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("taskkill not found");
    });

    const { killBackendTree } = await import("./main.js");
    const fakeKill = vi.fn();
    const fakeChild = { pid: 4242, kill: fakeKill } as unknown as import("child_process").ChildProcess;

    killBackendTree(fakeChild);

    expect(fakeKill).toHaveBeenCalled();
  });

  it("posix: calls process.kill(-pid, 'SIGTERM')", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

    const { killBackendTree } = await import("./main.js");
    const fakeKill = vi.fn();
    const fakeChild = { pid: 4242, kill: fakeKill } as unknown as import("child_process").ChildProcess;

    killBackendTree(fakeChild);

    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(fakeKill).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("posix with undefined pid: falls back to child.kill()", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);

    const { killBackendTree } = await import("./main.js");
    const fakeKill = vi.fn();
    const fakeChild = { pid: undefined, kill: fakeKill } as unknown as import("child_process").ChildProcess;

    killBackendTree(fakeChild);

    expect(fakeKill).toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });

  it("posix: process.kill throwing falls back to child.kill()", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });

    const { killBackendTree } = await import("./main.js");
    const fakeKill = vi.fn();
    const fakeChild = { pid: 4242, kill: fakeKill } as unknown as import("child_process").ChildProcess;

    killBackendTree(fakeChild);

    expect(fakeKill).toHaveBeenCalled();

    killSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// before-quit — #130: the tray "Beenden" choke point must route the kill
// through killBackendTree() (tree-kill), not backendChild.kill() (bootloader
// only), so the real uvicorn grandchild does not survive as an orphan.
// ---------------------------------------------------------------------------
describe("before-quit choke point", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("win32: before-quit handler routes through killBackendTree (taskkill fires on the spawned backend)", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const electron = await import("electron");
    // @ts-ignore
    electron.app.requestSingleInstanceLock = vi.fn(() => true);
    (electron.app.on as ReturnType<typeof vi.fn>).mockClear();

    const fsMock = await import("fs");
    (fsMock.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const cpMock = await import("child_process");
    const fakeChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      pid: 9999,
      kill: vi.fn(),
    };
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReset();
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);
    (cpMock.execFile as ReturnType<typeof vi.fn>).mockClear();

    const { spawnBackend } = await import("./main.js");
    // The Promise executor runs synchronously, so the module-level
    // backendChild reference is set before this line returns even though
    // the handshake itself never resolves in this test.
    spawnBackend().catch(() => {});

    const onSpy = electron.app.on as ReturnType<typeof vi.fn>;
    const beforeQuitCall = onSpy.mock.calls.find((c: unknown[]) => c[0] === "before-quit");
    expect(beforeQuitCall).toBeDefined();

    (beforeQuitCall![1] as () => void)();

    expect(cpMock.execFile).toHaveBeenCalledWith("taskkill", ["/pid", "9999", "/T", "/F"]);
    expect(fakeChild.kill).not.toHaveBeenCalled();
  });

  it("before-quit handler does not throw when backendChild is still null (no backend spawned yet)", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const electron = await import("electron");
    // @ts-ignore
    electron.app.requestSingleInstanceLock = vi.fn(() => true);
    (electron.app.on as ReturnType<typeof vi.fn>).mockClear();

    await import("./main.js");

    const onSpy = electron.app.on as ReturnType<typeof vi.fn>;
    const beforeQuitCall = onSpy.mock.calls.find((c: unknown[]) => c[0] === "before-quit");
    expect(beforeQuitCall).toBeDefined();

    expect(() => (beforeQuitCall![1] as () => void)()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// open-ticket-detail IPC handler — Finding 1: readiness guard
//
// The handler is registered at module-level via ipcMain.on. We use a fresh
// module import per test (vi.resetModules() in beforeEach) and always pick the
// LAST registered handler so we get the one from the current import, not a
// stale one accumulated from earlier tests. The BrowserWindow mock is primed
// before invoking the handler because the handler calls createDetailWindow()
// (new BrowserWindow()) lazily on first use.
// ---------------------------------------------------------------------------
describe("open-ticket-detail IPC handler (readiness guard)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // Build a BrowserWindow fake with controllable isLoading().
  function makeFakeWindow(isLoadingReturnValue: boolean) {
    return {
      loadFile: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
      on: vi.fn(),
      webContents: {
        send: vi.fn(),
        isLoading: vi.fn(() => isLoadingReturnValue),
        once: vi.fn(),
      },
    };
  }

  // Import a fresh module and extract the LAST "open-ticket-detail" handler.
  // "Last" is correct because vi.resetModules() + re-import means the mock's
  // call list grows by one entry per test; the handler we want is always the
  // newest (last) one.
  async function importAndGetHandler() {
    const electron = await import("electron");
    const ipcMainMock = electron.ipcMain as unknown as {
      on: ReturnType<typeof vi.fn>;
    };

    await import("./main.js");

    const allCalls: unknown[][] = ipcMainMock.on.mock.calls;
    // Walk backwards to find the most-recently registered "open-ticket-detail".
    let handlerFn: ((_event: unknown, ticket: unknown) => void) | undefined;
    for (let i = allCalls.length - 1; i >= 0; i--) {
      if (allCalls[i][0] === "open-ticket-detail") {
        handlerFn = allCalls[i][1] as (_event: unknown, ticket: unknown) => void;
        break;
      }
    }
    expect(handlerFn).toBeDefined();
    return {
      handler: handlerFn!,
      BrowserWindowMock: electron.BrowserWindow as unknown as ReturnType<typeof vi.fn>,
    };
  }

  it("when NOT loading: sends ticket-detail-data immediately and shows window", async () => {
    const { handler, BrowserWindowMock } = await importAndGetHandler();

    // Prime the mock BEFORE invoking the handler (handler calls new BrowserWindow()).
    const fakeWin = makeFakeWindow(false);
    BrowserWindowMock.mockImplementationOnce(() => fakeWin);

    const ticket = { id: 1, title: "Ticket A" };
    handler(null, ticket);

    expect(fakeWin.webContents.send).toHaveBeenCalledWith("ticket-detail-data", ticket);
    expect(fakeWin.show).toHaveBeenCalled();
    // once() must NOT have been registered.
    expect(fakeWin.webContents.once).not.toHaveBeenCalled();
  });

  it("when loading: does NOT send immediately and registers did-finish-load via once()", async () => {
    const { handler, BrowserWindowMock } = await importAndGetHandler();

    const fakeWin = makeFakeWindow(true);
    BrowserWindowMock.mockImplementationOnce(() => fakeWin);

    const ticket = { id: 2, title: "Ticket B" };
    handler(null, ticket);

    // Must not have sent yet.
    expect(fakeWin.webContents.send).not.toHaveBeenCalled();
    expect(fakeWin.show).not.toHaveBeenCalled();
    // Must have registered a did-finish-load listener via once().
    expect(fakeWin.webContents.once).toHaveBeenCalledWith(
      "did-finish-load",
      expect.any(Function)
    );
  });

  it("when loading: did-finish-load callback sends the buffered ticket and shows the window", async () => {
    const { handler, BrowserWindowMock } = await importAndGetHandler();

    const fakeWin = makeFakeWindow(true);
    BrowserWindowMock.mockImplementationOnce(() => fakeWin);

    const ticket = { id: 3, title: "Ticket C" };
    handler(null, ticket);

    // Retrieve and fire the did-finish-load callback registered via once().
    const onceCall = (fakeWin.webContents.once as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "did-finish-load"
    );
    expect(onceCall).toBeDefined();
    (onceCall![1] as () => void)();

    expect(fakeWin.webContents.send).toHaveBeenCalledWith("ticket-detail-data", ticket);
    expect(fakeWin.show).toHaveBeenCalled();
  });

  it("second click while loading overwrites pending ticket; only ONE once() listener is registered", async () => {
    const { handler, BrowserWindowMock } = await importAndGetHandler();

    // First call creates detailWin (new BrowserWindow). Subsequent calls reuse it.
    const fakeWin = makeFakeWindow(true);
    BrowserWindowMock.mockImplementationOnce(() => fakeWin);

    const ticketA = { id: "4", title: "Ticket D (first)" };
    const ticketB = { id: "5", title: "Ticket E (second)" };

    handler(null, ticketA); // detailWin created, pendingDetailTicket = ticketA, once() registered
    handler(null, ticketB); // detailWin reused, pendingDetailTicket overwritten to ticketB, NO new once()

    // Only ONE did-finish-load listener must exist — the second click must not add another.
    const onceCallsForFinishLoad = (fakeWin.webContents.once as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "did-finish-load"
    );
    expect(onceCallsForFinishLoad).toHaveLength(1);

    // Fire the single did-finish-load callback.
    (onceCallsForFinishLoad[0][1] as () => void)();

    // Must deliver the LATEST ticket (ticketB), not the stale first one.
    expect(fakeWin.webContents.send).toHaveBeenCalledWith("ticket-detail-data", ticketB);
    expect(fakeWin.webContents.send).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// open-ticket-detail IPC handler — toggle-close behaviour
// ---------------------------------------------------------------------------
describe("open-ticket-detail IPC handler (toggle-close)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function makeFakeWindow(isLoadingReturnValue: boolean, isVisibleReturnValue = false) {
    return {
      loadFile: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => isVisibleReturnValue),
      show: vi.fn(),
      hide: vi.fn(),
      on: vi.fn(),
      webContents: {
        send: vi.fn(),
        isLoading: vi.fn(() => isLoadingReturnValue),
        once: vi.fn(),
      },
    };
  }

  async function importAndGetHandler() {
    const electron = await import("electron");
    const ipcMainMock = electron.ipcMain as unknown as {
      on: ReturnType<typeof vi.fn>;
    };

    await import("./main.js");

    const allCalls: unknown[][] = ipcMainMock.on.mock.calls;
    let handlerFn: ((_event: unknown, ticket: unknown) => void) | undefined;
    for (let i = allCalls.length - 1; i >= 0; i--) {
      if (allCalls[i][0] === "open-ticket-detail") {
        handlerFn = allCalls[i][1] as (_event: unknown, ticket: unknown) => void;
        break;
      }
    }
    expect(handlerFn).toBeDefined();
    return {
      handler: handlerFn!,
      BrowserWindowMock: electron.BrowserWindow as unknown as ReturnType<typeof vi.fn>,
    };
  }

  it("same url while visible → data re-sent idempotently, hide NOT called", async () => {
    const { handler, BrowserWindowMock } = await importAndGetHandler();

    // First call: window hidden → open it.
    const fakeWin = makeFakeWindow(false, false);
    BrowserWindowMock.mockImplementationOnce(() => fakeWin);

    const ticket = { url: "https://github.com/org/repo/issues/1", title: "A" };
    handler(null, ticket);

    expect(fakeWin.show).toHaveBeenCalled();
    expect(fakeWin.webContents.send).toHaveBeenCalledWith("ticket-detail-data", ticket);

    // Now simulate the window being visible.
    (fakeWin.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // Second call with the same url — must NOT toggle off; must re-send data
    // (idempotent poll refresh).
    handler(null, { url: "https://github.com/org/repo/issues/1" });

    expect(fakeWin.hide).not.toHaveBeenCalled();
    // send should have been called a second time with the updated ticket.
    expect(fakeWin.webContents.send).toHaveBeenCalledTimes(2);
  });

  it("switch ticket: different url while visible → send called with new ticket, hide NOT called", async () => {
    const { handler, BrowserWindowMock } = await importAndGetHandler();

    const fakeWin = makeFakeWindow(false, false);
    BrowserWindowMock.mockImplementationOnce(() => fakeWin);

    handler(null, { url: "https://github.com/org/repo-a/issues/42", title: "First" });
    expect(fakeWin.show).toHaveBeenCalled();

    (fakeWin.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const secondTicket = { url: "https://github.com/org/repo-b/issues/42", title: "Second" };
    handler(null, secondTicket);

    // hide must NOT have been called — different urls even though same issue number.
    expect(fakeWin.hide).not.toHaveBeenCalled();
    // send called for first (open) and second (switch).
    expect(fakeWin.webContents.send).toHaveBeenCalledWith("ticket-detail-data", secondTicket);
    expect(fakeWin.webContents.send).toHaveBeenCalledTimes(2);
  });

  it("no url (legacy ticket): two identical calls do NOT toggle off; both show/send normally", async () => {
    const { handler, BrowserWindowMock } = await importAndGetHandler();

    const fakeWin = makeFakeWindow(false, false);
    BrowserWindowMock.mockImplementationOnce(() => fakeWin);

    // No url field — null !== null is false so toggle never fires.
    const legacyTicket = { title: "X", body: "Y" };
    handler(null, legacyTicket);

    expect(fakeWin.show).toHaveBeenCalled();
    expect(fakeWin.webContents.send).toHaveBeenCalledWith("ticket-detail-data", legacyTicket);

    // Simulate visible.
    (fakeWin.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(true);

    // Second call with same legacy ticket (no url) — must NOT toggle off; must switch.
    handler(null, legacyTicket);

    expect(fakeWin.hide).not.toHaveBeenCalled();
    // send called twice (once for each call).
    expect(fakeWin.webContents.send).toHaveBeenCalledTimes(2);
  });

  it("toggle while loading: two same-url calls while loading → no crash; once() guard still functions", async () => {
    const { handler, BrowserWindowMock } = await importAndGetHandler();

    const fakeWin = makeFakeWindow(true, false); // loading, hidden
    BrowserWindowMock.mockImplementationOnce(() => fakeWin);

    const ticket = { url: "https://github.com/org/repo/issues/3", title: "Loading ticket" };
    handler(null, ticket);
    // No crash, once() registered.
    expect(fakeWin.webContents.once).toHaveBeenCalledWith("did-finish-load", expect.any(Function));

    // Second call with same url while still loading and hidden — buffering logic.
    handler(null, ticket);

    // Still only one once() listener.
    const onceFinishLoad = (fakeWin.webContents.once as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "did-finish-load"
    );
    expect(onceFinishLoad).toHaveLength(1);

    // Fire the callback — should send + show.
    (onceFinishLoad[0][1] as () => void)();
    expect(fakeWin.webContents.send).toHaveBeenCalledWith("ticket-detail-data", ticket);
    expect(fakeWin.show).toHaveBeenCalled();
  });

  it("close-path reset: after window is hidden via close handler, same-url ticket reopens the window", async () => {
    const { handler, BrowserWindowMock } = await importAndGetHandler();

    const fakeWin = makeFakeWindow(false, false);
    BrowserWindowMock.mockImplementationOnce(() => fakeWin);

    const ticket = { url: "https://github.com/org/repo/issues/7", title: "Closeable" };

    // Open the window.
    handler(null, ticket);
    expect(fakeWin.show).toHaveBeenCalledTimes(1);

    // Simulate hiding via the close handler (fires win.on("close") which calls
    // win.hide() and resets currentDetailTicketUrl). We retrieve that handler
    // from the on() spy and invoke it, then simulate the window becoming hidden.
    const onSpy = fakeWin.on as ReturnType<typeof vi.fn>;
    const closeCall = onSpy.mock.calls.find((c: unknown[]) => c[0] === "close");
    expect(closeCall).toBeDefined();
    const fakeEvent = { preventDefault: vi.fn() };
    (closeCall![1] as (e: typeof fakeEvent) => void)(fakeEvent);
    // Window is now hidden; toggle key cleared.
    (fakeWin.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(false);

    // Clicking the same ticket again must show the window, not toggle it off.
    handler(null, ticket);
    expect(fakeWin.show).toHaveBeenCalledTimes(2);
    expect(fakeWin.webContents.send).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// createTray — Finding 2: tray toggle hides/restores detail window
// ---------------------------------------------------------------------------
describe("createTray — detail window visibility on toggle", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("hiding via tray also hides detailWin when it is visible", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => true),
      show: vi.fn(),
      hide: vi.fn(),
    };
    const mockDetailWin = {
      isVisible: vi.fn(() => true),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any, () => mockDetailWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;
    const clickCall = trayInstance.on.mock.calls.find((c: unknown[]) => c[0] === "click");
    (clickCall![1] as () => void)();

    expect(mockWin.hide).toHaveBeenCalled();
    expect(mockDetailWin.hide).toHaveBeenCalled();
  });

  it("hiding via tray does NOT hide detailWin when detailWin is not visible", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => true),
      show: vi.fn(),
      hide: vi.fn(),
    };
    const mockDetailWin = {
      isVisible: vi.fn(() => false), // already hidden
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any, () => mockDetailWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;
    const clickCall = trayInstance.on.mock.calls.find((c: unknown[]) => c[0] === "click");
    (clickCall![1] as () => void)();

    expect(mockWin.hide).toHaveBeenCalled();
    expect(mockDetailWin.hide).not.toHaveBeenCalled();
  });

  it("hiding via tray is safe when getDetailWin returns null (no getter crash)", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => true),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    // Pass a getter that returns null — simulates the window not yet created.
    expect(() => {
      createTray(mockWin as any, () => null);
      const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
      const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;
      const clickCall = trayInstance.on.mock.calls.find((c: unknown[]) => c[0] === "click");
      (clickCall![1] as () => void)();
    }).not.toThrow();

    expect(mockWin.hide).toHaveBeenCalled();
  });

  it("hiding via tray is safe when no getDetailWin is provided (no getter crash)", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => true),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    // No second argument — exercises the optional-getter code path.
    expect(() => {
      createTray(mockWin as any);
      const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
      const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;
      const clickCall = trayInstance.on.mock.calls.find((c: unknown[]) => c[0] === "click");
      (clickCall![1] as () => void)();
    }).not.toThrow();

    expect(mockWin.hide).toHaveBeenCalled();
  });

  it("showing via tray (panel was hidden) does NOT call detailWin.show", async () => {
    const electron = await import("electron");

    const mockWin = {
      isVisible: vi.fn(() => false), // panel is hidden → toggle shows it
      show: vi.fn(),
      hide: vi.fn(),
    };
    const mockDetailWin = {
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any, () => mockDetailWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;
    const clickCall = trayInstance.on.mock.calls.find((c: unknown[]) => c[0] === "click");
    (clickCall![1] as () => void)();

    expect(mockWin.show).toHaveBeenCalled();
    expect(mockWin.hide).not.toHaveBeenCalled();
    // Detail window is NOT auto-restored — user re-opens it by clicking a card.
    expect(mockDetailWin.show).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// hide-ticket-detail IPC handler
// ---------------------------------------------------------------------------
describe("hide-ticket-detail IPC handler", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function makeFakeWindow(isLoadingReturnValue: boolean, isVisibleReturnValue = false) {
    return {
      loadFile: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => isVisibleReturnValue),
      show: vi.fn(),
      hide: vi.fn(),
      on: vi.fn(),
      webContents: {
        send: vi.fn(),
        isLoading: vi.fn(() => isLoadingReturnValue),
        once: vi.fn(),
      },
    };
  }

  async function importHandlers() {
    const electron = await import("electron");
    const ipcMainMock = electron.ipcMain as unknown as { on: ReturnType<typeof vi.fn> };
    await import("./main.js");

    const allCalls: unknown[][] = ipcMainMock.on.mock.calls;
    let openHandler: ((_event: unknown, ticket: unknown) => void) | undefined;
    let hideHandler: ((_event: unknown) => void) | undefined;
    for (let i = allCalls.length - 1; i >= 0; i--) {
      if (allCalls[i][0] === "open-ticket-detail" && !openHandler) {
        openHandler = allCalls[i][1] as (_event: unknown, ticket: unknown) => void;
      }
      if (allCalls[i][0] === "hide-ticket-detail" && !hideHandler) {
        hideHandler = allCalls[i][1] as (_event: unknown) => void;
      }
      if (openHandler && hideHandler) break;
    }
    expect(openHandler).toBeDefined();
    expect(hideHandler).toBeDefined();
    return {
      openHandler: openHandler!,
      hideHandler: hideHandler!,
      BrowserWindowMock: electron.BrowserWindow as unknown as ReturnType<typeof vi.fn>,
    };
  }

  it("visible window: hide-ticket-detail hides the window", async () => {
    const { openHandler, hideHandler, BrowserWindowMock } = await importHandlers();

    const fakeWin = makeFakeWindow(false, false);
    BrowserWindowMock.mockImplementationOnce(() => fakeWin);

    const ticket = { url: "https://github.com/org/repo/issues/1", title: "T" };
    openHandler(null, ticket);
    expect(fakeWin.show).toHaveBeenCalled();

    (fakeWin.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(true);

    hideHandler(null);
    expect(fakeWin.hide).toHaveBeenCalled();
  });

  it("hide-ticket-detail clears currentDetailTicketUrl so same ticket can reopen", async () => {
    const { openHandler, hideHandler, BrowserWindowMock } = await importHandlers();

    const fakeWin = makeFakeWindow(false, false);
    BrowserWindowMock.mockImplementationOnce(() => fakeWin);

    const ticket = { url: "https://github.com/org/repo/issues/5", title: "T" };
    openHandler(null, ticket);
    expect(fakeWin.show).toHaveBeenCalledTimes(1);

    (fakeWin.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(true);
    hideHandler(null);
    expect(fakeWin.hide).toHaveBeenCalled();

    // Simulate window now hidden after hide
    (fakeWin.isVisible as ReturnType<typeof vi.fn>).mockReturnValue(false);

    // Open same ticket again — must show (URL was cleared by hide, so no stale
    // toggle-key issue even if toggle-off logic were still present)
    openHandler(null, ticket);
    expect(fakeWin.show).toHaveBeenCalledTimes(2);
    expect(fakeWin.webContents.send).toHaveBeenCalledTimes(2);
  });

  it("hide-ticket-detail is a no-op when no detail window exists", async () => {
    const { hideHandler } = await importHandlers();
    // detailWin is null at this point — must not throw
    expect(() => hideHandler(null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// detail-closed broadcast
// ---------------------------------------------------------------------------
describe("detail-closed broadcast", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function makeFakeDetailWindow() {
    return {
      loadFile: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => false),
      show: vi.fn(),
      hide: vi.fn(),
      on: vi.fn(),
      webContents: {
        send: vi.fn(),
        isLoading: vi.fn(() => false),
        once: vi.fn(),
      },
    };
  }

  it("createDetailWindow close handler broadcasts 'detail-closed' to all windows", async () => {
    const electron = await import("electron");
    const BW = electron.BrowserWindow as unknown as ReturnType<typeof vi.fn> & {
      getAllWindows: ReturnType<typeof vi.fn>;
    };

    // A fake main-renderer window that should receive the broadcast
    const fakeMainWin = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    };
    BW.getAllWindows = vi.fn(() => [fakeMainWin]);

    const fakeDetailWin = makeFakeDetailWindow();
    BW.mockImplementationOnce(() => fakeDetailWin);

    const { createDetailWindow } = await import("./main.js");
    createDetailWindow();

    const onSpy = fakeDetailWin.on as ReturnType<typeof vi.fn>;
    const closeCall = onSpy.mock.calls.find((c: unknown[]) => c[0] === "close");
    expect(closeCall).toBeDefined();

    const fakeEvent = { preventDefault: vi.fn() };
    (closeCall![1] as (e: typeof fakeEvent) => void)(fakeEvent);

    expect(fakeMainWin.webContents.send).toHaveBeenCalledWith("detail-closed");
  });

  it("tray hide broadcasts 'detail-closed' to all windows", async () => {
    const electron = await import("electron");
    const BW = electron.BrowserWindow as unknown as ReturnType<typeof vi.fn> & {
      getAllWindows: ReturnType<typeof vi.fn>;
    };

    const fakeMainWin = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    };
    BW.getAllWindows = vi.fn(() => [fakeMainWin]);

    const mockWin = {
      isVisible: vi.fn(() => true),
      show: vi.fn(),
      hide: vi.fn(),
    };
    const mockDetailWin = {
      isVisible: vi.fn(() => true),
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any, () => mockDetailWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;
    const clickCall = trayInstance.on.mock.calls.find((c: unknown[]) => c[0] === "click");
    (clickCall![1] as () => void)();

    expect(mockDetailWin.hide).toHaveBeenCalled();
    expect(fakeMainWin.webContents.send).toHaveBeenCalledWith("detail-closed");
  });

  it("tray hide does NOT broadcast 'detail-closed' when detailWin is not visible", async () => {
    const electron = await import("electron");
    const BW = electron.BrowserWindow as unknown as ReturnType<typeof vi.fn> & {
      getAllWindows: ReturnType<typeof vi.fn>;
    };

    const fakeMainWin = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    };
    BW.getAllWindows = vi.fn(() => [fakeMainWin]);

    const mockWin = {
      isVisible: vi.fn(() => true),
      show: vi.fn(),
      hide: vi.fn(),
    };
    const mockDetailWin = {
      isVisible: vi.fn(() => false), // already hidden
      show: vi.fn(),
      hide: vi.fn(),
    };

    const { createTray } = await import("./main.js");
    createTray(mockWin as any, () => mockDetailWin as any);

    const TrayCtor = electron.Tray as unknown as ReturnType<typeof vi.fn>;
    const trayInstance = TrayCtor.mock.results[TrayCtor.mock.results.length - 1].value;
    const clickCall = trayInstance.on.mock.calls.find((c: unknown[]) => c[0] === "click");
    (clickCall![1] as () => void)();

    expect(mockDetailWin.hide).not.toHaveBeenCalled();
    expect(fakeMainWin.webContents.send).not.toHaveBeenCalledWith("detail-closed");
  });
});

// ---------------------------------------------------------------------------
// Single-instance lock — a second launch must not spawn a second Electron +
// backend process pair (two backends independently polling/mutating the same
// shared state files was a real source of intermittent contention).
// ---------------------------------------------------------------------------
describe("single-instance lock", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // The electron mock's `app` object is created once by the vi.mock() factory
  // and reused (with accumulating mock.calls) across every test in this file
  // — vi.resetModules() only clears the module registry, not spy call
  // history. Each test below explicitly mockClear()s the spies it inspects,
  // right before importing "./main.js", so assertions only see calls made
  // during that test's own import.

  it("quits immediately and registers no lifecycle handlers when the lock is not obtained", async () => {
    const electron = await import("electron");
    // @ts-ignore — override mock: another instance already holds the lock.
    electron.app.requestSingleInstanceLock = vi.fn(() => false);
    (electron.app.quit as ReturnType<typeof vi.fn>).mockClear();
    (electron.app.on as ReturnType<typeof vi.fn>).mockClear();

    await import("./main.js");

    expect(electron.app.quit).toHaveBeenCalled();

    const onSpy = electron.app.on as ReturnType<typeof vi.fn>;
    const registered = onSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(registered).not.toContain("second-instance");
    expect(registered).not.toContain("window-all-closed");
    expect(registered).not.toContain("before-quit");
  });

  it("registers window-all-closed/before-quit and does not quit when the lock is obtained", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.requestSingleInstanceLock = vi.fn(() => true);
    (electron.app.quit as ReturnType<typeof vi.fn>).mockClear();
    (electron.app.on as ReturnType<typeof vi.fn>).mockClear();

    await import("./main.js");

    expect(electron.app.quit).not.toHaveBeenCalled();

    const onSpy = electron.app.on as ReturnType<typeof vi.fn>;
    const registered = onSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(registered).toContain("second-instance");
    expect(registered).toContain("window-all-closed");
    expect(registered).toContain("before-quit");
  });

  it("second-instance handler is a no-op when no window has been created yet", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.requestSingleInstanceLock = vi.fn(() => true);
    (electron.app.on as ReturnType<typeof vi.fn>).mockClear();

    await import("./main.js");

    const onSpy = electron.app.on as ReturnType<typeof vi.fn>;
    const secondInstanceCall = onSpy.mock.calls.find(
      (c: unknown[]) => c[0] === "second-instance"
    );
    expect(secondInstanceCall).toBeDefined();

    // bootstrap() (which sets the module-level main window) only runs under
    // a real app.whenReady(), which the VITEST guard skips — so at this
    // point there is no window yet. The handler must guard against that
    // rather than throwing.
    expect(() => (secondInstanceCall![1] as () => void)()).not.toThrow();
  });
});
