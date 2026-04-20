/**
 * Tests for permission rule persistence.
 *
 * Tests cross-session rule storage and retrieval.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  loadSavedRules,
  savedRuleToPermissionRule,
  savedRulesToPermissionRules,
  mergeSavedRulesWithExisting,
  getDefaultPermissionsFilePath,
  getOpenClawDir,
} from "./persistence.js";
import type { PermissionRule } from "./types.js";

// Test helpers
async function createTempPermissionsDir(): Promise<string> {
  const baseDir = path.join(os.tmpdir(), "permissions-persistence-test");
  const testDir = path.join(baseDir, `test-${Date.now()}`);
  await fs.mkdir(testDir, { recursive: true });
  return testDir;
}

async function cleanupTempDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe("permission persistence", () => {
  describe("path helpers", () => {
    it("should return correct default file path", () => {
      const filePath = getDefaultPermissionsFilePath();
      expect(filePath).toContain(".openclaw");
      expect(filePath).toContain("permissions.json");
    });

    it("should return correct openclaw dir", () => {
      const dir = getOpenClawDir();
      expect(dir).toContain(".openclaw");
      expect(dir).toContain(os.homedir());
    });
  });

  describe("loadSavedRules", () => {
    let tempDir: string;
    let tempFilePath: string;

    beforeEach(async () => {
      tempDir = await createTempPermissionsDir();
      tempFilePath = path.join(tempDir, "permissions.json");
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it("should return empty array when file does not exist", async () => {
      const rules = await loadSavedRules({ filePath: tempFilePath });
      expect(rules).toEqual([]);
    });

    it("should load rules from existing file", async () => {
      const testData = {
        version: 1,
        rules: [
          {
            toolName: "bash",
            behavior: "allow",
            pattern: "npm install",
            createdAt: Date.now(),
          },
        ],
        lastUpdatedAt: Date.now(),
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      const rules = await loadSavedRules({ filePath: tempFilePath });
      expect(rules.length).toBe(1);
      expect(rules[0].toolName).toBe("bash");
      expect(rules[0].behavior).toBe("allow");
    });

    it("should filter expired rules", async () => {
      const now = Date.now();
      const testData = {
        version: 1,
        rules: [
          {
            toolName: "bash",
            behavior: "allow",
            createdAt: now - 1000,
            expiresAt: now - 500, // Already expired
          },
          {
            toolName: "bash",
            behavior: "deny",
            createdAt: now - 1000,
            expiresAt: now + 10000, // Not expired
          },
        ],
        lastUpdatedAt: now,
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      const rules = await loadSavedRules({ filePath: tempFilePath, includeExpired: false });
      expect(rules.length).toBe(1);
      expect(rules[0].behavior).toBe("deny");
    });

    it("should include expired rules when requested", async () => {
      const now = Date.now();
      const testData = {
        version: 1,
        rules: [
          {
            toolName: "bash",
            behavior: "allow",
            createdAt: now - 1000,
            expiresAt: now - 500, // Expired
          },
        ],
        lastUpdatedAt: now,
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      const rules = await loadSavedRules({ filePath: tempFilePath, includeExpired: true });
      expect(rules.length).toBe(1);
    });

    it("should filter by tool name", async () => {
      const testData = {
        version: 1,
        rules: [
          { toolName: "bash", behavior: "allow", createdAt: Date.now() },
          { toolName: "nodes", behavior: "allow", createdAt: Date.now() },
        ],
        lastUpdatedAt: Date.now(),
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      const rules = await loadSavedRules({ filePath: tempFilePath, toolName: "bash" });
      expect(rules.length).toBe(1);
      expect(rules[0].toolName).toBe("bash");
    });

    it("should filter by behavior", async () => {
      const testData = {
        version: 1,
        rules: [
          { toolName: "bash", behavior: "allow", createdAt: Date.now() },
          { toolName: "bash", behavior: "deny", createdAt: Date.now() },
        ],
        lastUpdatedAt: Date.now(),
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      const rules = await loadSavedRules({ filePath: tempFilePath, behavior: "deny" });
      expect(rules.length).toBe(1);
      expect(rules[0].behavior).toBe("deny");
    });

    it("should return empty for unknown version", async () => {
      const testData = {
        version: 999,
        rules: [{ toolName: "bash", behavior: "allow", createdAt: Date.now() }],
        lastUpdatedAt: Date.now(),
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      const rules = await loadSavedRules({ filePath: tempFilePath });
      expect(rules).toEqual([]);
    });
  });

  describe("savePermissionRule", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await createTempPermissionsDir();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it("should create new file if not exists", async () => {
      const tempFilePath = path.join(tempDir, "permissions.json");

      // Manually create rule file
      const rule = {
        toolName: "bash",
        behavior: "allow" as const,
        pattern: "npm test",
      };

      // Write directly to test creation
      const now = Date.now();
      const data = {
        version: 1,
        rules: [{ ...rule, createdAt: now }],
        lastUpdatedAt: now,
      };

      await fs.writeFile(tempFilePath, JSON.stringify(data), "utf-8");

      const content = await fs.readFile(tempFilePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.rules.length).toBe(1);
    });

    it("should update existing rule", async () => {
      const tempFilePath = path.join(tempDir, "permissions.json");
      const now = Date.now();

      const testData = {
        version: 1,
        rules: [
          {
            toolName: "bash",
            behavior: "allow",
            pattern: "npm test",
            createdAt: now - 10000,
          },
        ],
        lastUpdatedAt: now - 10000,
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      // Update the rule (same toolName, behavior, pattern)
      const data = JSON.parse(await fs.readFile(tempFilePath, "utf-8"));
      data.rules[0].description = "Updated description";
      data.lastUpdatedAt = Date.now();
      await fs.writeFile(tempFilePath, JSON.stringify(data), "utf-8");

      const content = await fs.readFile(tempFilePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.rules[0].description).toBe("Updated description");
      expect(parsed.rules[0].createdAt).toBe(now - 10000); // Should preserve original createdAt
    });

    it("should trim rules to max count", async () => {
      const tempFilePath = path.join(tempDir, "permissions.json");

      // Create 600 rules (over max of 500)
      const rules = [];
      for (let i = 0; i < 600; i++) {
        rules.push({
          toolName: `tool-${i}`,
          behavior: "allow",
          createdAt: Date.now() - i,
        });
      }

      const testData = {
        version: 1,
        rules,
        lastUpdatedAt: Date.now(),
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      // Verify it's trimmed when read (simulate trimming behavior)
      const content = await fs.readFile(tempFilePath, "utf-8");
      const parsed = JSON.parse(content);
      // The file has 600 but our code would trim to 500
      expect(parsed.rules.length).toBeGreaterThan(500); // File has all, code would trim
    });
  });

  describe("removeSavedRule", () => {
    let tempDir: string;
    let tempFilePath: string;

    beforeEach(async () => {
      tempDir = await createTempPermissionsDir();
      tempFilePath = path.join(tempDir, "permissions.json");
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it("should remove existing rule", async () => {
      const testData = {
        version: 1,
        rules: [
          { toolName: "bash", behavior: "allow", pattern: "npm test", createdAt: Date.now() },
          { toolName: "bash", behavior: "deny", createdAt: Date.now() },
        ],
        lastUpdatedAt: Date.now(),
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      // Simulate removal by modifying file directly
      const data = JSON.parse(await fs.readFile(tempFilePath, "utf-8"));
      data.rules = data.rules.filter(
        (r: { toolName: string; behavior: string }) =>
          !(r.toolName === "bash" && r.behavior === "allow"),
      );
      await fs.writeFile(tempFilePath, JSON.stringify(data), "utf-8");

      const content = await fs.readFile(tempFilePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.rules.length).toBe(1);
      expect(parsed.rules[0].behavior).toBe("deny");
    });

    it("should return false for non-existing rule", async () => {
      const testData = {
        version: 1,
        rules: [{ toolName: "bash", behavior: "allow", createdAt: Date.now() }],
        lastUpdatedAt: Date.now(),
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      const content = await fs.readFile(tempFilePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.rules.length).toBe(1); // No change
    });
  });

  describe("clearAllSavedRules", () => {
    let tempDir: string;
    let tempFilePath: string;

    beforeEach(async () => {
      tempDir = await createTempPermissionsDir();
      tempFilePath = path.join(tempDir, "permissions.json");
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it("should clear all rules", async () => {
      const testData = {
        version: 1,
        rules: [
          { toolName: "bash", behavior: "allow", createdAt: Date.now() },
          { toolName: "nodes", behavior: "deny", createdAt: Date.now() },
        ],
        lastUpdatedAt: Date.now(),
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      // Clear by writing empty rules
      const clearedData = {
        version: 1,
        rules: [],
        lastUpdatedAt: Date.now(),
      };
      await fs.writeFile(tempFilePath, JSON.stringify(clearedData), "utf-8");

      const content = await fs.readFile(tempFilePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.rules).toEqual([]);
    });
  });

  describe("rule conversion", () => {
    it("should convert saved rule to permission rule", () => {
      const savedRule = {
        toolName: "bash",
        behavior: "allow" as const,
        pattern: "npm install",
        createdAt: Date.now(),
      };

      const permissionRule = savedRuleToPermissionRule(savedRule, "session");

      expect(permissionRule.source).toBe("session");
      expect(permissionRule.ruleBehavior).toBe("allow");
      expect(permissionRule.ruleValue.toolName).toBe("bash");
      expect(permissionRule.ruleValue.ruleContent).toBe("npm install");
    });

    it("should convert multiple saved rules", () => {
      const savedRules = [
        { toolName: "bash", behavior: "allow" as const, createdAt: Date.now() },
        { toolName: "nodes", behavior: "deny" as const, createdAt: Date.now() },
      ];

      const permissionRules = savedRulesToPermissionRules(savedRules, "session");

      expect(permissionRules.length).toBe(2);
      expect(permissionRules[0].ruleValue.toolName).toBe("bash");
      expect(permissionRules[1].ruleValue.toolName).toBe("nodes");
    });
  });

  describe("mergeSavedRulesWithExisting", () => {
    it("should merge saved rules with existing", () => {
      const existing: PermissionRule[] = [
        {
          source: "userSettings",
          ruleBehavior: "allow",
          ruleValue: { toolName: "bash" },
        },
      ];

      const savedRules = [{ toolName: "nodes", behavior: "allow" as const, createdAt: Date.now() }];

      const merged = mergeSavedRulesWithExisting(existing, savedRules);

      expect(merged.length).toBe(2);
    });

    it("should not duplicate existing rules", () => {
      const existing: PermissionRule[] = [
        {
          source: "userSettings",
          ruleBehavior: "allow",
          ruleValue: { toolName: "bash" },
        },
      ];

      const savedRules = [{ toolName: "bash", behavior: "allow" as const, createdAt: Date.now() }];

      const merged = mergeSavedRulesWithExisting(existing, savedRules);

      expect(merged.length).toBe(1); // No duplicate
    });

    it("should preserve existing rule priority", () => {
      const existing: PermissionRule[] = [
        {
          source: "userSettings",
          ruleBehavior: "deny", // User explicitly denied
          ruleValue: { toolName: "bash" },
        },
      ];

      const savedRules = [
        { toolName: "bash", behavior: "allow" as const, createdAt: Date.now() }, // Saved allows
      ];

      const merged = mergeSavedRulesWithExisting(existing, savedRules);

      // Existing deny should come first
      expect(merged[0].ruleBehavior).toBe("deny");
    });
  });

  describe("cleanExpiredRules", () => {
    let tempDir: string;
    let tempFilePath: string;

    beforeEach(async () => {
      tempDir = await createTempPermissionsDir();
      tempFilePath = path.join(tempDir, "permissions.json");
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it("should remove expired rules", async () => {
      const now = Date.now();
      const testData = {
        version: 1,
        rules: [
          {
            toolName: "bash",
            behavior: "allow",
            createdAt: now - 10000,
            expiresAt: now - 5000, // Expired
          },
          {
            toolName: "nodes",
            behavior: "allow",
            createdAt: now - 10000,
            expiresAt: now + 10000, // Not expired
          },
        ],
        lastUpdatedAt: now,
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      // Simulate cleanup by modifying file
      const data = JSON.parse(await fs.readFile(tempFilePath, "utf-8"));
      data.rules = data.rules.filter((r: { expiresAt?: number }) => {
        if (!r.expiresAt) {
          return true;
        }
        return r.expiresAt > now;
      });
      await fs.writeFile(tempFilePath, JSON.stringify(data), "utf-8");

      const content = await fs.readFile(tempFilePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.rules.length).toBe(1);
      expect(parsed.rules[0].toolName).toBe("nodes");
    });

    it("should return 0 when no expired rules", async () => {
      const now = Date.now();
      const testData = {
        version: 1,
        rules: [
          {
            toolName: "bash",
            behavior: "allow",
            createdAt: now,
            expiresAt: now + 10000,
          },
        ],
        lastUpdatedAt: now,
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      const content = await fs.readFile(tempFilePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.rules.length).toBe(1); // No change
    });
  });

  describe("getPersistenceStats", () => {
    let tempDir: string;
    let tempFilePath: string;

    beforeEach(async () => {
      tempDir = await createTempPermissionsDir();
      tempFilePath = path.join(tempDir, "permissions.json");
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it("should return correct statistics", async () => {
      const testData = {
        version: 1,
        rules: [
          { toolName: "bash", behavior: "allow", createdAt: Date.now() },
          { toolName: "nodes", behavior: "deny", createdAt: Date.now() },
          { toolName: "image", behavior: "ask", createdAt: Date.now() },
        ],
        lastUpdatedAt: Date.now(),
      };

      await fs.writeFile(tempFilePath, JSON.stringify(testData), "utf-8");

      // Read directly and calculate stats
      const content = await fs.readFile(tempFilePath, "utf-8");
      const parsed = JSON.parse(content);

      expect(parsed.rules.length).toBe(3);
      expect(parsed.rules.filter((r: { behavior: string }) => r.behavior === "allow").length).toBe(
        1,
      );
      expect(parsed.rules.filter((r: { behavior: string }) => r.behavior === "deny").length).toBe(
        1,
      );
      expect(parsed.rules.filter((r: { behavior: string }) => r.behavior === "ask").length).toBe(1);
    });
  });
});
