/**
 * Memory system types.
 *
 * Adapted from Claude Code's memdir.ts for OpenClaw's memory management.
 * Provides structured memory storage with type constraints and truncation.
 */

// ============================================================================
// Memory Types
// ============================================================================

/**
 * Allowed memory content types.
 * Memories must be classified into one of these categories.
 */
export const MEMORY_TYPES = [
  "user", // User preferences, habits, communication style
  "feedback", // User feedback, corrections, preferences
  "project", // Project-specific knowledge, architecture decisions
  "reference", // External references, documentation links, standards
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * Memory content with type classification.
 */
export type MemoryContent = {
  /** Type classification */
  type: MemoryType;
  /** Memory content text */
  content: string;
  /** Timestamp when memory was created */
  createdAt?: number;
  /** Timestamp when memory was last updated */
  updatedAt?: number;
  /** Source of the memory (agent, session, plugin) */
  source?: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
};

/**
 * Memory entry in the index.
 */
export type MemoryEntry = {
  /** Unique identifier */
  id: string;
  /** Type classification */
  type: MemoryType;
  /** Brief description/summary */
  summary: string;
  /** Content hash for deduplication */
  contentHash?: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt?: number;
  /** Source identifier */
  source?: string;
};

// ============================================================================
// Memory Index Types
// ============================================================================

/**
 * Memory index structure.
 * The main entrypoint file that lists all memories.
 */
export type MemoryIndex = {
  /** Project memories (shared across all agents) */
  project?: MemoryEntry[];
  /** Agent-specific memories */
  agents?: Record<string, MemoryEntry[]>;
  /** Session-specific memories (temporary) */
  sessions?: Record<string, MemoryEntry[]>;
  /** Last update timestamp */
  lastUpdatedAt?: number;
  /** Version for compatibility tracking */
  version?: number;
};

/**
 * Memory index file content with metadata.
 */
export type MemoryIndexFile = {
  /** Header comment */
  header?: string;
  /** Memory entries */
  entries: MemoryEntry[];
  /** Total size in bytes */
  totalBytes?: number;
  /** Total lines */
  totalLines?: number;
};

// ============================================================================
// Truncation Constraints
// ============================================================================

/**
 * Maximum lines in memory index.
 * Claude Code uses MAX_MEMORY_INDEX_LINES = 200.
 */
export const MAX_MEMORY_INDEX_LINES = 200;

/**
 * Maximum bytes in memory index.
 * Claude Code uses MAX_MEMORY_INDEX_BYTES = 25_000.
 */
export const MAX_MEMORY_INDEX_BYTES = 25_000;

/**
 * Maximum chars per memory summary.
 */
export const MAX_MEMORY_SUMMARY_CHARS = 500;

/**
 * Maximum chars per memory content.
 */
export const MAX_MEMORY_CONTENT_CHARS = 5_000;

/**
 * Maximum age for session memories (milliseconds).
 */
export const SESSION_MEMORY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ============================================================================
// Exclusion Boundaries
// ============================================================================

/**
 * Content patterns that should NOT be stored in memory.
 * These are transient or technical details that don't belong in long-term memory.
 */
export const MEMORY_EXCLUSION_PATTERNS = [
  // Code patterns - transient implementation details
  "function",
  "class",
  "interface",
  "const",
  "let",
  "var",
  "import",
  "export",
  // Git history - transient version control info
  "git log",
  "git diff",
  "git commit",
  "commit hash",
  "branch name",
  // Task details - transient operational data
  "task id",
  "job id",
  "process id",
  "thread id",
  // Temporary data
  "tmp",
  "temp",
  "cache",
  "buffer",
] as const;

export type MemoryExclusionPattern = (typeof MEMORY_EXCLUSION_PATTERNS)[number];

// ============================================================================
// Memory Scope Types
// ============================================================================

/**
 * Memory scope level.
 */
export type MemoryScope = "project" | "agent" | "session";

/**
 * Memory location configuration.
 */
export type MemoryLocation = {
  /** Scope level */
  scope: MemoryScope;
  /** Directory path */
  path: string;
  /** Agent ID (for agent scope) */
  agentId?: string;
  /** Session key (for session scope) */
  sessionKey?: string;
};

// ============================================================================
// Memory Operation Types
// ============================================================================

/**
 * Result of memory write operation.
 */
export type MemoryWriteResult = {
  /** Whether write succeeded */
  success: boolean;
  /** Number of entries written */
  entriesWritten: number;
  /** Number of entries truncated */
  entriesTruncated?: number;
  /** Bytes before write */
  bytesBefore?: number;
  /** Bytes after write */
  bytesAfter?: number;
  /** Error message if failed */
  error?: string;
};

/**
 * Result of memory truncation.
 */
export type MemoryTruncationResult = {
  /** Whether truncation occurred */
  truncated: boolean;
  /** Lines before truncation */
  linesBefore: number;
  /** Lines after truncation */
  linesAfter: number;
  /** Bytes before truncation */
  bytesBefore: number;
  /** Bytes after truncation */
  bytesAfter: number;
  /** Entries removed */
  entriesRemoved: number;
  /** Truncated entries archived */
  archived?: string[];
};

// ============================================================================
// Memory Query Types
// ============================================================================

/**
 * Memory query parameters.
 */
export type MemoryQuery = {
  /** Filter by type */
  type?: MemoryType;
  /** Filter by scope */
  scope?: MemoryScope;
  /** Filter by source */
  source?: string;
  /** Text search */
  search?: string;
  /** Maximum results */
  limit?: number;
};

/**
 * Memory query result.
 */
export type MemoryQueryResult = {
  /** Matching entries */
  entries: MemoryEntry[];
  /** Total matching count (before limit) */
  total: number;
  /** Query duration in ms */
  durationMs?: number;
};

// ============================================================================
// Memory Update Types
// ============================================================================

/**
 * Memory update operation.
 */
export type MemoryUpdate = {
  /** Operation type */
  type: "add" | "update" | "remove";
  /** Entry to operate on */
  entry?: MemoryEntry;
  /** Entry ID (for update/remove) */
  id?: string;
  /** Scope to apply update */
  scope?: MemoryScope;
};
