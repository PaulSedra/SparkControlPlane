/**
 * @fileoverview Audits production dependencies and fails on high or critical
 * npm-reported vulnerabilities.
 */

import { spawnSync } from 'node:child_process';

function main() {

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(
    npmCommand,
    ['audit', '--omit=dev', '--audit-level=high', '--json'],
    {
        encoding: 'utf8',
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    },
);

if (result.error != null) {
    throw new Error(`Production dependency audit could not start: ${result.error.message}`);
}

let report;
try {
    report = JSON.parse(result.stdout || '{}');
} catch {
    throw new Error('Production dependency audit returned invalid JSON.');
}

const vulnerabilities = report.metadata?.vulnerabilities ?? {};
const high = Number(vulnerabilities.high ?? 0);
const critical = Number(vulnerabilities.critical ?? 0);
const total = Number(vulnerabilities.total ?? high + critical);
if (result.status !== 0 || high > 0 || critical > 0) {
    throw new Error(
        `Production dependency audit failed: ${critical} critical, ${high} high, ${total} total vulnerabilities.`,
    );
}

console.log(`Production dependency audit passed: ${total} vulnerabilities.`);

}

main();
