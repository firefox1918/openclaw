/**
 * Permission pipeline implementation.
 *
 * Implements a multi-layer permission pipeline that processes requests through
 * several stages: validateInput → hooks → ruleMatching → mode → toolCheck → scopeCheck.
 *
 * Adapted from Claude Code's permissions.ts for OpenClaw.
 */

import {
  isBypassPermissionsMode,
  isDefaultMode,
  isDontAskMode,
  isPlanMode,
  modeAllowsBehavior,
} from "./modes.js";
import { loadSavedRules, savedRuleToPermissionRule } from "./persistence.js";
import { evaluateRules, parseRuleString, ruleMatchesTool } from "./rules.js";
import type {
  AdditionalWorkingDirectory,
  PermissionDecision,
  PermissionPipelineStage,
  PermissionPipelineStageResult,
  PermissionProfile,
  PermissionResult,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
} from "./types.js";

// ============================================================================
// Pipeline Types
// ============================================================================

/**
 * Input to the permission pipeline.
 */
export type PermissionPipelineInput<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** Tool name being checked */
  toolName: string;
  /** Tool input parameters */
  input: Input;
  /** Current working directory */
  cwd?: string;
  /** Additional context for rule matching */
  ruleContent?: string;
  /** Permission context */
  context: ToolPermissionContext;
  /** Operation type */
  operationType?: "read" | "write" | "execute" | "control";
  /** Whether this is a dangerous operation */
  isDangerous?: boolean;
  /** Hook results to consider */
  hookResults?: HookResult[];
};

/**
 * Result from a permission hook.
 */
export type HookResult = {
  /** Hook name */
  name: string;
  /** Hook source */
  source?: string;
  /** Whether the hook approved the operation */
  approved: boolean;
  /** Optional modified input */
  modifiedInput?: Record<string, unknown>;
  /** Optional reason */
  reason?: string;
};

/**
 * Complete pipeline result.
 */
export type PermissionPipelineOutput<
  Input extends Record<string, unknown> = Record<string, unknown>,
> = {
  /** Final decision */
  decision: PermissionResult<Input>;
  /** Stages that were executed */
  stages: PermissionPipelineStageResult<Input>[];
  /** Whether pipeline was short-circuited */
  shortCircuited?: boolean;
  /** Stage that caused short-circuit */
  shortCircuitStage?: PermissionPipelineStage;
};

/**
 * Pipeline configuration.
 */
export type PipelineConfig = {
  /** Stages to execute (in order) */
  stages?: PermissionPipelineStage[];
  /** Whether to allow short-circuiting */
  allowShortCircuit?: boolean;
  /** Custom hooks to run */
  hooks?: PermissionHook[];
  /** Custom validators for input validation */
  validators?: InputValidator[];
  /** Custom tool checkers */
  toolCheckers?: ToolChecker[];
};

/**
 * A permission hook that can modify or block the pipeline.
 */
export type PermissionHook = (input: PermissionPipelineInput) => Promise<HookResult> | HookResult;

/**
 * An input validator that checks input validity.
 */
export type InputValidator = (
  input: PermissionPipelineInput,
) => Promise<ValidationResult> | ValidationResult;

/**
 * Result from input validation.
 */
export type ValidationResult = {
  /** Whether input is valid */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** Modified input */
  modifiedInput?: Record<string, unknown>;
};

/**
 * A tool-specific permission checker.
 */
export type ToolChecker = (
  input: PermissionPipelineInput,
) => Promise<PermissionDecision | null> | PermissionDecision | null;

// ============================================================================
// Default Pipeline Configuration
// ============================================================================

const DEFAULT_STAGES: PermissionPipelineStage[] = [
  "validateInput",
  "hooks",
  "ruleMatching",
  "mode",
  "toolCheck",
  "scopeCheck",
];

// ============================================================================
// Pipeline Implementation
// ============================================================================

/**
 * Execute the permission pipeline.
 */
export async function executePermissionPipeline<Input extends Record<string, unknown>>(
  pipelineInput: PermissionPipelineInput<Input>,
  config?: PipelineConfig,
): Promise<PermissionPipelineOutput<Input>> {
  const stages = config?.stages ?? DEFAULT_STAGES;
  const stageResults: PermissionPipelineStageResult<Input>[] = [];
  let currentInput = pipelineInput.input;
  let shortCircuited = false;
  let shortCircuitStage: PermissionPipelineStage | undefined;

  for (const stage of stages) {
    const stageResult = await executeStage(
      stage,
      {
        ...pipelineInput,
        input: currentInput,
      },
      config,
    );

    stageResults.push(stageResult);

    // Check if we should short-circuit
    if (!stageResult.continue && (config?.allowShortCircuit ?? true)) {
      shortCircuited = true;
      shortCircuitStage = stage;
      break;
    }

    // Apply modified input
    if (stageResult.modifiedInput) {
      currentInput = stageResult.modifiedInput;
    }
  }

  // Determine final decision
  const lastDecision = stageResults.findLast((r) => r.decision)?.decision;
  const decision: PermissionResult<Input> = lastDecision ?? {
    behavior: "ask",
    message: `Permission required for tool '${pipelineInput.toolName}'`,
    decisionReason: { type: "mode", mode: pipelineInput.context.mode },
  };

  return {
    decision,
    stages: stageResults,
    shortCircuited,
    shortCircuitStage,
  };
}

/**
 * Execute a single pipeline stage.
 */
async function executeStage<Input extends Record<string, unknown>>(
  stage: PermissionPipelineStage,
  input: PermissionPipelineInput<Input>,
  config?: PipelineConfig,
): Promise<PermissionPipelineStageResult<Input>> {
  switch (stage) {
    case "validateInput":
      return executeValidateInputStage(input, config);
    case "hooks":
      return executeHooksStage(input, config);
    case "ruleMatching":
      return executeRuleMatchingStage(input);
    case "mode":
      return executeModeStage(input);
    case "toolCheck":
      return executeToolCheckStage(input, config);
    case "scopeCheck":
      return executeScopeCheckStage(input);
    default:
      return { stage, continue: true };
  }
}

// ============================================================================
// Stage Implementations
// ============================================================================

/**
 * Stage 1: Validate Input
 */
async function executeValidateInputStage<Input extends Record<string, unknown>>(
  input: PermissionPipelineInput<Input>,
  config?: PipelineConfig,
): Promise<PermissionPipelineStageResult<Input>> {
  const validators = config?.validators ?? [];

  for (const validator of validators) {
    const result = await validator(input);
    if (!result.valid) {
      return {
        stage: "validateInput",
        continue: false,
        decision: {
          behavior: "deny",
          message: result.error ?? "Invalid input",
          decisionReason: { type: "other", reason: "validation_failed" },
        },
      };
    }
    if (result.modifiedInput) {
      input.input = result.modifiedInput as Input;
    }
  }

  return { stage: "validateInput", continue: true };
}

/**
 * Stage 2: Hooks
 */
async function executeHooksStage<Input extends Record<string, unknown>>(
  input: PermissionPipelineInput<Input>,
  config?: PipelineConfig,
): Promise<PermissionPipelineStageResult<Input>> {
  const hooks = config?.hooks ?? [];
  const hookResults = input.hookResults ?? [];

  // Run custom hooks
  for (const hook of hooks) {
    const result = await hook(input);
    hookResults.push(result);
  }

  // Process hook results
  for (const result of hookResults) {
    if (!result.approved) {
      return {
        stage: "hooks",
        continue: false,
        decision: {
          behavior: "deny",
          message: result.reason ?? `Hook '${result.name}' denied permission`,
          decisionReason: {
            type: "hook",
            hookName: result.name,
            hookSource: result.source,
            reason: result.reason,
          },
        },
      };
    }
    if (result.modifiedInput) {
      input.input = { ...input.input, ...result.modifiedInput } as Input;
    }
  }

  return {
    stage: "hooks",
    continue: true,
    modifiedInput: input.input,
    metadata: { hookResults },
  };
}

/**
 * Stage 3: Rule Matching
 */
function executeRuleMatchingStage<Input extends Record<string, unknown>>(
  input: PermissionPipelineInput<Input>,
): PermissionPipelineStageResult<Input> {
  const matchResult = evaluateRules(input.context, input.toolName, input.ruleContent);

  if (!matchResult.matched) {
    return { stage: "ruleMatching", continue: true };
  }

  const behavior = matchResult.behavior;

  if (behavior === "deny") {
    return {
      stage: "ruleMatching",
      continue: false,
      decision: {
        behavior: "deny",
        message: `Permission denied by rule from ${matchResult.rule?.source}`,
        decisionReason: { type: "rule", rule: matchResult.rule! },
      },
    };
  }

  if (behavior === "allow") {
    return {
      stage: "ruleMatching",
      continue: true,
      decision: {
        behavior: "allow",
        decisionReason: { type: "rule", rule: matchResult.rule! },
      },
    };
  }

  if (behavior === "ask") {
    return {
      stage: "ruleMatching",
      continue: false,
      decision: {
        behavior: "ask",
        message: `Permission required by rule from ${matchResult.rule?.source}`,
        decisionReason: { type: "rule", rule: matchResult.rule! },
      },
    };
  }

  return { stage: "ruleMatching", continue: true };
}

/**
 * Stage 4: Mode
 */
function executeModeStage<Input extends Record<string, unknown>>(
  input: PermissionPipelineInput<Input>,
): PermissionPipelineStageResult<Input> {
  const mode = input.context.mode;

  // Bypass permissions mode
  if (isBypassPermissionsMode(mode)) {
    if (!input.context.isBypassPermissionsModeAvailable) {
      return {
        stage: "mode",
        continue: false,
        decision: {
          behavior: "deny",
          message: "Bypass permissions mode is not available",
          decisionReason: { type: "mode", mode },
        },
      };
    }
    return {
      stage: "mode",
      continue: true,
      decision: {
        behavior: "allow",
        decisionReason: { type: "mode", mode },
      },
    };
  }

  // Don't ask mode - deny by default
  if (isDontAskMode(mode)) {
    return {
      stage: "mode",
      continue: false,
      decision: {
        behavior: "deny",
        message: `Permission denied by '${mode}' mode`,
        decisionReason: { type: "mode", mode },
      },
    };
  }

  // Plan mode - check operation type
  if (isPlanMode(mode)) {
    const opType = input.operationType ?? "execute";
    if (opType === "write" || opType === "execute") {
      return {
        stage: "mode",
        continue: false,
        decision: {
          behavior: "ask",
          message: `Plan mode requires approval for '${opType}' operations`,
          decisionReason: { type: "mode", mode },
        },
      };
    }
    // Read operations allowed in plan mode
    return {
      stage: "mode",
      continue: true,
      decision: {
        behavior: "allow",
        decisionReason: { type: "mode", mode },
      },
    };
  }

  // Default mode - prompt for everything unless already decided
  if (isDefaultMode(mode)) {
    return { stage: "mode", continue: true };
  }

  // Other modes - continue to next stage
  return { stage: "mode", continue: true };
}

/**
 * Stage 5: Tool Check
 */
async function executeToolCheckStage<Input extends Record<string, unknown>>(
  input: PermissionPipelineInput<Input>,
  config?: PipelineConfig,
): Promise<PermissionPipelineStageResult<Input>> {
  const toolCheckers = config?.toolCheckers ?? [];

  // Run tool-specific checkers
  for (const checker of toolCheckers) {
    const result = await checker(input);
    if (result) {
      return {
        stage: "toolCheck",
        continue: result.behavior === "allow",
        decision: result as PermissionDecision<Input>,
      };
    }
  }

  // Default tool check - dangerous operations require permission
  if (input.isDangerous) {
    return {
      stage: "toolCheck",
      continue: false,
      decision: {
        behavior: "ask",
        message: `Dangerous operation requires permission: '${input.toolName}'`,
        decisionReason: {
          type: "safetyCheck",
          reason: "dangerous_operation",
          classifierApprovable: true,
        },
      },
    };
  }

  return { stage: "toolCheck", continue: true };
}

/**
 * Stage 6: Scope Check
 */
function executeScopeCheckStage<Input extends Record<string, unknown>>(
  input: PermissionPipelineInput<Input>,
): PermissionPipelineStageResult<Input> {
  const requiredScopes = input.context.requiredScopes ?? [];
  const grantedScopes = input.context.grantedScopes ?? [];

  // Check if all required scopes are granted
  const missingScopes = requiredScopes.filter((scope) => !grantedScopes.includes(scope));

  if (missingScopes.length > 0) {
    return {
      stage: "scopeCheck",
      continue: false,
      decision: {
        behavior: "deny",
        message: `Missing required scopes: ${missingScopes.join(", ")}`,
        decisionReason: {
          type: "scopeCheck",
          requiredScope: requiredScopes,
          missingScopes,
        },
      },
    };
  }

  return { stage: "scopeCheck", continue: true };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a default permission context.
 */
export function createDefaultPermissionContext(): ToolPermissionContext {
  return {
    mode: "default",
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    shouldAvoidPermissionPrompts: false,
  };
}

/**
 * Create a permission context from a profile.
 */
export function createPermissionContextFromProfile(
  profile: PermissionProfile,
): ToolPermissionContext {
  const allowRules: ToolPermissionRulesBySource = {
    agentProfile: profile.allow?.map(
      (r) => `${r.toolName}${r.ruleContent ? `:${r.ruleContent}` : ""}`,
    ),
  };
  const denyRules: ToolPermissionRulesBySource = {
    agentProfile: profile.deny?.map(
      (r) => `${r.toolName}${r.ruleContent ? `:${r.ruleContent}` : ""}`,
    ),
  };
  const askRules: ToolPermissionRulesBySource = {
    agentProfile: profile.ask?.map(
      (r) => `${r.toolName}${r.ruleContent ? `:${r.ruleContent}` : ""}`,
    ),
  };

  const additionalDirs = new Map<string, AdditionalWorkingDirectory>();
  for (const dir of profile.additionalWorkingDirectories ?? []) {
    additionalDirs.set(dir, { path: dir, source: "agentProfile" });
  }

  return {
    mode: profile.defaultMode ?? "default",
    additionalWorkingDirectories: additionalDirs,
    alwaysAllowRules: allowRules,
    alwaysDenyRules: denyRules,
    alwaysAskRules: askRules,
    isBypassPermissionsModeAvailable: profile.bypassPermissionsAvailable ?? false,
    activeProfileId: profile.id,
    requiredScopes: profile.requiredScope ?? [],
    grantedScopes: [],
  };
}

/**
 * Check permission using the pipeline (convenience function).
 */
export async function checkPermission<Input extends Record<string, unknown>>(
  toolName: string,
  input: Input,
  context: ToolPermissionContext,
  options?: {
    cwd?: string;
    ruleContent?: string;
    operationType?: "read" | "write" | "execute" | "control";
    isDangerous?: boolean;
    hooks?: PermissionHook[];
    validators?: InputValidator[];
    toolCheckers?: ToolChecker[];
  },
): Promise<PermissionResult<Input>> {
  const result = await executePermissionPipeline(
    {
      toolName,
      input,
      cwd: options?.cwd,
      ruleContent: options?.ruleContent,
      context,
      operationType: options?.operationType,
      isDangerous: options?.isDangerous,
    },
    {
      hooks: options?.hooks,
      validators: options?.validators,
      toolCheckers: options?.toolCheckers,
    },
  );
  return result.decision;
}

/**
 * Quick check if an operation is allowed without prompting.
 */
export function isOperationAllowed(
  toolName: string,
  context: ToolPermissionContext,
  operationType?: "read" | "write" | "execute",
): boolean {
  // Check mode-based decisions first
  if (modeAllowsBehavior(context.mode, operationType ?? "execute")) {
    return true;
  }

  // Check allow rules
  const allowRules = context.alwaysAllowRules;
  for (const rules of Object.values(allowRules)) {
    if (rules) {
      for (const rule of rules) {
        const parsed = parseRuleString(rule);
        if (parsed && ruleMatchesTool(parsed, toolName)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Create a permission context with persisted rules loaded from disk.
 *
 * This is the recommended way to create a permission context for production use,
 * as it merges any previously saved permission decisions with the profile rules.
 *
 * @param profile - Permission profile to use as base
 * @returns Permission context with persisted rules merged in
 */
export async function createPermissionContextWithPersistence(
  profile: PermissionProfile,
): Promise<ToolPermissionContext> {
  // Create base context from profile
  const baseContext = createPermissionContextFromProfile(profile);

  // Load persisted rules
  const savedRules = await loadSavedRules();

  // Merge saved rules into context's rule maps
  for (const saved of savedRules) {
    const rule = savedRuleToPermissionRule(saved, "session");
    const ruleKey = `${rule.ruleValue.toolName}${rule.ruleValue.ruleContent ? `:${rule.ruleValue.ruleContent}` : ""}`;

    // Determine which rule map to add to based on behavior
    switch (rule.ruleBehavior) {
      case "allow":
        if (!baseContext.alwaysAllowRules.session) {
          baseContext.alwaysAllowRules.session = [];
        }
        if (!baseContext.alwaysAllowRules.session.includes(ruleKey)) {
          baseContext.alwaysAllowRules.session.push(ruleKey);
        }
        break;
      case "deny":
        if (!baseContext.alwaysDenyRules.session) {
          baseContext.alwaysDenyRules.session = [];
        }
        if (!baseContext.alwaysDenyRules.session.includes(ruleKey)) {
          baseContext.alwaysDenyRules.session.push(ruleKey);
        }
        break;
      case "ask":
        if (!baseContext.alwaysAskRules.session) {
          baseContext.alwaysAskRules.session = [];
        }
        if (!baseContext.alwaysAskRules.session.includes(ruleKey)) {
          baseContext.alwaysAskRules.session.push(ruleKey);
        }
        break;
    }
  }

  return baseContext;
}
