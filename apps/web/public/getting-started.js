/** A dependency-free checklist. Actions navigate; only saved facts or explicit checkmarks complete steps. */
export function createGettingStarted({ storageKey, description, steps, floating = false }) {
  const root = document.createElement('section');
  const key = `getting-started:v1:${storageKey}`;
  let saved = { version: 1, collapsed: floating, checked: [] };
  let canSave = true;
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (value?.version === 1)
      saved = {
        version: 1,
        collapsed: typeof value.collapsed === 'boolean' ? value.collapsed : floating,
        checked: Array.isArray(value.checked) ? value.checked.filter(id => typeof id === 'string').slice(0, 32) : []
      };
  } catch {
    canSave = false;
  }
  const node = (tag, text = '', className = '') => {
    const el = document.createElement(tag);
    el.textContent = text;
    el.className = className;
    return el;
  };
  const button = (label, className, run) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    el.textContent = label;
    el.onclick = run;
    return el;
  };
  const done = step => step.complete === true || (step.manual === true && saved.checked.includes(step.id));
  const save = focus => {
    try {
      localStorage.setItem(key, JSON.stringify(saved));
    } catch {
      canSave = false;
    }
    render();
    if (focus) root.querySelector(`[data-gs-focus="${focus}"]`)?.focus();
  };
  function action(step, primary = false) {
    const label = primary ? 'Continue setup' : step.actionLabel || 'Open step';
    if (!step.href && !step.onAction) return null;
    const el = step.href ? document.createElement('a') : document.createElement('button');
    if (el instanceof HTMLAnchorElement) el.href = step.href;
    else el.type = 'button';
    el.className = primary ? 'gs-primary' : 'gs-action';
    el.textContent = `${label} →`;
    el.setAttribute('aria-label', `${label}: ${step.title}`);
    el.onclick = () => {
      step.onAction?.();
      if (floating && root.isConnected) {
        saved.collapsed = true;
        save('toggle');
      }
    };
    return el;
  }
  function render() {
    const count = steps.filter(done).length,
      next = steps.find(step => !done(step));
    root.replaceChildren();
    root.className = `gs-card${floating ? ' gs-floating' : ''}${saved.collapsed ? ' gs-collapsed' : ''}`;
    root.setAttribute('aria-label', 'Getting started');
    const style = node('style', STARTER_CSS);
    root.append(style);
    const heading = node('div', '', 'gs-heading'),
      titles = node('div');
    titles.append(
      node('span', next ? 'YOUR NEXT SMALL WIN' : 'A GREAT BEGINNING', 'gs-eyebrow'),
      node('h2', next ? 'Getting started' : 'You’re off to a great start')
    );
    const toggle = button(saved.collapsed ? 'Show +' : 'Minimize −', 'gs-toggle', () => {
      saved.collapsed = !saved.collapsed;
      save('toggle');
    });
    toggle.dataset.gsFocus = 'toggle';
    toggle.setAttribute('aria-expanded', String(!saved.collapsed));
    heading.append(titles, toggle);
    root.append(heading);
    const progress = node('div', '', 'gs-progress'),
      bar = document.createElement('progress');
    bar.max = steps.length;
    bar.value = count;
    bar.setAttribute('aria-label', `${count} of ${steps.length} getting-started steps complete`);
    const status = node('span', `${count} of ${steps.length}`);
    status.setAttribute('aria-live', 'polite');
    progress.append(bar, status);
    root.append(progress);
    if (saved.collapsed) {
      root.append(
        node('p', next ? `Up next: ${next.title}` : 'Your checklist is here whenever you need it.', 'gs-summary')
      );
      return;
    }
    root.append(
      node('p', next ? description : 'You’ve found your footing. Keep going at your own pace.', 'gs-description')
    );
    const list = node('ol', '', 'gs-list');
    for (const [index, step] of steps.entries()) {
      const li = node('li', '', done(step) ? 'gs-done' : step === next ? 'gs-next' : '');
      const marker = node('span', done(step) ? '✓' : String(index + 1).padStart(2, '0'), 'gs-mark');
      marker.setAttribute('aria-hidden', 'true');
      const body = node('div', '', 'gs-step'),
        title = node('strong', step.title);
      title.append(node('span', done(step) ? ' — complete' : ' — not complete', 'gs-sr'));
      body.append(title, node('p', step.description));
      const controls = node('div', '', 'gs-controls'),
        link = action(step);
      if (link) controls.append(link);
      if (step.manual && !step.complete) {
        const label = node('label', '', 'gs-check'),
          input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = saved.checked.includes(step.id);
        input.dataset.gsFocus = `step-${index}`;
        input.onchange = () => {
          saved.checked = input.checked
            ? [...new Set([...saved.checked, step.id])]
            : saved.checked.filter(id => id !== step.id);
          save(`step-${index}`);
        };
        label.append(input, document.createTextNode('I’ve done this'), node('span', `: ${step.title}`, 'gs-sr'));
        controls.append(label);
      }
      body.append(controls);
      li.append(marker, body);
      list.append(li);
    }
    root.append(list);
    if (next) {
      const footer = node('div', '', 'gs-footer'),
        primary = action(next, true);
      if (primary) footer.append(primary);
      footer.append(
        button('I’ll explore first', 'gs-later', () => {
          saved.collapsed = true;
          save('toggle');
        })
      );
      root.append(footer);
    }
    root.append(
      node(
        'p',
        canSave
          ? 'Progress reflects your saved work. Your own checkmarks are saved on this device.'
          : 'Browser storage is unavailable. Manual checkmarks last for this visit.',
        'gs-note'
      )
    );
  }
  render();
  return root;
}
const STARTER_CSS = `
.gs-card{--gs-accent:#176650;box-sizing:border-box;width:100%;margin:20px 0;padding:22px;border:1px solid #deded5;border-radius:18px;background:#fffef9;color:#242d28;font-family:inherit;font-size:14px;line-height:1.5;text-align:left;color-scheme:light;box-shadow:0 3px 18px #172d2110}
.gs-card *{box-sizing:border-box}.gs-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.gs-card .gs-eyebrow{display:block;font-size:10px;font-weight:700;letter-spacing:.15em;color:var(--gs-accent);margin-bottom:5px}.gs-card h2{font-weight:650;font-family:inherit;font-size:20px;line-height:1.25;letter-spacing:-.025em;margin:0;color:#242d28}.gs-card button,.gs-card a,.gs-card input{font-family:inherit}.gs-card button,.gs-card a{touch-action:manipulation}.gs-toggle{flex-shrink:0;border:1px solid #e1e3db;border-radius:9px;padding:8px 10px;min-height:40px;background:transparent;color:#455148;font-size:12px;cursor:pointer}.gs-progress{display:flex;align-items:center;gap:12px;margin-top:16px}.gs-progress progress{appearance:none;flex:1;min-width:0;width:100%;height:5px;border:0;border-radius:9px;overflow:hidden;background:#e7e9df;color:var(--gs-accent)}.gs-progress progress::-webkit-progress-bar{background:#e7e9df;border-radius:9px}.gs-progress progress::-webkit-progress-value{background:var(--gs-accent);border-radius:9px}.gs-progress progress::-moz-progress-bar{background:var(--gs-accent)}.gs-progress span{font-size:12px;color:#526055;font-variant-numeric:tabular-nums}.gs-description,.gs-summary{margin:14px 0;color:#526055;font-size:13px;max-width:70ch}.gs-summary{margin:10px 0 0}.gs-list{list-style:none;padding:0;margin:18px 0 0;display:grid;gap:8px}.gs-list li{display:flex;gap:12px;padding:13px;border:1px solid #e5e7df;border-radius:11px;background:#fffefb}.gs-list .gs-next{border-color:var(--gs-accent);background:#f7f9f2}.gs-mark{display:flex;align-items:center;justify-content:center;flex-shrink:0;width:27px;height:27px;border:1px solid #c7d0c3;border-radius:50%;font-size:10px;color:#566356;font-variant-numeric:tabular-nums}.gs-done .gs-mark{background:var(--gs-accent);border-color:var(--gs-accent);color:#fff;font-size:15px}.gs-step{flex:1;min-width:0}.gs-step strong{display:block;font-size:14px;line-height:1.4;font-weight:650;color:#27362b}.gs-step p{margin:4px 0 0;color:#58665b;font-size:12px;line-height:1.5}.gs-done .gs-step strong{color:#617065}.gs-controls{display:flex;align-items:center;flex-wrap:wrap;gap:5px 15px}.gs-action{display:inline-flex;align-items:center;min-height:36px;background:transparent;border:0;padding:3px 0;color:var(--gs-accent);text-decoration:none;font-size:12px;font-weight:650;cursor:pointer}.gs-check{display:inline-flex;align-items:center;gap:7px;min-height:36px;font-size:12px;color:#58665b;cursor:pointer}.gs-check input{width:16px;height:16px;margin:0;accent-color:var(--gs-accent)}.gs-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:16px}.gs-primary{display:inline-flex;align-items:center;justify-content:space-between;gap:20px;flex:1;min-height:44px;border:0;border-radius:10px;padding:11px 15px;background:var(--gs-accent);color:#fff!important;text-decoration:none;font-size:13px;font-weight:650;cursor:pointer}.gs-later{min-height:44px;border:0;background:transparent;color:#526055;font-size:12px;cursor:pointer;padding:7px}.gs-card .gs-note{margin:13px 0 0;font-size:11px;color:#657166}.gs-card :is(button,a,input):focus-visible{outline:3px solid var(--gs-accent);outline-offset:3px}.gs-card button:disabled{opacity:.55;cursor:wait}.gs-card [hidden]{display:none!important}.gs-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.gs-floating{position:fixed;z-index:40;right:18px;bottom:calc(18px + env(safe-area-inset-bottom,0px));width:min(420px,calc(100vw - 36px));max-height:70dvh;overflow:auto;margin:0;box-shadow:0 10px 48px #142a2930}.gs-floating.gs-collapsed{width:min(320px,calc(100vw - 36px));padding:14px 16px}.gs-floating.gs-collapsed h2{font-size:16px}.gs-floating.gs-collapsed .gs-eyebrow{display:none}.gs-floating.gs-collapsed .gs-progress{margin-top:9px}.gs-floating.gs-collapsed .gs-summary{font-size:11px}.gs-collapsed .gs-toggle{min-height:40px}@media(max-width:600px){.gs-card{padding:17px}.gs-card h2{font-size:18px}.gs-toggle,.gs-action,.gs-check{min-height:44px}.gs-list li{padding:11px}.gs-floating{bottom:calc(84px + env(safe-area-inset-bottom,0px));right:12px;width:calc(100vw - 24px);max-height:60dvh}.gs-floating.gs-collapsed{width:min(300px,calc(100vw - 24px));padding:10px 13px}}
`;
