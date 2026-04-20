/**
 * Terminal execution module.
 *
 * Provides unified terminal command execution with:
 * - Dangerous command detection (30+ patterns from Hermes Agent)
 * - Local backend support (host process spawn)
 * - Session-scoped approval state management
 * - Permission system integration (Phase 6)
 *
 * ## Relationship with Sandbox Module
 *
 * This module focuses on **command-level security**:
 * - Pattern-based dangerous command detection
 * - Obfuscation normalization (ANSI, null bytes, Unicode)
 * - Approval workflow for destructive operations
 *
 * The sandbox module (`../sandbox/`) handles **container-level isolation**:
 * - Docker/SSH backend execution
 * - Security hardening (capDrop, pidsLimit, no-new-privileges)
 * - Workspace lifecycle and mount management
 *
 * **Integration**: `bash-tools.exec.ts` orchestrates both:
 * 1. Terminal module checks dangerous patterns (always runs)
 * 2. If sandbox context exists → sandbox module executes
 * 3. If no sandbox → terminal module's local backend executes
 *
 * ## When to Use This Module
 *
 * - Local host execution (development, tools without sandbox)
 * - Dangerous command detection in any execution context
 * - Session-scoped approval state management
 *
 * ## When to Use Sandbox Module
 *
 * - Containerized execution with isolation
 * - Workspace mount and sync operations
 * - Docker/SSH backend lifecycle management
 *
 * @module terminal
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
