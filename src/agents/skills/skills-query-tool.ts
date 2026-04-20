/**
 * Skills query tool - list and view skills.
 *
 * Provides Agent with ability to query available skills:
 * - list: List all available skills with brief info
 * - view: View full content of a specific skill
 *
 * ## Integration Points
 *
 * 1. openclaw-tools.ts - registered as core tool
 * 2. workspace.ts - uses loadWorkspaceSkillEntries for skill discovery
 *
 * ## Storage Locations (in priority order)
 *
 * 1. workspace/skills/ - highest priority (project-specific)
 * 2. .agents/skills/ - Agent-managed skills (personal/project)
 * 3. ~/.openclaw/skills/ - managed skills
 * 4. bundled skills - OpenClaw built-in skills
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { stringEnum } from "../schema/typebox.js";
import { jsonResult } from "../tools/common.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { SkillEntry } from "./types.js";
import { loadWorkspaceSkillEntries } from "./workspace.js";

const log = createSubsystemLogger("skills/query");

// ============================================================================
// Schema
// ============================================================================

const SKILLS_QUERY_ACTIONS = ["list", "view"] as const;

const SkillsQueryParametersSchema = Type.Object({
  action: stringEnum([...SKILLS_QUERY_ACTIONS]),
  name: Type.Optional(Type.String({ maxLength: 64 })),
  verbose: Type.Optional(Type.Boolean()),
});

// ============================================================================
// Action Handlers
// ============================================================================

/**
 * List all available skills.
 */
async function handleListAction(
  entries: SkillEntry[],
  verbose?: boolean,
): Promise<AgentToolResult<unknown>> {
  if (entries.length === 0) {
    return jsonResult({
      success: true,
      count: 0,
      skills: [],
      message: "No skills available in this workspace.",
    });
  }

  const skills = entries.map((entry) => {
    const skill = entry.skill;
    const base: {
      name: string;
      description: string;
      location: string;
      source: string;
    } = {
      name: skill.name,
      description: skill.description || "(no description)",
      location: skill.filePath,
      source: skill.source || "unknown",
    };

    if (verbose) {
      return {
        ...base,
        metadata: entry.metadata,
        invocation: entry.invocation,
        exposure: entry.exposure,
      };
    }

    return base;
  });

  return jsonResult({
    success: true,
    count: skills.length,
    skills,
    message: `Found ${skills.length} available skills.`,
  });
}

/**
 * View a specific skill's content.
 */
async function handleViewAction(
  entries: SkillEntry[],
  name: string,
): Promise<AgentToolResult<unknown>> {
  const entry = entries.find((e) => e.skill.name === name);

  if (!entry) {
    return jsonResult({
      success: false,
      error: `Skill "${name}" not found.`,
      availableSkills: entries.map((e) => e.skill.name).slice(0, 10),
    });
  }

  // Read the SKILL.md file content
  try {
    const content = await fs.readFile(entry.skill.filePath, "utf-8");

    return jsonResult({
      success: true,
      name: entry.skill.name,
      location: entry.skill.filePath,
      source: entry.skill.source || "unknown",
      content,
      metadata: entry.metadata,
      invocation: entry.invocation,
    });
  } catch (error) {
    log.error(`Failed to read skill file: ${String(error)}`);
    return jsonResult({
      success: false,
      error: `Failed to read skill file: ${String(error)}`,
      name: entry.skill.name,
      location: entry.skill.filePath,
    });
  }
}

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Create the skills query tool.
 */
export function createSkillsQueryTool(options?: {
  workspaceDir?: string;
  config?: unknown;
}): AnyAgentTool {
  const workspaceDir = options?.workspaceDir;

  return {
    name: "skills",
    label: "skills",
    description: `Query available skills. Use 'list' to see all available skills, or 'view' with a skill name to read its full content. Skills are reusable workflows that provide specialized instructions for specific tasks.`,
    parameters: SkillsQueryParametersSchema,
    execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> => {
      const params = args as Record<string, unknown>;
      const action = params.action as string;
      const name = params.name as string | undefined;
      const verbose = params.verbose as boolean | undefined;

      if (!workspaceDir) {
        return jsonResult({
          success: false,
          error: "No workspace directory configured. Cannot load skills.",
        });
      }

      // Load skill entries from workspace
      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        config: options?.config as Record<string, unknown> | undefined,
      });

      switch (action) {
        case "list":
          return handleListAction(entries, verbose);
        case "view":
          if (!name) {
            return jsonResult({
              success: false,
              error: "Skill name required for view action.",
            });
          }
          return handleViewAction(entries, name);
        default:
          return jsonResult({
            success: false,
            error: `Unknown action: ${action}. Supported actions: list, view`,
          });
      }
    },
  };
}

// ============================================================================
// Exports
// ============================================================================

export { SKILLS_QUERY_ACTIONS };
