/**
 * Terminal execution module.
 *
 * Provides unified terminal command execution with:
 * - Dangerous command detection (from Hermes Agent)
 * - Multiple backend support (local, docker, ssh)
 * - Session-scoped approval state management
 * - Permission system integration (Phase 6)
 */

// Types and constants
export {
  DANGEROUS_PATTERNS,
  DEFAULT_TERMINAL_TIMEOUT,
  FOREGROUND_MAX_TIMEOUT,
  MAX_CONSECUTIVE_TERMINAL_FAILURES,
  TERMINAL_BLOCKED_QUERY_SOURCES,
  type DangerousPattern,
  type DangerousDetectionResult,
  type TerminalExecuteResult,
  type TerminalExecuteOptions,
  type TerminalBackendType,
  type TerminalBackendConfig,
  type BackendAvailabilityResult,
} from "./types.js";

// Dangerous command detection
export {
  stripAnsi,
  normalizeCommandForDetection,
  detectDangerousCommand,
  isCommandSafeToExecute,
  getApprovalKeyAliases,
  getSessionApprovedPatterns,
  approvePatternForSession,
  revokePatternForSession,
  clearSessionApprovals,
  buildApprovalRequestMessage,
  checkDangerousCommandPermission,
} from "./dangerous.js";

// Local backend
export {
  sanitizeSubprocessEnv,
  findBash,
  checkLocalBackendAvailability,
  createLocalBackendConfig,
  executeLocalCommand,
  killLocalProcess,
} from "./local.js";

// Backend manager
export {
  TerminalBackendManager,
  createTerminalBackendManager,
  getAvailableBackendTypes,
  registerTerminalBackend,
  quickExecute,
  isDangerous,
} from "./backend-manager.js";
