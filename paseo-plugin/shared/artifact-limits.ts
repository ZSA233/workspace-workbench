export const MAX_REGISTERED_BYTES = 8 * 1024 * 1024;
export const REGISTERED_MIME_TYPES = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain', 'text/markdown', 'text/html', 'application/json',
] as const;
export function supportedArtifact(mimeType: string, size?: number) {
  return (REGISTERED_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase()) && (size === undefined || size <= MAX_REGISTERED_BYTES);
}
