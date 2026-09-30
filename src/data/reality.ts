/**
 * The ontology's reality levels that the signed-in app can show today (docs/ontology.yaml, `reality_levels`).
 * `live_mainnet` is omitted on purpose: nothing in the app is at that level yet.
 */
export type RealityLevel =
  | 'testnet_real'
  | 'testnet_simulated'
  | 'read_only_live'
  | 'self_declared_local'
  | 'self_declared_private'
  | 'prototype'
  | 'illustration'
  | 'roadmap';

export const REALITY: Record<RealityLevel, { label: string; meaning: string }> = {
  testnet_real: { label: 'Test network', meaning: 'Real program or contract execution on a test network with test tokens.' },
  testnet_simulated: { label: 'Test network · simulated input', meaning: 'Real test-network execution, but an input such as a price or yield is simulated on purpose.' },
  read_only_live: { label: 'Live · read-only', meaning: 'Real third-party data, read-only, with its source and review caveats.' },
  self_declared_local: { label: 'On this device', meaning: 'Unverified information you keep only on this device.' },
  self_declared_private: { label: 'Your own statement', meaning: 'Unverified information you entered, stored under your account and shared with no one.' },
  prototype: { label: 'Prototype', meaning: 'A working, limited flow. Not a production financial or legal workflow.' },
  illustration: { label: 'Illustration', meaning: 'A labelled exploratory visual or calculation with fictional inputs. No real transaction or measured outcome.' },
  roadmap: { label: 'Roadmap', meaning: 'An idea only. Nothing is built.' },
};
