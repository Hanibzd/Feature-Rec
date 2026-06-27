import React from "react";
import { AbsoluteFill } from "remotion";

/**
 * Cinematic camera: scales the whole stage toward a focus point.
 * `originX/originY` are in COMPOSITION px (1920x1080) — the same coordinate
 * space scenes lay out in, so the author can point the camera at an element
 * whose center they already know.
 */
export const Camera: React.FC<{
  scale: number;
  originX: number;
  originY: number;
  opacity?: number;
  children: React.ReactNode;
}> = ({ scale, originX, originY, opacity = 1, children }) => {
  return (
    <AbsoluteFill
      style={{
        transform: `scale(${scale})`,
        transformOrigin: `${originX}px ${originY}px`,
        opacity,
        willChange: "transform, opacity",
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
