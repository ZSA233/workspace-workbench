export const MAX_REGISTERED_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
export function artifactByteLimit(mimeType: string) {
  return mimeType.toLowerCase().startsWith('video/') ? MAX_VIDEO_BYTES : MAX_REGISTERED_BYTES;
}
export const REGISTERED_MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'application/pdf', 'application/octet-stream', 'text/plain', 'text/markdown', 'text/html', 'application/json',
] as const;
export function supportedArtifact(mimeType: string, size?: number) {
  return (REGISTERED_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase()) && (size === undefined || size <= artifactByteLimit(mimeType));
}

/** Archive labels are hints; the original response determines delivery format. */
export function selectableArchiveArtifact(mimeType: string, size?: number) {
  return size === undefined || size <= artifactByteLimit(mimeType);
}
export function canonicalArtifactMimeType(value: string) {
  const type = value.split(';')[0].trim().toLowerCase();
  return ({ 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/x-png': 'image/png' } as Record<string, string>)[type]
    || (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : 'application/octet-stream');
}
