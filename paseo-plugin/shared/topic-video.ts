export type TopicVideoFrame = { time: number; mimeType: 'image/jpeg'; base64: string };
export type TopicVideoPreview = { duration: number; frames: TopicVideoFrame[] };
export type TopicStoredVideo = {assetId: string; name: string; duration: number; frames: Array<{assetId: string; time: number}>};
export function videoTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return (value >= 3600 ? String(Math.floor(value / 3600)) + ':' : '') + String(Math.floor(value / 60) % 60).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
}
