// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFilterSettings } from "./useFilterSettings";
import { FILTER_SETTINGS_STORAGE_KEY } from "../filters";

describe("useFilterSettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("initializes with the default settings when localStorage is empty", () => {
    const { result } = renderHook(() => useFilterSettings());
    const [settings] = result.current;
    expect(settings).toEqual({ assignedToMeOnly: false });
  });

  it("set true, then remount initializes true from localStorage", () => {
    const { result, unmount } = renderHook(() => useFilterSettings());
    act(() => {
      const [, update] = result.current;
      update("assignedToMeOnly", true);
    });
    expect(result.current[0].assignedToMeOnly).toBe(true);
    unmount();

    const { result: result2 } = renderHook(() => useFilterSettings());
    expect(result2.current[0].assignedToMeOnly).toBe(true);
  });

  it("corrupt JSON in localStorage falls back to defaults without throwing", () => {
    localStorage.setItem(FILTER_SETTINGS_STORAGE_KEY, "not-valid-json{{{");
    expect(() => {
      const { result } = renderHook(() => useFilterSettings());
      expect(result.current[0]).toEqual({ assignedToMeOnly: false });
    }).not.toThrow();
  });

  it("partial/missing keys are backfilled from defaults", () => {
    localStorage.setItem(FILTER_SETTINGS_STORAGE_KEY, JSON.stringify({}));
    const { result } = renderHook(() => useFilterSettings());
    expect(result.current[0]).toEqual({ assignedToMeOnly: false });
  });

  it("writes the merged settings object back to localStorage on update", () => {
    const { result } = renderHook(() => useFilterSettings());
    act(() => {
      const [, update] = result.current;
      update("assignedToMeOnly", true);
    });
    expect(localStorage.getItem(FILTER_SETTINGS_STORAGE_KEY)).toBe(
      JSON.stringify({ assignedToMeOnly: true })
    );
  });

  it("a write when localStorage.setItem throws is swallowed, not thrown", () => {
    const { result } = renderHook(() => useFilterSettings());
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    expect(() => {
      act(() => {
        const [, update] = result.current;
        update("assignedToMeOnly", true);
      });
    }).not.toThrow();

    // The in-memory state still updates even though the write failed.
    expect(result.current[0].assignedToMeOnly).toBe(true);

    setItemSpy.mockRestore();
  });
});
