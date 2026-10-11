#!/usr/bin/env node
/**
 * Development smoke runner.
 *
 * Drives the program through `--exec` with a list of commands, then prints the
 * merged output. It exists so that verifying behaviour does not depend on a
 * shell's argument-quoting rules — the commands are passed to the child as a
 * real argv array, exactly as the terminal would receive them.
 *
 * Usage:
 *   node scripts/smoke.mjs "help" "status"
 *   node scripts/smoke.mjs "demo test-text 3000" "list" "stop"
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const commands = process.argv.slice(2);
if (commands.length === 0) {
  console.error('usage: node scripts/smoke.mjs "<command>" ["<command>" ...]');
  process.exit(2);
}

const argv = [tsx, join(root, 'src', 'index.ts')];
for (const command of commands) argv.push('--exec', command);

// Both child streams go to *this* process's stdout, so their relative order is
// preserved instead of being split by the caller's own stream handling. That
// matters when reasoning about which log line preceded which command.
const child = spawn(process.execPath, argv, {
  cwd: root,
  stdio: ['ignore', 'inherit', 1],
});

child.on('close', (code) => {
  console.log(`=== exit code: ${code} ===`);
});
