/**
 * Circuit breaker for compaction operations.
 *
 * Prevents runaway auto-compaction when consecutive failures indicate
 * a systemic issue (e.g., provider unavailability, summary failures).
 *
 * State machine:
 * - closed → open: MAX_CONSECUTIVE_FAILURES reached
 * - open → half-open: COOLDOWN period elapsed
 * - half-open → closed: Successful compaction
 * - half-open → open: Another failure
 *
 * Adapted from Claude Code's autoCompact.ts circuit breaker pattern.
 */

import {
  CIRCUIT_BREAKER_COOLDOWN_MS,
  HALF_OPEN_RECOVERY_ATTEMPTS,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  type CircuitBreakerConfig,
  type CircuitBreakerState,
  type CircuitBreakerStatus,
} from "./types.js";

// ============================================================================
// Circuit Breaker Implementation
// ============================================================================

/**
 * Circuit breaker for compaction operations.
 */
export class CompactionCircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private consecutiveFailures: number = 0;
  private openedAt?: number;
  private halfOpenAt?: number;
  private halfOpenSuccesses: number = 0;
  private lastFailureReason?: string;

  private readonly config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      maxConsecutiveFailures:
        config?.maxConsecutiveFailures ?? MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
      cooldownMs: config?.cooldownMs ?? CIRCUIT_BREAKER_COOLDOWN_MS,
      recoveryAttempts: config?.recoveryAttempts ?? HALF_OPEN_RECOVERY_ATTEMPTS,
    };
  }

  /**
   * Get current circuit breaker status.
   */
  getStatus(): CircuitBreakerStatus {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      halfOpenAt: this.halfOpenAt,
      halfOpenSuccesses: this.halfOpenSuccesses,
      lastFailureReason: this.lastFailureReason,
    };
  }

  /**
   * Check if compaction is allowed based on circuit breaker state.
   */
  isAllowed(): boolean {
    // Always check for half-open transition first
    this.maybeTransitionToHalfOpen();

    switch (this.state) {
      case "closed":
        return true;
      case "open":
        return false;
      case "half-open":
        // In half-open, we allow one attempt to test recovery
        return this.halfOpenSuccesses < this.config.recoveryAttempts;
      default:
        // Exhaustive check
        const _: never = this.state;
        throw new Error(`Unknown circuit breaker state: ${String(_)}`);
    }
  }

  /**
   * Record a successful compaction.
   */
  recordSuccess(): void {
    switch (this.state) {
      case "closed":
        // Reset failure count on success in closed state
        this.consecutiveFailures = 0;
        break;
      case "half-open":
        // Increment success count
        this.halfOpenSuccesses++;
        // Check if we've recovered enough to close
        if (this.halfOpenSuccesses >= this.config.recoveryAttempts) {
          this.transitionToClosed();
        }
        break;
      case "open":
        // Shouldn't happen - success while open means someone bypassed
        // But we handle it gracefully by transitioning to half-open
        this.transitionToHalfOpen();
        break;
      default:
        // Exhaustive check
        const _: never = this.state;
        throw new Error(`Unknown circuit breaker state: ${String(_)}`);
    }
  }

  /**
   * Record a failed compaction.
   */
  recordFailure(reason?: string): void {
    this.lastFailureReason = reason;

    switch (this.state) {
      case "closed":
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
          this.transitionToOpen();
        }
        break;
      case "half-open":
        // Failure in half-open immediately reopens
        this.transitionToOpen();
        break;
      case "open":
        // Already open, just update failure reason
        break;
      default:
        // Exhaustive check
        const _: never = this.state;
        throw new Error(`Unknown circuit breaker state: ${String(_)}`);
    }
  }

  /**
   * Force reset the circuit breaker to closed state.
   * Use with caution - typically only for manual intervention.
   */
  reset(): void {
    this.transitionToClosed();
  }

  /**
   * Get the reason why circuit breaker might be blocking.
   */
  getBlockReason(): string | undefined {
    if (this.state === "closed") {
      return undefined;
    }
    if (this.state === "open") {
      const elapsed = this.openedAt ? Date.now() - this.openedAt : 0;
      const remainingMs = this.config.cooldownMs - elapsed;
      const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
      return `Circuit breaker open (${this.consecutiveFailures} consecutive failures, ${remainingSec}s until retry, reason: ${this.lastFailureReason ?? "unknown"})`;
    }
    if (this.state === "half-open") {
      return `Circuit breaker half-open (testing recovery after cooldown)`;
    }
    return undefined;
  }

  // ============================================================================
  // State Transitions (Private)
  // ============================================================================

  private transitionToClosed(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = undefined;
    this.halfOpenAt = undefined;
    this.halfOpenSuccesses = 0;
  }

  private transitionToOpen(): void {
    this.state = "open";
    this.openedAt = Date.now();
    this.halfOpenAt = undefined;
    this.halfOpenSuccesses = 0;
  }

  private transitionToHalfOpen(): void {
    this.state = "half-open";
    this.halfOpenAt = Date.now();
    this.halfOpenSuccesses = 0;
    // Keep failure count but reset half-open state
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state !== "open") {
      return;
    }
    if (!this.openedAt) {
      return;
    }
    const elapsed = Date.now() - this.openedAt;
    if (elapsed >= this.config.cooldownMs) {
      this.transitionToHalfOpen();
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a circuit breaker with default configuration.
 */
export function createCompactionCircuitBreaker(
  config?: Partial<CircuitBreakerConfig>,
): CompactionCircuitBreaker {
  return new CompactionCircuitBreaker(config);
}

/**
 * Create a per-session circuit breaker.
 * Each session should have its own circuit breaker to track its specific failures.
 */
export function createSessionCircuitBreaker(): CompactionCircuitBreaker {
  return new CompactionCircuitBreaker();
}

// ============================================================================
// Testing Helpers
// ============================================================================

/**
 * Create a circuit breaker in a specific state for testing.
 */
export function createCircuitBreakerInState(
  state: CircuitBreakerState,
  _failures?: number,
): CompactionCircuitBreaker {
  const breaker = new CompactionCircuitBreaker();
  if (state === "open") {
    // Force failures to open
    for (let i = 0; i < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES; i++) {
      breaker.recordFailure("test failure");
    }
  } else if (state === "half-open") {
    // Open then wait for cooldown (simulate)
    for (let i = 0; i < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES; i++) {
      breaker.recordFailure("test failure");
    }
    // Force half-open by resetting openedAt to past
    // This is only for testing
    const breakerInternal = breaker as unknown as {
      openedAt: number;
      transitionToHalfOpen: () => void;
    };
    breakerInternal.openedAt = Date.now() - CIRCUIT_BREAKER_COOLDOWN_MS - 1000;
    breakerInternal.transitionToHalfOpen();
  }
  return breaker;
}
