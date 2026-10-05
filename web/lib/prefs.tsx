"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";

export type Theme = "dark" | "light";

const THEME_KEY = "kh-theme";
const STAGE_KEY = "kh-stage";
const SOUND_KEY = "kh-sound";

/**
 * Runs before first paint (inlined in <head>) so neither the theme nor stage mode flashes.
 * `?stage=1` turns stage mode on for the browser session, `?stage=0` turns it off.
 * `?theme=light|dark` overrides the stored theme (used by stage-mode snapshots).
 */
export const PREFS_BOOT_SCRIPT = `(() => {
  try {
    var d = document.documentElement, q = new URLSearchParams(location.search);
    var s = q.get("stage");
    if (s === "1") sessionStorage.setItem("${STAGE_KEY}", "1");
    if (s === "0") sessionStorage.removeItem("${STAGE_KEY}");
    if (sessionStorage.getItem("${STAGE_KEY}") === "1") d.setAttribute("data-stage", "1");
    var t = q.get("theme");
    if (t === "light" || t === "dark") localStorage.setItem("${THEME_KEY}", t);
    var stored = localStorage.getItem("${THEME_KEY}");
    d.setAttribute("data-theme", stored === "light" ? "light" : "dark");
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();`;

interface Prefs {
  theme: Theme;
  setTheme: (t: Theme) => void;
  stage: boolean;
  /** 1.3 in stage mode (PRD section 12), else 1. Multiply every duration by this. */
  motionScale: number;
  /** prefers-reduced-motion: no pulses, no counting, instant state changes. */
  reducedMotion: boolean;
  sound: boolean;
  setSound: (on: boolean) => void;
}

const PrefsContext = createContext<Prefs | null>(null);

function safeGet(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // Storage blocked (private mode): the preference lasts for this page only.
  }
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");
  const [stage, setStage] = useState(false);
  const [sound, setSoundState] = useState(false);
  const reduced = useReducedMotion() ?? false;

  useEffect(() => {
    const d = document.documentElement;
    setThemeState(d.getAttribute("data-theme") === "light" ? "light" : "dark");
    setStage(d.getAttribute("data-stage") === "1");
    setSoundState(safeGet(() => localStorage, SOUND_KEY) === "1");
  }, []);

  const setTheme = useCallback((t: Theme) => {
    document.documentElement.setAttribute("data-theme", t);
    safeSet(() => localStorage, THEME_KEY, t);
    setThemeState(t);
  }, []);

  const setSound = useCallback((on: boolean) => {
    safeSet(() => localStorage, SOUND_KEY, on ? "1" : "0");
    setSoundState(on);
  }, []);

  const value = useMemo<Prefs>(
    () => ({ theme, setTheme, stage, motionScale: stage ? 1.3 : 1, reducedMotion: reduced, sound, setSound }),
    [theme, setTheme, stage, reduced, sound, setSound],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): Prefs {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePrefs must be used inside <PrefsProvider>");
  return ctx;
}

/** Duration in ms adjusted for stage mode, or 0 under reduced motion. */
export function useDuration(): (ms: number) => number {
  const { motionScale, reducedMotion } = usePrefs();
  return useCallback((ms: number) => (reducedMotion ? 0 : Math.round(ms * motionScale)), [motionScale, reducedMotion]);
}
