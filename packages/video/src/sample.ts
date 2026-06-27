import type { DemoPlan } from "./schema";

/**
 * Default props for the Studio preview. The CLI overrides these at render time
 * with the real plan built from the diff (passed as inputProps).
 */
export const sampleDemoPlan: DemoPlan = {
  brand: {
    productName: "Acme",
    primary: "#6C5CE7",
    tagline: "Dark mode just landed.",
    releaseTag: "v1.4.0",
    prNumber: 128,
  },
  scenes: [
    {
      id: "dark-mode-toggle",
      title: "Dark mode toggle",
      durationInFrames: 175,
      props: {
        brandPrimary: "#6C5CE7",
        cardTitle: "Settings",
        cardSubtitle: "Manage your workspace preferences",
        accountEmail: "team@acme.com",
        heroLabel: "Appearance",
        heroSubLabel: "Use dark theme across the app",
        caption: "New — dark mode toggle",
        focus: { x: 1288, y: 626, scale: 1.9 },
      },
    },
  ],
};
