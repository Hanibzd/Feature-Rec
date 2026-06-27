import React from "react";
import { AbsoluteFill } from "remotion";
import { COLORS } from "../tokens";

/**
 * Dark scrim with a soft radial hole punched over the hero while the camera
 * is zoomed in. Lives in screen space (outside the Camera) so the hole tracks
 * the on-screen focus point regardless of stage scale.
 */
export const Spotlight: React.FC<{
  x: number;
  y: number;
  radius: number;
  opacity: number;
}> = ({ x, y, radius, opacity }) => {
  if (opacity <= 0.001) return null;
  const r = Math.max(1, radius);
  const mask = `radial-gradient(circle ${r}px at ${x}px ${y}px, transparent 55%, black 100%)`;
  return (
    <AbsoluteFill
      style={{
        background: COLORS.spotlightScrim,
        opacity,
        WebkitMaskImage: mask,
        maskImage: mask,
        pointerEvents: "none",
      }}
    />
  );
};
