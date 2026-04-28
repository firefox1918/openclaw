/**
 * Compaction engineering tests.
 */

import { describe, expect, it } from "vitest";
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  COMPACT_BLOCKED_QUERY_SOURCES,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  MANUAL_COMPACT_BUFFER_TOKENS,
  createCompactionCircuitBreaker,
  createCircuitBreakerInState,
  createThresholdManager,
  createModelThresholdManager,
  shouldAutoCompact,
  shouldManualCompact,
  createRecursionGuard,
  isBlockedFromCompaction,
  getCompactionBlockedSources,
  getCompactionDepth,
  isInCompaction,
  runInCompactionContext,
  checkCompactionDepth,
  createCompactionComponents,
  makeCompactionDecision,
  shouldTriggerAutoCompaction,
} from "./index.js";

// ============================================================================
// Circuit Breaker Tests
// ============================================================================

describe("CompactionCircuitBreaker", () => {
  it("should start in closed state", () => {
    const breaker = createCompactionCircuitBreaker();
    expect(breaker.isAllowed()).toBe(true);
    expect(breaker.getStatus().state).toBe("closed");
    expect(breaker.getStatus().consecutiveFailures).toBe(0);
  });

  it("should transition to open after max failures", () => {
    const breaker = createCompactionCircuitBreaker();
    for (let i = 0; i < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES; i++) {
      breaker.recordFailure("test failure");
    }
    expect(breaker.isAllowed()).toBe(false);
    expect(breaker.getStatus().state).toBe("open");
    expect(breaker.getStatus().consecutiveFailures).toBe(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES);
  });

  it("should not transition to open before max failures", () => {
    const breaker = createCompactionCircuitBreaker();
    breaker.recordFailure("failure 1");
    breaker.recordFailure("failure 2");
    expect(breaker.isAllowed()).toBe(true);
    expect(breaker.getStatus().state).toBe("closed");
    expect(breaker.getStatus().consecutiveFailures).toBe(2);
  });

  it("should reset failures on success in closed state", () => {
    const breaker = createCompactionCircuitBreaker();
    breaker.recordFailure("failure");
    breaker.recordSuccess();
    expect(breaker.getStatus().consecutiveFailures).toBe(0);
  });

  it("should transition to half-open after cooldown", async () => {
    const breaker = createCompactionCircuitBreaker({ cooldownMs: 100 });
    for (let i = 0; i < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES; i++) {
      breaker.recordFailure("test failure");
    }
    expect(breaker.getStatus().state).toBe("open");
    expect(breaker.isAllowed()).toBe(false);

    // Wait for cooldown
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(breaker.isAllowed()).toBe(true); // Now in half-open
    expect(breaker.getStatus().state).toBe("half-open");
  });

  it("should close after success in half-open", () => {
    const breaker = createCircuitBreakerInState("half-open");
    expect(breaker.getStatus().state).toBe("half-open");
    breaker.recordSuccess();
    expect(breaker.getStatus().state).toBe("closed");
  });

  it("should reopen on failure in half-open", () => {
    const breaker = createCircuitBreakerInState("half-open");
    expect(breaker.getStatus().state).toBe("half-open");
    breaker.recordFailure("half-open failure");
    expect(breaker.getStatus().state).toBe("open");
  });

  it("should provide block reason", () => {
    const breaker = createCircuitBreakerInState("open");
    const reason = breaker.getBlockReason();
    expect(reason).toContain("Circuit breaker open");
    expect(reason).toContain("consecutive failures");
  });

  it("should reset to closed state", () => {
    const breaker = createCircuitBreakerInState("open");
    breaker.reset();
    expect(breaker.getStatus().state).toBe("closed");
    expect(breaker.getStatus().consecutiveFailures).toBe(0);
  });
});

// ============================================================================
// Threshold Manager Tests
// ============================================================================

describe("ThresholdManager", () => {
  const contextWindowTokens = 200_000;

  it("should calculate thresholds correctly", () => {
    const manager = createThresholdManager(contextWindowTokens);
    const autoThreshold = manager.getAutoThreshold();
    const manualThreshold = manager.getManualThreshold();

    expect(autoThreshold).toBe(contextWindowTokens - AUTOCOMPACT_BUFFER_TOKENS);
    expect(manualThreshold).toBe(contextWindowTokens - MANUAL_COMPACT_BUFFER_TOKENS);
    expect(autoThreshold).toBeLessThan(manualThreshold);
  });

  it("should trigger auto-compaction when above threshold", () => {
    const manager = createThresholdManager(contextWindowTokens);
    const threshold = manager.getAutoThreshold();
    const result = manager.checkAutoThreshold(threshold + 1000);

    expect(result.shouldCompact).toBe(true);
    expect(result.reason).toBe("auto_overflow");
    expect(result.overflowTokens).toBe(1000);
  });

  it("should not trigger auto-compaction when below threshold", () => {
    const manager = createThresholdManager(contextWindowTokens);
    const threshold = manager.getAutoThreshold();
    const result = manager.checkAutoThreshold(threshold - 1000);

    expect(result.shouldCompact).toBe(false);
    expect(result.overflowTokens).toBe(0);
  });

  it("should trigger manual compaction when above threshold", () => {
    const manager = createThresholdManager(contextWindowTokens);
    const threshold = manager.getManualThreshold();
    const result = manager.checkManualThreshold(threshold + 500);

    expect(result.shouldCompact).toBe(true);
    expect(result.reason).toBe("manual_request");
  });

  it("should scale buffers for larger context windows", () => {
    const manager = createModelThresholdManager(400_000);
    expect(manager.getAutoThreshold()).toBeGreaterThan(
      createThresholdManager(200_000).getAutoThreshold(),
    );
  });

  it("should calculate target tokens correctly", () => {
    const manager = createThresholdManager(contextWindowTokens);
    const autoTarget = manager.calculateTargetTokens(true);
    const manualTarget = manager.calculateTargetTokens(false);

    expect(autoTarget).toBe(manager.getAutoThreshold());
    expect(manualTarget).toBe(manager.getManualThreshold());
  });
});

describe("Quick threshold checks", () => {
  const contextWindowTokens = 200_000;

  it("shouldAutoCompact returns true when above threshold", () => {
    const aboveThreshold = contextWindowTokens - AUTOCOMPACT_BUFFER_TOKENS + 1000;
    expect(shouldAutoCompact(aboveThreshold, contextWindowTokens)).toBe(true);
  });

  it("shouldAutoCompact returns false when below threshold", () => {
    const belowThreshold = contextWindowTokens - AUTOCOMPACT_BUFFER_TOKENS - 1000;
    expect(shouldAutoCompact(belowThreshold, contextWindowTokens)).toBe(false);
  });

  it("shouldManualCompact returns true when above threshold", () => {
    const aboveThreshold = contextWindowTokens - MANUAL_COMPACT_BUFFER_TOKENS + 500;
    expect(shouldManualCompact(aboveThreshold, contextWindowTokens)).toBe(true);
  });
});

// ============================================================================
// Recursion Guard Tests
// ============================================================================

describe("RecursionGuard", () => {
  it("should allow normal sources", () => {
    const guard = createRecursionGuard();
    const result = guard.check("normal_query");
    expect(result.allowed).toBe(true);
  });

  it("should block session_memory source", () => {
    const guard = createRecursionGuard();
    const result = guard.check("session_memory");
    expect(result.allowed).toBe(false);
    expect(result.blockedSource).toBe("session_memory");
    expect(result.reason).toContain("blocked");
  });

  it("should block compact source", () => {
    const guard = createRecursionGuard();
    const result = guard.check("compact");
    expect(result.allowed).toBe(false);
  });

  it("should handle agent: prefix", () => {
    const guard = createRecursionGuard();
    const result = guard.check("agent:session_memory");
    expect(result.allowed).toBe(false);
    expect(result.blockedSource).toBe("session_memory");
  });

  it("should track blocked attempts", () => {
    const guard = createRecursionGuard({ logBlocked: false });
    guard.check("session_memory");
    guard.check("session_memory");
    guard.check("session_memory");

    const counts = guard.getBlockedAttemptCounts();
    expect(counts.get("session_memory")).toBe(3);
  });

  it("should clear blocked attempts", () => {
    const guard = createRecursionGuard({ logBlocked: false });
    guard.check("session_memory");
    guard.clearBlockedAttempts();
    expect(guard.getBlockedAttemptCounts().size).toBe(0);
  });
});

describe("Quick recursion checks", () => {
  it("isBlockedFromCompaction returns true for blocked sources", () => {
    expect(isBlockedFromCompaction("session_memory")).toBe(true);
    expect(isBlockedFromCompaction("compact")).toBe(true);
    expect(isBlockedFromCompaction("marble_origami")).toBe(true);
  });

  it("isBlockedFromCompaction returns false for normal sources", () => {
    expect(isBlockedFromCompaction("normal_query")).toBe(false);
    expect(isBlockedFromCompaction(undefined)).toBe(false);
  });

  it("getCompactionBlockedSources returns blocked list", () => {
    const blocked = getCompactionBlockedSources();
    expect(blocked).toContain("session_memory");
    expect(blocked).toContain("compact");
    expect(blocked).toEqual(COMPACT_BLOCKED_QUERY_SOURCES);
  });
});

describe("AsyncLocalStorage recursion tracking", () => {
  it("should track compaction depth", async () => {
    expect(getCompactionDepth()).toBe(0);
    expect(isInCompaction()).toBe(false);

    await runInCompactionContext("test_source", async () => {
      expect(getCompactionDepth()).toBe(1);
      expect(isInCompaction()).toBe(true);

      const result = checkCompactionDepth();
      expect(result.allowed).toBe(true);
    });

    expect(getCompactionDepth()).toBe(0);
    expect(isInCompaction()).toBe(false);
  });

  it("should track nested compaction depth", async () => {
    await runInCompactionContext("outer", async () => {
      expect(getCompactionDepth()).toBe(1);

      await runInCompactionContext("inner", async () => {
        expect(getCompactionDepth()).toBe(2);
        const result = checkCompactionDepth();
        expect(result.allowed).toBe(false); // Exceeds MAX_COMPACTION_DEPTH
      });

      expect(getCompactionDepth()).toBe(1);
    });

    expect(getCompactionDepth()).toBe(0);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("Compaction Decision Integration", () => {
  const contextWindowTokens = 200_000;

  it("should create complete compaction components", () => {
    const components = createCompactionComponents({ contextWindowTokens });
    expect(components.circuitBreaker).toBeDefined();
    expect(components.thresholdManager).toBeDefined();
    expect(components.recursionGuard).toBeDefined();
  });

  it("should proceed when all checks pass", () => {
    const { circuitBreaker, thresholdManager, recursionGuard } = createCompactionComponents({
      contextWindowTokens,
    });
    const aboveThreshold = contextWindowTokens - AUTOCOMPACT_BUFFER_TOKENS + 1000;

    const decision = makeCompactionDecision({
      circuitBreaker,
      thresholdManager,
      recursionGuard,
      currentTokens: aboveThreshold,
      contextWindowTokens,
      isAuto: true,
      querySource: "normal_query",
    });

    expect(decision.proceed).toBe(true);
    expect(decision.blockedByCircuitBreaker).toBe(false);
    expect(decision.blockedByRecursionGuard).toBe(false);
    expect(decision.belowThreshold).toBe(false);
  });

  it("should block when recursion guard fails", () => {
    const { circuitBreaker, thresholdManager, recursionGuard } = createCompactionComponents({
      contextWindowTokens,
    });
    const aboveThreshold = contextWindowTokens - AUTOCOMPACT_BUFFER_TOKENS + 1000;

    const decision = makeCompactionDecision({
      circuitBreaker,
      thresholdManager,
      recursionGuard,
      currentTokens: aboveThreshold,
      contextWindowTokens,
      isAuto: true,
      querySource: "session_memory",
    });

    expect(decision.proceed).toBe(false);
    expect(decision.blockedByRecursionGuard).toBe(true);
  });

  it("should block when circuit breaker fails", () => {
    const { circuitBreaker, thresholdManager, recursionGuard } = createCompactionComponents({
      contextWindowTokens,
    });
    // Open the circuit breaker
    for (let i = 0; i < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES; i++) {
      circuitBreaker.recordFailure("test failure");
    }

    const aboveThreshold = contextWindowTokens - AUTOCOMPACT_BUFFER_TOKENS + 1000;

    const decision = makeCompactionDecision({
      circuitBreaker,
      thresholdManager,
      recursionGuard,
      currentTokens: aboveThreshold,
      contextWindowTokens,
      isAuto: true,
      querySource: "normal_query",
    });

    expect(decision.proceed).toBe(false);
    expect(decision.blockedByCircuitBreaker).toBe(true);
    expect(decision.circuitBreakerState).toBe("open");
  });

  it("should block when below threshold", () => {
    const { circuitBreaker, thresholdManager, recursionGuard } = createCompactionComponents({
      contextWindowTokens,
    });
    const belowThreshold = contextWindowTokens - AUTOCOMPACT_BUFFER_TOKENS - 1000;

    const decision = makeCompactionDecision({
      circuitBreaker,
      thresholdManager,
      recursionGuard,
      currentTokens: belowThreshold,
      contextWindowTokens,
      isAuto: true,
      querySource: "normal_query",
    });

    expect(decision.proceed).toBe(false);
    expect(decision.belowThreshold).toBe(true);
  });

  it("shouldTriggerAutoCompaction quick check", () => {
    const { circuitBreaker } = createCompactionComponents({ contextWindowTokens });
    const aboveThreshold = contextWindowTokens - AUTOCOMPACT_BUFFER_TOKENS + 1000;

    expect(
      shouldTriggerAutoCompaction({
        currentTokens: aboveThreshold,
        contextWindowTokens,
        circuitBreaker,
        querySource: "normal_query",
      }),
    ).toBe(true);

    expect(
      shouldTriggerAutoCompaction({
        currentTokens: aboveThreshold,
        contextWindowTokens,
        circuitBreaker,
        querySource: "session_memory",
      }),
    ).toBe(false);
  });
});
