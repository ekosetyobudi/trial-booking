# AI usage

## Tools

Claude Code (Opus) as the implementing agent, driven from a staged plan I wrote
before starting the timer. The plan fixed the order of the work, the exact scope
of each stage, and the gate each stage had to pass before the next one began.
`CLAUDE.md` in this repo carries the standing rules the agent worked under —
strict TypeScript with no `any`, invariants in Postgres rather than application
code, no interfaces or DI, no dependency added without asking, no commit without
my explicit go-ahead.

## What it was used for

Every stage: the scaffold, the schema and seed, the read endpoints, booking
creation, the payment transaction, the test suite, the one-page UI, and the first
draft of this documentation. I reviewed each stage before the next one started,
and I read `service.ts` and `booking.test.ts` line by line myself — those two
files are the submission, and I would not defend code I had only skimmed.

Two stages were handled differently. The payment stage ran as a **plan gate**:
the agent had to produce the transaction sequence statement by statement, name
where the lock was taken, justify recounting after it, and name the alternative
it rejected — all before writing any code. I approved that plan before
implementation began. The API contract in the README was written **before** the
endpoints existed, so the contract was decided by me rather than discovered from
whatever the agent happened to return.

## Where it clearly sped me up

The schema and the read endpoints. Five tables, a partial unique index, a check
constraint, three query functions and three route handlers is mechanical work
with a well-defined answer, and having it produced and verified against a real
database in one pass bought me the time I later spent on concurrency.

The second gain was less obvious: because each stage ended with a verification
command whose real output had to be reported, the errors I would normally find
an hour later surfaced immediately. The `23503` foreign-key branch on booking
creation exists because the verification of that stage showed a raw Postgres
error reaching the client.

## Where I rejected what it produced

**The race test that passed for the wrong reason.** The last-seat test was
written, ran green, and looked finished. I asked for the standard proof: delete
`SELECT ... FOR UPDATE` and show me the test failing. It passed ten runs out of
ten against a service with no lock at all. A green test that cannot fail is
worse than no test, because it certifies the exact thing it is not checking.

Neither obvious cause applied. Both payments were started inside a single
`Promise.all` with no `await` serialising them, and the connection pool was the
postgres.js default of ten, confirmed by running two concurrent `pg_sleep(1)`
transactions and seeing distinct backend pids finish in 1261ms rather than
2000ms. Timestamps taken inside the transaction gave the real cause: postgres.js
opens pool connections lazily, and the TLS handshake to a remote database costs
more than the whole payment transaction. The second payer was still connecting
while the first committed, so the two transactions never overlapped and the
loser read a count that was already final.

The fix is `openConnections()`, which opens both pool connections before the
race starts. With the pool warmed, the test fails ten out of ten without the
lock — both payers reading three confirmed and both confirming into a four-seat
class — and passes ten out of ten with it restored. I applied the same standard
to the second race test added later: with `FOR UPDATE` removed it confirms one
booking twice and records two charges for it, five runs out of five.

**Three schema omissions I accepted and later reversed.** At the schema stage the
agent listed what it had deliberately left out rather than adding it silently:
no `payment_attempts` rows in the seed, no `CHECK (capacity > 0)`, and no unique
constraint on `parents.email`. Flagging them instead of quietly including them
was the right behaviour, and I accepted all three at the time because the
invariants that carry the exercise were still unwritten.

Reviewing that call with time left over, all three were wrong. The seed had no
failed payment in it, so the one status meaning money moved and nothing was
seated could only be produced by driving the API first — and the brief asks for
that case in the seed. `capacity` is the only input to every seat check, so a
non-positive value would make `CLASS_FULL` permanent and unexplainable. And an
email is what identifies a parent, so a duplicate row misfiles every booking
under it. All three are in now. The lesson is not that the agent was careless:
it named each omission clearly. It is that an omission accepted under time
pressure needs revisiting once the pressure is off, and nothing prompts you to
do that except deciding to.

I also rejected the initial reading of `CLASS_FULL`. Counting
`confirmed + pending` against capacity is a defensible reading of the words and
the wrong one here, because a pending booking holds no seat; it would also have
made the race scenario impossible to construct. That definition was pinned in
the instructions rather than left to interpretation.

## How the workflow changed as I went

- **Verification became "show me the command and its output", never a summary.**
  A prose claim that something works is not evidence, and this is what caught the
  false-green race test.
- **The plan gate was worth it exactly once.** For the payment transaction it
  forced the reasoning into the open before any code existed. Applying it to the
  schema or the endpoints would have been ceremony.
- **The README was written incrementally, at four fixed points** rather than at
  the end. The reasoning behind the lock is hardest to reconstruct once the
  context is cold, so it was written while it was still fresh.
- **Scope was held tight on purpose.** Speculative helpers, retry wrappers and
  abstraction layers were refused as they came up. With one implementation of
  everything, an interface buys indirection and nothing else.

## What I would change next time

- **Demand the falsification proof at the same moment the test is written**, not
  after it goes green. The race test cost a second round trip precisely because
  "it passes" was allowed to stand as a result for a while. Any test whose whole
  purpose is to catch a concurrency bug should arrive with evidence of it failing
  against a broken implementation.
- **Give the agent the environment's sharp edges up front.** The lazy connection
  pool was not a reasoning failure, it was missing context about a remote
  database over TLS. A short note on the runtime would have saved the detour.
- **Pin ambiguous domain terms in the instructions before the first line of
  code.** `CLASS_FULL` was pinned and cost nothing; had it not been, the fix
  would have landed in the middle of writing the race test, which is the worst
  possible time to discover the definition is wrong.
- **Fewer, larger review passes on documentation.** Reviewing prose stage by
  stage let claims drift out of step with the code — the final audit found the
  overview asserting a database constraint the service actually enforces. One
  adversarial read of the finished document against the finished code catches
  more than four partial reads did.

## How everything was verified

- **Constraints probed directly against Postgres**, not assumed from the
  migration: the check constraint rejects both directions with `23514`, the
  partial unique index rejects a second live booking with `23505` while
  accepting one after a terminal status, `capacity_positive` rejects 0 and -1
  while accepting 1, and `parents_email_unique` rejects a repeated address with
  `23505`.
- **Every endpoint exercised with curl** against seeded data, including each
  error code and the empty-roster case in both directions.
- **The documented setup run from an empty database.** The three migrations were
  applied incrementally as they were written, which never tests the path a
  reviewer takes. I dropped every table, the enum and the migration bookkeeping,
  then ran the README's commands from scratch: three migrations applied, four
  foreign keys, both indexes and all three constraints present, seed correct, and
  the suite and the browser run green against the rebuilt database.
- **Eight tests importing the service directly**, each building its own parent,
  student and class so no test depends on seeded rows or on what ran before it.
- **Both race tests checked against a deliberately broken implementation**, as
  described above.
- **The UI driven end to end in a real browser** with Playwright: duplicate and
  full-class rejections, a declined payment leaving the seat count untouched, a
  successful payment confirming with a `confirmed_at` and dropping the class
  from three seats to two, and the roster afterwards holding the confirmed
  student and not the declined one. Fourteen assertions, each pairing the
  rendered result with the HTTP status of the request behind it. That harness is
  local tooling and is not part of the submitted repo; the flow it drives is
  reproducible by hand from the API section of the README.

Finally, the finished README and this document were audited against the finished
code by a reviewer prompt with no prior context, asked only for claims the code
does not support. Five were found and corrected, the largest being an overview
sentence that credited Postgres with enforcing capacity when the service enforces
it under a lock.
