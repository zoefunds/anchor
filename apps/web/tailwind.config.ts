import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        // Deep, near-black ink with a cold navy tint — authority, not
        // generic SaaS-dark. Paper-toned surfaces read as case files, not
        // app cards.
        ink: {
          DEFAULT: "#faf9f6",
          950: "#0a0c10",
          900: "#0f1216",
          800: "#171b21",
          700: "#20252c",
        },
        paper: {
          DEFAULT: "#fdfcf9",
          dim: "#f3f1ea",
        },
        line: {
          DEFAULT: "#e7e3d8",
          dark: "#262b33",
        },
        muted: {
          DEFAULT: "#6f6b5f",
          dark: "#8b8f98",
        },
        // Verdict gold — the single accent, used sparingly for the things
        // that matter: primary actions, the seal, active state.
        seal: {
          50: "#fbf3e3",
          200: "#eccd8c",
          400: "#c99a3f",
          500: "#b3822c",
          600: "#8f6720",
        },
        // Status vocabulary, not a generic color ramp — each one means a
        // specific docket state.
        status: {
          pending: "#6f6b5f",
          active: "#2f5f8a",
          adjudicating: "#b3822c",
          accepted: "#2e6b4f",
          undetermined: "#a13d3d",
        },
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        sans: ["var(--font-sans)", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        mono: ["var(--font-mono)", "SF Mono", "Menlo", "monospace"],
      },
      letterSpacing: {
        widest2: "0.18em",
      },
      backgroundImage: {
        "ledger-lines":
          "repeating-linear-gradient(to bottom, transparent, transparent 39px, currentColor 39px, currentColor 40px)",
      },
    },
  },
  plugins: [],
};

export default config;
