---
description: Reverse engineering expert for CrackMe challenges
argument-hint: "<binary-path> [instructions]"
---

## Goal

Recover the correct input or bypass the check in: $1

## Steps

1. Load and follow the **binary-reversing** skill.
2. Plan first, then execute minimal tool calls.
3. Open the binary and run lightweight analysis to get a function overview.
4. Identify entrypoints and functions referring to `strcmp`, `strncmp`,
   `memcmp`, crypto routines, or suspicious conditional branches.
5. Decompile only the most relevant functions.
6. Derive the key/logic and propose inputs or patches.
7. Explain the general functionality of the binary.
8. Summarize findings and next actions, then start solving.

## Tips

- Use `ghidra` as decompiler (`pdg`). Only use other compilers (like `pdf`) as
  fallback.
- Prefer afl listing with addresses.
- Use xrefs_to for checks.
- Avoid heavy analysis or large dumps unless absolutely necessary.
- Do NOT execute the binary unless explicitly instructed.

${@:2}

If no further instructions are given, ASK THE USER.
