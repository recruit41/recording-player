import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polygon points="6 3 20 12 6 21 6 3" fill="currentColor" />
    </Svg>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6" y="4" width="4" height="16" fill="currentColor" />
      <rect x="14" y="4" width="4" height="16" fill="currentColor" />
    </Svg>
  );
}

export function SkipBackIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </Svg>
  );
}

export function SkipForwardIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </Svg>
  );
}

export function VolumeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </Svg>
  );
}

export function MutedIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </Svg>
  );
}

export function MaximizeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </Svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="6 9 12 15 18 9" />
    </Svg>
  );
}

export function LoaderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </Svg>
  );
}

export function VideoOffIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8" />
      <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10Z" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </Svg>
  );
}
