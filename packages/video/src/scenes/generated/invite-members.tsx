/**
 * GENERATED-STYLE SCENE — "known good" reference output of the UI Replication Agent.
 *
 * Feature: a new primary "Invite" button added to a Members card header.
 * Context (member rows) is static; the HERO is the new button — it POPS in
 * (SPRING_POP), the camera zooms onto it with a spotlight, and a caption labels it.
 *
 * The card/header/button/row markup reuses the EXACT Tailwind classNames from the
 * target repo's component (see fixtures/invite-members/after.tsx).
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
import { RADIAL_BG, SPRING_SMOOTH, SPRING_POP } from "../../tokens";
import { fontFamily } from "../../font";

const MemberSchema = z.object({
  initials: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  color: z.string(),
});

export const schema = z.object({
  brandPrimary: z.string().default("#6C5CE7"),
  cardTitle: z.string().default("Members"),
  cardSubtitle: z.string().default("3 people in Acme"),
  buttonLabel: z.string().default("Invite"),
  caption: z.string().default("New — invite teammates"),
  members: z
    .array(MemberSchema)
    .default([
      { initials: "MC", name: "Maya Chen", email: "maya@acme.com", role: "Admin", color: "#6C5CE7" },
      { initials: "TP", name: "Theo Park", email: "theo@acme.com", role: "Member", color: "#2D9CDB" },
      { initials: "IR", name: "Inès Roux", email: "ines@acme.com", role: "Member", color: "#27AE60" },
    ]),
  focus: z
    .object({ x: z.number(), y: z.number(), scale: z.number() })
    .default({ x: 1265, y: 335, scale: 2.0 }),
});

export type InviteMembersProps = z.infer<typeof schema>;

export default function InviteMembersScene(props: Partial<InviteMembersProps>) {
  const { brandPrimary, cardTitle, cardSubtitle, buttonLabel, caption, members, focus } =
    schema.parse(props ?? {});

  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // [0-14] stage + context UI fade/scale in (hero button still hidden)
  const stageIn = interpolate(frame, [0, 14], [0, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const stageScale = interpolate(frame, [0, 14], [0.97, 1], {
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  // [16-..] HERO reveal — the new button pops in
  const pop = spring({ frame: frame - 16, fps, config: SPRING_POP });

  // [40-..] camera zoom in, holds, eases back at the end
  const zoomIn = spring({ frame: frame - 40, fps, config: SPRING_SMOOTH });
  const zoomOut = spring({ frame: frame - (durationInFrames - 22), fps, config: SPRING_SMOOTH });
  const p = Math.max(0, Math.min(1, zoomIn - zoomOut));
  const camScale = 1 + p * (focus.scale - 1);

  return (
    <AbsoluteFill style={{ background: RADIAL_BG, fontFamily }}>
      <Camera scale={stageScale * camScale} originX={focus.x} originY={focus.y} opacity={stageIn}>
        {/* decorative app window behind the card */}
        <div
          className="absolute rounded-3xl bg-[#0F0F16] ring-1 ring-white/10 shadow-2xl overflow-hidden"
          style={{ left: 460, top: 200, width: 1000, height: 520 }}
        >
          <div className="h-[46px] flex items-center gap-2 px-5 border-b border-white/5 bg-[#0B0B12]">
            <span className="w-3 h-3 rounded-full" style={{ background: "#FF5F57" }} />
            <span className="w-3 h-3 rounded-full" style={{ background: "#FEBC2E" }} />
            <span className="w-3 h-3 rounded-full" style={{ background: "#28C840" }} />
            <span className="ml-4 text-[#8A8A9A] text-sm font-medium">acme.app/members</span>
          </div>
        </div>

        {/* REPRODUCED MEMBERS CARD — exact classNames from the target repo */}
        <div
          className="absolute rounded-2xl bg-[#16161F] shadow-2xl ring-1 ring-white/5"
          style={{ left: 540, top: 280, width: 840 }}
        >
          <div className="px-10 h-[110px] flex items-center justify-between border-b border-white/10">
            <div className="flex flex-col">
              <h2 className="text-[#F5F5F7] text-2xl font-bold">{cardTitle}</h2>
              <p className="text-[#8A8A9A] text-sm font-medium">{cardSubtitle}</p>
            </div>
            {/* HERO ELEMENT — the new Invite button (pops in) */}
            <button
              className="flex items-center gap-2 h-[48px] w-[150px] justify-center rounded-xl text-white text-base font-semibold"
              style={{
                background: brandPrimary,
                transform: `scale(${pop})`,
                opacity: Math.min(1, pop),
                boxShadow: `0 14px 40px -10px ${brandPrimary}`,
              }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              {buttonLabel}
            </button>
          </div>

          <div className="px-10 divide-y divide-white/10">
            {members.map((m) => (
              <div key={m.email} className="h-[96px] flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center text-white text-sm font-bold"
                    style={{ background: m.color }}
                  >
                    {m.initials}
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[#F5F5F7] text-lg font-semibold">{m.name}</span>
                    <span className="text-[#8A8A9A] text-sm font-medium">{m.email}</span>
                  </div>
                </div>
                <span
                  className="text-sm font-semibold"
                  style={{ color: m.role === "Admin" ? brandPrimary : "#8A8A9A" }}
                >
                  {m.role}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Camera>

      {/* SPOTLIGHT — screen space, over the on-screen hero while zoomed */}
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
