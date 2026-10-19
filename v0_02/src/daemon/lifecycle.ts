/**
 * Daemon lifecycle: starting one in the background, and stopping one politely.
 *
 * "Daemon mode" has two flavours, and both matter:
 *
 * - **Foreground** (`--mode daemon`): the process owns a terminal, logs in front
 *   of you, and stops on Ctrl+C. Excellent while developing.
 * - **Detached** (`--mode daemon --detach`): the launcher forks a child, waits
 *   until it is reachable, prints how to reach it, and exits. The service keeps
 *   running after the terminal closes — which is the point of "responsive from
 *   all terminals".
 *
 * Detaching is done with `spawn(..., { detached: true })` plus `unref()`. The
 * parent cannot observe the child's readiness directly (it deliberately has no
 * pipe to it), so readiness is observed the same way any other client observes
 * it: by waiting for the discovery file to describe a reachable daemon.
 */

import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

import { DaemonClient } from './client.js';
import {
  type DaemonRecord,
  clearRecord,
  delay,
  isProcessAlive,
  readRecord,
  waitForDaemon,
} from './discovery.js';
import { clearLock, readLockPid } from './lock.js';

export interface DetachOptions {
  stateDir: string;
  /** Arguments for the child, e.g. `['--mode', 'daemon', '--live']`. */
  args: readonly string[];
  /** Absolute path to the program entry (`process.argv[1]`). */
  entry: string;
  timeoutMs?: number;
}

/**
 * Start a daemon in the background and wait until it is reachable.
 *
 * Throws with a useful message if it never becomes ready — most often because
 * the child died on a bad argument, so the message points at the log.
 */
export async function spawnDetachedDaemon(options: DetachOptions): Promise<DaemonRecord> {
  const { entry, args, stateDir } = options;
  const isTypeScript = entry.endsWith('.ts');

  // Under tsx the entry is a .ts file, which plain Node cannot execute. Node's
  // own loader flag is the least magical way to inherit the same ability.
  const childArgs = isTypeScript ? ['--import', 'tsx', entry, ...args] : [entry, ...args];

  const child = spawn(process.execPath, childArgs, {
    // Resolve `tsx` and relative paths from the program's own directory, not
    // from wherever the user happened to be standing.
    cwd: dirname(dirname(entry)),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, JS_AGENT_STATE_DIR: stateDir },
  });
  child.unref();

  try {
    return await waitForDaemon(stateDir, { timeoutMs: options.timeoutMs ?? 15_000 });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        `Check the daemon log at ${stateDir} for details.`,
    );
  }
}

/**
 * Stop a running daemon.
 *
 * Preferred path is the protocol's own `shutdown` command, because it lets the
 * daemon unwind cleanly: cancel runs, release the device, remove the record.
 * The signal is only a fallback for a daemon that is wedged.
 *
 * The daemon is located by its discovery file *or*, failing that, by its lock.
 * The second source matters: a daemon whose record was deleted is still running
 * and still owns the device, so leaving it unstoppable would be a nasty state.
 *
 * Returns true if a daemon was found (whether or not it had to be signalled).
 */
export async function stopDaemon(stateDir: string, timeoutMs = 8_000): Promise<boolean> {
  const record = await readRecord(stateDir);
  const lockPid = await readLockPid(stateDir);
  const pid = record?.pid ?? lockPid ?? null;

  if (pid === null) return false;

  if (!isProcessAlive(pid)) {
    await clearRecord(stateDir);
    await clearLock(stateDir);
    return false;
  }

  if (record !== null) {
    try {
      const client = await DaemonClient.connect({
        stateDir,
        endpoint: record.endpoint,
        timeoutMs: 3_000,
      });
      await client.run('shutdown');
      client.close();
    } catch {
      // Could not talk to it; ask the OS instead.
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  } else {
    // No record means no endpoint to connect to, so the signal is the only
    // option. The lock identifies the process.
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await delay(100);
  }

  await clearRecord(stateDir);
  await clearLock(stateDir);
  return true;
}
