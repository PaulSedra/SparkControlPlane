/**
 * @fileoverview In-process context supplied by the managed integration test
 * runner without adding test-only values to the child environment.
 */

let managedContext;

/**
 * Installs the immutable context for one managed test process.
 */
export function setManagedTestContext(value) {
    if (managedContext != null) {
        throw new Error('Managed integration test context was already installed.');
    }
    if (value == null || typeof value !== 'object') {
        throw new Error('Managed integration test context must be an object.');
    }
    managedContext = Object.freeze({ ...value });
}

/**
 * Returns the managed context when a test was launched by the Docker-backed
 * runner, or undefined for a direct low-level test invocation.
 */
export function getManagedTestContext() {
    return managedContext;
}

/**
 * Requires a managed context for a test that cannot run meaningfully alone.
 */
export function requireManagedTestContext(description = 'this managed test') {
    if (managedContext == null) {
        throw new Error(`${description} must be launched by the managed integration runner.`);
    }
    return managedContext;
}
