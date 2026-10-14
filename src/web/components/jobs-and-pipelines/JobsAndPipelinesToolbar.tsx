/**
 * @fileoverview Search, scope, type, tag, run-as, and favorites controls for
 * the jobs page.
 */

import {
    ChevronDown,
    Search,
    Star,
    Tag,
} from 'lucide-react';
import { AppIcon } from '../ui/AppIcon';
import type { JobsAndPipelinesController } from './hooks/useJobsAndPipelinesController';

type JobsAndPipelinesToolbarController = Pick<
    JobsAndPipelinesController,
    | 'favoritesOnly'
    | 'searchQuery'
    | 'setFavoritesOnly'
    | 'setSearchQuery'
    | 'setTagFilter'
    | 'tagFilter'
    | 'tagOptions'
>;

/**
 * Exposes supported local filters for the pipeline registry.
 *
 * Search, tag, and favorite state filter the loaded pipeline definitions.
 * Ownership and run-as controls stay hidden until the registry API supplies
 * those fields.
 */
export function JobsAndPipelinesToolbar({
    controller,
}: Readonly<{ controller: JobsAndPipelinesToolbarController }>) {
    const {
        favoritesOnly,
        searchQuery,
        setFavoritesOnly,
        setSearchQuery,
        setTagFilter,
        tagFilter,
        tagOptions,
    } = controller;

    return (
        <div className="jobs-pipelines-toolbar" role="toolbar">
            <label className="jobs-pipelines-search">
                <AppIcon icon={Search} size="control" />
                <input
                    aria-label="Filter pipelines by name or ID"
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Filter by name or ID..."
                    value={searchQuery}
                />
            </label>

            <button
                aria-pressed={favoritesOnly}
                className={`jobs-pipelines-filter-button ${favoritesOnly ? 'active' : ''}`}
                onClick={() => setFavoritesOnly((current) => !current)}
                type="button"
            >
                <AppIcon icon={Star} size="status" />
                Favorites
            </button>

            <label className="jobs-pipelines-select-wrapper">
                <AppIcon icon={Tag} size="status" />
                <select
                    aria-label="Filter by tags"
                    className="jobs-pipelines-filter-select"
                    onChange={(event) => setTagFilter(event.target.value)}
                    value={tagFilter}
                >
                    <option value="all">Tags</option>
                    {tagOptions.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
                </select>
                <AppIcon icon={ChevronDown} size="status" />
            </label>

            <div className="jobs-pipelines-toolbar-spacer" />
            <button
                className="jobs-pipelines-create-button"
                title="Create is not implemented for read-only mounted pipeline definitions."
                type="button"
            >
                Create
                <AppIcon icon={ChevronDown} size="status" />
            </button>
        </div>
    );
}
