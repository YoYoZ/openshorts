import React from "react";
import { AbsoluteFill } from "remotion";
import type { SubtitleConfig } from "../lib/types";
import { Subtitles } from "./Subtitles";

export const CaptionsOnly: React.FC<{ subtitles: SubtitleConfig }> = ({ subtitles }) => (
  <AbsoluteFill style={{ backgroundColor: "transparent" }}>
    <Subtitles config={subtitles} />
  </AbsoluteFill>
);
