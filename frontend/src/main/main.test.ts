import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Mock the `electron` module so importing main.ts doesn't need a real Electron
// runtime. We need app.isPackaged and process.resourcesPath to be controllable.
// ---------------------------------------------------------------------------
vi.mock("electron", () => {
  return {
    app: {
      isPackaged: false,
      getVersion: vi.fn(() => "0.0.0"),
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn(),
      quit: vi.fn(),
    },
    BrowserWindow: vi.fn().mockImplementation(() => ({
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
      getAllWindows: vi.fn(() => []),
    })),
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
  })),
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

  it("dev mode → path ends with .seretos/projects.yml", async () => {
    const electron = await import("electron");
    // @ts-ignore
    electron.app.isPackaged = false;

    const { resolveProjectsConfigPath } = await import("./main.js");
    const result = resolveProjectsConfigPath();

    expect(result).not.toBeNull();
    expect(result!.replace(/\\/g, "/")).toMatch(/\.seretos\/projects\.yml$/);
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
});

// ---------------------------------------------------------------------------
// spawnBackend — env wiring
// ---------------------------------------------------------------------------
describe("spawnBackend", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("spawn is called with env containing PROJECT_ISSUES_CONFIG equal to resolveProjectsConfigPath()", async () => {
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
    (cpMock.spawn as ReturnType<typeof vi.fn>).mockReturnValue(fakeChild);

    const { spawnBackend, resolveProjectsConfigPath } = await import("./main.js");
    const expectedConfigPath = resolveProjectsConfigPath();

    // Start but don't await — handshake never resolves in this test; we only
    // care that spawn was called with the right options.
    spawnBackend().catch(() => {});

    expect(cpMock.spawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          PROJECT_ISSUES_CONFIG: expectedConfigPath,
        }),
      })
    );
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

    const ticketA = { id: 4, title: "Ticket D (first)" };
    const ticketB = { id: 5, title: "Ticket E (second)" };

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
