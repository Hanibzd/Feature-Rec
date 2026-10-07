import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

/** Critically damped, no bounce: the "native app" feel. */
export const SMOOTH = { damping: 200, stiffness: 120, mass: 1 } as const;

/** 0 → 1 progress starting at `at`, settling in ~`duration` frames. */
export function useProgress(at: number, duration = 18): number {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - at, fps, config: SMOOTH, durationInFrames: duration });
}

/**
 * A new element appearing in the flow: its height (or width) grows from 0 so the
 * siblings move naturally, while it fades in. No measuring needed.
 */
export const Reveal: React.FC<{
  at: number;
  duration?: number;
  axis?: "y" | "x";
  children: React.ReactNode;
}> = ({ at, duration = 18, axis = "y", children }) => {
  const p = useProgress(at, duration);
  const track = `${p}fr`;
  return (
    <div
      data-reveal={axis}
      style={
        axis === "y"
          ? { display: "grid", gridTemplateRows: track }
          : { display: "inline-grid", gridTemplateColumns: track, verticalAlign: "middle" }
      }
    >
      <div style={{ minHeight: 0, minWidth: 0, overflow: "clip", overflowClipMargin: 8 }}>
        <div
          style={{
            opacity: interpolate(p, [0.35, 1], [0, 1], { extrapolateLeft: "clamp" }),
            transform: axis === "y" ? `translateY(${(1 - p) * -4}px)` : undefined,
            whiteSpace: axis === "x" ? "nowrap" : undefined,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};

/**
 * Same element, before → after, in place: both versions share one grid cell so
 * nothing jumps and no text is ever duplicated side by side.
 */
export const Swap: React.FC<{
  at: number;
  duration?: number;
  before: React.ReactNode;
  after: React.ReactNode;
  inline?: boolean;
}> = ({ at, duration = 12, before, after, inline = true }) => {
  const p = useProgress(at, duration);
  return (
    <div style={{ display: inline ? "inline-grid" : "grid", verticalAlign: "middle" }}>
      <div style={{ gridArea: "1 / 1", opacity: 1 - p, justifySelf: "start", alignSelf: "center" }}>{before}</div>
      <div style={{ gridArea: "1 / 1", opacity: p, justifySelf: "start", alignSelf: "center" }}>{after}</div>
    </div>
  );
};

/** Characters typed one by one from `from`, with a caret while the field is focused. */
export const Typewriter: React.FC<{
  text: string;
  from: number;
  /** characters per second */
  cps?: number;
  /** frame the field gets focus (caret appears); defaults to `from` */
  focusAt?: number;
  caret?: boolean;
}> = ({ text, from, cps = 14, focusAt, caret = true }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const n = Math.max(0, Math.min(text.length, Math.floor(((frame - from) * cps) / fps)));
  const typing = frame >= from && n < text.length;
  const focused = frame >= (focusAt ?? from);
  const blinkOn = typing || Math.floor((frame - (focusAt ?? from)) / 16) % 2 === 0;
  return (
    <>
      {text.slice(0, n)}
      {caret && focused ? (
        <span
          style={{
            display: "inline-block",
            width: 1.5,
            height: "1.15em",
            marginLeft: 1,
            verticalAlign: "text-bottom",
            background: "currentColor",
            opacity: blinkOn ? 1 : 0,
          }}
        />
      ) : null}
    </>
  );
};
