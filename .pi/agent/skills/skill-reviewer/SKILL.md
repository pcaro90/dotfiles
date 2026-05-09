---
name: skill-reviewer
description: Use when reviewing, critiquing, improving, or creating SKILL.md files for AI agents. Checks structure, tone, conciseness, success criteria, descriptions, naming conventions, progressive disclosure, directory layout, and completeness. Use when the user asks to review, audit, improve, or create a skill, or says "turn this into a skill". Applies whenever the user is working with SKILL.md files, even if they don't explicitly ask for a review.
allowed-tools:
  - read
  - grep
  - find
  - ls
  - edit
  - write
---

# Skill Reviewer

Review and improve AI agent SKILL.md files against established best practices from Anthropic's official docs, the Agent Skills standard, and community guidelines.

## Goal

Produce a structured review of a SKILL.md file with actionable findings, severity ratings, and concrete fixes. Optionally rewrite the skill in-place.

## Steps

### 0. Capture intent (if creating from scratch)

If the user is creating a skill rather than reviewing an existing one, start by extracting context from the current conversation. Look for workflows the user just performed — tools used, sequence of steps, corrections made, input/output formats observed. Ask the user to confirm:

1. What should this skill enable the agent to do?
2. When should this skill trigger? (what user phrases/contexts)
3. What's the expected output format?
4. Should we set up test cases? Skills with objectively verifiable outputs (file transforms, data extraction, code generation) benefit from them. Skills with subjective outputs (writing style, art) often don't need them. Suggest the appropriate default based on the skill type, but let the user decide.

**Success criteria:** Confirm the user answered all four questions before proceeding to writing.

### 1. Load the SKILL.md

Read the full SKILL.md file. If the user referenced a skill name instead of a path, look for `SKILL.md` in the current working directory, `./skills/<name>/SKILL.md`, or another local skills directory the agent knows about.

**Success criteria:** Load the full file content. Quote relevant excerpts only where needed unless the user explicitly asks to see the full file. Report the total token/token-approximation count.

### 1b. Handle missing or malformed input

If the path does not exist, no `SKILL.md` is found, YAML frontmatter is missing or invalid, or the skill name matches multiple files, stop and ask the user for clarification. Do not invent file contents or continue with a partial review.

**Success criteria:** Detect missing, malformed, or ambiguous inputs and ask the user for the minimum clarification needed to continue.

### 2. Check frontmatter

Verify the YAML frontmatter against these rules:

- **`name`:** Lowercase, hyphens, no reserved words (`helper`, `utils`, `tools`, `files`, `documents`, `data`). Prefer gerund form (`monitoring-zines`) but compound noun form (`skill-reviewer`) is acceptable if it reads clearly.
- **`description`:** Written in third person. Starts with an action phrase (`Use when...`, `Handles...`). Describes user intent, not internal mechanics. Includes trigger contexts — cases where the user doesn't name the domain directly. Put all "when to use" information in `description`, not in the body. Under 1024 characters. Contains specific keywords the agent can match against. **Be pushy:** explicitly list contexts where the skill applies to combat undertriggering. Example addition: "even if they don't explicitly mention 'X' or 'Y.'"
- **`compatibility` (optional):** Required tools or dependencies. Flag if the skill requires specific tools but doesn't declare them here.
- **`allowed-tools` (optional but recommended):** Lists which tools the skill is expected to use. Flag any deviation from the rules with a specific fix.

### 2b. Check directory structure

If the skill has bundled resources, verify the directory layout:

```
skill-name/
├── SKILL.md (required)
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed
    └── assets/     - Files used in output (templates, icons, fonts)
```

Flag if files exist outside this structure. Flag if `references/` files lack a table of contents when they exceed 300 lines.

**Success criteria:** Confirm the directory structure matches the convention above. Flag any deviations.

### 3. Check tone and perspective

Scan the body for perspective consistency:

- **Instructions:** Use second person imperative ("Use `X` to do `Y`", "Run this command", "Do not create `Z`").
- **No third-person self-reference:** Flag phrases like "the agent should", "it should", "one must". Rewrite as second person.
- **No first person:** Flag "I will", "we recommend".
- **No agent-name-specific references** unless strictly necessary (e.g., the skill uses Claude Code–exclusive features). Prefer "you" for instructions. Use "the agent" only when referring to the subject being reviewed, not the active assistant.

**Success criteria:** Confirm every instructional sentence is in second-person imperative. List any violations with line references and suggested rewrites.

### 4. Check for success criteria on every step

This is the single biggest quality differentiator. Each numbered or titled step in the skill must include explicit **Success criteria:** that tell the agent when the step is done.

**Success criteria:** Confirm every step has a "Success criteria:" line. Flag steps missing them as HIGH severity.

### 4b. Check progressive disclosure

Verify that `SKILL.md` follows the three-level loading model:

1. **Metadata:** `name` and `description` stay concise and always available.
2. **SKILL.md body:** operational workflow loaded when the skill triggers.
3. **Bundled resources:** detailed schemas, long examples, API docs, and checklists loaded only when needed from `references/`, `scripts/`, or `assets/`.

If the skill uses references, make sure the body explains when to read each one. For multi-domain skills, prefer domain-specific reference files.

**Success criteria:** Confirm the SKILL.md body is lean. Confirm reference material is properly offloaded and references are cited with usage guidance.

### 5. Check conciseness

Evaluate each section for verbosity:

- Flag explanations of concepts the agent already knows (what PDFs are, how Python imports work, what a REST API is).
- Count approximate tokens. Flag long or reference-heavy bodies as candidates for splitting material into `references/` files.
- Flag repeated information (e.g., the same rule stated in two sections).

**Success criteria:** Flag verbosity violations. Confirm no section explains something the agent already knows.

### 5b. Check output formats and examples

If the skill defines an expected output format, verify it uses an exact template rather than vague descriptions like "something like" or "similar to". If the skill transforms input to output, verify it includes at least one representative Input/Output example. Read `references/examples.md` when you need concrete patterns.

**Success criteria:** Confirm output formats use exact templates. Flag transform-style skills without representative Input/Output examples as LOW severity.

### 6. Check behavioral rules

If the skill includes behavioral rules or constraints, verify they follow the **prohibition + reason + alternative** pattern:

- **Weak:** "Don't over-engineer."
- **Strong:** "Don't create helpers or abstractions for one-time operations. The right amount of complexity is the minimum needed for the current task."

**Success criteria:** Confirm each behavioral rule has a reason and/or alternative, not just a prohibition.

### 7. Check persona and identity

If the skill defines an identity or role:

- Must be **functional**, not personality-based.
- Pattern: `You are [role noun] for [context]. [Core capability summary].`
- No personality adjectives ("enthusiastic", "detail-oriented", "passionate").
- Domain expertise should encode **decision criteria**, not just a label.

**Success criteria:** Confirm identity is functional with decision-making criteria. Flag personality-based language.

### 8. Check degree of freedom and writing style

Verify that specificity matches risk: fragile operations need exact commands and clear "Do not modify" boundaries, while creative or analytical tasks can use higher-level guidance. Also flag draft-quality writing, missing rationale, or examples that are too narrow to represent a class of problems.

**Success criteria:** Confirm specificity matches operation fragility. Confirm rules explain why they exist, examples are representative, and writing is polished.

### 9. Check edge cases, surprise, and testability

Verify that steps with likely failure modes explain what to do when commands fail, input is empty or malformed, dependencies are missing, or escalation is needed. Flag hidden behavior, misleading operations, or commands whose intent is not obvious. For objectively verifiable skills, check for 2-3 realistic test prompts.

Use these prompt classes when a reviewed skill lacks realistic tests:

- Missing frontmatter or malformed YAML.
- Missing success criteria in one or more numbered steps.
- Creating a new skill from a previous workflow or conversation.

**Success criteria:** Confirm failure modes have fallback guidance. Confirm operations are honest and unsurprising. Confirm objective-output skills include realistic test prompts.

### 10. Produce the review

Output a structured review using this exact template:

```markdown
**Summary:** PASS / NEEDS WORK / REWRITE RECOMMENDED — one-line verdict.

**Findings:**

1. **Severity:** HIGH / MEDIUM / LOW **Rule violated:** ... **Current text:** "..." **Suggested fix:** ...

**Token count estimate:** ...

**Rewrite offer:** Ask whether the user wants an in-place rewrite addressing all findings only if editing is allowed and the user has not requested review-only output.
```

**Success criteria:** The review includes a verdict, numbered findings with severity/current text/suggested fix, a token estimate, and no rewrite offer when the user requested review-only output.

### 11. (Optional) Rewrite

If the user approves, rewrite the SKILL.md addressing all findings. Preserve the original intent and structure, only fixing what the review flagged.

**Success criteria:** Confirm the rewritten skill passes all checks from steps 2–9 when re-reviewed.

## References

Read these only when useful for the current review:

- `references/checklist.md` — quick final pass after the structured review.
- `references/anti-patterns.md` — examples of recurring skill-quality issues.
- `references/examples.md` — exact output-template and Input/Output example patterns.
