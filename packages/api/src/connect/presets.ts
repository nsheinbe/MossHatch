import type { ConnectRecordIn, ConnectWarning } from "./plan.ts";

/**
 * Versioned presets (DC-05). Each one returns records for the connect plan. It does not write.
 * Addresses that are published as stable are named in a comment with the doc URL. Addresses a
 * provider can change are inputs, never constants.
 */

export interface PresetField { name: string; label: string; required: boolean; placeholder?: string }
export interface PresetDraft {
  add: ConnectRecordIn[];
  replace_addresses?: string[];
  spf?: { name: string; mechanisms: string[] }[];
  alias?: boolean;
  warnings: ConnectWarning[];
  blocked?: { code: string; message: string };
}
export interface Preset {
  id: string;
  version: number;
  title: string;
  doc: string;
  fields: PresetField[];
  build(input: Record<string, string>): PresetDraft;
}

const doc = (url: string): ConnectWarning => ({ code: "doc", message: url });
const need = (label: string): PresetDraft => ({ add: [], warnings: [], blocked: { code: "invalid_input", message: `${label} is required.` } });
const wild = (v: string) => v.includes("*");

const GITHUB_DOC = "https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site";
const WEBFLOW_DOC = "https://university.webflow.com/lesson/connect-a-custom-domain";
const RENDER_DOC = "https://render.com/docs/custom-domains";
const GOOGLE_DOC = "https://support.google.com/a/answer/140034";
const M365_DOC = "https://learn.microsoft.com/microsoft-365/admin/get-help-with-domains/create-dns-records-at-any-dns-hosting-provider";

/** GitHub Pages apex addresses, from the doc above. They are the published anycast set, not a guess. */
const GITHUB_A = ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"];
const GITHUB_AAAA = ["2606:50c0:8000::153", "2606:50c0:8001::153", "2606:50c0:8002::153", "2606:50c0:8003::153"];
/** Render's apex A when the host has no ALIAS, from the doc above. */
const RENDER_A = "216.24.57.1";

export const PRESETS: readonly Preset[] = [
  {
    id: "github-pages", version: 1, title: "GitHub Pages", doc: GITHUB_DOC,
    fields: [{ name: "user", label: "GitHub user or organization", required: true, placeholder: "octocat" }],
    build(input) {
      const user = (input.user ?? "").trim();
      if (!user) return need("GitHub user");
      if (wild(user)) return { add: [], warnings: [doc(GITHUB_DOC)], blocked: { code: "wildcard_refused", message: "A wildcard host is not added." } };
      if (!/^[a-z0-9-]+$/i.test(user)) return { add: [], warnings: [], blocked: { code: "invalid_input", message: "The GitHub user is not a single name." } };
      return {
        add: [
          ...GITHUB_A.map((value) => ({ type: "A", name: "", value })),
          ...GITHUB_AAAA.map((value) => ({ type: "AAAA", name: "", value })),
          { type: "CNAME", name: "www", value: `${user.toLowerCase()}.github.io` },
        ],
        replace_addresses: [""],
        warnings: [doc(GITHUB_DOC)],
      };
    },
  },
  {
    id: "webflow", version: 1, title: "Webflow", doc: WEBFLOW_DOC,
    fields: [
      { name: "apex_a", label: "Apex A address from Webflow", required: true, placeholder: "Paste the A address Webflow shows" },
      { name: "www", label: "www CNAME target from Webflow", required: true, placeholder: "Paste the CNAME target Webflow shows" },
      { name: "verification", label: "Webflow site verification", required: true, placeholder: "Paste the verification value" },
    ],
    build(input) {
      const apex = (input.apex_a ?? "").trim();
      const www = (input.www ?? "").trim();
      const verification = (input.verification ?? "").trim();
      if (!apex || !www || !verification) return need("Webflow addresses and the verification value");
      if ([apex, www, verification].some(wild)) return { add: [], warnings: [doc(WEBFLOW_DOC)], blocked: { code: "wildcard_refused", message: "A wildcard host is not added." } };
      return {
        add: [
          { type: "A", name: "", value: apex },
          { type: "CNAME", name: "www", value: www },
          { type: "TXT", name: "_webflow", value: verification },
        ],
        replace_addresses: [""],
        warnings: [doc(WEBFLOW_DOC)],
      };
    },
  },
  {
    id: "render", version: 1, title: "Render", doc: RENDER_DOC,
    fields: [
      { name: "service", label: "Service host", required: true, placeholder: "your-service.onrender.com" },
      { name: "alias", label: "Ask for an apex ALIAS instead of an A record", required: false, placeholder: "yes or no" },
    ],
    build(input) {
      if (/^(yes|true)$/i.test((input.alias ?? "").trim())) return { add: [], alias: true, warnings: [doc(RENDER_DOC)] };
      const service = (input.service ?? "").trim().replace(/\.$/, "");
      if (!service) return need("Render service host");
      if (wild(service)) return { add: [], warnings: [doc(RENDER_DOC)], blocked: { code: "wildcard_refused", message: "A wildcard host is not added." } };
      return {
        add: [
          { type: "A", name: "", value: RENDER_A },
          { type: "CNAME", name: "www", value: service },
        ],
        replace_addresses: [""],
        warnings: [doc(RENDER_DOC)],
      };
    },
  },
  {
    id: "google-workspace", version: 1, title: "Google Workspace", doc: GOOGLE_DOC,
    fields: [{ name: "dmarc", label: "DMARC record for _dmarc", required: true, placeholder: "Paste the DMARC value" }],
    build(input) {
      const dmarc = (input.dmarc ?? "").trim();
      if (!dmarc) return need("DMARC value");
      if (wild(dmarc)) return { add: [], warnings: [], blocked: { code: "wildcard_refused", message: "A wildcard host is not added." } };
      return {
        add: [
          { type: "MX", name: "", value: "smtp.google.com", priority: 1 },
          { type: "TXT", name: "_dmarc", value: dmarc },
        ],
        spf: [{ name: "", mechanisms: ["include:_spf.google.com"] }],
        warnings: [doc(GOOGLE_DOC)],
      };
    },
  },
  {
    id: "microsoft-365", version: 1, title: "Microsoft 365", doc: M365_DOC,
    fields: [
      { name: "mx", label: "MX target Microsoft gave you", required: true },
      { name: "dkim1_host", label: "First DKIM host", required: true },
      { name: "dkim1_target", label: "First DKIM target", required: true },
      { name: "dkim2_host", label: "Second DKIM host", required: true },
      { name: "dkim2_target", label: "Second DKIM target", required: true },
      { name: "verification_name", label: "Verification TXT name", required: true },
      { name: "verification", label: "Verification TXT value", required: true },
    ],
    build(input) {
      const g = (k: string) => (input[k] ?? "").trim();
      const keys = ["mx", "dkim1_host", "dkim1_target", "dkim2_host", "dkim2_target", "verification_name", "verification"];
      if (keys.some((k) => !g(k))) return need("Every Microsoft 365 value");
      if (keys.some((k) => wild(g(k)))) return { add: [], warnings: [doc(M365_DOC)], blocked: { code: "wildcard_refused", message: "A wildcard host is not added." } };
      return {
        add: [
          { type: "MX", name: "", value: g("mx"), priority: 0 },
          { type: "CNAME", name: g("dkim1_host"), value: g("dkim1_target") },
          { type: "CNAME", name: g("dkim2_host"), value: g("dkim2_target") },
          { type: "TXT", name: g("verification_name"), value: g("verification") },
        ],
        spf: [{ name: "", mechanisms: ["include:spf.protection.outlook.com"] }],
        warnings: [doc(M365_DOC)],
      };
    },
  },
];

export const presetById = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id);

export const presetView = (p: Preset) => ({ id: p.id, version: p.version, title: p.title, doc: p.doc, fields: p.fields });
