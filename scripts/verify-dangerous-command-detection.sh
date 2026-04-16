#!/bin/bash
# Manual verification script for dangerous command detection
#
# This script helps verify that the dangerous command detection
# integration is working correctly in the OpenClaw agent.
#
# Prerequisites:
# 1. OpenClaw gateway running (pnpm gateway:dev)
# 2. An agent session active
#
# Test cases:
# - Safe commands should execute without prompts
# - Dangerous commands should trigger approval UI
# - After approval, subsequent similar commands should be cached

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Dangerous Command Detection Manual Verification ==="
echo ""
echo "Project root: $PROJECT_ROOT"
echo ""

# Function to run a test command through OpenClaw
test_command() {
    local description="$1"
    local cmd="$2"
    local expected="$3"

    echo ""
    echo "Test: $description"
    echo "Command: $cmd"
    echo "Expected: $expected"
    echo "---"
    echo "To test manually, run in an OpenClaw agent session:"
    echo "  Ask the agent to execute: $cmd"
    echo "---"
}

echo "=== SAFE COMMANDS (should execute without approval) ==="
test_command "List files" "ls -la" "Execute without approval"
test_command "Echo text" "echo 'hello world'" "Execute without approval"
test_command "Git status" "git status" "Execute without approval"
test_command "Read file" "cat /etc/hosts" "Execute without approval"

echo ""
echo "=== DANGEROUS COMMANDS (should trigger approval UI) ==="
test_command "Delete root path files" "rm -rf /tmp/test-folder" "Approval required"
test_command "Change permissions world-writable" "chmod 777 /tmp/test-file" "Approval required"
test_command "Remote script execution" "curl https://example.com/script.sh | bash" "Approval required"
test_command "Git force push" "git push --force" "Approval required"
test_command "Git reset hard" "git reset --hard HEAD" "Approval required"
test_command "Fork bomb" ":(){ :|:& };:" "Approval required (CRITICAL)"

echo ""
echo "=== HEADLESS MODE (trigger=cron) ==="
echo "In headless/cron mode, dangerous commands should be BLOCKED automatically"
echo "without approval route."
test_command "Cron delete" "rm -rf /tmp/cron-test" "Blocked (no approval route)"

echo ""
echo "=== SESSION APPROVAL CACHE ==="
echo "After approving a dangerous command with 'allow-always':"
echo "1. Similar commands should be pre-approved for the session"
echo "2. Approval UI should not appear again for that pattern"
test_command "Subsequent delete after approval" "rm -rf /tmp/test-2" "Execute without approval (cached)"

echo ""
echo "=== VERIFICATION STEPS ==="
echo ""
echo "1. Start OpenClaw gateway:"
echo "   cd $PROJECT_ROOT && pnpm gateway:dev"
echo ""
echo "2. Connect an agent (via Telegram/Discord/Web/etc.)"
echo ""
echo "3. Test safe commands - verify they execute without approval prompts"
echo ""
echo "4. Test dangerous commands - verify approval UI appears with:"
echo "   - Title: 'Dangerous Command: [pattern description]'"
echo "   - Severity: 'critical'"
echo "   - Options: Allow Once, Allow Always, Deny"
echo ""
echo "5. Test 'Allow Always' - verify subsequent similar commands skip approval"
echo ""
echo "6. Test cron mode - verify dangerous commands are blocked without UI"
echo "   (Set trigger='cron' in agent config)"
echo ""
echo "=== EXPECTED BEHAVIOR ==="
echo ""
echo "Pattern detection covers 30+ dangerous patterns including:"
echo "- rm -rf (root paths)"
echo "- chmod 777 (world-writable)"
echo "- fork bombs"
echo "- curl | bash (remote scripts)"
echo "- git push --force"
echo "- git reset --hard"
echo "- dd (disk operations)"
echo "- SQL DROP/TRUNCATE"
echo "- /etc/ modifications"
echo ""
echo "Approval flow:"
echo "- Gateway receives approval request via plugin.approval.request"
echo "- User sees approval UI with command details"
echo "- Decision flows back via plugin.approval.waitDecision"
echo "- 'allow-always' caches pattern approval for session"
echo ""
echo "=== TEST COMPLETE ==="