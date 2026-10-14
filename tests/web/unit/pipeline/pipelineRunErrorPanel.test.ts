/**
 * @fileoverview User-visible diagnostics coverage for the selected pipeline run.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInThisContext } from 'node:vm';
import * as react from 'react';
import type { ComponentType } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PipelineRun } from '../../../../src/shared/pipelineRegistryTypes.ts';
import {
    pipelineRunFailureMessage,
    pipelineRunFailureTitle,
    RunStatus,
} from '../../../../src/shared/status/run.ts';
import ts from 'typescript';

const errorStatuses = [
    RunStatus.FAILED,
    RunStatus.CANCELED,
    RunStatus.TIMED_OUT,
    RunStatus.UNKNOWN,
] as const;

test('error panel keeps diagnostic text without rendering a status symbol', () => {
    const PipelineRunErrorPanel = loadPipelineRunErrorPanel();

    for (const status of errorStatuses) {
        const run = {
            runId: `run-${status}`,
            status,
            stderr: 'WARNING: Using included pipeline code.',
        } as PipelineRun;
        const markup = renderToStaticMarkup(
            react.createElement(PipelineRunErrorPanel, { run }),
        );

        assert.equal(markup.includes('data-status-symbol'), false, status);
        assert.ok(markup.includes(pipelineRunFailureTitle(status)), status);
        assert.ok(markup.includes('WARNING: Using included pipeline code.'), status);
    }
});

function loadPipelineRunErrorPanel(): ComponentType<{ run?: PipelineRun }> {
    const source = readFileSync(new URL(
        '../../../../src/web/components/pipeline/graph/PipelineRunErrorPanel.tsx', import.meta.url,
    ), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    });
    const dependencies: Record<string, unknown> = {
        'lucide-react': { ChevronDown: () => null },
        react,
        'react/jsx-runtime': jsxRuntime,
        '../../../../shared/status/run.ts': {
            pipelineRunFailureMessage,
            pipelineRunFailureTitle,
            RunStatus,
        },
        '../../ui/AppIcon': { AppIcon: () => null },
    };
    const componentExports: {
        PipelineRunErrorPanel?: ComponentType<{ run?: PipelineRun }>;
    } = {};
    const loadComponent = runInThisContext(
        `(function(require, exports) {${compiled.outputText}\n})`,
    );
    loadComponent((id: string) => {
        assert.ok(id in dependencies, `Unexpected component dependency: ${id}`);
        return dependencies[id];
    }, componentExports);
    assert.ok(componentExports.PipelineRunErrorPanel);
    return componentExports.PipelineRunErrorPanel;
}
