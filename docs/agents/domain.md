# Domain Docs

**Layout**: single-context

## Files

- `CONTEXT.md` — project domain model and terminology (root)
- `docs/adr/` — Architecture Decision Records

## Consumer rules

An agent reading domain material:

1. Read `CONTEXT.md` first for shared vocabulary.
2. Check `docs/adr/` for decisions affecting the current task.
3. Do not restate what `CONTEXT.md` already defines; reference it.
4. When a domain concept is ambiguous, propose an ADR rather than guess.
