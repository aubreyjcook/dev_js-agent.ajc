# User guide — `v0_01`

Everything you need to run the program, use its commands, and know what to do
when something looks wrong. For *why* the code is shaped this way, see the
[learning guide](LEARNING-GUIDE.md); for a structural map, see the
[overview](OVERVIEW.md).

---

## Requirements

- **Node.js 20 or newer** (`node --version`).
- **npm**.
- A desktop session. Input is injected at the operating-system level, so a
  headless machine has nothing to type into.
- Windows, macOS or Linux. The native input backend ships prebuilt binaries for
  the common platforms; `npm install` does not need a compiler.

Node 16 and 18 are below the requirement: the tooling (`tsx`/esbuild) and the
module features used here expect a modern runtime, and the failure on an older
Node is confusing rather than obvious. If you use nvm and the default is older,
switch before doing anything else:

```bash
nvm use 24      # or any installed 20+
node --version  # confirm
```

Tested here on Windows 11 with Node 24. The code is written portably, but that is
the only platform it has actually been exercised on.

## Install

```bash
cd v0_01
npm install
```

Verify the toolchain before running anything:

```bash
npm run check      # type-checks; writes nothing
npm test           # 28 behaviour checks, all in dry-run mode
```

---

## First run — dry run

```bash
npm start
```

You should see a banner, then `js-agent> `. Nothing you do will reach your real
desktop: the default driver is a **recorder** that validates every request,
records it, and performs nothing.

```text
  js-agent 0.1.0  ·  target 0.01
  input driver   recorder (dry run — nothing is sent)
  ...
js-agent> move-mouse 400 300
[sub-1] move-mouse: running · moving to 400,300
[sub-1] move-mouse: completed · cursor at 400,300
```

Use the dry run to learn the commands and to develop subroutines. It is also what
the automated suite uses.

## Live run — real input

```bash
npm run live
```

or `npm start -- --live`. The banner changes to `LIVE — real keyboard and mouse`
and a warning is printed. From that point, subroutines really do type, click and
move.

**Safety habits worth adopting:**

- Start with something harmless: `move-mouse 200 200`, then `type-text hello`.
- Remember that typing goes to whatever window has focus. Click the target first,
  or use `demo`, which counts down and tells you to focus.
- Keep a hand near `Ctrl+C`; `stop` cancels running work.
- Type `stop` first if a run is doing something unexpected.

There is no confirmation prompt in this version. That is a deliberate scope
limit, noted at the end.

---

## Command-line options

```
--live                  drive the real keyboard and mouse
--dry-run               force the recording driver (default)
--log-level <level>     debug | info | warn | error
--speed <px-per-second> cursor speed; higher is faster
--key-delay <ms>        pause after each key press
--char-delay <ms>       pause between typed characters
--exec <command>        run a command, then exit; repeatable, in order
--help
```

Examples:

```bash
npm start -- --live --log-level debug
npm start -- --exec "help"
npm start -- --exec "press-key ctrl+l" --exec "type-text https://example.com" --exec "press-key enter"
```

`--exec` runs commands in order, settles between them (except before `stop`), and
exits `0` or `1`. Use it for scripts and for reproducing a bug in one line.

---

## Commands

| Command | Aliases | What it does |
|---|---|---|
| `help [topic]` | `?`, `h` | list commands and subroutines; `help <name>` explains one |
| `list [--all]` | `jobs`, `ps` | what is running now; `--all` adds recently finished runs |
| `stop` | `kill`, `cancel`, `stopall` | cancel every running subroutine and its input |
| `status` | | agent state, driver, host, cursor, inputs sent |
| `exit` | `quit`, `q` | stop everything, release the driver, close |

Anything else is looked up as a subroutine.

### Examples

```text
js-agent> help
js-agent> help type-text
js-agent> status
js-agent> list
js-agent> list --all
js-agent> stop
js-agent> exit
```

Arguments are split on whitespace, and `"quotes"` preserve spaces:

```text
js-agent> type-text "hello, world"
js-agent> type-text hello world        # same thing: the last argument soaks up words
```

---

## Subroutines

| Subroutine | Arguments | Notes |
|---|---|---|
| `press-key` | `<chord> [repeat] [key-delay-ms]` | `ctrl+shift+t`, `enter`, `f5`, `numpad4`, or a single character |
| `type-text` | `<text ...> [char-delay-ms]` | printable ASCII only; trailing number sets pacing |
| `move-mouse` | `<x> <y> [duration-ms]` | `0` teleports; larger values animate |
| `click-mouse` | `[button] [times] [x] [y]` | clicks at the cursor, or moves first |
| `scroll` | `<steps> [axis]` | positive scrolls down/right |
| `goto` | `<url ...>` | opens the default browser via the Run dialog |
| `demo` | `[text] [wait-ms] [x] [y]` | countdown, click, type — a template to copy |

`help <subroutine>` prints the arguments, their defaults, and what they mean.

### Worked examples

Open a new browser tab and search:

```text
js-agent> press-key ctrl+l
js-agent> type-text "keyboard automation"
js-agent> press-key enter
```

Wait five seconds so you can focus a target, then click and type:

```text
js-agent> demo "typed by a subroutine" 5000
```

Move, click, and scroll the cursor to a fixed spot:

```text
js-agent> move-mouse 640 400 300
js-agent> click-mouse left 1
js-agent> scroll 3
```

Hold a chord and repeat it:

```text
js-agent> press-key ctrl+t 3
```

Cancel a long run:

```text
js-agent> demo hello 30000
[sub-1] demo: running · starting in 30s
js-agent> stop
Stopped 1 run(s): 1 cancelled.
```

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | a command was rejected, or a subroutine run failed |
| `2` | bad command-line usage, or nothing to read because stdin is not a terminal |

`--exec` reports failures through the exit code, so it can be used in scripts.

---

## Troubleshooting

### Node is older than 20

Symptom: `npm test` prints a version message and exits 2, or the program fails
inside `tsx` with module errors. The project requires Node 20+; the check script
now fails early rather than deep in the toolchain.

```bash
nvm use 24      # or any installed 20+
npm test
```

### `spawn EPERM` when starting

`tsx` runs `esbuild`, which starts a helper process over pipes. Confined sandboxes
that forbid named pipes will fail here. Run outside the sandbox, or test on a
normal shell. This is an environment restriction, not a program bug.

### `Cannot find module …` mentioning a path one directory too high

Read the path in the error first. Import specifiers use `.js` even though the
files are `.ts` (see the learning guide), and `../` from `src/` means the package
root. A wrong relative path is almost always the cause.

### Text with accents, emoji or CJK does not type correctly

The driver reproduces **printable ASCII** only, because the input backend presses
keycodes. Such text is refused with an explanation rather than typed wrongly. The
fix would be clipboard-based pasting, which is on the roadmap.

### `press-key !` is refused

There is no keycode for `!`; it is Shift+1. Use `type-text !`, or the explicit
chord `press-key shift+1`. The error message suggests the right form.

### The prompt gets mixed up with log lines

Asynchronous log records are written straight to stdout in this version, so they
can land on the same line as the prompt. Press Enter to redraw it. Task progress
lines are prompt-aware; log lines are not.

### Quoting is mangled on Windows PowerShell

PowerShell rewrites quotes when handing arguments to a native program. Prefer the
argument forms that need no quotes (`type-text hello world`), use a script file,
or run through `cmd /c '...'` with single outer quotes. `scripts/smoke.mjs` passes
a real argv array and avoids the problem entirely:

```bash
node scripts/smoke.mjs "type-text \"hello world\"" "list"
```

### A run seems to hang after `stop`

`stop` waits for the run to unwind so it can report an accurate summary. If a
native call is genuinely stuck, the shutdown path gives up after a couple of
seconds. Report the sequence if you can reproduce it.

### `stdin is not a TTY`

The interactive prompt needs a terminal. From a script, use `--exec`. This is
also why an automated test can check the banner but not the prompt.

---

## Where to go next

- Add a subroutine: see “Adding a subroutine” in the [README](../README.md).
- Understand the design: [learning guide](LEARNING-GUIDE.md).
- See what was deliberately left out and what came next: [roadmap](ROADMAP.md).
