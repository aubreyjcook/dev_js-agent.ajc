# User guide — `v0_02`

How to run the program in each mode, use its commands, and recover when something
goes wrong. For the design reasoning, see the
[change document](V0_02-CHANGES.md); for a structural map, the
[overview](OVERVIEW.md).

---

## Requirements

- **Node.js 20 or newer**, npm, and a desktop session (input is injected at the
  OS level).
- The native input backend ships prebuilt binaries; no compiler is needed.
- Tested on Windows 11 with Node 24. The code is portable but that is the only
  platform exercised.

Node 16 and 18 are below the requirement. If you use nvm and the default is
older, switch first — otherwise `tsx` fails with unrelated-looking module errors:

```bash
nvm use 24      # or any installed 20+
node --version  # confirm
```

## Install

```bash
cd v0_02
npm install
npm run check      # typecheck
npm test           # 45 behaviour checks (standalone + daemon + detached)
```

---

## Choosing a mode

Run without a mode and the program asks:

```text
  How should js-agent run?

    1) standalone  this terminal owns the keyboard and mouse (default)
    2) daemon      run as a service; any terminal can send commands
```

If a daemon is already running, option 2 becomes **attach** instead, because
starting a second daemon would fail:

```text
    1) standalone  this terminal owns the keyboard and mouse (default)
    2) attach      send commands to the running daemon (pid 4021) on …
```

Press Enter for the default. The rules around the prompt are strict, so scripts
never get blocked:

| Situation | Behaviour |
|---|---|
| `--mode` (or `--standalone` / `--daemon` / `--attach`) given | used, no prompt |
| `--detach` given | implies daemon mode |
| Not a terminal, with `--exec` | defaults to **standalone** |
| Not a terminal, without `--exec` | **error**, exit 2, tells you to pass `--mode` |
| Terminal | shows the menu |
| `--ask` | shows the menu even without a terminal |

---

## Standalone mode

```bash
npm run standalone          # dry run
npm run live                # real keyboard and mouse
```

Behaves exactly like v0_01: `help`, `list`, `stop`, `status`, `exit`, plus the
subroutines. The differences are deliberate:

- **`shutdown` is available** and stops the program (same effect as `exit` here).
- **Log and task events** are rendered as they happen, as before.

The detailed command and subroutine reference is in
[`v0_01/docs/USER-GUIDE.md`](../../v0_01/docs/USER-GUIDE.md); the command set is
the same except for `shutdown`.

---

## Daemon mode

### Foreground

```bash
npm run daemon
```

Useful while developing: logs are visible, and Ctrl+C stops it gracefully.

```text
js-agent 0.2.0 · target 0.02 · daemon · pid 21284
  endpoint  pipe \\.\pipe\js-agent-87098585e7 (local)
  driver    recorder (dry run)
  waiting for clients; Ctrl+C to stop
```

### Background

```bash
npm run daemon:detach
```

```text
js-agent 0.2.0 · daemon started in the background
  pid       21284
  endpoint  pipe \\.\pipe\js-agent-87098585e7
  log       C:\Users\you\.js-agent\daemon.log
  attach    --mode attach --state-dir "C:\Users\you\.js-agent"
```

The launcher waits until the daemon actually answers, then exits. The daemon
survives the terminal.

### Driving it from other terminals

```bash
npm run attach                                  # interactive prompt
npm start -- --mode attach --exec "status"      # one command, then exit
npm start -- --mode attach --exec "list"        # what is running
npm start -- --mode attach --exec "stop"        # cancel shared work
npm start -- --stop-daemon                      # stop the service
```

Attach mode’s prompt is `js-agent (remote)> `. Commands run in the daemon, so
every attached terminal sees the same tasks and the same progress.

### The three-terminal pattern

This is the workflow daemon mode exists for:

```bash
# terminal 1: start a long run and return immediately
npm start -- --mode attach --exec "demo hello 8000" --no-wait

# terminal 2: watch it
npm start -- --mode attach --exec "list" --no-wait

# terminal 3: stop it (everyone sees the cancellation)
npm start -- --mode attach --exec "stop"
```

`--no-wait` is what makes the first two commands return while the work continues.

### State directory

Everything the daemon owns lives in one directory (default `~/.js-agent`,
overridable with `--state-dir` or `JS_AGENT_STATE_DIR`):

```
daemon.json    discovery: pid, endpoint, protocol version (removed on shutdown)
daemon.lock    single-instance claim
daemon.sock    unix socket (POSIX only; Windows uses a named pipe)
daemon.log     log file, when running detached
```

Deleting the whole directory while a daemon runs does **not** stop it. Use
`--stop-daemon`, which falls back to the lock file if the discovery file is gone.

---

## Options

```
--mode <mode>           standalone | daemon | attach
--standalone|--daemon|--attach   shorthands for --mode
--detach                daemon mode: run in the background and return
--stop-daemon           stop a running daemon, then exit
--state-dir <path>      discovery file, lock, socket and logs live here
--port <n>              loopback TCP instead of a local socket (0 = OS chooses)
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

Conflicts are rejected before anything starts (exit 2): two different modes,
`--detach` with a non-daemon mode, `--port` with `--endpoint`, `--stop-daemon`
with `--exec`.

---

## Commands

| Command | What it does |
|---|---|
| `help [topic]` | list commands and subroutines; `help <name>` for one |
| `list [--all]` | what is running now; `--all` adds finished runs |
| `stop` | cancel **every** running subroutine, for every client |
| `status` | agent, driver, host, cursor, and daemon details when attached |
| `exit` | leave this terminal. **Attached: detach; the daemon keeps running** |
| `shutdown` | stop the program — or the daemon and all its clients |

Subroutines are unchanged from v0_01: `press-key`, `type-text`, `move-mouse`,
`click-mouse`, `scroll`, `goto`, `demo`. `help <name>` shows arguments and
defaults.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | a command was rejected or a run failed; no daemon to attach to; nothing to stop |
| `2` | bad usage, conflicting flags, or no safe mode choice |

---

## Security

Read this before using `--live` with a daemon.

- **Any client that can open the socket is fully trusted.** There is no
  authentication or authorisation in this version.
- **Any client can `stop` or `shutdown`.** That is convenient and obviously
  abusable on a shared account.
- **`--live` means every attached client can drive the real keyboard and mouse.**
  Use dry run while experimenting.
- The default endpoint is a local pipe/socket; on POSIX it is `chmod 0600`.
  Loopback TCP (`--port`) is reachable by any local user and is opt-in.
- The daemon does not authenticate which terminal sent a command.

These are documented limits, not oversights; authentication and client identity
head the [roadmap](ROADMAP.md).

---

## Troubleshooting

### “No daemon is listening” when attaching

Start one first:

```bash
npm start -- --mode daemon --detach
```

Check `daemon.json` in the state directory; if it is absent, the daemon is not
running in that state directory. If you are using a custom `--state-dir`, the
client must use the same one (or the same `JS_AGENT_STATE_DIR`).

### “A daemon is already running for this state directory”

Something owns the lock. Attach to it, or stop it:

```bash
npm start -- --mode attach
npm start -- --stop-daemon
```

If you are certain nothing is running (for example after a hard reboot), the lock
is stale: starting a daemon removes it when the recorded pid is not alive.

### `--stop-daemon` says “No running daemon found” but you expect one

Either the state directory differs, or the daemon is gone. If you deleted
`daemon.json` by hand, stop still works through the lock file; if both are gone,
there is nothing running to stop.

### Tests fail immediately with a Node version message

The project requires Node 20+. `npm test` checks this first and exits 2 with an
explanation rather than letting the failure surface inside the daemon harness or
`tsx`. Switch with `nvm use 24` (or any installed 20+), then re-run.

### Named-pipe errors, or `spawn EPERM`

Some sandboxed environments forbid opening named pipes (the default endpoint) or
spawning helper processes (needed by `tsx`/esbuild). Run outside the sandbox, or
use loopback TCP for the daemon:

```bash
npm start -- --mode daemon --port 0 --state-dir ./tmp
npm start -- --mode attach --state-dir ./tmp --exec status
```

### A second daemon cannot start

That is intended. One daemon per state directory. To run an isolated one for
testing, give it a different state directory *and* let it choose its own port:

```bash
npm start -- --mode daemon --port 0 --state-dir ./tmp
```

### `--live` seems to be ignored when attaching

Correct — it is. The daemon owns the device; the client cannot choose the driver.
Nothing to fix; the note is printed when you pass it.

### `--exec` attach returns before the work finishes

By default attach `--exec` settles once at the *end* of the command list. If you
want to return immediately, add `--no-wait`. If you want to watch work started
elsewhere, use a second attach client.

### `exit` did not stop the running subroutine

In attach mode, `exit` only detaches. Use `stop` (cancels work, keeps the daemon)
or `shutdown` (stops everything).

### The daemon log is empty or missing

`--log-file` defaults to `<state-dir>/daemon.log` only for `--detach`. A
foreground daemon logs to its terminal. Set `--log-file` explicitly if you need
both.

### Stale socket on POSIX

Starting a daemon probes the socket path and removes it only if nothing answers.
If you see “already listening” but cannot attach, a process is still bound; find
it with `ps` or stop it with `--stop-daemon` (which uses the lock).

---

## Cleanup

```bash
npm start -- --stop-daemon                 # stop the service, if running
rm -rf ~/.js-agent                         # remove discovery, lock, socket, logs
```

On Windows the equivalent is `Remove-Item -Recurse -Force "$HOME\.js-agent"`.
