# js-agent — target `v0_02`

A Node.js agent that drives this machine's keyboard and mouse, with a separate
layer of *subroutines* on top. It runs in one of three modes:

| Mode | What it means |
|---|---|
| **standalone** | This process owns the device and gives you a prompt. Same as v0_01. |
| **daemon** | One process owns the device and serves commands from **any terminal** on the machine. |
| **attach** | This process is only a client: commands go to the running daemon. |

When you run it without `--mode`, it asks. Explicit flags skip the question.

> New to the code? Read [`docs/V0_02-CHANGES.md`](docs/V0_02-CHANGES.md) for what
> changed since v0_01 and why, or [`docs/LEARNING-GUIDE.md`](docs/LEARNING-GUIDE.md)
> for a full TypeScript tour of the agent and subroutine layers (written against
> v0_01; still accurate for those layers).

---

## The design in one picture

```
        clients (any number of terminals)
        ┌──────────────────┐   ┌──────────────────┐
        │ attach           │   │ standalone       │
        │ RemoteSession    │   │ LocalSession     │
        └────────┬─────────┘   └────────┬─────────┘
                 │ local socket          │ in-process
        ┌────────▼───────────────────────▼─────────┐
        │            CommandBroker                 │  ← decides what a command means
        ├──────────────────────────────────────────┤
        │  Agent (keyboard/mouse)  Subroutines     │  ← unchanged since v0_01
        │  TaskRegistry            EventBus        │
        └──────────────────────────────────────────┘
```

The agent and the subroutines never import each other. Both talk only through
`src/contract/`. The daemon added in v0_02 did not change either of them — that
is the point of the split.

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

### Daemon mode

```bash
# Terminal 1: start a background daemon (dry run by default)
npm run daemon:detach
#   pid 12345 · endpoint pipe \\.\pipe\js-agent-1a2b3c · log ~/.js-agent/daemon.log

# Terminal 2, 3, …: drive it
npm run attach                                  # interactive prompt
npm start -- --mode attach --exec "list"        # one command
npm start -- --mode attach --exec "stop"        # stop shared work
npm start -- --stop-daemon                      # stop the service
```

Or keep it in the foreground to watch the logs:

```bash
npm run daemon          # Ctrl+C stops it
```

### Verify the interesting part

Three terminals, one run:

```bash
# 1: start something long and return immediately
npm start -- --mode attach --exec "demo hello 8000" --no-wait

# 2: see it
npm start -- --mode attach --exec "list" --no-wait

# 3: stop it (visible to everyone)
npm start -- --mode attach --exec "stop"
```

---

## Options

```
--mode <mode>           standalone | daemon | attach
--standalone            shorthand for --mode standalone
--daemon                shorthand for --mode daemon
--attach                shorthand for --mode attach
--detach                daemon mode: run in the background and return
--stop-daemon           stop a running daemon, then exit
--state-dir <path>      where the discovery file, socket and log live
--port <n>              use loopback TCP instead of a local socket (0 = choose one)
--endpoint <path>       explicit pipe/socket path
--log-file <path>       also write logs to this file
--ask                   ask for a mode even when stdin is not a terminal
--no-wait               with --exec: return without waiting for background work

--live / --dry-run      real input, or the recording driver (default: dry run)
--log-level <level>     debug | info | warn | error
--speed / --key-delay / --char-delay
--exec <command>        run a command, then exit; repeatable
--help
```

Conflicts are rejected before anything starts, with exit code 2: two different
modes, `--detach` without daemon mode, `--port` with `--endpoint`,
`--stop-daemon` with `--exec`.

Exit codes: `0` success, `1` a command or run failed (or no daemon to talk to),
`2` bad usage or no safe mode choice.

---

## Commands

| Command | What it does |
|---|---|
| `help [topic]` | list commands and subroutines; `help <name>` for details |
| `list [--all]` | what is running now; `--all` adds finished runs |
| `stop` | cancel **every** running subroutine, in every client |
| `status` | agent, driver, host, and daemon details if attached |
| `exit` | leave this terminal. **In attach mode: detach; the daemon keeps running** |
| `shutdown` | stop the program — or the daemon and all its clients |

Subroutines are unchanged from v0_01: `press-key`, `type-text`, `move-mouse`,
`click-mouse`, `scroll`, `goto`, `demo`.

---

## How the daemon works

- **Discovery.** On start the daemon writes `daemon.json` into its state
  directory (`~/.js-agent` by default): pid, endpoint, protocol version. Clients
  find it there, so a daemon on an OS-chosen port is still findable.
- **Transport.** A named pipe (Windows) or unix socket (POSIX). `--port` opts
  into loopback TCP for debugging or restricted environments.
- **Protocol.** Newline-delimited JSON with a versioned handshake; every request
  has an id; every frame is validated before it is trusted.
- **Single instance.** An exclusive lock file, claimed *before* the input device
  is opened. A second daemon refuses with a clear message and leaves the first
  one alone.
- **Lifecycle.** `--detach` spawns a background process and waits until it is
  reachable. `--stop-daemon` asks it to shut down over the protocol so it can
  cancel work, release the device and clean up.

Full reasoning, including the bugs that shaped it, is in
[`docs/V0_02-CHANGES.md`](docs/V0_02-CHANGES.md).

---

## Layout

```
src/
  contract/      shared types only. The seam. (v0_02 added commands, events,
                 protocol, transport.)
  core/          the agent: drivers, keymap, task registry. Unchanged.
  subroutines/   behaviours, one file each. Unchanged.
  terminal/      front ends and command layer:
                   broker.ts          decides what a command means (new)
                   local-session.ts   standalone prompt
                   remote-session.ts  attached prompt (new)
                   commands.ts        help/list/stop/status/exit/shutdown
                   render.ts          formatting shared by both front ends (new)
  daemon/        transport, framing, protocol server/client, discovery, lock,
                 lifecycle. All new in v0_02.
  cli/           flag parsing and the mode chooser.
  app.ts         composition root: builds the runtime and the bus.
  index.ts       entry point: parse → stop-daemon? → discover → choose → run.
```

---

## Known limits

- **No authentication.** Any process that can open the socket is trusted
  completely, and any client can `shutdown` or `stop`. The default socket is
  user-scoped (0600 on POSIX), and loopback TCP is opt-in for this reason.
- **`--live` in daemon mode means every attached client can drive the real
  keyboard and mouse.** Use dry run while experimenting.
- **Named pipes are blocked in some sandboxes.** There the daemon must be given
  `--port 0`; the tests do exactly that, while production defaults to the pipe.
- **Attach mode has no per-command settling.** `--exec` waits for the daemon to
  be idle at the end; `--no-wait` skips that. Observing in-flight work is done
  from a second client, which is the intended pattern.
- **No client identity in the UI.** A run does not say which client started it.
- **Printable ASCII only, one run per subroutine at a time**, as in v0_01.

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
