/**
 * Web's view of the composer context-window readout.
 *
 * The derivation is shared with mobile; this re-export keeps the existing
 * `~/lib/contextWindow` import path working.
 */
export {
  type ContextWindowSnapshot,
  deriveLatestContextWindowSnapshot,
  formatContextWindowPercentage,
  formatContextWindowTokens,
  formatThreadCostUsd,
} from "@t3tools/client-runtime/context-window";
