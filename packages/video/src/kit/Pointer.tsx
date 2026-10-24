import React from "react";

/**
 * macOS-style pointers, drawn at screen size (constant, never scaled by the camera).
 * Tip of the arrow and center of the I-beam sit exactly at (x, y).
 */

const ARROW_H = 40; // on-screen height, ~macOS at 2x like a Screen Studio recording

export const PointerArrow: React.FC<{ x: number; y: number; press?: number }> = ({ x, y, press = 1 }) => (
  <svg
    width={(ARROW_H * 22) / 32}
    height={ARROW_H}
    viewBox="0 0 22 32"
    style={{
      position: "absolute",
      left: x - (ARROW_H / 32) * 2,
      top: y - (ARROW_H / 32) * 1.5,
      transform: `scale(${press})`,
      transformOrigin: `${(ARROW_H / 32) * 2}px ${(ARROW_H / 32) * 1.5}px`,
      filter: "drop-shadow(0 1.5px 2.5px rgba(0,0,0,0.28))",
      overflow: "visible",
      pointerEvents: "none",
    }}
  >
    {/* white outline */}
    <path
      d="M2 1.5 L2 25 L7.6 19.6 L11.3 28.4 L15.4 26.7 L11.8 18.1 L19.6 18.1 Z"
      fill="#FFFFFF"
      stroke="#FFFFFF"
      strokeWidth="3"
      strokeLinejoin="round"
    />
    {/* black body */}
    <path
      d="M2 1.5 L2 25 L7.6 19.6 L11.3 28.4 L15.4 26.7 L11.8 18.1 L19.6 18.1 Z"
      fill="#111111"
      stroke="#111111"
      strokeWidth="0.6"
      strokeLinejoin="round"
    />
  </svg>
);

export const PointerText: React.FC<{ x: number; y: number }> = ({ x, y }) => (
  <svg
    width={14}
    height={30}
    viewBox="0 0 14 30"
    style={{
      position: "absolute",
      left: x - 7,
      top: y - 15,
      filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,0.25))",
      pointerEvents: "none",
    }}
  >
    <path
      d="M3 2 H5.5 Q7 2 7 3.5 Q7 2 8.5 2 H11 M7 3.5 V26.5 M3 28 H5.5 Q7 28 7 26.5 Q7 28 8.5 28 H11"
      fill="none"
      stroke="#FFFFFF"
      strokeWidth="3.6"
      strokeLinecap="round"
    />
    <path
      d="M3 2 H5.5 Q7 2 7 3.5 Q7 2 8.5 2 H11 M7 3.5 V26.5 M3 28 H5.5 Q7 28 7 26.5 Q7 28 8.5 28 H11"
      fill="none"
      stroke="#111111"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);
