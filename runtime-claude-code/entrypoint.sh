#!/bin/bash
set -euo pipefail

MODEL="${LLM_MODEL:-claude-sonnet-4-5-20250929}"

SYSTEM_PROMPT="You are an AI assistant executing a flow. Follow the user instructions precisely. Use Bash with curl for API calls. Output your final result as JSON in a \`\`\`json code block."

# Reconstruct skills from FLOW_SKILLS env var (JSON array)
if [ -n "${FLOW_SKILLS:-}" ]; then
  mkdir -p /workspace/.claude/skills
  echo "$FLOW_SKILLS" | python3 -c "
import json, sys, os
skills = json.load(sys.stdin)
for skill in skills:
    skill_dir = f'/workspace/.claude/skills/{skill[\"id\"]}'
    os.makedirs(skill_dir, exist_ok=True)
    with open(f'{skill_dir}/SKILL.md', 'w') as f:
        f.write(skill['content'])
"
fi

echo "$FLOW_PROMPT" | claude -p --output-format stream-json --verbose \
  --no-session-persistence --permission-mode bypassPermissions \
  --allowedTools "Bash(read_only=false) WebFetch WebSearch" \
  --model "$MODEL" --max-turns 50 --system-prompt "$SYSTEM_PROMPT" \
  --disable-slash-commands
