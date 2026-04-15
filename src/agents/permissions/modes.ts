/**
 * Permission mode implementation.
 *
 * Provides mode configuration, validation, and utility functions.
 * Adapted from Claude Code's PermissionMode.ts for OpenClaw.
 */

import { EXTERNAL_PERMISSION_MODES } from "./types.js";
import type { ExternalPermissionMode, PermissionMode } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * All permission modes for runtime validation.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = [...EXTERNAL_PERMISSION_MODES, "auto"];

// ============================================================================
// Mode Configuration
// ============================================================================

type ModeColorKey = "text" | "planMode" | "permission" | "autoAccept" | "error" | "warning";

type PermissionModeConfig = {
  title: string;
  shortTitle: string;
  symbol: string;
  color: ModeColorKey;
  external: ExternalPermissionMode;
  description: string;
};

/**
 * Configuration for each permission mode.
 */
const PERMISSION_MODE_CONFIG: Record<PermissionMode, PermissionModeConfig> = {
  default: {
    title: "Default",
    shortTitle: "Default",
    symbol: "",
    color: "text",
    external: "default",
    description: "Normal permission prompting behavior",
  },
  plan: {
    title: "Plan Mode",
    shortTitle: "Plan",
    symbol: "⏸",
    color: "planMode",
    external: "plan",
    description: "Planning mode - read-only operations with explicit approval for writes",
  },
  acceptEdits: {
    title: "Accept Edits",
    shortTitle: "Accept",
    symbol: "⏵⏵",
    color: "autoAccept",
    external: "acceptEdits",
    description: "Auto-accept file edits, prompt for other operations",
  },
  bypassPermissions: {
    title: "Bypass Permissions",
    shortTitle: "Bypass",
    symbol: "⚠",
    color: "error",
    external: "bypassPermissions",
    description: "Bypass all permission checks - requires admin scope",
  },
  dontAsk: {
    title: "Don't Ask",
    shortTitle: "DontAsk",
    symbol: "⏵",
    color: "error",
    external: "dontAsk",
    description: "Suppress permission prompts, deny by default",
  },
  auto: {
    title: "Auto Mode",
    shortTitle: "Auto",
    symbol: "⏵⏵",
    color: "warning",
    external: "default", // auto maps to default externally
    description: "Automatic mode with classifier-based decisions",
  },
};

// ============================================================================
// Mode Utilities
// ============================================================================

/**
 * Get the configuration for a permission mode.
 */
export function getModeConfig(mode: PermissionMode): PermissionModeConfig {
  return PERMISSION_MODE_CONFIG[mode] ?? PERMISSION_MODE_CONFIG.default;
}

/**
 * Convert a string to a permission mode.
 * Returns 'default' for invalid values.
 */
export function permissionModeFromString(str: string): PermissionMode {
  if (PERMISSION_MODES.includes(str as PermissionMode)) {
    return str as PermissionMode;
  }
  return "default";
}

/**
 * Get the display title for a mode.
 */
export function permissionModeTitle(mode: PermissionMode): string {
  return getModeConfig(mode).title;
}

/**
 * Get the short display title for a mode.
 */
export function permissionModeShortTitle(mode: PermissionMode): string {
  return getModeConfig(mode).shortTitle;
}

/**
 * Get the symbol/icon for a mode.
 */
export function permissionModeSymbol(mode: PermissionMode): string {
  return getModeConfig(mode).symbol;
}

/**
 * Get the color key for a mode.
 */
export function getModeColor(mode: PermissionMode): ModeColorKey {
  return getModeConfig(mode).color;
}

/**
 * Get the description for a mode.
 */
export function permissionModeDescription(mode: PermissionMode): string {
  return getModeConfig(mode).description;
}

/**
 * Convert an internal mode to an external mode.
 * 'auto' maps to 'default' externally.
 */
export function toExternalPermissionMode(mode: PermissionMode): ExternalPermissionMode {
  return getModeConfig(mode).external;
}

/**
 * Check if a mode is default mode.
 */
export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === "default" || mode === undefined;
}

/**
 * Check if a mode is an external permission mode.
 */
export function isExternalPermissionMode(mode: PermissionMode): mode is ExternalPermissionMode {
  return EXTERNAL_PERMISSION_MODES.includes(mode as ExternalPermissionMode);
}

/**
 * Check if a mode allows auto-accepting edits.
 */
export function isAutoAcceptEditsMode(mode: PermissionMode | undefined): boolean {
  return mode === "acceptEdits" || mode === "bypassPermissions";
}

/**
 * Check if a mode bypasses permission checks.
 */
export function isBypassPermissionsMode(mode: PermissionMode | undefined): boolean {
  return mode === "bypassPermissions";
}

/**
 * Check if a mode suppresses prompts.
 */
export function isDontAskMode(mode: PermissionMode | undefined): boolean {
  return mode === "dontAsk" || mode === "bypassPermissions";
}

/**
 * Check if a mode is plan mode (read-only with explicit write approval).
 */
export function isPlanMode(mode: PermissionMode | undefined): boolean {
  return mode === "plan";
}

/**
 * Check if a mode uses classifier-based decisions.
 */
export function isAutoMode(mode: PermissionMode | undefined): boolean {
  return mode === "auto";
}

/**
 * Check if the mode allows the given behavior without prompting.
 */
export function modeAllowsBehavior(
  mode: PermissionMode | undefined,
  behavior: "read" | "write" | "execute",
): boolean {
  switch (mode) {
    case "bypassPermissions":
      return true;
    case "acceptEdits":
      return behavior === "write";
    case "dontAsk":
      return false; // DontAsk denies by default, doesn't auto-allow
    case "plan":
      return behavior === "read";
    case "auto":
      return false; // Auto uses classifier, not mode-based decisions
    case "default":
    case undefined:
      return false; // Default prompts for everything
    default:
      return false;
  }
}

// Re-export for convenience
export { EXTERNAL_PERMISSION_MODES } from "./types.js";
