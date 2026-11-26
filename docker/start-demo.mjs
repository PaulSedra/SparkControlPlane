import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const dockerLocations = process.platform === 'win32'
    ? ['C:/Program Files/Docker/Docker/resources/bin/docker.exe']
    : ['/usr/bin/docker', '/usr/local/bin/docker', '/opt/homebrew/bin/docker'];
const dockerExecutable = dockerLocations.find((location) => existsSync(location));
if (dockerExecutable == null) {
    throw new Error('Docker CLI was not found in a standard installation directory.');
}

const composeArgs = ['compose', '--file', 'compose.dev.yaml'];
const services = [
    ['control-plane', 'Control Plane'],
    ['spark-master', 'Spark Master'],
];

const startup = spawnSync(
    dockerExecutable,
    [...composeArgs, 'up', '--detach', '--build', '--wait', '--remove-orphans'],
    { stdio: 'inherit' },
);
if (startup.error) throw startup.error;
if (startup.status !== 0) process.exit(startup.status ?? 1);

console.log();
for (const [service, label] of services) {
    const mapping = spawnSync(dockerExecutable, [...composeArgs, 'port', service, '8080'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    if (mapping.error) throw mapping.error;
    if (mapping.status !== 0) process.exit(mapping.status ?? 1);

    console.log(`${label}  http://${mapping.stdout.trim()}`);
}
