/**
 * Permission rule matching engine.
 *
 * Provides rule parsing, matching, and evaluation logic.
 * Adapted from Claude Code's PermissionRule.ts for OpenClaw.
 */

import type {
  PermissionBehavior,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
} from "./types.js";

// ============================================================================
// Rule Parsing
// ============================================================================

/**
 * Parse a rule string into a PermissionRuleValue.
 * Format: "toolName" or "toolName:ruleContent"
 */
export function parseRuleString(rule: string): PermissionRuleValue | null {
  const trimmed = rule.trim();
  if (!trimmed) {
    return null;
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex === -1) {
    return { toolName: trimmed };
  }

  const toolName = trimmed.slice(0, colonIndex).trim();
  const ruleContent = trimmed.slice(colonIndex + 1).trim();

  if (!toolName) {
    return null;
  }

  return { toolName, ruleContent };
}

/**
 * Parse an array of rule strings into PermissionRuleValue array.
 */
export function parseRuleStrings(rules: string[]): PermissionRuleValue[] {
  return rules.map(parseRuleString).filter((r): r is PermissionRuleValue => r !== null);
}

/**
 * Normalize a tool name for comparison.
 */
export function normalizeToolName(name: string): string {
  return name.toLowerCase().trim();
}

/**
 * Check if a rule value matches a tool name.
 */
export function ruleMatchesTool(rule: PermissionRuleValue, toolName: string): boolean {
  const normalizedRule = normalizeToolName(rule.toolName);
  const normalizedTool = normalizeToolName(toolName);

  // Exact match
  if (normalizedRule === normalizedTool) {
    return true;
  }

  // Wildcard match
  if (normalizedRule === "*" || normalizedRule === "all") {
    return true;
  }

  // Prefix match (e.g., "bash:*" matches all bash tool variants)
  if (normalizedRule.endsWith(":*")) {
    const prefix = normalizedRule.slice(0, -2);
    return normalizedTool.startsWith(prefix);
  }

  // Group match (e.g., "group:dangerous" matches tools in dangerous group)
  if (normalizedRule.startsWith("group:")) {
    const groupName = normalizedRule.slice(6);
    return isToolInGroup(normalizedTool, groupName);
  }

  return false;
}

/**
 * Check if a tool belongs to a named group.
 */
export function isToolInGroup(toolName: string, groupName: string): boolean {
  const groups = TOOL_GROUPS[groupName.toLowerCase()];
  if (!groups) {
    return false;
  }
  return groups.some((g) => normalizeToolName(g) === toolName);
}

/**
 * Tool groups for permission rules.
 */
export const TOOL_GROUPS: Record<string, string[]> = {
  dangerous: ["bash", "exec", "powershell", "shell", "terminal"],
  filesystem: ["read", "write", "edit", "glob", "grep", "ls"],
  network: ["webfetch", "websearch", "curl", "http"],
  control: ["agent", "task", "spawn", "fork"],
  info: ["status", "help", "version", "doctor"],
};

// ============================================================================
// Rule Matching
// ============================================================================

/**
 * Result of matching rules against a tool.
 */
export type RuleMatchResult = {
  /** Whether any rule matched */
  matched: boolean;
  /** The matching rule if found */
  rule?: PermissionRule;
  /** The behavior of the matching rule */
  behavior?: PermissionBehavior;
  /** All matching rules */
  allMatches: PermissionRule[];
};

/**
 * Find a matching rule from a list of rules.
 * Returns the first matching rule with highest priority.
 */
export function findMatchingRule(
  rules: PermissionRule[],
  toolName: string,
  ruleContent?: string,
): RuleMatchResult {
  const allMatches: PermissionRule[] = [];

  for (const rule of rules) {
    if (ruleMatchesTool(rule.ruleValue, toolName)) {
      // If rule has content, check if it matches
      if (rule.ruleValue.ruleContent && ruleContent) {
        if (!ruleContentMatches(rule.ruleValue.ruleContent, ruleContent)) {
          continue;
        }
      }
      allMatches.push(rule);
    }
  }

  if (allMatches.length === 0) {
    return { matched: false, allMatches: [] };
  }

  // Sort by priority: deny > ask > allow, then by specificity
  const sorted = sortRulesByPriority(allMatches);
  const topRule = sorted[0];

  return {
    matched: true,
    rule: topRule,
    behavior: topRule.ruleBehavior,
    allMatches: sorted,
  };
}

/**
 * Check if rule content matches the provided content.
 * Supports pattern matching with wildcards.
 */
export function ruleContentMatches(pattern: string, content: string): boolean {
  const normalizedPattern = pattern.toLowerCase().trim();
  const normalizedContent = content.toLowerCase().trim();

  // Exact match
  if (normalizedPattern === normalizedContent) {
    return true;
  }

  // Wildcard match
  if (normalizedPattern === "*" || normalizedPattern === "**") {
    return true;
  }

  // Simple glob pattern (supports * and ?)
  if (normalizedPattern.includes("*") || normalizedPattern.includes("?")) {
    return globMatch(normalizedPattern, normalizedContent);
  }

  // Prefix/suffix match
  if (normalizedPattern.startsWith("*")) {
    return normalizedContent.endsWith(normalizedPattern.slice(1));
  }
  if (normalizedPattern.endsWith("*")) {
    return normalizedContent.startsWith(normalizedPattern.slice(0, -1));
  }

  // Regex match (if pattern starts with ^)
  if (normalizedPattern.startsWith("^")) {
    try {
      const regex = new RegExp(normalizedPattern);
      return regex.test(normalizedContent);
    } catch {
      return false;
    }
  }

  // Substring match
  return normalizedContent.includes(normalizedPattern);
}

/**
 * Simple glob pattern matching.
 */
function globMatch(pattern: string, text: string): boolean {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");

  try {
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(text);
  } catch {
    return false;
  }
}

/**
 * Sort rules by priority.
 * Priority order: deny > ask > allow, then by specificity (more specific first).
 */
export function sortRulesByPriority(rules: PermissionRule[]): PermissionRule[] {
  return rules.toSorted((a, b) => {
    // Behavior priority: deny > ask > allow
    const behaviorPriority = { deny: 0, ask: 1, allow: 2 };
    const aPriority = behaviorPriority[a.ruleBehavior];
    const bPriority = behaviorPriority[b.ruleBehavior];

    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    // Specificity: rules with content are more specific
    const aHasContent = a.ruleValue.ruleContent ? 1 : 0;
    const bHasContent = b.ruleValue.ruleContent ? 1 : 0;

    if (aHasContent !== bHasContent) {
      return bHasContent - aHasContent; // More specific first
    }

    // Source priority: session > command > cliArg > projectSettings > userSettings
    const sourcePriority: Record<PermissionRuleSource, number> = {
      session: 0,
      command: 1,
      cliArg: 2,
      policySettings: 3,
      localSettings: 4,
      projectSettings: 5,
      userSettings: 6,
      flagSettings: 7,
      agentProfile: 8,
    };
    const aSourcePriority = sourcePriority[a.source] ?? 99;
    const bSourcePriority = sourcePriority[b.source] ?? 99;

    return aSourcePriority - bSourcePriority;
  });
}

// ============================================================================
// Rule Evaluation
// ============================================================================

/**
 * Evaluate rules from context against a tool.
 */
export function evaluateRules(
  context: ToolPermissionContext,
  toolName: string,
  ruleContent?: string,
): RuleMatchResult {
  // Build rule list from context
  const rules: PermissionRule[] = [];

  // Add always deny rules first (highest priority)
  for (const [source, ruleStrings] of Object.entries(context.alwaysDenyRules)) {
    if (ruleStrings) {
      for (const ruleString of ruleStrings) {
        const value = parseRuleString(ruleString);
        if (value) {
          rules.push({
            source: source as PermissionRuleSource,
            ruleBehavior: "deny",
            ruleValue: value,
          });
        }
      }
    }
  }

  // Add always ask rules
  for (const [source, ruleStrings] of Object.entries(context.alwaysAskRules)) {
    if (ruleStrings) {
      for (const ruleString of ruleStrings) {
        const value = parseRuleString(ruleString);
        if (value) {
          rules.push({
            source: source as PermissionRuleSource,
            ruleBehavior: "ask",
            ruleValue: value,
          });
        }
      }
    }
  }

  // Add always allow rules
  for (const [source, ruleStrings] of Object.entries(context.alwaysAllowRules)) {
    if (ruleStrings) {
      for (const ruleString of ruleStrings) {
        const value = parseRuleString(ruleString);
        if (value) {
          rules.push({
            source: source as PermissionRuleSource,
            ruleBehavior: "allow",
            ruleValue: value,
          });
        }
      }
    }
  }

  return findMatchingRule(rules, toolName, ruleContent);
}

/**
 * Create a deny decision from a rule match.
 */
export function createDenyDecisionFromRule(
  rule: PermissionRule,
  toolName: string,
  message?: string,
): PermissionDenyDecision {
  return {
    behavior: "deny",
    message: message ?? `Permission denied for tool '${toolName}' by rule from ${rule.source}`,
    decisionReason: { type: "rule", rule },
  };
}

/**
 * Create a decision reason from a rule match.
 */
export function createDecisionReasonFromRule(rule: PermissionRule): PermissionDecisionReason {
  return { type: "rule", rule };
}

// ============================================================================
// Rule Management
// ============================================================================

/**
 * Merge rules from multiple sources.
 */
export function mergeRules(
  rulesBySource: ToolPermissionRulesBySource,
  behavior: PermissionBehavior,
): PermissionRule[] {
  const merged: PermissionRule[] = [];

  for (const [source, ruleStrings] of Object.entries(rulesBySource)) {
    if (ruleStrings) {
      for (const ruleString of ruleStrings) {
        const value = parseRuleString(ruleString);
        if (value) {
          merged.push({
            source: source as PermissionRuleSource,
            ruleBehavior: behavior,
            ruleValue: value,
          });
        }
      }
    }
  }

  return merged;
}

/**
 * Deduplicate rules, keeping the highest priority version.
 */
export function deduplicateRules(rules: PermissionRule[]): PermissionRule[] {
  const seen = new Map<string, PermissionRule>();

  for (const rule of sortRulesByPriority(rules)) {
    const key = `${normalizeToolName(rule.ruleValue.toolName)}:${rule.ruleValue.ruleContent ?? ""}`;
    if (!seen.has(key)) {
      seen.set(key, rule);
    }
  }

  return Array.from(seen.values());
}

/**
 * Filter rules by tool name.
 */
export function filterRulesByTool(rules: PermissionRule[], toolName: string): PermissionRule[] {
  return rules.filter((rule) => ruleMatchesTool(rule.ruleValue, toolName));
}

/**
 * Filter rules by source.
 */
export function filterRulesBySource(
  rules: PermissionRule[],
  source: PermissionRuleSource,
): PermissionRule[] {
  return rules.filter((rule) => rule.source === source);
}

/**
 * Filter rules by behavior.
 */
export function filterRulesByBehavior(
  rules: PermissionRule[],
  behavior: PermissionBehavior,
): PermissionRule[] {
  return rules.filter((rule) => rule.ruleBehavior === behavior);
}
