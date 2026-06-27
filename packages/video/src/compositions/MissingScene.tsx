import React from "react";
import { AbsoluteFill } from "remotion";
import { COLORS, RADIAL_BG } from "../tokens";
import { fontFamily } from "../font";

/**
 * Safety net: rendered when a DemoPlan references a scene id that is not in the
 * registry. Guarantees we NEVER render an empty frame.
 */
export const MissingScene: React.FC<{ id: string }> = ({ id }) => {
  return (
    <AbsoluteFill
      style={{
        background: RADIAL_BG,
        fontFamily,
        alignItems: "center",
        justifyContent: "center",
        color: COLORS.textMid,
      }}
    >
      <div
        style={{
          padding: "28px 40px",
          borderRadius: 20,
          background: COLORS.surface,
          border: `1px solid ${COLORS.hairline}`,
          fontSize: 30,
          fontWeight: 600,
        }}
      >
        Preview unavailable — <span style={{ color: COLORS.textLo }}>{id}</span>
      </div>
    </AbsoluteFill>
  );
};
