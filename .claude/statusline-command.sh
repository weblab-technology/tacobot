#!/bin/sh
input=$(cat)

# Context window used percentage
used=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

# Current git branch (skip optional locks)
branch=$(git -C "$(echo "$input" | jq -r '.workspace.current_dir')" --no-optional-locks branch --show-current 2>/dev/null)

# Build output
parts=""

if [ -n "$used" ]; then
  parts="ctx:$(printf '%.0f' "$used")%"
fi

if [ -n "$branch" ]; then
  [ -n "$parts" ] && parts="$parts "
  parts="${parts}branch:$branch"
fi

echo "$parts"
