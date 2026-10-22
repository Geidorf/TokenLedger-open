import { useCallback, useSyncExternalStore } from 'react';

export type ThemeMode = 'light' | 'dark' | 'auto';
export type EffectiveTheme = 'light' | 'dark';

const STORAGE_KEY = 'tokenledger:theme';

interface ThemeSnapshot {
  mode: ThemeMode;
  effective: EffectiveTheme;
}

const subscribers = new Set<() => void>();
let mediaQuery: MediaQueryList | null = null;
let browserListenersInstalled = false;

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'auto';
  const value = window.localStorage.getItem(STORAGE_KEY);
  return value === 'light' || value === 'dark' || value === 'auto' ? value : 'auto';
}

function systemPrefersLight(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}

export function resolveEffectiveTheme(mode: ThemeMode, prefersLight: boolean): EffectiveTheme {
  return mode === 'auto' ? (prefersLight ? 'light' : 'dark') : mode;
}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
  return mode === 'auto' ? 'light' : mode === 'light' ? 'dark' : 'auto';
}

let snapshot: ThemeSnapshot = {
  mode: readStoredMode(),
  effective: resolveEffectiveTheme(readStoredMode(), systemPrefersLight()),
};

function applyDocumentTheme(theme: EffectiveTheme) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

function syncNativeWindowTheme(theme: EffectiveTheme) {
  if (typeof window === 'undefined') return;
  const internals = (window as Window & {
    __TAURI_INTERNALS__?: {
      metadata?: {
        currentWindow?: {
          label?: string;
        };
      };
    };
  }).__TAURI_INTERNALS__;
  // Browser fixtures and partially bootstrapped WebViews can expose the
  // marker without the metadata required by getCurrentWindow(). Treat that
  // as a non-native surface and keep theme changes warning-free.
  if (!internals?.metadata?.currentWindow?.label) return;
  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(theme))
    .catch((error) => console.warn('无法同步原生窗口主题:', error));
}

function publish(next: ThemeSnapshot, persist: boolean) {
  const changed = next.mode !== snapshot.mode || next.effective !== snapshot.effective;
  snapshot = next;
  applyDocumentTheme(next.effective);

  if (persist && typeof window !== 'undefined') {
    try {
      if (next.mode === 'auto') window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, next.mode);
    } catch {
      // A restricted WebView can reject storage while the visual theme still works.
    }
  }

  syncNativeWindowTheme(next.effective);
  if (changed) subscribers.forEach((notify) => notify());
}

function installBrowserListeners() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function' || browserListenersInstalled) return;
  browserListenersInstalled = true;
  mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
  mediaQuery?.addEventListener?.('change', (event) => {
    if (snapshot.mode !== 'auto') return;
    publish({ mode: 'auto', effective: resolveEffectiveTheme('auto', event.matches) }, false);
  });
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    const mode = readStoredMode();
    publish({ mode, effective: resolveEffectiveTheme(mode, systemPrefersLight()) }, false);
  });
}

export function initializeTheme() {
  installBrowserListeners();
  const mode = readStoredMode();
  publish({ mode, effective: resolveEffectiveTheme(mode, systemPrefersLight()) }, false);
}

function subscribe(notify: () => void) {
  installBrowserListeners();
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

function getSnapshot() {
  return snapshot;
}

const SERVER_SNAPSHOT: ThemeSnapshot = { mode: 'auto', effective: 'dark' };

function getServerSnapshot() {
  return SERVER_SNAPSHOT;
}

function setThemeMode(mode: ThemeMode) {
  publish({ mode, effective: resolveEffectiveTheme(mode, systemPrefersLight()) }, true);
}

export function useTheme() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const set = useCallback((mode: ThemeMode) => setThemeMode(mode), []);
  const cycle = useCallback(() => setThemeMode(nextThemeMode(getSnapshot().mode)), []);
  return { ...current, set, cycle };
}
