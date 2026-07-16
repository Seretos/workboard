import { useState } from "react";
import { DEFAULT_FILTER_SETTINGS, FILTER_SETTINGS_STORAGE_KEY, type FilterSettings } from "../filters";

function loadFilterSettings(): FilterSettings {
  try {
    const raw = localStorage.getItem(FILTER_SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_FILTER_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<FilterSettings>;
    return { ...DEFAULT_FILTER_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_FILTER_SETTINGS };
  }
}

export function useFilterSettings(): [
  FilterSettings,
  <K extends keyof FilterSettings>(key: K, value: FilterSettings[K]) => void
] {
  const [settings, setSettings] = useState<FilterSettings>(loadFilterSettings);

  function updateSetting<K extends keyof FilterSettings>(key: K, value: FilterSettings[K]): void {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(FILTER_SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore quota errors
      }
      return next;
    });
  }

  return [settings, updateSetting];
}
