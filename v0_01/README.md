# js-agent — target `v0_01`

A Node.js agent that drives this machine's keyboard and mouse, with a separate
layer of *subroutines* on top. You drive it from a terminal prompt.

v0_01 is the single-process baseline: one program owns the device and reads your
terminal. **v0_02 adds daemon mode** — [see it here](../v0_02/README.md).

---

## Documentation

| Document | Read it for |
|---|---|
| **this file** | what it is and how to start it |
| [Overview](docs/OVERVIEW.md) | the architecture, the vocabulary, and where to read next |
| [User guide](docs/USER-GUIDE.md) | commands, subroutines, options, examples, troubleshooting |
| [Learning guide](docs/LEARNING-GUIDE.md) | a TypeScript tour: why the code is shaped this way |
| [What's in v0_01](docs/V0_01-CHANGES.md) | scope, decisions, verification, known limits |
| [Roadmap](docs/ROADMAP.md) | what was planned for v0_02, and how the plan turned out |

Each version in this repository follows the same documentation shape: a landing
page, an architecture overview, a usage guide, a learning guide, a change
document, and a roadmap for what comes next.

---

## Quick start

```bash
cd v0_01
npm install
npm start          # interactive, dry run — nothing reaches your desktop
npm run live       # interactive, real keyboard and mouse
npm test           # 28 behaviour checks
npm run check      # typecheck
```

`--exec` runs commands non-interactively, which is useful for scripts and for
reproducing a problem in one line:

```bash
npm start -- --exec "help"
npm start -- --exec "move-mouse 400 300" --exec status
```

---

## A 60-second tour

The prompt accepts built-in commands and subroutine names:

| Command | What it does |
|---|---|
| `help [topic]` | list commands and subroutines; `help <name>` explains one |
| `list [--all]` | what is running now; `--all` includes finished runs |
| `stop` | cancel every running subroutine and its input |
| `status` | agent, driver, host, cursor, inputs sent |
| `exit` | stop everything and close |

| Subroutine | Example |
|---|---|
| `press-key` | `press-key ctrl+shift+t`, `press-key enter`, `press-key f5` |
| `type-text` | `type-text "hello, world"` |
| `move-mouse` | `move-mouse 400 300 250` |
| `click-mouse` | `click-mouse left 2` |
| `scroll` | `scroll 3` |
| `goto` | `goto example.com` |
| `demo` | `demo "hello" 5000` — countdown, click, type |

Anything that sends input is a subroutine, not a command. That is the central
rule of the program, and it is what keeps the two halves separable.

---

## Safety

The default driver is a **recorder**: every request is validated and recorded,
and nothing reaches the operating system. That is why `npm start` is safe to
explore with, and why the test suite can run unattended.

`npm run live` (or `--live`) selects the real driver. From then on, typing goes to
whatever window has focus. There is no confirmation prompt in this version — see
[the user guide](docs/USER-GUIDE.md) for safe habits.

---

## How it is built

```
src/contract/      types only — the seam between the halves
src/core/          the agent: input drivers, keymap, task registry
src/subroutines/   behaviours, one file each
src/terminal/      prompt, commands, rendering
```

`src/core/` and `src/subroutines/` never import each other; both talk only through
`src/contract/`. That boundary is what made it possible to add a second driver
(dry run) without touching a single subroutine.

Read [the overview](docs/OVERVIEW.md) for the diagram and the reading order.

---

## Known limits

Deliberate for a first version, and carried into the roadmap: one process only, no
confirmation before live input, printable ASCII only, one run per subroutine at a
time, no authentication model (nothing to authenticate yet), and Windows-only
verification.

The [roadmap](docs/ROADMAP.md) records how these became v0_02's requirements.
