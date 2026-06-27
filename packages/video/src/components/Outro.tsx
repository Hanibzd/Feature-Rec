import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS, RADIAL_BG, SPRING_SMOOTH } from "../tokens";
import { fontFamily } from "../font";
import type { Brand } from "../schema";

export const Outro: React.FC<{ brand: Brand }> = ({ brand }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const reveal = spring({ frame, fps, config: SPRING_SMOOTH });
  const fadeIn = interpolate(frame, [0, 10], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const y = interpolate(reveal, [0, 1], [24, 0]);

  return (
    <AbsoluteFill style={{ background: RADIAL_BG, fontFamily, opacity: fadeIn }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 50%, ${brand.primary}26 0%, transparent 45%)`,
        }}
      />
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          transform: `translateY(${y}px)`,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 18,
            color: COLORS.textHi,
            fontWeight: 800,
            fontSize: 72,
            letterSpacing: -1.5,
          }}
        >
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: brand.primary,
              boxShadow: `0 0 26px 4px ${brand.primary}`,
              transform: "rotate(45deg)",
            }}
          />
          Shipped with AutoDemo
        </div>
        <div
          style={{
            color: COLORS.textLo,
            fontWeight: 500,
            fontSize: 30,
            marginTop: 22,
            textAlign: "center",
          }}
        >
          Auto-generated from the diff · No humans in the loop
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
