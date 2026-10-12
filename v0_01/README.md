# js-agent — target `v0_01`

A Node.js agent that can drive this machine's keyboard and mouse, plus a
separate layer of *subroutines* that sequence that input. You drive it from the
terminal.

This release is deliberately a skeleton: the two halves are built, wired
together, and separated cleanly enough to be worked on independently. The
built-in command set is only what was asked for — stop everything, see what is
running, exit.

> New to TypeScript, or to this codebase? Read
> [`docs/LEARNING-GUIDE.md`](docs/LEARNING-GUIDE.md). It walks the same
> architecture this README summarises, but explains the language features and
> the reasoning behind each decision as it goes.

---

## The two halves

| | Folder | Owns | May import |
|---|---|---|---|
| **Agent core** | `src/core/` | keyboard/mouse input, task bookkeeping | `src/contract/`, `src/shared/` |
| **Subroutines** | `src/subroutines/` | *what* to type and click, in what order | `src/contract/`, `src/shared/` |

They never import each other. Everything they must agree on lives in
`src/contract/` — types only, no behaviour. That is the whole design:

```
        ┌──────────────────────────────────────────────┐
        │  src/terminal/       the prompt and commands │
        └───────────────┬──────────────────────────────┘
                        │ drives both, owns shutdown
        ┌───────────────┴──────────────┐
        │                              │
┌───────▼────────┐            ┌────────▼─────────┐
│  src/core/     │            │ src/subroutines/ │
│  Agent         │◄───────────│  registry +      │
│  InputDevice   │  AgentApi  │  built-ins       │
│  TaskRegistry  │  (interface)│                 │
└───────┬────────┘            └──────────────────┘
        │                              │
        └──────────┬───────────────────┘
                   ▼
          ┌─────────────────┐
          │ src/contract/   │  the seam: types only
          └─────────────────┘
```

Because the subroutine layer only ever sees the `AgentApi` *interface*, you can
swap the driver (real, recorded, remote) without touching a single subroutine,
and you can rewrite every subroutine without going near the input code.

### What each folder is for

```
src/
  contract/          the seam. Types and interfaces only — no implementation.
    agent-api.ts       what the agent exposes to subroutines
    subroutine.ts      what a subroutine is, and the registry's interface
    input.ts           request shapes: typeText, pressKey, moveMouse, …
    signals.ts         cooperative cancellation
    tasks.ts           task states and snapshots
    logger.ts          logging vocabulary
    point.ts           coordinates, key names, chords

  core/              THE AGENT. Has no idea subroutines exist.
    agent.ts           turns requests into input, tracks every action
    input/
      nut-input-device.ts        the only code that touches the real OS
      recording-input-device.ts  dry-run twin: validates, records, sends nothing
      keymap.ts                  key names -> driver keys
    task-registry.ts   single source of truth for "what is running"
    index.ts           the folder's public surface

  subroutines/       BEHAVIOUR. Never touches the OS, never imports core/.
    registry.ts        catalogue + validation + running as tracked tasks
    builtin/           one file per behaviour
      press-key.ts  type-text.ts  move-mouse.ts  click-mouse.ts
      scroll.ts     goto.ts       demo.ts       index.ts
    index.ts

  terminal/          THE FRONT END. The only place that knows both halves.
    session.ts         prompt loop, dispatch, shutdown, SIGINT
    commands.ts        help / list / stop / status / exit
    banner.ts          the startup banner
    parse-command-line.ts

  shared/            Leaf utilities with no domain knowledge.
    command-line.ts    quoting and splitting
    text.ts            what the input driver can reproduce

  logging/           Console logger (used by both halves).
  cli/config.ts      command-line options
  app.ts             composition root — the ONE place the halves meet
  index.ts           entry point
```

---

## Running it

```bash
npm install
npm start                      # interactive, DRY RUN (nothing is sent)
npm run live                   # interactive, real keyboard and mouse
npm test                       # 24 behaviour checks
npm run check                  # typecheck
```

`npm start` defaults to the recording driver on purpose: you can develop and
test subroutines without the agent taking over your real keyboard mid-sentence.

### Options

```
--live                  drive the real keyboard and mouse
--dry-run               force the recording driver (default)
--log-level <level>     debug | info | warn | error
--speed <px-per-second> cursor speed; higher is faster
--key-delay <ms>        pause after each key press
--char-delay <ms>       pause between typed characters
--exec <command>        run a command, then exit; repeatable
--help
```

`--exec` runs its commands in order, settling each one before the next so that a
later command cannot read stale state. The one exception is a `stop` that
follows, which is deliberately allowed to interrupt work still in flight. It
exits non-zero if a command was rejected or a subroutine failed.

> **Quoting on PowerShell.** `node` receives quotes intact, but PowerShell strips
> them when handing arguments to a native command through `npm`. If you are on
> Windows and quoting gets mangled, use `scripts/smoke.mjs`, which passes a real
> argv array:
> `node scripts/smoke.mjs "type-text \"hello world\"" "list" "stop"`

---

## Commands

| Command | Aliases | What it does |
|---|---|---|
| `help [topic]` | `?`, `h` | list commands and subroutines; `help <name>` for one topic |
| `list [--all]` | `jobs`, `ps` | what is running now; `--all` adds recently finished runs |
| `stop` | `kill`, `cancel`, `stopall` | cancel every running subroutine and its input |
| `status` | | agent state, input driver, host, cursor, inputs sent |
| `exit` | `quit`, `q` | stop everything, release the driver, close |

Anything else is looked up as a subroutine.

---

## Subroutines

| Subroutine | Arguments | Notes |
|---|---|---|
| `press-key` | `<chord> [repeat] [key-delay-ms]` | `ctrl+shift+t`, `enter`, `f5`, `numpad4` |
| `type-text` | `<text ...> [char-delay-ms]` | printable ASCII only |
| `move-mouse` | `<x> <y> [duration-ms]` | duration `0` teleports |
| `click-mouse` | `[button] [times] [x] [y]` | clicks at the cursor, or moves first |
| `scroll` | `<steps> [axis]` | positive scrolls down/right |
| `goto` | `<url ...>` | opens the default browser via the Run dialog |
| `demo` | `[text] [wait-ms] [x] [y]` | worked example of the subroutine contract |

Text may be quoted (`type-text "a  b"`) or unquoted (`type-text hello world`);
both work, and quoting is exact.

---

## Adding a subroutine

One file, one entry in a barrel. Nothing in `src/core` or `src/terminal` changes.

```ts
// src/subroutines/builtin/save-file.ts
import type { Subroutine } from '../../contract/index.js';

export const saveFile: Subroutine = {
  name: 'save-file',
  summary: 'press ctrl+s and wait for the dialog',
  params: [{ name: 'wait-ms', required: false, description: 'settle time', defaultValue: '500' }],

  async entry(ctx) {
    ctx.signal.throwIfCancelled();          // between every step, so `stop` works
    await ctx.agent.pressKey({ chord: ['ctrl', 's'] });
    ctx.status('waiting for the dialog');   // shows up in `list`
    await ctx.sleep(ctx.paramOr('wait-ms', '500'));
  },
};
```

Then add it to `builtinSubroutines` in `src/subroutines/builtin/index.ts`.

Rules a subroutine must follow — they are what keep the halves separable:

1. Reach the machine only through `ctx.agent`.
2. Never import from `src/core`; types come from `src/contract`.
3. Call `ctx.signal.throwIfCancelled()` between steps.
4. Never call `process.exit`, never write to stdout directly, never manage
   cancellation yourself. Use `ctx.log`, `ctx.status`, `ctx.sleep`.

### Adding a command instead

Only add a built-in command if it is about *controlling the program*. Anything
that sends input is a subroutine. Commands live in `src/terminal/commands.ts`.

---

## How cancellation works

Cancellation is cooperative and explicit — there are no signals or thread
kills, so it is testable and precise.

- The `TaskRegistry` owns a `CancelToken` per task. `stop` cancels tasks, which
  trips their signals.
- Every layer checks the signal between steps: the agent before each action, the
  driver between keystrokes, `ctx.sleep` while waiting.
- A cancelled run is recorded as `cancelled`, not `failed`.
- The registry also holds a program-wide token, so `exit` and SIGINT cancel
  everything in one move.

A cancelled run is reported as `cancelled`; genuine errors are `failed` and are
reported with their message.

---

## Notes and known limits

These are deliberate for this skeleton, not oversights:

- **Dry run by default.** `npm start` uses a recording driver. Pass `--live`.
- **Printable ASCII only.** nut-js presses keycodes, so `é`, emoji and CJK
  cannot be reproduced faithfully. The driver refuses them with a clear message
  rather than silently sending the wrong characters. Pasting via the clipboard
  would be the fix.
- **Shifted punctuation is not a chord.** There is no keycode for `!`; it is
  Shift+1. `type-text !` works (the driver handles the shift), but `press-key !`
  is refused with a suggestion of `shift+1`.
- **One run per subroutine at a time.** A second `press-key` is refused while
  the first is still running, so `list` stays unambiguous.
- **`goto` uses the Run dialog.** Most reliable way to reach the user's default
  browser; `--new` depends on the browser honouring a command-line flag.
- **No confirmation prompt in live mode.** The banner warns; there is no
  "are you sure". Worth adding before this drives anything unattended.
- **No `--trace` flag** to dump the dry-run action log, though the recording
  driver already keeps one and the check suite could assert on it.

## Verification

`npm test` runs `scripts/check.mjs`: 28 cases, each in its own process, asserting
on real program output. It covers the interactive banner, the control commands,
cancellation (including interrupting input mid-flight), argument validation,
error reporting and exit codes. `scripts/smoke.mjs` is the same idea for ad-hoc
poking, with quoting that avoids shell mangling.
