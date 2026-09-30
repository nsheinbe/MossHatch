/**
 * Re-hide timing for a revealed value (PLAN 4.6 row 8, WCAG 2.2.1). The first window is the person's `rehideSeconds`
 * (clamped to 5..100); "Keep showing for 30 more seconds" adds time until the total reaches 100 seconds, never beyond.
 */
export const REHIDE_CAP_SECONDS = 100;
export const EXTEND_SECONDS = 30;
export const REHIDE_CHOICES = [10, 30, 60, 100] as const;

export const firstWindow = (rehideSeconds: number): number =>
  Math.min(REHIDE_CAP_SECONDS, Math.max(5, Math.round(Number.isFinite(rehideSeconds) ? rehideSeconds : 10)));

export interface RehideState { left: number; granted: number }
export const startRehide = (rehideSeconds: number): RehideState => { const s = firstWindow(rehideSeconds); return { left: s, granted: s }; };
export const tick = (s: RehideState): RehideState => ({ ...s, left: Math.max(0, s.left - 1) });
export const canExtend = (s: RehideState): boolean => s.left > 0 && s.granted < REHIDE_CAP_SECONDS;
export function extend(s: RehideState): RehideState {
  if (!canExtend(s)) return s;
  const add = Math.min(EXTEND_SECONDS, REHIDE_CAP_SECONDS - s.granted);
  return { left: s.left + add, granted: s.granted + add };
}

/** The hold that starts a reveal with a pointer (D-010: the keyboard and switch path is a single activation). */
export const HOLD_MS = 1000;

/** Clipboard policy (ST-40): the run command is the primary copy; a value copy is on for dev and preview, off for prod until enabled. */
export const valueCopyAllowed = (env: string, prodCopyEnabled: boolean): boolean => env === "dev" || env === "preview" || (env === "prod" && prodCopyEnabled);
export const runCommand = (fqdn: string, env: string): string => `mosshatch run ${fqdn} --env ${env} -- npm start`;
/** Where `clipboardchange` exists, an unchanged clipboard is overwritten after this long. */
export const CLIPBOARD_CLEAR_MS = 30_000;
