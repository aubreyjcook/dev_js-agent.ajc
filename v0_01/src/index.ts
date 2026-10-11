#!/usr/bin/env node
/**
 * Entry point.
 *
 * Deliberately thin: parse the arguments, build the app, hand it to the
 * terminal, and translate the result into an exit code. All the interesting
 * wiring lives in `app.ts`; all the interesting behaviour lives behind the agent
 * and subroutine barrels.
 */

import { createApp, readVersion } from './app.js';
import { CliError, parseCliArgs, renderCliHelp } from './cli/config.js';

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

  const app = await createApp({ config, version: readVersion() });

  // SIGINT is handled by the session so that `stop` and a graceful shutdown run
  // instead of the process dying with input still in flight.
  const onInterrupt = (): void => app.session.interrupt();
  process.on('SIGINT', onInterrupt);

  try {
    return config.exec.length > 0
      ? await app.session.runOnce(config.exec)
      : await app.session.runInteractive();
  } finally {
    process.off('SIGINT', onInterrupt);
    await app.shutdown().catch(() => undefined);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`js-agent failed to start: ${message}\n`);
    process.exitCode = 1;
  });
