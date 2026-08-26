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
  brass: 'text-brassbright border-brass/55 bg-brass/15',
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

const BTN = {
  primary: 'border-brass/60 text-brassbright bg-brass/15 hover:bg-brass/25',
  ghost: 'border-line text-ash hover:text-bone hover:border-brass',
  danger: 'border-oxblood/60 text-oxblood bg-oxblood/10 hover:bg-oxblood/20',
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
