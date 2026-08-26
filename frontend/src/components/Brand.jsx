// The Throne & Liberty Tournament Series mark.
//
// Served from /public as SVG rather than inlined or imported as a PNG: it is
// drawn at three very different sizes here (28px in the nav, 96px on the login
// page, 512px as the icon) and a raster would be soft at two of them. The files
// are also the same ones handed to anyone who needs the logo, so the site can't
// drift from the brand.
//
// ── Why no plate behind the mark ────────────────────────────────────────────
// The sigil's own disc is filled #0B0A0C, which is exactly --color-ink. On the
// dark theme it therefore sits directly on the page with no visible edge. In
// the light theme it deliberately keeps its black disc, the way a printed logo
// doesn't invert — so it reads as an object placed on the page rather than as a
// hole punched in it.

export function Sigil({ className = '', size = 28 }) {
  return (
    <img
      src="/tl-sigil-mark.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className={`flex-none select-none ${className}`}
      draggable="false"
    />
  );
}

// The full horizontal lockup: sigil, THRONE & LIBERTY, TOURNAMENT SERIES.
// `alt` carries the name because this is the page's actual title on the login
// screen — a decorative empty alt there would leave a screen reader with
// nothing to announce.
export function Lockup({ className = '', width = 340 }) {
  return (
    <img
      src="/tl-sigil-lockup-horizontal.svg"
      width={width}
      alt="Throne &amp; Liberty Tournament Series"
      className={`max-w-full h-auto select-none ${className}`}
      draggable="false"
    />
  );
}

// Sigil above the wordmark. Better than the horizontal lockup anywhere the
// available width is narrower than about 280px, where the horizontal one's
// type would be too small to read.
export function LockupVertical({ className = '', width = 260 }) {
  return (
    <img
      src="/tl-sigil-lockup-vertical.svg"
      width={width}
      alt="Throne &amp; Liberty Tournament Series"
      className={`max-w-full h-auto select-none ${className}`}
      draggable="false"
    />
  );
}
