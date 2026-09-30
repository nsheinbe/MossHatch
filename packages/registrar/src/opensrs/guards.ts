import { RegistrarError } from "../port.ts";

/** Kill switch: `writes_paused` still allows reads (the rotation drill's smoke `GET_BALANCE`); `all_paused` blocks every call. */
export type SwitchState = "open" | "writes_paused" | "all_paused";
export interface KillSwitch { read(): SwitchState | Promise<SwitchState> }

export class MemoryKillSwitch implements KillSwitch {
  constructor(public state: SwitchState = "open") {}
  read() { return this.state; }
  set(s: SwitchState) { this.state = s; }
}
/** Fails closed: an unreadable switch, a thrown error or any value other than "open" or "writes_paused" means everything is paused. */
export async function readSwitch(ks: KillSwitch): Promise<SwitchState> {
  try {
    const s = await ks.read();
    return s === "open" || s === "writes_paused" ? s : "all_paused";
  } catch { return "all_paused"; }
}

export interface CredentialSource { read(): { username: string; apiKey: string } }
export class MemoryCredentials implements CredentialSource {
  constructor(private c: { username: string; apiKey: string }) {}
  read() { return { ...this.c }; }
  set(c: { username: string; apiKey: string }) { this.c = { ...c }; }
}

export type FuseClass = "code_issue" | "unlock" | "ns_change" | "contact_change";
/** Own targets from plan 4.3b (raising one is a passkey-approved config change): code issue 5 an hour, unlock 10, nameserver change 20, contact change 10. */
export const DEFAULT_FUSE_LIMITS: Readonly<Record<FuseClass, number>> = { code_issue: 5, unlock: 10, ns_change: 20, contact_change: 10 };

export interface AdapterAlert { kind: "fuse_tripped" | "debit_mismatch" | "auth_failed" | "kill_switch_closed"; detail: string }

/**
 * Velocity fuse across all customers. In-memory here; a multi-instance deployment needs a shared counter behind the same interface
 * (unbuilt: the registrar project's storage is decided with the deployment topology).
 */
export class VelocityFuse {
  private hits = new Map<FuseClass, number[]>();
  constructor(private clock: { now(): Date }, private alert: (a: AdapterAlert) => void, private limits: Readonly<Record<FuseClass, number>> = DEFAULT_FUSE_LIMITS, private windowMs = 3_600_000) {}
  take(cls: FuseClass): void {
    const now = this.clock.now().getTime();
    const list = (this.hits.get(cls) ?? []).filter((t) => t > now - this.windowMs);
    if (list.length >= this.limits[cls]) {
      this.hits.set(cls, list);
      this.alert({ kind: "fuse_tripped", detail: cls });
      throw new RegistrarError("rate_limited", "velocity fuse tripped", { retryable: false, outcomeUnknown: false, code: `fuse_${cls}` });
    }
    list.push(now); this.hits.set(cls, list);
  }
  used(cls: FuseClass): number { const now = this.clock.now().getTime(); return (this.hits.get(cls) ?? []).filter((t) => t > now - this.windowMs).length; }
}
