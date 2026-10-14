/**
 * @fileoverview Shared Lucide table glyph with a small eye marker for views.
 */

import { Eye, Table2 } from 'lucide-react';
import { AppIcon } from './AppIcon';

/** Data object kinds with distinct shared glyphs across catalog and pipeline UI. */
export type DataAssetKind = 'table' | 'view';

/** Renders tables with Table2 and overlays a small Eye for view assets. */
export function DataAssetIcon({
    kind,
    size = 'status',
}: Readonly<{
    kind: DataAssetKind;
    size?: 'control' | 'status';
}>) {
    return (
        <span
            aria-hidden='true'
            className={'data-asset-icon data-asset-icon--' + size}
        >
            <AppIcon
                className='data-asset-icon__table'
                icon={Table2}
                size={size}
            />
            {kind === 'view' && (
                <AppIcon
                    className='data-asset-icon__view'
                    icon={Eye}
                    size='status'
                />
            )}
        </span>
    );
}

