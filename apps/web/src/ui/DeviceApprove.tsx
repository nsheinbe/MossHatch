import { useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { ApiError } from "../lib/api";
import { explainDomain } from "../lib/domains";
import { approveDevice, denyDevice, lookupDevice, shownScopes, type DeviceLookup } from "../lib/device";
import { StepUp, type StepUpRequest } from "./StepUp";

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

function explainDevice(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "not_found") return "No sign-in is waiting for that code. Check the code in your terminal. Codes last 10 minutes.";
    if (e.code === "device_code_locked") return "Too many wrong codes. Approval is locked for a while. Start the sign-in again later.";
    if (e.code === "device_login_disabled") return "Command-line sign-in is turned off for your account.";
    if (e.code === "request_unavailable") return "That sign-in is no longer waiting. Start it again in your terminal.";
  }
  return explainDomain(e);
}

/**
 * The approval page for `mosshatch login` (RFC 8628). Lazy chunk, reached at /device. It never reads a code from the URL:
 * the person types the code their own terminal shows (device-code phishing). It shows only what the server observed, and
 * puts what the device said about itself under "reported by the device, not verified". Approval is a passkey step-up that
 * binds the request, the typed code and the exact scopes listed here.
 */
export default function DeviceApprove({ onClose }: { onClose: () => void }) {
  const { apiReady, account, set } = useUi();
  const [code, setCode] = useState("");
  const [found, setFound] = useState<DeviceLookup | null>(null);
  const [envs, setEnvs] = useState<string[]>([]);
  const [prod, setProd] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, []);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !req) onClose(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose, req]);

  const look = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setMsg(null); setFound(null); setBusy(true);
    try { const f = await lookupDevice(code); setFound(f); setEnvs(f.default_envs); setProd([]); }
    catch (e) { setMsg(explainDevice(e)); }
    finally { setBusy(false); }
  };
  const toggle = (list: string[], v: string, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));
  const approve = () => {
    if (!found) return;
    setReq({
      type: "device.approve", target: found.request_id, input: { user_code: code, envs, prod_domains: prod },
      run: async (id) => { await approveDevice(id); setDone("Approved. Your terminal is signed in within a few seconds. We emailed you a note with a revoke link."); setFound(null); setCode(""); },
    });
  };
  const deny = async () => {
    if (!found) return;
    try { await denyDevice(found.request_id, code); setDone("Denied. The terminal gets nothing."); setFound(null); setCode(""); }
    catch (e) { setMsg(explainDevice(e)); }
  };

  return (
    <main>
      <div className="panel ledger device" role="region" aria-labelledby="device-h">
        <div className="head"><h2 id="device-h" ref={head} tabIndex={-1}>Approve a command-line sign-in</h2></div>
        <div className="body">
          {apiReady === false && <p className="notice">Accounts are not connected in this preview.</p>}
          {apiReady && !account && <p className="notice">Sign in first with the Sign in button, then type the code here.</p>}
          <p>Type the code that <code>mosshatch login</code> shows in your terminal. Only do this if you started that sign-in yourself, just now. Nobody from Mosshatch will ever ask you for this code.</p>
          <form className="form-grid" onSubmit={(e) => void look(e)}>
            <label htmlFor="device-code">Code from your terminal</label>
            <input id="device-code" className="text-input" name="device-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 12))}
              autoComplete="off" autoCapitalize="characters" spellCheck={false} inputMode="text" placeholder="XXXX-XXXX" aria-describedby="device-code-hint" />
            <p id="device-code-hint" className="fineprint">Eight letters, like BCDF-GHJK.</p>
            <div className="row-actions"><button type="submit" className="btn primary" disabled={busy || code.replace(/[^A-Z]/g, "").length !== 8 || !account}>Look up</button>
              <button type="button" className="btn secondary" onClick={onClose}>Close</button></div>
          </form>
          {msg && <p role="alert" className="notice">{msg}</p>}
          {done && <p role="status" className="notice">{done}</p>}
          {found && (
            <section className="section" aria-labelledby="device-facts-h">
              <h3 id="device-facts-h">What we saw</h3>
              <dl className="facts">
                <div><dt>Asked from address</dt><dd>{found.observed.address ?? "unknown"}</dd></div>
                <div><dt>Asked at</dt><dd>{when(found.observed.requested_at)}</dd></div>
                <div><dt>Code expires</dt><dd>{when(found.observed.expires_at)}</dd></div>
              </dl>
              <h4>Reported by the device, not verified</h4>
              <p>{found.reported.client_name ?? "No name given"}{found.reported.client_version ? ` ${found.reported.client_version}` : ""}</p>
              <h4>What it will be able to do</h4>
              <fieldset className="plain">
                <legend>Environments</legend>
                {(["dev", "preview"] as const).map((e) => (
                  <label key={e} className="check"><input type="checkbox" checked={envs.includes(e)} onChange={(x) => setEnvs(toggle(envs, e, x.target.checked))} /> {e}</label>
                ))}
              </fieldset>
              {found.prod_choices.length > 0 && (
                <fieldset className="plain">
                  <legend>Production, only for the domains you tick</legend>
                  {found.prod_choices.map((d) => <label key={d} className="check"><input type="checkbox" checked={prod.includes(d)} onChange={(x) => setProd(toggle(prod, d, x.target.checked))} /> {d} (prod)</label>)}
                </fieldset>
              )}
              <ul className="plain">{shownScopes(envs, prod).map((s) => <li key={s}><code>{s}</code></li>)}</ul>
              {req ? <StepUp req={req} onDone={() => setReq(null)} /> : (
                <div className="row-actions">
                  <button type="button" className="btn primary" disabled={envs.length === 0} onClick={approve}>Approve with passkey</button>
                  <button type="button" className="btn secondary" onClick={() => void deny()}>Deny</button>
                </div>
              )}
            </section>
          )}
          <p className="fineprint">You can turn command-line sign-in off, or revoke every sign-in, from your account.{" "}
            <button type="button" className="tag-btn linklike" onClick={() => set({ accountOpen: true })}>Open account</button></p>
        </div>
      </div>
    </main>
  );
}
