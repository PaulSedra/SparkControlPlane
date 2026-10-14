/**
 * @fileoverview Page heading and tablist for jobs, pipelines, and run history.
 */

import type {
    JobsAndPipelinesTab,
} from './hooks/useJobsAndPipelinesController';

/**
 * Provides the two local views for the jobs page and reports tab selection to
 * the controller. The tab buttons do not reload data themselves, allowing the
 * same loaded registry and action state to be reused across both views.
 */
export function JobsAndPipelinesHeader({
    activeTab,
    onSelectTab,
}: Readonly<{
    activeTab: JobsAndPipelinesTab;
    onSelectTab: (tab: JobsAndPipelinesTab) => void;
}>) {
    return (
        <>
            <header className="jobs-pipelines-header">
                <h1>Jobs &amp; Pipelines</h1>
            </header>
            <nav aria-label="Jobs and pipelines views" className="jobs-pipelines-tabs" role="tablist">
                <button
                    aria-selected={activeTab === 'jobs-pipelines'}
                    className={activeTab === 'jobs-pipelines' ? 'active' : undefined}
                    onClick={() => onSelectTab('jobs-pipelines')}
                    role="tab"
                    type="button"
                >
                    Jobs &amp; pipelines
                </button>
                <button
                    aria-selected={activeTab === 'job-runs'}
                    className={activeTab === 'job-runs' ? 'active' : undefined}
                    onClick={() => onSelectTab('job-runs')}
                    role="tab"
                    type="button"
                >
                    Job runs
                </button>
            </nav>
        </>
    );
}
