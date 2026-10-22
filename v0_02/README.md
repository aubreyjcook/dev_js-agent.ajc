# js-agent — target `v0_02`

A Node.js agent that drives this machine's keyboard and mouse, with a separate
layer of *subroutines* on top. It runs in one of three modes:

| Mode | What it means |
|---|---|
| **standalone** | This process owns the device and gives you a prompt. Same as v0_01. |
| **daemon** | One process owns the device and serves commands from **any terminal** on the machine. |
| **attach** | This process is only a client: commands go to the running daemon. |

Exactly one process owns the hardware; every other process is a client with no
input access. When you run it without `--mode`, it asks — explicit flags skip the
question.

---

## Documentation

| Document | Read it for |
|---|---|
| **this file** | what it is and how to start it |
| [Overview](docs/OVERVIEW.md) | the architecture, the three modes, how a command travels |
| [User guide](docs/USER-GUIDE.md) | every mode, options, commands, examples, troubleshooting, security |
| [What changed in v0_02](docs/V0_02-CHANGES.md) | the design decisions and the bugs that shaped them |
| [Learning guide](docs/LEARNING-GUIDE.md) | a TypeScript tour of the agent and subroutine layers |
| [Roadmap](docs/ROADMAP.md) | what comes next (v0_03), with acceptance criteria |
| [v0_01](../v0_01/README.md) | the single-process baseline this version grew from |

Every version follows the same documentation shape: landing page, architecture
overview, user guide, learning guide, change document, and a roadmap for the next
version.

---

## Quick start

```bash
cd v0_02
npm install
npm run check        # typecheck
npm test             # 45 behaviour checks (standalone + daemon + detached)

npm start            # asks: standalone or daemon (or attach, if one is running)
npm run standalone   # local prompt, dry run — nothing reaches the desktop
npm run live         # local prompt, real keyboard and mouse
```

### Daemon in four lines

```bash
npm run daemon:detach                      # background service, dry run
npm start -- --mode attach --exec status   # from any terminal
npm start -- --mode attach --exec "stop"   # cancel shared work
npm start -- --stop-daemon                 # stop the service
```

Or run it in the foreground (`npm run daemon`) to watch the logs; Ctrl+C stops it.

### The three-terminal pattern

This is the workflow daemon mode exists for:

```bash
# 1: start something long and return immediately
npm start -- --mode attach --exec "demo hello 8000" --no-wait

# 2: watch it
npm start -- --mode attach --exec "list" --no-wait

# 3: stop it (everyone sees the cancellation)
npm start -- --mode attach --exec "stop"
```

---

## Commands

| Command | What it does |
|---|---|
| `help [topic]` | list commands and subroutines; `help <name>` for details |
| `list [--all]` | what is running now; `--all` adds finished runs |
| `stop` | cancel **every** running subroutine, in every client |
| `status` | agent, driver, host, and daemon details if attached |
| `exit` | leave this terminal. **Attach mode: detach; the daemon keeps running** |
| `shutdown` | stop the program — or the daemon and all its clients |

Subroutines are unchanged from v0_01: `press-key`, `type-text`, `move-mouse`,
`click-mouse`, `scroll`, `goto`, `demo`.

Exit codes: `0` success, `1` a command or run failed (or no daemon to talk to),
`2` bad usage or no safe mode choice. The full option list is in the
[user guide](docs/USER-GUIDE.md).

---

## How it is built

```
        clients (many terminals)
        ┌──────────────────┐   ┌──────────────────┐
        │ attach           │   │ standalone       │
        │ RemoteSession    │   │ LocalSession     │
        └────────┬─────────┘   └────────┬─────────┘
                 │ local socket          │ in-process
        ┌────────▼───────────────────────▼─────────┐
        │  CommandBroker   decides what a line means│
        ├──────────────────────────────────────────┤
        │  Agent (keyboard/mouse)  Subroutines     │
        │  TaskRegistry            EventBus        │
        └──────────────────────────────────────────┘
```

`src/core/` (the agent) and `src/subroutines/` (behaviour) never import each
other; both talk only through `src/contract/`. **The daemon did not change
either of them** — that is the point of the split. The daemon layer
(`src/daemon/`) adds framing, a versioned protocol, transport, discovery,
locking and process lifecycle.

Read [the overview](docs/OVERVIEW.md) for the diagram and the reading order.

---

## Security, briefly

The daemon trusts any process that can open its socket: there is no
authentication, any client can `stop` or `shutdown`, and `--live` means any
attached client can drive the real keyboard and mouse. The default endpoint is a
user-scoped local pipe/socket; loopback TCP is opt-in.

Use dry run while experimenting. Authentication, authorisation and client
attribution are the first items on the [roadmap](docs/ROADMAP.md).

---

## Verification

`npm test` runs 45 cases in [`scripts/check.mjs`](scripts/check.mjs):

- 7 CLI/conflict cases and 3 mode-chooser cases (including answering the menu)
- 17 standalone cases — the v0_01 regression net
- 11 daemon cases driven from separate client processes: shared state, stop from
  a third client, detach-on-exit, single-instance refusal, protocol mismatch
- 5 detached-lifecycle cases, including discovery-file cleanup
- 2 orphan-recovery cases: a daemon whose `daemon.json` is deleted is still
  stoppable via its lock file

Each case runs in its own process, with its own temporary state directory, and a
hang is a failure.
