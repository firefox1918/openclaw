/**
 * Recursion guard for compaction operations.
 *
 * Prevents compaction from being triggered recursively when certain
 * query sources are involved (e.g., session_memory agents that run
 * compaction themselves).
 *
 * Adapted from Claude Code's COMPACT_BLOCKED_QUERY_SOURCES pattern.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  COMPACT_BLOCKED_QUERY_SOURCES,
  type QuerySource,
  type RecursionGuardConfig,
  type RecursionGuardResult,
} from "./types.js";

const log = createSubsystemLogger("compaction/recursion-guard");

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: RecursionGuardConfig = {
  blockedSources: COMPACT_BLOCKED_QUERY_SOURCES,
  logBlocked: true,
};

// ============================================================================
// Recursion Guard Implementation
// ============================================================================

/**
 * Recursion guard to prevent compaction loops.
 */
export class RecursionGuard {
  private readonly config: RecursionGuardConfig;
  private readonly blockedAttempts: Map<QuerySource, number> = new Map();

  constructor(config?: Partial<RecursionGuardConfig>) {
    this.config = {
      blockedSources: config?.blockedSources ?? DEFAULT_CONFIG.blockedSources,
      logBlocked: config?.logBlocked ?? DEFAULT_CONFIG.logBlocked,
    };
  }

  /**
   * Check if a query source is allowed to trigger compaction.
   */
  check(querySource?: QuerySource): RecursionGuardResult {
    if (!querySource) {
      return { allowed: true };
    }

    const normalizedSource = this.normalizeSource(querySource);
    const isBlocked = this.config.blockedSources.includes(normalizedSource);

    if (isBlocked) {
      // Track blocked attempts for monitoring
      const count = this.blockedAttempts.get(normalizedSource) ?? 0;
      this.blockedAttempts.set(normalizedSource, count + 1);

      if (this.config.logBlocked) {
        log.warn(`Compaction blocked for query source: ${normalizedSource} (count: ${count + 1})`);
      }

      return {
        allowed: false,
        blockedSource: normalizedSource,
        reason: `Query source '${normalizedSource}' is blocked from triggering compaction to prevent recursion`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check if compaction should proceed given multiple potential sources.
   */
  checkSources(sources: QuerySource[]): RecursionGuardResult {
    for (const source of sources) {
      const result = this.check(source);
      if (!result.allowed) {
        return result;
      }
    }
    return { allowed: true };
  }

  /**
   * Get blocked attempt counts for monitoring.
   */
  getBlockedAttemptCounts(): Map<QuerySource, number> {
    return new Map(this.blockedAttempts);
  }

  /**
   * Clear blocked attempt tracking.
   */
  clearBlockedAttempts(): void {
    this.blockedAttempts.clear();
  }

  /**
   * Check if a source is in the blocked list.
   */
  isBlockedSource(source: QuerySource): boolean {
    const normalized = this.normalizeSource(source);
    return this.config.blockedSources.includes(normalized as never);
  }

  /**
   * Get the list of blocked sources.
   */
  getBlockedSources(): readonly QuerySource[] {
    return this.config.blockedSources;
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private normalizeSource(source: QuerySource): QuerySource {
    // Normalize to lowercase and strip common prefixes
    let normalized = source.toLowerCase().trim();
    // Strip "agent:" prefix if present
    if (normalized.startsWith("agent:")) {
      normalized = normalized.slice(6);
    }
    // Strip "mcp:" prefix if present
    if (normalized.startsWith("mcp:")) {
      normalized = normalized.slice(4);
    }
    return normalized;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a recursion guard with default configuration.
 */
export function createRecursionGuard(config?: Partial<RecursionGuardConfig>): RecursionGuard {
  return new RecursionGuard(config);
}

/**
 * Create a session-scoped recursion guard.
 */
export function createSessionRecursionGuard(): RecursionGuard {
  return new RecursionGuard();
}

// ============================================================================
// Quick Check Functions
// ============================================================================

/**
 * Quick check if a source is blocked from compaction.
 */
export function isBlockedFromCompaction(source?: QuerySource): boolean {
  if (!source) {
    return false;
  }
  let normalized = source.toLowerCase().trim();
  if (normalized.startsWith("agent:")) {
    normalized = normalized.slice(6);
  }
  if (normalized.startsWith("mcp:")) {
    normalized = normalized.slice(4);
  }
  return COMPACT_BLOCKED_QUERY_SOURCES.includes(normalized as never);
}

/**
 * Get the blocked sources list for reference.
 */
export function getCompactionBlockedSources(): readonly QuerySource[] {
  return COMPACT_BLOCKED_QUERY_SOURCES;
}

// ============================================================================
// AsyncLocalStorage Integration
// ============================================================================

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Context for tracking compaction recursion across async boundaries.
 */
type CompactionRecursionContext = {
  /** Current compaction depth */
  depth: number;
  /** Source that initiated compaction */
  source?: QuerySource;
};

/**
 * AsyncLocalStorage for compaction recursion tracking.
 */
const compactionRecursionStorage = new AsyncLocalStorage<CompactionRecursionContext>();

/**
 * Get current compaction recursion context.
 */
export function getCompactionRecursionContext(): CompactionRecursionContext | undefined {
  return compactionRecursionStorage.getStore();
}

/**
 * Check if we're currently inside a compaction operation.
 */
export function isInCompaction(): boolean {
  const ctx = compactionRecursionStorage.getStore();
  return ctx !== undefined && ctx.depth > 0;
}

/**
 * Get current compaction depth.
 */
export function getCompactionDepth(): number {
  const ctx = compactionRecursionStorage.getStore();
  return ctx?.depth ?? 0;
}

/**
 * Run code within a compaction context.
 * Increments depth for nested compaction detection.
 */
export async function runInCompactionContext<T>(
  source: QuerySource,
  fn: () => Promise<T>,
): Promise<T> {
  const parentCtx = compactionRecursionStorage.getStore();
  const newCtx: CompactionRecursionContext = {
    depth: (parentCtx?.depth ?? 0) + 1,
    source,
  };

  return compactionRecursionStorage.run(newCtx, fn);
}

/**
 * Maximum compaction depth before blocking.
 */
const MAX_COMPACTION_DEPTH = 2;

/**
 * Check if compaction depth exceeds safe limits.
 */
export function checkCompactionDepth(): RecursionGuardResult {
  const depth = getCompactionDepth();
  if (depth >= MAX_COMPACTION_DEPTH) {
    return {
      allowed: false,
      reason: `Compaction depth ${depth} exceeds maximum ${MAX_COMPACTION_DEPTH}`,
    };
  }
  return { allowed: true };
}
