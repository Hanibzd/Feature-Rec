/**
 * GENERATED-STYLE SCENE — "known good" reference output of the UI Replication Agent.
 *
 * Feature: a new dark-mode toggle added to a Settings card (the Appearance row).
 * The surrounding rows (Account, Notifications) are static CONTEXT. The HERO is the
 * new Appearance row + toggle: it reveals, the knob slides on, the camera zooms onto
 * it with a spotlight, and a caption labels the change.
 *
 * The card/row/toggle markup reuses the EXACT Tailwind classNames from the target
 * repo's component (see apps/web/components/SettingsRow.tsx / fixtures/dark-mode-toggle).
 */
import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";
import { Camera } from "../../components/Camera";
import { Spotlight } from "../../components/Spotlight";
import { Caption } from "../../components/Caption";
import { RADIAL_BG, SPRING_SMOOTH } from "../../tokens";
import { fontFamily } from "../../font";

export const schema = z.object({
  brandPrimary: z.string().default("#6C5CE7"),
  cardTitle: z.string().default("Settings"),
  cardSubtitle: z.string().default("Manage your workspace preferences"),
  accountEmail: z.string().default("team@acme.com"),
  heroLabel: z.string().default("Appearance"),
  heroSubLabel: z.string().default("Use dark theme across the app"),
  caption: z.string().default("New — dark mode toggle"),
  focus: z
    .object({ x: z.number(), y: z.number(), scale: z.number() })
    .default({ x: 1288, y: 626, scale: 1.9 }),
});

export type DarkModeToggleProps = z.infer<typeof schema>;

export default function DarkModeToggleScene(props: Partial<DarkModeToggleProps>) {
  const {
    brandPrimary,
    cardTitle,
    cardSubtitle,
    accountEmail,
    heroLabel,
    heroSubLabel,
    caption,
    focus,
  } = schema.parse(props ?? {});

  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // [0-14] stage fades/scales in (context UI present, hero still hidden)
  const stageIn = interpolate(frame, [0, 14], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const stageScale = interpolate(frame, [0, 14], [0.97, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // [14-..] HERO reveal — the new Appearance row slides + fades in
  const rowReveal = spring({ frame: frame - 14, fps, config: SPRING_SMOOTH });
  const rowY = interpolate(rowReveal, [0, 1], [16, 0]);

  // [26-..] the toggle knob slides on
  const knob = spring({ frame: frame - 26, fps, config: SPRING_SMOOTH });
  const knobX = interpolate(knob, [0, 1], [0, 30]);

  // [40-..] camera zoom in, holds, eases back at the end
  const zoomIn = spring({ frame: frame - 40, fps, config: SPRING_SMOOTH });
  const zoomOut = spring({ frame: frame - (durationInFrames - 22), fps, config: SPRING_SMOOTH });
  const p = Math.max(0, Math.min(1, zoomIn - zoomOut));
  const camScale = 1 + p * (focus.scale - 1);

  return (
    <AbsoluteFill style={{ background: RADIAL_BG, fontFamily }}>
      {/* STAGE inside the camera (scales toward the hero) */}
      <Camera scale={stageScale * camScale} originX={focus.x} originY={focus.y} opacity={stageIn}>
        {/* decorative app window behind the card */}
        <div
          className="absolute rounded-3xl bg-[#0F0F16] ring-1 ring-white/10 shadow-2xl overflow-hidden"
          style={{ left: 470, top: 210, width: 980, height: 500 }}
        >
          <div className="h-[46px] flex items-center gap-2 px-5 border-b border-white/5 bg-[#0B0B12]">
            <span className="w-3 h-3 rounded-full" style={{ background: "#FF5F57" }} />
            <span className="w-3 h-3 rounded-full" style={{ background: "#FEBC2E" }} />
            <span className="w-3 h-3 rounded-full" style={{ background: "#28C840" }} />
            <span className="ml-4 text-[#8A8A9A] text-sm font-medium">acme.app/settings</span>
          </div>
        </div>

        {/* REPRODUCED SETTINGS CARD — exact classNames from the target repo */}
        <div
          className="absolute rounded-2xl bg-[#16161F] shadow-2xl ring-1 ring-white/5"
          style={{ left: 560, top: 296, width: 800 }}
        >
          <div className="px-10 h-[100px] flex flex-col justify-center">
            <h2 className="text-[#F5F5F7] text-2xl font-bold">{cardTitle}</h2>
            <p className="text-[#8A8A9A] text-sm font-medium">{cardSubtitle}</p>
          </div>

          <div className="px-10 divide-y divide-white/10">
            {/* context row */}
            <div className="h-[92px] flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-[#F5F5F7] text-xl font-semibold">Account</span>
                <span className="text-[#8A8A9A] text-sm font-medium">{accountEmail}</span>
              </div>
              <span className="text-[#C7C7D2] text-sm font-medium">Manage</span>
            </div>

            {/* context row */}
            <div className="h-[92px] flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-[#F5F5F7] text-xl font-semibold">Notifications</span>
                <span className="text-[#8A8A9A] text-sm font-medium">Email me about releases</span>
              </div>
              <span className="text-[#6C5CE7] text-sm font-semibold">On</span>
            </div>

            {/* HERO ROW — the change */}
            <div
              className="h-[92px] flex items-center justify-between"
              style={{ opacity: rowReveal, transform: `translateY(${rowY}px)` }}
            >
              <div className="flex flex-col">
                <span className="text-[#F5F5F7] text-xl font-semibold">{heroLabel}</span>
                <span className="text-[#8A8A9A] text-sm font-medium">{heroSubLabel}</span>
              </div>
              {/* HERO ELEMENT — the new toggle */}
              <button
                className="relative w-[64px] h-[34px] rounded-full p-1 transition-colors"
                style={{ background: brandPrimary }}
              >
                <span
                  className="block w-[26px] h-[26px] rounded-full bg-white shadow"
                  style={{ transform: `translateX(${knobX}px)` }}
                />
              </button>
            </div>
          </div>
        </div>
      </Camera>

      {/* SPOTLIGHT — screen space, tracks the on-screen hero while zoomed */}
      <Spotlight x={focus.x} y={focus.y} radius={60 + 220 * p} opacity={p} />

      {/* CAPTION — labels the change near the hero */}
      <Caption
        text={caption}
        x={Math.min(Math.max(focus.x, 260), 1660)}
        y={focus.y + 150}
        startFrame={54}
        accent={brandPrimary}
      />
    </AbsoluteFill>
  );
}
