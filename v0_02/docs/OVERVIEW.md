# Overview — `v0_02`

A structural map of v0_02: what it is, the three ways it can run, how a command
travels in each, and where to read next. Read this before the change document.

---

## What it is

The same program as v0_01 — a Node.js agent that controls the keyboard and mouse,
with subroutines on top — with one new capability: **the process that owns the
hardware can be a daemon, and other terminals can send it commands.**

Three modes:

| Mode | Process role | Front end |
|---|---|---|
| **standalone** | owns the device and reads a terminal | `LocalSession` |
| **daemon** | owns the device and serves other terminals | `DaemonServer` |
| **attach** | owns nothing; only sends commands | `RemoteSession` |

Exactly one process owns the keyboard and mouse. Every other process is a client
with no hardware access at all.

---

## The shape of the program

```
        clients (any number of terminals)
        ┌──────────────────┐        ┌──────────────────┐
        │ attach           │        │ standalone       │
        │ RemoteSession    │        │ LocalSession     │
        └────────┬─────────┘        └────────┬─────────┘
                 │ local socket              │ in-process
                 ▼                           ▼
        ┌──────────────────────────────────────────────┐
        │  CommandBroker      decides what a line means │
        ├──────────────────────────────────────────────┤
        │  Agent (keyboard/mouse)                      │
        │  SubroutineRegistry                          │
        │  TaskRegistry                                │
        │  EventBus ──────────► progress, logs, stop   │
        └──────────────────────────────────────────────┘
                 ▲
                 │  daemon layer: framing, protocol, transport,
                 │  discovery, lock, lifecycle
```

The layers that matter:

| Layer | Folder | Knows about |
|---|---|---|
| **contract** | `src/contract/` | nothing — types only, the seam |
| **agent** | `src/core/` | the operating system's input |
| **subroutines** | `src/subroutines/` | sequencing agent primitives |
| **command layer** | `src/terminal/broker.ts` + `commands.ts` | what a command line means |
| **front ends** | `src/terminal/local-session.ts`, `remote-session.ts` | prompts and rendering |
| **daemon** | `src/daemon/` | sockets, protocol, discovery, process lifecycle |
| **composition** | `src/app.ts`, `src/index.ts` | wiring and mode selection |

`src/core/` and `src/subroutines/` are **unchanged from v0_01**. The daemon did
not require touching them, which is the strongest evidence that the original
boundary was in the right place.

---

## How a command travels

### In standalone mode

1. `index.ts` parses flags, chooses the mode, builds the runtime (`app.ts`).
2. `LocalSession` reads a line, and calls `CommandBroker.execute(line, sink)`.
3. The broker resolves the line: built-in command, or subroutine.
4. A subroutine is validated synchronously, then started as a background task.
5. Input actions go through the agent to the active `InputDevice`.
6. The broker’s sink writes output to stdout; the `EventBus` publishes task
   transitions, which the session renders.
7. `exit` ends the session, which shuts the runtime down.

### In daemon + attach mode

1. The daemon starts: acquires the state-directory lock, listens on an endpoint,
   writes `daemon.json`, subscribes to the bus.
2. A client connects; the daemon sends `welcome` with the protocol version.
3. The client validates the version and replies `hello`.
4. The client sends `command` with an id; the daemon hands the line to the same
   `CommandBroker` and streams `output` messages back, then `result`.
5. The daemon broadcasts `event` messages to every attached client: task progress
   and log records.
6. `exit` in a client closes only that connection. `shutdown` asks the daemon to
   stop, which cancels work, releases the device, and removes `daemon.json` and
   `daemon.lock`.

### Where cancellation fits

Unchanged from v0_01: the `TaskRegistry` owns a cancellation token per task, and
every layer checks it between steps. What is new is scope: `stop` issued by any
client cancels work for all of them, because the work belongs to the daemon.

---

## Key concepts added in v0_02

| Term | Meaning |
|---|---|
| **endpoint** | Where the daemon listens: a named pipe / unix socket (`local`), or loopback TCP. |
| **discovery file** | `daemon.json` in the state directory: pid, endpoint, protocol version. |
| **state directory** | Default `~/.js-agent`; holds the discovery file, lock, socket (POSIX) and logs. Overridable with `--state-dir`. |
| **lock** | `daemon.lock`, claimed with an exclusive create. Enforces one daemon per state directory. |
| **protocol** | Versioned newline-delimited JSON. `PROTOCOL_VERSION` guards incompatible peers. |
| **broker** | The single implementation of “what does this command line mean?”. |
| **event bus** | Publish/subscribe for task and log events, so any number of front ends can render them. |

---

## Reading order

If you are new to the codebase, start with v0_01's material for the agent and
subroutines, then read the daemon layer:

1. [`../src/terminal/broker.ts`](../src/terminal/broker.ts) — the extracted
   decision layer, and the concurrency queue.
2. [`../src/daemon/server.ts`](../src/daemon/server.ts) — handshake, per-client
   state, broadcast, shutdown.
3. [`../src/daemon/framing.ts`](../src/daemon/framing.ts) — how bytes become
   messages.
4. [`../src/contract/protocol.ts`](../src/contract/protocol.ts) — the messages and
   their runtime guards.
5. [`../src/daemon/discovery.ts`](../src/daemon/discovery.ts) and
   [`../src/daemon/lock.ts`](../src/daemon/lock.ts) — finding a daemon and keeping
   it single.
6. [`../src/daemon/client.ts`](../src/daemon/client.ts) — the client state machine.
7. [`../src/cli/mode.ts`](../src/cli/mode.ts) — the startup decision.

The [change document](V0_02-CHANGES.md) explains the reasoning behind each step,
in the order the work happened.

---

## Documentation map

| Document | Answers |
|---|---|
| [README](../README.md) | What is this, and how do I start it? |
| **this file** | How is it put together, and where do I read? |
| [USER-GUIDE](USER-GUIDE.md) | How do I use each mode, and what do I do when it misbehaves? |
| [V0_02-CHANGES](V0_02-CHANGES.md) | What changed since v0_01, why, and which bugs shaped it. |
| [LEARNING-GUIDE](LEARNING-GUIDE.md) | A TypeScript tour of the agent and subroutine layers (written for v0_01; still accurate for those layers). |
| [ROADMAP](ROADMAP.md) | What comes next, with acceptance criteria. |
