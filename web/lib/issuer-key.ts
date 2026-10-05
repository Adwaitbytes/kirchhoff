/**
 * The issuer API key lives only in this browser tab (sessionStorage), never in localStorage,
 * never in a cookie and never in the bundle. It authorizes /specs/* and /keys on the API.
 */
const KEY = "kh-issuer-key";

export function getIssuerKey(): string | undefined {
  try {
    const v = sessionStorage.getItem(KEY);
    return v && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function setIssuerKey(value: string): void {
  try {
    if (value.trim()) sessionStorage.setItem(KEY, value.trim());
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the key then has to be entered again on each request screen.
  }
}
