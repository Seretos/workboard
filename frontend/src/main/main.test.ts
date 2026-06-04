import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "path";

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
      webContents: { send: vi.fn() },
      getAllWindows: vi.fn(() => []),
    })),
    dialog: {
      showErrorBox: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn(),
    },
    screen: {
      getPrimaryDisplay: vi.fn(() => ({ workAreaSize: { width: 1920, height: 1080 } })),
    },
  };
});

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

  it("calls screen.getPrimaryDisplay to get workAreaSize height", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    createWindow();

    expect(electron.screen.getPrimaryDisplay).toHaveBeenCalled();
  });

  it("constructs BrowserWindow with height from workAreaSize (1080)", async () => {
    const electron = await import("electron");

    const { createWindow } = await import("./main.js");
    createWindow();

    expect(electron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({ height: 1080 })
    );
  });
});
