/**
 * Compaction engineering module.
 *
 * Provides circuit breaker, threshold management, and recursion protection
 * for auto-compaction operations.
 *
 * Adapted from Claude Code's autoCompact.ts for OpenClaw.
 */

// Types
export type {
  CircuitBreakerConfig,
  CircuitBreakerState,
  CircuitBreakerStatus,
  CompactionContext,
  CompactionDecision,
  CompactionTriggerReason,
  QuerySource,
  RecursionGuardConfig,
  RecursionGuardResult,
  ThresholdCheckResult,
  ThresholdConfig,
} from "./types.js";

export {
  AUTOCOMPACT_BUFFER_TOKENS,
  COMPACT_BLOCKED_QUERY_SOURCES,
  CIRCUIT_BREAKER_COOLDOWN_MS,
  HALF_OPEN_RECOVERY_ATTEMPTS,
  MANUAL_COMPACT_BUFFER_TOKENS,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
} from "./types.js";

// Circuit Breaker
export {
  CompactionCircuitBreaker,
  createCircuitBreakerInState,
  createCompactionCircuitBreaker,
  createSessionCircuitBreaker,
} from "./circuit-breaker.js";

// Threshold Manager
export {
  createModelThresholdManager,
  createThresholdManager,
  shouldAutoCompact,
  shouldManualCompact,
  ThresholdManager,
} from "./threshold-manager.js";

// Recursion Guard
export {
  checkCompactionDepth,
  createRecursionGuard,
  createSessionRecursionGuard,
  getCompactionBlockedSources,
  getCompactionDepth,
  getCompactionRecursionContext,
  isBlockedFromCompaction,
  isInCompaction,
  RecursionGuard,
  runInCompactionContext,
} from "./recursion-guard.js";

// ============================================================================
// Convenience Functions
// ============================================================================

import { CompactionCircuitBreaker, createCompactionCircuitBreaker } from "./circuit-breaker.js";
import {
  RecursionGuard,
  createRecursionGuard,
  isBlockedFromCompaction,
} from "./recursion-guard.js";
import {
  ThresholdManager,
  createThresholdManager,
  shouldAutoCompact,
} from "./threshold-manager.js";
import type { CompactionDecision } from "./types.js";

/**
 * Create a complete compaction context with all components.
 */
export function createCompactionComponents(params?: { contextWindowTokens?: number }): {
  circuitBreaker: CompactionCircuitBreaker;
  thresholdManager: ThresholdManager;
  recursionGuard: RecursionGuard;
} {
  return {
    circuitBreaker: createCompactionCircuitBreaker(),
    thresholdManager: createThresholdManager(params?.contextWindowTokens),
    recursionGuard: createRecursionGuard(),
  };
}

/**
 * Make a compaction decision considering all factors.
 */
export function makeCompactionDecision(params: {
  circuitBreaker: CompactionCircuitBreaker;
  thresholdManager: ThresholdManager;
  recursionGuard: RecursionGuard;
  currentTokens: number;
  contextWindowTokens: number;
  isAuto: boolean;
  querySource?: string;
}): CompactionDecision {
  const { circuitBreaker, thresholdManager, recursionGuard, currentTokens, isAuto, querySource } =
    params;

  // Check recursion guard first
  const recursionResult = recursionGuard.check(querySource);
  if (!recursionResult.allowed) {
    return {
      proceed: false,
      reason: recursionResult.reason ?? "Blocked by recursion guard",
      circuitBreakerState: circuitBreaker.getStatus().state,
      blockedByCircuitBreaker: false,
      blockedByRecursionGuard: true,
      belowThreshold: false,
    };
  }

  // Check circuit breaker
  if (!circuitBreaker.isAllowed()) {
    return {
      proceed: false,
      reason: circuitBreaker.getBlockReason() ?? "Blocked by circuit breaker",
      circuitBreakerState: circuitBreaker.getStatus().state,
      blockedByCircuitBreaker: true,
      blockedByRecursionGuard: false,
      belowThreshold: false,
    };
  }

  // Check threshold
  const thresholdResult = isAuto
    ? thresholdManager.checkAutoThreshold(currentTokens)
    : thresholdManager.checkManualThreshold(currentTokens);

  if (!thresholdResult.shouldCompact) {
    return {
      proceed: false,
      reason: `Below threshold (current: ${currentTokens}, threshold: ${thresholdResult.thresholdTokens})`,
      circuitBreakerState: circuitBreaker.getStatus().state,
      blockedByCircuitBreaker: false,
      blockedByRecursionGuard: false,
      belowThreshold: true,
    };
  }

  // All checks passed, proceed with compaction
  return {
    proceed: true,
    reason: thresholdResult.reason ?? "Threshold exceeded",
    circuitBreakerState: circuitBreaker.getStatus().state,
    blockedByCircuitBreaker: false,
    blockedByRecursionGuard: false,
    belowThreshold: false,
  };
}

/**
 * Quick helper to check if auto-compaction should be triggered.
 */
export function shouldTriggerAutoCompaction(params: {
  currentTokens: number;
  contextWindowTokens: number;
  circuitBreaker: CompactionCircuitBreaker;
  querySource?: string;
}): boolean {
  // Check recursion guard
  if (isBlockedFromCompaction(params.querySource)) {
    return false;
  }

  // Check circuit breaker
  if (!params.circuitBreaker.isAllowed()) {
    return false;
  }

  // Check threshold
  return shouldAutoCompact(params.currentTokens, params.contextWindowTokens);
}
