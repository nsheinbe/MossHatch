import { useState } from "react";
import { explain } from "../lib/account";
import { saveContact, type ContactInput } from "../lib/orders";

const EMPTY: ContactInput = { name: "", email: "", phone: "", street: "", city: "", region: "", postalCode: "", country: "US" };
const FIELDS: { key: keyof ContactInput; label: string; auto: string; type?: string }[] = [
  { key: "name", label: "Full name", auto: "name" },
  { key: "phone", label: "Phone, like +1.5555550100", auto: "tel" },
  { key: "street", label: "Street address", auto: "street-address" },
  { key: "city", label: "City", auto: "address-level2" },
  { key: "region", label: "State or region", auto: "address-level1" },
  { key: "postalCode", label: "Postal code", auto: "postal-code" },
  { key: "country", label: "Country, two letters", auto: "country" },
];

/** The registrant contact (C-15). The email is the person's verified sign-in address, so the ICANN verification has a real mailbox. */
export function ContactForm({ email, onSaved }: { email: string; onSaved: () => void }) {
  const [v, setV] = useState<ContactInput>({ ...EMPTY, email });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await saveContact(v); onSaved(); } catch (x) { setErr(explain(x)); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit}>
      <p>Every domain needs a registrant. This is you. We keep it private where the registry allows.</p>
      {FIELDS.map((f) => (
        <div key={f.key} style={{ marginBottom: 8 }}>
          <label htmlFor={`c-${f.key}`}>{f.label}</label>
          <input id={`c-${f.key}`} className="text-input" autoComplete={f.auto} required value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
        </div>
      ))}
      <p className="notice">Registrant email: {email}</p>
      {err && <p role="alert" className="notice" style={{ color: "var(--st-attention)" }}>{err}</p>}
      <div className="row-actions"><button type="submit" className="btn primary" disabled={busy}>Save contact</button></div>
    </form>
  );
}
