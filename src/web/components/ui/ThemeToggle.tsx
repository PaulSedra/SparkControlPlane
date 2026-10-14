/**
 * @fileoverview Theme context and toggle for the light/dark application shell.
 */

import { Moon, Sun } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AppIcon } from './AppIcon';

const THEME_STORAGE_KEY = 'spark-control-plane.theme';

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/** Theme values persisted by the application shell. */
export type ThemeMode = 'dark' | 'light';

interface ThemeContextValue {
    mode: ThemeMode;
    setMode: (mode: ThemeMode) => void;
}

/**
 * Owns the shell theme preference and applies it to the document root.
 *
 * The initial mode is read from browser storage when available, then every
 * change updates both `data-theme` and `color-scheme` for CSS and native
 * controls. Storage is best effort: private browsing or disabled storage
 * falls back to the dark reference theme without preventing rendering.
 */
export function ThemeProvider({ children }: Readonly<{ children: ReactNode }>) {
    const [mode, setMode] = useState<ThemeMode>(readStoredTheme);

    useEffect(() => {
        document.documentElement.dataset.theme = mode;
        document.documentElement.style.colorScheme = mode;
        try {
            window.localStorage.setItem(THEME_STORAGE_KEY, mode);
        } catch {
            // Theme persistence is optional when storage is unavailable.
        }
    }, [mode]);

    const value = useMemo(() => ({ mode, setMode }), [mode]);
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Switches between the two document themes through the nearest provider and
 * exposes the destination mode in the button's accessible label.
 */
export function ThemeToggle() {
    const context = useContext(ThemeContext);
    if (context == null) {
        throw new Error('ThemeToggle must be rendered inside ThemeProvider.');
    }

    const nextMode = context.mode === 'dark' ? 'light' : 'dark';
    const Icon = context.mode === 'dark' ? Sun : Moon;
    return (
        <button
            aria-label={`Switch to ${nextMode} mode`}
            className="global-theme-toggle"
            onClick={() => context.setMode(nextMode)}
            title={`Switch to ${nextMode} mode`}
            type="button"
        >
            <AppIcon icon={Icon} size="status" />
        </button>
    );
}

function readStoredTheme(): ThemeMode {
    if (typeof window !== 'undefined') {
        try {
            const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
            if (stored === 'light' || stored === 'dark') {
                return stored;
            }
        } catch {
            // Use the dark reference theme when storage is unavailable.
        }
    }

    return 'dark';
}
