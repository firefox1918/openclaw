/**
 * Threshold manager for compaction triggers.
 *
 * Manages token budgets and determines when compaction should be triggered
 * based on context window limits and buffer sizes.
 *
 * Adapted from Claude Code's autoCompact.ts threshold management.
 */

import {
  AUTOCOMPACT_BUFFER_TOKENS,
  MANUAL_COMPACT_BUFFER_TOKENS,
  type ThresholdCheckResult,
  type ThresholdConfig,
} from "./types.js";

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Safety margin for token estimates (Claude Code uses 1.2).
 */
const DEFAULT_SAFETY_MARGIN = 1.2;

/**
 * Minimum context window for compaction calculations.
 */
const MIN_CONTEXT_WINDOW_TOKENS = 8_000;

// ============================================================================
// Threshold Manager Implementation
// ============================================================================

/**
 * Threshold manager for compaction decisions.
 */
export class ThresholdManager {
  private readonly config: ThresholdConfig;

  constructor(config?: Partial<ThresholdConfig>) {
    this.config = {
      contextWindowTokens: config?.contextWindowTokens ?? MIN_CONTEXT_WINDOW_TOKENS,
      autoBufferTokens: config?.autoBufferTokens ?? AUTOCOMPACT_BUFFER_TOKENS,
      manualBufferTokens: config?.manualBufferTokens ?? MANUAL_COMPACT_BUFFER_TOKENS,
      safetyMargin: config?.safetyMargin ?? DEFAULT_SAFETY_MARGIN,
    };
  }

  /**
   * Get the effective threshold for auto-compaction.
   */
  getAutoThreshold(): number {
    return Math.max(1, this.config.contextWindowTokens - this.config.autoBufferTokens);
  }

  /**
   * Get the effective threshold for manual compaction.
   */
  getManualThreshold(): number {
    return Math.max(1, this.config.contextWindowTokens - this.config.manualBufferTokens);
  }

  /**
   * Get the auto-compaction buffer tokens.
   */
  getAutoBufferTokens(): number {
    return this.config.autoBufferTokens;
  }

  /**
   * Get the manual compaction buffer tokens.
   */
  getManualBufferTokens(): number {
    return this.config.manualBufferTokens;
  }

  /**
   * Check if current token usage triggers auto-compaction.
   */
  checkAutoThreshold(currentTokens: number): ThresholdCheckResult {
    const threshold = this.getAutoThreshold();
    const bufferTokens = this.config.autoBufferTokens;
    const overflowTokens = Math.max(0, currentTokens - threshold);

    if (overflowTokens > 0) {
      return {
        shouldCompact: true,
        reason: "auto_overflow",
        currentTokens,
        thresholdTokens: threshold,
        bufferTokens,
        overflowTokens,
      };
    }

    return {
      shouldCompact: false,
      currentTokens,
      thresholdTokens: threshold,
      bufferTokens,
      overflowTokens: 0,
    };
  }

  /**
   * Check if current token usage triggers manual compaction.
   * Manual compaction always triggers if above threshold, regardless of buffer.
   */
  checkManualThreshold(currentTokens: number): ThresholdCheckResult {
    const threshold = this.getManualThreshold();
    const bufferTokens = this.config.manualBufferTokens;
    const overflowTokens = Math.max(0, currentTokens - threshold);

    // Manual compaction triggers if user requested it and we're above threshold
    if (currentTokens > threshold) {
      return {
        shouldCompact: true,
        reason: "manual_request",
        currentTokens,
        thresholdTokens: threshold,
        bufferTokens,
        overflowTokens,
      };
    }

    return {
      shouldCompact: false,
      currentTokens,
      thresholdTokens: threshold,
      bufferTokens,
      overflowTokens: 0,
    };
  }

  /**
   * Check preemptive threshold before a prompt is sent.
   * Used to detect overflow before it happens.
   */
  checkPreemptiveThreshold(params: {
    currentTokens: number;
    estimatedPromptTokens: number;
    reserveTokens: number;
  }): ThresholdCheckResult {
    const { currentTokens, estimatedPromptTokens, reserveTokens } = params;
    const totalTokens = currentTokens + estimatedPromptTokens + reserveTokens;
    const bufferTokens = this.config.autoBufferTokens;
    const overflowTokens = Math.max(0, totalTokens - this.config.contextWindowTokens);

    if (overflowTokens > 0) {
      return {
        shouldCompact: true,
        reason: "preemptive_check",
        currentTokens: totalTokens,
        thresholdTokens: this.config.contextWindowTokens - bufferTokens,
        bufferTokens,
        overflowTokens,
      };
    }

    return {
      shouldCompact: false,
      currentTokens: totalTokens,
      thresholdTokens: this.config.contextWindowTokens - bufferTokens,
      bufferTokens,
      overflowTokens: 0,
    };
  }

  /**
   * Get the configured safety margin.
   */
  getSafetyMargin(): number {
    return this.config.safetyMargin;
  }

  /**
   * Calculate target tokens after compaction.
   * Leaves buffer space to allow room for new content.
   */
  calculateTargetTokens(isAuto: boolean): number {
    const buffer = isAuto ? this.config.autoBufferTokens : this.config.manualBufferTokens;
    return Math.max(1, this.config.contextWindowTokens - buffer);
  }

  /**
   * Estimate how many tokens need to be compacted.
   */
  estimateCompactionNeeded(params: { currentTokens: number; targetTokens: number }): number {
    return Math.max(0, params.currentTokens - params.targetTokens);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a threshold manager with context window configuration.
 */
export function createThresholdManager(contextWindowTokens?: number): ThresholdManager {
  return new ThresholdManager({ contextWindowTokens });
}

/**
 * Create a threshold manager for a specific model's context window.
 */
export function createModelThresholdManager(modelContextWindowTokens: number): ThresholdManager {
  // Scale buffer tokens proportionally for larger context windows
  const scaleFactor = modelContextWindowTokens / MIN_CONTEXT_WINDOW_TOKENS;
  const autoBufferTokens = Math.floor(AUTOCOMPACT_BUFFER_TOKENS * Math.min(scaleFactor, 2));
  const manualBufferTokens = Math.floor(MANUAL_COMPACT_BUFFER_TOKENS * Math.min(scaleFactor, 2));

  return new ThresholdManager({
    contextWindowTokens: modelContextWindowTokens,
    autoBufferTokens,
    manualBufferTokens,
  });
}

/**
 * Quick check if tokens exceed auto-compaction threshold.
 */
export function shouldAutoCompact(currentTokens: number, contextWindowTokens: number): boolean {
  const threshold = contextWindowTokens - AUTOCOMPACT_BUFFER_TOKENS;
  return currentTokens > threshold;
}

/**
 * Quick check if tokens exceed manual compaction threshold.
 */
export function shouldManualCompact(currentTokens: number, contextWindowTokens: number): boolean {
  const threshold = contextWindowTokens - MANUAL_COMPACT_BUFFER_TOKENS;
  return currentTokens > threshold;
}
