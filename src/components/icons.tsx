/**
 * Inline SVG icon set.
 *
 * Hand-rolled rather than pulling in an icon package: the app needs fewer than
 * twenty glyphs, and keeping them local avoids a dependency and keeps stroke
 * weight consistent with the canvas chrome.
 */

import type { ReactNode } from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 16, className, children }: IconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function BranchIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 3v5.2A2.8 2.8 0 0 0 6.8 11H11" />
      <circle cx="4" cy="3" r="1.5" />
      <path d="M11 9.6 13 11l-2 1.4" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Svg>
  );
}

export function MinusIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M3.5 8h9" />
    </Svg>
  );
}

export function FitIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M2.5 6V3.6a1 1 0 0 1 1-1H6M10 2.6h2.4a1 1 0 0 1 1 1V6M13.4 10v2.4a1 1 0 0 1-1 1H10M6 13.4H3.6a1 1 0 0 1-1-1V10" />
    </Svg>
  );
}

export function TargetIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="4.6" />
      <circle cx="8" cy="8" r="1.3" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M3.4 5h9.2M6.4 5V3.6h3.2V5M4.9 5l.6 8h5l.6-8" />
    </Svg>
  );
}

export function CollapseIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 3.6h8" />
      <path d="M4.6 7.2 8 10.6l3.4-3.4" />
    </Svg>
  );
}

export function ExpandIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 3.6h8" />
      <path d="M4.6 10.4 8 7l3.4 3.4" />
    </Svg>
  );
}

export function UndoIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M5.6 4.6 2.8 7.4l2.8 2.8" />
      <path d="M3.1 7.4h6a3.4 3.4 0 0 1 0 6.8H7.4" />
    </Svg>
  );
}

export function RedoIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M10.4 4.6l2.8 2.8-2.8 2.8" />
      <path d="M12.9 7.4h-6a3.4 3.4 0 0 0 0 6.8h1.7" />
    </Svg>
  );
}

export function DownloadIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M8 2.6v7.2M5.2 7.4 8 10.2l2.8-2.8M3 12.4h10" />
    </Svg>
  );
}

export function UploadIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M8 10.4V3.2M5.2 5.6 8 2.8l2.8 2.8M3 12.4h10" />
    </Svg>
  );
}

export function HelpIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M6.4 6.3a1.7 1.7 0 1 1 2.4 1.6c-.5.3-.8.6-.8 1.2v.3" />
      <path d="M8 11.4h.01" />
    </Svg>
  );
}

export function ResetIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M3 8a5 5 0 1 1 1.6 3.7" />
      <path d="M2.6 5.4 3 8.2l2.8-.4" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
    </Svg>
  );
}

export function ParentIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M11 12V7.4A2.4 2.4 0 0 0 8.6 5H4.6" />
      <path d="M6.6 3 4.2 5l2.4 2" />
    </Svg>
  );
}

export function SettingsIcon(): ReactNode {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" height="1.15rem" width="1.15rem" fill="#98a0b5"><path d="M9.69,21.5L9.31,18.45q-0.4-0.13-0.82-0.38T7.73,17.56L4.91,18.75l-2.31-4l2.44-1.84Q5.01,12.68 5,12.46T4.98,12.01q0-0.21 0.01-0.43t0.05-0.48L2.6,9.25L4.91,5.27L7.72,6.45Q8.08,6.17 8.5,5.93T9.3,5.55L9.69,2.5h4.62l0.38,3.06q0.45,0.16 0.81,0.38t0.74,0.51l2.85-1.18L21.4,9.25l-2.48,1.87q0.05,0.24 0.06,0.45t0,0.42q0,0.2-0.01,0.41T18.9,12.9l2.46,1.85l-2.31,4l-2.82-1.2q-0.37,0.3-0.76,0.52t-0.79,0.37L14.31,21.5H9.69ZM11,20h1.97l0.36-2.68q0.77-0.2 1.4-0.57t1.22-0.95l2.48,1.04l0.98-1.7l-2.17-1.63q0.13-0.39 0.17-0.76T17.46,12q0-0.39-0.05-0.75T17.25,10.5l2.19-1.65l-0.98-1.7L15.94,8.21q-0.5-0.54-1.2-0.95T13.32,6.68L13,4H11.02L10.68,6.67Q9.92,6.85 9.27,7.22T8.03,8.18L5.55,7.15L4.57,8.85l2.16,1.61Q6.6,10.82 6.55,11.2T6.5,12.01q0,0.39 0.05,0.77t0.17,0.74L4.57,15.15l0.98,1.7L8.03,15.8q0.57,0.58 1.22,0.96t1.43,0.57L11,20Zm1.01-5q1.25,0 2.12-0.88T15.01,12T14.14,9.88T12.01,9Q10.75,9 9.88,9.88T9.01,12t0.87,2.12T12.01,15ZM12,12Z"/></svg>
  );
}

export function ChatIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M3 4.2h10v7H7.4L4.6 13.4v-2.2H3z" />
      <path d="M5.8 7.7h4.4" />
    </Svg>
  );
}

export function NoteIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M4 2.6h5.4L12.8 6v7.4H4z" />
      <path d="M9.2 2.8V6h3.4M6 8.6h4.4M6 11h3.2" />
    </Svg>
  );
}

export function SendIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <path d="M2.6 8 13.4 2.8 10.8 13l-2.6-3.4z" />
      <path d="M8.2 9.6 13.4 2.8" />
    </Svg>
  );
}

export function StopIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.4" />
    </Svg>
  );
}

export function KeyIcon(props: IconProps): ReactNode {
  return (
    <Svg {...props}>
      <circle cx="5.2" cy="10.8" r="2.4" />
      <path d="M7 9 12.8 3.2M10.6 5.4l1.6 1.6M9.2 6.8l1.4 1.4" />
    </Svg>
  );
}
