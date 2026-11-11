import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Player } from '@remotion/player';
import { ShortVideo } from '../remotion/compositions/ShortVideo';

/**
 * Wraps Remotion's Player component for real-time preview in modals.
 * Accepts the same ShortVideoProps interface as the Remotion composition.
 *
 * @param {object} props
 * @param {string} props.videoUrl - URL to the base clip video
 * @param {number} props.durationInSeconds - Video duration in seconds
 * @param {object|null} props.subtitles - SubtitleConfig or null
 * @param {object|null} props.hook - HookConfig or null
 * @param {object|null} props.effects - EffectsConfig or null
 * @param {string} [props.className] - Additional CSS classes
 */
export default function RemotionPreview({
    videoUrl,
    durationInSeconds = 30,
    subtitles = null,
    hook = null,
    effects = null,
    className = '',
    seekTo = null,          // { t: seconds, n: nonce }: jump there and pause
    initialTime = null,
    onTime = null,
}) {
    const fps = 30;
    const playerRef = useRef(null);
    const onTimeRef = useRef(onTime);
    onTimeRef.current = onTime;
    useEffect(() => {
        const p = playerRef.current;
        if (!p || !seekTo) return;
        p.pause();
        p.seekTo(Math.max(0, Math.round(seekTo.t * fps)));
    }, [seekTo]);
    // The shared workspace playhead: report frames back, and seek to it once
    // the real length is known (the timeline is rebuilt when it is measured,
    // which would undo an earlier seek). Frames before that seek are the
    // player's own 0 and must not overwrite the shared time.
    const seeded = useRef(initialTime === null);
    useEffect(() => {
        const player = playerRef.current;
        if (!player) return undefined;
        const update = (event) => {
            if (seeded.current) onTimeRef.current?.(event?.detail?.frame / fps);
        };
        player.addEventListener('frameupdate', update);
        return () => player.removeEventListener('frameupdate', update);
    }, []);
    // The real length of the file being previewed. The caller's figure comes
    // from the clip's start/end, which is wrong for a trimmed clip made of
    // several pieces (start..end spans the gaps) and whenever the metadata and
    // the render disagree: the preview then ran on past the video's end with
    // the captions still animating over a frozen last frame.
    const [measured, setMeasured] = useState(null);
    useEffect(() => {
        setMeasured(null);
        if (!videoUrl) return undefined;
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.muted = true;
        v.onloadedmetadata = () => {
            if (Number.isFinite(v.duration) && v.duration > 0) setMeasured(v.duration);
        };
        v.src = videoUrl;
        return () => { v.onloadedmetadata = null; v.removeAttribute('src'); v.load(); };
    }, [videoUrl]);
    const seconds = measured ?? durationInSeconds;
    useEffect(() => {
        const player = playerRef.current;
        if (seeded.current || !player || (videoUrl && measured === null)) return;
        if (Number.isFinite(initialTime)) {
            player.pause();
            player.seekTo(Math.max(0, Math.round(initialTime * fps)));
        }
        seeded.current = true;
    // initialTime is read once per mount by design
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [measured, videoUrl]);
    const durationInFrames = Math.max(1, Math.floor(seconds * fps));

    const inputProps = useMemo(
        () => ({
            videoUrl,
            durationInFrames,
            fps,
            width: 1080,
            height: 1920,
            subtitles,
            hook,
            effects,
        }),
        [videoUrl, durationInFrames, subtitles, hook, effects]
    );

    return (
        <div className={`w-full h-full ${className}`}>
            <Player
                ref={playerRef}
                component={ShortVideo}
                inputProps={inputProps}
                durationInFrames={durationInFrames}
                fps={fps}
                compositionWidth={1080}
                compositionHeight={1920}
                style={{
                    width: '100%',
                    height: '100%',
                }}
                controls
                loop
            />
        </div>
    );
}
