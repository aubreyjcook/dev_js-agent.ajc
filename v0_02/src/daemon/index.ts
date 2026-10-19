/**
 * The daemon barrel.
 *
 * Everything a caller outside this folder needs: connecting as a client, running
 * the server, discovery, and lifecycle.
 */

export { DaemonClient, type CommandHandlers, type DaemonClientOptions } from './client.js';
export {
  type DaemonRecord,
  type DaemonLookup,
  clearRecord,
  ensureStateDir,
  findDaemon,
  isProcessAlive,
  protocolMatches,
  readRecord,
  recordPath,
  waitForDaemon,
  writeRecord,
} from './discovery.js';
export { defaultStateDir, resolveEndpoint, resolveStateDir, type EndpointOptions } from './endpoint.js';
export { JsonLineChannel, MAX_MESSAGE_BYTES } from './framing.js';
export { spawnDetachedDaemon, stopDaemon, type DetachOptions } from './lifecycle.js';
export { acquireDaemonLock, clearLock, lockPath, readLockPid, type DaemonLock } from './lock.js';
export { DaemonServer, type DaemonServerOptions } from './server.js';
export {
  type ListenOptions,
  type ListeningServer,
  connect as connectTransport,
  describe as describeEndpoint,
  listen,
  probeEndpoint,
} from './transport.js';
