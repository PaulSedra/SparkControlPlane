/**
 * @fileoverview Redacts configured secrets from structured values, commands,
 * and public error messages before they cross an observability boundary.
 */

const SENSITIVE_KEY = /(password|passwd|pwd|token|secret|credential|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|auth[_-]?header|cookie|private[_-]?key|environment|^env$)/i;
const INLINE_SECRET = /(["']?(?:password|passwd|pwd|token|secret|credential|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|auth[_-]?header|cookie)["']?\s*[=:]\s*)(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s,;}&]+))/gi;
const PEM_BLOCK = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g;
const SENSITIVE_COMMAND_FLAG = /^--?(?:password|passwd|pwd|token|secret|credential|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|cookie)$/i;

/**
 * Recursively redacts sensitive keys and nested string values before structured
 * data crosses a log or API boundary; arrays and non-sensitive primitives keep
 * their shape and type.
 */
export function sanitizeFields(value: unknown, additionalSecrets: readonly string[] = []): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeFields(item, additionalSecrets));
    }
    if (value != null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            key,
            SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeFields(item, additionalSecrets),
        ]));
    }
    if (typeof value === 'string') {
        return sanitizeText(value, additionalSecrets);
    }
    return value;
}

/**
 * Removes configured secret values, PEM blocks, key/value credentials, and
 * bearer tokens while preserving surrounding diagnostic text.
 */
export function sanitizeText(value: string, additionalSecrets: readonly string[] = []): string {
    let sanitized = value.replace(PEM_BLOCK, '[REDACTED_PEM]');
    const secrets = [...new Set([...configuredSecrets(), ...additionalSecrets])]
        .filter((secret) => secret.length > 0)
        .sort((left, right) => right.length - left.length);
    for (const secret of secrets) {
        sanitized = sanitized.split(secret).join('[REDACTED]');
    }
    return sanitized
        .replace(INLINE_SECRET, (_match, prefix: string, doubleQuoted?: string, singleQuoted?: string) => {
            if (doubleQuoted !== undefined) {
                return `${prefix}"[REDACTED]"`;
            }
            if (singleQuoted !== undefined) {
                return `${prefix}'[REDACTED]'`;
            }
            return `${prefix}[REDACTED]`;
        })
        .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
}

/**
 * Redacts each command argument while preserving vector order and length.
 *
 * This is used in diagnostics where argument position helps explain a failed
 * subprocess, but raw tokens/credentials must not cross the log or API
 * boundary. It does not mutate the caller's array.
 */
export function sanitizeCommand(
    command: string[],
    additionalSecrets: readonly string[] = [],
): string[] {
    const sanitized: string[] = [];
    for (let index = 0; index < command.length; index += 1) {
        const argument = command[index];
        sanitized.push(sanitizeText(argument, additionalSecrets));
        if (SENSITIVE_COMMAND_FLAG.test(argument) && command[index + 1] != null) {
            sanitized.push('[REDACTED]');
            index += 1;
        }
    }
    return sanitized;
}

/**
 * Extracts an error message and applies the same secret redaction used for
 * logs, preventing raw configuration values from appearing in API responses.
 */
export function publicErrorMessage(error: unknown, additionalSecrets: readonly string[] = []): string {
    const message = error instanceof Error ? error.message : 'Pipeline API request failed.';
    return sanitizeText(message, additionalSecrets);
}

function configuredSecrets(): string[] {
    return [
        process.env.AISTOR_WEBHOOK_TOKEN,
        process.env.POSTGRES_PASSWORD,
        process.env.POSTGRES_SSLROOTCERT,
        process.env.POSTGRES_SSLCERT,
        process.env.POSTGRES_SSLKEY,
    ].filter((value): value is string => value != null && value.length >= 4);
}
