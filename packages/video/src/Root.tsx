import React from "react";
import { Composition } from "remotion";
import { ReleaseDemo } from "./compositions/ReleaseDemo";
import { DemoPlanSchema, totalFrames } from "./schema";
import { FPS, WIDTH, HEIGHT } from "./tokens";
import { sampleDemoPlan } from "./sample";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="ReleaseDemo"
      component={ReleaseDemo}
      schema={DemoPlanSchema}
      defaultProps={sampleDemoPlan}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      durationInFrames={totalFrames(sampleDemoPlan)}
      calculateMetadata={({ props }) => ({
        durationInFrames: totalFrames(props),
      })}
    />
  );
};
