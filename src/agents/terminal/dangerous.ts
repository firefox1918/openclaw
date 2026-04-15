/**
 * Dangerous command detection module.
 *
 * Detects potentially destructive commands using pattern matching,
 * normalizes obfuscation attempts, and provides approval workflow integration.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  DANGEROUS_PATTERNS,
  type DangerousDetectionResult,
  type DangerousPattern,
} from "./types.js";

const log = createSubsystemLogger("terminal/dangerous");

// ============================================================================
// Command Normalization
// ============================================================================

/**
 * ANSI escape sequence regex for stripping control characters.
 * Matches CSI (ESC [), OSC (ESC ]), DCS (ESC P), and 8-bit C1 sequences.
 * Uses RegExp constructor with hex escapes to avoid lint issues.
 */
const ANSI_CSI_PATTERN = "\\x1b\\[[0-9;]*[a-zA-Z]";
const ANSI_OSC_PATTERN = "\\x1b\\].*?\\x07";
const ANSI_DCS_PATTERN = "\\x1bP.*?\\x1b\\\\";
const ANSI_SOS_PATTERN = "\\x1b[X^_].*?\\x1b\\\\";
const ANSI_C1_PATTERN = "[\\x80-\\x9F][@-~]";
const ANSI_ESCAPE_REGEX = new RegExp(
  `${ANSI_CSI_PATTERN}|${ANSI_OSC_PATTERN}|${ANSI_DCS_PATTERN}|${ANSI_SOS_PATTERN}|${ANSI_C1_PATTERN}`,
  "g",
);

/**
 * Strip ANSI escape sequences from a command string.
 * Prevents obfuscation via control characters.
 */
export function stripAnsi(command: string): string {
  return command.replace(ANSI_ESCAPE_REGEX, "");
}

/**
 * Normalize a command string for dangerous pattern matching.
 *
 * Strips:
 * - ANSI escape sequences (full ECMA-48)
 * - Null bytes
 * - Unicode fullwidth character obfuscation (e.g., ＲＭ → RM)
 */
export function normalizeCommandForDetection(command: string): string {
  // Strip ANSI escape sequences
  let normalized = stripAnsi(command);

  // Strip null bytes (intentional for security)
  const NULL_BYTE_PATTERN = "\\x00";
  normalized = normalized.replace(new RegExp(NULL_BYTE_PATTERN, "g"), "");

  // Normalize Unicode (fullwidth Latin, halfwidth Katakana, etc.)
  // Using NFKC which converts compatibility characters to canonical form
  normalized = normalized.normalize("NFKC");

  return normalized;
}

// ============================================================================
// Dangerous Pattern Detection
// ============================================================================

/**
 * Pattern key aliases for backwards compatibility.
 * Maps legacy regex-derived keys to human-readable descriptions.
 */
const PATTERN_KEY_ALIASES: Map<string, Set<string>> = new Map();

// Initialize aliases from patterns
for (const pattern of DANGEROUS_PATTERNS) {
  const description = pattern.description;
  const legacyKey = extractLegacyPatternKey(pattern);

  // Add aliases for both description and legacy key
  if (!PATTERN_KEY_ALIASES.has(description)) {
    PATTERN_KEY_ALIASES.set(description, new Set([description, legacyKey]));
  } else {
    PATTERN_KEY_ALIASES.get(description)?.add(legacyKey);
  }

  if (!PATTERN_KEY_ALIASES.has(legacyKey)) {
    PATTERN_KEY_ALIASES.set(legacyKey, new Set([legacyKey, description]));
  } else {
    PATTERN_KEY_ALIASES.get(legacyKey)?.add(description);
  }
}

/**
 * Extract legacy pattern key from regex pattern.
 * Reproduces the old regex-derived approval key for backwards compatibility.
 */
function extractLegacyPatternKey(pattern: DangerousPattern): string {
  const patternStr = pattern.pattern.source;
  // Extract first word after \b if present
  const match = patternStr.match(/\\b(\w+)/);
  return match ? match[1] : patternStr.slice(0, 20);
}

/**
 * Get all approval key aliases for a pattern key.
 * New approvals use human-readable descriptions, but older entries
 * may still contain historical regex-derived keys.
 */
export function getApprovalKeyAliases(patternKey: string): Set<string> {
  return PATTERN_KEY_ALIASES.get(patternKey) ?? new Set([patternKey]);
}

/**
 * Check if a command matches any dangerous patterns.
 *
 * @param command - The command string to check
 * @returns Detection result with isDangerous, patternKey, and description
 */
export function detectDangerousCommand(command: string): DangerousDetectionResult {
  const normalized = normalizeCommandForDetection(command).toLowerCase();

  for (const pattern of DANGEROUS_PATTERNS) {
    // Create a new regex from the pattern source for case-insensitive matching
    // The stored patterns use 'i' flag, but we re-create for safety
    const regex = new RegExp(pattern.pattern.source, "i");

    if (regex.test(normalized)) {
      log.warn(`Dangerous command detected: ${pattern.description}`);
      return {
        isDangerous: true,
        patternKey: pattern.description,
        description: pattern.description,
      };
    }
  }

  return {
    isDangerous: false,
    patternKey: null,
    description: null,
  };
}

/**
 * Check if a command is safe to execute without approval.
 *
 * @param command - The command to check
 * @param approvedPatterns - Set of pattern keys that have been pre-approved
 * @returns true if safe to execute, false if needs approval
 */
export function isCommandSafeToExecute(command: string, approvedPatterns: Set<string>): boolean {
  const detection = detectDangerousCommand(command);

  if (!detection.isDangerous) {
    return true;
  }

  // Check if the pattern is in the approved list
  const aliases = getApprovalKeyAliases(detection.patternKey ?? "");
  for (const alias of aliases) {
    if (approvedPatterns.has(alias)) {
      log.info(`Dangerous command approved: ${detection.description}`);
      return true;
    }
  }

  return false;
}

// ============================================================================
// Approval State Management (Session-scoped)
// ============================================================================

/**
 * Per-session approval state for dangerous commands.
 * Thread-safe storage keyed by session key.
 */
const approvalState: Map<string, Set<string>> = new Map();

/**
 * Get the approved patterns for a session.
 */
export function getSessionApprovedPatterns(sessionKey: string): Set<string> {
  if (!approvalState.has(sessionKey)) {
    approvalState.set(sessionKey, new Set());
  }
  return approvalState.get(sessionKey) ?? new Set();
}

/**
 * Add an approved pattern to a session.
 */
export function approvePatternForSession(sessionKey: string, patternKey: string): void {
  const aliases = getApprovalKeyAliases(patternKey);
  const approved = getSessionApprovedPatterns(sessionKey);
  for (const alias of aliases) {
    approved.add(alias);
  }
  log.info(`Pattern approved for session ${sessionKey}: ${patternKey}`);
}

/**
 * Remove an approved pattern from a session.
 */
export function revokePatternForSession(sessionKey: string, patternKey: string): void {
  const aliases = getApprovalKeyAliases(patternKey);
  const approved = getSessionApprovedPatterns(sessionKey);
  for (const alias of aliases) {
    approved.delete(alias);
  }
  log.info(`Pattern revoked for session ${sessionKey}: ${patternKey}`);
}

/**
 * Clear all approved patterns for a session.
 */
export function clearSessionApprovals(sessionKey: string): void {
  approvalState.delete(sessionKey);
  log.info(`All approvals cleared for session ${sessionKey}`);
}

// ============================================================================
// Integration Helpers
// ============================================================================

/**
 * Build approval request message for a dangerous command.
 */
export function buildApprovalRequestMessage(
  command: string,
  detection: DangerousDetectionResult,
): string {
  if (!detection.isDangerous) {
    return "";
  }

  return [
    `⚠️ Dangerous command detected: ${detection.description}`,
    "",
    `Command: ${command.slice(0, 200)}${command.length > 200 ? "..." : ""}`,
    "",
    "This command may cause irreversible damage.",
    "Approve to allow execution, or deny to block.",
  ].join("\n");
}

/**
 * Check command safety with permission system integration.
 * Returns a permission result compatible with Phase 6 permissions module.
 */
export function checkDangerousCommandPermission(
  command: string,
  sessionKey: string,
): {
  behavior: "allow" | "ask" | "deny";
  reason?: string;
  patternKey?: string;
} {
  const detection = detectDangerousCommand(command);

  if (!detection.isDangerous) {
    return { behavior: "allow" };
  }

  // Check if already approved for this session
  const approved = getSessionApprovedPatterns(sessionKey);
  const aliases = getApprovalKeyAliases(detection.patternKey ?? "");

  for (const alias of aliases) {
    if (approved.has(alias)) {
      return {
        behavior: "allow",
        reason: "pre-approved",
        patternKey: detection.patternKey ?? undefined,
      };
    }
  }

  // Needs approval - return ask behavior
  return {
    behavior: "ask",
    reason: buildApprovalRequestMessage(command, detection) ?? undefined,
    patternKey: detection.patternKey ?? undefined,
  };
}
