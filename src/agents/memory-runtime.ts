/**
 * Memory runtime integration - bridges memory module to runtime.
 *
 * Provides:
 * - Memory prompt supplement builder for system prompt injection
 * - Project-level memory loading and formatting
 * - Session memory lifecycle hooks
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildGlobalMemoryIndex,
  createProjectMemoryManager,
  createSessionMemoryManager,
  type MemoryEntry,
  type MemoryManager,
} from "../memory/index.js";
import {
  registerMemoryPromptSupplement,
  type MemoryPromptSectionBuilder,
} from "../plugins/memory-state.js";

const log = createSubsystemLogger("memory/runtime");

// ============================================================================
// Memory Prompt Builder
// ============================================================================

/**
 * Format memory entries for system prompt injection.
 */
function formatMemoryEntriesForPrompt(entries: MemoryEntry[]): string[] {
  if (entries.length === 0) {
    return [];
  }

  const lines: string[] = ["## Memory", "", "Persistent context from MEMORY.md files:", ""];

  // Group by type for organized display
  const byType: Record<string, MemoryEntry[]> = {};
  for (const entry of entries) {
    if (!byType[entry.type]) {
      byType[entry.type] = [];
    }
    byType[entry.type].push(entry);
  }

  // Format each type group
  for (const [type, typeEntries] of Object.entries(byType)) {
    lines.push(`### ${type}`);
    for (const entry of typeEntries) {
      lines.push(`- ${entry.summary}`);
    }
    lines.push("");
  }

  return lines;
}

/**
 * Create a memory prompt supplement builder.
 */
function createMemoryPromptBuilder(memoryManager: MemoryManager): MemoryPromptSectionBuilder {
  return (params) => {
    // Skip if memory tools not available
    if (!params.availableTools.has("memory") && !params.availableTools.has("memory_add")) {
      return [];
    }

    try {
      const entries = memoryManager.getEntries();
      return formatMemoryEntriesForPrompt(entries);
    } catch (err) {
      log.warn(`Failed to get memory entries: ${String(err)}`);
      return [];
    }
  };
}

// ============================================================================
// Runtime Integration
// ============================================================================

/**
 * Initialize memory runtime integration.
 *
 * This should be called early in session startup to:
 * 1. Load project-level memory
 * 2. Register prompt supplement builder
 */
export async function initializeMemoryRuntime(params: {
  projectDir?: string;
  agentId?: string;
  sessionKey?: string;
}): Promise<{
  projectMemoryManager: MemoryManager;
  sessionMemoryManager?: MemoryManager;
}> {
  // Create project memory manager
  const projectMemoryManager = createProjectMemoryManager(params.projectDir);

  // Load project memory
  try {
    await projectMemoryManager.load();
    log.info(`Loaded project memory from ${projectMemoryManager.getFilePath()}`);
  } catch {
    // Memory file may not exist yet - that's OK
    log.info(`No existing project memory at ${projectMemoryManager.getFilePath()}`);
  }

  // Register prompt supplement builder
  const builder = createMemoryPromptBuilder(projectMemoryManager);
  registerMemoryPromptSupplement("memory-core", builder);

  // Create session memory manager if session key provided
  let sessionMemoryManager: MemoryManager | undefined;
  if (params.sessionKey) {
    sessionMemoryManager = createSessionMemoryManager(params.sessionKey, params.projectDir);
    try {
      await sessionMemoryManager.load();
      // Clean expired session memories
      const cleaned = await sessionMemoryManager.cleanExpired();
      if (cleaned > 0) {
        log.info(`Cleaned ${cleaned} expired session memories`);
      }
    } catch {
      log.info(`No existing session memory for ${params.sessionKey}`);
    }
  }

  return {
    projectMemoryManager,
    sessionMemoryManager,
  };
}

/**
 * Clean up session memory on session end.
 */
export async function cleanupSessionMemory(sessionMemoryManager: MemoryManager): Promise<void> {
  try {
    const cleaned = await sessionMemoryManager.cleanExpired();
    if (cleaned > 0) {
      log.info(`Cleaned ${cleaned} expired session memories on cleanup`);
    }
    // Ensure memory is saved
    await sessionMemoryManager.save();
  } catch (err) {
    log.warn(`Failed to cleanup session memory: ${String(err)}`);
  }
}

/**
 * Build global memory index for compaction.
 *
 * Returns formatted memory content that should be preserved during compaction.
 */
export async function buildMemoryPromptForCompaction(params: {
  projectMemoryManager: MemoryManager;
  agentId?: string;
}): Promise<string> {
  try {
    const globalIndex = await buildGlobalMemoryIndex({
      projectManager: params.projectMemoryManager,
    });

    const lines: string[] = [];

    // Add project memories
    if (globalIndex.project) {
      for (const entry of globalIndex.project) {
        lines.push(`[${entry.type}] ${entry.summary}`);
      }
    }

    // Add agent memories if available
    if (globalIndex.agents && params.agentId) {
      const agentEntries = globalIndex.agents[params.agentId];
      if (agentEntries) {
        for (const entry of agentEntries) {
          lines.push(`[${entry.type}] ${entry.summary}`);
        }
      }
    }

    return lines.join("\n");
  } catch (err) {
    log.warn(`Failed to build global memory index: ${String(err)}`);
    return "";
  }
}

/**
 * Get memory entries count for diagnostics.
 */
export function getMemoryStats(memoryManager: MemoryManager): {
  totalEntries: number;
  byType: Record<string, number>;
} {
  const entries = memoryManager.getEntries();
  const byType: Record<string, number> = {};

  for (const entry of entries) {
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;
  }

  return {
    totalEntries: entries.length,
    byType,
  };
}
