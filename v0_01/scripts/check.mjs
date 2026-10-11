#!/usr/bin/env node
/**
 * Behaviour checks.
 *
 * Runs the program once per case (`--exec` in, output out) and asserts on what
 * it printed. Each case is isolated in its own process, so results do not depend
 * on stream interleaving or on ordering between concurrent subroutines.
 *
 * This is a plain script rather than a test framework on purpose: there is no
 * test dependency in this package yet, and a check that needs only Node is one
 * that will still run in a year.
 *
 * Usage:
 *   node scripts/check.mjs          run every case
 *   node scripts/check.mjs cancel   run cases whose name contains "cancel"
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entry = join(root, 'src', 'index.ts');

/** Run the program with the given commands; resolve with merged output. */
function run(commands, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const argv = [tsx, entry];
    for (const command of commands) argv.push('--exec', command);

    const child = spawn(process.execPath, argv, {
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

    // A case that hangs is a failure, not a reason to wait forever.
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

/**
 * Run without any `--exec`, which is the interactive path.
 *
 * With stdin redirected it is not a TTY, so the session should print the banner
 * and then explain how to run non-interactively. `runInteractive` writes the
 * prompt straight to stdout, so this is also a partial check that the
 * TTY-only drawing stays out of the way when there is no TTY.
 */
function runInteractive(timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsx, entry], {
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

    // EOF immediately: no commands to run.
    child.stdin.end();
  });
}

const cases = [];
function check(name, commands, assertions, options = {}) {
  cases.push({ name, commands, assertions, options });
}

/** A case that runs the interactive entry point instead of `--exec`. */
function checkInteractive(name, assertions, options = {}) {
  cases.push({ name, commands: [], assertions, options: { ...options, interactive: true } });
}

// The banner is the first thing a user sees, and it is printed by the
// interactive path, so it gets covered here rather than left to chance.
checkInteractive('interactive banner is printed', [
  ['shows the version', /js-agent \d+\.\d+\.\d+\s+·\s+target 0\.01/],
  ['shows the driver', /input driver\s+recorder \(dry run/],
  ['shows the host', /host\s+\S+ · win32/],
  ['lists every built-in', /commands\s+[\s\S]*?\bhelp\b[\s\S]*?\blist\b[\s\S]*?\bstop\b[\s\S]*?\bexit\b/],
  ['lists the subroutines', /subroutines\s+[\s\S]*?type-text/],
  ['explains usage', /Type `help` for commands/],
  ['explains the non-TTY case', /stdin is not a TTY/],
], { expectCode: 2 });

check('help lists the control commands', ['help'], [  ['shows exit', /exit\s+stop everything/],
  ['shows list', /list\s+show what is running/],
  ['shows stop', /stop\s+stop every running/],
  ['shows subroutines', /Subroutines[\s\S]*type-text/],
  ['shows rest marker', /type-text <text \.\.\.> \[char-delay-ms\]/],
]);

check('status reports driver and host', ['status'], [
  ['names the driver', /Input driver recorder \(dry run\)/],
  ['reports node', /Node\s+24\./],
  ['reports state', /State\s+ready/],
]);

check('list is empty on a fresh start', ['list'], [
  ['nothing running', /Running subroutines: none/],
]);

check('list --all shows finished runs', ['press-key enter', 'stop', 'list --all'], [
  ['lists a finish', /Recently finished: \d/],
  ['shows completed', /completed/],
]);

// `--exec` settles between commands, so sequential work must not trip the
// duplicate-run guard. Ids are not consecutive: each run's driver actions take
// ids from the same counter.
check('sequential runs of one subroutine both complete', ['press-key a', 'press-key b'], [
  ['first completed', /press-key\] completed \(sub-1\)/],
  ['second completed', /press-key\] completed \(sub-3\)/],
]);

check('exit ends the program cleanly', ['status', 'exit'], [
  ['reports ready', /State\s+ready/],
]);

check('a single letter is a valid key', ['press-key a'], [
  ['accepts the letter', /press-key\] completed/],
]);

check('punctuation that needs no shift is a valid key', ['press-key slash'], [
  ['accepts the name', /press-key\] completed/],
]);

check('stop cancels a running subroutine', ['demo test-text 3000', 'stop'], [
  ['reports the stop', /Stopped 1 run\(s\): 1 cancelled/],
  ['logs the cancellation', /WARN\s+\[js-agent\/demo\] cancelled/],
]);

check('stop is a no-op when idle', ['stop'], [
  ['says nothing is running', /Nothing is running\./],
]);

check(
  'stop interrupts a long typing run',
  ['type-text abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz 60', 'stop'],
  [
    ['reports the stop', /Stopped 1 run\(s\): 1 cancelled/],
    ['logs the cancellation', /type-text\] cancelled/],
  ],
);

// Progress notes are published as the run advances. This is the regression guard
// for a real bug: the registry used to write "starting" *after* a subroutine's
// synchronous prefix, overwriting the subroutine's own first status line.
check('progress detail is reported and not overwritten', [
  'type-text aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 150',
], [
  ['reports its own detail', /running · typing \d+ chars/],
  ['reports progress', /typed \d+\/\d+ chars|typed \d+ chars/],
  ['reports the outcome', /completed · typed \d+ chars/],
  // The overwrite bug showed up as a "starting" note arriving after progress.
  ['starting never follows progress', /^(?![\s\S]*typing[\s\S]*starting)/],
]);

check('exit reports shutdown failures', ['press-key !', 'exit'], [
  ['reports the failure', /1 subroutine run\(s\) failed/],
], { expectCode: 1 });

check('dry run drives the simulated cursor', ['move-mouse 400 300', 'status'], [
  ['reports cursor', /Cursor\s+400,300/],
  ['never leaves dry run', /Input driver recorder \(dry run\)/],
]);

check('input error is reported and task fails', ['move-mouse 99999999 5'], [
  ['reports failure', /outside the simulated screen/],
  ['fails the run', /1 subroutine run\(s\) failed/],
], { expectCode: 1 });

check('unknown command is rejected', ['total-nonsense'], [
  ['explains', /Unknown command or subroutine "total-nonsense"/],
], { expectCode: 1 });

check('missing argument is explained', ['press-key'], [
  ['names the parameter', /"press-key" needs chord/],
], { expectCode: 1 });

check('unknown key name is explained', ['press-key crtl+c'], [
  ['names the key', /Unknown key "crtl"/],
  ['suggests ctrl', /ctrl/],
], { expectCode: 1 });

check('shifted punctuation cannot be a bare chord', ['press-key !'], [
  ['explains the shift', /shift\+1/],
], { expectCode: 1 });

check('multi-word text works unquoted', ['type-text hello world'], [
  ['runs to completion', /type-text\] completed/],
]);

check('quoted text is preserved exactly', ['type-text "a  b"'], [
  ['runs to completion', /type-text\] completed/],
]);

check('trailing number sets pacing', ['type-text hello 1'], [
  ['runs to completion', /type-text\] completed/],
]);

check('non-ASCII text is refused', ['type-text café'], [
  ['explains why', /printable ASCII only/],
  ['fails the run', /1 subroutine run\(s\) failed/],
], { expectCode: 1 });

check('extra arguments are refused', ['move-mouse 1 2 3 4'], [
  ['counts arguments', /accepts at most 3 argument\(s\)/],
], { expectCode: 1 });

check('a bad URL is refused', ['goto javascript:alert(1)'], [
  ['refuses the scheme', /not a URL I can open|only http and https/],
], { expectCode: 1 });

check('unknown help topic is handled', ['help nonsense'], [
  ['says so', /No command or subroutine named "nonsense"/],
]);

check('help shows a subroutine contract', ['help demo'], [
  ['shows usage', /usage: demo \[text\] \[wait-ms\]/],
  ['shows defaults', /default "5000"/],
]);

const filter = process.argv[2];
const selected = filter === undefined
  ? cases
  : cases.filter((testCase) => testCase.name.includes(filter));

let passed = 0;
const failures = [];

for (const testCase of selected) {
  const { output, code } = testCase.interactive
    ? await runInteractive(testCase.options.timeoutMs)
    : await run(testCase.commands, testCase.options.timeoutMs);
  const problems = [];

  if (code === 'timeout') {
    problems.push('timed out');
  } else if (testCase.options.expectCode !== undefined) {
    if (code !== testCase.options.expectCode) {
      problems.push(`expected exit ${testCase.options.expectCode}, got ${code}`);
    }
  } else if (code !== 0) {
    problems.push(`expected exit 0, got ${code}`);
  }

  for (const [label, pattern] of testCase.assertions) {
    if (!pattern.test(output)) problems.push(label);
  }

  if (problems.length === 0) {
    passed += 1;
    console.log(`  ok    ${testCase.name}`);
  } else {
    failures.push({ name: testCase.name, problems, output });
    console.log(`  FAIL  ${testCase.name}`);
    for (const problem of problems) console.log(`          - ${problem}`);
  }
}

console.log(`\n${passed}/${selected.length} passed`);

if (failures.length > 0) {
  console.log('\n--- failing output ---');
  for (const failure of failures) {
    console.log(`\n### ${failure.name}`);
    console.log(failure.output.trimEnd());
  }
  process.exitCode = 1;
}
