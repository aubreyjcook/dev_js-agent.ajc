#!/usr/bin/env node
/**
 * Behaviour checks for v0_02.
 *
 * The structure mirrors the program:
 *
 *   - **standalone cases** drive `--mode standalone --exec`, exactly as v0_01's
 *     suite did. They are the regression net for the agent and subroutines.
 *   - **daemon cases** start one real daemon on a private state directory and
 *     then talk to it from *separate client processes*. That separation is the
 *     point: a test that reused one process could not prove that state is shared
 *     across terminals.
 *   - **detached cases** exercise the background lifecycle end to end.
 *
 * Transport note: the suite uses `--port 0` (loopback TCP) rather than the
 * default named pipe / unix socket. Every daemon publishes its actual endpoint
 * in `daemon.json`, so clients find it the same way they do in production; only
 * the transport differs, and pipes are blocked in some sandboxed environments.
 *
 * Usage:
 *   node scripts/check.mjs              run everything
 *   node scripts/check.mjs daemon       run cases whose name matches
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = join(root, 'src', 'index.ts');
const nodePath = process.execPath;

const results = [];
const filter = process.argv[2];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Run the program with an explicit argv array; never involve a shell. */
function run(args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(nodePath, [tsx, entry, ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ output, code: 'timeout' });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ output, code });
    });
  });
}

/** Run with an interactive stdin (piped, therefore not a TTY). */
function runInteractive(args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(nodePath, [tsx, entry, ...args], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ output, code: 'timeout' });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ output, code });
    });

    child.stdin.end();
  });
}

/**
 * Feed a real answer to the mode menu.
 *
 * This is how the "the user decides when it first runs" requirement is tested:
 * stdin is piped, the chooser asks a question, and the answer arrives.
 */
function runWithInput(args, input, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(nodePath, [tsx, entry, ...args], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ output, code });
    };

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      finish('timeout');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code);
    });

    child.stdin.write(`${input}\n`);
    child.stdin.end();
  });
}

function makeStateDir(label) {
  return mkdtempSync(join(tmpdir(), `js-agent-${label}-`));
}

function readRecord(stateDir) {
  const path = join(stateDir, 'daemon.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probePort(port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

/** Start a daemon in the foreground of a child process, on a private state dir. */
async function startDaemon(label) {
  const stateDir = makeStateDir(label);
  const args = ['--mode', 'daemon', '--port', '0', '--state-dir', stateDir, '--log-level', 'debug'];
  const child = spawn(nodePath, [tsx, entry, ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const record = readRecord(stateDir);
    if (record !== null && record.endpoint?.kind === 'tcp') {
      if (await probePort(record.endpoint.port)) {
        return { stateDir, child, output: () => output };
      }
    }
    await delay(100);
  }

  child.kill();
  throw new Error(`daemon did not become ready.\n${output}`);
}

async function stopDaemonProcess(daemon) {
  await run(['--stop-daemon', '--state-dir', daemon.stateDir], 20_000);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (daemon.child.exitCode !== null) return;
    await delay(100);
  }
  daemon.child.kill();
  await delay(200);
}

/** Attach-client helper: every command is passed as its own `--exec`. */
function attachArgs(stateDir, commands, { noWait = false } = {}) {
  const args = ['--mode', 'attach', '--state-dir', stateDir];
  for (const command of commands) args.push('--exec', command);
  if (noWait) args.push('--no-wait');
  return args;
}

function runAttach(stateDir, commands, options = {}) {
  return run(attachArgs(stateDir, commands, options), options.timeoutMs ?? 30_000);
}

function record(label, ok, problems, output) {
  results.push({ label, ok, problems, output });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) for (const problem of problems) console.log(`          - ${problem}`);
}

function assess(name, { output, code }, assertions, options = {}) {
  const problems = [];
  if (code === 'timeout') {
    problems.push('timed out');
  } else if (options.expectCode !== undefined) {
    if (code !== options.expectCode) problems.push(`expected exit ${options.expectCode}, got ${code}`);
  } else if (code !== 0) {
    problems.push(`expected exit 0, got ${code}`);
  }
  for (const [label, pattern] of assertions) {
    if (!pattern.test(output)) problems.push(label);
  }
  record(name, problems.length === 0, problems, output);
}

function wanted(name) {
  return filter === undefined || name.includes(filter);
}

// ---------------------------------------------------------------------------
// 1. CLI validation and mode selection
// ---------------------------------------------------------------------------

async function cliCases() {
  const cases = [
    {
      name: 'cli: conflicting modes are rejected',
      argv: ['--mode', 'daemon', '--mode', 'attach'],
      expectCode: 2,
      assertions: [['explains the conflict', /Conflicting modes requested/]],
    },
    {
      name: 'cli: --detach only makes sense with daemon mode',
      argv: ['--mode', 'attach', '--detach'],
      expectCode: 2,
      assertions: [['explains', /only makes sense with daemon mode/]],
    },
    {
      name: 'cli: --port and --endpoint conflict',
      argv: ['--mode', 'daemon', '--port', '0', '--endpoint', 'x'],
      expectCode: 2,
      assertions: [['explains', /either --endpoint or --port/]],
    },
    {
      name: 'cli: --stop-daemon cannot be combined with --exec',
      argv: ['--stop-daemon', '--exec', 'status'],
      expectCode: 2,
      assertions: [['explains', /cannot be combined/]],
    },
    {
      name: 'cli: no mode without a terminal is an error',
      argv: [],
      interactive: true,
      expectCode: 2,
      assertions: [['explains', /No mode chosen/], ['suggests a flag', /--mode standalone/]],
    },
    {
      name: 'cli: help lists the modes and examples',
      argv: ['--help'],
      assertions: [
        ['shows standalone', /standalone/],
        ['shows daemon', /daemon/],
        ['shows attach', /attach/],
        ['shows detach example', /--mode daemon --detach/],
      ],
    },
    {
      name: 'banner: standalone prints the mode and warns about TTY',
      argv: ['--mode', 'standalone'],
      interactive: true,
      expectCode: 2,
      assertions: [
        ['shows the mode', /target 0\.02\s+·\s+standalone mode/],
        ['shows the driver', /input driver\s+recorder \(dry run/],
        ['explains non-TTY', /stdin is not a TTY/],
      ],
    },
  ];

  console.log('\nCLI and mode selection');
  for (const testCase of cases) {
    if (!wanted(testCase.name)) continue;
    const result = testCase.interactive
      ? await runInteractive(testCase.argv)
      : await run(testCase.argv);
    assess(testCase.name, result, testCase.assertions, { expectCode: testCase.expectCode });
  }
}

// ---------------------------------------------------------------------------
// 1b. The mode chooser itself
// ---------------------------------------------------------------------------

async function modeChoiceCases() {
  // Pressing Enter accepts the default, which is standalone.
  const defaultDir = makeStateDir('choose-default');
  assess(
    'chooser: the default answer is standalone',
    await runWithInput(['--ask', '--state-dir', defaultDir], ''),
    [
      ['asks the question', /How should js-agent run\?/],
      ['offers standalone', /1\) standalone/],
      ['offers daemon', /2\) daemon/],
      ['starts standalone', /standalone mode/],
      ['reports the missing TTY', /stdin is not a TTY/],
    ],
    { expectCode: 2 },
  );
  rmSync(defaultDir, { recursive: true, force: true });

  // Answering "2" must actually start a daemon.
  const daemonDir = makeStateDir('choose-daemon');
  const child = spawn(
    nodePath,
    [tsx, entry, '--ask', '--port', '0', '--state-dir', daemonDir],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stdin.write('2\n');
  child.stdin.end();

  let ready = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const record = readRecord(daemonDir);
    if (record?.endpoint?.kind === 'tcp' && (await probePort(record.endpoint.port))) {
      ready = true;
      break;
    }
    await delay(100);
  }

  const problems = [];
  if (!ready) problems.push('the daemon never became reachable');
  if (!/How should js-agent run\?/.test(output)) problems.push('the menu was not shown');
  if (!/daemon/.test(output)) problems.push('the daemon banner was not printed');
  record('chooser: answering "daemon" starts one', problems.length === 0, problems, output);

  await run(['--stop-daemon', '--state-dir', daemonDir], 20_000);
  await delay(300);
  child.kill();
  rmSync(daemonDir, { recursive: true, force: true });

  // Attaching without a daemon should fail with advice, not a stack trace.
  const emptyDir = makeStateDir('attach-none');
  assess(
    'attach: without a daemon reports clearly',
    await run(['--mode', 'attach', '--state-dir', emptyDir, '--exec', 'status']),
    [
      ['says nothing is listening', /No daemon is listening|Timed out connecting/],
      ['suggests starting one', /Start one first|--mode daemon/],
    ],
    { expectCode: 1 },
  );
  rmSync(emptyDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2. Standalone (regression against v0_01's behaviour)
// ---------------------------------------------------------------------------

async function standaloneCases() {
  const cases = [
    {
      name: 'standalone: help lists the control commands',
      argv: ['--mode', 'standalone', '--exec', 'help'],
      assertions: [
        ['shows exit', /exit\s+leave this terminal/],
        ['shows list', /list\s+show what is running/],
        ['shows stop', /stop\s+stop every running/],
        ['shows shutdown', /shutdown\s+stop the program/],
        ['shows subroutines', /Subroutines[\s\S]*type-text/],
      ],
    },
    {
      name: 'standalone: status reports driver and host',
      argv: ['--mode', 'standalone', '--exec', 'status'],
      assertions: [
        ['names the driver', /Input driver recorder \(dry run\)/],
        ['reports state', /State\s+ready/],
        ['has no daemon line', /^(?![\s\S]*Daemon\s+pid)/],
      ],
    },
    {
      name: 'standalone: list is empty on a fresh start',
      argv: ['--mode', 'standalone', '--exec', 'list'],
      assertions: [['nothing running', /Running subroutines: none/]],
    },
    {
      name: 'standalone: sequential runs both complete',
      argv: ['--mode', 'standalone', '--exec', 'press-key a', '--exec', 'press-key b'],
      assertions: [
        ['first completed', /press-key\] completed \(sub-1\)/],
        ['second completed', /press-key\] completed \(sub-3\)/],
      ],
    },
    {
      name: 'standalone: stop cancels a running subroutine',
      argv: ['--mode', 'standalone', '--exec', 'demo test-text 3000', '--exec', 'stop'],
      assertions: [
        ['reports the stop', /Stopped 1 run\(s\): 1 cancelled/],
        ['logs the cancellation', /WARN\s+\[js-agent\/demo\] cancelled/],
      ],
    },
    {
      name: 'standalone: stop interrupts a long typing run',
      argv: [
        '--mode', 'standalone',
        '--exec', 'type-text aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 60',
        '--exec', 'stop',
      ],
      assertions: [['cancelled', /type-text\] cancelled/]],
    },
    {
      name: 'standalone: unknown command fails',
      argv: ['--mode', 'standalone', '--exec', 'total-nonsense'],
      expectCode: 1,
      assertions: [['explains', /Unknown command or subroutine "total-nonsense"/]],
    },
    {
      name: 'standalone: missing argument is explained',
      argv: ['--mode', 'standalone', '--exec', 'press-key'],
      expectCode: 1,
      assertions: [['names the parameter', /"press-key" needs chord/]],
    },
    {
      name: 'standalone: unknown key is explained',
      argv: ['--mode', 'standalone', '--exec', 'press-key crtl+c'],
      expectCode: 1,
      assertions: [['names the key', /Unknown key "crtl"/]],
    },
    {
      name: 'standalone: shifted punctuation needs shift',
      argv: ['--mode', 'standalone', '--exec', 'press-key !'],
      expectCode: 1,
      assertions: [['suggests shift+1', /shift\+1/]],
    },
    {
      name: 'standalone: non-ASCII is refused',
      argv: ['--mode', 'standalone', '--exec', 'type-text café'],
      expectCode: 1,
      assertions: [
        ['explains', /printable ASCII only/],
        ['reports the failure', /1 subroutine run\(s\) failed/],
      ],
    },
    {
      name: 'standalone: extra arguments are refused',
      argv: ['--mode', 'standalone', '--exec', 'move-mouse 1 2 3 4'],
      expectCode: 1,
      assertions: [['counts arguments', /accepts at most 3 argument\(s\)/]],
    },
    {
      name: 'standalone: a bad URL is refused',
      argv: ['--mode', 'standalone', '--exec', 'goto javascript:alert(1)'],
      expectCode: 1,
      assertions: [['refuses', /not a URL I can open/]],
    },
    {
      name: 'standalone: a single letter is a valid key',
      argv: ['--mode', 'standalone', '--exec', 'press-key a'],
      assertions: [['completes', /press-key\] completed/]],
    },
    {
      name: 'standalone: progress detail is reported',
      argv: ['--mode', 'standalone', '--exec', 'type-text aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 150'],
      assertions: [
        ['reports its own detail', /running · typing \d+ chars/],
        ['reports the outcome', /completed · typed \d+ chars/],
      ],
    },
    {
      name: 'standalone: dry run moves the simulated cursor',
      argv: ['--mode', 'standalone', '--exec', 'move-mouse 400 300', '--exec', 'status'],
      assertions: [['reports cursor', /Cursor\s+400,300/]],
    },
    {
      name: 'standalone: help shows a subroutine contract',
      argv: ['--mode', 'standalone', '--exec', 'help demo'],
      assertions: [
        ['shows usage', /usage: demo \[text\] \[wait-ms\]/],
        ['shows defaults', /default "5000"/],
      ],
    },
  ];

  console.log('\nStandalone');
  for (const testCase of cases) {
    if (!wanted(testCase.name)) continue;
    assess(testCase.name, await run(testCase.argv), testCase.assertions, {
      expectCode: testCase.expectCode,
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Daemon: shared state across separate client processes
// ---------------------------------------------------------------------------

async function daemonCases(daemon) {
  const { stateDir } = daemon;

  assess('daemon: status identifies the daemon', await runAttach(stateDir, ['status'], { noWait: true }), [
    ['shows the daemon', /Daemon\s+pid \d+ · tcp 127\.0\.0\.1:\d+/],
    ['shows client count', /Clients\s+\d+/],
    ['shows the driver', /Input driver recorder \(dry run\)/],
  ]);

  assess('daemon: one client can start work', await runAttach(stateDir, ['demo test-text 8000'], { noWait: true }), [
    ['starts the run', /demo: running/],
    ['reports progress', /starting in \d+s/],
  ]);

  assess('daemon: another client sees the running work', await runAttach(stateDir, ['list'], { noWait: true }), [
    ['shows it running', /Running subroutines: 1/],
    ['names the run', /sub-\d+\s+demo\s+running/],
    ['shows its detail', /starting in \d+s/],
  ]);

  assess('daemon: a third client can stop it', await runAttach(stateDir, ['stop']), [
    ['stops it', /Stopped 1 run\(s\): 1 cancelled/],
  ]);

  assess('daemon: state is consistent afterwards', await runAttach(stateDir, ['list'], { noWait: true }), [
    ['nothing running', /Running subroutines: none/],
  ]);

  assess('daemon: exit detaches rather than stopping', await runAttach(stateDir, ['exit']), [
    ['says it detaches', /Detaching from the daemon/],
  ]);

  assess('daemon: survives a client exit', await runAttach(stateDir, ['status'], { noWait: true }), [
    ['still answers', /State\s+ready/],
  ]);

  assess(
    'daemon: a second instance is refused',
    await run(['--mode', 'daemon', '--port', '0', '--state-dir', stateDir], 20_000),
    [['refuses', /A daemon is already running/]],
    { expectCode: 1 },
  );

  assess('daemon: refusal left the original running', await runAttach(stateDir, ['status'], { noWait: true }), [
    ['still answers', /State\s+ready/],
  ]);

  assess('daemon: a bad protocol version is rejected', await protocolMismatchCase(stateDir), [
    ['reports a mismatch', /Protocol mismatch|protocol mismatch/],
  ]);
}

/** Speak the wire protocol directly, badly, and check the daemon says no. */
async function protocolMismatchCase(stateDir) {
  const record = readRecord(stateDir);
  if (record === null) return { output: 'no record', code: 'error' };

  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: record.endpoint.port });
    let output = '';
    let sent = false;

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      output += chunk;
      // The daemon speaks first: read the welcome, then greet it in the wrong
      // dialect on purpose.
      if (!sent && output.includes('"welcome"')) {
        sent = true;
        socket.write(`${JSON.stringify({ kind: 'hello', protocol: 999, clientName: 'bad' })}\n`);
      }
    });
    socket.on('close', () => resolve({ output, code: 0 }));
    socket.on('error', () => resolve({ output, code: 0 }));
    socket.setTimeout(5_000, () => {
      socket.destroy();
      resolve({ output: `${output}\n(timeout)`, code: 'timeout' });
    });
  });
}

// ---------------------------------------------------------------------------
// 4. Detached lifecycle
// ---------------------------------------------------------------------------

async function detachedCases() {
  const stateDir = makeStateDir('detached');

  assess(
    'detached: starts in the background',
    await run(['--mode', 'daemon', '--detach', '--port', '0', '--state-dir', stateDir], 30_000),
    [
      ['reports it started', /daemon started in the background/],
      ['reports a pid', /pid\s+\d+/],
      ['reports the endpoint', /endpoint\s+tcp 127\.0\.0\.1:\d+/],
    ],
  );

  const daemonRecord = readRecord(stateDir);
  assess('detached: clients can drive it', await runAttach(stateDir, ['status'], { noWait: true }), [
    ['answers', /State\s+ready/],
    ['knows its pid', new RegExp(`Daemon\\s+pid ${daemonRecord?.pid ?? '\\d+'}`)],
  ]);

  assess('detached: --stop-daemon stops it', await run(['--stop-daemon', '--state-dir', stateDir], 20_000), [
    ['confirms', /Daemon stopped/],
  ]);

  await delay(500);
  const gone = readRecord(stateDir) === null;
  record(
    'detached: the discovery file is removed',
    gone,
    gone ? [] : ['daemon.json still present'],
    '',
  );

  assess('detached: stopping again reports nothing to stop', await run(['--stop-daemon', '--state-dir', stateDir], 20_000), [
    ['says so', /No running daemon found/],
  ], { expectCode: 1 });

  rmSync(stateDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 5. Orphan recovery
// ---------------------------------------------------------------------------

/**
 * A daemon whose discovery file has been deleted is still running and still
 * owns the device. The lock file is the fallback that keeps it stoppable.
 */
async function orphanCases() {
  const daemon = await startDaemon('orphan');
  try {
    rmSync(join(daemon.stateDir, 'daemon.json'), { force: true });

    assess(
      'orphan: --stop-daemon falls back to the lock file',
      await run(['--stop-daemon', '--state-dir', daemon.stateDir], 20_000),
      [['confirms', /Daemon stopped/]],
    );

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && daemon.child.exitCode === null) {
      await delay(100);
    }
    const exited = daemon.child.exitCode !== null;
    record('orphan: the process actually exited', exited, exited ? [] : ['still running'], '');
  } finally {
    if (daemon.child.exitCode === null) daemon.child.kill();
    rmSync(daemon.stateDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  await cliCases();
  await modeChoiceCases();
  await standaloneCases();

  let daemon;
  if (filter === undefined || filter.includes('daemon')) {
    console.log('\nDaemon (separate client processes)');
    try {
      daemon = await startDaemon('main');
      try {
        await daemonCases(daemon);
      } finally {
        await stopDaemonProcess(daemon);
      }

      const gone = readRecord(daemon.stateDir) === null;
      record(
        'daemon: shutdown removes the discovery file',
        gone,
        gone ? [] : ['daemon.json still present'],
        '',
      );
    } catch (error) {
      console.error(`\nDaemon phase failed to run: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    } finally {
      if (daemon !== undefined) rmSync(daemon.stateDir, { recursive: true, force: true });
    }
  }

  if (filter === undefined || filter.includes('detached')) {
    console.log('\nDetached lifecycle');
    await detachedCases();
  }

  if (filter === undefined || filter.includes('orphan')) {
    console.log('\nOrphan recovery');
    await orphanCases();
  }

  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n${passed}/${results.length} passed`);

  const failures = results.filter((entry) => !entry.ok);
  if (failures.length > 0) {
    console.log('\n--- failing output ---');
    for (const failure of failures) {
      console.log(`\n### ${failure.label}`);
      if (failure.output !== '') console.log(failure.output.trimEnd());
    }
    process.exitCode = 1;
  }
}

await main();
