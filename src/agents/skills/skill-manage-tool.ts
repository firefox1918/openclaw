/**
 * Skill Manager Tool -- Agent-Managed Skill Creation & Editing
 *
 * Allows the agent to create, update, and delete skills, turning successful
 * approaches into reusable procedural knowledge.
 *
 * ## Phase 8: 自主技能形成能力
 *
 * This tool implements Hermes Agent's skill_manage functionality:
 * - create: Create new skill from successful workflow
 * - edit: Full SKILL.md rewrite (major overhauls)
 * - patch: Targeted find-and-replace (token-efficient fixes)
 * - delete: Remove obsolete skills
 * - write_file: Add supporting files (references, templates, scripts)
 * - remove_file: Clean up supporting files
 *
 * ## Skill Storage Locations
 *
 * User skills are stored in (precedence from low to high):
 * - ~/.openclaw/skills/ (managed skills)
 * - ~/.agents/skills/ (personal agent skills)
 * - <workspace>/.agents/skills/ (project agent skills)
 * - <workspace>/skills/ (workspace skills)
 *
 * ## Trigger Conditions for Skill Creation
 *
 * Agent should create a skill when:
 * - Complex task succeeded (5+ tool calls)
 * - Errors overcome with successful path found
 * - User-corrected approach worked
 * - Non-trivial reusable workflow discovered
 * - User explicitly asks to remember a procedure
 *
 * @module skills/skill-manage-tool
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";
import { CONFIG_DIR } from "../../utils.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "../tools/common.js";

const log = createSubsystemLogger("skill-manage");

// =============================================================================
// Constants
// =============================================================================

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_CONTENT_CHARS = 100_000; // ~36k tokens at 2.75 chars/token
const MAX_SKILL_FILE_BYTES = 1_048_576; // 1 MiB per supporting file

// Characters allowed in skill names (filesystem-safe, URL-friendly)
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

// Subdirectories allowed for write_file/remove_file
const ALLOWED_SUBDIRS = ["references", "templates", "scripts", "assets"];

// =============================================================================
// Validation Helpers (exported for testing)
// =============================================================================

export function validateName(name: string): string | null {
  if (!name) {
    return "Skill name is required.";
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`;
  }
  if (!VALID_NAME_RE.test(name)) {
    return `Invalid skill name '${name}'. Use lowercase letters, numbers, hyphens, dots, and underscores. Must start with a letter or digit.`;
  }
  return null;
}

export function validateCategory(category: string | undefined): string | null {
  if (!category) {
    return null;
  }
  const trimmed = category.trim();
  if (!trimmed) {
    return null;
  }
  if (category.includes("/") || category.includes("\\")) {
    return `Invalid category '${category}'. Categories must be a single directory name.`;
  }
  if (category.length > MAX_NAME_LENGTH) {
    return `Category exceeds ${MAX_NAME_LENGTH} characters.`;
  }
  if (!VALID_NAME_RE.test(trimmed)) {
    return `Invalid category '${category}'. Use lowercase letters, numbers, hyphens, dots, and underscores.`;
  }
  return null;
}

export function validateFrontmatter(content: string): string | null {
  if (!content.trim()) {
    return "Content cannot be empty.";
  }

  if (!content.startsWith("---")) {
    return "SKILL.md must start with YAML frontmatter (---). See existing skills for format.";
  }

  const endMatch = content.slice(3).match(/\n---\s*\n/);
  if (!endMatch || endMatch.index === undefined) {
    return "SKILL.md frontmatter is not closed. Ensure you have a closing '---' line.";
  }

  const yamlContent = content.slice(3, 3 + endMatch.index);

  try {
    const parsed = parseFrontmatterBlock(content);
    if (!parsed || typeof parsed !== "object") {
      return "Frontmatter must be a YAML mapping (key: value pairs).";
    }
  } catch (e) {
    return `YAML frontmatter parse error: ${e instanceof Error ? e.message : String(e)}`;
  }

  const frontmatter = parseFrontmatterBlock(content);
  if (!frontmatter?.name) {
    return "Frontmatter must include 'name' field.";
  }
  if (!frontmatter.description) {
    return "Frontmatter must include 'description' field.";
  }
  if (String(frontmatter.description).length > MAX_DESCRIPTION_LENGTH) {
    return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`;
  }

  const bodyStart = 3 + endMatch.index + endMatch[0].length;
  const body = content.slice(bodyStart).trim();
  if (!body) {
    return "SKILL.md must have content after the frontmatter (instructions, procedures, etc.).";
  }

  return null;
}

export function validateContentSize(content: string, label: string = "SKILL.md"): string | null {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return `${label} content is ${content.length} characters (limit: ${MAX_SKILL_CONTENT_CHARS}). Consider splitting into a smaller SKILL.md with supporting files in references/ or templates/.`;
  }
  return null;
}

export function validateFilePath(filePath: string): string | null {
  if (!filePath) {
    return "file_path is required.";
  }

  // Prevent path traversal
  if (filePath.includes("..")) {
    return "Path traversal ('..') is not allowed.";
  }

  const normalized = path.normalize(filePath);

  // Must be under an allowed subdirectory
  const firstPart = normalized.split(path.sep)[0];
  if (!ALLOWED_SUBDIRS.includes(firstPart)) {
    const allowed = ALLOWED_SUBDIRS.join(", ");
    return `File must be under one of: ${allowed}. Got: '${filePath}'`;
  }

  // Must have a filename (not just a directory)
  const parts = normalized.split(path.sep);
  if (parts.length < 2) {
    return `Provide a file path, not just a directory. Example: '${parts[0]}/myfile.md'`;
  }

  return null;
}

// =============================================================================
// Skill Directory Resolution
// =============================================================================

/**
 * Get the default directory for new user-created skills.
 * Uses ~/.agents/skills/ for personal skills (highest precedence for user skills).
 */
function getDefaultUserSkillsDir(): string {
  const homeDir = os.homedir();
  return path.resolve(homeDir, ".agents", "skills");
}

/**
 * Get all skill directories where skills might exist.
 */
function getAllSkillDirs(workspaceDir: string): string[] {
  const homeDir = os.homedir();
  return [
    path.resolve(CONFIG_DIR, "skills"), // managed
    homeDir ? path.resolve(homeDir, ".agents", "skills") : path.resolve(".agents", "skills"), // personal
    path.resolve(workspaceDir, ".agents", "skills"), // project
    path.resolve(workspaceDir, "skills"), // workspace
  ];
}

/**
 * Find a skill by name across all skill directories.
 */
async function findSkill(name: string, workspaceDir: string): Promise<{ path: string } | null> {
  const skillDirs = getAllSkillDirs(workspaceDir);

  for (const skillDir of skillDirs) {
    try {
      const entries = await fs.readdir(skillDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name === name) {
          const skillMdPath = path.join(skillDir, entry.name, "SKILL.md");
          try {
            await fs.access(skillMdPath);
            return { path: path.join(skillDir, entry.name) };
          } catch {
            // Not a valid skill directory
          }
        }
      }

      // Also check category subdirectories
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const categoryDir = path.join(skillDir, entry.name);
          try {
            const categoryEntries = await fs.readdir(categoryDir, { withFileTypes: true });
            for (const catEntry of categoryEntries) {
              if (catEntry.isDirectory() && catEntry.name === name) {
                const skillMdPath = path.join(categoryDir, catEntry.name, "SKILL.md");
                try {
                  await fs.access(skillMdPath);
                  return { path: path.join(categoryDir, catEntry.name) };
                } catch {
                  // Not a valid skill directory
                }
              }
            }
          } catch {
            // Ignore errors reading category directories
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
  }

  return null;
}

/**
 * Resolve the target directory for a new skill.
 */
function resolveSkillDir(name: string, category: string | undefined, workspaceDir: string): string {
  const baseDir = getDefaultUserSkillsDir();
  if (category) {
    return path.join(baseDir, category, name);
  }
  return path.join(baseDir, name);
}

/**
 * Resolve a supporting file path within a skill directory.
 */
function resolveSkillTarget(
  skillDir: string,
  filePath: string,
): { target: string; error: string | null } {
  const target = path.join(skillDir, filePath);

  // Ensure the target stays within the skill directory
  const resolvedTarget = path.resolve(target);
  const resolvedSkillDir = path.resolve(skillDir);

  if (
    !resolvedTarget.startsWith(resolvedSkillDir + path.sep) &&
    resolvedTarget !== resolvedSkillDir
  ) {
    return { target: "", error: "File path escapes skill directory." };
  }

  return { target: resolvedTarget, error: null };
}

// =============================================================================
// Atomic Write Helper
// =============================================================================

/**
 * Atomically write text content to a file.
 * Uses a temporary file and rename to ensure atomicity.
 */
async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = path.join(
    path.dirname(filePath),
    `.tmp.${path.basename(filePath)}.${Date.now()}`,
  );

  try {
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Clean up temp file on error
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

// =============================================================================
// Core Actions
// =============================================================================

interface SkillManageResult {
  success: boolean;
  message?: string;
  error?: string;
  path?: string;
  hint?: string;
}

async function createSkill(
  name: string,
  content: string,
  category: string | undefined,
  workspaceDir: string,
): Promise<SkillManageResult> {
  // Validate name
  const nameErr = validateName(name);
  if (nameErr) {
    return { success: false, error: nameErr };
  }

  // Validate category
  const catErr = validateCategory(category);
  if (catErr) {
    return { success: false, error: catErr };
  }

  // Validate content
  const contentErr = validateFrontmatter(content);
  if (contentErr) {
    return { success: false, error: contentErr };
  }

  const sizeErr = validateContentSize(content);
  if (sizeErr) {
    return { success: false, error: sizeErr };
  }

  // Check for existing skill
  const existing = await findSkill(name, workspaceDir);
  if (existing) {
    return {
      success: false,
      error: `A skill named '${name}' already exists at ${existing.path}.`,
    };
  }

  // Create skill directory
  const skillDir = resolveSkillDir(name, category, workspaceDir);
  await fs.mkdir(skillDir, { recursive: true });

  // Write SKILL.md atomically
  const skillMdPath = path.join(skillDir, "SKILL.md");
  await atomicWriteText(skillMdPath, content);

  log.info(`Skill '${name}' created at ${skillDir}`);

  return {
    success: true,
    message: `Skill '${name}' created.`,
    path: skillDir,
    hint: `To add supporting files, use skill_manage(action='write_file', name='${name}', file_path='references/example.md', file_content='...')`,
  };
}

async function editSkill(
  name: string,
  content: string,
  workspaceDir: string,
): Promise<SkillManageResult> {
  // Validate content
  const contentErr = validateFrontmatter(content);
  if (contentErr) {
    return { success: false, error: contentErr };
  }

  const sizeErr = validateContentSize(content);
  if (sizeErr) {
    return { success: false, error: sizeErr };
  }

  // Find existing skill
  const existing = await findSkill(name, workspaceDir);
  if (!existing) {
    return {
      success: false,
      error: `Skill '${name}' not found. Use skill_manage(action='create') to create a new skill.`,
    };
  }

  // Backup original content for rollback
  const skillMdPath = path.join(existing.path, "SKILL.md");
  let originalContent: string | null = null;
  try {
    originalContent = await fs.readFile(skillMdPath, "utf-8");
  } catch {
    // No original content
  }

  // Write new content
  await atomicWriteText(skillMdPath, content);

  log.info(`Skill '${name}' updated at ${existing.path}`);

  return {
    success: true,
    message: `Skill '${name}' updated.`,
    path: existing.path,
  };
}

async function patchSkill(
  name: string,
  oldString: string,
  newString: string,
  filePath: string | undefined,
  replaceAll: boolean,
  workspaceDir: string,
): Promise<SkillManageResult> {
  if (!oldString) {
    return { success: false, error: "old_string is required for 'patch'." };
  }
  if (newString === undefined) {
    return {
      success: false,
      error: "new_string is required for 'patch'. Use empty string to delete matched text.",
    };
  }

  // Find existing skill
  const existing = await findSkill(name, workspaceDir);
  if (!existing) {
    return { success: false, error: `Skill '${name}' not found.` };
  }

  // Determine target file
  let target: string;
  let targetLabel: string;

  if (filePath) {
    const pathErr = validateFilePath(filePath);
    if (pathErr) {
      return { success: false, error: pathErr };
    }
    const { target: resolved, error: resolveErr } = resolveSkillTarget(existing.path, filePath);
    if (resolveErr) {
      return { success: false, error: resolveErr };
    }
    target = resolved;
    targetLabel = filePath;
  } else {
    target = path.join(existing.path, "SKILL.md");
    targetLabel = "SKILL.md";
  }

  // Read current content
  let content: string;
  try {
    content = await fs.readFile(target, "utf-8");
  } catch {
    return { success: false, error: `File not found: ${targetLabel}` };
  }

  // Perform replacement
  let newContent: string;
  let matchCount: number;

  if (replaceAll) {
    // Count matches
    const matches = content.split(oldString);
    matchCount = matches.length - 1;

    if (matchCount === 0) {
      const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "");
      return {
        success: false,
        error: `old_string not found in ${targetLabel}.`,
        hint: preview,
      };
    }

    newContent = content.replaceAll(oldString, newString);
  } else {
    // Single replacement - require unique match
    const firstIndex = content.indexOf(oldString);
    if (firstIndex === -1) {
      const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "");
      return {
        success: false,
        error: `old_string not found in ${targetLabel}.`,
        hint: preview,
      };
    }

    const secondIndex = content.indexOf(oldString, firstIndex + oldString.length);
    if (secondIndex !== -1) {
      return {
        success: false,
        error: `Multiple matches found in ${targetLabel}. Use replace_all=true or provide a more unique old_string with surrounding context.`,
      };
    }

    matchCount = 1;
    newContent = content.replace(oldString, newString);
  }

  // Validate size
  const sizeErr = validateContentSize(newContent, targetLabel);
  if (sizeErr) {
    return { success: false, error: sizeErr };
  }

  // If patching SKILL.md, validate frontmatter
  if (!filePath) {
    const fmErr = validateFrontmatter(newContent);
    if (fmErr) {
      return { success: false, error: `Patch would break SKILL.md structure: ${fmErr}` };
    }
  }

  // Write updated content
  await atomicWriteText(target, newContent);

  log.info(`Patched ${targetLabel} in skill '${name}' (${matchCount} replacement)`);

  return {
    success: true,
    message: `Patched ${targetLabel} in skill '${name}' (${matchCount} replacement${matchCount > 1 ? "s" : ""}).`,
    path: existing.path,
  };
}

async function deleteSkill(name: string, workspaceDir: string): Promise<SkillManageResult> {
  const existing = await findSkill(name, workspaceDir);
  if (!existing) {
    return { success: false, error: `Skill '${name}' not found.` };
  }

  // Remove skill directory
  await fs.rm(existing.path, { recursive: true, force: true });

  // Clean up empty parent directories (category folders)
  const parent = path.dirname(existing.path);
  const skillsRoot = getDefaultUserSkillsDir();

  if (parent !== skillsRoot) {
    try {
      const entries = await fs.readdir(parent);
      if (entries.length === 0) {
        await fs.rm(parent, { recursive: false });
        log.info(`Cleaned up empty category directory: ${parent}`);
      }
    } catch {
      // Ignore errors
    }
  }

  log.info(`Skill '${name}' deleted from ${existing.path}`);

  return {
    success: true,
    message: `Skill '${name}' deleted.`,
  };
}

async function writeSkillFile(
  name: string,
  filePath: string,
  fileContent: string,
  workspaceDir: string,
): Promise<SkillManageResult> {
  const pathErr = validateFilePath(filePath);
  if (pathErr) {
    return { success: false, error: pathErr };
  }

  if (fileContent === undefined) {
    return { success: false, error: "file_content is required." };
  }

  // Check size limits
  const contentBytes = Buffer.byteLength(fileContent, "utf-8");
  if (contentBytes > MAX_SKILL_FILE_BYTES) {
    return {
      success: false,
      error: `File content is ${contentBytes} bytes (limit: ${MAX_SKILL_FILE_BYTES} bytes / 1 MiB). Consider splitting into smaller files.`,
    };
  }

  const sizeErr = validateContentSize(fileContent, filePath);
  if (sizeErr) {
    return { success: false, error: sizeErr };
  }

  // Find existing skill
  const existing = await findSkill(name, workspaceDir);
  if (!existing) {
    return {
      success: false,
      error: `Skill '${name}' not found. Create it first with action='create'.`,
    };
  }

  // Resolve target path
  const { target, error: resolveErr } = resolveSkillTarget(existing.path, filePath);
  if (resolveErr) {
    return { success: false, error: resolveErr };
  }

  // Create parent directory
  await fs.mkdir(path.dirname(target), { recursive: true });

  // Write file
  await atomicWriteText(target, fileContent);

  log.info(`File '${filePath}' written to skill '${name}'`);

  return {
    success: true,
    message: `File '${filePath}' written to skill '${name}'.`,
    path: target,
  };
}

async function removeSkillFile(
  name: string,
  filePath: string,
  workspaceDir: string,
): Promise<SkillManageResult> {
  const pathErr = validateFilePath(filePath);
  if (pathErr) {
    return { success: false, error: pathErr };
  }

  // Find existing skill
  const existing = await findSkill(name, workspaceDir);
  if (!existing) {
    return { success: false, error: `Skill '${name}' not found.` };
  }

  // Resolve target path
  const { target, error: resolveErr } = resolveSkillTarget(existing.path, filePath);
  if (resolveErr) {
    return { success: false, error: resolveErr };
  }

  // Check if file exists
  try {
    await fs.access(target);
  } catch {
    // List available files for reference
    const availableFiles: string[] = [];
    for (const subdir of ALLOWED_SUBDIRS) {
      const subdirPath = path.join(existing.path, subdir);
      try {
        const entries = await fs.readdir(subdirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile()) {
            availableFiles.push(path.join(subdir, entry.name));
          }
        }
      } catch {
        // Ignore
      }
    }

    return {
      success: false,
      error: `File '${filePath}' not found in skill '${name}'.`,
      hint: availableFiles.length > 0 ? `Available files: ${availableFiles.join(", ")}` : undefined,
    };
  }

  // Remove file
  await fs.unlink(target);

  // Clean up empty subdirectories
  const parent = path.dirname(target);
  try {
    const entries = await fs.readdir(parent);
    if (entries.length === 0 && parent !== existing.path) {
      await fs.rm(parent, { recursive: false });
    }
  } catch {
    // Ignore
  }

  log.info(`File '${filePath}' removed from skill '${name}'`);

  return {
    success: true,
    message: `File '${filePath}' removed from skill '${name}'.`,
  };
}

// =============================================================================
// Tool Entry Point
// =============================================================================

const SKILL_MANAGE_ACTIONS = [
  "create",
  "patch",
  "edit",
  "delete",
  "write_file",
  "remove_file",
] as const;

const SkillManageActionSchema = stringEnum(SKILL_MANAGE_ACTIONS);

const SkillManageParametersSchema = Type.Object({
  action: SkillManageActionSchema,
  name: Type.String({
    minLength: 1,
    maxLength: MAX_NAME_LENGTH,
    description: "Skill name (lowercase, hyphens/underscores, max 64 chars).",
  }),
  content: Type.Optional(
    Type.String({
      maxLength: MAX_SKILL_CONTENT_CHARS,
      description:
        "Full SKILL.md content (YAML frontmatter + markdown body). Required for 'create' and 'edit'.",
    }),
  ),
  category: Type.Optional(
    Type.String({
      maxLength: MAX_NAME_LENGTH,
      description:
        "Optional category/domain for organizing the skill (e.g., 'devops', 'data-science'). Only used with 'create'.",
    }),
  ),
  old_string: Type.Optional(
    Type.String({
      description:
        "Text to find in the file. Required for 'patch'. Must be unique unless replace_all=true.",
    }),
  ),
  new_string: Type.Optional(
    Type.String({
      description:
        "Replacement text. Required for 'patch'. Can be empty string to delete matched text.",
    }),
  ),
  replace_all: Type.Optional(
    Type.Boolean({
      description: "For 'patch': replace all occurrences instead of requiring a unique match.",
    }),
  ),
  file_path: Type.Optional(
    Type.String({
      description:
        "Path to a supporting file within the skill directory. Must be under references/, templates/, scripts/, or assets/.",
    }),
  ),
  file_content: Type.Optional(
    Type.String({
      maxLength: MAX_SKILL_FILE_BYTES,
      description: "Content for the file. Required for 'write_file'.",
    }),
  ),
});

async function skillManageHandler(
  params: Record<string, unknown>,
  context: { workspaceDir?: string },
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true }) as
    | "create"
    | "patch"
    | "edit"
    | "delete"
    | "write_file"
    | "remove_file";
  const name = readStringParam(params, "name", { required: true });
  const workspaceDir = context.workspaceDir ?? process.cwd();

  let result: SkillManageResult;

  switch (action) {
    case "create": {
      const content = readStringParam(params, "content", { required: true });
      const category = readStringParam(params, "category");
      result = await createSkill(name, content, category, workspaceDir);
      break;
    }

    case "edit": {
      const content = readStringParam(params, "content", { required: true });
      result = await editSkill(name, content, workspaceDir);
      break;
    }

    case "patch": {
      const oldString = readStringParam(params, "old_string", { required: true });
      const newString =
        readStringParam(params, "new_string", { required: false, allowEmpty: true }) ?? "";
      const filePath = readStringParam(params, "file_path");
      const replaceAll = params.replace_all === true;
      result = await patchSkill(name, oldString, newString, filePath, replaceAll, workspaceDir);
      break;
    }

    case "delete": {
      result = await deleteSkill(name, workspaceDir);
      break;
    }

    case "write_file": {
      const filePath = readStringParam(params, "file_path", { required: true });
      const fileContent = readStringParam(params, "file_content", {
        required: true,
        allowEmpty: true,
      });
      result = await writeSkillFile(name, filePath, fileContent, workspaceDir);
      break;
    }

    case "remove_file": {
      const filePath = readStringParam(params, "file_path", { required: true });
      result = await removeSkillFile(name, filePath, workspaceDir);
      break;
    }

    default:
      result = {
        success: false,
        error: `Unknown action '${action}'. Use: create, edit, patch, delete, write_file, remove_file`,
      };
  }

  return jsonResult(result);
}

// =============================================================================
// Tool Registration
// =============================================================================

/**
 * Create the skill_manage tool with workspace context.
 */
export function createSkillManageTool(options?: { workspaceDir?: string }): AnyAgentTool {
  const workspaceDir = options?.workspaceDir;

  return {
    name: "skill_manage",
    label: "skill_manage",
    description: `Manage skills (create, update, delete). Skills are your procedural memory — reusable approaches for recurring task types.

Actions:
- create: Create new skill with SKILL.md content (YAML frontmatter + markdown body)
- edit: Full SKILL.md rewrite (major overhauls)
- patch: Targeted find-and-replace (token-efficient fixes)
- delete: Remove skill entirely
- write_file: Add supporting file (references/, templates/, scripts/, assets/)
- remove_file: Remove supporting file

Create when:
- Complex task succeeded (5+ tool calls)
- Errors overcome with successful path found
- User-corrected approach worked
- Non-trivial reusable workflow discovered
- User asks to remember a procedure

Update when:
- Instructions stale/wrong
- OS-specific failures found
- Missing steps or pitfalls discovered during use

Good skills have:
- Trigger conditions (when to use)
- Numbered steps with exact commands
- Pitfalls section (what to avoid)
- Verification steps (how to confirm success)`,
    parameters: SkillManageParametersSchema,
    execute: async (_toolCallId: string, args: unknown) => {
      const params = args as Record<string, unknown>;
      return skillManageHandler(params, { workspaceDir });
    },
  };
}

export const skillManageTool: AnyAgentTool = {
  name: "skill_manage",
  label: "skill_manage",
  description: `Manage skills (create, update, delete). Skills are your procedural memory — reusable approaches for recurring task types.

Actions:
- create: Create new skill with SKILL.md content (YAML frontmatter + markdown body)
- edit: Full SKILL.md rewrite (major overhauls)
- patch: Targeted find-and-replace (token-efficient fixes)
- delete: Remove skill entirely
- write_file: Add supporting file (references/, templates/, scripts/, assets/)
- remove_file: Remove supporting file

Create when:
- Complex task succeeded (5+ tool calls)
- Errors overcome with successful path found
- User-corrected approach worked
- Non-trivial reusable workflow discovered
- User asks to remember a procedure

Update when:
- Instructions stale/wrong
- OS-specific failures found
- Missing steps or pitfalls discovered during use

Good skills have:
- Trigger conditions (when to use)
- Numbered steps with exact commands
- Pitfalls section (what to avoid)
- Verification steps (how to confirm success)`,
  parameters: SkillManageParametersSchema,
  execute: async (_toolCallId: string, args: unknown) => {
    const params = args as Record<string, unknown>;
    return skillManageHandler(params, {});
  },
};

export default skillManageTool;
