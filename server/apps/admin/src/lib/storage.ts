/**
 * Per-browser conveniences (theme, language). Storage can be missing or
 * throw (private windows, blocked site data): every access is guarded and
 * the panel works without it.
 */
export function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not persisted; the choice still applies to this page.
  }
}
