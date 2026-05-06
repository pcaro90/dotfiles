# Common Skill Anti-Patterns

Watch for these recurring mistakes during review.

1. **Explaining the obvious** — e.g. defining PDFs, imports, or REST APIs when the agent already knows them.
2. **Vague descriptions** — e.g. "A utility for data processing" is too broad to trigger reliably.
3. **Mixed perspective** — alternating between "you should" and "the agent should".
4. **Personality in identity** — e.g. "You are an enthusiastic assistant..." instead of a functional role.
5. **Missing success criteria** — steps without a way to verify completion.
6. **Over-long skills** — detailed schemas, API docs, or long examples crammed into `SKILL.md` instead of `references/`.
7. **Generic names** — `helper`, `utils`, `tools`, etc. are uninformative for discovery.
8. **No error handling** — assuming every command or input works on the first try.
9. **Implementation-focused descriptions** — describing internals instead of user intent and trigger contexts.
10. **Aspirational guidance** — e.g. "write good code" instead of specific checks or commands.
11. **Vague output formats** — saying "something like" instead of providing an exact template.
12. **No examples for transformations** — formatters, converters, and generators need representative Input/Output examples.
13. **Hardcoded examples** — examples should represent a class of problems, not only one narrow case.
