import React from 'react';

const Svg = ({ size = 16, children, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
);

export const PlayIcon = (p) => (
  <Svg {...p}>
    <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.89l11-6.86a1.05 1.05 0 0 0 0-1.78l-11-6.86A1.05 1.05 0 0 0 8 5.14z" />
  </Svg>
);

export const PauseIcon = (p) => (
  <Svg {...p}>
    <path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" />
  </Svg>
);

export const NextIcon = (p) => (
  <Svg {...p}>
    <path d="M6 5.5v13c0 .77.84 1.24 1.5.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 6 5.5z" />
    <path d="M17 5h2.5v14H17z" />
  </Svg>
);

export const PrevIcon = (p) => (
  <Svg {...p}>
    <path d="M18 5.5v13c0 .77-.84 1.24-1.5.85l-10-6.5a1 1 0 0 1 0-1.7l10-6.5A1 1 0 0 1 18 5.5z" />
    <path d="M4.5 5H7v14H4.5z" />
  </Svg>
);

export const HeartIcon = ({ filled, ...p }) =>
  filled ? (
    <Svg {...p}>
      <path d="M12 21s-7.5-4.9-10-9.5C.4 8.4 2.2 4.5 5.8 4.1c2-.2 3.9.8 4.9 2.4l1.3 2 1.3-2c1-1.6 2.9-2.6 4.9-2.4 3.6.4 5.4 4.3 3.8 7.4C19.5 16.1 12 21 12 21z" />
    </Svg>
  ) : (
    <Svg {...p} fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 20s-6.8-4.5-9.1-8.7C1.4 8.5 3 5.1 6.2 4.7c1.8-.2 3.5.7 4.4 2.2l1.4 2.1 1.4-2.1c.9-1.5 2.6-2.4 4.4-2.2 3.2.4 4.8 3.8 3.3 6.6C18.8 15.5 12 20 12 20z" />
    </Svg>
  );

export const TrashIcon = (p) => (
  <Svg {...p}>
    <path d="M9 3h6l.5 1.5H20V7H4V4.5h4.5zM6 8.5h12l-.8 12a1.5 1.5 0 0 1-1.5 1.4H8.3a1.5 1.5 0 0 1-1.5-1.4z" />
  </Svg>
);

export const RefreshIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 3v5h-5" />
  </Svg>
);

export const NoteIcon = (p) => (
  <Svg {...p}>
    <path d="M9 3v11.55A4 4 0 1 0 11 18V7h7V3z" />
  </Svg>
);

export const HomeIcon = (p) => (
  <Svg {...p}>
    <path d="M12 3 2.5 10.5V21H9v-6h6v6h6.5V10.5z" />
  </Svg>
);

export const ClockIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </Svg>
);

export const ChevronIcon = ({ open, ...p }) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="2.2">
    {open ? <path d="M5 14.5 12 8l7 6.5" /> : <path d="M5 9.5 12 16l7-6.5" />}
  </Svg>
);

export const ListIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);

export const PlaylistAddIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 6h12M4 11h12M4 16h7" />
    <path d="M17 13.5v6M14 16.5h6" />
  </Svg>
);

export const CheckIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="2.6">
    <path d="M4.5 12.5 10 18 19.5 7" />
  </Svg>
);

export const PencilIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="1.9">
    <path d="M4 20l1-4L17.5 3.5a2.1 2.1 0 0 1 3 3L8 19z" />
  </Svg>
);

export const PlusIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="2.2">
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const HamburgerIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const GearIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4L9.6 5a7.6 7.6 0 0 0-2.6 1.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.4z" />
  </Svg>
);

export const DownloadIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 3v11" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 20h16" />
  </Svg>
);

export const CrossIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="2.2">
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const SpeakerIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </Svg>
);

export const LaptopIcon = (p) => (
  <Svg {...p} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
    <rect x="4.5" y="5" width="15" height="10.5" rx="1.5" />
    <path d="M2.5 19h19" strokeLinecap="round" />
  </Svg>
);
