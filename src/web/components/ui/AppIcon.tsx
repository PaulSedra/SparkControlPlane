/**
 * @fileoverview Shared Lucide icon wrapper with semantic size and accessible
 * label handling.
 */

import type { LucideIcon } from 'lucide-react';

const ICON_SIZES = {
    brand: 20,
    control: 16,
    empty: 32,
    status: 14,
} as const;

/** Renders a Lucide icon using the application's size and accessibility rules. */
export function AppIcon({
    className,
    icon: Icon,
    label,
    size = 'control',
}: Readonly<{
    className?: string;
    icon: LucideIcon;
    label?: string;
    size?: keyof typeof ICON_SIZES;
}>) {
    return (
        <Icon
            aria-hidden={label == null ? 'true' : undefined}
            aria-label={label}
            className={className == null ? 'app-icon' : `app-icon ${className}`}
            role={label == null ? undefined : 'img'}
            size={ICON_SIZES[size]}
            strokeWidth={2}
        />
    );
}
