import type { Step } from "../lib/orders";

const STEPS: { id: Step; label: string }[] = [
  { id: "choose", label: "Choose" }, { id: "pay", label: "Pay" }, { id: "register", label: "Register" }, { id: "yours", label: "Yours" },
];

/**
 * Where a real purchase stands, as one sequence (docs/AUDIT-2026-10-07.md C3): choosing the name, payment on Stripe, registration with the
 * registrar, and the name confirmed as yours. A practice hatch never shows it, so nothing a preview does can look like ownership.
 */
export function JourneySteps({ at, stopped = false }: { at: Step; stopped?: boolean }) {
  const idx = STEPS.findIndex((s) => s.id === at);
  return (
    <ol className="journey" aria-label="Purchase progress">
      {STEPS.map((s, i) => {
        const state = i < idx ? "done" : i === idx ? (stopped ? "stopped" : "current") : "todo";
        return (
          <li key={s.id} className={`journey-step ${state}`} aria-current={i === idx ? "step" : undefined}>
            <span className="journey-dot" aria-hidden="true" />
            <span>{s.label}</span>
            <span className="sr-only">{state === "done" ? " (done)" : state === "current" ? " (in progress)" : state === "stopped" ? " (needs attention)" : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}
