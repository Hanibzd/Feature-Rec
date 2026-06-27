import { loadFont } from "@remotion/google-fonts/Inter";
import { FALLBACK_FONT } from "./tokens";

// Loaded once; @remotion/google-fonts manages delayRender so the headless
// render waits for the font before capturing frames.
const loaded = loadFont("normal", {
  weights: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
});

export const fontFamily = `${loaded.fontFamily}, ${FALLBACK_FONT}`;
