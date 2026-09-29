import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { formatUsd, usd, feePerYear } from "@mosshatch/core";
import { EXTENSIONS, SAMPLE_WHOLESALE_CENTS } from "@mosshatch/registrar";

const root = fileURLToPath(new URL(".", import.meta.url));

/** The price list in the static HTML is generated at build time from the adapter's sample quotes. */
function staticPrices(): Plugin {
  return {
    name: "mosshatch-static-prices",
    transformIndexHtml(html) {
      const items = EXTENSIONS.map((tld) => {
        const w = SAMPLE_WHOLESALE_CENTS[tld]!;
        const years = tld === "ai" ? 2 : 1;
        const price = formatUsd(usd((w + feePerYear(usd(w)).cents) * years));
        return `<li><span class="ext">.${tld}</span> <span class="price">${price}</span> <span class="note">${years === 2 ? "for 2 years" : "first year"}, renews the same</span></li>`;
      }).join("");
      const asOf = new Date().toISOString().slice(0, 10);
      return html
        .replace("<!--PRICES-->", items)
        .replace("<!--ASOF-->", asOf);
    },
  };
}

/** Strip comments and indentation from GLSL imported with ?raw (keeps line breaks for #directives). */
function glslMinify(): Plugin {
  return {
    name: "mosshatch-glsl-minify",
    enforce: "pre",
    transform(code, id) {
      if (!/\.(glsl|vert|frag)\?raw$/.test(id)) return null;
      const m = /^export default (".*")\s*;?\s*$/s.exec(code);
      if (!m) return null;
      const src: string = JSON.parse(m[1]!);
      const out = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean).join("\n");
      return { code: `export default ${JSON.stringify(out)};`, map: null };
    },
  };
}

// The debug entry (?debug=states via /debug.html) is a review tool. It is only part of a build when asked for.
const withDebug = process.env.MOSSHATCH_DEBUG_ENTRY === "1";

export default defineConfig({
  plugins: [glslMinify(), react(), staticPrices()],
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    sourcemap: false,
    rollupOptions: {
      input: { main: root + "index.html", ...(withDebug ? { debug: root + "debug.html" } : {}) },
    },
  },
  define: { __DEBUG_ENTRY__: JSON.stringify(withDebug) },
});
