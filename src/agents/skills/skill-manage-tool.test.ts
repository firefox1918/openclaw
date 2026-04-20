/**
 * Tests for skill_manage tool.
 *
 * Tests the core skill management functionality:
 * - create: Create new skill with SKILL.md content
 * - edit: Full SKILL.md rewrite
 * - patch: Targeted find-and-replace
 * - delete: Remove skill
 * - write_file: Add supporting file
 * - remove_file: Remove supporting file
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createSkillManageTool,
  validateName,
  validateCategory,
  validateFrontmatter,
  validateContentSize,
  validateFilePath,
} from "./skill-manage-tool.js";

// Test fixtures
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

const INVALID_SKILL_NO_NAME = `---
description: Missing name field
---

Content here
`;

const INVALID_SKILL_NO_FRONTMATTER = `This content has no frontmatter.`;

const VALID_SKILL_PATCH_OLD = "First step";
const VALID_SKILL_PATCH_NEW = "Updated first step";

// Helper to create temp directory
async function createTempDir(): Promise<string> {
  const baseDir = path.join(os.tmpdir(), "skill-manage-test");
  const testDir = path.join(baseDir, `test-${Date.now()}`);
  await fs.mkdir(testDir, { recursive: true });
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

// Helper to extract text from tool result
function extractResultText(result: unknown): string {
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
          return String(block.text);
        }
      }
    }
  }
  return String(result);
}

describe("skill-manage-tool", () => {
  describe("validateName", () => {
    it("should accept valid names", () => {
      expect(validateName("my-skill")).toBeNull();
      expect(validateName("my_skill")).toBeNull();
      expect(validateName("my.skill")).toBeNull();
      expect(validateName("skill123")).toBeNull();
    });

    it("should reject invalid names", () => {
      expect(validateName("")).not.toBeNull();
      expect(validateName("MySkill")).not.toBeNull(); // uppercase
      expect(validateName("my skill")).not.toBeNull(); // space
      expect(validateName("a".repeat(65))).not.toBeNull(); // too long
    });
  });

  describe("validateCategory", () => {
    it("should accept valid categories", () => {
      expect(validateCategory(undefined)).toBeNull();
      expect(validateCategory("")).toBeNull();
      expect(validateCategory("devops")).toBeNull();
      expect(validateCategory("data-science")).toBeNull();
    });

    it("should reject invalid categories", () => {
      expect(validateCategory("invalid/path")).not.toBeNull();
      expect(validateCategory("invalid\\path")).not.toBeNull();
    });
  });

  describe("validateFrontmatter", () => {
    it("should accept valid frontmatter", () => {
      expect(validateFrontmatter(VALID_SKILL_CONTENT)).toBeNull();
    });

    it("should reject missing name field", () => {
      expect(validateFrontmatter(INVALID_SKILL_NO_NAME)).not.toBeNull();
    });

    it("should reject missing frontmatter", () => {
      expect(validateFrontmatter(INVALID_SKILL_NO_FRONTMATTER)).not.toBeNull();
    });

    it("should reject empty content", () => {
      expect(validateFrontmatter("")).not.toBeNull();
    });

    it("should reject unclosed frontmatter", () => {
      expect(validateFrontmatter("---\nname: test")).not.toBeNull();
    });
  });

  describe("validateContentSize", () => {
    it("should accept content within limit", () => {
      expect(validateContentSize("short content")).toBeNull();
    });

    it("should reject oversized content", () => {
      const largeContent = "a".repeat(101_000);
      expect(validateContentSize(largeContent)).not.toBeNull();
    });
  });

  describe("validateFilePath", () => {
    it("should accept valid file paths", () => {
      expect(validateFilePath("references/example.md")).toBeNull();
      expect(validateFilePath("templates/config.json")).toBeNull();
      expect(validateFilePath("scripts/run.sh")).toBeNull();
      expect(validateFilePath("assets/image.png")).toBeNull();
    });

    it("should reject invalid file paths", () => {
      expect(validateFilePath("")).not.toBeNull();
      expect(validateFilePath("../escape")).not.toBeNull();
      expect(validateFilePath("invalid/location")).not.toBeNull();
      expect(validateFilePath("references")).not.toBeNull(); // just directory
    });
  });

  describe("createSkillManageTool", () => {
    it("should create tool with correct name", () => {
      const tool = createSkillManageTool();
      expect(tool.name).toBe("skill_manage");
      expect(tool.label).toBe("skill_manage");
    });

    it("should create tool with description", () => {
      const tool = createSkillManageTool();
      expect(tool.description).toContain("Manage skills");
      expect(tool.description).toContain("create");
      expect(tool.description).toContain("delete");
    });

    it("should create tool with parameters schema", () => {
      const tool = createSkillManageTool();
      expect(tool.parameters).toBeDefined();
    });

    it("should create tool with workspace context", () => {
      const workspaceDir = "/tmp/test-workspace";
      const tool = createSkillManageTool({ workspaceDir });
      expect(tool.name).toBe("skill_manage");
    });
  });

  // Integration tests with temp directory
  describe("skill operations", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await createTempDir();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it("should execute create action", async () => {
      const tool = createSkillManageTool({ workspaceDir: tempDir });
      const uniqueName = `test-skill-${Date.now()}`;
      const result = await tool.execute("test-id", {
        action: "create",
        name: uniqueName,
        content: VALID_SKILL_CONTENT,
      });

      const resultText = extractResultText(result);
      expect(resultText).toContain("success");
      expect(resultText).toContain("true");
    });

    it("should reject duplicate skill names", async () => {
      const tool = createSkillManageTool({ workspaceDir: tempDir });
      const uniqueName = `duplicate-test-${Date.now()}`;

      // Create first skill
      await tool.execute("test-id-1", {
        action: "create",
        name: uniqueName,
        content: VALID_SKILL_CONTENT,
      });

      // Try to create duplicate
      const result = await tool.execute("test-id-2", {
        action: "create",
        name: uniqueName,
        content: VALID_SKILL_CONTENT,
      });

      const resultText = extractResultText(result);
      expect(resultText).toContain("already exists");
    });

    it("should execute delete action", async () => {
      const tool = createSkillManageTool({ workspaceDir: tempDir });
      const uniqueName = `delete-test-${Date.now()}`;

      // Create skill first
      await tool.execute("test-id-1", {
        action: "create",
        name: uniqueName,
        content: VALID_SKILL_CONTENT,
      });

      // Delete it
      const result = await tool.execute("test-id-2", {
        action: "delete",
        name: uniqueName,
      });

      const resultText = extractResultText(result);
      expect(resultText).toContain("deleted");
    });
  });
});
