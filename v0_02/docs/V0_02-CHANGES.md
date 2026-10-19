# v0_01 → v0_02: what changed, and why

This is the learning document for v0_02. It assumes you have read or skimmed the
v0_01 guide ([`LEARNING-GUIDE.md`](LEARNING-GUIDE.md)) — the agent core, the
subroutines, the contract and cancellation are barely touched, and that guide
still describes them accurately.

What changed is the *shape of the program around them*.

> **The short version.** In v0_01, one process did everything: it owned the
> keyboard and mouse, and it read the terminal. In v0_02, the process that owns
> the hardware can be a **daemon**, and *other processes* become clients that
> send it commands over a local socket. The bit that decides what a command
> means was extracted into a `CommandBroker` so that both kinds of front end
> share it. The agent and subroutines did not change.

Read this in order. Each section states the problem, the design, the code, and
the mistake that design avoids.

---

## 1. The requirement, and why it is not a small feature

The new requirement was:

> Once the agent runs in daemon mode, it is responsive to commands across all
> terminals on that system. When the program first runs, the user decides which
> mode to run in.

Break that into the constraints it creates, because they are what drive every
decision below.

**One process must own the keyboard and mouse.** This is not a design
preference; it is physics. Two processes injecting input simultaneously produce
interleaved keystrokes and a cursor that fights itself. So "many terminals" must
mean *many clients of one owner*, never many owners.

**Commands arrive from outside the owning process.** In v0_01, a command line was
a string read from stdin and interpreted immediately. Now the string has to
travel from a client process to the daemon process. That is a network boundary —
even though the "network" is a named pipe on the same machine — and boundaries
change what you can assume:

- bytes arrive in pieces, not as messages
- the peer may be an older version, or not this program at all
- the peer may disconnect halfway through
- two peers may be talking at once

**The user must choose a mode.** That makes startup a conversation, which means
the program needs a decision point *before* it builds anything. In v0_01,
startup was: parse args → build app → prompt. v0_02 is: parse args → decide mode
→ build app → hand it to the right front end.

**The existing behaviour must survive.** A standalone v0_02 run should behave
like v0_01. That is a testing constraint, and it is why the new suite re-runs the
old cases unchanged.

### The shape before and after

```
v0_01                                    v0_02
─────                                    ─────

  process                                  process A (daemon)
  ┌──────────────────────┐                 ┌─────────────────────────────┐
  │ TerminalSession      │                 │ DaemonServer                │
  │   reads stdin        │                 │   CommandBroker ◄── socket  │
  │   dispatches ────────┼──┐              │   Agent + subroutines       │
  │   Agent + subroutines│  │              │   EventBus ── broadcasts    │
  └──────────────────────┘  │              └──────────▲──────────────────┘
                            │                         │ local socket
                ┌───────────┴─────────┐               │
                │ TaskRegistry        │      ┌────────┴────────┐
                │ (observer installed │      │ client B        │
                │  by the terminal)   │      │ RemoteSession   │
                └─────────────────────┘      └─────────────────┘
                                             ┌─────────────────┐
                                             │ client C        │
                                             │ LocalSession    │  ← standalone mode
                                             └─────────────────┘
```

The important line in that diagram is `CommandBroker`. It exists once, in the
daemon, and both front ends reach it — the local one in-process, the remote one
over the socket. **The meaning of a command is defined once.**

---

## 2. Change 1: extracting the `CommandBroker`

### The problem

`v0_01`'s `TerminalSession` did two jobs at once:

```ts
// v0_01, src/terminal/session.ts (simplified)
async dispatch(line) {
  const { name, args } = parseCommandLine(line);
  const command = findCommand(name);
  if (command !== undefined) { await command.run(this.#context(), args); ... }
  const prepared = this.#runtime.subroutines.prepareRun(name, args);
  void this.#runtime.subroutines.start(prepared.run);
}
```

Then `runInteractive` and `runOnce` rendered output, managed the prompt, and
handled shutdown around it.

With one front end, that is fine. With two, you have two options:

1. Copy `dispatch` into the remote front end. They drift within a month: a fix
   to "unknown command" lands in one, and the daemon starts behaving differently
   from standalone mode. This is the classic fate of duplicated dispatch logic.
2. Move the decision into one object that both call.

v0_02 does (2). The new file is
[`src/terminal/broker.ts`](../src/terminal/broker.ts), and the class is
`CommandBroker` ([line 64](../src/terminal/broker.ts#L64)).

### The design

The broker knows how to turn a line into work. It does **not** know:

| Question | Answer |
|---|---|
| Where did the line come from? | It is given a string. |
| Where should output go? | It is given a sink: `(line: string) => void`. |
| Should `exit` stop the program? | It reports `status: 'exit'` and lets the front end decide. |
| Is there a daemon? | Only if told, so `status` can print daemon details. |

That table is the whole design. Everything the broker does not know is something
it cannot get wrong.

```ts
export class CommandBroker {
  execute(line: string, sink: OutputSink): Promise<CommandResult> {
    return this.#queue.run(() => this.#execute(line, sink));
  }
```

`CommandResult` is a value, not an exception:

```ts
export interface CommandResult {
  status: 'ok' | 'empty' | 'exit' | 'error' | 'shutdown';
  message?: string;
}
```

**Why a result type instead of `throw`?** Because the caller may be on the other
side of a socket. An exception cannot be sent over a socket; a value can. This
is the same reasoning that produced `PrepareRunResult` in v0_01 (see §14 of the
guide), now applied at a second boundary.

**Why does `execute` take a sink?** Because output must reach *whoever asked*.
In the daemon, the sink writes an `output` message to that client's socket. In a
local session, it writes to stdout. The commands (`help`, `list`, `status`) were
written against `context.write(line)` in v0_01 and did not have to change at
all — which is a sign the original seam was in the right place.

### The concurrency problem nobody has in one process

With one terminal, commands arrive one at a time: a person types, waits, types.
With three attached clients, two commands can arrive in the same millisecond.

Some interleavings are harmless. `status` and `list` reading state at the same
time is fine. Others are not: a `stop` landing in the middle of a `list` can
produce output from one command inside another, and a command that reads state
while another is changing it sees a half-applied world.

The fix is a one-at-a-time queue around the *decision* — not around the work:

```ts
// src/shared/async-queue.ts
export class AsyncQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(job: Job<T>): Promise<T> {
    const result = this.#tail.then(async () => job());
    // Keep the chain alive on failure, so one bad command cannot wedge the queue.
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
```

Three details worth learning here:

- **Chain on a promise, not on a boolean.** A boolean "busy" flag needs careful
  resetting on every path; a promise chain continues by construction.
- **Rejections must not break the chain.** `this.#tail = result.catch(...)`
  absorbs the failure for *sequencing purposes only*. The original `result` is
  still returned to the caller, so it still sees the error.
- **Scope matters.** The queue covers command evaluation, which lasts
  milliseconds. A subroutine started by a command runs outside the queue, so
  `stop` from another client can still interrupt it. Queueing the *work* instead
  of the *decision* would have made the daemon single-tasking, which is exactly
  what daemon mode is for.

### What the extraction bought

`LocalSession` and `RemoteSession` are now mostly rendering and lifecycle. The
local one is ~350 lines, and none of it decides what `list` means.

The move also produced a bug worth remembering: **responsibility moved, but its
side effect did not.** v0_01's `dispatch` printed error messages itself. The
broker returns them as data. The remote session printed `result.message`; the
local session forgot to, so `press-key` with a missing argument exited 1 with no
explanation. Three standalone tests caught it immediately (§9). When you move
responsibility, move or re-test its side effects explicitly.

---

## 3. Change 2: from one observer to an event bus

### The problem

In v0_01 the terminal reached into the task registry and installed a callback:

```ts
// v0_01
this.#runtime.tasks.observe((snapshot) => { ...render... });
```

That works when there is exactly one interested party, in the same process. Now
progress must be rendered by:

- the local prompt (standalone)
- every attached client (daemon)

and in daemon mode it must cross a socket.

### The design

Two new pieces, both small:

1. [`EventBus`](../src/shared/event-bus.ts) — subscribe/publish, synchronous,
   isolated listeners.
2. A `RuntimeEvent` union in the contract, which is what actually travels.

```ts
export type RuntimeEvent =
  | { kind: 'log'; record: LogEventRecord }
  | { kind: 'task'; task: TaskSnapshot }
  | { kind: 'stopping'; reason: string };
```

The app wires the sources once:

```ts
// src/app.ts
tasks.observe((task) => bus.publish({ kind: 'task', task }));

// and the logger publishes records as they are emitted
ConsoleLogger.create({
  onRecord: (record) => bus.publish({ kind: 'log', record: { ...} }),
});
```

Note what did **not** change: `TaskRegistry` still has `observe`. It remains the
registry's own concern; the bus is a *consumer* of it. If the registry knew about
buses, the core would have grown a dependency on the application's plumbing.

### Who renders what, and why it differs

This is subtle enough that the code comments it in both places.

- **Local session:** renders `task` events, ignores `log` events.
  Reason: the console logger already writes log lines in this process. Rendering
  them again would double every line.
- **Remote session:** renders both.
  Reason: a client has no console in the daemon's process. Forwarding records is
  the only way it can see failures and lifecycle messages.

That asymmetry is not a wart; it is the consequence of *where the logger lives*.
A useful question to ask of any event system: "who already knows this?"

### Filtering before the wire

The daemon broadcasts events; it does not broadcast *input* task events to
clients, because the clients filter them:

```ts
// remote-session.ts
case 'task':
  if (event.task.kind === 'subroutine') { render(...); }
  return;
```

Input tasks are tracked for `stop` and counters, but one line per keystroke would
drown a terminal. Subroutine tasks are the interesting unit.

---

## 4. Change 3: the wire protocol

### The problem

We need to send commands and receive results and events across a socket. That
requires defining a format, a framing rule, and a versioning rule. It is easy to
underestimate how much correctness lives in those three things.

### Framing: newline-delimited JSON

[`src/daemon/framing.ts`](../src/daemon/framing.ts#L42) implements
`JsonLineChannel`. One JSON object per line.

Why NDJSON rather than a length-prefixed binary protocol, or HTTP, or JSON-RPC?

- **Inspectable.** You can connect with `nc` and type a command. During
  development that is worth a lot.
- **Safe against user text.** `JSON.stringify` escapes newlines inside strings,
  so `type-text "a\nb"` cannot break framing. A protocol that framed on a
  character that can appear in payload would be exploitable.
- **No length bookkeeping.** The alternative is a 4-byte header, which is fine
  but is more code to get wrong and impossible to debug by eye.

What it gives up: slightly more bandwidth. For local IPC, irrelevant.

Two implementation details that are commonly missed:

```ts
readonly #decoder = new StringDecoder('utf8');
// ...
this.#buffer += this.#decoder.write(chunk);
```

`StringDecoder` holds an incomplete multi-byte character across chunk
boundaries. `chunk.toString()` would corrupt `é` split between two reads. The
sandbox forbids named pipes here, but that is an environment quirk; the framing
must still be correct for arbitrary bytes.

```ts
if (Buffer.byteLength(this.#buffer, 'utf8') > MAX_MESSAGE_BYTES) {
  this.#finish('message too large');
}
```

A peer that sends bytes forever without a newline would otherwise make the daemon
buffer until it dies. That is a denial of service in one line of missing code.

### Versioning: the handshake

```ts
export const PROTOCOL_VERSION = 1;
```

The daemon speaks first:

```ts
// ClientSession.begin(), server side
this.#send({ kind: 'welcome', protocol: PROTOCOL_VERSION, daemon: ... });
```

The client validates before it commits:

```ts
// client.ts
if (message.protocol !== PROTOCOL_VERSION) {
  rejectReady(new Error(
    `Protocol mismatch: daemon speaks v${message.protocol}, ` +
    `this client speaks v${PROTOCOL_VERSION}. ...`));
  channel.close();
  return;
}
```

And the daemon validates the client's answer:

```ts
// server.ts
if (message.protocol !== PROTOCOL_VERSION) {
  this.#sendProblem(`Protocol mismatch: ...`);
  return;
}
```

**Why server-speaks-first?** So the client learns the version before sending
anything. The alternative — client speaks first — means a v2 client talking to a
v1 daemon has already sent a message the daemon may misread.

**Why repeat the version in the discovery file?** Because a stale file is a real
failure mode: the daemon died, `daemon.json` survived, and a new client would
otherwise trust it. Two checks catch two different mistakes.

### Request identity

Every command carries an `id`:

```ts
| { kind: 'command'; id: number; line: string }
```

The server replies with `output` lines and a final `result`, both carrying the
same `id`. Today the broker serialises commands, so ordering alone would work.
Ids are there because **"it works today" is not a protocol design.** The moment
anything becomes concurrent, ordered replies stop being true, and a client that
matched by position would resolve the wrong promise.

### Runtime validation at the boundary

This is the most important lesson in this section. The protocol types are claims
about data produced by *this* program. Bytes from a socket were produced by some
other process. Casting them is a lie:

```ts
// do not do this
const message = JSON.parse(line) as ClientMessage;
```

The daemon would then crash somewhere unrelated when `message.line` turned out to
be `undefined`. Instead, the boundary parses and narrows:

```ts
export function isClientMessage(value: unknown): value is ClientMessage {
  const record = asRecord(value);
  if (record === undefined) return false;
  switch (record['kind']) {
    case 'hello':
      return typeof record['protocol'] === 'number' && typeof record['clientName'] === 'string';
    case 'command':
      return typeof record['id'] === 'number' && typeof record['line'] === 'string';
    // ...
  }
}
```

`asRecord` returns `Record<string, unknown> | undefined`, which is how you ask
questions about `unknown` without asserting answers. The channel calls the guard
and rejects unrecognised input:

```ts
decode: (value) => (isClientMessage(value) ? value : undefined),
```

`noUncheckedIndexedAccess` is what makes `record['kind']` a union rather than
`any`, and it is why this validation is pleasant to write rather than a fight.

### The message set, and the one that is not obvious

| Direction | Message | Purpose |
|---|---|---|
| server → client | `welcome` | protocol version, daemon identity |
| client → server | `hello` | protocol version, client name |
| client → server | `command` | a command line, with an id |
| client → server | `wait` | "tell me when nothing is running" |
| client → server | `ping` | liveness |
| server → client | `output` | one line of a command's output |
| server → client | `result` | the command finished |
| server → client | `event` | task progress or a log record |
| server → client | `pong` | liveness reply |
| server → client | `problem` | protocol-level refusal; the connection closes |

`wait` deserves explanation because it is a protocol feature born from a
distributed test failure.

In standalone `--exec`, the local session can wait for its own tasks to become
idle. In attach mode, the work belongs to the daemon; the client cannot inspect
the daemon's task registry. Without a `wait` message, `--attach --exec "demo …"`
would either return immediately (work still running) or have to poll `list`,
which is slower and racy.

So the daemon implements the barrier on behalf of the client:

```ts
if (message.kind === 'wait') {
  const report = await this.#options.broker.drainReport(this.#failureSince);
  this.#send({ kind: 'result', id: message.id, status: report.result.status, ... });
}
```

**The general lesson:** when a capability lives behind a boundary, the boundary
must expose the capability — not the state required to infer it.

---

## 5. Change 4: choosing a transport

### The two options

[`Endpoint`](../src/contract/transport.ts) has exactly two variants:

```ts
export type Endpoint =
  | { kind: 'local'; path: string }
  | { kind: 'tcp'; host: string; port: number };
```

`local` is a named pipe on Windows (`\\.\pipe\js-agent-…`) and a unix domain
socket on POSIX (`~/.js-agent/daemon.sock`). Node's `net` module treats both as
"a path to listen on", which is why one variant covers them.

`tcp` is loopback-only and opt-in (`--port`).

### Why the default is the local socket

| Property | local pipe/socket | loopback TCP |
|---|---|---|
| Who can connect | OS permissions; we `chmod 0600` on POSIX | any process of any local user |
| Name collision | namespaced by path, scoped by state dir | port numbers, shared machine-wide |
| Firewall prompts | none | possible |
| Debuggable with `nc` | awkward | trivial |
| Sandbox friendliness | blocked in some environments | works |

The default is the local socket because **the default should be the safe one**.
TCP is available for the cases where it earns its risk: debugging, restricted
environments, and tests (this repository's sandbox blocks named pipes, so the
suite runs with `--port 0`).

Note `--port 0`: the OS chooses. That would be unusable without discovery (§6),
because the client could not know the port. So the choice of transport created a
requirement for a discovery file — a nice example of decisions rippling.

### The code that matters is the failure path

[`src/daemon/transport.ts`](../src/daemon/transport.ts) looks routine until you
read the stale-socket handling:

```ts
async function clearStaleSocket(path: string): Promise<void> {
  if (process.platform === 'win32') return; // named pipes are not files
  if (!(await pathExists(path))) return;
  if (await isListening(path)) {
    throw new Error(`A daemon is already listening at pipe "${path}". ...`);
  }
  try { await unlink(path); } catch { /* race */ }
}
```

My first version of this unconditionally unlinked the path. That is a serious
bug, and it is worth spelling out: **unlinking a live unix socket does not stop
the daemon, but it makes it unreachable forever.** The daemon keeps running,
holding an inode nobody can address. The probe-then-delete order is the fix.

The general shape: destructive cleanup must be guarded by a check that the thing
is genuinely dead, and the check must be as close to the destruction as
possible.

Other failure paths handled there:

- **`EADDRINUSE`** → "something is already listening; attach or stop it" rather
  than a raw error.
- **connect timeout** → a CLI that says "no daemon is listening" instead of
  hanging silently.
- **socket permissions** → `chmod 0o600` on POSIX so another account cannot
  drive the agent.

---

## 6. Change 5: discovery and lifecycle

### Discovery: one file answers three questions

A client cannot be told the port of a daemon that chose its own port. So the
daemon publishes a record in its state directory:

```json
{
  "protocol": 1,
  "pid": 21284,
  "endpoint": { "kind": "tcp", "host": "127.0.0.1", "port": 61195 },
  "startedAt": "2026-10-19T00:57:32.746Z",
  "version": "0.2.0",
  "live": false
}
```

`~/.js-agent/daemon.json` answers:

1. **Where is it?** `endpoint`
2. **Is it alive?** `pid`, checked with `process.kill(pid, 0)` — which sends no
   signal, only asks "may I signal this process?"
3. **Can I speak to it?** `protocol`, checked against the handshake

Two details that are easy to skip and expensive to skip:

- **Atomic writes.** `writeFile` to a temporary path, then `rename`. A client
  must never read a half-written JSON file. `rename` is atomic on POSIX and
  Windows for this purpose.
- **Treat the file as untrusted.** It can be stale, hand-edited, or from another
  version. `parseRecord` validates every field and returns `null` on nonsense —
  same principle as the wire guards.

### The single-instance bug

This one is the best story in v0_02, because the first implementation *looked*
correct and failed in a way I did not predict.

**What happened.** I started a daemon with `--port 0`. I started a second with
the same state directory and `--port 0`. It succeeded. The OS gave it a different
free port, so there was no bind conflict — and then it overwrote `daemon.json`,
orphaning the first daemon and redirecting every future client to the newcomer.

Two daemons were running. One was invisible. Both owned simulated input.

**Why the obvious check was insufficient.** My mental model was "only one process
can bind the endpoint". That is true for a fixed port and false for an ephemeral
one. And a pipe name is not a lock either, because the race is not at bind time:
a second daemon can start while the first is still initialising, before it has
published anything.

**The fix: make the claim explicit.**

[`src/daemon/lock.ts`](../src/daemon/lock.ts#L46) uses an exclusive file create:

```ts
const handle = await open(path, 'wx');   // fails if it exists
```

`'wx'` is atomic on every platform here. If it exists, read the pid: if alive,
refuse with a clear message; if dead, it is debris, remove it and retry once.

**And a second fix, about ordering.** My first version checked for an existing
daemon *inside* `DaemonServer.start()`, which runs after `createApp()` — i.e.
after the input device had been opened. In live mode that means a second daemon
briefly opens the real keyboard and mouse before saying "no". Startup now claims
the lock in `index.ts` before building the runtime:

```ts
// index.ts, runDaemon()
const existing = await findDaemon(stateDir);
if (existing !== null && existing.reachable) throw new Error(/* already running */);
lock = await acquireDaemonLock(stateDir);
const app = await createApp({ ... });
server = new DaemonServer({ ..., lock, ... });
```

**Lessons:**

- "Only one may run" is a property of **state**, not of a socket. Express it
  where the state lives.
- Order startup so that the cheapest, most decisive refusal happens before any
  expensive or dangerous resource is acquired.
- A test that starts one daemon and talks to it would never have found this. The
  test that found it started a *second* one and checked the first still worked.

### Detaching

[`spawnDetachedDaemon`](../src/daemon/lifecycle.ts#L47):

```ts
const child = spawn(process.execPath, childArgs, {
  cwd: dirname(dirname(entry)),
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  env: { ...process.env, JS_AGENT_STATE_DIR: stateDir },
});
child.unref();
```

Points that matter:

- **`stdio: 'ignore'`** because the parent exits. A child writing to a closed
  pipe gets `EPIPE` and dies. Detached daemons log to a file instead
  (`--log-file`, defaulting to `stateDir/daemon.log`).
- **`detached: true` + `unref()`** so the child survives the parent and does not
  keep the parent alive.
- **`cwd` set to the package root** so `--import tsx` resolves. Under tsx the
  entry is a `.ts` file, which plain `node` cannot execute; the child is spawned
  as `node --import tsx <entry> …`.
- **Readiness by polling the shared state.** The parent deliberately has no pipe
  to the child, so it cannot ask "are you ready?". It waits for
  `daemon.json` to describe a reachable endpoint — the same mechanism any other
  client uses. One discovery path, not two.

### Stopping

`stopDaemon` prefers the protocol:

```ts
const client = await DaemonClient.connect({ ... });
await client.run('shutdown');
```

Why not just `kill`? Because the daemon needs to unwind: cancel runs, release
the device, remove the record and lock. A signal only reaches the process, not
its work. The signal path remains as a fallback for a wedged daemon, and the
lock's staleness check cleans up after it.

### Two sources of truth, on purpose

The daemon is located by `daemon.json` **or**, failing that, by its lock file:

```ts
const record = await readRecord(stateDir);
const lockPid = await readLockPid(stateDir);
const pid = record?.pid ?? lockPid ?? null;
```

This looked like belt-and-braces until it was needed. While developing v0_02 I
deleted a state directory while a daemon was still running; the record was gone,
the daemon was not, and `--stop-daemon` said "No running daemon found" about a
process that was still holding the keyboard. A daemon that cannot be found is
also a daemon that cannot be stopped, and in live mode that is not an acceptable
state.

So `--stop-daemon` falls back to the lock's pid and sends `SIGTERM` when there is
no endpoint left to talk to. Graceful shutdown and guaranteed shutdown are
different requirements, and a service needs both. The suite covers it: delete
`daemon.json` while a daemon runs, then stop it and assert the process exited.

---

## 7. Change 6: choosing a mode

The requirement — *the user decides when the program first runs* — makes startup
a conversation. But a prompt is a liability: it must never appear when nobody can
answer it. The rules in [`src/cli/mode.ts`](../src/cli/mode.ts#L56):

1. An explicit mode always wins. No prompt.
2. Non-interactive with `--exec` defaults to **standalone**: a script asked for
   commands, not for a service.
3. Non-interactive without `--exec` and without a mode is an **error**. Guessing
   here would mean a cron job silently starting a daemon.
4. Only a real terminal gets the menu.

The menu reflects reality:

```text
  How should js-agent run?

    1) standalone  this terminal owns the keyboard and mouse (default)
    2) attach      send commands to the running daemon (pid 4021) on tcp port 61195

  A daemon is already running; use --stop-daemon to stop it first.
```

If a daemon is running, "attach" replaces "daemon", because starting a second one
would fail — the menu should not offer an option it knows is broken.

### The flag parser got harder

v0_01 parsed eight flags. v0_02 adds seven, and more importantly adds *conflicts*:

- `--mode daemon --mode attach` → two different modes
- `--detach` with `--mode attach` → only meaningful for a daemon
- `--port` and `--endpoint` → two ways to say where to listen
- `--stop-daemon --exec` → contradictory jobs

All are rejected before anything starts, with exit code 2. A CLI that silently
prefers one flag over another is one whose users cannot predict it.

An implementation detail: mode flags are exempt from the "given more than once"
check, so `--mode daemon --daemon` is idempotent rather than an error, while two
*different* modes report a conflict. Both are better messages than "given twice".

### `--ask`, a testability lesson

The chooser only runs on a real TTY. The automated suite has no PTY, so the
primary UX path was untestable — and untestable code is where bugs live.

The fix was not to weaken the TTY rule; it was to add an explicit override:

```ts
interactive: isInteractive() || config.ask
```

`--ask` means "ask me even though stdin is not a terminal". It is useful beyond
testing (piping an answer in), and it makes the requirement verifiable: the suite
now feeds `2\n` to the menu and asserts that a daemon actually starts.

**Lesson:** when a guard makes something unreachable in tests, add a deliberate
override rather than removing the guard. The guard exists for a good reason; the
override makes the reason explicit.

---

## 8. Behaviour that changed, and behaviour that must not

This is the section to read if you are writing scripts against the program.

| Situation | v0_01 | v0_02 standalone | v0_02 attached |
|---|---|---|---|
| `exit` | stop work, close program | stop work, close program | **detach only**; daemon keeps running |
| `shutdown` | — | stops the program | **stops the daemon** and disconnects everyone |
| Ctrl+C | stop work, exit | stop work, exit | **detach only** |
| `stop` | cancel all runs | cancel all runs | cancel all runs, **visible to every client** |
| log lines | printed by the local logger | printed by the local logger | forwarded over the wire |
| `--exec` between commands | settle before the next | settle before the next | no per-command settle |
| `--exec` at the end | report failed runs | report failed runs | wait for daemon idle, report failures; `--no-wait` skips |

### Why `exit` and `shutdown` had to split

In v0_01 one command could mean both things because there was only one scope.
With several terminals, `exit` has an obvious local meaning — "I am done with
this terminal" — and killing shared work on the way out would be a hostile
surprise. `shutdown` is the explicit request to stop the service.

The same reasoning applies to Ctrl+C. In a client it must not reach across
processes and cancel another client's run. The user has `stop` for that, and
`stop` is intentionally global and visible.

### Why attach `--exec` does not settle between commands

Standalone owns its work, so "do A, then B" means "wait for A". A client does
not own the work; it cannot distinguish "A finished starting a run" from "A's run
finished". Waiting after every command would also make
`--attach --exec "start something" --exec "list"` impossible to use for
observation.

So attach mode settles **once at the end**, and `--no-wait` skips even that.
That is what makes this possible:

```bash
# terminal 1: start a long run and return immediately
js-agent --mode attach --exec "demo hello 8000" --no-wait

# terminal 2: watch it
js-agent --mode attach --exec "list" --no-wait

# terminal 3: stop it
js-agent --mode attach --exec "stop"
```

This is the behaviour the daemon requirement is really about, and it is worth
exercising by hand once.

### What did not change

- `src/core/` — agent, both input drivers, keymap, task registry. **No changes.**
- `src/subroutines/` — registry and every built-in. **No changes.**
- The contract's existing files — `input`, `signals`, `tasks`, `subroutine`,
  `agent-api`, `logger`, `point`. Only *new* files were added.
- The v0_01 standalone test cases, which run unchanged against v0_02.

That is the architecture paying its debt. If adding a daemon had required
touching the input driver or the subroutines, the v0_01 split would have been
wrong.

---

## 9. New files, and what each is for

```
v0_02/src/
  contract/
    commands.ts      CommandOutcome / CommandResult — the shape of "what happened"
    events.ts        RuntimeEvent — what the runtime publishes
    protocol.ts      ClientMessage / ServerMessage / guards / PROTOCOL_VERSION
    transport.ts     Endpoint and MessageChannel<In, Out>
  daemon/
    endpoint.ts      state dir and endpoint derivation (hash of state dir)
    framing.ts       NDJSON channel: buffering, UTF-8, size ceiling
    transport.ts     listen/connect, stale socket handling, permissions
    discovery.ts     daemon.json read/write/validate, pid liveness, waitForDaemon
    lock.ts          single-instance claim ('wx')
    server.ts        DaemonServer + ClientSession (handshake, commands, broadcast)
    client.ts        DaemonClient (handshake, requests, events)
    lifecycle.ts     detached spawn, stopDaemon
    index.ts         barrel
  shared/
    event-bus.ts     subscribe/publish
    async-queue.ts   one-at-a-time command evaluation
  terminal/
    broker.ts        CommandBroker — the extracted decision layer
    render.ts        shared formatting for both front ends
    local-session.ts the v0_01 prompt, now using the broker
    remote-session.ts the attached prompt
  cli/
    mode.ts          the chooser, and its rules
```

Changed files: `app.ts` (builds the runtime and bus, no session), `index.ts`
(three modes), `cli/config.ts` (new flags and conflicts),
`logging/console-logger.ts` (an `onRecord` hook), `terminal/banner.ts` (mode line
and an attach banner), `terminal/commands.ts` (`shutdown`, daemon line in
`status`, shared render helpers).

---

## 10. TypeScript and Node gained in v0_02

The v0_01 feature table still applies. These are the additions.

### Generics for a channel in two directions

```ts
export interface MessageChannel<Incoming, Outgoing> {
  send(message: Outgoing): void;
  onMessage(handler: (message: Incoming) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(): void;
}
```

The server side is `MessageChannel<ClientMessage, ServerMessage>`; the client
side is the reverse. Writing framing once, generically, means the buffering logic
is not duplicated — and the compiler prevents sending a server message to a
server.

### Type predicates, again, at the boundary

```ts
export function isServerMessage(value: unknown): value is ServerMessage
```

A predicate is what makes validation ergonomic: after `if (!isServerMessage(x)) return;`,
`x` is a `ServerMessage` everywhere below. See §4.

### Promise chains as a queue

`AsyncQueue` is a promise-chain mutex (§2). The pattern generalises: any time you
need "one at a time", a `tail` promise and `.then` is usually enough.

### A deferred promise for "it has stopped"

```ts
readonly #stopped: Promise<void>;
#resolveStopped: () => void = () => {};

constructor() {
  this.#stopped = new Promise<void>((resolve) => {
    this.#resolveStopped = resolve;
  });
}
```

This is the **deferred** pattern: create the promise now, resolve it later from
somewhere else. It is how the launcher awaits a daemon whose stop can be
requested by a client, a signal, or an error. Using an EventEmitter would work,
but a promise composes with `await` and cannot be missed by subscribing late.

### Capturing a value that is assigned later

```ts
let server: DaemonServer | undefined;
const app = await createApp({
  daemonStatus: () => server?.summary(),
  ...
});
server = new DaemonServer({ ... });
```

The closure reads `server` when `status` is called, not when the closure is
created. This breaks what would otherwise be a circular construction: the broker
needs to report the daemon, and the daemon is built from the broker.

### Node APIs

| API | Where | Why it matters |
|---|---|---|
| `node:net` `createServer`/`connect` | transport | one abstraction covers pipes and unix sockets |
| `node:string_decoder` | framing | correct UTF-8 across chunk boundaries |
| `spawn(..., { detached: true })` + `unref()` | lifecycle | a service that outlives its launcher |
| `node:fs/promises` `open(path, 'wx')` | lock | atomic single-instance claim |
| `node:fs/promises` `rename` | discovery | atomic file replacement |
| `process.kill(pid, 0)` | discovery | liveness without signalling |
| `mkdtempSync` | tests | isolated state directory per test |

### Error types for expected refusals

```ts
export class ModeChoiceError extends Error {}
export class CliError extends Error {}
```

Both are caught in `index.ts` and turned into a message plus exit code 2; anything
else is rethrown with a stack trace. **Expected** failures deserve a name;
**unexpected** ones deserve a stack.

---

## 11. Bugs found while building v0_02

Every one of these was found by running the thing, not by reading it. They are
listed in the order they were found, because the order is the lesson.

### 1. A second daemon on an ephemeral port (§6)

Symptom: two daemons, one discovery file, an orphan that kept running.
Cause: "unique endpoint" is not "single instance".
Fix: explicit lock, claimed before the runtime is built.
Test added: start a second daemon, assert it refuses **and** that the first still
answers. The second assertion is the important one — a refusal that breaks the
incumbent is worse than no refusal.

### 2. Unconditional stale-socket deletion

Caught while writing the cleanup, before it ran: unlinking a live socket file
makes a running daemon unreachable. Fix: probe first, delete only if nothing
answers.
Lesson: destructive cleanup needs an immediately-preceding liveness check.

### 3. Errors became invisible after the broker extraction

Symptom: three standalone tests failed; `press-key` with no argument exited 1
and printed nothing.
Cause: the broker returns errors as data; the remote session printed them, the
local session did not.
Fix: `local-session.ts` prints `result.message` on `status === 'error'`.
Lesson: when responsibility moves, move its side effects, and test them.

### 4. A refusal that arrived after the hardware was opened

Symptom: the second daemon logged "input ready" before refusing.
Cause: the single-instance check lived in `DaemonServer.start()`, after
`createApp()`.
Fix: claim the lock in `index.ts` before `createApp()`.
Lesson: order startup so refusals are cheap and early.

### 5. The primary UX was untestable

Symptom: the mode menu never appeared in tests; only the "no mode" error path was
exercised.
Cause: the chooser is gated on a TTY.
Fix: `--ask` override, plus two end-to-end cases that answer the menu.
Lesson: a guard that makes code unreachable in tests is a warning sign, not a
reason to skip the test.

### 6. `--exec` waited for global idle after every attach command

Symptom: observing work started by another client was impossible; `list` blocked
until the run finished.
Cause: standalone semantics copied into a context where the client does not own
the work.
Fix: settle once at the end in attach mode, and add `--no-wait`.
Lesson: copy behaviour only after checking whose ownership it assumed.

### 7. An orphan with no discovery file was unstoppable

Symptom: during cleanup, `--stop-daemon` reported "No running daemon found" while
a daemon was still running and still held the input device.
Cause: the record was the only source of truth for "which process is the daemon".
Fix: fall back to the lock file's pid, and `SIGTERM` when there is no endpoint
left to speak to (§6).
Lesson: services need *guaranteed* stop, not only *graceful* stop. Ask "what if
the bookkeeping is missing?" of every cleanup path.

### The one that did not bite, but was designed out

`linkSignals` in v0_01 registered a listener per input on the program-wide token.
The `dispose()` call in `finally` prevents an unbounded listener set. In daemon
mode, an input stream is longer-lived, so that fix matters more here than it did
there.

---

## 12. Testing a program with more than one process

The v0_01 suite ran one process per case. v0_02 needs more:

**A daemon fixture.** `startDaemon()` spawns a real daemon on a private
`mkdtemp` state directory, polls `daemon.json` and probes the port, and returns a
handle. Every case then runs as a *separate client process*.

**Why separate processes, not in-process clients?** Because the requirement is
about terminals. A test that constructs a `DaemonClient` in the same process
would not prove that discovery works, that the lock works, or that state is
actually shared across process boundaries. The suite spawns the CLI, which does
the full path: parse flags → discover → connect → handshake → command.

**A raw-socket test.** One case speaks the protocol by hand:

```js
socket.on('data', (chunk) => {
  if (!sent && output.includes('"welcome"')) {
    sent = true;
    socket.write(JSON.stringify({ kind: 'hello', protocol: 999, clientName: 'bad' }) + '\n');
  }
});
```

This is the only way to test the daemon's *refusal* of a bad peer without
building a malicious client. It also documents the protocol better than prose:
you can see exactly what a handshake looks like.

**Lifecycle tests.** Detach → assert the discovery file → attach → stop → assert
the file is gone → stop again → assert a clear "nothing to stop". Each step
asserts on observable state, not on internal flags.

**Cleanup is part of correctness.** Every fixture removes its temp directory, and
timeouts are failures. A hung daemon would otherwise hold the port, the lock and
the suite forever.

Current total: **45 cases** — 7 CLI/mode, 3 chooser, 17 standalone, 11 daemon,
5 detached, 2 orphan recovery — all in [`scripts/check.mjs`](../scripts/check.mjs).

---

## 13. Security, and what this version does *not* do

Be explicit about this before running daemon mode with `--live`.

**What is protected:**

- The default endpoint is a local pipe/socket, not a network port.
- On POSIX the socket is `chmod 0600`, so only the owning user can connect.
- The discovery file is validated before use.
- Protocol messages are validated before use.
- Only one daemon can own a state directory.

**What is not:**

- **No authentication or authorisation.** Any process that can open the socket is
  trusted completely. On Windows, the default pipe ACL is whatever the OS gives
  the creating user; this code does not tighten it.
- **Any client can stop the daemon** (`shutdown`) or cancel work (`stop`). That
  is a deliberate convenience and an obvious abuse vector on a shared account.
- **Loopback TCP (`--port`) is reachable by any local user.** It is opt-in for
  that reason.
- **`--live` means any attached client can drive the real keyboard and mouse.**
  This is the most important sentence in this section. Dry-run mode is the safe
  default; use it when experimenting with clients.

The natural next step, if this were more than a learning version, is a shared
secret in the discovery file plus a token in the handshake, and OS-specific ACLs
for the pipe. That would not change the architecture — only the handshake and the
transport — which is a decent sign the seams are in the right places.

---

## 14. Exercises

Ordered by how much they make you think about the boundary.

1. **Observe the daemon.** Run `--mode daemon --detach`, then `--mode attach
   --exec "status"`. Find the discovery file and explain every field.
2. **Break the handshake.** Connect with a raw socket, read the welcome, and send
   `hello` with the wrong protocol. Then send a `command` *before* `hello` and
   explain the two different refusals in `server.ts`.
3. **Two terminals, one run.** Start `demo` from one attached client with
   `--no-wait`; watch it from a second; stop it from a third. Then do the same
   with `exit` instead of `stop` and explain what differs and why.
4. **Prove the lock.** Start a daemon, then start a second with the same state
   directory. Predict the error before running it. Then delete `daemon.lock` by
   hand while the daemon runs and explain what a third daemon would do.
5. **Add a protocol message.** Add `{ kind: 'stats' }` that returns task counts.
   You will need: a contract shape, a guard case, a server handler, a client
   method, and a test. Then explain why `PROTOCOL_VERSION` should or should not
   change.
6. **Replace the transport.** Implement an `Endpoint` kind that uses an in-memory
   duplex pair for tests, so the daemon and client can be exercised in one
   process without sockets. Which files change? (The answer should be: transport
   and the test harness.)
7. **Find the missing feature.** Attach mode has no prompt-completion, no
   multi-line, and no way to see *which client* started a run. Pick one and
   design it. Ask what it does to the protocol.

Exercise 5 is the best measure of whether the abstraction is real: if adding a
message requires editing the agent, the boundary is leaking.

---

## 15. Where to read next

- [`src/terminal/broker.ts`](../src/terminal/broker.ts) — the extracted decision
  layer.
- [`src/daemon/server.ts`](../src/daemon/server.ts) — handshake, per-client
  state, broadcast, shutdown.
- [`src/daemon/client.ts`](../src/daemon/client.ts) — a small state machine and
  a promise correlator.
- [`src/daemon/framing.ts`](../src/daemon/framing.ts) — the byte-level reality
  that "messages over a socket" hides.
- [`src/daemon/lock.ts`](../src/daemon/lock.ts) and
  [`discovery.ts`](../src/daemon/discovery.ts) — the two files that make the
  daemon reliable rather than merely functional.

Then re-read §8 and try the three-terminal exercise. The behaviour makes more
sense with three shells open.
