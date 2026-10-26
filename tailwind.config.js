/** @type {import('tailwindcss').Config} */

// Every colour in the app comes from a CSS variable in src/index.css, so a company
// can re-theme the whole board by editing those variables — no class hunting.
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        display: ['ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        canvas: token('canvas'),
        surface: token('surface'),
        muted: token('muted'),
        line: { DEFAULT: token('line'), strong: token('line-strong') },
        fg: { DEFAULT: token('fg'), muted: token('fg-muted'), subtle: token('fg-subtle') },
        accent: { DEFAULT: token('accent'), fg: token('accent-fg') },
      },
    },
  },
  plugins: [],
};
