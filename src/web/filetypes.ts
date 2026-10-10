import type { IconName } from './components/icons.tsx';

const EXT: [RegExp, IconName][] = [
  [/\.(png|jpe?g|gif|webp|avif|bmp|svg|ico|tiff?|heic)$/i, 'image'],
  [/\.(mp4|mov|mkv|webm|avi|mp3|wav|flac|ogg|m4a|aac|opus)$/i, 'media'],
  [/\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar|jar|war)$/i, 'archive'],
  [
    /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|sql|json|ya?ml|toml|xml|html?|css|tf)$/i,
    'code',
  ],
  [/\.(txt|md|markdown|csv|tsv|log|pdf|docx?|rtf|odt)$/i, 'fileText'],
];

/** The icon for a key, by extension. */
export function fileIcon(key: string): IconName {
  for (const [re, icon] of EXT) if (re.test(key)) return icon;
  return 'file';
}
