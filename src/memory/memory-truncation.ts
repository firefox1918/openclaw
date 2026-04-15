/**
 * Memory truncation utilities.
 *
 * Provides explicit truncation functions for memory content
 * with archive management and size enforcement.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildMemoryIndexContent, checkMemoryIndexSize } from "./memory-index.js";
import {
  MAX_MEMORY_CONTENT_CHARS,
  MAX_MEMORY_INDEX_BYTES,
  MAX_MEMORY_INDEX_LINES,
  MAX_MEMORY_SUMMARY_CHARS,
  type MemoryEntry,
  type MemoryTruncationResult,
} from "./memory-types.js";

const log = createSubsystemLogger("memory/truncation");

// ============================================================================
// Content Truncation
// ============================================================================

/**
 * Truncate memory content to maximum allowed characters.
 */
export function truncateMemoryContent(content: string): string {
  if (content.length <= MAX_MEMORY_CONTENT_CHARS) {
    return content;
  }

  const truncated = content.slice(0, MAX_MEMORY_CONTENT_CHARS - 3) + "...";
  log.debug(`Truncated content from ${content.length} to ${truncated.length} chars`);
  return truncated;
}

/**
 * Truncate memory summary to maximum allowed characters.
 */
export function truncateMemorySummary(summary: string): string {
  if (summary.length <= MAX_MEMORY_SUMMARY_CHARS) {
    return summary;
  }

  return summary.slice(0, MAX_MEMORY_SUMMARY_CHARS - 3) + "...";
}

// ============================================================================
// Index Truncation
// ============================================================================

/**
 * Check if memory index needs truncation.
 */
export function checkNeedsTruncation(entries: MemoryEntry[]): {
  needsTruncation: boolean;
  lines: number;
  bytes: number;
  exceedsLines: boolean;
  exceedsBytes: boolean;
} {
  const content = buildMemoryIndexContent(entries);
  const sizeCheck = checkMemoryIndexSize(content);

  return {
    needsTruncation: sizeCheck.exceedsLines || sizeCheck.exceedsBytes,
    lines: sizeCheck.lines,
    bytes: sizeCheck.bytes,
    exceedsLines: sizeCheck.exceedsLines,
    exceedsBytes: sizeCheck.exceedsBytes,
  };
}

/**
 * Truncate memory index by removing oldest entries.
 * Preserves most recent memories and archives removed entries.
 */
export function truncateMemoryEntries(
  entries: MemoryEntry[],
  archiveDir?: string,
): MemoryTruncationResult {
  const check = checkNeedsTruncation(entries);

  if (!check.needsTruncation) {
    return {
      truncated: false,
      linesBefore: check.lines,
      linesAfter: check.lines,
      bytesBefore: check.bytes,
      bytesAfter: check.bytes,
      entriesRemoved: 0,
    };
  }

  // Sort by creation time (most recent first)
  const sorted = [...entries].toSorted((a, b) => b.createdAt - a.createdAt);

  let removed: MemoryEntry[] = [];
  let kept: MemoryEntry[] = sorted;

  // Remove oldest entries until size constraints satisfied
  while (kept.length > 0) {
    const content = buildMemoryIndexContent(kept);
    const size = checkMemoryIndexSize(content);

    if (!size.exceedsLines && !size.exceedsBytes) {
      break;
    }

    // Remove the oldest entry from kept
    const oldest = kept.pop();
    if (oldest) {
      removed.push(oldest);
    }
  }

  // Archive removed entries if directory provided
  let archivedFiles: string[] = [];
  if (archiveDir && removed.length > 0) {
    archivedFiles = archiveEntries(removed, archiveDir);
  }

  const finalContent = buildMemoryIndexContent(kept);
  const finalSize = checkMemoryIndexSize(finalContent);

  log.info(
    `Truncated memory index: removed ${removed.length} entries, ` +
      `${check.bytes} -> ${finalSize.bytes} bytes, ` +
      `${check.lines} -> ${finalSize.lines} lines`,
  );

  return {
    truncated: true,
    linesBefore: check.lines,
    linesAfter: finalSize.lines,
    bytesBefore: check.bytes,
    bytesAfter: finalSize.bytes,
    entriesRemoved: removed.length,
    archived: archivedFiles,
  };
}

// ============================================================================
// Archive Management
// ============================================================================

/**
 * Archive removed memory entries to timestamped file.
 */
export function archiveEntries(entries: MemoryEntry[], archiveDir: string): string[] {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveFile = path.join(archiveDir, `memory-archive-${timestamp}.md`);
  const content = buildMemoryIndexContent(entries);

  // Create archive directory and write file asynchronously
  fs.mkdir(archiveDir, { recursive: true })
    .then(() => fs.writeFile(archiveFile, content, "utf-8"))
    .catch((err) => {
      log.warn(`Failed to archive memory entries: ${err.message}`);
    });

  return [archiveFile];
}

/**
 * Clean up old archive files.
 */
export async function cleanOldArchives(
  archiveDir: string,
  maxAgeDays: number = 30,
): Promise<number> {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  try {
    const files = await fs.readdir(archiveDir);
    let cleaned = 0;

    for (const file of files) {
      if (!file.startsWith("memory-archive-") || !file.endsWith(".md")) {
        continue;
      }

      const filePath = path.join(archiveDir, file);
      const stat = await fs.stat(filePath);

      if (now - stat.mtimeMs > maxAgeMs) {
        await fs.unlink(filePath);
        cleaned++;
        log.debug(`Cleaned old archive: ${file}`);
      }
    }

    if (cleaned > 0) {
      log.info(`Cleaned ${cleaned} old archive files`);
    }

    return cleaned;
  } catch (err) {
    log.warn(`Failed to clean archives: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

// ============================================================================
// Memory Budget Management
// ============================================================================

/**
 * Calculate memory budget for a given context window.
 */
export function calculateMemoryBudget(contextWindowTokens: number): {
  maxLines: number;
  maxBytes: number;
  estimatedTokens: number;
} {
  // Rough estimate: ~4 chars per token, ~80 chars per line
  const charsPerToken = 4;
  const charsPerLine = 80;

  // Memory index should use at most 10% of context window
  const maxMemoryTokens = Math.floor(contextWindowTokens * 0.1);
  const maxMemoryBytes = maxMemoryTokens * charsPerToken;
  const maxMemoryLines = Math.floor(maxMemoryBytes / charsPerLine);

  return {
    maxLines: Math.min(maxMemoryLines, MAX_MEMORY_INDEX_LINES),
    maxBytes: Math.min(maxMemoryBytes, MAX_MEMORY_INDEX_BYTES),
    estimatedTokens: maxMemoryTokens,
  };
}

/**
 * Estimate token count for memory entries.
 */
export function estimateMemoryTokens(entries: MemoryEntry[]): number {
  const content = buildMemoryIndexContent(entries);
  // Rough estimate: ~4 chars per token
  return Math.ceil(content.length / 4);
}

// ============================================================================
// Smart Truncation Strategies
// ============================================================================

/**
 * Truncation priority levels for entries.
 */
export type TruncationPriority = "high" | "medium" | "low";

/**
 * Get truncation priority for a memory entry.
 * Higher priority entries are preserved during truncation.
 */
export function getTruncationPriority(entry: MemoryEntry): TruncationPriority {
  const ageMs = Date.now() - entry.createdAt;
  const ageHours = ageMs / (60 * 60 * 1000);

  // User and feedback types are high priority
  if (entry.type === "user" || entry.type === "feedback") {
    // Very old user memories might be medium priority
    if (ageHours > 24 * 7) {
      // older than 1 week
      return "medium";
    }
    return "high";
  }

  // Project memories are medium priority
  if (entry.type === "project") {
    // Very recent project memories are high priority
    if (ageHours < 24) {
      // less than 1 day old
      return "high";
    }
    return "medium";
  }

  // Reference memories are low priority
  if (entry.type === "reference") {
    return "low";
  }

  return "medium";
}

/**
 * Truncate memory entries with priority-based selection.
 * Preserves high priority entries when possible.
 */
export function truncateWithPriority(
  entries: MemoryEntry[],
  archiveDir?: string,
): MemoryTruncationResult {
  const check = checkNeedsTruncation(entries);

  if (!check.needsTruncation) {
    return {
      truncated: false,
      linesBefore: check.lines,
      linesAfter: check.lines,
      bytesBefore: check.bytes,
      bytesAfter: check.bytes,
      entriesRemoved: 0,
    };
  }

  // Sort by priority (high first) then by creation time (recent first)
  const sorted = [...entries].toSorted((a, b) => {
    const priorityA = getTruncationPriority(a);
    const priorityB = getTruncationPriority(b);

    // Priority order: high > medium > low
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    if (priorityOrder[priorityA] !== priorityOrder[priorityB]) {
      return priorityOrder[priorityA] - priorityOrder[priorityB];
    }

    // Same priority: prefer recent
    return b.createdAt - a.createdAt;
  });

  let removed: MemoryEntry[] = [];
  let kept: MemoryEntry[] = sorted;

  // Remove low priority entries first
  while (kept.length > 0) {
    const content = buildMemoryIndexContent(kept);
    const size = checkMemoryIndexSize(content);

    if (!size.exceedsLines && !size.exceedsBytes) {
      break;
    }

    // Remove from end (lowest priority/oldest)
    const entry = kept.pop();
    if (entry) {
      removed.push(entry);
    }
  }

  // Archive removed entries
  let archivedFiles: string[] = [];
  if (archiveDir && removed.length > 0) {
    archivedFiles = archiveEntries(removed, archiveDir);
  }

  const finalContent = buildMemoryIndexContent(kept);
  const finalSize = checkMemoryIndexSize(finalContent);

  log.info(
    `Priority-based truncation: removed ${removed.length} entries, ` +
      `preserved ${kept.length} high-priority entries`,
  );

  return {
    truncated: true,
    linesBefore: check.lines,
    linesAfter: finalSize.lines,
    bytesBefore: check.bytes,
    bytesAfter: finalSize.bytes,
    entriesRemoved: removed.length,
    archived: archivedFiles,
  };
}
