/**
 * Dangerous command check and approval flow for exec tool.
 *
 * Bridges the terminal dangerous detection module to bash-tools.exec,
 * integrating with the Gateway approval system for user confirmation.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { PluginApprovalResolutions } from "../plugins/types.js";
import {
  approvePatternForSession,
  buildApprovalRequestMessage,
  checkDangerousCommandPermission,
  detectDangerousCommand,
} from "./terminal/dangerous.js";
import { callGatewayTool } from "./tools/gateway.js";

const log = createSubsystemLogger("bash-tools/exec-dangerous-check");

/**
 * Check result from dangerous command detection.
 */
export type DangerousCommandCheckResult = {
  /** Whether the command execution should be blocked */
  blocked: boolean;
  /** Reason for blocking (if blocked) */
  reason?: string;
  /** Pattern key that was approved (if approved via Gateway) */
  approvedPatternKey?: string;
};

/**
 * Parameters for dangerous command check.
 */
export type DangerousCommandCheckParams = {
  /** The command to check */
  command: string;
  /** Session key for approval caching */
  sessionKey?: string;
  /** Agent ID for approval context */
  agentId?: string;
  /** Message provider channel for approval routing */
  turnSourceChannel?: string;
  /** Account ID for approval routing */
  turnSourceAccountId?: string;
  /** Trigger type (e.g., "cron" for headless mode) */
  trigger?: string;
  /** Warnings array to append approval messages */
  warnings?: string[];
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
};

/**
 * Default session key when none is provided.
 * Used to isolate approvals across different execution contexts.
 */
const DEFAULT_SESSION_KEY = "default-exec-session";

/**
 * Check if a command is dangerous and request approval if needed.
 *
 * Flow:
 * 1. Call checkDangerousCommandPermission to detect dangerous patterns
 * 2. If behavior="allow" → command is safe or pre-approved, return blocked=false
 * 3. If behavior="deny" → command is blocked by policy, return blocked=true
 * 4. If behavior="ask" → trigger Gateway approval flow
 *    - Create approval request via plugin.approval.request
 *    - Wait for user decision via plugin.approval.waitDecision
 *    - If decision="allow-always" → cache approval for session
 *    - Return blocked based on decision
 *
 * Special cases:
 * - Headless/cron mode: deny dangerous commands by default (no approval route)
 * - Missing sessionKey: use default session key for approval caching
 */
export async function checkDangerousCommandAndRequestApproval(
  params: DangerousCommandCheckParams,
): Promise<DangerousCommandCheckResult> {
  const { command, sessionKey, agentId, trigger, warnings, signal } = params;
  const effectiveSessionKey = sessionKey ?? DEFAULT_SESSION_KEY;

  // 1. Check dangerous command permission
  const permissionResult = checkDangerousCommandPermission(command, effectiveSessionKey);

  // 2. Command is safe - allow execution
  if (permissionResult.behavior === "allow") {
    if (permissionResult.reason === "pre-approved" && permissionResult.patternKey) {
      log.info(`Dangerous command pre-approved for session: ${permissionResult.patternKey}`);
    }
    return { blocked: false };
  }

  // 3. Command is denied by policy - block execution
  if (permissionResult.behavior === "deny") {
    log.warn(`Dangerous command denied: ${permissionResult.reason}`);
    return {
      blocked: true,
      reason: permissionResult.reason ?? "Dangerous command blocked by policy",
    };
  }

  // 4. Handle headless/cron mode - deny dangerous commands without approval route
  if (trigger === "cron") {
    log.warn(`Dangerous command blocked in headless/cron mode: ${permissionResult.patternKey}`);
    return {
      blocked: true,
      reason:
        "Dangerous command not allowed in headless mode. " +
        "Run in interactive mode to approve this command.",
    };
  }

  // 5. Trigger Gateway approval flow
  const detection = detectDangerousCommand(command);
  if (!detection.isDangerous) {
    // Should not happen if behavior="ask", but safety check
    return { blocked: false };
  }

  const approvalMessage = buildApprovalRequestMessage(command, detection);

  try {
    // Request approval from Gateway
    const requestResult: {
      id?: string;
      status?: string;
      decision?: string | null;
    } = await callGatewayTool(
      "plugin.approval.request",
      { timeoutMs: 120_000 + 10_000 },
      {
        pluginId: "terminal-dangerous",
        title: `Dangerous Command: ${detection.description ?? "Unknown"}`,
        description: approvalMessage,
        severity: "critical",
        toolName: "exec",
        toolCallId: `dangerous-${Date.now()}`,
        agentId,
        sessionKey: effectiveSessionKey,
        timeoutMs: 120_000,
        twoPhase: true,
      },
      { expectFinal: false },
    );

    const approvalId = requestResult?.id;
    if (!approvalId) {
      log.warn("Dangerous command approval request failed: no approval ID returned");
      return {
        blocked: true,
        reason: approvalMessage || "Dangerous command approval request failed",
      };
    }

    // Check for immediate decision
    const hasImmediateDecision = Object.prototype.hasOwnProperty.call(
      requestResult ?? {},
      "decision",
    );
    let decision: string | null | undefined;

    if (hasImmediateDecision) {
      decision = requestResult?.decision;
      if (decision === null) {
        log.warn("Dangerous command approval unavailable: no approval route");
        return {
          blocked: true,
          reason: "Dangerous command approval unavailable (no approval route)",
        };
      }
    } else {
      // Wait for user decision
      const waitPromise: Promise<{
        id?: string;
        decision?: string | null;
      }> = callGatewayTool(
        "plugin.approval.waitDecision",
        { timeoutMs: 120_000 + 10_000 },
        { id: approvalId },
      );

      let waitResult: { id?: string; decision?: string | null } | undefined;

      if (signal) {
        // Handle abort signal for cancellation
        let onAbort: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        });

        try {
          waitResult = await Promise.race([waitPromise, abortPromise]);
        } finally {
          if (onAbort) {
            signal.removeEventListener("abort", onAbort);
          }
        }
      } else {
        waitResult = await waitPromise;
      }

      decision = waitResult?.decision;
    }

    // Process decision
    if (
      decision === PluginApprovalResolutions.ALLOW_ONCE ||
      decision === PluginApprovalResolutions.ALLOW_ALWAYS
    ) {
      // Cache approval for "allow-always" decisions
      if (decision === PluginApprovalResolutions.ALLOW_ALWAYS && detection.patternKey) {
        approvePatternForSession(effectiveSessionKey, detection.patternKey);
        log.info(`Pattern approved for session: ${detection.patternKey}`);
        if (warnings) {
          warnings.push(`Approved dangerous pattern: ${detection.patternKey}`);
        }
        return {
          blocked: false,
          approvedPatternKey: detection.patternKey,
        };
      }

      log.info(`Dangerous command approved (once): ${detection.patternKey}`);
      return { blocked: false };
    }

    if (decision === PluginApprovalResolutions.DENY) {
      log.warn(`Dangerous command denied by user: ${detection.patternKey}`);
      return { blocked: true, reason: "Denied by user" };
    }

    // Timeout or other - deny by default
    log.warn(`Dangerous command approval timed out or cancelled: ${decision}`);
    return { blocked: true, reason: "Dangerous command approval timed out" };
  } catch (err) {
    // Check for abort signal cancellation
    if (signal && isAbortSignalCancellation(err, signal)) {
      log.warn(`Dangerous command approval cancelled by run abort: ${String(err)}`);
      return {
        blocked: true,
        reason: "Approval cancelled (run aborted)",
      };
    }

    log.warn(`Dangerous command approval gateway error: ${String(err)}`);
    return {
      blocked: true,
      reason: "Dangerous command approval required (gateway unavailable)",
    };
  }
}

/**
 * Check if an error is due to abort signal cancellation.
 */
function isAbortSignalCancellation(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) {
    return true;
  }
  // Check for common abort error patterns
  if (err instanceof Error) {
    return err.name === "AbortError" || err.message.includes("aborted");
  }
  return false;
}
