/**
 * The single-instance lock.
 *
 * This exists because of a bug found while testing v0_02. Starting a second
 * daemon with the same state directory but `--port 0` **succeeded**: the OS gave
 * it a different free port, so there was no bind conflict. It then overwrote
 * `daemon.json`, orphaning the first daemon and pointing every future client at
 * the newcomer.
 *
 * The lesson is larger than the fix: **"only one may run" is a property of the
 * state, not of the socket.** TCP cannot express it when the port is chosen by
 * the OS, and neither can a pipe name that is already in use by a daemon that is
 * about to exit. So the claim is made explicitly, with an exclusive file create
 * (`wx`), which is atomic on every platform we care about.
 *
 * Staleness is handled by liveness, not by age: if the recorded pid is gone, the
 * lock is debris and is replaced. A pid that has been recycled by an unrelated
 * process is the known false-positive; the cost is a refusal with a clear
 * message, which is the safe way to be wrong.
 */

import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureStateDir, isProcessAlive } from './discovery.js';

export interface DaemonLock {
  readonly path: string;
  release(): Promise<void>;
}

interface LockContents {
  pid: number;
  startedAt: string;
}

export function lockPath(stateDir: string): string {
  return join(stateDir, 'daemon.lock');
}

/**
 * Claim the state directory for this process.
 *
 * Throws a user-facing error when another live daemon holds it.
 */
export async function acquireDaemonLock(stateDir: string): Promise<DaemonLock> {
  await ensureStateDir(stateDir);
  const path = lockPath(stateDir);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx');
      const contents: LockContents = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
      try {
        await handle.writeFile(`${JSON.stringify(contents)}\n`, 'utf8');
      } finally {
        await handle.close();
      }
      return {
        path,
        release: async (): Promise<void> => {
          try {
            await unlink(path);
          } catch {
            // Already gone.
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      const existing = await readLock(path);
      if (existing !== null && isProcessAlive(existing.pid)) {
        throw new Error(
          `A daemon is already running for this state directory ` +
            `(pid ${existing.pid}, since ${existing.startedAt}). ` +
            'Attach with --mode attach, or stop it with --stop-daemon.',
        );
      }

      // The holder is gone: the lock is debris.
      try {
        await unlink(path);
      } catch {
        // Someone else cleaned it; the next attempt will tell.
      }
    }
  }

  throw new Error(
    `Could not acquire the daemon lock at ${path}. Another process may be starting.`,
  );
}

async function readLock(path: string): Promise<LockContents | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record['pid'] !== 'number' || typeof record['startedAt'] !== 'string') {
      return null;
    }
    return { pid: record['pid'], startedAt: record['startedAt'] };
  } catch {
    return null;
  }
}

/**
 * The pid from the lock file, if any.
 *
 * Used by `--stop-daemon` as a fallback when `daemon.json` is missing. That
 * happens in practice: the record is cleaned up (or deleted by hand), the daemon
 * is still running, and without this the service becomes unaddressable *and*
 * unstoppable. The lock is the second, more durable source of truth.
 */
export async function readLockPid(stateDir: string): Promise<number | null> {
  const contents = await readLock(lockPath(stateDir));
  return contents?.pid ?? null;
}

/** Remove the lock without checking ownership. Used by forced-stop paths. */
export async function clearLock(stateDir: string): Promise<void> {
  try {
    await unlink(lockPath(stateDir));
  } catch {
    // Already gone.
  }
}
