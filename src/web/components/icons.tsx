// Stroke icons on a 16×16 grid; they inherit the text colour.
import type { ReactNode } from 'react';

const PATHS = {
  folder: <path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6.5a1 1 0 0 0-1-1H7.6L6 3H2.5a1 1 0 0 0-1 1.5z" />,
  folderPlus: (
    <>
      <path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6.5a1 1 0 0 0-1-1H7.6L6 3H2.5a1 1 0 0 0-1 1.5z" />
      <path d="M8 7.5v4M6 9.5h4" />
    </>
  ),
  file: (
    <>
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="M9.5 1.5v3h3" />
    </>
  ),
  fileText: (
    <>
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="M9.5 1.5v3h3M5.5 8h5M5.5 10.5h5M5.5 5.5h2" />
    </>
  ),
  image: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <circle cx="5.5" cy="6" r="1.2" />
      <path d="M14.5 11 10.5 7l-6 6.5" />
    </>
  ),
  media: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="m6.5 5.5 4 2.5-4 2.5z" />
    </>
  ),
  archive: (
    <>
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="M7 3v1.5M8 5v1.5M7 7v1.5M6.5 10h2v2h-2z" />
    </>
  ),
  code: (
    <>
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="m6.5 8-1.5 1.5L6.5 11M9.5 8l1.5 1.5L9.5 11" />
    </>
  ),
  bucket: (
    <>
      <ellipse cx="8" cy="4" rx="5.5" ry="2" />
      <path d="M2.5 4l1.2 8.8c.1.9 2 1.7 4.3 1.7s4.2-.8 4.3-1.7L13.5 4" />
    </>
  ),
  server: (
    <>
      <rect x="1.5" y="2" width="13" height="5" rx="1" />
      <rect x="1.5" y="9" width="13" height="5" rx="1" />
      <path d="M4 4.5h.01M4 11.5h.01" />
    </>
  ),
  upload: <path d="M8 10.5V2M4.5 5.5 8 2l3.5 3.5M2 10.5v3h12v-3" />,
  download: <path d="M8 2v8.5M4.5 7 8 10.5 11.5 7M2 10.5v3h12v-3" />,
  trash: <path d="M2.5 4h11M6 4V2.5h4V4M3.8 4l.7 9.5h7l.7-9.5M6.5 6.5v5M9.5 6.5v5" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="9" height="9" rx="1" />
      <path d="M10.5 5.5v-3a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h3" />
    </>
  ),
  move: <path d="M1.5 8h11M9 4.5 12.5 8 9 11.5M14.5 2.5v11" />,
  pencil: <path d="M10.5 2.5l3 3-8 8h-3v-3zM8.5 4.5l3 3" />,
  refresh: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 4 4" />
    </>
  ),
  link: <path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.8 2.8 0 0 1 4 4L11 8.5M9 11.5l-1.2 1.2a2.8 2.8 0 0 1-4-4L5 7.5" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7.2v4M8 4.8h.01" />
    </>
  ),
  history: <path d="M2 8a6 6 0 1 0 1.8-4.3M2 2v3.5h3.5M8 5v3.2l2.2 1.5" />,
  tag: (
    <>
      <path d="M1.5 2.5v5l7 7 6-6-7-7h-5a1 1 0 0 0-1 1z" />
      <circle cx="5" cy="5" r="1" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="7" width="10" height="7.5" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8 3.4 3.4" />
    </>
  ),
  chevronRight: <path d="m6 3.5 4.5 4.5L6 12.5" />,
  chevronDown: <path d="m3.5 6 4.5 4.5L12.5 6" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  plus: <path d="M8 3v10M3 8h10" />,
  check: <path d="m3 8.5 3 3 7-7" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  sum: <path d="M12 3H4l4.5 5L4 13h8" />,
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`icon ${className ?? ''}`}
    >
      {PATHS[name]}
    </svg>
  );
}
