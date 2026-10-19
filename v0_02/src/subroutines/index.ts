/**
 * Subroutine layer barrel.
 *
 * `subroutines/` owns behaviour: what the agent should do, in what order. It
 * talks to the machine only through the `AgentApi` interface and never imports
 * from `core/`.
 */

export {
  SubroutineRegistry,
  normaliseName,
  resolveParams,
  type SubroutineRegistryOptions,
} from './registry.js';
export {
  builtinSubroutines,
  clickMouse,
  demo,
  goto,
  moveMouse,
  normaliseUrl,
  pressKey,
  scroll,
  typeText,
} from './builtin/index.js';
