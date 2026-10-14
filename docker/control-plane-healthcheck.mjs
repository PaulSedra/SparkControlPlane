/**
 * @fileoverview Docker healthcheck for the standalone control-plane server.
 */

const port = Number.parseInt(process.env.CONTROL_PLANE_PORT ?? '8080', 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.exit(1);
}

try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    process.exit(response.ok ? 0 : 1);
} catch {
    process.exit(1);
}
