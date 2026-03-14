/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'podman';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.containers.internal';

/**
 * Address the credential proxy binds to.
 * macOS: 127.0.0.1 — Podman Desktop routes host.containers.internal to loopback.
 * Linux rootful Podman: bind to the podman0 bridge IP so only containers can reach it.
 * Linux rootless Podman: 0.0.0.0 — containers reach host via slirp4netns/pasta.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Rootful Podman: bind to the podman0 bridge IP (only containers can reach it).
  const ifaces = os.networkInterfaces();
  const podman0 = ifaces['podman0'];
  if (podman0) {
    const ipv4 = podman0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }

  // Rootless Podman with pasta (transparent mode): containers share the host's LAN IP.
  // There is no isolated subnet, so the proxy must bind to 0.0.0.0 to be reachable
  // from containers. Restrict LAN exposure via firewall instead:
  //   sudo firewall-cmd --add-rich-rule='rule family=ipv4 source NOT address=127.0.0.1 port protocol=tcp port=3001 reject' --permanent
  //   sudo firewall-cmd --reload
  // Or set CREDENTIAL_PROXY_HOST in .env to override.
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // Podman auto-injects host.containers.internal into all containers — no --add-host needed.
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  // :ro,z — readonly + SELinux relabeling (required for Podman on enforcing systems)
  return ['-v', `${hostPath}:${containerPath}:ro,z`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Podman is installed (rootless works without daemon)  ║',
    );
    console.error(
      '║  2. Run: podman info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
