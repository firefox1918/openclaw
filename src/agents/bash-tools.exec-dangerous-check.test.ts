/**
 * Tests for dangerous command check and approval flow.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { checkDangerousCommandAndRequestApproval } from "./bash-tools.exec-dangerous-check.js";
import { approvePatternForSession, clearSessionApprovals } from "./terminal/dangerous.js";

// Mock the Gateway tool
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

import { callGatewayTool } from "./tools/gateway.js";

const mockCallGatewayTool = vi.mocked(callGatewayTool);

describe("checkDangerousCommandAndRequestApproval", () => {
  const testSessionKey = "test-session-key";

  beforeEach(() => {
    vi.clearAllMocks();
    clearSessionApprovals(testSessionKey);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("safe commands", () => {
    it("should allow safe commands like ls", async () => {
      const result = await checkDangerousCommandAndRequestApproval({
        command: "ls -la",
        sessionKey: testSessionKey,
      });

      expect(result.blocked).toBe(false);
      expect(result.reason).toBeUndefined();
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    });

    it("should allow echo commands", async () => {
      const result = await checkDangerousCommandAndRequestApproval({
        command: "echo 'hello world'",
        sessionKey: testSessionKey,
      });

      expect(result.blocked).toBe(false);
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    });

    it("should allow git status", async () => {
      const result = await checkDangerousCommandAndRequestApproval({
        command: "git status",
        sessionKey: testSessionKey,
      });

      expect(result.blocked).toBe(false);
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    });
  });

  describe("pre-approved dangerous commands", () => {
    it("should allow pre-approved dangerous commands", async () => {
      // Pre-approve the pattern
      approvePatternForSession(testSessionKey, "delete in root path");

      const result = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /tmp/test",
        sessionKey: testSessionKey,
      });

      expect(result.blocked).toBe(false);
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    });
  });

  describe("dangerous commands requiring approval", () => {
    it("should trigger approval for rm -rf /", async () => {
      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-123",
        status: "pending",
      });

      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-123",
        decision: "allow-once",
      });

      const result = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /tmp/test",
        sessionKey: testSessionKey,
      });

      expect(result.blocked).toBe(false);
      expect(mockCallGatewayTool).toHaveBeenCalledTimes(2);
      expect(mockCallGatewayTool).toHaveBeenCalledWith(
        "plugin.approval.request",
        expect.anything(),
        expect.objectContaining({
          pluginId: "terminal-dangerous",
          severity: "critical",
        }),
        expect.anything(),
      );
    });

    it("should block when user denies", async () => {
      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-456",
        status: "pending",
      });

      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-456",
        decision: "deny",
      });

      const result = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /",
        sessionKey: testSessionKey,
      });

      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("Denied by user");
    });

    it("should cache approval for allow-always decision", async () => {
      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-789",
        status: "pending",
      });

      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-789",
        decision: "allow-always",
      });

      const result = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /tmp/test",
        sessionKey: testSessionKey,
      });

      expect(result.blocked).toBe(false);
      expect(result.approvedPatternKey).toBeTruthy();

      // Second call should not trigger approval (cached)
      mockCallGatewayTool.mockClear();
      const result2 = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /tmp/another",
        sessionKey: testSessionKey,
      });

      expect(result2.blocked).toBe(false);
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    });

    it("should block on approval timeout", async () => {
      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-timeout",
        status: "pending",
      });

      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-timeout",
        decision: "timeout",
      });

      const result = await checkDangerousCommandAndRequestApproval({
        command: "chmod 777 /etc/passwd",
        sessionKey: testSessionKey,
      });

      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("Dangerous command approval timed out");
    });
  });

  describe("headless/cron mode", () => {
    it("should block dangerous commands in cron mode", async () => {
      const result = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /",
        sessionKey: testSessionKey,
        trigger: "cron",
      });

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("headless mode");
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    });

    it("should allow safe commands in cron mode", async () => {
      const result = await checkDangerousCommandAndRequestApproval({
        command: "echo 'test'",
        sessionKey: testSessionKey,
        trigger: "cron",
      });

      expect(result.blocked).toBe(false);
    });
  });

  describe("approval request failure", () => {
    it("should block when gateway is unavailable", async () => {
      mockCallGatewayTool.mockRejectedValueOnce(new Error("Gateway unavailable"));

      const result = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /",
        sessionKey: testSessionKey,
      });

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("gateway unavailable");
    });

    it("should block when no approval ID returned", async () => {
      mockCallGatewayTool.mockResolvedValueOnce({});

      const result = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /",
        sessionKey: testSessionKey,
      });

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("Dangerous command detected");
    });

    it("should block when no approval route available", async () => {
      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-no-route",
        decision: null,
      });

      const result = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /",
        sessionKey: testSessionKey,
      });

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("no approval route");
    });
  });

  describe("abort signal handling", () => {
    it("should block when aborted during wait phase", async () => {
      const controller = new AbortController();

      // First call for request returns pending
      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-abort",
        status: "pending",
      });

      // Second call for wait - simulate abort by rejecting
      mockCallGatewayTool.mockImplementationOnce(async () => {
        controller.abort();
        throw new DOMException("The operation was aborted", "AbortError");
      });

      const result = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /",
        sessionKey: testSessionKey,
        signal: controller.signal,
      });

      expect(result.blocked).toBe(true);
      expect(result.reason).toContain("aborted");
    });
  });

  describe("session key handling", () => {
    it("should work without session key", async () => {
      // Should use default session key
      const result = await checkDangerousCommandAndRequestApproval({
        command: "ls -la",
      });

      expect(result.blocked).toBe(false);
    });

    it("should cache approval for default session key", async () => {
      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-default",
        status: "pending",
      });

      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-default",
        decision: "allow-always",
      });

      // No session key provided - uses default
      const result = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /tmp/test",
      });

      expect(result.blocked).toBe(false);

      // Second call with same command type should be cached
      mockCallGatewayTool.mockClear();
      const result2 = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /tmp/another",
      });

      expect(result2.blocked).toBe(false);
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    });
  });

  describe("warnings array", () => {
    it("should append approved pattern to warnings", async () => {
      const warnings: string[] = [];

      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-warnings",
        status: "pending",
      });

      mockCallGatewayTool.mockResolvedValueOnce({
        id: "approval-warnings",
        decision: "allow-always",
      });

      const result = await checkDangerousCommandAndRequestApproval({
        command: "rm -rf /tmp/test",
        sessionKey: testSessionKey,
        warnings,
      });

      expect(result.blocked).toBe(false);
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain("Approved dangerous pattern");
    });
  });
});
