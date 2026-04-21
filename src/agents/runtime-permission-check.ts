/**
 * Runtime permission check - bridges the permissions module to tool execution.
 *
 * This file creates the core integration point for the permissions module,
 * allowing runtime permission decisions during tool execution.
 */

import {
  checkPermission,
  createDefaultPermissionContext,
  createPermissionContextFromProfile,
  createPermissionContextWithPersistence,
  type PermissionResult,
  type ToolPermissionContext,
} from "./permissions/index.js";
import type {
  PermissionProfile,
  PermissionRuleSource,
  ToolPermissionRulesBySource,
} from "./permissions/types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Simple policy like existing OpenClaw allow/deny configuration.
 */
export type SimpleToolPolicy = {
  allow?: string[];
  deny?: string[];
};

/**
 * Configuration for runtime permission checking.
 */
export interface RuntimePermissionConfig {
  /** Permission profile to use (if configured) */
  profile?: PermissionProfile;
  /** Default permission mode */
  defaultMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";
  /** Whether bypassPermissions mode is available (requires admin scope) */
  bypassPermissionsAvailable?: boolean;
  /** Granted scopes for the current session */
  grantedScopes?: string[];
  /** Existing policies to convert to permission rules */
  policies?: SimpleToolPolicy[];
  /** Policy source for rule attribution */
  policySource?: PermissionRuleSource;
}

/**
 * Result of runtime permission check with additional context.
 */
export interface RuntimePermissionCheckResult {
  /** The permission decision */
  decision: PermissionResult;
  /** Whether the operation should proceed */
  allowed: boolean;
  /** Message to display if denied or asking */
  message: string;
}

// ============================================================================
// Permission Context Creation
// ============================================================================

/**
 * Convert simple allow/deny policies to PermissionRulesBySource.
 *
 * This bridges the existing OpenClaw tool policy system to the permissions module.
 */
function policiesToRulesBySource(
  policies: SimpleToolPolicy[],
  source: PermissionRuleSource = "agentProfile",
): {
  allowRules: ToolPermissionRulesBySource;
  denyRules: ToolPermissionRulesBySource;
} {
  const allowRules: ToolPermissionRulesBySource = {};
  const denyRules: ToolPermissionRulesBySource = {};

  // Collect all allow/deny entries from policies
  const allowEntries: string[] = [];
  const denyEntries: string[] = [];

  for (const policy of policies) {
    if (policy.allow) {
      for (const tool of policy.allow) {
        const trimmed = tool?.trim();
        if (trimmed) {
          allowEntries.push(trimmed);
        }
      }
    }
    if (policy.deny) {
      for (const tool of policy.deny) {
        const trimmed = tool?.trim();
        if (trimmed) {
          denyEntries.push(trimmed);
        }
      }
    }
  }

  // Deduplicate and assign to rules by source
  if (allowEntries.length > 0) {
    allowRules[source] = Array.from(new Set(allowEntries));
  }
  if (denyEntries.length > 0) {
    denyRules[source] = Array.from(new Set(denyEntries));
  }

  return { allowRules, denyRules };
}

/**
 * Merge rules by source (profile rules take precedence over policy rules).
 */
function mergeRulesBySource(
  base: ToolPermissionRulesBySource,
  overlay: ToolPermissionRulesBySource,
): ToolPermissionRulesBySource {
  const result: ToolPermissionRulesBySource = {};
  // Copy base rules
  for (const [source, rules] of Object.entries(base)) {
    if (rules) {
      result[source as PermissionRuleSource] = rules;
    }
  }
  // Overlay rules (base takes precedence, so only add if not present)
  for (const [source, rules] of Object.entries(overlay)) {
    if (rules && !result[source as PermissionRuleSource]) {
      result[source as PermissionRuleSource] = rules;
    }
  }
  return result;
}

/**
 * Create a permission context from runtime configuration.
 *
 * Returns a new context object (readonly properties are handled correctly).
 */
export function createRuntimePermissionContext(
  config: RuntimePermissionConfig,
): ToolPermissionContext {
  if (config.profile) {
    const baseCtx = createPermissionContextFromProfile(config.profile);

    // Build the context with overrides
    const mode = baseCtx.mode;
    const isBypassAvailable =
      config.bypassPermissionsAvailable ?? baseCtx.isBypassPermissionsModeAvailable;
    const grantedScopes = config.grantedScopes ?? baseCtx.grantedScopes ?? [];

    // Merge policies if provided
    let allowRules = baseCtx.alwaysAllowRules;
    let denyRules = baseCtx.alwaysDenyRules;
    if (config.policies && config.policies.length > 0) {
      const { allowRules: policyAllow, denyRules: policyDeny } = policiesToRulesBySource(
        config.policies,
        config.policySource ?? "agentProfile",
      );
      // Profile rules take precedence
      allowRules = mergeRulesBySource(baseCtx.alwaysAllowRules, policyAllow);
      denyRules = mergeRulesBySource(baseCtx.alwaysDenyRules, policyDeny);
    }

    return {
      mode,
      additionalWorkingDirectories: baseCtx.additionalWorkingDirectories,
      alwaysAllowRules: allowRules,
      alwaysDenyRules: denyRules,
      alwaysAskRules: baseCtx.alwaysAskRules,
      isBypassPermissionsModeAvailable: isBypassAvailable,
      grantedScopes,
      requiredScopes: baseCtx.requiredScopes,
      activeProfileId: baseCtx.activeProfileId,
    };
  }

  // Create default context
  const baseCtx = createDefaultPermissionContext();
  const mode = config.defaultMode ?? baseCtx.mode;
  const isBypassAvailable =
    config.bypassPermissionsAvailable ?? baseCtx.isBypassPermissionsModeAvailable;
  const grantedScopes = config.grantedScopes ?? baseCtx.grantedScopes ?? [];

  // Apply policies to the context
  let allowRules = baseCtx.alwaysAllowRules;
  let denyRules = baseCtx.alwaysDenyRules;
  if (config.policies && config.policies.length > 0) {
    const { allowRules: policyAllow, denyRules: policyDeny } = policiesToRulesBySource(
      config.policies,
      config.policySource ?? "agentProfile",
    );
    allowRules = policyAllow;
    denyRules = policyDeny;
  }

  return {
    mode,
    additionalWorkingDirectories: baseCtx.additionalWorkingDirectories,
    alwaysAllowRules: allowRules,
    alwaysDenyRules: denyRules,
    alwaysAskRules: baseCtx.alwaysAskRules,
    isBypassPermissionsModeAvailable: isBypassAvailable,
    grantedScopes,
  };
}

/**
 * Create a permission context from runtime configuration with persisted rules.
 *
 * This is the recommended async version that loads previously saved permission
 * decisions from disk and merges them with the profile/policy rules.
 *
 * @param config - Runtime permission configuration
 * @returns Permission context with persisted rules merged in
 */
export async function createRuntimePermissionContextWithPersistence(
  config: RuntimePermissionConfig,
): Promise<ToolPermissionContext> {
  if (config.profile) {
    // Use the persistence-aware function from permissions module
    const baseCtx = await createPermissionContextWithPersistence(config.profile);

    // Build the context with overrides
    const mode = baseCtx.mode;
    const isBypassAvailable =
      config.bypassPermissionsAvailable ?? baseCtx.isBypassPermissionsModeAvailable;
    const grantedScopes = config.grantedScopes ?? baseCtx.grantedScopes ?? [];

    // Merge policies if provided
    let allowRules = baseCtx.alwaysAllowRules;
    let denyRules = baseCtx.alwaysDenyRules;
    if (config.policies && config.policies.length > 0) {
      const { allowRules: policyAllow, denyRules: policyDeny } = policiesToRulesBySource(
        config.policies,
        config.policySource ?? "agentProfile",
      );
      // Profile rules take precedence
      allowRules = mergeRulesBySource(baseCtx.alwaysAllowRules, policyAllow);
      denyRules = mergeRulesBySource(baseCtx.alwaysDenyRules, policyDeny);
    }

    return {
      mode,
      additionalWorkingDirectories: baseCtx.additionalWorkingDirectories,
      alwaysAllowRules: allowRules,
      alwaysDenyRules: denyRules,
      alwaysAskRules: baseCtx.alwaysAskRules,
      isBypassPermissionsModeAvailable: isBypassAvailable,
      grantedScopes,
      requiredScopes: baseCtx.requiredScopes,
      activeProfileId: baseCtx.activeProfileId,
    };
  }

  // For non-profile cases, fall back to sync version
  // (persistence is only meaningful when there's a profile)
  return createRuntimePermissionContext(config);
}

/**
 * Build permission config from OpenClaw's effective tool policy.
 *
 * This is the convenience function to use when you have the result from
 * resolveEffectiveToolPolicy and want to create a permission context.
 */
export function buildPermissionConfigFromPolicies(params: {
  globalPolicy?: SimpleToolPolicy;
  globalProviderPolicy?: SimpleToolPolicy;
  agentPolicy?: SimpleToolPolicy;
  agentProviderPolicy?: SimpleToolPolicy;
  groupPolicy?: SimpleToolPolicy;
  sandboxToolPolicy?: SimpleToolPolicy;
  subagentPolicy?: SimpleToolPolicy;
  defaultMode?: RuntimePermissionConfig["defaultMode"];
}): RuntimePermissionConfig {
  const policies: SimpleToolPolicy[] = [];

  // Add policies in priority order (later policies can override earlier)
  // Global policies first, then more specific ones
  if (params.globalPolicy) {
    policies.push(params.globalPolicy);
  }
  if (params.globalProviderPolicy) {
    policies.push(params.globalProviderPolicy);
  }
  if (params.agentPolicy) {
    policies.push(params.agentPolicy);
  }
  if (params.agentProviderPolicy) {
    policies.push(params.agentProviderPolicy);
  }
  if (params.groupPolicy) {
    policies.push(params.groupPolicy);
  }
  if (params.sandboxToolPolicy) {
    policies.push(params.sandboxToolPolicy);
  }
  if (params.subagentPolicy) {
    policies.push(params.subagentPolicy);
  }

  return {
    policies,
    policySource: "agentProfile", // Use agentProfile as the unified source
    defaultMode: params.defaultMode ?? "default",
  };
}

// ============================================================================
// Runtime Permission Check
// ============================================================================

/**
 * Extract message from PermissionResult.
 */
function extractMessage(decision: PermissionResult): string {
  if (
    decision.behavior === "ask" ||
    decision.behavior === "deny" ||
    decision.behavior === "passthrough"
  ) {
    return decision.message;
  }
  return "";
}

/**
 * Check permission for a tool operation at runtime.
 *
 * This is the main entry point for runtime permission checking.
 * Call this before executing any tool that requires permission control.
 *
 * @param toolName - Name of the tool being executed
 * @param input - Tool input parameters
 * @param context - Permission context with mode, rules, scope
 * @param options - Optional operation-specific metadata
 * @returns Permission check result with decision and message
 */
export async function checkRuntimePermission(
  toolName: string,
  input: Record<string, unknown>,
  context: ToolPermissionContext,
  options?: {
    operationType?: "read" | "write" | "execute";
    additionalContext?: Record<string, unknown>;
  },
): Promise<RuntimePermissionCheckResult> {
  const decision = await checkPermission(toolName, input, context, options);

  return {
    decision,
    allowed: decision.behavior === "allow",
    message: extractMessage(decision),
  };
}

/**
 * Quick check if an operation is allowed without full pipeline.
 *
 * Use this for simple checks where you just need allow/deny without messaging.
 */
export async function isRuntimeOperationAllowed(
  toolName: string,
  context: ToolPermissionContext,
): Promise<boolean> {
  const { isOperationAllowed } = await import("./permissions/index.js");
  return isOperationAllowed(toolName, context);
}

// ============================================================================
// Permission Decision Handlers
// ============================================================================

/**
 * Handle a permission denial - create appropriate error response.
 */
export function handlePermissionDenial(result: RuntimePermissionCheckResult): {
  type: "error";
  message: string;
  code: "PERMISSION_DENIED";
} {
  return {
    type: "error",
    message: result.message || "Operation denied by permission policy",
    code: "PERMISSION_DENIED",
  };
}

/**
 * Handle a permission ask - this should trigger user confirmation flow.
 *
 * The actual confirmation mechanism depends on the UI implementation.
 * This function returns the data needed to present the confirmation prompt.
 */
export function handlePermissionAsk(result: RuntimePermissionCheckResult): {
  type: "confirmation_required";
  message: string;
  reason?: string;
} {
  // Extract reason from decision if available
  let reason: string | undefined;
  if (result.decision.behavior === "ask") {
    const decisionReason = result.decision.decisionReason;
    if (decisionReason) {
      if (decisionReason.type === "mode") {
        reason = `Mode: ${decisionReason.mode}`;
      } else if (decisionReason.type === "rule") {
        reason = `Rule from: ${decisionReason.rule.source}`;
      } else if (decisionReason.type === "safetyCheck") {
        reason = decisionReason.reason;
      }
    }
  }

  return {
    type: "confirmation_required",
    message: result.message,
    reason,
  };
}

// ============================================================================
// Export Convenience Functions
// ============================================================================

/**
 * One-stop permission check with configuration.
 *
 * Combines context creation and permission check into a single call.
 */
export async function checkPermissionWithConfig(
  toolName: string,
  input: Record<string, unknown>,
  config: RuntimePermissionConfig,
  options?: {
    operationType?: "read" | "write" | "execute";
  },
): Promise<RuntimePermissionCheckResult> {
  const context = createRuntimePermissionContext(config);
  return checkRuntimePermission(toolName, input, context, options);
}
