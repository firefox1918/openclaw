/**
 * Terminal backend manager.
 *
 * Provides unified interface for terminal execution across multiple backends.
 * Integrates dangerous command detection with permission system.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { checkDangerousCommandPermission } from "./dangerous.js";
import { executeLocalCommand, checkLocalBackendAvailability } from "./local.js";
import type {
  BackendAvailabilityResult,
  TerminalBackendConfig,
  TerminalBackendType,
  TerminalExecuteOptions,
  TerminalExecuteResult,
} from "./types.js";

const log = createSubsystemLogger("terminal/manager");

// ============================================================================
// Backend Registry
// ============================================================================

type BackendExecutor = (
  command: string,
  options?: TerminalExecuteOptions,
) => Promise<TerminalExecuteResult>;

type BackendAvailabilityChecker = () => BackendAvailabilityResult;

interface BackendRegistration {
  executor: BackendExecutor;
  availabilityChecker: BackendAvailabilityChecker;
}

const BACKEND_REGISTRY: Map<TerminalBackendType, BackendRegistration> = new Map();

// Register local backend
BACKEND_REGISTRY.set("local", {
  executor: executeLocalCommand,
  availabilityChecker: checkLocalBackendAvailability,
});

// Docker and SSH backends are already implemented in sandbox module
// We'll bridge them here later

// ============================================================================
// Backend Manager
// ============================================================================

/**
 * Terminal backend manager for unified execution.
 */
export class TerminalBackendManager {
  private readonly config: TerminalBackendConfig;
  private readonly sessionKey: string;
  private backendType: TerminalBackendType;

  constructor(config: TerminalBackendConfig, sessionKey: string) {
    this.config = config;
    this.sessionKey = sessionKey;
    this.backendType = config.type;
  }

  /**
   * Check if current backend is available.
   */
  async checkAvailability(): Promise<BackendAvailabilityResult> {
    const registration = BACKEND_REGISTRY.get(this.backendType);
    if (!registration) {
      return {
        available: false,
        reason: `Backend "${this.backendType}" not registered`,
      };
    }
    return registration.availabilityChecker();
  }

  /**
   * Get the current backend type.
   */
  getBackendType(): TerminalBackendType {
    return this.backendType;
  }

  /**
   * Set the backend type.
   */
  setBackendType(type: TerminalBackendType): void {
    this.backendType = type;
  }

  /**
   * Execute a command with dangerous command check.
   *
   * @param command - The command to execute
   * @param options - Execution options
   * @returns Execution result
   */
  async execute(command: string, options?: TerminalExecuteOptions): Promise<TerminalExecuteResult> {
    // Step 1: Check for dangerous commands
    const permissionResult = checkDangerousCommandPermission(command, this.sessionKey);

    if (permissionResult.behavior === "deny") {
      log.warn(`Command blocked: ${permissionResult.reason}`);
      return {
        stdout: Buffer.from([]),
        stderr: Buffer.from(
          `Command blocked: ${permissionResult.reason ?? "dangerous pattern detected"}`,
        ),
        exitCode: 1,
        timedOut: false,
        interrupted: false,
      };
    }

    // Step 2: If "ask", trigger approval workflow (integrate with Phase 6)
    if (permissionResult.behavior === "ask") {
      // This would trigger the approval UI via Gateway
      // For now, we return a pending state
      log.info(`Command requires approval: ${permissionResult.patternKey}`);
      // In production, this would call the approval flow from Phase 6
      // For this module, we return a special result indicating approval needed
      return {
        stdout: Buffer.from([]),
        stderr: Buffer.from(`Approval required: ${permissionResult.reason ?? ""}`),
        exitCode: 126, // Command not executable - approval needed
        timedOut: false,
        interrupted: false,
      };
    }

    // Step 3: Get backend executor
    const registration = BACKEND_REGISTRY.get(this.backendType);
    if (!registration) {
      throw new Error(`Backend "${this.backendType}" not registered`);
    }

    // Step 4: Execute command
    log.debug(`Executing command on ${this.backendType}: ${command.slice(0, 100)}...`);

    const mergedOptions: TerminalExecuteOptions = {
      cwd: options?.cwd ?? this.config.cwd,
      env: { ...this.config.env, ...options?.env },
      timeout: options?.timeout ?? this.config.timeout,
      stdin: options?.stdin,
      signal: options?.signal,
    };

    return registration.executor(command, mergedOptions);
  }

  /**
   * Execute a command without dangerous command check.
   * Use only for trusted internal operations.
   */
  async executeUnchecked(
    command: string,
    options?: TerminalExecuteOptions,
  ): Promise<TerminalExecuteResult> {
    const registration = BACKEND_REGISTRY.get(this.backendType);
    if (!registration) {
      throw new Error(`Backend "${this.backendType}" not registered`);
    }

    return registration.executor(command, options);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a terminal backend manager.
 */
export function createTerminalBackendManager(
  config: TerminalBackendConfig,
  sessionKey: string,
): TerminalBackendManager {
  return new TerminalBackendManager(config, sessionKey);
}

/**
 * Get all available backend types.
 */
export function getAvailableBackendTypes(): TerminalBackendType[] {
  const available: TerminalBackendType[] = [];

  for (const [type, registration] of BACKEND_REGISTRY) {
    const result = registration.availabilityChecker();
    if (result.available) {
      available.push(type);
    }
  }

  return available;
}

/**
 * Register a custom backend.
 */
export function registerTerminalBackend(
  type: TerminalBackendType,
  registration: BackendRegistration,
): void {
  BACKEND_REGISTRY.set(type, registration);
  log.info(`Registered terminal backend: ${type}`);
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Quick execute a command on local backend.
 */
export async function quickExecute(
  command: string,
  options?: TerminalExecuteOptions,
): Promise<TerminalExecuteResult> {
  return executeLocalCommand(command, options);
}

/**
 * Check if a command is dangerous.
 */
export function isDangerous(command: string): boolean {
  const result = checkDangerousCommandPermission(command, "default");
  return result.behavior !== "allow";
}
