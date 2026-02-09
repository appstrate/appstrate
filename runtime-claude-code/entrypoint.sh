#!/bin/bash
set -euo pipefail

MODEL="${LLM_MODEL:-claude-sonnet-4-5-20250929}"

SYSTEM_PROMPT="You are an AI assistant executing a flow. Follow the user instructions precisely. Use Bash with curl for API calls. Output your final result as JSON in a \`\`\`json code block."

echo "$FLOW_PROMPT" | claude -p --output-format stream-json --verbose \
  --no-session-persistence --permission-mode bypassPermissions \
  --allowedTools "Bash(read_only=false) WebFetch WebSearch" \
  --model "$MODEL" --max-turns 50 --system-prompt "$SYSTEM_PROMPT" \
  --disable-slash-commands
