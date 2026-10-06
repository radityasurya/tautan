// Every icon tautan draws, lifted from docs/design/src/*.dc.html so the weights and the
// geometry match the mockups. All 24×24, stroked with currentColor, decorative.
import type { SVGProps } from 'react';

type Props = { size?: number } & SVGProps<SVGSVGElement>;

function Icon({ size = 20, strokeWidth = 1.8, children, ...rest }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Back = (p: Props) => (
  <Icon size={24} strokeWidth={2} {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Icon>
);

export const Plus = (p: Props) => (
  <Icon strokeWidth={2} {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const ChevronDown = (p: Props) => (
  <Icon size={12} strokeWidth={2.4} {...p}>
    <path d="M6 9l6 6 6-6" />
  </Icon>
);

export const ChevronRight = (p: Props) => (
  <Icon size={12} strokeWidth={2.4} {...p}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);

/** Collapse every group: two chevrons converging on the centre line. */
export const CollapseAll = (p: Props) => (
  <Icon {...p}>
    <path d="M6 5l6 6 6-6" />
    <path d="M6 19l6-6 6 6" />
  </Icon>
);

/** Expand every group: the same two chevrons, pointing outward. */
export const ExpandAll = (p: Props) => (
  <Icon {...p}>
    <path d="M6 9l6-6 6 6" />
    <path d="M6 15l6 6 6-6" />
  </Icon>
);

/** The 2×2 grid that opens the Switch drawer. */
export const Switch2 = (p: Props) => (
  <Icon {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Icon>
);

export const Speaker = (p: Props) => (
  <Icon {...p}>
    <path d="M4 10v4h3.5L12 18V6L7.5 10H4z" />
    <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5M18 7a7 7 0 0 1 0 10" />
  </Icon>
);

export const More = ({ size = 20, ...rest }: Props) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden {...rest}>
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);

/** The refresh circle, Lucide's `rotate-cw` geometry, so it matches the stroked set. */
export const Refresh = (p: Props) => (
  <Icon {...p}>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </Icon>
);

export const Search = (p: Props) => (
  <Icon size={18} strokeWidth={2} {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4-4" />
  </Icon>
);

export const Mic = (p: Props) => (
  <Icon {...p}>
    <rect x="9" y="3" width="6" height="12" rx="3" />
    <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" />
  </Icon>
);

export const Attach = (p: Props) => (
  <Icon {...p}>
    <path d="M20 12.5l-7.8 7.8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.9 18a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4" />
  </Icon>
);

export const Send = (p: Props) => (
  <Icon strokeWidth={2} {...p}>
    <path d="M12 19V5m0 0-6 6m6-6 6 6" />
  </Icon>
);

export const Down = (p: Props) => (
  <Icon size={14} strokeWidth={2} {...p}>
    <path d="M12 5v14m0 0 6-6m-6 6-6-6" />
  </Icon>
);

export const AgentsTab = (p: Props) => (
  <Icon size={22} {...p}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </Icon>
);

export const HostsTab = (p: Props) => (
  <Icon size={22} {...p}>
    <rect x="4" y="5" width="16" height="6" rx="1.5" />
    <rect x="4" y="13" width="16" height="6" rx="1.5" />
    <path d="M7.5 8h.01M7.5 16h.01" />
  </Icon>
);

export const SettingsTab = (p: Props) => (
  <Icon size={22} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
  </Icon>
);

export const Install = (p: Props) => (
  <Icon size={18} strokeWidth={1.6} {...p}>
    <path d="M12 15V4m0 0 3.2 3.2M12 4 8.8 7.2" />
    <path d="M7.5 10.5H6A1.5 1.5 0 0 0 4.5 12v6.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5h-1.5" />
  </Icon>
);

/** The keys trigger in the dock: a key bar folded into one 24×24 cap. */
export const Keyboard = (p: Props) => (
  <Icon {...p}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M6.5 14h11" />
  </Icon>
);

/** The Chat lens: a speech bubble. 16 px in the phone header's icon pair. */
export const ChatLens = (p: Props) => (
  <Icon size={16} {...p}>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z" />
  </Icon>
);

/** The Screen lens: a terminal window with a prompt chevron. */
export const ScreenLens = (p: Props) => (
  <Icon size={16} {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3" />
  </Icon>
);
