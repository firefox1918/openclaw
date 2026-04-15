/**
 * Compaction engineering types.
 *
 * Adapted from Claude Code's autoCompact.ts for OpenClaw's context management.
 * Provides circuit breaker, threshold management, and recursion protection.
 */

// ============================================================================
// Constants
// ============================================================================

/**
 * Token buffer for auto-compaction triggers.
 * Larger buffer to allow more context before triggering auto-compact.
 */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/**
 * Token buffer for manual compaction.
 * Smaller buffer since user explicitly requested compact.
 */
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

/**
 * Maximum consecutive auto-compaction failures before circuit breaker opens.
 */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

/**
 * Half-open state recovery attempts before fully closing circuit.
 */
export const HALF_OPEN_RECOVERY_ATTEMPTS = 1;

/**
 * Circuit breaker cooldown period in milliseconds.
 */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000; // 1 minute

/**
 * Sources that should not trigger compaction when querying.
 * These are special agent types that run compaction themselves.
 */
export const COMPACT_BLOCKED_QUERY_SOURCES = [
  "session_memory",
  "compact",
  "marble_origami",
] as const;

// ============================================================================
// Circuit Breaker Types
// ============================================================================

/**
 * Circuit breaker state.
 * - closed: Normal operation, compaction allowed
 * - open: Compaction blocked due to consecutive failures
 * - half-open: Testing if compaction can resume
 */
export type CircuitBreakerState = "closed" | "open" | "half-open";

/**
 * Circuit breaker status for monitoring.
 */
export type CircuitBreakerStatus = {
  /** Current state */
  state: CircuitBreakerState;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Timestamp when circuit opened */
  openedAt?: number;
  /** Timestamp when circuit entered half-open */
  halfOpenAt?: number;
  /** Number of successful operations in half-open state */
  halfOpenSuccesses: number;
  /** Last failure reason */
  lastFailureReason?: string;
};

/**
 * Circuit breaker configuration.
 */
export type CircuitBreakerConfig = {
  /** Maximum consecutive failures before opening */
  maxConsecutiveFailures: number;
  /** Cooldown period before trying half-open */
  cooldownMs: number;
  /** Number of successes needed in half-open to close */
  recoveryAttempts: number;
};

// ============================================================================
// Threshold Types
// ============================================================================

/**
 * Compaction trigger reason.
 */
export type CompactionTriggerReason =
  | "auto_overflow"
  | "manual_request"
  | "preemptive_check"
  | "context_share";

/**
 * Threshold check result.
 */
export type ThresholdCheckResult = {
  /** Whether compaction should be triggered */
  shouldCompact: boolean;
  /** Reason for the trigger */
  reason?: CompactionTriggerReason;
  /** Current token usage */
  currentTokens: number;
  /** Token budget threshold */
  thresholdTokens: number;
  /** Buffer tokens reserved */
  bufferTokens: number;
  /** Overflow tokens (if shouldCompact) */
  overflowTokens: number;
};

/**
 * Threshold configuration.
 */
export type ThresholdConfig = {
  /** Context window token limit */
  contextWindowTokens: number;
  /** Buffer tokens for auto-compaction */
  autoBufferTokens: number;
  /** Buffer tokens for manual compaction */
  manualBufferTokens: number;
  /** Safety margin multiplier */
  safetyMargin: number;
};

// ============================================================================
// Recursion Guard Types
// ============================================================================

/**
 * Query source that might trigger recursion.
 */
export type QuerySource = string;

/**
 * Recursion guard check result.
 */
export type RecursionGuardResult = {
  /** Whether compaction should proceed */
  allowed: boolean;
  /** Blocked source if not allowed */
  blockedSource?: QuerySource;
  /** Reason for blocking */
  reason?: string;
};

/**
 * Recursion guard configuration.
 */
export type RecursionGuardConfig = {
  /** Sources that should not trigger compaction */
  blockedSources: readonly QuerySource[];
  /** Whether to log blocked attempts */
  logBlocked: boolean;
};

// ============================================================================
// Compaction Context Types
// ============================================================================

/**
 * Context for compaction decision making.
 */
export type CompactionContext = {
  /** Circuit breaker status */
  circuitBreaker: CircuitBreakerStatus;
  /** Current threshold check */
  threshold: ThresholdCheckResult;
  /** Recursion guard result */
  recursionGuard: RecursionGuardResult;
  /** Whether this is an auto-compaction */
  isAuto: boolean;
  /** Query source if applicable */
  querySource?: QuerySource;
};

/**
 * Compaction decision result.
 */
export type CompactionDecision = {
  /** Whether compaction should proceed */
  proceed: boolean;
  /** Reason for the decision */
  reason: string;
  /** Circuit breaker state at decision time */
  circuitBreakerState: CircuitBreakerState;
  /** Whether circuit breaker blocked */
  blockedByCircuitBreaker: boolean;
  /** Whether recursion guard blocked */
  blockedByRecursionGuard: boolean;
  /** Whether threshold didn't trigger */
  belowThreshold: boolean;
};
