# Engineering Contract

## Authority

Kartik, the technical lead owns product direction and final technical decisions. 

`architecture.md` is the source of truth for system architecture.

`plan.md` is the source of truth for current implementation priorities and progress.

`README.md` describes the product and development setup.

`CLAUDE.md` contains Claude Code-specific working instructions.

## Operating Principles

- Inspect existing code before modifying it.
- Do not silently change architecture.
- Surface architectural conflicts before proceeding.
- Prefer the simplest production-quality implementation.
- Avoid speculative abstractions.
- Do not modify unrelated code.
- Preserve strong typing where applicable.
- Validate untrusted input at system boundaries.
- Never expose secrets or credentials.
- Never silently swallow meaningful errors.
- Reuse existing project conventions before introducing new ones.

## Implementation

For non-trivial work:

1. Read the relevant project documentation.
2. Inspect the existing implementation.
3. Understand the acceptance criteria.
4. Implement the smallest coherent solution.
5. Verify the implementation.

## Definition of Done

Work is not complete until relevant:

- formatting passes
- lint passes
- typechecking passes
- tests pass
- production build passes
- important loading and error states are handled
- acceptance criteria have been verified

Run:

`./scripts/verify.sh`

before declaring substantial work complete.

## Git Safety

- Never force push unless explicitly instructed.
- Never rewrite unrelated commits.
- Never commit secrets or `.env` files.
- Keep changes scoped to the assigned task.