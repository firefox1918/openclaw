/**
 * Memory manager - orchestrates memory operations.
 *
 * Provides high-level API for memory CRUD operations with
 * automatic truncation and type enforcement.
 */

import os from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  generateContentHash,
  generateMemoryId,
  isValidMemoryType,
  mergeMemoryEntries,
  needsTruncation,
  readMemoryIndex,
  truncateMemoryIndex,
  writeMemoryIndex,
} from "./memory-index.js";
import {
  MEMORY_EXCLUSION_PATTERNS,
  MEMORY_TYPES,
  MAX_MEMORY_CONTENT_CHARS,
  SESSION_MEMORY_MAX_AGE_MS,
  type MemoryContent,
  type MemoryEntry,
  type MemoryIndex,
  type MemoryLocation,
  type MemoryQuery,
  type MemoryQueryResult,
  type MemoryWriteResult,
} from "./memory-types.js";

const log = createSubsystemLogger("memory/manager");

// ============================================================================
// Memory Paths
// ============================================================================

/**
 * Get default memory directory for project-level memories.
 */
export function getDefaultMemoryDir(): string {
  return path.join(os.homedir(), ".openclaw", "memory");
}

/**
 * Get memory file path for a scope.
 */
export function getMemoryFilePath(location: MemoryLocation): string {
  const baseDir = location.path || getDefaultMemoryDir();

  switch (location.scope) {
    case "project":
      return path.join(baseDir, "MEMORY.md");
    case "agent":
      if (!location.agentId) {
        throw new Error("agentId required for agent scope");
      }
      return path.join(baseDir, "agents", location.agentId, "MEMORY.md");
    case "session":
      if (!location.sessionKey) {
        throw new Error("sessionKey required for session scope");
      }
      return path.join(baseDir, "sessions", location.sessionKey, "MEMORY.md");
    default:
      // Exhaustive check - should never reach
      throw new Error(`Unknown scope: ${location.scope as string}`);
  }
}

/**
 * Get archive directory for a scope.
 */
export function getArchiveDir(location: MemoryLocation): string {
  const filePath = getMemoryFilePath(location);
  return path.join(path.dirname(filePath), "archive");
}

// ============================================================================
// Memory Manager Implementation
// ============================================================================

/**
 * Memory manager for a specific scope.
 */
export class MemoryManager {
  private readonly location: MemoryLocation;
  private readonly filePath: string;
  private readonly archiveDir: string;
  private entries: MemoryEntry[] = [];
  private loaded: boolean = false;

  constructor(location: MemoryLocation) {
    this.location = location;
    this.filePath = getMemoryFilePath(location);
    this.archiveDir = getArchiveDir(location);
  }

  /**
   * Load memory index from file.
   */
  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const indexFile = await readMemoryIndex(this.filePath);
    this.entries = indexFile.entries;
    this.loaded = true;
  }

  /**
   * Get all entries.
   */
  getEntries(): MemoryEntry[] {
    return [...this.entries];
  }

  /**
   * Add a new memory.
   */
  async add(content: MemoryContent): Promise<MemoryWriteResult> {
    await this.load();

    // Validate type
    if (!isValidMemoryType(content.type)) {
      return {
        success: false,
        entriesWritten: 0,
        error: `Invalid memory type: ${String(content.type)}. Must be one of: ${MEMORY_TYPES.join(", ")}`,
      };
    }

    // Check for exclusion patterns
    if (containsExclusionPattern(content.content)) {
      return {
        success: false,
        entriesWritten: 0,
        error: "Content contains exclusion pattern and should not be stored",
      };
    }

    // Truncate content if needed
    const truncatedContent = truncateContent(content.content);

    // Create entry
    const now = Date.now();
    const entry: MemoryEntry = {
      id: generateMemoryId(),
      type: content.type,
      summary: extractSummary(truncatedContent),
      contentHash: generateContentHash(truncatedContent),
      createdAt: content.createdAt ?? now,
      updatedAt: now,
      source: content.source,
    };

    // Add to entries
    this.entries = mergeMemoryEntries(this.entries, [entry]);

    // Check if truncation needed
    const truncateResult = needsTruncation(this.entries);
    if (truncateResult) {
      const truncated = truncateMemoryIndex(this.entries, this.archiveDir);
      this.entries = this.entries.slice(0, this.entries.length - truncated.entriesRemoved);
      log.info(`Truncated ${truncated.entriesRemoved} entries to fit size limits`);
    }

    // Write to file
    await writeMemoryIndex(this.filePath, this.entries);

    return {
      success: true,
      entriesWritten: 1,
      entriesTruncated: truncateResult ? 1 : 0,
    };
  }

  /**
   * Query memories.
   */
  async query(params: MemoryQuery): Promise<MemoryQueryResult> {
    await this.load();

    let filtered = this.entries;

    // Filter by type
    if (params.type) {
      filtered = filtered.filter((e) => e.type === params.type);
    }

    // Filter by source
    if (params.source) {
      filtered = filtered.filter((e) => e.source === params.source);
    }

    // Search in summary
    if (params.search) {
      const searchLower = params.search.toLowerCase();
      filtered = filtered.filter((e) => e.summary.toLowerCase().includes(searchLower));
    }

    // Apply limit
    const total = filtered.length;
    if (params.limit && filtered.length > params.limit) {
      filtered = filtered.slice(0, params.limit);
    }

    return {
      entries: filtered,
      total,
    };
  }

  /**
   * Remove a memory by ID.
   */
  async remove(id: string): Promise<boolean> {
    await this.load();

    const index = this.entries.findIndex((e) => e.id === id);
    if (index < 0) {
      return false;
    }

    this.entries.splice(index, 1);
    await writeMemoryIndex(this.filePath, this.entries);
    return true;
  }

  /**
   * Clean expired session memories.
   */
  async cleanExpired(): Promise<number> {
    if (this.location.scope !== "session") {
      return 0;
    }

    await this.load();

    const now = Date.now();
    const expired = this.entries.filter((e) => now - e.createdAt > SESSION_MEMORY_MAX_AGE_MS);

    if (expired.length === 0) {
      return 0;
    }

    this.entries = this.entries.filter((e) => now - e.createdAt <= SESSION_MEMORY_MAX_AGE_MS);

    await writeMemoryIndex(this.filePath, this.entries);
    return expired.length;
  }

  /**
   * Force save current state.
   */
  async save(): Promise<void> {
    await writeMemoryIndex(this.filePath, this.entries);
  }

  /**
   * Get the memory file path.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Get the location.
   */
  getLocation(): MemoryLocation {
    return this.location;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a project-level memory manager.
 */
export function createProjectMemoryManager(baseDir?: string): MemoryManager {
  return new MemoryManager({
    scope: "project",
    path: baseDir || getDefaultMemoryDir(),
  });
}

/**
 * Create an agent-level memory manager.
 */
export function createAgentMemoryManager(agentId: string, baseDir?: string): MemoryManager {
  return new MemoryManager({
    scope: "agent",
    path: baseDir || getDefaultMemoryDir(),
    agentId,
  });
}

/**
 * Create a session-level memory manager.
 */
export function createSessionMemoryManager(sessionKey: string, baseDir?: string): MemoryManager {
  return new MemoryManager({
    scope: "session",
    path: baseDir || getDefaultMemoryDir(),
    sessionKey,
  });
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if content contains exclusion patterns.
 */
function containsExclusionPattern(content: string): boolean {
  const lowerContent = content.toLowerCase();
  for (const pattern of MEMORY_EXCLUSION_PATTERNS) {
    if (lowerContent.includes(pattern.toLowerCase())) {
      // Check if it's just a mention vs actual code
      // Simple heuristic: if pattern appears with keywords like 'function', 'class', etc.
      const codeIndicators = ["{", "}", "(", ")", ";", "=", "=>"];
      const hasCodeIndicators = codeIndicators.some((i) => content.includes(i));
      if (hasCodeIndicators) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Truncate content to max chars.
 */
function truncateContent(content: string): string {
  if (content.length <= MAX_MEMORY_CONTENT_CHARS) {
    return content;
  }
  return content.slice(0, MAX_MEMORY_CONTENT_CHARS - 3) + "...";
}

/**
 * Extract summary from content (first line or first 100 chars).
 */
function extractSummary(content: string): string {
  const firstLine = content.split("\n")[0] || "";
  if (firstLine.length <= 100) {
    return firstLine;
  }
  return firstLine.slice(0, 100);
}

// ============================================================================
// Global Memory Index
// ============================================================================

/**
 * Build a global memory index combining all scopes.
 */
export async function buildGlobalMemoryIndex(params: {
  projectManager?: MemoryManager;
  agentManagers?: Map<string, MemoryManager>;
}): Promise<MemoryIndex> {
  const index: MemoryIndex = {};

  // Load project memories
  if (params.projectManager) {
    await params.projectManager.load();
    index.project = params.projectManager.getEntries();
  }

  // Load agent memories
  if (params.agentManagers) {
    index.agents = {};
    for (const [agentId, manager] of params.agentManagers) {
      await manager.load();
      index.agents[agentId] = manager.getEntries();
    }
  }

  index.lastUpdatedAt = Date.now();
  index.version = 1;

  return index;
}
