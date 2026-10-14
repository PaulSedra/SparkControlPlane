/**
 * @fileoverview Locale-aware formatting helpers for dates, durations, bytes,
 * and counts shown in the web UI.
 */

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
});

/**
 * Formats a valid timestamp with the user's locale-specific compact date/time
 * pattern; empty values become `Not reported` and invalid values are returned
 * unchanged so diagnostics are not hidden.
 */
export function formatDate(value?: string | number | null): string {
    if (value == null || value === '') {
        return 'Not reported';
    }

    const normalized =
        typeof value === 'string'
            ? value.replace(/GMT$/, 'Z').replace(/(\d{2}:\d{2}:\d{2}\.\d{3})Z$/, '$1Z')
            : value;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return DATE_FORMAT.format(date);
}

/**
 * Formats milliseconds using ms, seconds, minutes, or hours, selecting the
 * smallest unit that avoids unwieldy values. Missing or non-finite durations
 * intentionally render as `0 ms` for the UI's zero-state convention.
 */
export function formatDuration(ms?: number | null): string {
    if (ms == null || !Number.isFinite(ms)) {
        return '0 ms';
    }

    if (ms < 1000) {
        return `${Math.round(ms)} ms`;
    }

    const seconds = ms / 1000;
    if (seconds < 60) {
        return `${seconds.toFixed(1)} s`;
    }

    const minutes = seconds / 60;
    if (minutes < 60) {
        return `${minutes.toFixed(1)} min`;
    }

    return `${(minutes / 60).toFixed(1)} hr`;
}

/**
 * Formats bytes with binary KiB/MiB/GiB/TiB thresholds and compact precision;
 * missing or non-finite values render as `0 B`.
 */
export function formatBytes(bytes?: number | null): string {
    if (bytes == null || !Number.isFinite(bytes)) {
        return '0 B';
    }

    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let size = bytes;
    let unitIndex = 0;

    while (Math.abs(size) >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex += 1;
    }

    const precision = unitIndex === 0 || Math.abs(size) >= 10 ? 0 : 1;
    return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

/** Formats a count with the browser locale, treating missing values as zero. */
export function formatNumber(value?: number | null): string {
    return new Intl.NumberFormat().format(value ?? 0);
}
