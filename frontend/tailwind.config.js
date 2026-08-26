/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Driven by the CSS vars in index.css, so a palette change is one file.
        ink: 'rgb(var(--color-ink) / <alpha-value>)',
        panel: 'rgb(var(--color-panel) / <alpha-value>)',
        panelup: 'rgb(var(--color-panelup) / <alpha-value>)',
        line: 'rgb(var(--color-line) / <alpha-value>)',
        brass: 'rgb(var(--color-brass) / <alpha-value>)',
        brassbright: 'rgb(var(--color-brassbright) / <alpha-value>)',
        oxblood: 'rgb(var(--color-oxblood) / <alpha-value>)',
        oxblooddeep: 'rgb(var(--color-oxblooddeep) / <alpha-value>)',
        verdigris: 'rgb(var(--color-verdigris) / <alpha-value>)',
        verdigrisdeep: 'rgb(var(--color-verdigrisdeep) / <alpha-value>)',
        bone: 'rgb(var(--color-bone) / <alpha-value>)',
        ash: 'rgb(var(--color-ash) / <alpha-value>)',
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
