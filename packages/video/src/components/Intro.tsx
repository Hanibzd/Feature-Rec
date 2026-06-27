import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS, RADIAL_BG, SPRING_SMOOTH, SPRING_POP } from "../tokens";
import { fontFamily } from "../font";
import type { Brand } from "../schema";

export const Intro: React.FC<{ brand: Brand }> = ({ brand }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const reveal = spring({ frame, fps, config: SPRING_SMOOTH });
  const pill = spring({ frame: frame - 16, fps, config: SPRING_POP });
  const halo = spring({ frame, fps, config: { damping: 200, mass: 1, stiffness: 50 } });

  const y = interpolate(reveal, [0, 1], [30, 0]);
  const fadeOut = interpolate(
    frame,
    [durationInFrames - 9, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) },
  );

  return (
    <AbsoluteFill style={{ background: RADIAL_BG, fontFamily, opacity: fadeOut }}>
      {/* accent halo */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 46%, ${brand.primary}33 0%, transparent 42%)`,
          opacity: halo,
          transform: `scale(${interpolate(halo, [0, 1], [0.8, 1])})`,
        }}
      />
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          transform: `translateY(${y}px)`,
          opacity: reveal,
        }}
      >
        <div
          style={{
            color: brand.primary,
            fontWeight: 700,
            fontSize: 26,
            letterSpacing: 6,
            textTransform: "uppercase",
            marginBottom: 22,
          }}
        >
          New in this release
        </div>
        <div
          style={{
            color: COLORS.textHi,
            fontWeight: 800,
            fontSize: 104,
            letterSpacing: -2,
            lineHeight: 1.02,
            textAlign: "center",
          }}
        >
          {brand.productName}
        </div>
        <div
          style={{
            color: COLORS.textMid,
            fontWeight: 600,
            fontSize: 36,
            marginTop: 20,
            textAlign: "center",
            maxWidth: 1100,
          }}
        >
          {brand.tagline}
        </div>
        <div
          style={{
            marginTop: 44,
            transform: `scale(${pill})`,
            opacity: Math.min(1, pill),
            display: "flex",
            alignItems: "center",
            gap: 16,
            padding: "14px 26px",
            borderRadius: 999,
            background: COLORS.surface,
            border: `1px solid ${COLORS.hairline}`,
            color: COLORS.textHi,
            fontWeight: 600,
            fontSize: 28,
          }}
        >
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 999,
              background: brand.primary,
              boxShadow: `0 0 16px 2px ${brand.primary}`,
            }}
          />
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
            {brand.releaseTag}
          </span>
          {brand.prNumber > 0 ? (
            <>
              <span style={{ color: COLORS.textLo }}>·</span>
              <span style={{ color: COLORS.textMid, fontVariantNumeric: "tabular-nums" }}>
                PR #{brand.prNumber}
              </span>
            </>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
