/**
 * @fileoverview Shared status icon vocabulary and accessible rendering for
 * pipeline and Spark lifecycle states.
 */

import {
    CheckCircle2,
    Clock,
    CircleMinus,
    XCircle,
} from 'lucide-react';
import {
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
    status: StatusPresentationStateValue;
}>) {
    const Icon = status === StatusPresentationState.FAILED
        ? XCircle
        : status === StatusPresentationState.CANCELED
            ? CircleMinus
            : status === StatusPresentationState.RUNNING
                ? Clock
                : status === StatusPresentationState.SUCCEEDED
                    ? CheckCircle2
                    : CircleMinus;
    const statusClassName = `status-icon--${status}`;
    const classes = className == null
        ? statusClassName
        : `${className} ${statusClassName}`;

    return (
        <AppIcon
            className={classes}
            icon={Icon}
            label={label}
            size="control"
        />
    );
}
