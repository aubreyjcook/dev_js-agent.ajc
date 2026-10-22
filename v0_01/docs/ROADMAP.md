# Roadmap — planned at `v0_01`, delivered in `v0_02`

This is the plan that was written when v0_01 was finished: what should come next,
in what order, and why. It is kept because comparing a plan with its outcome is
one of the more useful things a project can document.

**Status: every item below was delivered in v0_02.** A short retrospective at the
end records what changed between the plan and the result, including two things
the plan did not anticipate. For the actual changes, see
[`v0_02/docs/V0_02-CHANGES.md`](../../v0_02/docs/V0_02-CHANGES.md).

---

## The next requirement

> Once the agent runs in daemon mode, it must be responsive to commands across all
> terminals on that system. When the program first runs, the user decides which
> mode to run in.

That requirement drives the priorities. The key constraint is not technical but
physical: **exactly one process may own the keyboard and mouse.** "Many
terminals" must therefore mean many *clients* of one owner.

---

## P0 — the mode boundary

### 1. Extract command dispatch from the terminal

**Why.** v0_01's `TerminalSession` both interprets a command line and drives a
prompt. With two front ends (local and remote), copying that logic guarantees
drift: a fix lands in one path only.

**Sketch.** A `CommandBroker` that parses, resolves, validates and runs a line,
returns a result value, and takes an output sink. Sessions render; the broker
decides.

**Acceptance.** Both front ends obtain identical behaviour for the same line, and
a shared check suite can exercise a command without a prompt.

**Delivered.** `src/terminal/broker.ts`; local and remote sessions both call it.

### 2. Introduce an event bus

**Why.** The terminal currently installs an observer on the task registry. With N
clients, “who wants to know?” becomes a list, and events must cross a process
boundary.

**Sketch.** A minimal synchronous `EventBus`; the app publishes task transitions
and log records; the daemon broadcasts, sessions render.

**Acceptance.** Task progress and failures are visible to every attached client.

**Delivered.** `src/shared/event-bus.ts` and `RuntimeEvent` in the contract.

### 3. Define the wire protocol

**Why.** Commands and events must cross a socket that delivers bytes, not
messages, and that may connect an incompatible version.

**Sketch.** Newline-delimited JSON; a version in the handshake; ids on requests;
runtime validation of every frame; an explicit refusal message.

**Acceptance.** A malformed or mismatched peer is rejected with a clear message;
user text can never break framing.

**Delivered.** `src/contract/protocol.ts`, `src/daemon/framing.ts`.

## P1 — the daemon

### 4. Choose a transport

**Why.** The default must be safe, not convenient.

**Sketch.** Named pipe / unix domain socket by default (filesystem-scoped,
owner-only); loopback TCP opt-in for debugging and restricted environments.

**Acceptance.** Discovery works without the user knowing the endpoint; permissions
are owner-only on POSIX.

**Delivered.** `src/daemon/transport.ts`; TCP added specifically because some
sandboxes block pipes (see the retrospective).

### 5. Discovery and single instance

**Why.** A client must find a daemon it did not start; an OS-chosen port or pipe
name cannot be guessed. And two daemons must never both own the device.

**Sketch.** A validated `daemon.json` (pid, endpoint, protocol) written atomically;
an exclusive lock file; liveness by `kill(pid, 0)`.

**Acceptance.** A second daemon refuses and leaves the first running; a stale
record is ignored; a stale lock is replaced.

**Delivered.** `src/daemon/discovery.ts`, `src/daemon/lock.ts`.

### 6. Mode selection at startup

**Why.** The requirement says the user decides. A prompt that appears in scripts
would break automation, so the rules matter as much as the prompt.

**Sketch.** Explicit flag wins; non-interactive `--exec` defaults to standalone;
non-interactive without a mode is an error; only a TTY gets the menu.

**Acceptance.** The menu is shown on first interactive run, and no script is ever
blocked by it.

**Delivered.** `src/cli/mode.ts`, plus `--ask` for testability.

### 7. Lifecycle: detach, stop, clean up

**Why.** A service that cannot be stopped reliably is worse than no service.

**Sketch.** `--detach` spawns a detached child and waits for discovery;
`--stop-daemon` asks politely over the protocol, then falls back to a signal;
record and lock removed on the way out.

**Acceptance.** Detached daemon survives its launcher; shutdown removes its files;
an orphan remains stoppable.

**Delivered.** `src/daemon/lifecycle.ts`.

## P2 — semantics and safety

### 8. Separate “leave” from “stop”

**Why.** With shared work, `exit` in one terminal must not kill another's run.

**Sketch.** `exit` ends the session (detach when attached); `shutdown` stops the
daemon. Ctrl+C in a client detaches.

**Delivered.** `CommandOutcome` includes both; documented in the user guide.

### 9. Make waits explicit

**Why.** Only the daemon owns the work, so only the daemon can say it is idle.

**Sketch.** A `wait` protocol message; attach `--exec` settles once at the end;
`--no-wait` for fire-and-forget.

**Delivered.** `wait` in the protocol; `--no-wait` flag.

---

## Explicitly not in v0_02

- Authentication and per-client permissions.
- Client identity in the UI (which terminal started a run).
- Clipboard-based support for non-ASCII text.
- Compiled distribution (the program still runs through `tsx`).
- Cross-platform CI.

These were carried into the v0_02 roadmap rather than silently dropped.

---

## Retrospective: plan versus outcome

**On plan.** The P0/P1 structure held: extracting the broker first made the daemon
a transport problem rather than a rewrite. The agent and the subroutines were not
touched, which was the point of v0_01's boundary.

**Not anticipated, and worth recording:**

1. **A single-instance bug.** The plan said “only one daemon may bind the
   endpoint”. With an OS-chosen port that is false: two daemons can bind different
   ports, and the second overwrote discovery, orphaning the first. The fix was an
   explicit lock claimed before the input device opens. Uniqueness is a property
   of *state*, not of a socket.

2. **An orphan whose record was deleted became unstoppable.** Found while
   cleaning up after development. `--stop-daemon` now falls back to the lock
   file's pid. Guaranteed stop and graceful stop are different requirements.

**Also worth noting:** the plan assumed named pipes everywhere; a restricted
sandbox blocks them, so TCP had to be a first-class option rather than an
afterthought. That is why the test suite runs over TCP while production defaults
to the pipe.

The forward-looking roadmap, written when v0_02 was finished, is
[`v0_02/docs/ROADMAP.md`](../../v0_02/docs/ROADMAP.md).
