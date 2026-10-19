// The block "copy" puts on the clipboard, one per short (App's "copy all"
// joins them with blank lines).
export function clipCopyBlock(clip, index) {
    return [
        `#${index + 1}`,
        `Name: ${clip?.video_title_for_youtube_short || ''}`,
        `Description: ${clip?.video_description_for_tiktok || clip?.video_description_for_instagram || ''}`,
    ].join('\n');
}
