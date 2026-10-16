import { useEffect, useRef, useState } from "react";
import { normalizePhone } from "@mosshatch/core";
import { explain } from "../lib/account";
import { saveContact, type ContactInput } from "../lib/orders";
import { sessionEnded } from "../lib/session";

const EMPTY: ContactInput = { name: "", email: "", phone: "", street: "", city: "", region: "", postalCode: "", country: "US" };
export const PHONE_HINT = "Any usual way of writing it works, like (310) 555-0100 or +44 20 7946 0958. We keep it in the registry's own format.";
export const PHONE_PROBLEM = "Check the phone number. Write it the way you would dial it from the country below, with the area code, or start it with + and the country code.";
interface Field { key: keyof ContactInput; label: string; auto: string; type?: string; inputMode?: "tel"; hint?: string; maxLength?: number }
const FIELDS: Field[] = [
  { key: "name", label: "Full name", auto: "name" },
  { key: "phone", label: "Phone", auto: "tel", type: "tel", inputMode: "tel", hint: PHONE_HINT },
  { key: "street", label: "Street address", auto: "street-address" },
  { key: "city", label: "City", auto: "address-level2" },
  { key: "region", label: "State or region", auto: "address-level1" },
  { key: "postalCode", label: "Postal code", auto: "postal-code" },
  { key: "country", label: "Country, two letters", auto: "country", maxLength: 2 },
];

/** What was typed when a sign-in interrupted the save (the session ended). Memory only, for the same address, cleared once saved. */
let draft: ContactInput | null = null;

/**
 * The registrant contact (C-15). The email is the person's verified sign-in address, so the ICANN verification has a real mailbox.
 * The phone is read on the page first (packages/core phone.ts) so a number typed the everyday way is never refused for its shape,
 * and the server stores the EPP form the registries want.
 */
export function ContactForm({ email, onSaved }: { email: string; onSaved: () => void }) {
  const [v, setV] = useState<ContactInput>(() => (draft && draft.email === email ? draft : { ...EMPTY, email }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  useEffect(() => { draft = v; }, [v]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    const phone = normalizePhone(v.phone, v.country);
    if (!phone) { setErr(PHONE_PROBLEM); phoneRef.current?.focus(); return; }
    setBusy(true);
    try { await saveContact({ ...v, phone, country: v.country.trim().toUpperCase() }); draft = null; onSaved(); }
    catch (x) { if (await sessionEnded(x)) return; setErr(explain(x)); }
    finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} aria-label="Registrant contact">
      <p>Every domain needs a registrant. This is you. We keep it private where the registry allows.</p>
      {FIELDS.map((f) => (
        <div key={f.key} style={{ marginBottom: 8 }}>
          <label htmlFor={`c-${f.key}`}>{f.label}</label>
          <input id={`c-${f.key}`} ref={f.key === "phone" ? phoneRef : undefined} className="text-input" type={f.type ?? "text"} inputMode={f.inputMode} autoComplete={f.auto}
            maxLength={f.maxLength} required aria-describedby={f.hint ? `c-${f.key}-hint` : undefined} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
          {f.hint && <p id={`c-${f.key}-hint`} className="fineprint">{f.hint}</p>}
        </div>
      ))}
      <p className="notice">Registrant email: {email}</p>
      {err && <p role="alert" className="notice" style={{ color: "var(--st-attention)" }}>{err}</p>}
      <div className="row-actions"><button type="submit" className="btn primary" disabled={busy}>Save contact</button></div>
    </form>
  );
}
