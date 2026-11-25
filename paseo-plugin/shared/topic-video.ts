export type TopicVideoFrame = { time: number; mimeType: 'image/jpeg'; base64: string };
export type TopicVideoPreview = { duration: number; frames: TopicVideoFrame[]; size?: number; error?: string };
export type TopicStoredVideo = {assetId: string; name: string; size?: number; duration: number; frames: Array<{assetId: string; time: number}>; error?: string};
export const MAX_INLINE_VIDEO_BYTES = 8 * 1024 * 1024;
export function inlineVideo(size?: number) { return size !== undefined && size <= MAX_INLINE_VIDEO_BYTES; }
export function videoFileSize(size?: number) {
  return size === undefined ? '' : size < 1024 * 1024 ? (size / 1024).toFixed(0) + ' KiB' : (size / (1024 * 1024)).toFixed(1) + ' MiB';
}
export function videoTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return (value >= 3600 ? String(Math.floor(value / 3600)) + ':' : '') + String(Math.floor(value / 60) % 60).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
}
