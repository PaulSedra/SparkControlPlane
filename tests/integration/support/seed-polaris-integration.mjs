/**
 * @fileoverview Seeds one disposable Polaris catalog and namespace through the
 * public management and Iceberg REST APIs.
 */

const baseUrl = required('POLARIS_BASE_URL').replace(/\/$/, '');
const clientId = required('POLARIS_CLIENT_ID');
const clientSecret = required('POLARIS_CLIENT_SECRET');
const realm = process.env.POLARIS_REALM?.trim() || 'POLARIS';
const catalog = required('POLARIS_CATALOG_NAME');
const namespace = process.env.POLARIS_NAMESPACE?.trim() || 'integration';
const catalogRole = process.env.POLARIS_CATALOG_ROLE?.trim() || 'integration_catalog_admin';
const location = process.env.POLARIS_CATALOG_LOCATION?.trim() ||
    'file:///tmp/spark-control-plane-integration-warehouse';

const token = await accessToken();
await createCatalog(token);
await createCatalogRole(token);
await grantCatalogContent(token);
await assignCatalogRole(token);
await createNamespace(token);
console.log(`SEEDED_POLARIS catalog=${catalog} namespace=${namespace}`);

async function accessToken() {
    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: 'PRINCIPAL_ROLE:ALL',
    });
    const response = await fetch(`${baseUrl}/api/catalog/v1/oauth/tokens`, {
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        method: 'POST',
    });
    const payload = await readJson(response);
    if (!response.ok || typeof payload?.access_token !== 'string') {
        throw new Error(`Polaris token bootstrap failed with HTTP ${response.status}.`);
    }
    return payload.access_token;
}

async function createCatalog(token) {
    const response = await fetch(`${baseUrl}/api/management/v1/catalogs`, {
        body: JSON.stringify({
            catalog: {
                name: catalog,
                properties: { 'default-base-location': location },
                readOnly: false,
                storageConfigInfo: {
                    allowedLocations: [location],
                    storageType: 'FILE',
                },
                type: 'INTERNAL',
            },
        }),
        headers: managementHeaders(token),
        method: 'POST',
    });
    if (!response.ok && response.status !== 409) {
        throw new Error(`Polaris catalog seed failed with HTTP ${response.status}.`);
    }
}

async function createNamespace(token) {
    const response = await fetch(
        `${baseUrl}/api/catalog/v1/${encodeURIComponent(catalog)}/namespaces`,
        {
            body: JSON.stringify({ namespace: [namespace], properties: {} }),
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Polaris-Realm': realm,
            },
            method: 'POST',
        },
    );
    if (!response.ok && response.status !== 409) {
        throw new Error(`Polaris namespace seed failed with HTTP ${response.status}.`);
    }
}

async function createCatalogRole(token) {
    const response = await fetch(
        `${baseUrl}/api/management/v1/catalogs/${encodeURIComponent(catalog)}/catalog-roles`,
        {
            body: JSON.stringify({ catalogRole: { name: catalogRole, properties: {} } }),
            headers: managementHeaders(token),
            method: 'POST',
        },
    );
    if (!response.ok && response.status !== 409) {
        throw new Error(`Polaris catalog role seed failed with HTTP ${response.status}.`);
    }
}

async function grantCatalogContent(token) {
    const response = await fetch(
        `${baseUrl}/api/management/v1/catalogs/${encodeURIComponent(catalog)}/catalog-roles/${encodeURIComponent(catalogRole)}/grants`,
        {
            body: JSON.stringify({ type: 'catalog', privilege: 'CATALOG_MANAGE_CONTENT' }),
            headers: managementHeaders(token),
            method: 'PUT',
        },
    );
    if (!response.ok && response.status !== 409) {
        throw new Error(`Polaris catalog privilege seed failed with HTTP ${response.status}.`);
    }
}

async function assignCatalogRole(token) {
    const response = await fetch(
        `${baseUrl}/api/management/v1/principal-roles/service_admin/catalog-roles/${encodeURIComponent(catalog)}`,
        {
            body: JSON.stringify({ catalogRole: { name: catalogRole } }),
            headers: managementHeaders(token),
            method: 'PUT',
        },
    );
    if (!response.ok && response.status !== 409) {
        throw new Error(`Polaris principal role seed failed with HTTP ${response.status}.`);
    }
}

function managementHeaders(token) {
    return {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Polaris-Realm': realm,
    };
}

async function readJson(response) {
    try {
        return await response.json();
    } catch {
        return undefined;
    }
}

function required(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is required for Polaris integration seeding.`);
    }
    return value;
}
