/**
 * Discovery: how a second terminal finds a daemon it did not start.
 *
 * A client cannot be told the port of a daemon whose port was chosen by the OS,
 * and a human should not have to remember a pipe name. So the daemon publishes a
 * small record when it starts and removes it when it stops:
 *
 *   ~/.js-agent/daemon.json
 *
 * The record answers three questions with one file:
 *   1. Where is it?  (`endpoint`)
 *   2. Is it alive?  (`pid`, checked with `process.kill(pid, 0)`)
 *   3. Which protocol does it speak? (`protocol`, in the record *and* the
 *      handshake — belt and braces, because a stale file is a real failure mode)
 *
 * Writes are atomic (write a temp file, then rename) so a client never reads a
 * half-written JSON document.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type Endpoint, PROTOCOL_VERSION } from '../contract/index.js';
import { probeEndpoint } from './transport.js';

export interface DaemonRecord {
  protocol: number;
  pid: number;
  endpoint: Endpoint;
  /** ISO-8601. */
  startedAt: string;
  version: string;
  live: boolean;
}

export function recordPath(stateDir: string): string {
  return join(stateDir, 'daemon.json');
}

export async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
}

export async function writeRecord(stateDir: string, record: DaemonRecord): Promise<void> {
  const target = recordPath(stateDir);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  // Atomic on POSIX and Windows alike: readers see the old file or the new one.
  await rename(temporary, target);
}

export async function readRecord(stateDir: string): Promise<DaemonRecord | null> {
  let raw: string;
  try {
    raw = await readFile(recordPath(stateDir), 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseRecord(parsed);
}

export async function clearRecord(stateDir: string): Promise<void> {
  try {
    await unlink(recordPath(stateDir));
  } catch {
    // Already absent.
  }
}

/**
 * Validate a discovery file.
 *
 * A stale or hand-edited file must be treated as "no daemon", not trusted. Same
 * principle as the wire protocol: the file is external input.
 */
export function parseRecord(value: unknown): DaemonRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  if (typeof record['pid'] !== 'number') return null;
  if (typeof record['protocol'] !== 'number') return null;
  if (typeof record['startedAt'] !== 'string') return null;
  if (typeof record['version'] !== 'string') return null;
  if (typeof record['live'] !== 'boolean') return null;

  const endpoint = record['endpoint'];
  if (typeof endpoint !== 'object' || endpoint === null) return null;
  const candidate = endpoint as Record<string, unknown>;

  let parsedEndpoint: Endpoint;
  if (candidate['kind'] === 'local' && typeof candidate['path'] === 'string') {
    parsedEndpoint = { kind: 'local', path: candidate['path'] };
  } else if (
    candidate['kind'] === 'tcp' &&
    typeof candidate['host'] === 'string' &&
    typeof candidate['port'] === 'number'
  ) {
    parsedEndpoint = {
      kind: 'tcp',
      host: candidate['host'],
      port: candidate['port'],
    };
  } else {
    return null;
  }

  return {
    protocol: record['protocol'],
    pid: record['pid'],
    endpoint: parsedEndpoint,
    startedAt: record['startedAt'],
    version: record['version'],
    live: record['live'],
  };
}

/**
 * Is a process with this id running?
 *
 * `kill(pid, 0)` sends no signal: it only checks permission to do so. `EPERM`
 * means "the process exists but belongs to someone else", which counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface DaemonLookup {
  record: DaemonRecord;
  /** True when the process is alive and the endpoint accepts connections. */
  reachable: boolean;
}

/** Look for a daemon without failing when there is none. */
export async function findDaemon(stateDir: string): Promise<DaemonLookup | null> {
  const record = await readRecord(stateDir);
  if (record === null) return null;
  if (!isProcessAlive(record.pid)) return { record, reachable: false };
  return { record, reachable: await probeEndpoint(record.endpoint) };
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Wait until a daemon is reachable.
 *
 * Used after spawning a detached daemon: the parent has no handle on the child's
 * readiness, so it polls the shared state instead of guessing with a sleep.
 */
export async function waitForDaemon(
  stateDir: string,
  options: WaitOptions = {},
): Promise<DaemonRecord> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = await findDaemon(stateDir);
    if (found !== null && found.reachable) return found.record;
    await delay(intervalMs);
  }

  const last = await readRecord(stateDir);
  const detail = last === null
    ? 'it never published a discovery file'
    : `pid ${last.pid} is ${isProcessAlive(last.pid) ? 'alive but not accepting connections' : 'no longer running'}`;
  throw new Error(`The daemon did not become ready within ${timeoutMs} ms: ${detail}.`);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Guard used before trusting a record's protocol version. */
export function protocolMatches(record: { protocol: number }): boolean {
  return record.protocol === PROTOCOL_VERSION;
}
