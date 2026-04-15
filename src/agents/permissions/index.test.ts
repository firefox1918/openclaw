/**
 * Permission system tests.
 */

import { describe, expect, it } from "vitest";
import {
  checkPermission,
  createDefaultPermissionContext,
  createPermissionContextFromProfile,
  EXTERNAL_PERMISSION_MODES,
  isBypassPermissionsMode,
  isDefaultMode,
  isDontAskMode,
  isOperationAllowed,
  isPlanMode,
  modeAllowsBehavior,
  normalizeToolName,
  parseRuleString,
  permissionModeFromString,
  permissionModeTitle,
  ruleMatchesTool,
  sortRulesByPriority,
  TOOL_GROUPS,
} from "./index.js";
import type { PermissionProfile, ToolPermissionContext, PermissionRule } from "./types.js";

/**
 * Create a mutable permission context for testing.
 * Production code should use createDefaultPermissionContext() or createPermissionContextFromProfile().
 */
function createTestPermissionContext(
  overrides?: Partial<ToolPermissionContext>,
): ToolPermissionContext {
  const base = createDefaultPermissionContext();
  return {
    ...base,
    ...overrides,
  } as ToolPermissionContext;
}

describe("Permission Modes", () => {
  it("should have all expected external modes", () => {
    expect(EXTERNAL_PERMISSION_MODES).toContain("default");
    expect(EXTERNAL_PERMISSION_MODES).toContain("plan");
    expect(EXTERNAL_PERMISSION_MODES).toContain("acceptEdits");
    expect(EXTERNAL_PERMISSION_MODES).toContain("bypassPermissions");
    expect(EXTERNAL_PERMISSION_MODES).toContain("dontAsk");
  });

  it("should parse mode from string", () => {
    expect(permissionModeFromString("default")).toBe("default");
    expect(permissionModeFromString("plan")).toBe("plan");
    expect(permissionModeFromString("invalid")).toBe("default");
  });

  it("should get correct mode title", () => {
    expect(permissionModeTitle("default")).toBe("Default");
    expect(permissionModeTitle("plan")).toBe("Plan Mode");
    expect(permissionModeTitle("bypassPermissions")).toBe("Bypass Permissions");
  });

  it("should detect mode types correctly", () => {
    expect(isDefaultMode("default")).toBe(true);
    expect(isDefaultMode(undefined)).toBe(true);
    expect(isDefaultMode("plan")).toBe(false);

    expect(isPlanMode("plan")).toBe(true);
    expect(isPlanMode("default")).toBe(false);

    expect(isBypassPermissionsMode("bypassPermissions")).toBe(true);
    expect(isBypassPermissionsMode("default")).toBe(false);

    expect(isDontAskMode("dontAsk")).toBe(true);
    expect(isDontAskMode("bypassPermissions")).toBe(true); // bypass is also dontAsk
    expect(isDontAskMode("default")).toBe(false);
  });

  it("should check mode behavior correctly", () => {
    expect(modeAllowsBehavior("bypassPermissions", "read")).toBe(true);
    expect(modeAllowsBehavior("bypassPermissions", "write")).toBe(true);
    expect(modeAllowsBehavior("bypassPermissions", "execute")).toBe(true);

    expect(modeAllowsBehavior("plan", "read")).toBe(true);
    expect(modeAllowsBehavior("plan", "write")).toBe(false);
    expect(modeAllowsBehavior("plan", "execute")).toBe(false);

    expect(modeAllowsBehavior("acceptEdits", "write")).toBe(true);
    expect(modeAllowsBehavior("acceptEdits", "read")).toBe(false);

    expect(modeAllowsBehavior("default", "read")).toBe(false);
    expect(modeAllowsBehavior("default", "write")).toBe(false);
  });
});

describe("Rule Parsing", () => {
  it("should parse simple tool rule", () => {
    const rule = parseRuleString("bash");
    expect(rule).toEqual({ toolName: "bash" });
  });

  it("should parse rule with content", () => {
    const rule = parseRuleString("read:/etc/passwd");
    expect(rule).toEqual({ toolName: "read", ruleContent: "/etc/passwd" });
  });

  it("should handle empty rules", () => {
    expect(parseRuleString("")).toBeNull();
    expect(parseRuleString("   ")).toBeNull();
  });

  it("should normalize tool names", () => {
    expect(normalizeToolName("Bash")).toBe("bash");
    expect(normalizeToolName("  READ  ")).toBe("read");
  });
});

describe("Rule Matching", () => {
  it("should match exact tool names", () => {
    expect(ruleMatchesTool({ toolName: "bash" }, "bash")).toBe(true);
    expect(ruleMatchesTool({ toolName: "bash" }, "BASH")).toBe(true);
    expect(ruleMatchesTool({ toolName: "bash" }, "read")).toBe(false);
  });

  it("should match wildcards", () => {
    expect(ruleMatchesTool({ toolName: "*" }, "bash")).toBe(true);
    expect(ruleMatchesTool({ toolName: "all" }, "read")).toBe(true);
  });

  it("should match prefix patterns", () => {
    expect(ruleMatchesTool({ toolName: "bash:*" }, "bash")).toBe(true);
    expect(ruleMatchesTool({ toolName: "bash:*" }, "bash_exec")).toBe(true);
    expect(ruleMatchesTool({ toolName: "bash:*" }, "read")).toBe(false);
  });

  it("should match groups", () => {
    expect(ruleMatchesTool({ toolName: "group:dangerous" }, "bash")).toBe(true);
    expect(ruleMatchesTool({ toolName: "group:dangerous" }, "exec")).toBe(true);
    expect(ruleMatchesTool({ toolName: "group:filesystem" }, "read")).toBe(true);
    expect(ruleMatchesTool({ toolName: "group:filesystem" }, "bash")).toBe(false);
  });
});

describe("Rule Priority", () => {
  it("should sort deny before allow", () => {
    const rules: PermissionRule[] = [
      { source: "userSettings", ruleBehavior: "allow", ruleValue: { toolName: "bash" } },
      { source: "userSettings", ruleBehavior: "deny", ruleValue: { toolName: "bash" } },
    ];
    const sorted = sortRulesByPriority(rules);
    expect(sorted[0].ruleBehavior).toBe("deny");
    expect(sorted[1].ruleBehavior).toBe("allow");
  });

  it("should sort ask between deny and allow", () => {
    const rules: PermissionRule[] = [
      { source: "userSettings", ruleBehavior: "allow", ruleValue: { toolName: "bash" } },
      { source: "userSettings", ruleBehavior: "ask", ruleValue: { toolName: "bash" } },
      { source: "userSettings", ruleBehavior: "deny", ruleValue: { toolName: "bash" } },
    ];
    const sorted = sortRulesByPriority(rules);
    expect(sorted[0].ruleBehavior).toBe("deny");
    expect(sorted[1].ruleBehavior).toBe("ask");
    expect(sorted[2].ruleBehavior).toBe("allow");
  });

  it("should prioritize rules with content", () => {
    const rules: PermissionRule[] = [
      { source: "userSettings", ruleBehavior: "allow", ruleValue: { toolName: "bash" } },
      {
        source: "userSettings",
        ruleBehavior: "allow",
        ruleValue: { toolName: "bash", ruleContent: "/safe" },
      },
    ];
    const sorted = sortRulesByPriority(rules);
    expect(sorted[0].ruleValue.ruleContent).toBe("/safe");
  });
});

describe("Tool Groups", () => {
  it("should define dangerous group", () => {
    expect(TOOL_GROUPS.dangerous).toContain("bash");
    expect(TOOL_GROUPS.dangerous).toContain("exec");
    expect(TOOL_GROUPS.dangerous).toContain("terminal");
  });

  it("should define filesystem group", () => {
    expect(TOOL_GROUPS.filesystem).toContain("read");
    expect(TOOL_GROUPS.filesystem).toContain("write");
  });
});

describe("Permission Context", () => {
  it("should create default context", () => {
    const ctx = createDefaultPermissionContext();
    expect(ctx.mode).toBe("default");
    expect(ctx.isBypassPermissionsModeAvailable).toBe(false);
    expect(ctx.alwaysAllowRules).toEqual({});
    expect(ctx.alwaysDenyRules).toEqual({});
  });

  it("should create context from profile", () => {
    const profile: PermissionProfile = {
      id: "test-profile",
      name: "Test Profile",
      defaultMode: "plan",
      allow: [{ toolName: "read" }],
      deny: [{ toolName: "bash" }],
      bypassPermissionsAvailable: false,
      requiredScope: ["user"],
    };
    const ctx = createPermissionContextFromProfile(profile);
    expect(ctx.mode).toBe("plan");
    expect(ctx.activeProfileId).toBe("test-profile");
    expect(ctx.alwaysAllowRules.agentProfile).toContain("read");
    expect(ctx.alwaysDenyRules.agentProfile).toContain("bash");
  });
});

describe("Operation Allowed Check", () => {
  it("should allow in bypass mode", () => {
    const ctx = createTestPermissionContext({
      mode: "bypassPermissions",
      isBypassPermissionsModeAvailable: true,
    });
    expect(isOperationAllowed("bash", ctx)).toBe(true);
  });

  it("should deny in default mode without rules", () => {
    const ctx = createDefaultPermissionContext();
    expect(isOperationAllowed("bash", ctx)).toBe(false);
  });

  it("should allow based on rules", () => {
    const ctx = createTestPermissionContext({
      alwaysAllowRules: { userSettings: ["bash"] },
    });
    expect(isOperationAllowed("bash", ctx)).toBe(true);
    expect(isOperationAllowed("read", ctx)).toBe(false);
  });
});

describe("Permission Pipeline", () => {
  it("should deny in dontAsk mode", async () => {
    const ctx = createTestPermissionContext({ mode: "dontAsk" });
    const result = await checkPermission("bash", { command: "ls" }, ctx);
    expect(result.behavior).toBe("deny");
  });

  it("should allow in bypass mode", async () => {
    const ctx = createTestPermissionContext({
      mode: "bypassPermissions",
      isBypassPermissionsModeAvailable: true,
    });
    const result = await checkPermission("bash", { command: "ls" }, ctx);
    expect(result.behavior).toBe("allow");
  });

  it("should deny bypass when not available", async () => {
    const ctx = createTestPermissionContext({
      mode: "bypassPermissions",
      isBypassPermissionsModeAvailable: false,
    });
    const result = await checkPermission("bash", { command: "ls" }, ctx);
    expect(result.behavior).toBe("deny");
  });

  it("should prompt for write in plan mode", async () => {
    const ctx = createTestPermissionContext({ mode: "plan" });
    const result = await checkPermission("write", { path: "/tmp/test.txt" }, ctx, {
      operationType: "write",
    });
    expect(result.behavior).toBe("ask");
  });

  it("should allow read in plan mode", async () => {
    const ctx = createTestPermissionContext({ mode: "plan" });
    const result = await checkPermission("read", { path: "/tmp/test.txt" }, ctx, {
      operationType: "read",
    });
    expect(result.behavior).toBe("allow");
  });
});
