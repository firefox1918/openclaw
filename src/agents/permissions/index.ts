/**
 * Permission system module.
 *
 * Provides multi-layer permission pipeline with modes, rules, and scope checks.
 * Adapted from Claude Code's permission architecture for OpenClaw.
 */

// Types
export type {
  AdditionalWorkingDirectory,
  ExternalPermissionMode,
  InternalPermissionMode,
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionBehavior,
  PermissionDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
  PermissionMode,
  PermissionPipelineStage,
  PermissionPipelineStageResult,
  PermissionProfile,
  PermissionProfileConfig,
  PermissionResult,
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
  PermissionUpdate,
  PermissionUpdateDestination,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
} from "./types.js";

export { EXTERNAL_PERMISSION_MODES, PERMISSION_MODES } from "./types.js";

// Modes
export {
  getModeColor,
  getModeConfig,
  isAutoAcceptEditsMode,
  isAutoMode,
  isBypassPermissionsMode,
  isDefaultMode,
  isDontAskMode,
  isExternalPermissionMode,
  isPlanMode,
  modeAllowsBehavior,
  permissionModeDescription,
  permissionModeFromString,
  permissionModeShortTitle,
  permissionModeSymbol,
  permissionModeTitle,
  toExternalPermissionMode,
} from "./modes.js";

// Rules
export {
  createDenyDecisionFromRule,
  createDecisionReasonFromRule,
  deduplicateRules,
  evaluateRules,
  filterRulesByBehavior,
  filterRulesBySource,
  filterRulesByTool,
  findMatchingRule,
  isToolInGroup,
  mergeRules,
  normalizeToolName,
  parseRuleString,
  parseRuleStrings,
  ruleContentMatches,
  ruleMatchesTool,
  sortRulesByPriority,
  TOOL_GROUPS,
} from "./rules.js";

export type { RuleMatchResult } from "./rules.js";

// Pipeline
export {
  checkPermission,
  createDefaultPermissionContext,
  createPermissionContextFromProfile,
  executePermissionPipeline,
  isOperationAllowed,
} from "./pipeline.js";

export type {
  HookResult,
  InputValidator,
  PermissionHook,
  PermissionPipelineInput,
  PermissionPipelineOutput,
  PipelineConfig,
  ToolChecker,
  ValidationResult,
} from "./pipeline.js";

// Persistence
export {
  cleanExpiredRules,
  clearAllSavedRules,
  getDefaultPermissionsFilePath,
  getOpenClawDir,
  getPersistenceStats,
  loadSavedRules,
  mergeSavedRulesWithExisting,
  removeSavedRule,
  savePermissionRule,
  savedRuleToPermissionRule,
  savedRulesToPermissionRules,
} from "./persistence.js";

export type {
  LoadRulesOptions,
  PersistedPermissions,
  SaveRuleOptions,
  SavedPermissionRule,
} from "./persistence.js";
