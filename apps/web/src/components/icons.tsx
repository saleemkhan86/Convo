interface IconProps {
  className?: string;
}

const base = "h-5 w-5";

export function ChatIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M21 11.5a8.4 8.4 0 01-9 8.4 8.6 8.6 0 01-3.8-.9L3 21l1.9-5.2A8.4 8.4 0 0112 3.1a8.4 8.4 0 019 8.4z" />
    </svg>
  );
}

export function MailIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M3.5 7.5L12 13l8.5-5.5" />
    </svg>
  );
}

export function ContactsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0113 0" />
      <path d="M16 4.6a3.5 3.5 0 010 6.8M17.5 14.2A6.5 6.5 0 0121.5 20" />
    </svg>
  );
}

export function SettingsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.03 1.56V21a2 2 0 11-4 0v-.09A1.7 1.7 0 009 19.35a1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.65 15a1.7 1.7 0 00-1.56-1.03H3a2 2 0 110-4h.09A1.7 1.7 0 004.65 9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.65 1.7 1.7 0 0010.03 3.1V3a2 2 0 114 0v.09c0 .68.4 1.3 1.03 1.56a1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9c.26.62.88 1.03 1.56 1.03H21a2 2 0 110 4h-.09c-.68 0-1.3.4-1.51.97z" />
    </svg>
  );
}

export function PhoneIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <rect x="6" y="2.5" width="12" height="19" rx="3" />
      <path d="M10.5 18.5h3" />
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className ?? "h-3.5 w-3.5"} aria-hidden>
      <path d="M4.5 12.5l5 5 10-11" />
    </svg>
  );
}

export function DoubleCheckIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={className ?? "h-3.5 w-3.5"} aria-hidden>
      <path d="M2 12.5l4 4 8-9" />
      <path d="M10 14.5l2 2 8-9" />
    </svg>
  );
}

export function SmileIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.5 4.5 0 007 0" />
      <path d="M9 9.5h.01M15 9.5h.01" />
    </svg>
  );
}

export function ReplyIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h9a7 7 0 017 7v1" />
    </svg>
  );
}

export function PencilIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M4 20h4L18 10l-4-4L4 16v4z" />
      <path d="M13 6l4 4" />
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" />
    </svg>
  );
}

export function XIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className ?? base} aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className ?? base} aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function ArrowLeftIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </svg>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className ?? base} aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.8-3.8" />
    </svg>
  );
}

export function LinkIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M9.5 14.5a4 4 0 010-5.6l2.6-2.6a4 4 0 015.6 5.6l-1.3 1.3" />
      <path d="M14.5 9.5a4 4 0 010 5.6l-2.6 2.6a4 4 0 01-5.6-5.6l1.3-1.3" />
    </svg>
  );
}

export function StatusIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className ?? base} aria-hidden>
      <circle cx="12" cy="12" r="9" strokeDasharray="4 3" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function GroupsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <circle cx="8.5" cy="8" r="3" />
      <path d="M2.8 19a5.7 5.7 0 0111.4 0" />
      <circle cx="16.5" cy="9.5" r="2.4" />
      <path d="M15 14.2a5.7 5.7 0 016.2 4.8" />
    </svg>
  );
}

export function StarIcon({ className, filled }: IconProps & { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M12 3.6l2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7L7.4 19l1-5.6-4-3.9 5.6-.8z" />
    </svg>
  );
}

export function PinIcon({ className, filled }: IconProps & { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M14.5 3.5l6 6-2.6 1.6-.6 4.4-4.3-4.3-5.6 5.6 1.1-5.2L3.5 11l5.6-5.6z" />
      <path d="M9 15l-4.5 4.5" />
    </svg>
  );
}

export function ArchiveIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <rect x="3" y="4.5" width="18" height="4" rx="1.4" />
      <path d="M5 8.5v9a2 2 0 002 2h10a2 2 0 002-2v-9" />
      <path d="M10 12.5h4" />
    </svg>
  );
}

export function BellOffIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M8.6 4.7A5.5 5.5 0 0117.5 9c0 4 1.5 5.6 1.5 5.6H7" />
      <path d="M6.5 8.4A5.5 5.5 0 006.5 14.6" />
      <path d="M10 19a2.2 2.2 0 004 0" />
      <path d="M3.5 3.5l17 17" />
    </svg>
  );
}

export function DotsIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className ?? base} aria-hidden>
      <circle cx="12" cy="5" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="12" cy="19" r="1.8" />
    </svg>
  );
}

export function BlockIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className ?? base} aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6.2 6.2l11.6 11.6" />
    </svg>
  );
}

export function FlagIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M5.5 21V4" />
      <path d="M5.5 4.8h11l-2 4 2 4h-11" />
    </svg>
  );
}

export function PaperclipIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M20 11.5l-8.2 8.2a5 5 0 01-7.1-7.1l8.6-8.6a3.4 3.4 0 014.8 4.8l-8.6 8.6a1.8 1.8 0 01-2.5-2.5l8.2-8.2" />
    </svg>
  );
}

export function ImageIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <rect x="3" y="4.5" width="18" height="15" rx="3" />
      <circle cx="8.5" cy="10" r="1.6" />
      <path d="M4 17.5l4.8-4.6 4 3.6 3-2.6 4 3.6" />
    </svg>
  );
}

export function MicIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v3" />
    </svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className ?? base} aria-hidden>
      <path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor" />
    </svg>
  );
}

export function PauseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className ?? base} aria-hidden>
      <path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" />
    </svg>
  );
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M4.5 12L20 5l-6.5 15-2-6.5z" />
    </svg>
  );
}

export function DownloadIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M12 4v10.5M8 11l4 4 4-4" />
      <path d="M4.5 19h15" />
    </svg>
  );
}

export function ForwardIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M14 4l6 6-6 6" />
      <path d="M20 10h-7a7 7 0 00-7 7v3" />
    </svg>
  );
}

export function ViewOnceIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v4.5l3 1.8" />
    </svg>
  );
}

export function MapPinIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M12 21s7-5.3 7-11a7 7 0 10-14 0c0 5.7 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.6" />
    </svg>
  );
}

export function TimerIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9.4V13l2.6 1.7M9.4 3h5.2" />
    </svg>
  );
}

export function GifIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <rect x="3" y="6" width="18" height="12" rx="3" />
      <path d="M9.4 10.2H7.8v3.6h1.6M14.4 10.2h-3.2v3.6M17.8 10.2h-1.4v3.6M16.4 12h.8" />
    </svg>
  );
}

export function VideoIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <rect x="2.5" y="6" width="12.5" height="12" rx="3" />
      <path d="M15 10.6l6.5-3.4v9.6L15 13.4z" />
    </svg>
  );
}

export function VideoOffIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M15 10.6l6.5-3.4v9.6l-3.4-1.8M12.6 18H5.5a3 3 0 01-3-3V9a3 3 0 013-3h1.4" />
      <path d="M2.5 21L21 2.5" />
    </svg>
  );
}

/** Hang up: the handset glyph turned upside down, the way every dialler draws it. */
export function PhoneOffIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <g transform="rotate(135 12 12)">
        <path d="M6.2 3.5h3l1.3 3.6-2 1.4a11.5 11.5 0 005.9 5.9l1.4-2 3.6 1.3v3a1.8 1.8 0 01-2 1.8A15.6 15.6 0 014.4 5.5a1.8 1.8 0 011.8-2z" />
      </g>
    </svg>
  );
}

export function MicOffIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M15 6.8V6a3 3 0 00-5.9-.7M9 10.2V14a3 3 0 006 0v-.6" />
      <path d="M5.5 11.5a6.5 6.5 0 009.8 5.6M18.5 11.5c0 .8-.1 1.5-.4 2.2M12 18v3" />
      <path d="M2.5 21L21 2.5" />
    </svg>
  );
}

export function CallIncomingIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M17 7L7 17M7 10.5V17h6.5" />
    </svg>
  );
}

export function CallOutgoingIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className ?? base} aria-hidden>
      <path d="M7 17L17 7M17 13.5V7h-6.5" />
    </svg>
  );
}
