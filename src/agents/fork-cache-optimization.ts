/**
 * Fork Cache Optimization - Claude Code's cache optimization for subagents.
 *
 * Key innovation: All forked subagents use identical placeholders,
 * maximizing Prompt Cache sharing and reducing token costs.
 *
 * ## Concept (Claude Code 12-Layer Harness S04)
 *
 * Without optimization: Each fork has unique placeholder → No cache sharing
 * With optimization: All forks use same placeholder → Max cache sharing
 *
 * ## Integration Points
 *
 * 1. subagent-spawn.ts - Fork subagent creation
 * 2. sessions-spawn-tool.ts - Spawn tool integration
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("fork-cache");

// ============================================================================
// Types (Simplified for compatibility)
// ============================================================================

/**
 * Simplified message content block types.
 */
export interface SimpleToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface SimpleToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export interface SimpleTextBlock {
  type: "text";
  text: string;
}

export type SimpleContentBlock = SimpleTextBlock | SimpleToolUseBlock | SimpleToolResultBlock;

/**
 * Simplified Message type.
 */
export interface SimpleMessage {
  role: "user" | "assistant";
  content: SimpleContentBlock[] | string;
}

/**
 * Fork configuration for spawning a subagent.
 */
export interface ForkConfig {
  /** The directive/task for the subagent */
  directive: string;
  /** The parent assistant message to clone */
  parentAssistantMessage?: SimpleMessage;
  /** Tool use blocks from parent to create placeholders for */
  parentToolUseBlocks?: SimpleToolUseBlock[];
  /** Session key for the fork */
  sessionKey?: string;
  /** Workspace directory */
  workspaceDir?: string;
  /** Additional context to pass */
  additionalContext?: Record<string, unknown>;
}

/**
 * Fork messages result.
 */
export interface ForkMessagesResult {
  /** Messages to send to the forked subagent */
  messages: SimpleMessage[];
  /** Whether cache optimization was applied */
  cacheOptimized: boolean;
  /** Estimated cache reuse (number of shared tokens) */
  estimatedCacheReuse?: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Unified placeholder result for all forked subagents.
 *
 * This identical placeholder allows prompt cache sharing across all forks.
 * When the provider sees this exact string repeated, it can reuse cached prefix.
 */
export const FORK_UNIFIED_PLACEHOLDER = "Fork started — processing in background";

/**
 * Fork boilerplate template - shared cache prefix for all subagents.
 *
 * This template is identical for all forks, enabling cache reuse.
 * Only the DIRECTIVE section is unique per fork.
 */
export const FORK_BOILERPLATE_TEMPLATE = `STOP. READ THIS FIRST.
You are a forked worker process. You are NOT the main agent.

RULES:
1. Do NOT spawn sub-agents; execute directly
2. Do NOT converse or ask questions
3. USE your tools directly: Bash, Read, Write, Edit, Glob, Grep, etc.
4. If you modify files, commit before reporting
5. Stay strictly within your directive's scope
6. Keep report under 500 words
7. Response MUST begin with "Scope:" followed by directive summary`;

// ============================================================================
// Fork Message Builder
// ============================================================================

/**
 * Build messages for a forked subagent with cache optimization.
 *
 * Creates messages that maximize prompt cache sharing by using:
 * 1. Unified placeholder for all parent tool_use blocks
 * 2. Shared boilerplate template before unique directive
 */
export function buildForkMessages(config: ForkConfig): ForkMessagesResult {
  const { directive, parentAssistantMessage, parentToolUseBlocks, additionalContext } = config;

  // Build the user message content
  const userContent: SimpleContentBlock[] = [];

  // Add unified placeholders for parent tool_use blocks
  if (parentToolUseBlocks && parentToolUseBlocks.length > 0) {
    for (const block of parentToolUseBlocks) {
      userContent.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: FORK_UNIFIED_PLACEHOLDER, // Unified placeholder for cache sharing!
      });
    }
  }

  // Build directive text
  const directiveText = buildDirectiveText(directive, additionalContext);

  // Add boilerplate + directive
  userContent.push({
    type: "text",
    text: `${FORK_BOILERPLATE_TEMPLATE}\n\nDIRECTIVE: ${directiveText}`,
  });

  // Build messages array
  const messages: SimpleMessage[] = [];

  // Clone parent assistant message if available (for context)
  if (parentAssistantMessage) {
    messages.push(cloneMessage(parentAssistantMessage));
  }

  // Create user message with placeholders and directive
  messages.push({
    role: "user",
    content: userContent,
  });

  // Calculate estimated cache reuse
  const boilerplateTokens = estimateTokens(FORK_BOILERPLATE_TEMPLATE);
  const placeholderTokens = parentToolUseBlocks?.length
    ? estimateTokens(FORK_UNIFIED_PLACEHOLDER) * parentToolUseBlocks.length
    : 0;

  return {
    messages,
    cacheOptimized: true,
    estimatedCacheReuse: boilerplateTokens + placeholderTokens,
  };
}

/**
 * Build the directive text with additional context.
 */
function buildDirectiveText(
  directive: string,
  additionalContext?: Record<string, unknown>,
): string {
  let text = directive;

  if (additionalContext) {
    const contextParts: string[] = [];

    const workspaceDir = additionalContext.workspaceDir;
    if (workspaceDir && typeof workspaceDir === "string") {
      contextParts.push(`Working directory: ${workspaceDir}`);
    }
    const sessionKey = additionalContext.sessionKey;
    if (sessionKey && typeof sessionKey === "string") {
      contextParts.push(`Session: ${sessionKey}`);
    }
    const targetFiles = additionalContext.targetFiles;
    if (targetFiles) {
      contextParts.push(`Target files: ${JSON.stringify(targetFiles)}`);
    }

    if (contextParts.length > 0) {
      text = `${text}\n\nContext:\n${contextParts.join("\n")}`;
    }
  }

  return text;
}

/**
 * Clone a message (for fork context preservation).
 */
function cloneMessage(message: SimpleMessage): SimpleMessage {
  return {
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((block) => ({ ...block }))
      : message.content,
  };
}

/**
 * Estimate token count for a string (rough approximation).
 */
function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

// ============================================================================
// Fork Subagent Factory
// ============================================================================

/**
 * Create a fork subagent configuration.
 *
 * This factory ensures all forks use the same optimization patterns.
 */
export function createForkConfig(params: {
  directive: string;
  parentAssistantMessage?: SimpleMessage;
  parentToolUseBlocks?: SimpleToolUseBlock[];
  workspaceDir?: string;
  sessionKey?: string;
  additionalContext?: Record<string, unknown>;
}): ForkConfig {
  // Merge workspaceDir and sessionKey into additionalContext
  const mergedContext: Record<string, unknown> = {
    ...params.additionalContext,
  };
  if (params.workspaceDir) {
    mergedContext.workspaceDir = params.workspaceDir;
  }
  if (params.sessionKey) {
    mergedContext.sessionKey = params.sessionKey;
  }

  return {
    directive: params.directive,
    parentAssistantMessage: params.parentAssistantMessage,
    parentToolUseBlocks: params.parentToolUseBlocks,
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
    additionalContext: mergedContext,
  };
}

// ============================================================================
// Batch Fork Optimization
// ============================================================================

/**
 * Build messages for multiple forked subagents with maximum cache sharing.
 *
 * When spawning multiple subagents, this ensures all share the same cache prefix.
 */
export function buildBatchForkMessages(
  directives: string[],
  sharedContext?: {
    parentAssistantMessage?: SimpleMessage;
    parentToolUseBlocks?: SimpleToolUseBlock[];
    workspaceDir?: string;
    sessionKey?: string;
    additionalContext?: Record<string, unknown>;
  },
): ForkMessagesResult[] {
  const results: ForkMessagesResult[] = [];

  for (const directive of directives) {
    const config = createForkConfig({
      directive,
      parentAssistantMessage: sharedContext?.parentAssistantMessage,
      parentToolUseBlocks: sharedContext?.parentToolUseBlocks,
      workspaceDir: sharedContext?.workspaceDir,
      sessionKey: sharedContext?.sessionKey,
      additionalContext: sharedContext?.additionalContext,
    });

    results.push(buildForkMessages(config));
  }

  // Log total cache savings
  const totalCacheReuse = results.reduce((sum, r) => sum + (r.estimatedCacheReuse ?? 0), 0);
  log.info(
    `Batch fork: ${directives.length} subagents, estimated cache reuse: ${totalCacheReuse} tokens`,
  );

  return results;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate a fork config.
 */
export function validateForkConfig(config: ForkConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.directive || config.directive.trim().length === 0) {
    errors.push("Directive is required and must not be empty");
  }

  if (config.directive && config.directive.length > 2000) {
    errors.push("Directive is too long (max 2000 characters)");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// Export Constants for Testing
// ============================================================================

export const __testing = {
  FORK_UNIFIED_PLACEHOLDER,
  FORK_BOILERPLATE_TEMPLATE,
  estimateTokens,
};
