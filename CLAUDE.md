@AGENTS.md

# Ottodot trial booking take-home

The assignment brief is kept outside the repo. Ask me when scope is unclear.
Do not reference it in code comments.

## Scope

Trial bookings only. No enrollment, no auth, no caching, no abstraction layers.
4-hour take-home — the smallest thing that is correct.

## Invariants (enforced in Postgres, not application code)

1. Confirmed students per class never exceed trial_classes.capacity
2. No duplicate confirmed booking for the same student + class
3. A failed payment never produces a confirmed booking
4. On the last seat, at most one concurrent user ends confirmed

## TypeScript

- strict: true. No `any`, no non-null assertion on external input.
- Types are derived, never written twice: inputs via z.infer, rows via
  InferSelectModel. Booking status is one shared union derived from the DB enum.

## Structure (feature-based)

```
src/
  features/booking/
    service.ts      <- business logic, transactions, locking
    queries.ts      <- read-only DB access
    schema.ts       <- zod input schemas
    errors.ts       <- typed domain errors
    components/     <- UI for this feature
  db/               <- client, schema, seed
  lib/              <- genuinely shared utilities only
  app/              <- routes and route handlers
```

## Separation of concerns (non-negotiable)

- Route handlers: parse with zod, call the service, map domain errors to HTTP
  status. No SQL, no business branching.
- Service layer: owns every invariant. Knows nothing about HTTP.
- Components: never touch the database. They call route handlers.
- Tests import the service directly. This is why the boundary exists.

## Errors

Typed and named: DUPLICATE_BOOKING, CLASS_FULL, PAYMENT_FAILED,
BOOKING_NOT_FOUND, BOOKING_NOT_PENDING. Error-to-status mapping lives in one
place. Never surface a raw Postgres error.

## Design principles, scoped to this project

- Single Responsibility: apply it.
- Do NOT introduce interfaces, dependency injection, repositories, or
  factories. There is one implementation of everything here.
- DRY by rule of three. Two similar blocks with different reasons to change
  stay separate.

## React / Next

- Server Components by default; 'use client' only where interactivity needs it.
- Prefer Next primitives over hand-rolled equivalents.
- No shadcn, no component library, no state management library. Tailwind for
  layout only. If shadcn is ever added, components/ui is append-only —
  variations go in a shared wrapper composed from the primitive.

## Scalability, concretely

- Route handlers are stateless. No module-level mutable state, no in-memory
  caches or counters.
- Invariants live in Postgres, so correctness survives multiple instances.
- Seat availability is always derived from bookings.

## Config

All config via env vars. .env.example committed, .env is not. Fail fast at
startup on a missing required var.

## Code comments

- Prefer clear, self-explanatory code. If intent can be expressed through
  naming, do that instead of commenting.
- Comment only where it adds context that is not obvious from the code.
- Explain intent, constraints, trade-offs, or non-obvious behaviour — never
  restate what the code does.
- Maximum 3 lines per comment block. Clear, professional English.
  Self-contained and understandable from the surrounding code.
- No meta-commentary, conversational phrasing, generated-code explanations, or
  wording that suggests the code was written by an AI assistant.
- No decorative symbols, emoji, headings, or unusual formatting.
- Do not narrate straightforward implementation steps.
- Do not reference prompts, task numbers, or AI conversations.
  Referencing API.md or README is fine.
- Do comment the concurrency decisions explicitly: why SELECT FOR UPDATE on the
  class row, why the confirmed count is recounted after the lock, why 23505 is
  caught instead of checking first.

## Working agreement

- Write only what the current task asks for. No speculative helpers, no
  utilities used once, no retry, logging, or config wrappers I did not request.
  If you think something extra is needed, say so and wait — do not add it.
- Run the verification command at the end of every task. Report the command and
  its actual output, not a prose summary. If a check did not run, say so.
- Never claim something works without running it.
- Ask before adding any dependency.
- Never modify NOTES.md, RUNBOOK.md, or anything git ignores.
- Never run git commit or git push. Stop, show `git status --porcelain`, and
  wait for my explicit go-ahead in this session before any commit.
