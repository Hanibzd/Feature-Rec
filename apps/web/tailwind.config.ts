import type { Config } from "tailwindcss";

// Design tokens for the product. AutoDemo reads this file (+ globals.css) and
// injects it into the replication agent so reproduced UI uses the same colors.
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#08080C",
        surface: "#16161F",
        accent: "#6C5CE7",
        hi: "#F5F5F7",
        mid: "#C7C7D2",
        lo: "#8A8A9A",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
} satisfies Config;
