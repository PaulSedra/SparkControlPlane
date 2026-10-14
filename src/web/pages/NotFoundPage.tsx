/**
 * @fileoverview Fallback page for unmatched application routes.
 */

import { ArrowLeft } from 'lucide-react';
import { AppIcon } from '../components/ui/AppIcon';
import { navigateTo } from '../routes/useCurrentRoute';

/**
 * Handles unmatched browser paths with a recoverable route back to the
 * pipeline list; it deliberately does not redirect automatically so a bad
 * deep link remains visible to the user.
 */
export function NotFoundPage() {
    return (
        <main className="not-found-page">
            <div>
                <span className="crumb">Workspace</span>
                <h1>Page not found</h1>
                <p>The requested Spark Control Plane page does not exist.</p>
                <button
                    className="primary-button"
                    onClick={() => navigateTo('/')}
                    type="button"
                >
                    <AppIcon icon={ArrowLeft} />
                    Back to pipelines
                </button>
            </div>
        </main>
    );
}
