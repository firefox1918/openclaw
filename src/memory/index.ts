/**
 * Memory system module.
 *
 * Provides structured memory storage with type constraints,
 * automatic truncation, and scope-based organization.
 */

// Types and constants
export {
  MEMORY_TYPES,
  MEMORY_EXCLUSION_PATTERNS,
  MAX_MEMORY_INDEX_LINES,
  MAX_MEMORY_INDEX_BYTES,
  MAX_MEMORY_SUMMARY_CHARS,
  MAX_MEMORY_CONTENT_CHARS,
  SESSION_MEMORY_MAX_AGE_MS,
  type MemoryType,
  type MemoryContent,
  type MemoryEntry,
  type MemoryIndex,
  type MemoryIndexFile,
  type MemoryTruncationResult,
  type MemoryScope,
  type MemoryLocation,
  type MemoryWriteResult,
  type MemoryQuery,
  type MemoryQueryResult,
  type MemoryUpdate,
  type MemoryExclusionPattern,
} from "./memory-types.js";

// Index operations
export {
  parseMemoryEntry,
  formatMemoryEntry,
  readMemoryIndex,
  writeMemoryIndex,
  buildMemoryIndexContent,
  checkMemoryIndexSize,
  needsTruncation,
  truncateMemoryIndex,
  generateMemoryId,
  generateContentHash,
  isValidMemoryType,
  mergeMemoryEntries,
} from "./memory-index.js";

// Manager and operations
export {
  getDefaultMemoryDir,
  getMemoryFilePath,
  getArchiveDir,
  MemoryManager,
  createProjectMemoryManager,
  createAgentMemoryManager,
  createSessionMemoryManager,
  buildGlobalMemoryIndex,
} from "./memory-manager.js";

// Truncation utilities
export {
  truncateMemoryContent,
  truncateMemorySummary,
  checkNeedsTruncation,
  truncateMemoryEntries,
  archiveEntries,
  cleanOldArchives,
  calculateMemoryBudget,
  estimateMemoryTokens,
  getTruncationPriority,
  truncateWithPriority,
  type TruncationPriority,
} from "./memory-truncation.js";
