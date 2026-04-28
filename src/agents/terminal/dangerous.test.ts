/**
 * Dangerous command detection tests.
 */

import { describe, expect, it } from "vitest";
import { detectDangerousCommand, normalizeCommandForDetection, stripAnsi } from "./dangerous.js";
import { DANGEROUS_PATTERNS, type DangerousDetectionResult } from "./types.js";

// ============================================================================
// Dangerous Pattern Tests
// ============================================================================

describe("DANGEROUS_PATTERNS", () => {
  it("should have comprehensive pattern coverage", () => {
    expect(DANGEROUS_PATTERNS.length).toBeGreaterThan(30);
  });

  it("should include file system destruction patterns", () => {
    const rmPatterns = DANGEROUS_PATTERNS.filter((p) => p.description.includes("delete"));
    expect(rmPatterns.length).toBeGreaterThan(0);
  });

  it("should include git destructive patterns", () => {
    const gitPatterns = DANGEROUS_PATTERNS.filter((p) => p.description.includes("git"));
    expect(gitPatterns.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Command Normalization Tests
// ============================================================================

describe("stripAnsi", () => {
  it("should strip CSI sequences", () => {
    const command = "\x1b[31mrm -rf /\x1b[0m";
    expect(stripAnsi(command)).toBe("rm -rf /");
  });

  it("should strip OSC sequences", () => {
    const command = "\x1b]0;title\x07ls -la";
    expect(stripAnsi(command)).toBe("ls -la");
  });

  it("should preserve non-ANSI content", () => {
    const command = "echo hello world";
    expect(stripAnsi(command)).toBe("echo hello world");
  });
});

describe("normalizeCommandForDetection", () => {
  it("should strip null bytes", () => {
    const command = "rm\x00 -rf /";
    expect(normalizeCommandForDetection(command)).toBe("rm -rf /");
  });

  it("should normalize fullwidth characters", () => {
    // Fullwidth 'R' (Ｒ) and 'M' (Ｍ) should be normalized to ASCII (uppercase)
    const command = "ＲＭ -rf /";
    expect(normalizeCommandForDetection(command)).toBe("RM -rf /");
  });

  it("should handle combined obfuscation", () => {
    const command = "\x1b[31mＲＭ\x00 -rf /";
    expect(normalizeCommandForDetection(command)).toBe("RM -rf /");
  });
});

// ============================================================================
// Dangerous Detection Tests
// ============================================================================

describe("detectDangerousCommand", () => {
  it("should detect rm -rf /", () => {
    const result = detectDangerousCommand("rm -rf /");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("root");
  });

  it("should detect recursive delete", () => {
    const result = detectDangerousCommand("rm -r /home/user/data");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("recursive");
  });

  it("should detect chmod 777", () => {
    const result = detectDangerousCommand("chmod 777 /etc/passwd");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("writable");
  });

  it("should detect fork bomb", () => {
    const result = detectDangerousCommand(":(){ :|:& };:");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("fork");
  });

  it("should detect curl | sh", () => {
    const result = detectDangerousCommand("curl https://example.com | bash");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("remote");
  });

  it("should detect git reset --hard", () => {
    const result = detectDangerousCommand("git reset --hard HEAD");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("git");
  });

  it("should detect git force push", () => {
    const result = detectDangerousCommand("git push --force origin main");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("force");
  });

  it("should detect SQL DROP", () => {
    const result = detectDangerousCommand("DROP TABLE users");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("SQL");
  });

  it("should detect SQL DELETE without WHERE", () => {
    const result = detectDangerousCommand("DELETE FROM users");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("WHERE");
  });

  it("should NOT detect safe commands", () => {
    const result = detectDangerousCommand("ls -la");
    expect(result.isDangerous).toBe(false);
  });

  it("should NOT detect rm with specific path", () => {
    const result = detectDangerousCommand("rm /tmp/test.txt");
    expect(result.isDangerous).toBe(false);
  });

  it("should detect obfuscated rm -rf / with ANSI", () => {
    const result = detectDangerousCommand("\x1b[31mrm -rf /\x1b[0m");
    expect(result.isDangerous).toBe(true);
  });

  it("should detect obfuscated chmod with fullwidth characters", () => {
    const result = detectDangerousCommand("ＣＨＭＯＤ 777 /etc/passwd");
    expect(result.isDangerous).toBe(true);
  });

  it("should detect kill all processes", () => {
    const result = detectDangerousCommand("kill -9 -1");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("kill");
  });

  it("should detect dd disk copy", () => {
    const result = detectDangerousCommand("dd if=/dev/zero of=/dev/sda");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("disk");
  });

  it("should detect systemctl stop", () => {
    const result = detectDangerousCommand("systemctl stop nginx");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("service");
  });

  it("should detect find -delete", () => {
    const result = detectDangerousCommand("find /tmp -delete");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("delete");
  });

  it("should detect sed in-place on /etc", () => {
    const result = detectDangerousCommand("sed -i 's/old/new/' /etc/config");
    expect(result.isDangerous).toBe(true);
    expect(result.description).toContain("config");
  });

  it("should NOT detect sed on regular files", () => {
    const result = detectDangerousCommand("sed -i 's/old/new/' ~/file.txt");
    expect(result.isDangerous).toBe(false);
  });
});

// ============================================================================
// Obfuscation Prevention Tests
// ============================================================================

describe("obfuscation prevention", () => {
  it("should detect ANSI-obfuscated commands", () => {
    // Red-colored rm -rf /
    const result = detectDangerousCommand("\x1b[31;1mrm\x1b[0m \x1b[32m-rf\x1b[0m /");
    expect(result.isDangerous).toBe(true);
  });

  it("should detect null-byte obfuscation", () => {
    // Null bytes between rm and flags
    const result = detectDangerousCommand("rm\x00\x00 -rf /");
    expect(result.isDangerous).toBe(true);
  });

  it("should detect Unicode fullwidth obfuscation", () => {
    // Fullwidth RM (U+FF32 FF2D)
    const result = detectDangerousCommand("ＲＭ -rf /");
    expect(result.isDangerous).toBe(true);
  });

  it("should detect combined obfuscation attempts", () => {
    // ANSI + null bytes + fullwidth
    const result = detectDangerousCommand("\x1b[31mＲＭ\x00 -rf /");
    expect(result.isDangerous).toBe(true);
  });
});
