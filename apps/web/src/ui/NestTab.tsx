import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { day } from "../lib/domains";
import { deleteSecret, ENVS, explainNest, getNest, getReserved, nameProblem, normalizeName, putSecret, type Env, type NestView, type ReservedNames } from "../lib/nest";
import { Reveal } from "../reveal/Reveal";
import { REHIDE_CHOICES, runCommand } from "../reveal/rehide";

const ENV_WORD: Record<Env, string> = { dev: "Development", preview: "Preview", prod: "Production" };

/**
 * The Nest tab: a domain's secrets by environment. Names are listed, values never are. A value goes up once in a PUT and its field
 * is cleared; the only way back is Reveal (passkey, once, re-hidden). Lazy chunk; nothing here enters the store except the person's
 * re-hide seconds.
 */
export default function NestTab({ fqdn }: { fqdn: string }) {
  const { rehideSeconds, set } = useUi();
  const [env, setEnv] = useState<Env>("dev");
  const [nest, setNest] = useState<NestView | null>(null);
  const [reserved, setReserved] = useState<ReservedNames | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [prodCopy, setProdCopy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const valueRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try { setNest(await getNest(fqdn)); setErr(null); } catch (e) { setErr(explainNest(e)); }
  }, [fqdn]);
  useEffect(() => { setNest(null); void load(); }, [load]);
  useEffect(() => { void getReserved().then(setReserved).catch(() => setReserved(null)); }, []);
  useEffect(() => { setConfirmDel(null); setCopied(null); setMsg(null); }, [env]);

  const list = nest?.envs[env].secrets ?? [];
  const problem = name ? nameProblem(name, reserved) : null;
  const exists = list.some((s) => s.name === normalizeName(name));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null); setFormErr(null);
    const n = normalizeName(name);
    const p = nameProblem(name, reserved);
    if (p) { setFormErr(p); return; }
    const field = valueRef.current;
    if (!field || field.value.length === 0) { setFormErr("Enter the value to store."); return; }
    setBusy(true);
    try {
      // The value is read from the field, sent once, and the field is cleared whatever the answer.
      const v = field.value;
      field.value = "";
      const r = await putSecret(fqdn, env, n, v);
      setMsg(r.created ? `Saved ${r.name} in ${env}.` : `Updated ${r.name} in ${env}. It is now version ${r.version}.`);
      setName("");
      await load();
    } catch (x) { setFormErr(explainNest(x)); }
    finally { if (valueRef.current) valueRef.current.value = ""; setBusy(false); }
  };
  const remove = async (n: string) => {
    setBusy(true); setMsg(null);
    try { const r = await deleteSecret(fqdn, env, n); setMsg(`Deleted ${n} from ${env}. ${r.versions_destroyed} ${r.versions_destroyed === 1 ? "version was" : "versions were"} destroyed.`); setConfirmDel(null); await load(); }
    catch (x) { setMsg(explainNest(x)); }
    finally { setBusy(false); }
  };
  const cmd = runCommand(fqdn, env);
  const copyCmd = async () => {
    try { await navigator.clipboard.writeText(cmd); setCopied("Copied the command. It holds no secret."); } catch { setCopied("Copying did not work. Select the command and copy it."); }
  };

  return (
    <div className="nest">
      <p>The Nest keeps this domain's secrets, encrypted. Names are listed here; values are not. To see a value, hold Reveal and confirm with your passkey. It shows once and hides again.</p>
      {err && <p role="alert" className="notice">{err}</p>}

      <div className="env-switch" role="group" aria-label="Environment">
        {ENVS.map((e) => (
          <button key={e} type="button" aria-pressed={env === e} onClick={() => setEnv(e)}>
            {ENV_WORD[e]}{nest ? ` (${nest.envs[e].count})` : ""}
          </button>
        ))}
      </div>

      <div className="section" role="group" aria-labelledby="nest-run-h">
        <h3 id="nest-run-h">Use them without copying values</h3>
        <p>Run your app with this environment's secrets. The command holds no secret.</p>
        <p><code className="run-cmd">{cmd}</code></p>
        <div className="row-actions"><button type="button" className="btn secondary small" onClick={() => void copyCmd()}>Copy the run command</button></div>
        {copied && <p role="status" className="notice">{copied}</p>}
      </div>

      <div className="section" role="group" aria-labelledby="nest-list-h">
        <h3 id="nest-list-h">{ENV_WORD[env]} secrets</h3>
        {!nest && !err && <p role="status">Loading.</p>}
        {msg && <p role="status" className="notice">{msg}</p>}
        {env === "prod" && (
          <label className="check"><input type="checkbox" checked={prodCopy} onChange={(e) => setProdCopy(e.target.checked)} /> Allow copying production values while one is shown. It is off each time you open the Nest.</label>
        )}
        {nest && list.length === 0 && <p>No secrets in {ENV_WORD[env].toLowerCase()} yet.</p>}
        {list.length > 0 && (
          <ul className="secrets" aria-label={`${ENV_WORD[env]} secret names`}>
            {list.map((s) => (
              <li key={s.id}>
                <div className="secret-row">
                  <span><span className="secret-name">{s.name}</span> <small className="notice">version {s.version}, changed {day(s.updated_at)}</small></span>
                  <button type="button" className="btn secondary small" aria-label={`Delete ${s.name}`} disabled={busy} onClick={() => setConfirmDel(s.name)}>Delete</button>
                </div>
                <Reveal s={{ id: s.id, name: s.name, env, version: s.version }} prodCopy={prodCopy} />
                {confirmDel === s.name && (
                  <div className="stepup" role="group" aria-label={`Confirm deleting ${s.name}`}>
                    <p>Delete {s.name} from {env}? Every version is destroyed and cannot be brought back.</p>
                    <div className="row-actions">
                      <button type="button" className="btn primary small" disabled={busy} onClick={() => void remove(s.name)}>Delete for good</button>
                      <button type="button" className="btn secondary small" disabled={busy} onClick={() => setConfirmDel(null)}>Keep it</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="notice">Revealed values hide again after the time you choose, when you switch tabs or windows, and when you close this panel. Clipboard history or sync may keep anything you copy.</p>
        <label className="inline-select">Hide revealed values after{" "}
          <select value={REHIDE_CHOICES.includes(rehideSeconds as never) ? rehideSeconds : 30} onChange={(e) => set({ rehideSeconds: Number(e.target.value) })}>
            {REHIDE_CHOICES.map((n) => <option key={n} value={n}>{n} seconds</option>)}
          </select>
        </label>
      </div>

      <form className="section form-grid" aria-labelledby="nest-add-h" onSubmit={(e) => void save(e)} autoComplete="off">
        <h3 id="nest-add-h">Add or update a secret in {env}</h3>
        <label>Name, like DATABASE_URL
          <input className="text-input mono" value={name} maxLength={128} autoComplete="off" autoCapitalize="characters" spellCheck={false}
            aria-invalid={!!problem} aria-describedby={problem ? "nest-name-problem" : undefined} onChange={(e) => { setName(e.target.value); setFormErr(null); }} />
        </label>
        {problem && <p id="nest-name-problem" className="warn">{problem}</p>}
        <label>Value
          <textarea ref={valueRef} className="text-input mono value-input" rows={3} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} data-1p-ignore="" data-lpignore="true" />
        </label>
        {formErr && <p role="alert" className="warn">{formErr}</p>}
        <div className="row-actions">
          <button type="submit" className="btn primary" disabled={busy || !!problem}>{exists ? "Update secret" : "Add secret"}</button>
        </div>
        <p className="notice">A value is sent once and this field is cleared. Saving an existing name makes a new version.</p>
      </form>
    </div>
  );
}
