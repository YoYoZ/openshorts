import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { Video } from "@remotion/media";
import { Subtitles } from "./Subtitles";
import { HookOverlay } from "./HookOverlay";
import { VideoEffects } from "./VideoEffects";

// The live draft of a clip, for the workspace's one player: the source video
// played through the trim segments, framed zone by zone the way the render
// will frame it, with captions, hook and effects on top. Nothing is rendered
// server-side to preview a change.
//
// Framing maths mirrors components/ReframeEditor.jsx (drawOutput, halfGeom)
// and split_layout.split_geometry: a "window" shows a rectangle of the source
// (fractions of its width/height) inside a rectangle of the output (fractions).

type Seg = { start: number; end: number };
type Rect = { x: number; y: number; w: number; h: number };
type Geometry = {
  cropWidthFraction?: number;
  splitBox?: { w: number; h: number; y_bias: number } | null;
  sourceWidth?: number;
  sourceHeight?: number;
  scenes?: { start: number; end: number; suggested_center?: number }[];
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// The source, cut to the trim segments, sized so `crop` fills the box.
const Source: React.FC<{
  src: string; segments: Seg[]; fps: number; crop: Rect; muted?: boolean; filter?: string;
}> = ({ src, segments, fps, crop, muted, filter }) => {
  let cursor = 0;
  return (
    <>
      {segments.map((s, i) => {
        const frames = Math.max(1, Math.round((s.end - s.start) * fps));
        const from = cursor;
        cursor += frames;
        return (
          <Sequence key={i} from={from} durationInFrames={frames} layout="none">
            <Video
              src={src}
              trimBefore={Math.round(s.start * fps)}
              trimAfter={Math.round(s.end * fps)}
              muted={muted}
              volume={muted ? 0 : 1}
              style={{
                position: "absolute",
                width: `${100 / crop.w}%`,
                height: `${100 / crop.h}%`,
                left: `${(-crop.x / crop.w) * 100}%`,
                top: `${(-crop.y / crop.h) * 100}%`,
                objectFit: "fill",
                filter,
              }}
            />
          </Sequence>
        );
      })}
    </>
  );
};

const Window: React.FC<{
  src: string; segments: Seg[]; fps: number; crop: Rect; box: Rect; muted?: boolean; filter?: string;
}> = ({ box, ...rest }) => (
  <div style={{
    position: "absolute", overflow: "hidden",
    left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`,
  }}>
    <Source {...rest} />
  </div>
);

const modeOf = (v: any) => {
  if (v === undefined || v === null) return "auto";
  if (typeof v === "number") return "fill";
  if (v.mode) return v.mode;
  if (v.top && v.bottom) return "split";
  return "auto";
};

const halfGeom = (h: any, sb: { w: number; h: number; y_bias: number }) => {
  const ratio = sb.h / sb.w;
  const maxW = Math.min(1, 1 / ratio);
  const w = clamp(h?.w ?? sb.w, 0.1, maxW);
  const hh = w * ratio;
  const x = clamp(h?.x ?? 0.5, w / 2, 1 - w / 2);
  const cy = clamp(h?.y ?? 0.5, hh * sb.y_bias, 1 - hh * (1 - sb.y_bias));
  return { w, hh, x, top: cy - hh * sb.y_bias };
};

const Framed: React.FC<{
  src: string; segments: Seg[]; fps: number; cuts: number[]; overrides: Record<string, any>;
  geometry: Geometry; duration: number;
}> = ({ src, segments, fps, cuts, overrides, geometry }) => {
  const t = useCurrentFrame() / fps;
  const zone = cuts.filter((c) => c <= t).length;
  const value = overrides[zone] ?? overrides[String(zone)];
  const mode = modeOf(value);
  const cwf = geometry.cropWidthFraction || 0.316;
  const srcAspect = (geometry.sourceWidth || 16) / (geometry.sourceHeight || 9);
  const outAspect = 9 / 16;
  const full: Rect = { x: 0, y: 0, w: 1, h: 1 };
  const common = { src, segments, fps };

  // Blurred cover of the whole frame, under fit / zoom.
  const coverW = clamp(outAspect / srcAspect, 0.01, 1);
  const cover = <Window {...common} muted box={full} filter="blur(28px) brightness(0.65)"
    crop={{ x: (1 - coverW) / 2, y: 0, w: coverW, h: 1 }} />;

  if (mode === "fit" || mode === "zoom") {
    const w = mode === "zoom" ? clamp(value?.width ?? 0.75, 0.3, 1) : 1;
    const cx = mode === "zoom" ? clamp(value?.x ?? 0.5, w / 2, 1 - w / 2) : 0.5;
    const h = clamp(outAspect / (w * srcAspect), 0, 1);
    return (
      <>
        {cover}
        <Window {...common} box={{ x: 0, y: (1 - h) / 2, w: 1, h }} crop={{ x: cx - w / 2, y: 0, w, h: 1 }} />
      </>
    );
  }
  if (mode === "split" && value?.top && geometry.splitBox) {
    const a = halfGeom(value.top, geometry.splitBox);
    const b = halfGeom(value.bottom, geometry.splitBox);
    return (
      <>
        <Window {...common} box={{ x: 0, y: 0, w: 1, h: 0.5 }} crop={{ x: a.x - a.w / 2, y: a.top, w: a.w, h: a.hh }} />
        <Window {...common} muted box={{ x: 0, y: 0.5, w: 1, h: 0.5 }} crop={{ x: b.x - b.w / 2, y: b.top, w: b.w, h: b.hh }} />
      </>
    );
  }
  // fill, or auto: the server tracks faces; the draft centres on the face the
  // scene detection found (an approximation of what the tracker will do).
  const scene = geometry.scenes?.find((s) => t >= s.start && t < s.end) ?? geometry.scenes?.[geometry.scenes.length - 1];
  const c = typeof value === "number" ? value : (value?.x ?? scene?.suggested_center ?? 0.5);
  const x = clamp(c, cwf / 2, 1 - cwf / 2) - cwf / 2;
  return <Window {...common} box={full} crop={{ x, y: 0, w: cwf, h: 1 }} />;
};

export const ClipDraft: React.FC<Record<string, unknown>> = (props) => {
  const {
    sourceUrl, segments = [], fps = 30, cuts = [], overrides = {}, geometry,
    subtitles, hook, effects, durationInFrames = 1,
  } = props as any;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <VideoEffects config={effects}>
        <AbsoluteFill style={{ overflow: "hidden" }}>
          {sourceUrl && segments.length > 0 && (
            <Framed src={sourceUrl} segments={segments} fps={fps} cuts={cuts} overrides={overrides}
              geometry={geometry || {}} duration={durationInFrames / fps} />
          )}
        </AbsoluteFill>
      </VideoEffects>
      {subtitles && <Subtitles config={subtitles} />}
      {hook && <HookOverlay config={hook} />}
    </AbsoluteFill>
  );
};
