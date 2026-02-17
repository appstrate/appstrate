#!/bin/bash
set -euo pipefail

MODEL="${LLM_MODEL:-claude-sonnet-4-5-20250929}"

SYSTEM_PROMPT="You are an AI assistant executing a flow. Follow the user instructions precisely. Use Bash with curl for API calls. Output your final result as JSON in a \`\`\`json code block."

# Initialize git repo (required for Claude Code project root detection)
git init -q /workspace
git -C /workspace config user.email "claude@appstrate.local"
git -C /workspace config user.name "Claude"

# Extract flow package if present
if [ -f /workspace/flow-package.zip ]; then
  cd /workspace && unzip -qo flow-package.zip -d /workspace/.flow-package
  # Install skills
  if [ -d /workspace/.flow-package/skills ]; then
    mkdir -p /workspace/.claude/skills
    cp -r /workspace/.flow-package/skills/* /workspace/.claude/skills/
  fi
  rm -rf /workspace/.flow-package /workspace/flow-package.zip
fi

echo "$FLOW_PROMPT" | claude -p --output-format stream-json --verbose \
  --no-session-persistence --permission-mode bypassPermissions \
  --allowedTools "Bash(read_only=false) WebFetch WebSearch" \
  --model "$MODEL" --max-turns 50 --system-prompt "$SYSTEM_PROMPT"
