/**
 * Trusted Types (ST-38). The CSP says `require-trusted-types-for 'script'; trusted-types mosshatch`, so every DOM
 * injection sink (innerHTML, script src and text, eval-like calls) refuses plain strings, and only a policy named
 * `mosshatch` may ever be created, once. This module creates it first thing, with rules that turn every HTML or script
 * string away and allow script URLs only for this origin's /assets/, so no later script can claim the name or a default
 * policy. The app itself uses no sink (React renders text nodes; the contract test bans string HTML).
 */
type Policy = { createHTML(s: string): unknown; createScript(s: string): unknown; createScriptURL(s: string): unknown };
type TT = { createPolicy(name: string, rules: { createHTML?: (s: string) => string; createScript?: (s: string) => string; createScriptURL?: (s: string) => string }): Policy };

const refuse = (what: string) => () => { throw new TypeError(`${what} from a string is not allowed here`); };

export const policy: Policy | null = (() => {
  const tt = (globalThis as { trustedTypes?: TT }).trustedTypes;
  if (!tt) return null;   // browsers without Trusted Types: the rest of the CSP still applies
  return tt.createPolicy("mosshatch", {
    createHTML: refuse("HTML"),
    createScript: refuse("Script"),
    createScriptURL: (u: string) => {
      const url = new URL(u, location.href);
      if (url.origin === location.origin && url.pathname.startsWith("/assets/")) return url.href;
      throw new TypeError("Only this site's own scripts may load");
    },
  });
})();
