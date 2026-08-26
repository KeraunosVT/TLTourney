/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Driven by the CSS vars in index.css, so a palette change is one file.
        // Names come from the logo, not from a design system — `crimson` is
        // the wordmark's red and `bone` is the blade's white, so a value here
        // can be checked against the mark itself.
        ink: 'rgb(var(--color-ink) / <alpha-value>)',
        panel: 'rgb(var(--color-panel) / <alpha-value>)',
        panelup: 'rgb(var(--color-panelup) / <alpha-value>)',
        line: 'rgb(var(--color-line) / <alpha-value>)',
        crimson: 'rgb(var(--color-crimson) / <alpha-value>)',
        crimsonbright: 'rgb(var(--color-crimsonbright) / <alpha-value>)',
        oxblood: 'rgb(var(--color-oxblood) / <alpha-value>)',
        oxblooddeep: 'rgb(var(--color-oxblooddeep) / <alpha-value>)',
        verdigris: 'rgb(var(--color-verdigris) / <alpha-value>)',
        verdigrisdeep: 'rgb(var(--color-verdigrisdeep) / <alpha-value>)',
        bone: 'rgb(var(--color-bone) / <alpha-value>)',
        ash: 'rgb(var(--color-ash) / <alpha-value>)',
        dim: 'rgb(var(--color-dim) / <alpha-value>)',
      },
      fontFamily: {
        display: ['Marcellus', 'Georgia', 'serif'],
        sans: ['"Noto Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
