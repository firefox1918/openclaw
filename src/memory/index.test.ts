/**
 * Memory system tests.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  parseMemoryEntry,
  formatMemoryEntry,
  generateMemoryId,
  generateContentHash,
  isValidMemoryType,
  mergeMemoryEntries,
  buildMemoryIndexContent,
} from "./memory-index.js";
import {
  getDefaultMemoryDir,
  getMemoryFilePath,
  getArchiveDir,
  MemoryManager,
  createProjectMemoryManager,
  createAgentMemoryManager,
  createSessionMemoryManager,
} from "./memory-manager.js";
import {
  truncateMemoryContent,
  truncateMemorySummary,
  getTruncationPriority,
  calculateMemoryBudget,
  estimateMemoryTokens,
} from "./memory-truncation.js";
import {
  MEMORY_TYPES,
  MAX_MEMORY_INDEX_LINES,
  MAX_MEMORY_INDEX_BYTES,
  MAX_MEMORY_SUMMARY_CHARS,
  MAX_MEMORY_CONTENT_CHARS,
  SESSION_MEMORY_MAX_AGE_MS,
  type MemoryType,
  type MemoryEntry,
} from "./memory-types.js";

// ============================================================================
// Memory Types Tests
// ============================================================================

describe("Memory Types", () => {
  it("should define valid memory types", () => {
    expect(MEMORY_TYPES).toContain("user");
    expect(MEMORY_TYPES).toContain("feedback");
    expect(MEMORY_TYPES).toContain("project");
    expect(MEMORY_TYPES).toContain("reference");
    expect(MEMORY_TYPES.length).toBe(4);
  });

  it("should have correct truncation limits", () => {
    expect(MAX_MEMORY_INDEX_LINES).toBe(200);
    expect(MAX_MEMORY_INDEX_BYTES).toBe(25_000);
    expect(MAX_MEMORY_SUMMARY_CHARS).toBe(500);
    expect(MAX_MEMORY_CONTENT_CHARS).toBe(5_000);
    expect(SESSION_MEMORY_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// ============================================================================
// Memory Index Tests
// ============================================================================

describe("Memory Index Operations", () => {
  it("should parse valid memory entry", () => {
    const line = "- [user] Prefers dark mode (mem-123, 1700000000000)";
    const entry = parseMemoryEntry(line);
    expect(entry).toBeDefined();
    expect(entry?.type).toBe("user");
    expect(entry?.summary).toBe("Prefers dark mode");
    expect(entry?.id).toBe("mem-123");
    expect(entry?.createdAt).toBe(1700000000000);
  });

  it("should parse entry with source", () => {
    const line = "- [feedback] Use snake_case for variables (mem-456, 1700000000000, agent:test)";
    const entry = parseMemoryEntry(line);
    expect(entry).toBeDefined();
    expect(entry?.source).toBe("agent:test");
  });

  it("should reject invalid memory type", () => {
    const line = "- [invalid] Some content (mem-789, 1700000000000)";
    const entry = parseMemoryEntry(line);
    expect(entry).toBeUndefined();
  });

  it("should reject malformed entry", () => {
    const line = "not a valid entry format";
    const entry = parseMemoryEntry(line);
    expect(entry).toBeUndefined();
  });

  it("should format memory entry correctly", () => {
    const entry: MemoryEntry = {
      id: "mem-test",
      type: "user",
      summary: "Test summary",
      createdAt: 1700000000000,
    };
    const formatted = formatMemoryEntry(entry);
    expect(formatted).toBe("- [user] Test summary (mem-test, 1700000000000)");
  });

  it("should format entry with source", () => {
    const entry: MemoryEntry = {
      id: "mem-test",
      type: "feedback",
      summary: "Test summary",
      createdAt: 1700000000000,
      source: "agent:test",
    };
    const formatted = formatMemoryEntry(entry);
    expect(formatted).toContain("agent:test");
  });

  it("should truncate long summary", () => {
    const longSummary = "a".repeat(600);
    const entry: MemoryEntry = {
      id: "mem-test",
      type: "project",
      summary: longSummary,
      createdAt: 1700000000000,
    };
    const formatted = formatMemoryEntry(entry);
    expect(formatted.length).toBeLessThan(longSummary.length + 50);
    expect(formatted).toContain("...");
  });
});

describe("Memory Entry Helpers", () => {
  it("should generate unique memory IDs", () => {
    const id1 = generateMemoryId();
    const id2 = generateMemoryId();
    expect(id1).toMatch(/^mem-\d+-[a-z0-9]+$/);
    expect(id2).toMatch(/^mem-\d+-[a-z0-9]+$/);
    expect(id1).not.toBe(id2);
  });

  it("should generate content hash", () => {
    const hash1 = generateContentHash("test content");
    const hash2 = generateContentHash("test content");
    const hash3 = generateContentHash("different content");
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1.length).toBe(16);
  });

  it("should validate memory types", () => {
    expect(isValidMemoryType("user")).toBe(true);
    expect(isValidMemoryType("feedback")).toBe(true);
    expect(isValidMemoryType("invalid")).toBe(false);
  });

  it("should merge entries with deduplication", () => {
    const existing: MemoryEntry[] = [
      { id: "mem-1", type: "user", summary: "Existing", createdAt: 1, contentHash: "hash1" },
    ];
    const newEntries: MemoryEntry[] = [
      { id: "mem-2", type: "feedback", summary: "New", createdAt: 2, contentHash: "hash2" },
      { id: "mem-3", type: "user", summary: "Duplicate", createdAt: 3, contentHash: "hash1" },
    ];
    const merged = mergeMemoryEntries(existing, newEntries);
    expect(merged.length).toBe(2); // hash1 should not be added twice
  });
});

describe("Memory Index Content Builder", () => {
  it("should group entries by type", () => {
    const entries: MemoryEntry[] = [
      { id: "mem-1", type: "user", summary: "User 1", createdAt: 1 },
      { id: "mem-2", type: "feedback", summary: "Feedback 1", createdAt: 2 },
      { id: "mem-3", type: "user", summary: "User 2", createdAt: 3 },
    ];
    const content = buildMemoryIndexContent(entries);
    expect(content).toContain("## user");
    expect(content).toContain("## feedback");
  });

  it("should include header", () => {
    const entries: MemoryEntry[] = [];
    const content = buildMemoryIndexContent(entries);
    expect(content).toContain("# Memory Index");
  });
});

// ============================================================================
// Memory Manager Tests
// ============================================================================

describe("Memory Manager Paths", () => {
  it("should get default memory directory", () => {
    const dir = getDefaultMemoryDir();
    expect(dir).toBe(path.join(os.homedir(), ".openclaw", "memory"));
  });

  it("should get project memory file path", () => {
    const filePath = getMemoryFilePath({ scope: "project", path: "/test" });
    expect(filePath).toBe("/test/MEMORY.md");
  });

  it("should get agent memory file path", () => {
    const filePath = getMemoryFilePath({ scope: "agent", path: "/test", agentId: "agent-1" });
    expect(filePath).toBe("/test/agents/agent-1/MEMORY.md");
  });

  it("should get session memory file path", () => {
    const filePath = getMemoryFilePath({ scope: "session", path: "/test", sessionKey: "sess-1" });
    expect(filePath).toBe("/test/sessions/sess-1/MEMORY.md");
  });

  it("should throw for agent without agentId", () => {
    expect(() => getMemoryFilePath({ scope: "agent", path: "/test" })).toThrow("agentId required");
  });

  it("should throw for session without sessionKey", () => {
    expect(() => getMemoryFilePath({ scope: "session", path: "/test" })).toThrow(
      "sessionKey required",
    );
  });

  it("should get archive directory", () => {
    const archiveDir = getArchiveDir({ scope: "project", path: "/test" });
    expect(archiveDir).toBe("/test/archive");
  });
});

describe("Memory Manager Factory", () => {
  it("should create project memory manager", () => {
    const manager = createProjectMemoryManager("/test");
    expect(manager).toBeInstanceOf(MemoryManager);
    expect(manager.getLocation().scope).toBe("project");
  });

  it("should create agent memory manager", () => {
    const manager = createAgentMemoryManager("agent-1", "/test");
    expect(manager).toBeInstanceOf(MemoryManager);
    expect(manager.getLocation().scope).toBe("agent");
    expect(manager.getLocation().agentId).toBe("agent-1");
  });

  it("should create session memory manager", () => {
    const manager = createSessionMemoryManager("sess-1", "/test");
    expect(manager).toBeInstanceOf(MemoryManager);
    expect(manager.getLocation().scope).toBe("session");
    expect(manager.getLocation().sessionKey).toBe("sess-1");
  });
});

// ============================================================================
// Truncation Tests
// ============================================================================

describe("Memory Content Truncation", () => {
  it("should truncate content to max chars", () => {
    const longContent = "a".repeat(6000);
    const truncated = truncateMemoryContent(longContent);
    expect(truncated.length).toBe(MAX_MEMORY_CONTENT_CHARS);
    expect(truncated.endsWith("...")).toBe(true);
  });

  it("should not truncate short content", () => {
    const shortContent = "short content";
    const truncated = truncateMemoryContent(shortContent);
    expect(truncated).toBe(shortContent);
  });

  it("should truncate summary to max chars", () => {
    const longSummary = "a".repeat(600);
    const truncated = truncateMemorySummary(longSummary);
    expect(truncated.length).toBe(MAX_MEMORY_SUMMARY_CHARS);
    expect(truncated.endsWith("...")).toBe(true);
  });
});

describe("Truncation Priority", () => {
  it("should give high priority to user memories", () => {
    const entry: MemoryEntry = {
      id: "mem-1",
      type: "user",
      summary: "Test",
      createdAt: Date.now(),
    };
    expect(getTruncationPriority(entry)).toBe("high");
  });

  it("should give high priority to feedback memories", () => {
    const entry: MemoryEntry = {
      id: "mem-1",
      type: "feedback",
      summary: "Test",
      createdAt: Date.now(),
    };
    expect(getTruncationPriority(entry)).toBe("high");
  });

  it("should give medium priority to old user memories", () => {
    const oldTimestamp = Date.now() - (7 * 24 * 60 * 60 * 1000 + 1000); // 1 week + 1 sec
    const entry: MemoryEntry = {
      id: "mem-1",
      type: "user",
      summary: "Test",
      createdAt: oldTimestamp,
    };
    expect(getTruncationPriority(entry)).toBe("medium");
  });

  it("should give high priority to recent project memories", () => {
    const recentTimestamp = Date.now() - 12 * 60 * 60 * 1000; // 12 hours ago
    const entry: MemoryEntry = {
      id: "mem-1",
      type: "project",
      summary: "Test",
      createdAt: recentTimestamp,
    };
    expect(getTruncationPriority(entry)).toBe("high");
  });

  it("should give medium priority to old project memories", () => {
    const oldTimestamp = Date.now() - (24 * 60 * 60 * 1000 + 1000); // 1 day + 1 sec
    const entry: MemoryEntry = {
      id: "mem-1",
      type: "project",
      summary: "Test",
      createdAt: oldTimestamp,
    };
    expect(getTruncationPriority(entry)).toBe("medium");
  });

  it("should give low priority to reference memories", () => {
    const entry: MemoryEntry = {
      id: "mem-1",
      type: "reference",
      summary: "Test",
      createdAt: Date.now(),
    };
    expect(getTruncationPriority(entry)).toBe("low");
  });
});

describe("Memory Budget", () => {
  it("should calculate memory budget for context window", () => {
    const budget = calculateMemoryBudget(200_000);
    expect(budget.maxLines).toBeLessThanOrEqual(MAX_MEMORY_INDEX_LINES);
    expect(budget.maxBytes).toBeLessThanOrEqual(MAX_MEMORY_INDEX_BYTES);
    expect(budget.estimatedTokens).toBeLessThan(200_000);
  });

  it("should estimate tokens from entries", () => {
    const entries: MemoryEntry[] = [
      { id: "mem-1", type: "user", summary: "Test entry 1", createdAt: 1 },
      { id: "mem-2", type: "feedback", summary: "Test entry 2", createdAt: 2 },
    ];
    const tokens = estimateMemoryTokens(entries);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(1000); // Small entries should have small tokens
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("Memory Manager Integration", () => {
  const tempDir = path.join(os.tmpdir(), "openclaw-memory-test-" + Date.now());

  beforeEach(async () => {
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should add and query memories", async () => {
    const manager = createProjectMemoryManager(tempDir);

    const result = await manager.add({
      type: "user",
      content: "User prefers dark mode",
    });

    expect(result.success).toBe(true);
    expect(result.entriesWritten).toBe(1);

    const queryResult = await manager.query({ type: "user" });
    expect(queryResult.total).toBe(1);
    expect(queryResult.entries[0].summary).toContain("dark mode");
  });

  it("should reject invalid memory type", async () => {
    const manager = createProjectMemoryManager(tempDir);

    const result = await manager.add({
      type: "invalid" as MemoryType,
      content: "Test content",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid memory type");
  });

  it("should query by source", async () => {
    const manager = createProjectMemoryManager(tempDir);

    await manager.add({
      type: "feedback",
      content: "Feedback from agent",
      source: "agent:test",
    });

    await manager.add({
      type: "feedback",
      content: "Feedback from user",
      source: "user",
    });

    const result = await manager.query({ source: "agent:test" });
    expect(result.total).toBe(1);
    expect(result.entries[0].source).toBe("agent:test");
  });

  it("should search in summaries", async () => {
    const manager = createProjectMemoryManager(tempDir);

    await manager.add({
      type: "project",
      content: "Architecture uses microservices pattern",
    });

    await manager.add({
      type: "project",
      content: "Database uses PostgreSQL",
    });

    const result = await manager.query({ search: "microservices" });
    expect(result.total).toBe(1);
    expect(result.entries[0].summary).toContain("microservices");
  });

  it("should remove memory by ID", async () => {
    const manager = createProjectMemoryManager(tempDir);

    await manager.add({
      type: "user",
      content: "Test memory to remove",
    });

    const entries = manager.getEntries();
    const id = entries[0].id;

    const removed = await manager.remove(id);
    expect(removed).toBe(true);

    const afterRemove = manager.getEntries();
    expect(afterRemove.length).toBe(0);
  });

  it("should not remove non-existent memory", async () => {
    const manager = createProjectMemoryManager(tempDir);

    const removed = await manager.remove("non-existent-id");
    expect(removed).toBe(false);
  });

  it("should apply limit to query results", async () => {
    const manager = createProjectMemoryManager(tempDir);

    for (let i = 0; i < 5; i++) {
      await manager.add({
        type: "reference",
        content: `Reference ${i}`,
      });
    }

    const result = await manager.query({ type: "reference", limit: 3 });
    expect(result.entries.length).toBe(3);
    expect(result.total).toBe(5);
  });
});
