/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Lumen · Night Foundry — values mirror tokens.css (kept literal so
        // Tailwind alpha modifiers like bg-brass/10 compile)
        // Darkroom (redesign canvas): neutral near-black, one warm accent.
        paper: "rgb(14 15 17 / <alpha-value>)",
        paper2: "rgb(20 21 24 / <alpha-value>)",
        paper3: "rgb(30 33 37 / <alpha-value>)",
        ink: "rgb(236 237 238 / <alpha-value>)",
        ink2: "rgb(201 205 210 / <alpha-value>)",
        muted: "rgb(142 148 156 / <alpha-value>)",
        brass: "rgb(245 165 36 / <alpha-value>)",
        brassink: "rgb(26 18 6 / <alpha-value>)",
        info: "rgb(76 154 255 / <alpha-value>)",
        coral: "oklch(68% 0.16 18 / <alpha-value>)",
        ok: "rgb(63 185 126 / <alpha-value>)",
        warn: "rgb(232 179 57 / <alpha-value>)",
        danger: "rgb(229 72 77 / <alpha-value>)",
        // legacy aliases so untouched files degrade gracefully
        background: "oklch(13% 0.014 265 / <alpha-value>)",
        surface: "oklch(16.5% 0.015 265 / <alpha-value>)",
        primary: "oklch(76% 0.17 50 / <alpha-value>)",
        accent: "oklch(68% 0.16 18 / <alpha-value>)",
      },
      fontFamily: {
        display: "var(--font-display)",
        body: "var(--font-body)",
        sans: "var(--font-body)",
        serif: "var(--font-display)",
        mono: "var(--font-mono)",
      },
      borderColor: {
        rule: "var(--color-rule)",
        rule2: "var(--color-rule-2)",
      },
      borderRadius: {
        card: "var(--radius-card)",
        input: "var(--radius-input)",
      },
      fontSize: {
        micro: ["10.5px", { letterSpacing: "0.10em" }],
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade': 'fadeIn 0.4s var(--ease-out)',
        // mobile shell: the nav drawer flies in from the edge, sheets rise
        'slide-in-left': 'slideInLeft 0.24s var(--ease-out)',
        'sheet-up': 'sheetUp 0.26s var(--ease-out)',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideInLeft: {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(0)' },
        },
        sheetUp: {
          from: { transform: 'translateY(12px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
