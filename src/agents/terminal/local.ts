/**
 * Local terminal backend implementation.
 *
 * Executes commands directly on the host machine with spawn-per-call model.
 * Includes environment sanitization to prevent credential leakage.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  BackendAvailabilityResult,
  TerminalBackendConfig,
  TerminalExecuteOptions,
  TerminalExecuteResult,
} from "./types.js";

const log = createSubsystemLogger("terminal/local");

const IS_WINDOWS = process.platform === "win32";

// ============================================================================
// Environment Sanitization
// ============================================================================

/**
 * OpenClaw-internal env vars that should NOT leak into terminal subprocesses.
 * Provider API keys, secrets, and internal configuration.
 */
const OPENCLAW_PROVIDER_ENV_BLOCKLIST = new Set([
  // Provider API keys
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_ORG_ID",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY",
  "PERPLEXITY_API_KEY",
  "COHERE_API_KEY",
  "FIREWORKS_API_KEY",
  "XAI_API_KEY",
  "HELICONE_API_KEY",
  "OPENROUTER_API_KEY",

  // Internal config
  "OPENCLAW_SESSION_KEY",
  "OPENCLAW_AGENT_ID",
  "GATEWAY_ALLOWED_USERS",

  // Messaging secrets
  "TELEGRAM_HOME_CHANNEL",
  "DISCORD_HOME_CHANNEL",
  "SLACK_HOME_CHANNEL",
  "SIGNAL_HTTP_URL",
  "SIGNAL_ACCOUNT",
]);

/**
 * Standard PATH entries for environments with minimal PATH.
 */
const SANE_PATH =
  "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Build sanitized environment for subprocess execution.
 * Filters out provider secrets and ensures sane PATH.
 */
export function sanitizeSubprocessEnv(
  baseEnv: NodeJS.ProcessEnv,
  extraEnv?: Record<string, string>,
): Record<string, string> {
  const merged = { ...baseEnv, ...extraEnv };
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(merged)) {
    // Skip blocked secrets
    if (OPENCLAW_PROVIDER_ENV_BLOCKLIST.has(key)) {
      continue;
    }

    // Skip _HERMES_FORCE_ prefix (internal override mechanism)
    if (key.startsWith("_HERMES_FORCE_")) {
      const realKey = key.slice("_HERMES_FORCE_".length);
      if (value !== undefined) {
        sanitized[realKey] = value;
      }
      continue;
    }

    // Include allowed vars
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }

  // Ensure sane PATH
  const existingPath = sanitized.PATH ?? "";
  if (!existingPath.includes("/usr/bin")) {
    sanitized.PATH = existingPath ? `${existingPath}:${SANE_PATH}` : SANE_PATH;
  }

  return sanitized;
}

// ============================================================================
// Bash Shell Finder
// ============================================================================

/**
 * Find bash executable for command execution.
 */
export function findBash(): string {
  if (!IS_WINDOWS) {
    // Unix: try common locations
    const candidates: (string | undefined)[] = [
      process.env.SHELL,
      "/bin/bash",
      "/usr/bin/bash",
      "/usr/local/bin/bash",
      "/opt/homebrew/bin/bash",
    ];

    for (const candidate of candidates) {
      if (candidate && isExecutable(candidate)) {
        return candidate;
      }
    }

    // Fallback to sh
    return "/bin/sh";
  }

  // Windows: find Git Bash
  const customPath = process.env.HERMES_GIT_BASH_PATH;
  if (customPath && isExecutable(customPath)) {
    return customPath;
  }

  // Common Git Bash locations on Windows
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const localAppData = process.env.LOCALAPPDATA ?? "";

  const windowsCandidates = [
    path.join(programFiles, "Git", "bin", "bash.exe"),
    path.join(programFiles, "Git", "usr", "bin", "bash.exe"),
    path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
  ];

  for (const candidate of windowsCandidates) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Git Bash not found. OpenClaw requires Git for Windows on Windows.\n" +
      "Install from: https://git-scm.com/download/win\n" +
      "Or set HERMES_GIT_BASH_PATH to your bash.exe location.",
  );
}

/**
 * Check if a file exists and is executable.
 */
function isExecutable(filePath: string): boolean {
  try {
    // Simple existence check - executable bit check varies by platform
    const fs = require("node:fs");
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

// ============================================================================
// Local Backend Implementation
// ============================================================================

/**
 * Check if local backend is available.
 */
export function checkLocalBackendAvailability(): BackendAvailabilityResult {
  try {
    findBash();
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message : "Bash not available",
    };
  }
}

/**
 * Create local backend configuration.
 */
export function createLocalBackendConfig(
  options?: Partial<TerminalBackendConfig>,
): TerminalBackendConfig {
  return {
    type: "local",
    cwd: options?.cwd ?? process.cwd(),
    timeout: options?.timeout ?? 60,
    env: options?.env ?? {},
  };
}

/**
 * Execute a command on the local machine.
 */
export async function executeLocalCommand(
  command: string,
  options?: TerminalExecuteOptions,
): Promise<TerminalExecuteResult> {
  const bash = findBash();
  const cwd = options?.cwd ?? process.cwd();
  const timeout = options?.timeout ?? 60;
  const env = sanitizeSubprocessEnv(process.env, options?.env);

  log.debug(`Executing local command: ${command.slice(0, 100)}...`);

  return new Promise<TerminalExecuteResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let interrupted = false;
    let exited = false;

    const child = spawn(bash, ["-c", command], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      // Set process group on Unix for clean termination
      ...(IS_WINDOWS ? {} : { detached: true }),
    });

    // Collect stdout
    child.stdout?.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    // Collect stderr
    child.stderr?.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    // Handle stdin if provided
    if (options?.stdin) {
      const stdinData =
        typeof options.stdin === "string" ? Buffer.from(options.stdin) : options.stdin;
      child.stdin?.write(stdinData);
      child.stdin?.end();
    }

    // Handle abort signal
    const signal = options?.signal;
    const handleAbort = () => {
      if (exited) {
        return;
      }
      interrupted = true;
      if (IS_WINDOWS) {
        child.kill("SIGTERM");
      } else {
        // Kill entire process group
        try {
          process.kill(-(child.pid ?? 0), "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    };

    if (signal) {
      if (signal.aborted) {
        handleAbort();
      } else {
        signal.addEventListener("abort", handleAbort);
      }
    }

    // Handle timeout
    const timeoutTimer = setTimeout(() => {
      if (exited) {
        return;
      }
      timedOut = true;
      handleAbort();
    }, timeout * 1000);

    // Handle exit
    child.on("close", (code) => {
      exited = true;
      clearTimeout(timeoutTimer);
      if (signal) {
        signal.removeEventListener("abort", handleAbort);
      }

      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);

      log.debug(`Local command completed: exitCode=${code}, timedOut=${timedOut}`);

      resolve({
        stdout,
        stderr,
        exitCode: code ?? (timedOut ? 124 : interrupted ? 130 : 1),
        timedOut,
        interrupted,
      });
    });

    // Handle spawn errors
    child.on("error", (err) => {
      exited = true;
      clearTimeout(timeoutTimer);
      log.error(`Local command spawn error: ${err.message}`);
      resolve({
        stdout: Buffer.from([]),
        stderr: Buffer.from(err.message),
        exitCode: 1,
        timedOut: false,
        interrupted: false,
      });
    });
  });
}

/**
 * Kill a local process and all its children (process group).
 */
export function killLocalProcess(pid: number): void {
  if (IS_WINDOWS) {
    // Windows: use taskkill to kill process tree
    spawn("taskkill", ["/pid", String(pid), "/f", "/t"]);
  } else {
    // Unix: kill entire process group
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Process may already be dead
    }
  }
}
