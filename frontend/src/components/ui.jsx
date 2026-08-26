// A small UI kit — the pieces this app actually uses, in the visual language
// Gear-Gap's components/ui/ established. Kept in one file because there are
// seven of them and eleven files of six lines each is not organisation.

export function Panel({ title, subtitle, right, children, className = '' }) {
  return (
    <section className={`panel ${className}`}>
      {(title || right) && (
        <header className="px-4 py-3 border-b border-line flex items-center justify-between gap-3 flex-wrap">
          <div>
            {title && <h2 className="font-display text-[15px] tracking-wide">{title}</h2>}
            {subtitle && <p className="text-xs text-ash mt-0.5">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

const PILL_TONES = {
  crimson: 'text-crimsonbright border-crimson/55 bg-crimson/15',
  good: 'text-verdigris border-verdigris/45 bg-verdigrisdeep',
  bad: 'text-oxblood border-oxblood/50 bg-oxblooddeep',
  quiet: 'text-ash border-line bg-panelup',
};

export function Pill({ tone = 'quiet', children, blip = false }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border
        text-[10px] uppercase tracking-[0.08em] font-semibold whitespace-nowrap ${PILL_TONES[tone]}`}
    >
      {blip && <i className="w-1.5 h-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

// The brand's accent IS red, which means "primary action" and "destructive
// action" would otherwise be the same colour — Approve and Reject rendered
// identically, on the one screen where confusing them costs the most.
//
// So the two are split by HUE rather than by shade: an action that admits
// somebody is verdigris, an action that turns them away is oxblood, and the
// crimson accent is kept for neutral primaries (Save, Sign in) and for
// navigation. Distinguishing them by two tints of the same red would be a
// distinction nobody notices at a glance, which is the only speed that counts
// when working down a queue.
const BTN = {
  primary: 'border-crimson/60 text-crimsonbright bg-crimson/15 hover:bg-crimson/25',
  good: 'border-verdigris/55 text-verdigris bg-verdigris/12 hover:bg-verdigris/22',
  danger: 'border-oxblood/70 text-crimsonbright bg-oxblood/25 hover:bg-oxblood/40',
  ghost: 'border-line text-ash hover:text-bone hover:border-crimson',
};

export function Button({ variant = 'primary', className = '', children, ...props }) {
  return (
    <button
      {...props}
      className={`px-3 py-1.5 rounded border text-xs font-semibold transition-colors
        disabled:opacity-45 disabled:cursor-not-allowed ${BTN[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({ label, hint, error, optional, htmlFor, children }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {optional && <span className="normal-case tracking-normal font-normal italic text-ash/75">optional</span>}
      </label>
      {children}
      {error ? <p className="field-error">{error}</p> : hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

export function Tile({ label, value, note }) {
  return (
    <div className="panel px-4 py-3">
      <div className="eyebrow">{label}</div>
      <div className="mono text-[22px] mt-1">{value}</div>
      {note && <div className="text-[11px] text-ash mt-0.5">{note}</div>}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="px-4 py-8 text-center text-sm text-ash">{children}</div>;
}

// A brief message that replaces itself. Used for "Saved just now" — the sort of
// confirmation that should be visible and then stop being visible.
export function Note({ tone = 'good', children }) {
  if (!children) return null;
  const tones = {
    good: 'text-verdigris border-verdigris/40 bg-verdigrisdeep',
    bad: 'text-oxblood border-oxblood/45 bg-oxblooddeep',
  };
  return (
    <div className={`px-3 py-2 rounded border text-[13px] ${tones[tone]}`} role="status">
      {children}
    </div>
  );
}
