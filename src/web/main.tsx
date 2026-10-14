/**
 * @fileoverview Browser entry point that mounts the routed application inside
 * the theme provider.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './query/queryClient';
import AppRouter from './routes/AppRouter';
import { ThemeProvider } from './components/ui/ThemeToggle';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <ThemeProvider>
                <AppRouter />
            </ThemeProvider>
        </QueryClientProvider>
    </StrictMode>,
);
