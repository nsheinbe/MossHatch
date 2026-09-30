import { z } from "zod";
import { assertMailSafe, type RenderedMail } from "../mail/templates.ts";
import { NAME_RE } from "./names.ts";

/**
 * The vault's notification emails, from typed templates with strict schemas (no free text, so no value or token can ride
 * in a variable), checked by the shared `assertMailSafe`. Kept here rather than in `mail/templates.ts`, whose test forbids
 * reveal templates in the shared set (no pay or approval links for agent flows).
 */

const when = (s: string) => s.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, " UTC");
const fqdn = z.string().max(253).regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/);
const env = z.enum(["dev", "preview", "prod"]);
const UA: Record<string, string> = { chrome: "Chrome", firefox: "Firefox", safari: "Safari", edge: "Edge", other: "a browser" };

const Revealed = z.strictObject({ name: z.string().regex(NAME_RE), env, fqdn, ua: z.enum(["chrome", "firefox", "safari", "edge", "other"]), at: z.iso.datetime() });
const Digest = z.strictObject({ reads: z.number().int().min(1).max(100_000), prodReads: z.number().int().min(0).max(100_000), bindingRef: z.string().regex(/^[0-9a-f]{8}$/), hour: z.iso.datetime() });
const Incident = z.strictObject({ secrets: z.number().int().min(0).max(1_000_000), unaudited: z.number().int().min(0).max(1_000_000), incidentRef: z.string().regex(/^[0-9a-f]{8}$/) });

export const VAULT_MAIL = {
  revealed(v: z.input<typeof Revealed>, origin: string): RenderedMail {
    const p = Revealed.parse(v);
    const out = {
      subject: "A secret was revealed on your Mosshatch account",
      text: `Secret ${p.name} (${p.env}) on ${p.fqdn} was revealed from ${UA[p.ua]} at ${when(p.at)}.\n\nIf this was not you, sign in, sign out every session and rotate the secret where it was issued. Then write to security@mosshatch.com.\n`,
    };
    assertMailSafe(out, origin, null);
    return out;
  },
  readDigest(v: z.input<typeof Digest>, origin: string): RenderedMail {
    const p = Digest.parse(v);
    const out = {
      subject: "Secrets were read by one of your tokens",
      text: `Your token ending ${p.bindingRef} read ${p.reads} secret${p.reads === 1 ? "" : "s"} in the hour from ${when(p.hour)}, ${p.prodReads} of them from prod.\n\nIf you do not expect this, revoke the token in your Nest now.\n`,
    };
    assertMailSafe(out, origin, null);
    return out;
  },
  incident(v: z.input<typeof Incident>, origin: string): RenderedMail {
    const p = Incident.parse(v);
    const out = {
      subject: "Security notice about secrets in your Mosshatch account",
      text: `We found access to our key service that we did not authorise (incident ${p.incidentRef}). It may have exposed ${p.secrets} of your stored secret${p.secrets === 1 ? "" : "s"}; ${p.unaudited} of those reads have no matching reveal or token read in your audit log.\n\nRotate those secrets where they were issued. We have moved every secret to a new key.\n`,
    };
    assertMailSafe(out, origin, null);
    return out;
  },
};
