/**
 * @fileoverview User-visible rendering coverage for shared lifecycle icons.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInThisContext } from 'node:vm';
import * as react from 'react';
import type { ComponentType, SVGProps } from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatusPresentationState } from '../../../../src/shared/status/presentation.ts';
import type { StatusPresentationState as StatusPresentationStateValue } from '../../../../src/shared/status/presentation.ts';
import ts from 'typescript';

const StatusIcon = loadStatusIcon();

test('running status renders a labeled refresh icon with the running state class', () => {
    const markup = renderToStaticMarkup(react.createElement(StatusIcon, {
        label: 'Pipeline run in progress',
        status: StatusPresentationState.RUNNING,
    }));

    assert.match(markup, /data-icon="RefreshCw"/);
    assert.match(markup, /class="app-icon status-icon--running"/);
    assert.match(markup, /aria-label="Pipeline run in progress"/);
});

test('waiting status keeps its loader icon and waiting state class', () => {
    const markup = renderToStaticMarkup(react.createElement(StatusIcon, {
        status: StatusPresentationState.WAITING,
    }));

    assert.match(markup, /data-icon="LoaderCircle"/);
    assert.match(markup, /class="app-icon status-icon--waiting"/);
    assert.match(markup, /aria-label="Waiting for resources\.\.\."/);
});

test('missing status renders no icon', () => {
    const markup = renderToStaticMarkup(react.createElement(StatusIcon, {
        status: undefined,
    }));

    assert.equal(markup, '');
});

function loadStatusIcon(): ComponentType<{
    className?: string;
    label?: string;
    status: StatusPresentationStateValue | null | undefined;
}> {
    const source = readFileSync(new URL(
        '../../../../src/web/components/ui/StatusIcon.tsx', import.meta.url,
    ), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    });
    const dependencies: Record<string, unknown> = {
        'lucide-react': {
            CheckCircle2: mockIcon('CheckCircle2'),
            CircleMinus: mockIcon('CircleMinus'),
            LoaderCircle: mockIcon('LoaderCircle'),
            RefreshCw: mockIcon('RefreshCw'),
            XCircle: mockIcon('XCircle'),
        },
        react,
        'react/jsx-runtime': jsxRuntime,
        '../../../shared/status/presentation.ts': {
            STATUS_PRESENTATION_LABELS: {
                canceled: 'Canceled',
                failed: 'Failed',
                running: 'Running',
                succeeded: 'Completed',
                unknown: 'Unknown',
                waiting: 'Waiting for resources...',
            },
            StatusPresentationState,
        },
        './AppIcon': {
            AppIcon: ({
                className,
                icon: Icon,
                label,
            }: Readonly<{
                className?: string;
                icon: ComponentType<SVGProps<SVGSVGElement>>;
                label?: string;
            }>) => react.createElement(Icon, {
                'aria-label': label,
                className: `app-icon ${className ?? ''}`.trim(),
            }),
        },
    };
    const componentExports: {
        StatusIcon?: ComponentType<{
            className?: string;
            label?: string;
            status: StatusPresentationStateValue | null | undefined;
        }>;
    } = {};
    const loadComponent = runInThisContext(
        `(function(require, exports) {${compiled.outputText}\n})`,
    );
    loadComponent((id: string) => {
        assert.ok(id in dependencies, `Unexpected component dependency: ${id}`);
        return dependencies[id];
    }, componentExports);
    assert.ok(componentExports.StatusIcon);
    return componentExports.StatusIcon;
}

function mockIcon(name: string): ComponentType<SVGProps<SVGSVGElement>> {
    return (props) => react.createElement('svg', { ...props, 'data-icon': name });
}
