# v0_01 — initial release: what this version establishes

This is the first version, so “what changed” means *what exists now that did not
exist before*: the program itself. This document records the scope that was set,
the decisions that produced the shape, and what was deliberately left out. It is
written to be read alongside the [learning guide](LEARNING-GUIDE.md), which
explains the code in detail.

The next version, and how it changed this one, is documented in
[`v0_02/docs/V0_02-CHANGES.md`](../../v0_02/docs/V0_02-CHANGES.md).

---

## The brief

Build a Node.js agent in JavaScript/TypeScript that can control the keyboard and
mouse of the system it runs on. It has two parts:

- **an agent** that owns keyboard and mouse control;
- **subroutines** — the collection of automated inputs that correspond to
  commands given to the agent.

From the terminal, a minimal set of commands is required: stop all running
commands, see what is running, and exit. The two parts must be clearly separated
so they can be worked on and updated independently.

Everything here follows from those sentences.

---

## What “clearly separated” became

The requirement is about *change*: you should be able to work on one half without
fear of the other. That is a dependency question, so the answer is a folder
boundary plus a rule:

| Half | Folder | Allowed to import |
|---|---|---|
| Agent (hardware) | `src/core/` | `src/contract/`, `src/shared/` |
| Subroutines (behaviour) | `src/subroutines/` | `src/contract/`, `src/shared/` |
| Front end | `src/terminal/` | both halves |

They never import each other. Everything they must agree on is a type-only
*contract* ([`src/contract/`](../src/contract/index.ts)): the agent's API, the
subroutine shape, task snapshots, cancellation, request types.

The test of that boundary is not the diagram; it is whether the boundary survives
contact with a new requirement. It did: the recording driver was added as a
second `InputDevice` implementation and no subroutine changed. A later version
adds a daemon for the same reason (see the roadmap).

---

## What was built

```
v0_01/
  src/
    contract/        types only — the seam between the halves
      agent-api.ts     what subroutines may ask the agent to do
      subroutine.ts    what a subroutine is; the registry's interface
      input.ts         request shapes (typeText, pressKey, moveMouse, …)
      signals.ts       cooperative cancellation
      tasks.ts         task states and snapshots
      logger.ts        logging vocabulary
      point.ts         coordinates, key names, chords
    core/            the agent. No knowledge of subroutines.
      agent.ts         turns requests into tracked input actions
      input/
        nut-input-device.ts        the only code that touches the real OS
        recording-input-device.ts  dry-run twin, validates and records
        keymap.ts                  key names → driver keys
      task-registry.ts  single source of truth for “what is running”
    subroutines/     behaviour. Never touches the OS directly.
      registry.ts       catalogue, validation, running as tracked tasks
      builtin/          one file per behaviour
    terminal/        the prompt, built-in commands, banner, parsing
    shared/          parsing and text utilities with no domain knowledge
    logging/         console logger
    cli/             flag parsing
    app.ts           composition root
    index.ts         entry point
  scripts/
    check.mjs        28 behaviour checks
    smoke.mjs        ad-hoc driver with safe argv handling
  docs/
    OVERVIEW, USER-GUIDE, LEARNING-GUIDE, this file, ROADMAP
```

---

## Decisions worth studying

These are the choices that a reader should be able to argue about, with the
alternative that was rejected.

### 1. A dry-run driver, on by default

**Decision.** Ship two `InputDevice` implementations: `NutInputDevice` for real
input, and `RecordingInputDevice` that validates and records but performs
nothing. Default to the recorder.

**Why.** A program that grabs the keyboard is hostile to develop against. A
recording driver makes the whole program exercisable in tests, in CI, and by a
reader who does not want their cursor moved. It also forces the interface to be
honest — if the agent depended on a detail only the real driver has, the recorder
could not implement it.

**Rejected.** A `--dry-run` boolean threaded through the agent, which would spread
conditionals through the input path and leave the untested path in production.

### 2. Types as the seam, not shared code

**Decision.** The contract contains no behaviour, only types. Shared *functions*
go to `src/shared/`.

**Why.** Behaviour in the seam becomes a place both halves depend on and neither
owns; it accretes until the halves are coupled through it. Types are cheap to
change and cannot hide logic.

### 3. Synchronous validation before asynchronous work

**Decision.** `prepareRun` validates a subroutine invocation and returns a
discriminated result *synchronously*; `start` does the asynchronous run.

**Why.** An `async` function turns a thrown validation error into a rejected
promise. The terminal would then have to await the whole run to discover that the
arguments were wrong — or, worse, never discover it. This was a real bug during
development and is written up in the learning guide.

### 4. Cooperative cancellation, checked between steps

**Decision.** A `CancellationSignal` is passed to work; every layer calls
`throwIfCancelled()` between actions. The registry owns one token per task.

**Why.** It is predictable, testable, and works identically for a keystroke loop
and a subroutine countdown. Cancellation is reported as `cancelled`, distinct
from `failed`, because “the user asked us to stop” is not an error.

**Rejected.** Killing the process on `stop`, which would leave the user with a
held modifier key and no summary.

### 5. Every unit of work is a task

**Decision.** Both a whole subroutine run and each individual input action are
recorded in the same `TaskRegistry`.

**Why.** `list` needs to show subroutines, and `stop` needs to reach the input
currently in flight. One registry gives both, and gives the terminal a single
event stream to render.

### 6. Four commands, and no more

**Decision.** Built-ins are `help`, `list`, `stop`, `status`, `exit`. Anything
that sends input is a subroutine, not a command.

**Why.** The brief asked for three control commands. Adding input verbs as
commands would blur the boundary the whole program is built on. `status` was
added because it costs nothing and makes the runtime inspectable.

---

## How it was verified

`npm test` runs **28 cases** in [`scripts/check.mjs`](../scripts/check.mjs), each
in its own process, against real program output:

- the control commands (`help`, `list`, `stop`, `exit`, `status`);
- cancellation, including interrupting typing mid-run;
- argument validation and error reporting, with exit codes;
- quirks of the input layer: ASCII-only text, shifted punctuation, single
  characters as keys;
- the interactive banner, and the non-TTY path.

Bugs this suite caught during development are documented in the learning guide,
including a `stop` that could hang, a progress line that was overwritten, and bad
arguments that exited `0`.

---

## Known limits at release

Deliberate, and carried forward into the roadmap:

- **One process.** The agent owns a terminal; there is no way to command it from
  another terminal.
- **No confirmation before live input.** The banner warns; that is all.
- **Printable ASCII only**, because the driver presses keycodes.
- **One run of a given subroutine at a time**, so `list` stays unambiguous.
- **Log lines can collide with the prompt**, because the logger writes directly
  to stdout.
- **No authentication or permissions model** — there is nothing to authenticate
  against yet.
- **Windows-only verification**, though the code is portable.

---

## Next

The roadmap written when this version was finished is
[`ROADMAP.md`](ROADMAP.md). It planned v0_02 and records, item by item, how that
plan turned out.
