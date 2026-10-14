/**
 * @fileoverview Read-only source workspace for the currently selected pipeline
 * asset.
 */

import { Code2, LockKeyhole } from 'lucide-react';
import { AppIcon } from '../ui/AppIcon';
import type { PipelineSourceFile } from '../../../shared/pipelineRegistryTypes.ts';
import type { PipelineAssetNode } from '../../types/pipelineAssetTypes.ts';

/**
 * Presents the selected pipeline asset's source as a read-only workspace.
 *
 * A selected node can render inline SQL immediately while the controller loads
 * its registered source file; a source error is shown without erasing the
 * selected identity. The component never edits or writes source, and falls
 * back to an explicit unavailable message when neither source form exists.
 */
export function PipelineWorkspaceView({
    error,
    loading = false,
    node,
    sourceFile,
}: Readonly<{
    error?: string;
    loading?: boolean;
    node?: PipelineAssetNode;
    sourceFile?: PipelineSourceFile;
}>) {
    if (node == null) {
        return (
            <section aria-label="Workspace" className="pipeline-workspace-view">
                <div className="pipeline-workspace-empty">
                    <AppIcon icon={Code2} size="empty" />
                    <strong>{loading ? 'Loading source' : 'Select a node to view its source'}</strong>
                    <span>{loading ? 'Reading the registered pipeline file…' : 'Source code opens here in read-only mode.'}</span>
                </div>
            </section>
        );
    }

    const inlineContent = node.sqlText?.trim();
    const content = sourceFile?.content ?? inlineContent;
    const displayPath = sourceFile?.path ?? node.sourceFile ?? 'Inline definition';
    const language = sourceFile?.language ?? 'sql';

    return (
        <section aria-label="Workspace" className="pipeline-workspace-view">
            <header className="pipeline-workspace-header">
                <div className="pipeline-workspace-file">
                    <span className="pipeline-workspace-file-icon">
                        <AppIcon icon={Code2} size="control" />
                    </span>
                    <div>
                        <strong title={displayPath}>{displayPath}</strong>
                        <span>
                            {node.typeLabel ?? 'Pipeline asset'}
                            {node.sourceLine == null ? '' : ` · line ${node.sourceLine}`}
                        </span>
                    </div>
                </div>
                <span className="pipeline-workspace-readonly">
                    <AppIcon icon={LockKeyhole} size="status" />
                    Read only
                </span>
            </header>

            <div className="pipeline-workspace-titlebar">
                <strong>{node.label}</strong>
                <span>{languageLabel(language)}</span>
            </div>

            {loading && (
                <output className="pipeline-workspace-message">
                    Loading source code…
                </output>
            )}
            {error != null && (
                <div className="pipeline-workspace-message error" role="alert">
                    {error}
                </div>
            )}
            {!loading && error == null && content == null && (
                <div className="pipeline-workspace-message">
                    Source code is not available for this node.
                </div>
            )}
            {!loading && error == null && content != null && (
                <SourceCodeBlock content={content} sourceLine={node.sourceLine} />
            )}
        </section>
    );
}

function SourceCodeBlock({
    content,
    sourceLine,
}: Readonly<{
    content: string;
    sourceLine?: number;
}>) {
    const lines = content.split(/\r?\n/);

    return (
        <section aria-label="Read-only source code" className="pipeline-source-code">
            {lines.map((line, index) => {
                const lineNumber = index + 1;
                return (
                    <div
                        className={lineNumber === sourceLine ? 'pipeline-source-line active' : 'pipeline-source-line'}
                        key={lineNumber}
                    >
                        <span aria-hidden="true">{lineNumber}</span>
                        <code>{line || ' '}</code>
                    </div>
                );
            })}
        </section>
    );
}

function languageLabel(language: PipelineSourceFile['language']): string {
    return language === 'python' ? 'Python' : language === 'sql' ? 'SQL' : 'Text';
}
