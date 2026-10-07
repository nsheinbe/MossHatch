import { useState } from "react";
/** A lightweight, accessible illustration. No image generation, account, or network request. */
export function OwnershipPreview({ domain }: { domain: string }) {
  const [open, setOpen] = useState(false);
  let seed = 0; for (const c of domain) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const hue = seed % 360;
  return <section className="ownership-preview" aria-label="Your domain preview">
    <div className="preview-address"><span aria-hidden="true">◉</span> {domain}</div>
    <div className="preview-world" style={{ '--egg-hue': hue } as React.CSSProperties}>
      <svg viewBox="0 0 160 120" width="160" height="120" role="img" aria-label={`An egg waiting to hatch for ${domain}`}><ellipse cx="80" cy="103" rx="56" ry="12" fill="#344e36"/><ellipse cx="80" cy="100" rx="38" ry="8" fill="#86a45f"/><path d="M80 12C61 12 43 50 43 73C43 110 117 110 117 73C117 50 99 12 80 12Z" fill={`hsl(${hue} 48% 75%)`}/><path d="M56 56L69 63L80 53L91 65L107 55" fill="none" stroke="#fff8dd" strokeWidth="3"/><circle cx="66" cy="77" r="3" fill="#344336"/><circle cx="94" cy="77" r="3" fill="#344336"/><path d="M73 88Q80 93 87 88" fill="none" stroke="#344336" strokeWidth="2"/></svg>
      <p className="preview-title">Something wonderful<br />is taking root.</p><span>{domain}</span>
    </div>
    <p className="fineprint">An example welcome page for your name. Your creature is revealed after hatching.</p>
    <button type="button" className="text-btn" aria-expanded={open} onClick={() => setOpen(!open)}>What comes with my domain?</button>
    {open && <ul className="ownership-facts"><li>Manage DNS and connect your own website.</li><li>Control renewal settings and see your expiry date.</li><li>Transfer out when eligible under registry rules.</li><li>Publish your creature's page from the public card section in your domain's Overview after registration.</li></ul>}
  </section>;
}
