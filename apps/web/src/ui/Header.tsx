import { useUi } from "../store";
import { sound } from "../audio/synth";
import { handle } from "../world/handle";

export function WordmarkMark() {
  // A hatched egg: ink lines at two angles inside an egg outline.
  return (
    <svg viewBox="0 0 28 32" aria-hidden="true" focusable="false">
      <defs><clipPath id="egg"><ellipse cx="14" cy="18" rx="10" ry="13" /></clipPath></defs>
      <ellipse cx="14" cy="18" rx="10" ry="13" fill="#f1ead8" />
      <g clipPath="url(#egg)" stroke="#0c1122" strokeWidth="1" opacity="0.85">
        {Array.from({ length: 9 }, (_, i) => <line key={i} x1={-6 + i * 5} y1="36" x2={10 + i * 5} y2="2" />)}
        {Array.from({ length: 5 }, (_, i) => <line key={"b" + i} x1={2 + i * 6} y1="34" x2={-10 + i * 6} y2="4" opacity="0.5" />)}
      </g>
      <path d="M8 16 L12 19 L15 15 L19 19 L22 16" fill="none" stroke="#ffb257" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function Header() {
  const { view, calm, sound: on, apiReady, account, set } = useUi();
  return (
    <header className="site-header">
      <span className="wordmark"><WordmarkMark /><span>Mosshatch</span></span>
      <nav className="nav" aria-label="Views">
        <button type="button" aria-current={view === "find" ? "page" : undefined} onClick={() => set({ view: "find" })}>Find a name</button>
        <button type="button" aria-current={view === "grove" ? "page" : undefined} onClick={() => set({ view: "grove" })}>My grove</button>
        {apiReady && account && <button type="button" aria-current={view === "ledger" ? "page" : undefined} onClick={() => set({ view: "ledger" })}>Ledger</button>}
      </nav>
      <div className="tools">
        {apiReady && (
          <button type="button" onClick={() => set({ accountOpen: true })} aria-haspopup="dialog">
            <span className="label">{account ? "Account" : "Sign in"}</span>
          </button>
        )}
        <button type="button" aria-pressed={on} onClick={() => { const n = !on; sound.setEnabled(n); set({ sound: n }); }}>
          <span className="dot" aria-hidden="true" /><span className="label">Sound {on ? "on" : "off"}</span>
        </button>
        <button type="button" aria-pressed={calm} onClick={() => { const n = !calm; handle.world?.setCalm(n); set({ calm: n }); }}>
          <span className="dot" aria-hidden="true" /><span className="label">Calm {calm ? "on" : "off"}</span>
        </button>
      </div>
    </header>
  );
}
