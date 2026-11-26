/**
 * @fileoverview Shared status icon vocabulary and accessible rendering for
 * pipeline and Spark lifecycle states.
 */

import {
    CheckCircle2,
    CircleMinus,
    LoaderCircle,
    RefreshCw,
    XCircle,
} from 'lucide-react';
import {
    STATUS_PRESENTATION_LABELS,
    StatusPresentationState,
    type StatusPresentationState as StatusPresentationStateValue,
} from '../../../shared/status/presentation.ts';
import { AppIcon } from './AppIcon';

/** Renders the canonical icon and semantic color for a lifecycle state. */
export function StatusIcon({
    className,
    label,
    status,
}: Readonly<{
    className?: string;
    label?: string;
    status: StatusPresentationStateValue | null | undefined;
}>) {
    if (status == null) {
        return null;
    }

    const accessibleLabel = label ?? STATUS_PRESENTATION_LABELS[status];
    const Icon = statusIcon(status);
    const statusClassName = `status-icon--${status}`;
    const classes = className == null
        ? statusClassName
        : `${className} ${statusClassName}`;

    return (
        <AppIcon
            className={classes}
            icon={Icon}
            label={accessibleLabel}
            size="control"
        />
    );
}

function statusIcon(status: StatusPresentationStateValue) {
    switch (status) {
        case StatusPresentationState.FAILED:
            return XCircle;
        case StatusPresentationState.WAITING:
            return LoaderCircle;
        case StatusPresentationState.RUNNING:
            return RefreshCw;
        case StatusPresentationState.SUCCEEDED:
            return CheckCircle2;
        case StatusPresentationState.CANCELED:
        default:
            return CircleMinus;
    }
}
