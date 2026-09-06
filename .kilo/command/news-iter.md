---
description: "Iteration of the news pipeline based on feedback/logs"
agent: code
---

Read AGENTS.md and karpathy-guidelines.md in the project root, then the tail of logs/run.log (if it exists).

Task: $ARGUMENTS

Order of work:
1. Make minimal changes (minimal diff, nothing speculative).
2. Run the success criteria from AGENTS.md: `python3 -m pipeline run` twice (the second run must not add duplicates),
   then `python3 -m pipeline digest`.
3. Show the verification results and the final diff.
