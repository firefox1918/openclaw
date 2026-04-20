/**
 * Terminal execution types and constants.
 *
 * Provides dangerous command patterns, execution result types,
 * and backend configuration options.
 *
 * ## Backend Types vs Sandbox
 *
 * `TerminalBackendType` defines abstract backend types, but only "local"
 * is registered in this module. Docker/SSH backends are implemented in
 * the sandbox module with richer context (container lifecycle, mounts).
 *
 * See `backend-manager.ts` for module boundary documentation.
 */

// ============================================================================
// Dangerous Command Patterns
// ============================================================================

/**
 * Dangerous command pattern definition.
 * Each pattern includes a regex and a human-readable description.
 */
export type DangerousPattern = {
  pattern: RegExp;
  description: string;
};

/**
 * Sensitive write targets that should trigger approval even when
 * referenced via shell expansions like $HOME.
 */
// Note: These are used in pattern construction below

/**
 * Dangerous command patterns from Hermes Agent.
 * These patterns detect potentially destructive commands that require approval.
 *
 * Categories:
 * - File system destruction (rm -rf, chmod 777, etc.)
 * - Disk/device operations (dd, mkfs)
 * - SQL destructive operations (DROP, DELETE without WHERE)
 * - System service manipulation (systemctl stop)
 * - Process manipulation (kill -9, fork bombs)
 * - Remote script execution (curl | sh)
 * - Configuration file modification
 * - Git destructive operations (reset --hard, force push)
 */
export const DANGEROUS_PATTERNS: DangerousPattern[] = [
  // File system destruction
  { pattern: /\brm\s+-rf\s+\//i, description: "delete in root path" },
  { pattern: /\brm\s+-[^\s]*r\b/i, description: "recursive delete" },
  { pattern: /\brm\s+--recursive\b/i, description: "recursive delete (long flag)" },

  // Permission changes
  {
    pattern: /\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w|a\+[rwx]*w)\b/i,
    description: "world/other-writable permissions",
  },
  {
    pattern: /\bchmod\s+--recursive\b.*(777|666|o\+[rwx]*w|a\+[rwx]*w)/i,
    description: "recursive world/other-writable (long flag)",
  },

  // Ownership changes
  { pattern: /\bchown\s+(-[^\s]*)?R\s+root\b/i, description: "recursive chown to root" },
  { pattern: /\bchown\s+--recursive\b.*root/i, description: "recursive chown to root (long flag)" },

  // Disk/device operations
  { pattern: /\bmkfs\b/i, description: "format filesystem" },
  { pattern: /\bdd\s+.*if=/i, description: "disk copy" },
  { pattern: />\/dev\/sd/i, description: "write to block device" },

  // SQL destructive operations
  { pattern: /\bDROP\s+(TABLE|DATABASE)\b/i, description: "SQL DROP" },
  { pattern: /\bDELETE\s+FROM\b(?!\s.*\bWHERE\b)/i, description: "SQL DELETE without WHERE" },
  { pattern: /\bTRUNCATE\s+(TABLE)?\s*\w/i, description: "SQL TRUNCATE" },

  // System configuration
  { pattern: />\/etc\//i, description: "overwrite system config" },
  { pattern: /\bsystemctl\s+(stop|disable|mask)\b/i, description: "stop/disable system service" },

  // Process manipulation
  { pattern: /\bkill\s+-9\s+-1\b/i, description: "kill all processes" },
  { pattern: /\bpkill\s+-9\b/i, description: "force kill processes" },
  // Fork bomb: :(){ :|:& };:
  { pattern: /:\(\)\s*\{.*:\s*\|.*:&.*\}\s*;.*:/i, description: "fork bomb" },

  // Shell command execution
  {
    pattern: /\b(bash|sh|zsh|ksh)\s+-[^\s]*c(\s+|$)/i,
    description: "shell command via -c/-lc flag",
  },
  {
    pattern: /\b(python[23]?|perl|ruby|node)\s+-[ec]\s+/i,
    description: "script execution via -e/-c flag",
  },

  // Remote script execution
  { pattern: /\b(curl|wget)\b.*\|\s*(ba)?sh\b/i, description: "pipe remote content to shell" },
  {
    pattern: /\b(bash|sh|zsh|ksh)\s+<\s*<?\s*\(\s*(curl|wget)\b/i,
    description: "execute remote script via process substitution",
  },

  // File overwrite via tee/redirection
  { pattern: /\btee\b.*["']?\/etc\//i, description: "overwrite system file via tee" },
  { pattern: />>?\s*["']?\/etc\//i, description: "overwrite system file via redirection" },

  // Destructive combinations
  { pattern: /\bxargs\s+.*\brm\b/i, description: "xargs with rm" },
  { pattern: /\bfind\b.*-exec\s+.*rm\b/i, description: "find -exec rm" },
  { pattern: /\bfind\b.*-delete\b/i, description: "find -delete" },

  // File copy/move/edit into system paths
  { pattern: /\b(cp|mv|install)\b.*\/etc\//i, description: "copy/move file into /etc/" },
  { pattern: /\bsed\s+-[^\s]*i.*\/etc\//i, description: "in-place edit of system config" },
  {
    pattern: /\bsed\s+--in-place\b.*\/etc\//i,
    description: "in-place edit of system config (long flag)",
  },

  // Heredoc script execution
  {
    pattern: /\b(python[23]?|perl|ruby|node)\s+<<\b/i,
    description: "script execution via heredoc",
  },

  // Git destructive operations
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    description: "git reset --hard (destroys uncommitted changes)",
  },
  {
    pattern: /\bgit\s+push\b.*--force\b/i,
    description: "git force push (rewrites remote history)",
  },
  {
    pattern: /\bgit\s+push\b.*-f\b/i,
    description: "git force push short flag (rewrites remote history)",
  },
  {
    pattern: /\bgit\s+clean\s+-[^\s]*f\b/i,
    description: "git clean with force (deletes untracked files)",
  },
  { pattern: /\bgit\s+branch\s+-D\b/i, description: "git branch force delete" },

  // chmod +x followed by execution
  {
    pattern: /\bchmod\s+\+x\b.*[;&|].*\.\//i,
    description: "chmod +x followed by immediate execution",
  },

  // Self-termination protection
  {
    pattern: /\b(pkill|killall)\b.*\b(openclaw|gateway)\b/i,
    description: "kill openclaw/gateway process (self-termination)",
  },
  {
    pattern: /\bkill\b.*\$\(\s*pgrep\b/i,
    description: "kill process via pgrep expansion (self-termination)",
  },
  {
    pattern: /\bkill\b.*`\s*pgrep\b/i,
    description: "kill process via backtick pgrep expansion (self-termination)",
  },
];

/**
 * Result of dangerous command detection.
 */
export type DangerousDetectionResult = {
  isDangerous: boolean;
  patternKey: string | null;
  description: string | null;
};

// ============================================================================
// Execution Result Types
// ============================================================================

/**
 * Terminal command execution result.
 */
export type TerminalExecuteResult = {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  timedOut: boolean;
  interrupted: boolean;
};

/**
 * Terminal command execution options.
 */
export type TerminalExecuteOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  stdin?: Buffer | string;
  signal?: AbortSignal;
  usePty?: boolean;
};

// ============================================================================
// Backend Types
// ============================================================================

/**
 * Terminal backend types supported.
 *
 * Note: Only "local" is registered in terminal module.
 * Docker/SSH backends are in sandbox module with container context.
 * Modal, Daytona, Singularity are placeholder types for future extensions.
 */
export type TerminalBackendType = "local" | "docker" | "ssh" | "modal" | "daytona" | "singularity";

/**
 * Terminal backend configuration.
 */
export type TerminalBackendConfig = {
  type: TerminalBackendType;
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;

  // Docker-specific
  docker?: {
    image?: string;
    cpu?: number;
    memory?: number;
    disk?: number;
    persistent?: boolean;
    volumes?: string[];
    network?: boolean;
  };

  // SSH-specific
  ssh?: {
    host?: string;
    port?: number;
    user?: string;
    privateKeyPath?: string;
  };
};

/**
 * Terminal backend availability check result.
 */
export type BackendAvailabilityResult = {
  available: boolean;
  reason?: string;
};

// ============================================================================
// Constants
// ============================================================================

/**
 * Default timeout for terminal commands (seconds).
 */
export const DEFAULT_TERMINAL_TIMEOUT = 60;

/**
 * Maximum foreground timeout (seconds).
 */
export const FOREGROUND_MAX_TIMEOUT = 600;

/**
 * Maximum consecutive failures before circuit breaker opens.
 */
export const MAX_CONSECUTIVE_TERMINAL_FAILURES = 3;

/**
 * Blocked sources for terminal execution (recursion protection).
 */
export const TERMINAL_BLOCKED_QUERY_SOURCES = ["session_memory", "compact", "marble_origami"];
