import React, { useEffect, useMemo, useState } from 'react';
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
}) {
    const fps = 30;
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
                autoPlay
                loop
            />
        </div>
    );
}
