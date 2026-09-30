/**
 * Test helpers for @aigentia/agent-core and downstream packages. Nothing here calls a
 * network or a paid model; the mock language model logs a "[MOCK]" warning on first use.
 */
export { ScriptedBrain } from "./scripted-brain";
export { mockModelReturning, mockModelThrowing, mockModelSequence } from "./mock-model";
export { syntheticObservation } from "./fixtures";
export type { SyntheticObservationOptions } from "./fixtures";
