import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, SPRING_POP } from "../tokens";
import { fontFamily } from "../font";

/**
 * Caption pill that labels the change, anchored near the hero (screen space).
 * `x` is the horizontal center, `y` the top edge; it pops in with SPRING_POP.
 */
export const Caption: React.FC<{
  text: string;
  x: number;
  y: number;
  startFrame: number;
  accent: string;
}> = ({ text, x, y, startFrame, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < startFrame) return null;
  const pop = spring({ frame: frame - startFrame, fps, config: SPRING_POP });
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: `translateX(-50%) scale(${pop})`,
        transformOrigin: "center top",
        opacity: Math.min(1, pop),
        background: accent,
        color: "#FFFFFF",
        fontFamily,
        fontWeight: 600,
        fontSize: 30,
        lineHeight: 1,
        padding: "16px 30px",
        borderRadius: 999,
        whiteSpace: "nowrap",
        boxShadow: `0 22px 60px -16px ${accent}, 0 0 0 1px rgba(255,255,255,0.10)`,
      }}
    >
      {text}
    </div>
  );
};
