/**
 * Tests for skills query tool.
 *
 * Tests the skills list and view functionality.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createSkillsQueryTool } from "./skills-query-tool.js";

// Helper to create temp directory with skill
async function createTempSkillDir(skillName: string, skillContent: string): Promise<string> {
  const baseDir = path.join(os.tmpdir(), "skills-query-test");
  const testDir = path.join(baseDir, `test-${Date.now()}`);
  const skillDir = path.join(testDir, "skills", skillName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), skillContent, "utf-8");
  return testDir;
}

// Helper to clean up temp directory
async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// Helper to extract result
function extractResult(result: unknown): Record<string, unknown> {
  if (typeof result === "object" && result !== null && "content" in result) {
    const content = (result as { content: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text" &&
          "text" in block
        ) {
          try {
            return JSON.parse(String(block.text)) as Record<string, unknown>;
          } catch {
            return { raw: String(block.text) };
          }
        }
      }
    }
  }
  return {};
}

const VALID_SKILL_CONTENT = `---
name: test-skill
description: A test skill for unit testing
---

# Test Skill

This is a test skill content.

## Steps

1. First step
2. Second step

## Pitfalls

- Be careful with X
`;

describe("skills-query-tool", () => {
  describe("createSkillsQueryTool", () => {
    it("should create tool with correct name", () => {
      const tool = createSkillsQueryTool();
      expect(tool.name).toBe("skills");
      expect(tool.label).toBe("skills");
    });

    it("should create tool with description", () => {
      const tool = createSkillsQueryTool();
      expect(tool.description).toContain("Query available skills");
      expect(tool.description).toContain("list");
      expect(tool.description).toContain("view");
    });

    it("should create tool with parameters schema", () => {
      const tool = createSkillsQueryTool();
      expect(tool.parameters).toBeDefined();
    });

    it("should create tool with workspace context", () => {
      const workspaceDir = "/tmp/test-workspace";
      const tool = createSkillsQueryTool({ workspaceDir });
      expect(tool.name).toBe("skills");
    });
  });

  describe("skills operations", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await createTempSkillDir("test-skill", VALID_SKILL_CONTENT);
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it("should execute list action", async () => {
      const tool = createSkillsQueryTool({ workspaceDir: tempDir });
      const result = await tool.execute("test-id", {
        action: "list",
      });

      const parsed = extractResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.count).toBeDefined();
    });

    it("should execute list action with verbose", async () => {
      const tool = createSkillsQueryTool({ workspaceDir: tempDir });
      const result = await tool.execute("test-id", {
        action: "list",
        verbose: true,
      });

      const parsed = extractResult(result);
      expect(parsed.success).toBe(true);
    });

    it("should execute view action", async () => {
      const tool = createSkillsQueryTool({ workspaceDir: tempDir });
      const result = await tool.execute("test-id", {
        action: "view",
        name: "test-skill",
      });

      const parsed = extractResult(result);
      expect(parsed.success).toBe(true);
      expect(parsed.name).toBe("test-skill");
      expect(parsed.content).toBeDefined();
    });

    it("should return error for missing skill name in view", async () => {
      const tool = createSkillsQueryTool({ workspaceDir: tempDir });
      const result = await tool.execute("test-id", {
        action: "view",
      });

      const parsed = extractResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("name required");
    });

    it("should return error for non-existent skill", async () => {
      const tool = createSkillsQueryTool({ workspaceDir: tempDir });
      const result = await tool.execute("test-id", {
        action: "view",
        name: "non-existent-skill",
      });

      const parsed = extractResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("not found");
    });

    it("should return error for unknown action", async () => {
      const tool = createSkillsQueryTool({ workspaceDir: tempDir });
      const result = await tool.execute("test-id", {
        action: "unknown",
      });

      const parsed = extractResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("Unknown action");
    });

    it("should return error without workspace directory", async () => {
      const tool = createSkillsQueryTool();
      const result = await tool.execute("test-id", {
        action: "list",
      });

      const parsed = extractResult(result);
      expect(parsed.success).toBe(false);
      expect(parsed.error).toContain("No workspace directory");
    });

    it("should handle workspace without local skills", async () => {
      const emptyDir = path.join(os.tmpdir(), "skills-query-empty", `test-${Date.now()}`);
      await fs.mkdir(emptyDir, { recursive: true });

      const tool = createSkillsQueryTool({ workspaceDir: emptyDir });
      const result = await tool.execute("test-id", {
        action: "list",
      });

      const parsed = extractResult(result);
      expect(parsed.success).toBe(true);
      // Note: OpenClaw has bundled skills, so count won't be 0 even for empty workspace
      // We just verify the tool works without crashing
      expect(parsed.count).toBeDefined();
      expect(parsed.skills).toBeDefined();

      await cleanupTempDir(emptyDir);
    });
  });
});
