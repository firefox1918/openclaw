/**
 * Tests for Fork Cache Optimization.
 */

import { describe, expect, it } from "vitest";
import {
  buildForkMessages,
  createForkConfig,
  buildBatchForkMessages,
  validateForkConfig,
  FORK_UNIFIED_PLACEHOLDER,
  FORK_BOILERPLATE_TEMPLATE,
  __testing,
  type SimpleToolUseBlock,
  type SimpleContentBlock,
  type SimpleMessage,
} from "./fork-cache-optimization.js";

describe("fork-cache-optimization", () => {
  describe("constants", () => {
    it("should have unified placeholder", () => {
      expect(FORK_UNIFIED_PLACEHOLDER).toBe("Fork started — processing in background");
    });

    it("should have boilerplate template", () => {
      expect(FORK_BOILERPLATE_TEMPLATE).toContain("STOP. READ THIS FIRST");
      expect(FORK_BOILERPLATE_TEMPLATE).toContain("forked worker process");
      expect(FORK_BOILERPLATE_TEMPLATE).toContain('Response MUST begin with "Scope:"');
    });

    it("should export testing helpers", () => {
      expect(__testing.FORK_UNIFIED_PLACEHOLDER).toBe(FORK_UNIFIED_PLACEHOLDER);
      expect(__testing.FORK_BOILERPLATE_TEMPLATE).toBe(FORK_BOILERPLATE_TEMPLATE);
      expect(__testing.estimateTokens).toBeDefined();
    });
  });

  describe("createForkConfig", () => {
    it("should create config with minimal params", () => {
      const config = createForkConfig({
        directive: "Test task",
      });
      expect(config.directive).toBe("Test task");
      expect(config.parentAssistantMessage).toBeUndefined();
      expect(config.parentToolUseBlocks).toBeUndefined();
    });

    it("should create config with all params", () => {
      const mockMessage: SimpleMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      };
      const mockBlocks: SimpleToolUseBlock[] = [
        { type: "tool_use", id: "tool-1", name: "Read", input: {} },
      ];

      const config = createForkConfig({
        directive: "Test task",
        parentAssistantMessage: mockMessage,
        parentToolUseBlocks: mockBlocks,
        workspaceDir: "/workspace",
        sessionKey: "session-123",
        additionalContext: { targetFiles: ["a.ts", "b.ts"] },
      });

      expect(config.directive).toBe("Test task");
      expect(config.parentAssistantMessage).toBe(mockMessage);
      expect(config.parentToolUseBlocks).toBe(mockBlocks);
      expect(config.workspaceDir).toBe("/workspace");
      expect(config.sessionKey).toBe("session-123");
      expect(config.additionalContext?.targetFiles).toEqual(["a.ts", "b.ts"]);
    });
  });

  describe("buildForkMessages", () => {
    it("should build minimal messages", () => {
      const config = createForkConfig({
        directive: "Search for TODO comments",
      });

      const result = buildForkMessages(config);

      expect(result.messages.length).toBe(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.cacheOptimized).toBe(true);
      expect(result.estimatedCacheReuse).toBeGreaterThan(0);

      // Check content has boilerplate + directive
      const userContent = result.messages[0].content as SimpleContentBlock[];
      const textBlock = userContent.find((b) => b.type === "text");
      expect(textBlock?.text).toContain(FORK_BOILERPLATE_TEMPLATE);
      expect(textBlock?.text).toContain("DIRECTIVE: Search for TODO comments");
    });

    it("should add unified placeholders for tool_use blocks", () => {
      const mockBlocks: SimpleToolUseBlock[] = [
        { type: "tool_use", id: "tool-1", name: "Read", input: { path: "/a" } },
        { type: "tool_use", id: "tool-2", name: "Glob", input: { pattern: "*.ts" } },
      ];

      const config = createForkConfig({
        directive: "Process files",
        parentToolUseBlocks: mockBlocks,
      });

      const result = buildForkMessages(config);

      // Check placeholders added
      const userContent = result.messages[0].content as SimpleContentBlock[];
      const toolResults = userContent.filter((b) => b.type === "tool_result");
      expect(toolResults.length).toBe(2);

      // All placeholders should be identical (for cache sharing)
      expect((toolResults[0] as { content: string }).content).toBe(FORK_UNIFIED_PLACEHOLDER);
      expect((toolResults[1] as { content: string }).content).toBe(FORK_UNIFIED_PLACEHOLDER);

      // Check tool_use_id mapping
      expect((toolResults[0] as { tool_use_id: string }).tool_use_id).toBe("tool-1");
      expect((toolResults[1] as { tool_use_id: string }).tool_use_id).toBe("tool-2");
    });

    it("should clone parent assistant message", () => {
      const mockMessage: SimpleMessage = {
        role: "assistant",
        content: [
          { type: "text", text: "I will help you" },
          { type: "tool_use", id: "tool-1", name: "Read", input: {} },
        ],
      };

      const config = createForkConfig({
        directive: "Continue",
        parentAssistantMessage: mockMessage,
      });

      const result = buildForkMessages(config);

      expect(result.messages.length).toBe(2);
      expect(result.messages[0].role).toBe("assistant");
      expect(result.messages[0].content).toEqual(mockMessage.content);
    });

    it("should add context to directive", () => {
      const config = createForkConfig({
        directive: "Fix bugs",
        additionalContext: {
          workspaceDir: "/project",
          sessionKey: "session-456",
          targetFiles: ["src/main.ts", "src/test.ts"],
        },
      });

      const result = buildForkMessages(config);
      const userContent = result.messages[0].content as SimpleContentBlock[];
      const textBlock = userContent.find((b) => b.type === "text") as { text: string };

      expect(textBlock.text).toContain("Working directory: /project");
      expect(textBlock.text).toContain("Session: session-456");
      expect(textBlock.text).toContain("Target files:");
    });

    it("should calculate cache reuse estimate", () => {
      const mockBlocks: SimpleToolUseBlock[] = [
        { type: "tool_use", id: "tool-1", name: "Read", input: {} },
        { type: "tool_use", id: "tool-2", name: "Grep", input: {} },
        { type: "tool_use", id: "tool-3", name: "Glob", input: {} },
      ];

      const config = createForkConfig({
        directive: "Analyze code",
        parentToolUseBlocks: mockBlocks,
      });

      const result = buildForkMessages(config);

      // Boilerplate tokens + placeholder tokens * count
      const boilerplateTokens = __testing.estimateTokens(FORK_BOILERPLATE_TEMPLATE);
      const placeholderTokens = __testing.estimateTokens(FORK_UNIFIED_PLACEHOLDER) * 3;

      expect(result.estimatedCacheReuse).toBe(boilerplateTokens + placeholderTokens);
    });
  });

  describe("buildBatchForkMessages", () => {
    it("should build messages for multiple directives", () => {
      const directives = ["Task A", "Task B", "Task C"];
      const results = buildBatchForkMessages(directives);

      expect(results.length).toBe(3);
      expect(results.every((r) => r.cacheOptimized)).toBe(true);
    });

    it("should share context across all forks", () => {
      const mockMessage: SimpleMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Context" }],
      };

      const directives = ["Task 1", "Task 2"];
      const results = buildBatchForkMessages(directives, {
        parentAssistantMessage: mockMessage,
        additionalContext: {
          workspaceDir: "/shared",
        },
      });

      // All forks should have cloned parent message
      expect(results[0].messages[0].role).toBe("assistant");
      expect(results[1].messages[0].role).toBe("assistant");

      // All directives should include workspace
      for (const result of results) {
        const userContent = result.messages[1].content as SimpleContentBlock[];
        const textBlock = userContent.find((b) => b.type === "text") as { text: string };
        expect(textBlock.text).toContain("Working directory: /shared");
      }
    });

    it("should calculate total cache reuse", () => {
      const mockBlocks: SimpleToolUseBlock[] = [
        { type: "tool_use", id: "tool-1", name: "Read", input: {} },
      ];

      const directives = ["A", "B", "C"];
      const results = buildBatchForkMessages(directives, {
        parentToolUseBlocks: mockBlocks,
      });

      const totalReuse = results.reduce((sum, r) => sum + (r.estimatedCacheReuse ?? 0), 0);
      expect(totalReuse).toBeGreaterThan(0);

      // All forks share same cache prefix
      const reuse1 = results[0].estimatedCacheReuse ?? 0;
      const reuse2 = results[1].estimatedCacheReuse ?? 0;
      expect(reuse1).toBe(reuse2);
    });
  });

  describe("validateForkConfig", () => {
    it("should validate valid config", () => {
      const config = createForkConfig({ directive: "Valid task" });
      const result = validateForkConfig(config);

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it("should reject empty directive", () => {
      const config = createForkConfig({ directive: "" });
      const result = validateForkConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Directive is required and must not be empty");
    });

    it("should reject whitespace-only directive", () => {
      const config = createForkConfig({ directive: "   " });
      const result = validateForkConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Directive is required and must not be empty");
    });

    it("should reject too-long directive", () => {
      const longDirective = "a".repeat(2500);
      const config = createForkConfig({ directive: longDirective });
      const result = validateForkConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Directive is too long (max 2000 characters)");
    });
  });

  describe("estimateTokens", () => {
    it("should estimate tokens based on length", () => {
      const shortText = "Hello";
      const longText = "This is a much longer text that should have more tokens";

      const shortTokens = __testing.estimateTokens(shortText);
      const longTokens = __testing.estimateTokens(longText);

      expect(shortTokens).toBeLessThan(longTokens);
      expect(shortTokens).toBe(Math.ceil(shortText.length / 4));
      expect(longTokens).toBe(Math.ceil(longText.length / 4));
    });
  });
});
