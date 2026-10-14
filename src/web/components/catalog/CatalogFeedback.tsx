/**
 * @fileoverview Retryable catalog and selected-detail error notices.
 */

import { AlertCircle } from 'lucide-react';
import { AppIcon } from '../ui/AppIcon';
import type { CatalogLoadState } from '../../types/catalogTypes';

/**
 * Shows independent retry affordances for tree discovery and selected-detail
 * failures. A detail error does not replace a successfully loaded catalog
 * tree, and a catalog error does not require the detail callback to be used.
 */
export function CatalogFeedback({
    detailState,
    loadState,
    onRetryDetail,
    onRetryCatalog,
}: Readonly<{
    detailState?: CatalogLoadState;
    loadState: CatalogLoadState;
    onRetryDetail: () => void;
    onRetryCatalog: () => void;
}>) {
    return (
        <div className="catalog-feedback">
            {loadState.kind === 'error' && (
                <CatalogNotice message={loadState.message} onRetry={onRetryCatalog} />
            )}
            {detailState?.kind === 'error' && (
                <CatalogNotice message={detailState.message} onRetry={onRetryDetail} />
            )}
        </div>
    );
}

function CatalogNotice({
    message,
    onRetry,
}: Readonly<{
    message: string;
    onRetry: () => void;
}>) {
    return (
        <div className="catalog-notice error" role="alert">
            <AppIcon icon={AlertCircle} size="status" />
            <span>{message}</span>
            <button onClick={onRetry} type="button">Retry</button>
        </div>
    );
}
