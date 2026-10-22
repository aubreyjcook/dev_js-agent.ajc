# Overview — `v0_01`

A one-page map of what this program is, how it is put together, and where to read
next. If you are new to the codebase, read this before the learning guide.

---

## What it is

`js-agent` is a Node.js program that drives the computer it runs on: it can type
text, press keys and chords, move the cursor, click and scroll. On top of that
low-level ability sits a layer of *subroutines* — named, scripted sequences of
input that a person invokes from a terminal prompt.

It is deliberately a skeleton. The interesting engineering is not the mouse
movement; it is the boundary between "code that touches the operating system" and
"code that decides what to do", and how that boundary is kept clean enough that
each side can be developed and replaced on its own.

---

## The shape of the program

```
                    ┌──────────────────────────────────────┐
                    │  src/terminal/                       │
                    │  the prompt: reads a line, dispatches │
                    │  commands, renders output             │
                    └───────────────┬──────────────────────┘
                                    │ uses both halves
                   ┌────────────────┴─────────────────┐
                   ▼                                  ▼
        ┌──────────────────────┐          ┌───────────────────────┐
        │  src/core/           │          │  src/subroutines/     │
        │  Agent               │◄─────────│  registry + built-ins │
        │  InputDevice drivers │ AgentApi │                       │
        │  TaskRegistry        │(contract)│                       │
        └──────────┬───────────┘          └───────────┬───────────┘
                   │                                  │
                   └───────────────┬──────────────────┘
                                   ▼
                       ┌─────────────────────────┐
                       │  src/contract/          │
                       │  types only — the seam  │
                       └─────────────────────────┘
```

Three rules define the design:

1. `src/core/` and `src/subroutines/` never import each other.
2. Both may import `src/contract/`, which contains types and interfaces only.
3. `src/terminal/` is the only layer that knows both, because presenting them is
   its job.

This is **dependency inversion**: the subroutine layer depends on the `AgentApi`
*interface*, not on the agent. That is why a second input driver — the recording
driver used for dry runs — could be dropped in without touching a subroutine.

---

## How a command travels

1. `src/index.ts` parses flags, builds the app (`src/app.ts`), and starts the
   terminal session.
2. `TerminalSession` reads a line and splits it into a command name and
   arguments (`shared/command-line.ts`).
3. If the name is a built-in (`help`, `list`, `stop`, `status`, `exit`), the
   command implementation runs. Otherwise it is looked up as a subroutine.
4. Subroutines are validated synchronously (`prepareRun`) and then started as a
   tracked task; they run in the background so the prompt stays responsive.
5. Inside a subroutine, every action goes through `ctx.agent`, which creates an
   *input task* and asks the active `InputDevice` to perform it.
6. The `TaskRegistry` records both kinds of task, so `list` can show work and
   `stop` can cancel it. Cancellation is cooperative: the registry owns a token,
   and every layer checks it between steps.
7. The terminal renders task transitions as they happen and prints command
   output.

---

## Vocabulary

| Term | Meaning in this codebase |
|---|---|
| **agent** | The core that turns requests into real keyboard/mouse actions. |
| **driver / device** | An `InputDevice` implementation: `NutInputDevice` (real) or `RecordingInputDevice` (dry run). |
| **subroutine** | A named behaviour built from agent primitives, e.g. `type-text`. |
| **task** | One tracked unit of work: a whole subroutine run, or one input action. |
| **signal / token** | The read-only cancellation handle / the writable source that trips it. |
| **dry run** | Running against the recording driver; nothing reaches the OS. |
| **contract** | `src/contract/` — the shared types, and the only coupling between halves. |
| **composition root** | `src/app.ts` — the one place concrete implementations are chosen. |

---

## Where the code lives

```
src/
  contract/      types only: input requests, agent API, subroutines, tasks,
                 cancellation, logging
  core/          the agent: driver implementations, key mapping, task registry
  subroutines/   the registry and one file per built-in behaviour
  terminal/      prompt loop, built-in commands, banner, command-line parsing
  shared/        leaf utilities with no domain knowledge
  logging/       console logger
  cli/           flag parsing
  app.ts         composition root
  index.ts       entry point
```

---

## Reading order

1. `src/contract/input.ts` and `src/contract/tasks.ts` — the vocabulary.
2. `src/subroutines/builtin/press-key.ts` — the smallest complete behaviour.
3. `src/core/input/recording-input-device.ts` — an interface implementation with
   no native code in the way.
4. `src/core/task-registry.ts` — the bookkeeping behind `list` and `stop`.
5. `src/contract/signals.ts` — cancellation, including the settle-once guard.
6. `src/core/agent.ts` — the input pipeline.
7. `src/subroutines/registry.ts` — running behaviour as tracked work.
8. `src/terminal/session.ts` — dispatch, prompt, shutdown.
9. `src/app.ts` and `src/index.ts` — wiring and entry.

The [learning guide](LEARNING-GUIDE.md) walks exactly this path and explains the
TypeScript as it goes.

---

## Documentation map

| Document | Answers |
|---|---|
| [README](../README.md) | What is this, and how do I start it? |
| **this file** | How is it put together, and where do I read? |
| [USER-GUIDE](USER-GUIDE.md) | How do I actually use it: commands, options, examples, troubleshooting. |
| [LEARNING-GUIDE](LEARNING-GUIDE.md) | Why is it written this way, and what TypeScript is it using? |
| [V0_01-CHANGES](V0_01-CHANGES.md) | What exists in this version, and which decisions produced it? |
| [ROADMAP](ROADMAP.md) | What was planned next (v0_02), and how did it turn out? |
