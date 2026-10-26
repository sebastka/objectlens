// What the browser may show inline, by content type and file name. Shared by the server (which
// picks the type a preview is served with) and the UI (which picks the preview element).

export type PreviewKind = 'text' | 'image' | 'audio' | 'video' | 'pdf';

const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|x-sh|toml|x-toml|sql|graphql|ld\+json))/;
const TEXT_EXT =
  /\.(txt|md|markdown|csv|tsv|json|jsonl|ndjson|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|log|properties|tf|hcl|gitignore|dockerfile|svg|nix)$/i;
/** Image types browsers display; also the only images served inline. */
export const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/;

/** Media a browser plays or shows, by extension (for objects and files stored without a type). */
const MEDIA_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
};

const ext = (name: string) => {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
};

const kindOf = (type: string): PreviewKind | null =>
  INLINE_IMAGE.test(type)
    ? 'image'
    : type.startsWith('audio/')
      ? 'audio'
      : type.startsWith('video/')
        ? 'video'
        : type === 'application/pdf'
          ? 'pdf'
          : null;

export function previewKind(
  key: string,
  contentType: string | null,
  size: number,
  textMax: number,
): PreviewKind | null {
  const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const byType = kindOf(t);
  if (byType) return byType;
  if ((TEXT_TYPES.test(t) || TEXT_EXT.test(key)) && size <= textMax) return 'text';
  // Stored without a proper type: fall back to the extension for media too.
  if (t === '' || t === 'application/octet-stream' || t === 'binary/octet-stream') {
    const e = MEDIA_EXT[ext(key)];
    if (e) return kindOf(e);
  }
  return null;
}

/**
 * The type an inline preview is served with: chosen by ObjectLens, never taken unchecked from
 * the object (it could say text/html). null = not shown inline (served as an attachment).
 */
export function inlineType(key: string, contentType: string | null): { kind: PreviewKind; type: string } | null {
  const kind = previewKind(key, contentType, Infinity, Infinity);
  const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!kind) return null;
  if (kind === 'text') return { kind, type: 'text/plain; charset=utf-8' };
  if (kind === 'pdf') return { kind, type: 'application/pdf' };
  const type = kindOf(t) === kind ? t : MEDIA_EXT[ext(key)];
  return type ? { kind, type } : null;
}
