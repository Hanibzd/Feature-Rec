import React from "react";
import { AbsoluteFill, Series } from "remotion";
import { SCENE_REGISTRY } from "../scenes";
import { Intro } from "../components/Intro";
import { Outro } from "../components/Outro";
import { MissingScene } from "./MissingScene";
import { INTRO_FRAMES, OUTRO_FRAMES, RADIAL_BG } from "../tokens";
import type { DemoPlan } from "../schema";

/**
 * Composes the full release video: branded Intro -> generated scene(s) -> Outro.
 * Scenes are looked up by id from the (generated) registry; an unknown id falls
 * back to <MissingScene> so the timeline never has a hole.
 */
export const ReleaseDemo: React.FC<DemoPlan> = ({ brand, scenes }) => {
  return (
    <AbsoluteFill style={{ background: RADIAL_BG }}>
      <Series>
        <Series.Sequence durationInFrames={INTRO_FRAMES}>
          <Intro brand={brand} />
        </Series.Sequence>

        {scenes.map((scene, i) => {
          const entry = SCENE_REGISTRY[scene.id];
          const Component = entry?.Component;
          return (
            <Series.Sequence
              key={`${scene.id}-${i}`}
              durationInFrames={Math.max(1, scene.durationInFrames)}
            >
              {Component ? (
                <Component {...scene.props} />
              ) : (
                <MissingScene id={scene.id} />
              )}
            </Series.Sequence>
          );
        })}

        <Series.Sequence durationInFrames={OUTRO_FRAMES}>
          <Outro brand={brand} />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
