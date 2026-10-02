import type { Step } from "../../lib/launcher";

/**
 * The builder's steps as glowing runes on the scroll: each step gets a glyph drawn in the grove's ink-line style (strokes only, like
 * the crosshatch on the wordmark egg). Pending runes are faint ink, the active one glows (a slow pulse; steady in calm mode), done
 * runes are gold. The step labels are real text for screen readers; the glyphs are decoration.
 */
const GLYPHS = [
  "M12 3v18M12 8l6-4M12 13l-6-4",
  "M6 4l6 16 6-16M8 12h8",
  "M12 3v18M7 7l10 10M17 7L7 17",
  "M6 20V5l6 6 6-6v15",
  "M12 3l7 9-7 9-7-9zM12 8v8",
  "M5 6h14M12 6v14M8 14l4 6 4-6",
  "M7 4v16M17 4v16M7 12h10M10 8l4 8",
];

const WORD: Record<Step["state"], string> = { pending: "waiting", active: "in progress", done: "done", failed: "failed" };

export function Runes({ steps, label }: { steps: Step[]; label: string }) {
  if (!steps.length) return <p className="lx-runes-wait" role="status">The builder is reading the scroll.</p>;
  const done = steps.filter((s) => s.state === "done").length;
  return (
    <div className="lx-runes-wrap">
      <ol className="lx-runes" aria-label={label}>
        {steps.map((s, i) => (
          <li key={s.id} className={`lx-rune is-${s.state}`} aria-current={s.state === "active" ? "step" : undefined}>
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="11" className="lx-rune-ring" />
              <path d={GLYPHS[i % GLYPHS.length]} />
            </svg>
            <span className="lx-rune-label">{s.label}<span className="sr-only">, {WORD[s.state]}</span></span>
          </li>
        ))}
      </ol>
      <div className="lx-progress" role="progressbar" aria-label="Build progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done} aria-valuetext={`${done} of ${steps.length} steps done`}>
        <span style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
    </div>
  );
}
