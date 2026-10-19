#!/usr/bin/env node
/**
 * Entry point.
 *
 * Deliberately thin, but no longer trivial: v0_02 has three modes, and the
 * decision between them happens before any runtime is built.
 *
 *   standalone  one process owns the device and the prompt
 *   daemon      one process owns the device; many terminals send commands
 *   attach      this process is only a client
 *
 * The ordering below is intentional:
 *
 *   1. parse and validate flags (cheap, can fail without side effects)
 *   2. handle `--stop-daemon` (does not need a runtime)
 *   3. look for a running daemon (shapes the menu)
 *   4. choose a mode (may prompt)
 *   5. build the runtime, then hand it to the right front end
 *
 * Building the runtime is never done before the mode is known, because daemon
 * mode and standalone mode differ in who is allowed to own the device — and on a
 * real machine that ownership is exactly one process.
 */

import { join } from 'node:path';

import { createApp, readVersion, type App } from './app.js';
import { CliError, parseCliArgs, renderCliHelp } from './cli/config.js';
import { ModeChoiceError, chooseMode } from './cli/mode.js';
import { DaemonClient } from './daemon/client.js';
import { ensureStateDir, findDaemon } from './daemon/discovery.js';
import { resolveEndpoint, resolveStateDir } from './daemon/endpoint.js';
import { spawnDetachedDaemon, stopDaemon } from './daemon/lifecycle.js';
import { acquireDaemonLock, type DaemonLock } from './daemon/lock.js';
import { DaemonServer } from './daemon/server.js';
import { describe as describeEndpoint } from './daemon/transport.js';
import { isInteractive } from './terminal/banner.js';
import { LocalSession } from './terminal/local-session.js';
import { RemoteSession } from './terminal/remote-session.js';

async function main(argv: readonly string[]): Promise<number> {
  let config;
  try {
    config = parseCliArgs(argv);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  if (config.help) {
    process.stdout.write(renderCliHelp());
    return 0;
  }

  const version = readVersion();
  const stateDir = resolveStateDir(config.stateDir);

  if (config.stopDaemon) {
    const stopped = await stopDaemon(stateDir);
    if (stopped) {
      process.stdout.write('Daemon stopped.\n');
      return 0;
    }
    process.stderr.write(`No running daemon found in ${stateDir}.\n`);
    return 1;
  }

  const daemon = await findDaemon(stateDir);
  let mode;
  try {
    mode = await chooseMode({
      config,
      daemon,
      interactive: isInteractive() || config.ask,
    });
  } catch (error) {
    if (error instanceof ModeChoiceError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }

  switch (mode) {
    case 'standalone':
      return runStandalone(config, version);
    case 'daemon':
      return config.detach
        ? runDetached(config, stateDir, version)
        : runDaemon(config, stateDir, version);
    case 'attach':
      return runAttach(config, stateDir, version);
  }
}

/** A prompt and a runtime in this process. */
async function runStandalone(
  config: ReturnType<typeof parseCliArgs>,
  version: string,
): Promise<number> {
  const app = await createApp({ config, version });
  const session = new LocalSession({
    agent: app.agent,
    broker: app.broker,
    subroutines: app.subroutines,
    bus: app.bus,
    log: app.log,
    shutdown: app.shutdown,
    version,
    live: app.live,
    logLevel: config.logLevel,
    ...(config.noWait ? { noWait: true } : {}),
  });

  const onInterrupt = (): void => session.interrupt();
  process.on('SIGINT', onInterrupt);

  try {
    return config.exec.length > 0
      ? await session.runOnce(config.exec)
      : await session.runInteractive();
  } finally {
    process.off('SIGINT', onInterrupt);
    await app.shutdown().catch(() => undefined);
  }
}

/** A foreground service. Stops on Ctrl+C or a client's `shutdown`. */
async function runDaemon(
  config: ReturnType<typeof parseCliArgs>,
  stateDir: string,
  version: string,
): Promise<number> {
  await ensureStateDir(stateDir);

  // Claim the state directory *before* building the runtime. Starting the agent
  // opens the input device; discovering "another daemon is running" only after
  // that would be both wasteful and alarming in live mode.
  let lock: DaemonLock;
  try {
    const existing = await findDaemon(stateDir);
    if (existing !== null && existing.reachable) {
      throw new Error(
        `A daemon is already running for this state directory ` +
          `(pid ${existing.record.pid}). Attach with --mode attach, ` +
          'or stop it with --stop-daemon.',
      );
    }
    lock = await acquireDaemonLock(stateDir);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  // `daemonStatus` is a closure over `server`, which is assigned a moment later.
  // That indirection is what keeps the command layer unaware of the daemon.
  let server: DaemonServer | undefined;
  let app: App;
  try {
    app = await createApp({
      config,
      version,
      daemonStatus: () => server?.summary(),
      ...(config.logFile !== undefined ? { logFile: config.logFile } : {}),
    });
  } catch (error) {
    await lock.release();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const endpoint = resolveEndpoint({
    stateDir,
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.port !== undefined ? { port: config.port } : {}),
  });

  server = new DaemonServer({
    broker: app.broker,
    bus: app.bus,
    endpoint,
    stateDir,
    version,
    live: app.live,
    host: app.agent.hostInfo(),
    log: app.log,
    lock,
    shutdown: app.shutdown,
  });

  const onSigint = (): void => {
    void server?.stop('received SIGINT');
  };
  const onSigterm = (): void => {
    void server?.stop('received SIGTERM');
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    const info = await server.start();
    process.stdout.write(`js-agent ${version} · target 0.02 · daemon · pid ${info.pid}\n`);
    process.stdout.write(`  endpoint  ${info.endpoint} (${info.endpointKind})\n`);
    process.stdout.write(`  driver    ${info.host.driver} (${info.live ? 'LIVE' : 'dry run'})\n`);
    process.stdout.write('  waiting for clients; Ctrl+C to stop\n');
    await server.whenStopped;
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await app.shutdown().catch(() => undefined);
  }
}

/** Start a daemon in the background, wait until it answers, then return. */
async function runDetached(
  config: ReturnType<typeof parseCliArgs>,
  stateDir: string,
  version: string,
): Promise<number> {
  await ensureStateDir(stateDir);
  const logFile = config.logFile ?? join(stateDir, 'daemon.log');
  const entry = process.argv[1];
  if (entry === undefined) {
    process.stderr.write('Cannot determine the program entry point.\n');
    return 1;
  }

  try {
    const record = await spawnDetachedDaemon({
      stateDir,
      args: buildDaemonArgs(config, stateDir, logFile),
      entry,
    });
    process.stdout.write(`js-agent ${version} · daemon started in the background\n`);
    process.stdout.write(`  pid       ${record.pid}\n`);
    process.stdout.write(`  endpoint  ${describeEndpoint(record.endpoint)}\n`);
    process.stdout.write(`  log       ${logFile}\n`);
    process.stdout.write(`  attach    --mode attach --state-dir "${stateDir}"\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * Reconstruct the flags for the detached child.
 *
 * Explicit rather than forwarding `process.argv`: the parent may have had
 * `--detach` or `--exec`, both of which are meaningless (or harmful) in the
 * child.
 */
function buildDaemonArgs(
  config: ReturnType<typeof parseCliArgs>,
  stateDir: string,
  logFile: string,
): string[] {
  const args = [
    '--mode',
    'daemon',
    '--state-dir',
    stateDir,
    '--log-file',
    logFile,
    '--log-level',
    config.logLevel,
    config.live ? '--live' : '--dry-run',
  ];
  if (config.port !== undefined) args.push('--port', String(config.port));
  if (config.endpoint !== undefined) args.push('--endpoint', config.endpoint);
  return args;
}

/** A client attached to an existing daemon. */
async function runAttach(
  config: ReturnType<typeof parseCliArgs>,
  stateDir: string,
  version: string,
): Promise<number> {
  if (config.live) {
    process.stderr.write('Note: --live is ignored in attach mode; the daemon owns the device.\n');
  }

  const explicitEndpoint = config.endpoint !== undefined || config.port !== undefined
    ? resolveEndpoint({
        stateDir,
        ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
        ...(config.port !== undefined ? { port: config.port } : {}),
      })
    : undefined;

  let client: DaemonClient;
  try {
    client = await DaemonClient.connect({
      stateDir,
      clientName: `attach:${process.pid}`,
      ...(explicitEndpoint !== undefined ? { endpoint: explicitEndpoint } : {}),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write('Start one first: npm start -- --mode daemon --detach\n');
    return 1;
  }

  const session = new RemoteSession({
    client,
    info: client.info,
    version,
    ...(config.noWait ? { noWait: true } : {}),
  });
  const onInterrupt = (): void => session.interrupt();
  process.on('SIGINT', onInterrupt);

  try {
    return config.exec.length > 0
      ? await session.runOnce(config.exec)
      : await session.runInteractive();
  } finally {
    process.off('SIGINT', onInterrupt);
    client.close();
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`js-agent failed: ${message}\n`);
    process.exitCode = 1;
  });
