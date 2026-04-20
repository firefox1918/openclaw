/**
 * Permission rule persistence module.
 *
 * Saves user approval decisions to disk, enabling cross-session memory.
 * Rules are stored in ~/.openclaw/permissions.json and loaded on startup.
 *
 * ## Integration Points
 *
 * 1. pipeline.ts - loadSavedRules() called on permission context creation
 * 2. Permission updates - savePermissionRule() called when user approves/denies
 * 3. terminal/dangerous.ts - dangerous command patterns can be persisted
 *
 * ## Storage Format
 *
 * ```json
 * {
 *   "version": 1,
 *   "rules": [
 *     {
 *       "toolName": "bash",
 *       "behavior": "allow",
 *       "pattern": "rm -rf /tmp/*",
 *       "createdAt": 1714021200000,
 *       "expiresAt": null
 *     }
 *   ],
 *   "lastUpdatedAt": 1714021200000
 * }
 * ```
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { PermissionBehavior, PermissionRule, PermissionRuleSource } from "./types.js";

const log = createSubsystemLogger("permissions/persistence");

// ============================================================================
// Types
// ============================================================================

/**
 * A saved permission rule that persists across sessions.
 */
export type SavedPermissionRule = {
  /** Tool name this rule applies to */
  toolName: string;
  /** The behavior for this rule */
  behavior: PermissionBehavior;
  /** Optional pattern for tool-specific matching (e.g., bash command pattern) */
  pattern?: string;
  /** When this rule was created */
  createdAt: number;
  /** Optional expiration timestamp */
  expiresAt?: number | null;
  /** Optional source metadata */
  source?: string;
  /** Optional description for user reference */
  description?: string;
};

/**
 * The persisted permissions file structure.
 */
export type PersistedPermissions = {
  /** File format version */
  version: number;
  /** Saved rules */
  rules: SavedPermissionRule[];
  /** Last update timestamp */
  lastUpdatedAt: number;
};

/**
 * Options for saving a permission rule.
 */
export type SaveRuleOptions = {
  /** Tool name */
  toolName: string;
  /** Behavior to save */
  behavior: PermissionBehavior;
  /** Optional pattern for tool-specific matching */
  pattern?: string;
  /** Optional expiration time in milliseconds from now */
  expiresIn?: number;
  /** Optional source metadata */
  source?: string;
  /** Optional description */
  description?: string;
};

/**
 * Options for loading saved rules.
 */
export type LoadRulesOptions = {
  /** Filter by tool name */
  toolName?: string;
  /** Filter by behavior */
  behavior?: PermissionBehavior;
  /** Include expired rules */
  includeExpired?: boolean;
  /** Custom permissions file path */
  filePath?: string;
};

// ============================================================================
// Constants
// ============================================================================

/** Current file format version */
const PERSISTENCE_VERSION = 1;

/** Default permissions file name */
const PERMISSIONS_FILE_NAME = "permissions.json";

/** Maximum rules to store (prevent unbounded growth) */
const MAX_RULES_COUNT = 500;

/** Rule expiration default (30 days in milliseconds) */
const DEFAULT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000;

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Get default permissions file path.
 */
export function getDefaultPermissionsFilePath(): string {
  return path.join(os.homedir(), ".openclaw", PERMISSIONS_FILE_NAME);
}

/**
 * Get the .openclaw directory path.
 */
export function getOpenClawDir(): string {
  return path.join(os.homedir(), ".openclaw");
}

// ============================================================================
// Persistence Operations
// ============================================================================

/**
 * Load saved permission rules from disk.
 *
 * @param options - Load options for filtering
 * @returns Array of saved rules
 */
export async function loadSavedRules(options?: LoadRulesOptions): Promise<SavedPermissionRule[]> {
  const filePath = options?.filePath || getDefaultPermissionsFilePath();

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const data: PersistedPermissions = JSON.parse(content);

    // Validate version
    if (data.version !== PERSISTENCE_VERSION) {
      log.warn(`Unknown persistence version ${data.version}, expected ${PERSISTENCE_VERSION}`);
      return [];
    }

    let rules = data.rules || [];

    // Filter expired rules unless explicitly included
    if (!options?.includeExpired) {
      const now = Date.now();
      rules = rules.filter((rule) => {
        if (rule.expiresAt === null || rule.expiresAt === undefined) {
          return true;
        }
        return rule.expiresAt > now;
      });
    }

    // Filter by tool name
    if (options?.toolName) {
      rules = rules.filter((rule) => rule.toolName === options.toolName);
    }

    // Filter by behavior
    if (options?.behavior) {
      rules = rules.filter((rule) => rule.behavior === options.behavior);
    }

    return rules;
  } catch (error) {
    // File doesn't exist or is invalid - return empty array
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      log.info("No persisted permissions file found, starting fresh");
      return [];
    }
    log.error(`Failed to load persisted permissions: ${String(error)}`);
    return [];
  }
}

/**
 * Save a permission rule to disk.
 *
 * @param options - Rule options to save
 * @returns The saved rule
 */
export async function savePermissionRule(options: SaveRuleOptions): Promise<SavedPermissionRule> {
  const filePath = getDefaultPermissionsFilePath();
  const openClawDir = getOpenClawDir();

  // Ensure directory exists
  await fs.mkdir(openClawDir, { recursive: true, mode: 0o700 });

  // Load existing rules
  let existingRules: SavedPermissionRule[] = [];
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const data: PersistedPermissions = JSON.parse(content);
    existingRules = data.rules || [];
  } catch {
    // File doesn't exist, start fresh
  }

  // Check for duplicate and update if exists
  const now = Date.now();
  const expiresAt = options.expiresIn ? now + options.expiresIn : now + DEFAULT_EXPIRATION_MS; // Default 30 days expiration

  const existingIndex = existingRules.findIndex(
    (r) =>
      r.toolName === options.toolName &&
      r.behavior === options.behavior &&
      (r.pattern === options.pattern || (!r.pattern && !options.pattern)),
  );

  const newRule: SavedPermissionRule = {
    toolName: options.toolName,
    behavior: options.behavior,
    pattern: options.pattern,
    createdAt: existingIndex >= 0 ? existingRules[existingIndex].createdAt : now,
    expiresAt,
    source: options.source,
    description: options.description,
  };

  // Update or add
  if (existingIndex >= 0) {
    existingRules[existingIndex] = newRule;
  } else {
    existingRules.push(newRule);
  }

  // Enforce max count - remove oldest rules
  if (existingRules.length > MAX_RULES_COUNT) {
    existingRules = existingRules
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_RULES_COUNT);
    log.info(`Trimmed persisted rules to ${MAX_RULES_COUNT}`);
  }

  // Write to file
  const data: PersistedPermissions = {
    version: PERSISTENCE_VERSION,
    rules: existingRules,
    lastUpdatedAt: now,
  };

  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  log.info(`Saved permission rule: ${options.toolName}=${options.behavior}`);

  return newRule;
}

/**
 * Remove a saved permission rule.
 *
 * @param toolName - Tool name
 * @param behavior - Behavior to remove
 * @param pattern - Optional pattern
 * @returns True if rule was removed
 */
export async function removeSavedRule(
  toolName: string,
  behavior: PermissionBehavior,
  pattern?: string,
): Promise<boolean> {
  const filePath = getDefaultPermissionsFilePath();

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const data: PersistedPermissions = JSON.parse(content);

    const index = data.rules.findIndex(
      (r) =>
        r.toolName === toolName &&
        r.behavior === behavior &&
        (r.pattern === pattern || (!r.pattern && !pattern)),
    );

    if (index < 0) {
      return false;
    }

    data.rules.splice(index, 1);
    data.lastUpdatedAt = Date.now();

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    log.info(`Removed permission rule: ${toolName}=${behavior}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear all saved permission rules.
 */
export async function clearAllSavedRules(): Promise<void> {
  const filePath = getDefaultPermissionsFilePath();

  const data: PersistedPermissions = {
    version: PERSISTENCE_VERSION,
    rules: [],
    lastUpdatedAt: Date.now(),
  };

  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  log.info("Cleared all persisted permission rules");
}

// ============================================================================
// Rule Conversion
// ============================================================================

/**
 * Convert a saved rule to a PermissionRule for runtime use.
 *
 * @param savedRule - The saved rule
 * @param source - The source to assign
 * @returns PermissionRule for runtime
 */
export function savedRuleToPermissionRule(
  savedRule: SavedPermissionRule,
  source: PermissionRuleSource = "session",
): PermissionRule {
  return {
    source,
    ruleBehavior: savedRule.behavior,
    ruleValue: {
      toolName: savedRule.toolName,
      ruleContent: savedRule.pattern,
    },
  };
}

/**
 * Convert saved rules to PermissionRules for runtime use.
 *
 * @param savedRules - Saved rules to convert
 * @param source - The source to assign
 * @returns Array of PermissionRules
 */
export function savedRulesToPermissionRules(
  savedRules: SavedPermissionRule[],
  source: PermissionRuleSource = "session",
): PermissionRule[] {
  return savedRules.map((rule) => savedRuleToPermissionRule(rule, source));
}

/**
 * Merge saved rules with existing rules.
 * Saved rules have lower priority than explicitly set rules.
 *
 * @param existingRules - Existing permission rules
 * @param savedRules - Saved rules from disk
 * @returns Merged rules array
 */
export function mergeSavedRulesWithExisting(
  existingRules: PermissionRule[],
  savedRules: SavedPermissionRule[],
): PermissionRule[] {
  const convertedSaved = savedRulesToPermissionRules(savedRules, "session");

  // Deduplicate: existing rules take precedence
  const existingRuleKeys = new Set(
    existingRules.map(
      (r) => `${r.ruleValue.toolName}:${r.ruleBehavior}:${r.ruleValue.ruleContent || ""}`,
    ),
  );

  const merged = [...existingRules];

  for (const saved of convertedSaved) {
    const key = `${saved.ruleValue.toolName}:${saved.ruleBehavior}:${saved.ruleValue.ruleContent || ""}`;
    if (!existingRuleKeys.has(key)) {
      merged.push(saved);
    }
  }

  return merged;
}

// ============================================================================
// Cleanup Operations
// ============================================================================

/**
 * Clean up expired rules from the persistence file.
 *
 * @returns Number of rules removed
 */
export async function cleanExpiredRules(): Promise<number> {
  const filePath = getDefaultPermissionsFilePath();

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const data: PersistedPermissions = JSON.parse(content);

    const now = Date.now();
    const validRules = data.rules.filter((rule) => {
      if (rule.expiresAt === null || rule.expiresAt === undefined) {
        return true;
      }
      return rule.expiresAt > now;
    });

    const removedCount = data.rules.length - validRules.length;

    if (removedCount > 0) {
      data.rules = validRules;
      data.lastUpdatedAt = now;
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
      log.info(`Cleaned up ${removedCount} expired permission rules`);
    }

    return removedCount;
  } catch {
    return 0;
  }
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Get statistics about persisted permissions.
 */
export async function getPersistenceStats(): Promise<{
  totalRules: number;
  allowRules: number;
  denyRules: number;
  askRules: number;
  expiredRules: number;
  filePath: string;
}> {
  const filePath = getDefaultPermissionsFilePath();
  const allRules = await loadSavedRules({ includeExpired: true });
  const activeRules = await loadSavedRules({ includeExpired: false });

  const expiredCount = allRules.length - activeRules.length;

  return {
    totalRules: allRules.length,
    allowRules: allRules.filter((r) => r.behavior === "allow").length,
    denyRules: allRules.filter((r) => r.behavior === "deny").length,
    askRules: allRules.filter((r) => r.behavior === "ask").length,
    expiredRules: expiredCount,
    filePath,
  };
}
