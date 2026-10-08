import { useEffect } from "react";
import { api, ApiError } from "./api";
import { whoAmI } from "./account";
import { useUi } from "../store";

/** Server policy (PLAN 4.3b, ST-52): a session ends after 15 minutes without a request, and after 8 hours whatever happens. */
export const SESSION_IDLE_MINUTES = 15;
const TOUCH_EVERY_MS = 5 * 60_000;
export const SESSION_ENDED_NOTICE = `Your session ended after ${SESSION_IDLE_MINUTES} minutes without activity, so that was not saved. Sign in again to carry on where you were; what you typed is kept until you do.`;

let lastTouch = 0;

/**
 * Keeps a signed-in session alive while the person is actually doing something: typing a contact, reading the checkout sheet,
 * editing DNS. Real input (a key, a pointer, a form field) asks the server for the session at most once every five minutes, and
 * that request renews the idle clock. Nothing is sent while the tab is left alone, so the 15-minute idle rule still ends an
 * abandoned session (the one that lost a registrant contact typed over 17 minutes on 2026-10-08).
 */
export function useSessionKeepalive(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    lastTouch = Date.now();
    const onActivity = () => {
      const now = Date.now();
      if (now - lastTouch < TOUCH_EVERY_MS) return;
      lastTouch = now;
      void api("GET", "/api/v1/session").catch(() => undefined);
    };
    const events = ["pointerdown", "keydown", "input"] as const;
    for (const ev of events) window.addEventListener(ev, onActivity, { capture: true, passive: true });
    return () => { for (const ev of events) window.removeEventListener(ev, onActivity, { capture: true }); };
  }, [active]);
}

/**
 * A 401 while the page believes someone is signed in means the session ended: idle, the 8-hour limit, or revoked from another
 * device. The server is asked first, so a 401 that means something else stays with the caller. Returns true when it took over:
 * the account is cleared, the sign-in panel opens with a note, and the caller shows nothing more.
 */
export async function sessionEnded(e: unknown): Promise<boolean> {
  if (!(e instanceof ApiError) || e.status !== 401) return false;
  let me = null;
  try { me = await whoAmI(); } catch { /* unreachable: treated as ended */ }
  if (me) return false;
  useUi.getState().set({ account: null, accountOpen: true, accountNotice: SESSION_ENDED_NOTICE });
  return true;
}
