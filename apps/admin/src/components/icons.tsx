import type { ReactNode } from 'react';

// 16px outline icons with a 1.5 stroke, drawn in `currentColor`; the stroke is set by the stylesheet to match the text weight beside them.
const icon = (path: ReactNode) =>
    function Icon({ className }: { className?: string }) {
        return (
            <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>
                {path}
            </svg>
        );
    };

export const OverviewIcon = icon(<path d="M2.5 13.5V8m4 5.5v-9m4 9V6.5m3 7H2" />);
export const UsersIcon = icon(
    <>
        <circle cx="6" cy="5.5" r="2.5" />
        <path d="M1.5 13c.4-2.2 2.2-3.5 4.5-3.5s4.1 1.3 4.5 3.5M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 9.8c1.4.5 2.3 1.6 2.5 3.2" />
    </>,
);
export const InviteIcon = icon(
    <>
        <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2" />
        <path d="m2.5 4.5 5.5 4 5.5-4" />
    </>,
);
export const SettingsIcon = icon(
    <>
        <path d="M2.5 5h6m3 0h2M2.5 11h2m3 0h6" />
        <circle cx="10" cy="5" r="1.5" />
        <circle cx="6" cy="11" r="1.5" />
    </>,
);
export const SearchIcon = icon(
    <>
        <circle cx="7" cy="7" r="4.25" />
        <path d="m10.25 10.25 3 3" />
    </>,
);
export const ChevronRight = icon(<path d="m6 3.5 4.5 4.5L6 12.5" />);
export const ChevronLeft = icon(<path d="M10 3.5 5.5 8l4.5 4.5" />);
export const PlusIcon = icon(<path d="M8 3v10M3 8h10" />);
export const MinusIcon = icon(<path d="M3 8h10" />);
export const SignOutIcon = icon(<path d="M6.5 2.75h-2a1.75 1.75 0 0 0-1.75 1.75v7A1.75 1.75 0 0 0 4.5 13.25h2M10 5l3 3-3 3M13 8H6.5" />);
