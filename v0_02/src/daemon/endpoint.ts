/**
 * Where the daemon lives: state directory and endpoint.
 *
 * Both are derived rather than configured by default, so that a client started
 * in any terminal finds the same daemon without being told where it is. The
 * state directory is also the natural place for the discovery file and logs.
 *
 * Two things are derived from one root:
 *
 * - **The state directory** (`~/.js-agent` by default). Overridable with
 *   `--state-dir` or `JS_AGENT_STATE_DIR`, which is what makes tests able to run
 *   a private daemon without touching the real one.
 * - **The endpoint**, whose default is a named pipe on Windows and a unix socket
 *   inside the state directory on POSIX. The name includes a short hash of the
 *   state directory, so two daemons started with different state directories
 *   cannot collide — and neither can two test runs.
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Endpoint } from '../contract/index.js';

/** Directory holding the discovery file, sockets and logs. */
export function defaultStateDir(): string {
  const override = process.env['JS_AGENT_STATE_DIR'];
  if (override !== undefined && override.trim() !== '') return resolve(override);
  return join(homedir(), '.js-agent');
}

export function resolveStateDir(explicit?: string): string {
  return explicit !== undefined && explicit.trim() !== ''
    ? resolve(explicit)
    : defaultStateDir();
}

export interface EndpointOptions {
  stateDir: string;
  /** Explicit local path, for advanced use and tests. */
  endpoint?: string;
  /** Loopback TCP port instead of a local socket. `0` asks the OS to choose. */
  port?: number;
}

/**
 * Decide where the daemon should listen.
 *
 * Precedence is explicit path, then explicit port, then the derived default. The
 * hash exists so that a state directory is enough to identify an endpoint —
 * useful for tests and for running more than one daemon per machine.
 */
export function resolveEndpoint(options: EndpointOptions): Endpoint {
  if (options.endpoint !== undefined && options.endpoint.trim() !== '') {
    return { kind: 'local', path: options.endpoint };
  }
  if (options.port !== undefined) {
    return { kind: 'tcp', host: '127.0.0.1', port: options.port };
  }

  const tag = createHash('sha256').update(options.stateDir).digest('hex').slice(0, 10);
  return process.platform === 'win32'
    ? { kind: 'local', path: `\\\\.\\pipe\\js-agent-${tag}` }
    : { kind: 'local', path: join(options.stateDir, 'daemon.sock') };
}
