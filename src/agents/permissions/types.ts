/**
 * Permission system type definitions.
 *
 * This file contains only type definitions and constants with no runtime dependencies.
 * Inspired by Claude Code's permission architecture but adapted for OpenClaw's design.
 */

// ============================================================================
// Permission Modes
// ============================================================================

/**
 * External permission modes that users can configure.
 * These are the modes that appear in settings and CLI flags.
 */
export const EXTERNAL_PERMISSION_MODES = [
  "acceptEdits",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
] as const;

export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number];

/**
 * Internal permission modes include additional modes that are only used internally.
 */
export type InternalPermissionMode = ExternalPermissionMode | "auto";

export type PermissionMode = InternalPermissionMode;

/**
 * All permission modes for runtime validation.
 */
export const PERMISSION_MODES: readonly PermissionMode[] = [...EXTERNAL_PERMISSION_MODES, "auto"];

// ============================================================================
// Permission Behaviors
// ============================================================================

/**
 * The behavior associated with a permission rule.
 * - 'allow': The rule allows the tool to run without prompting
 * - 'deny': The rule denies the tool from running
 * - 'ask': The rule forces a prompt to be shown to the user
 */
export type PermissionBehavior = "allow" | "deny" | "ask";

// ============================================================================
// Permission Rules
// ============================================================================

/**
 * Where a permission rule originated from.
 * Includes all SettingSource values plus additional rule-specific sources.
 */
export type PermissionRuleSource =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "flagSettings"
  | "policySettings"
  | "cliArg"
  | "command"
  | "session"
  | "agentProfile";

/**
 * The value of a permission rule - specifies which tool and optional content.
 * Each tool may implement custom handling in `checkPermissions()`.
 */
export type PermissionRuleValue = {
  /** The name of the tool this rule applies to */
  toolName: string;
  /** Optional content for tool-specific rule matching (e.g., path patterns) */
  ruleContent?: string;
};

/**
 * A permission rule with its source and behavior.
 */
export type PermissionRule = {
  /** Where this rule originated */
  source: PermissionRuleSource;
  /** The behavior of this rule */
  ruleBehavior: PermissionBehavior;
  /** The value (tool name and optional content) */
  ruleValue: PermissionRuleValue;
};

// ============================================================================
// Permission Profiles
// ============================================================================

/**
 * A permission profile defines a named set of permission rules.
 * Profiles can be assigned to agents or sessions.
 */
export type PermissionProfile = {
  /** Unique profile identifier */
  id: string;
  /** Human-readable profile name */
  name?: string;
  /** Profile description */
  description?: string;
  /** Default permission mode for this profile */
  defaultMode?: ExternalPermissionMode;
  /** Allow rules */
  allow?: PermissionRuleValue[];
  /** Deny rules */
  deny?: PermissionRuleValue[];
  /** Ask rules (always prompt for these) */
  ask?: PermissionRuleValue[];
  /** Additional working directories permitted by this profile */
  additionalWorkingDirectories?: string[];
  /** Whether bypassPermissions mode is available for this profile */
  bypassPermissionsAvailable?: boolean;
  /** Required scope for sensitive operations (e.g., 'admin' for bypass) */
  requiredScope?: string[];
};

/**
 * Configuration for permission profiles.
 */
export type PermissionProfileConfig = {
  /** Default profile for new sessions */
  defaultProfile?: string;
  /** Available profiles */
  profiles?: PermissionProfile[];
  /** Profile assignments per agent */
  agentProfiles?: Record<string, string>;
};

// ============================================================================
// Permission Updates
// ============================================================================

/**
 * Where a permission update should be persisted.
 */
export type PermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg"
  | "agentProfile";

/**
 * Update operations for permission configuration.
 */
export type PermissionUpdate =
  | {
      type: "addRules";
      destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: "replaceRules";
      destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: "removeRules";
      destination: PermissionUpdateDestination;
      rules: PermissionRuleValue[];
      behavior: PermissionBehavior;
    }
  | {
      type: "setMode";
      destination: PermissionUpdateDestination;
      mode: ExternalPermissionMode;
    }
  | {
      type: "setProfile";
      destination: PermissionUpdateDestination;
      profileId: string;
    }
  | {
      type: "addDirectories";
      destination: PermissionUpdateDestination;
      directories: string[];
    }
  | {
      type: "removeDirectories";
      destination: PermissionUpdateDestination;
      directories: string[];
    };

// ============================================================================
// Permission Decisions & Results
// ============================================================================

/**
 * Result when permission is granted.
 */
export type PermissionAllowDecision<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = {
  behavior: "allow";
  /** Updated input after permission modifications */
  updatedInput?: Input;
  /** Whether user modified the input */
  userModified?: boolean;
  /** Reason for the decision */
  decisionReason?: PermissionDecisionReason;
  /** Tool use ID for tracking */
  toolUseID?: string;
};

/**
 * Result when user should be prompted.
 */
export type PermissionAskDecision<Input extends Record<string, unknown> = Record<string, unknown>> =
  {
    behavior: "ask";
    /** Message to show to the user */
    message: string;
    /** Updated input after permission modifications */
    updatedInput?: Input;
    /** Reason for the decision */
    decisionReason?: PermissionDecisionReason;
    /** Suggested permission updates */
    suggestions?: PermissionUpdate[];
    /** Blocked path if applicable */
    blockedPath?: string;
  };

/**
 * Result when permission is denied.
 */
export type PermissionDenyDecision = {
  behavior: "deny";
  /** Message explaining why permission was denied */
  message: string;
  /** Reason for the decision */
  decisionReason: PermissionDecisionReason;
  /** Tool use ID for tracking */
  toolUseID?: string;
};

/**
 * A permission decision - allow, ask, or deny.
 */
export type PermissionDecision<Input extends Record<string, unknown> = Record<string, unknown>> =
  | PermissionAllowDecision<Input>
  | PermissionAskDecision<Input>
  | PermissionDenyDecision;

/**
 * Permission result with additional passthrough option for hooks.
 */
export type PermissionResult<Input extends Record<string, unknown> = Record<string, unknown>> =
  | PermissionDecision<Input>
  | {
      behavior: "passthrough";
      message: string;
      decisionReason?: PermissionDecision<Input>["decisionReason"];
      suggestions?: PermissionUpdate[];
      blockedPath?: string;
    };

/**
 * Explanation of why a permission decision was made.
 */
export type PermissionDecisionReason =
  | {
      type: "rule";
      rule: PermissionRule;
    }
  | {
      type: "mode";
      mode: PermissionMode;
    }
  | {
      type: "profile";
      profileId: string;
    }
  | {
      type: "subcommandResults";
      reasons: Map<string, PermissionResult>;
    }
  | {
      type: "hook";
      hookName: string;
      hookSource?: string;
      reason?: string;
    }
  | {
      type: "sandboxOverride";
      reason: "excludedCommand" | "dangerouslyDisableSandbox";
    }
  | {
      type: "workingDir";
      reason: string;
    }
  | {
      type: "safetyCheck";
      reason: string;
      classifierApprovable: boolean;
    }
  | {
      type: "scopeCheck";
      requiredScope: string[];
      missingScopes: string[];
    }
  | {
      type: "other";
      reason: string;
    };

// ============================================================================
// Tool Permission Context
// ============================================================================

/**
 * Mapping of permission rules by their source.
 */
export type ToolPermissionRulesBySource = {
  [T in PermissionRuleSource]?: string[];
};

/**
 * Additional working directory with its source.
 */
export type AdditionalWorkingDirectory = {
  path: string;
  source: PermissionRuleSource;
};

/**
 * Context needed for permission checking in tools.
 */
export type ToolPermissionContext = {
  /** Current permission mode */
  readonly mode: PermissionMode;
  /** Additional working directories permitted */
  readonly additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>;
  /** Rules that always allow */
  readonly alwaysAllowRules: ToolPermissionRulesBySource;
  /** Rules that always deny */
  readonly alwaysDenyRules: ToolPermissionRulesBySource;
  /** Rules that always prompt */
  readonly alwaysAskRules: ToolPermissionRulesBySource;
  /** Whether bypassPermissions mode is available */
  readonly isBypassPermissionsModeAvailable: boolean;
  /** Stripped dangerous rules for safety */
  readonly strippedDangerousRules?: ToolPermissionRulesBySource;
  /** Whether to avoid permission prompts (e.g., in auto mode) */
  readonly shouldAvoidPermissionPrompts?: boolean;
  /** Current active profile ID */
  readonly activeProfileId?: string;
  /** Required scopes for sensitive operations */
  readonly requiredScopes?: string[];
  /** Current granted scopes */
  readonly grantedScopes?: string[];
};

// ============================================================================
// Permission Pipeline Stages
// ============================================================================

/**
 * Stages in the permission pipeline.
 * Each stage is executed in order and can modify or block the flow.
 */
export type PermissionPipelineStage =
  | "validateInput"
  | "hooks"
  | "ruleMatching"
  | "mode"
  | "toolCheck"
  | "scopeCheck";

/**
 * Result from a pipeline stage.
 */
export type PermissionPipelineStageResult<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** Stage that produced this result */
  stage: PermissionPipelineStage;
  /** Whether to continue to next stage */
  continue: boolean;
  /** Decision if stage produced one */
  decision?: PermissionDecision<Input>;
  /** Modified input for next stages */
  modifiedInput?: Input;
  /** Stage-specific metadata */
  metadata?: Record<string, unknown>;
};
