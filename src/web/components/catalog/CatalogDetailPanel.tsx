/**
 * @fileoverview Two-column catalog detail composition combining asset content
 * and metadata.
 */

import { CatalogAssetAbout } from './CatalogAssetAbout';
import { CatalogAssetDetail } from './CatalogAssetDetail';
import type {
    SparkSampleData,
    SparkTableDetail,
} from '../../../shared/catalogTypes.ts';
import type { CatalogLoadState } from '../../types/catalogTypes';
import type { CatalogTableTab } from '../../utils/catalogNavigation.ts';

/**
 * Composes the selected catalog asset's detail view and metadata sidebar.
 *
 * The detail pane owns column/sample filtering and retry presentation through
 * the callbacks supplied by the controller, while the sidebar remains a
 * read-only description of the same selected asset. Keeping those concerns
 * separate lets sample failures leave identity and schema metadata usable.
 */
export function CatalogDetailPanel({
    activeTab,
    columnQuery,
    detail,
    onRetrySample,
    sampleData,
    sampleQuery,
    sampleState,
    setColumnQuery,
    setSampleQuery,
}: Readonly<{
    activeTab: CatalogTableTab;
    columnQuery: string;
    detail: SparkTableDetail;
    onRetrySample: () => void;
    sampleData?: SparkSampleData;
    sampleQuery: string;
    sampleState?: CatalogLoadState;
    setColumnQuery: (value: string) => void;
    setSampleQuery: (value: string) => void;
}>) {
    return (
        <div className="catalog-detail-grid">
            <CatalogAssetDetail
                activeTab={activeTab}
                columnQuery={columnQuery}
                detail={detail}
                onRetrySample={onRetrySample}
                sampleData={sampleData}
                sampleQuery={sampleQuery}
                sampleState={sampleState}
                setColumnQuery={setColumnQuery}
                setSampleQuery={setSampleQuery}
            />
            <CatalogAssetAbout detail={detail} />
        </div>
    );
}
