# Trial Booking

Trial class booking for a tuition centre: a parent picks a student and a trial class,
creates a booking, and pays for it. The duplicate rule is a Postgres constraint.
Capacity is enforced by the service under a row lock, because a count across rows
is not something a constraint can express. Neither depends on application timing,
so both hold across concurrent requests and multiple app instances.

## Quick start

Requires Bun 1.4 and a Postgres database (Supabase session pooler, port 5432).

```bash
bun install
cp .env.example .env   # then set DATABASE_URL
bun run db:migrate
bun run db:seed
bun run dev
```

The seed creates three classes of capacity 4 with 1, 3, and 4 confirmed bookings,
so the open, one-seat-left, and full cases are all reachable without setup. It
also leaves one student already confirmed in the open class, so a duplicate
attempt is one click away, and one booking in `payment_failed` with its declined
`payment_attempts` row, so the failure path is visible before anything is driven
through the API.

## Schema

Five tables. `payment_attempts` records every charge; everything else is the
booking chain.

```
parents(id, name, email unique)
students(id, parent_id -> parents, name)
trial_classes(id, subject, starts_at, capacity default 4)
bookings(id, student_id -> students, trial_class_id -> trial_classes,
         status, confirmed_at, status_reason, created_at, updated_at)
payment_attempts(id, booking_id -> bookings, succeeded, failure_reason, created_at)
```

`status` is a Postgres enum, not a text column, so an unknown status fails at
write time rather than surviving in a row nobody reads until it breaks a count.

### Five constraints, and why each exists

```sql
CREATE UNIQUE INDEX bookings_one_live_per_student_class
  ON bookings (student_id, trial_class_id)
  WHERE status IN ('pending_payment', 'confirmed');

CREATE INDEX bookings_class_status ON bookings (trial_class_id, status);

ALTER TABLE bookings ADD CONSTRAINT confirmed_at_consistent
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL));

ALTER TABLE trial_classes ADD CONSTRAINT capacity_positive
  CHECK (capacity > 0);

ALTER TABLE parents ADD CONSTRAINT parents_email_unique UNIQUE (email);
```

**The unique index is partial, and it covers `pending_payment` as well as
`confirmed`.** Covering only `confirmed` would let a parent who double-clicks
accumulate pending bookings for the same class, and each one is a chargeable
row. Covering every status would be worse: a parent whose card was declined
could never retry, because the dead `payment_failed` row would block them
forever. The three terminal statuses fall out of the index, so a retry is a
plain insert and needs no cleanup path.

That index is also the enforcement, not a hint. Duplicate detection catches the
`23505` it raises rather than reading first and then inserting — a read-then-insert
has a window between the two statements in which another request commits the same
booking, and no amount of application care closes it.

**The composite index exists because the confirmed count is a hot read.** It is
recounted inside every payment transaction while a lock is held, so it sits on
the critical path of the one query that must not be slow.

**The check constraint pairs the timestamp with the status in both directions.**
`confirmed` without `confirmed_at` and `confirmed_at` without `confirmed` are
both rejected. That is what lets the roster promise a `confirmed_at` on every
entry instead of defending against a null it can do nothing about.

**Capacity must be positive.** It is the only input to every seat check, so a
zero or negative value would make `CLASS_FULL` permanent and unexplainable. A
class with no seats is not a class.

**A parent's email is unique.** It is what identifies them, so two rows sharing
one are the same person recorded twice, and every booking under the duplicate is
filed against the wrong parent. Cheaper to refuse the second row than to merge
two histories later.

### Two statuses for one failed booking

`payment_failed` and `seat_unavailable` are deliberately not one status. Only
the second means money moved: the charge was accepted and then the last seat was
found taken. Collapsing them would hide a refund obligation inside a status that
otherwise means "nothing happened", and the void queue is exactly the thing you
need to be able to query. `cancelled` is reserved and no endpoint writes it.

### No counter column

`trial_classes` holds `capacity` and nothing else about occupancy. Seat
availability is always counted from `bookings` — `GET /api/classes` derives it
with a filtered aggregate, and the payment transaction recounts it under a lock.

A `seats_taken` column would be faster and would be the bug: it is a second
source of truth that has to be kept in step with the rows it summarises, and
every path that writes a booking becomes a path that can drift it. Capacity is
read from the class row on every check, so no code anywhere hardcodes 4.

## API

Base URL `http://localhost:3000`. Every endpoint accepts and returns JSON only.

**Conventions**

- Field names are `snake_case`. Timestamps are ISO 8601 in UTC (`2026-09-10T07:17:26.614Z`).
- Every successful response is a JSON object. Arrays are always nested under a
  plural key, never returned at the top level.
- Reads are never cached. Every response reflects committed state at request time.
- Seat availability is always derived from `bookings`; there is no counter column.

**Error envelope**

Every error this API raises deliberately has this shape:

```json
{ "error": { "code": "CLASS_FULL", "message": "Human-readable explanation." } }
```

`code` is the contract; branch on it. `message` is for humans and may change
without notice — never parse it. Responses from `POST /api/bookings/[id]/pay`
carry one extra field, `booking_status`, described under that endpoint.

---

### GET /api/students

Every student with their parent, ordered by student name. Intended for a picker.

`200 OK`

```json
{
  "students": [
    {
      "id": "24135381-eb7d-42ca-aceb-24ef4cceb7fa",
      "name": "Aaron Tan",
      "parent": {
        "id": "381d8c55-2c58-47a8-9bd8-34dcfb26112c",
        "name": "Tan Wei Ming",
        "email": "parent1@example.com"
      }
    }
  ]
}
```

Never 404s. A database with no students returns `{ "students": [] }`.

---

### GET /api/classes

Every trial class with derived seat counts, ordered by `starts_at`.

`200 OK`

```json
{
  "classes": [
    {
      "id": "0f4b4599-8b9d-4975-b3b1-fcafe446b11e",
      "subject": "Primary 4 Mathematics",
      "starts_at": "2026-09-10T07:17:26.614Z",
      "capacity": 4,
      "confirmed_count": 1,
      "seats_remaining": 3
    }
  ]
}
```

- `confirmed_count` counts bookings with status `confirmed` only. Bookings in
  `pending_payment` are **not** counted, because a pending booking does not hold
  a seat (see `POST /api/bookings`).
- `seats_remaining` is `capacity - confirmed_count`, floored at 0. It is never
  negative, even if an administrator lowers `capacity` below the number of
  confirmed bookings.
- `seats_remaining: 0` means the class is full. It does not guarantee that a
  concurrent payment will fail — only that no seat is free at read time.

Never 404s.

---

### GET /api/classes/[id]/roster

Confirmed bookings for one class, ordered by `confirmed_at` ascending.

`200 OK`

```json
{
  "class_id": "5c1457bd-2738-45a5-86e6-6cf1739078ca",
  "bookings": [
    {
      "id": "1b964971-db92-4598-8504-9018b4c764c1",
      "student": {
        "id": "87bddc7c-146d-4b79-b124-5a0e94a9ebc0",
        "name": "Faith Wong"
      },
      "confirmed_at": "2026-09-09T07:17:27.011Z"
    }
  ]
}
```

- Only `confirmed` bookings appear. `pending_payment`, `payment_failed`,
  `seat_unavailable`, and `cancelled` are never in a roster.
- `confirmed_at` is always present and non-null on every entry.
- An existing class with no confirmed bookings returns `200` with
  `"bookings": []`. Only a class that does not exist returns `404`. Do not treat
  an empty array as a missing class.

| Status | Code              | When                                |
| ------ | ----------------- | ----------------------------------- |
| 400    | `INVALID_REQUEST` | `id` is not a UUID                  |
| 404    | `CLASS_NOT_FOUND` | `id` is a UUID with no matching row |

---

### POST /api/bookings

Creates a booking in `pending_payment`. Creating a booking does not charge
anything and does not hold a seat.

**Request**

```json
{
  "student_id": "24135381-eb7d-42ca-aceb-24ef4cceb7fa",
  "trial_class_id": "0f4b4599-8b9d-4975-b3b1-fcafe446b11e"
}
```

Both fields are required UUIDs. Unknown fields are rejected.

**`201 Created`**

```json
{
  "booking": {
    "id": "b0094d36-94c3-4db8-9b4b-22e85b0a038c",
    "student_id": "24135381-eb7d-42ca-aceb-24ef4cceb7fa",
    "trial_class_id": "0f4b4599-8b9d-4975-b3b1-fcafe446b11e",
    "status": "pending_payment",
    "confirmed_at": null,
    "created_at": "2026-09-09T07:17:26.765Z"
  }
}
```

| Status | Code                | When                                                         |
| ------ | ------------------- | ------------------------------------------------------------ |
| 400    | `INVALID_REQUEST`   | Body is not JSON, a field is missing, or a UUID is malformed |
| 404    | `STUDENT_NOT_FOUND` | `student_id` has no matching row                             |
| 404    | `CLASS_NOT_FOUND`   | `trial_class_id` has no matching row                         |
| 409    | `DUPLICATE_BOOKING` | This student already has a **live** booking for this class   |
| 409    | `CLASS_FULL`        | The class already has `capacity` **confirmed** bookings      |

**A seat is not reserved at this step.** Two parents may both hold a
`pending_payment` booking for the same last seat; the race is settled at payment,
not at booking. This is why `CLASS_FULL` here counts confirmed bookings only.

**Live** means `pending_payment` or `confirmed`. A student whose earlier booking
ended in `payment_failed`, `seat_unavailable`, or `cancelled` may book the same
class again — that is a retry, not a duplicate.

`DUPLICATE_BOOKING` does not return the id of the existing booking.

**These are checked in order, not independently.** The class is looked up, then
capacity, and only then does the insert run — so a request naming an unknown
student against a full class returns `CLASS_FULL`, not `STUDENT_NOT_FOUND`. The
existence of a student is only ever learned from the insert, which is what keeps
that check free of a race.

---

### POST /api/bookings/[id]/pay

Settles a `pending_payment` booking. Payment is a deterministic mock: the caller
states the outcome, and it is never random. Every attempt that reaches the
provider is recorded, whether it succeeds or fails. A call rejected by the guards
before that point — `BOOKING_NOT_FOUND` or `BOOKING_NOT_PENDING` — records
nothing, because no charge was attempted.

**Request**

```json
{ "succeed": true }
```

`succeed` is required. `true` simulates an accepted charge, `false` a decline.

**`200 OK`** — charge accepted and a seat was still free.

```json
{
  "booking": {
    "id": "b0094d36-94c3-4db8-9b4b-22e85b0a038c",
    "student_id": "24135381-eb7d-42ca-aceb-24ef4cceb7fa",
    "trial_class_id": "0f4b4599-8b9d-4975-b3b1-fcafe446b11e",
    "status": "confirmed",
    "confirmed_at": "2026-09-09T07:19:02.114Z",
    "created_at": "2026-09-09T07:17:26.765Z"
  }
}
```

**Errors.** Every error from this endpoint except `INVALID_REQUEST` and
`BOOKING_NOT_FOUND` carries the booking's resulting status, so a client never has
to re-read to learn where the booking landed:

```json
{
  "error": {
    "code": "CLASS_FULL",
    "message": "The last seat was taken while the payment was being processed.",
    "booking_status": "seat_unavailable"
  }
}
```

| Status | Code                  | `booking_status`   | When                                                      |
| ------ | --------------------- | ------------------ | --------------------------------------------------------- |
| 400    | `INVALID_REQUEST`     | absent             | `id` is not a UUID, or `succeed` is missing/not a boolean |
| 402    | `PAYMENT_FAILED`      | `payment_failed`   | Called with `succeed: false`                              |
| 404    | `BOOKING_NOT_FOUND`   | absent             | `id` is a UUID with no matching row                       |
| 409    | `BOOKING_NOT_PENDING` | current status     | The booking is not in `pending_payment`                   |
| 409    | `CLASS_FULL`          | `seat_unavailable` | Charge succeeded, but the class filled up first           |

Three points a client must handle correctly:

- **`PAYMENT_FAILED` is not a server error.** The request was well-formed and was
  processed; the charge was declined. The booking moves to `payment_failed` and
  never appears in a roster. The parent may create a new booking for the same class.
- **`CLASS_FULL` here means money moved.** The charge succeeded and then the last
  seat was found taken, so the booking moves to `seat_unavailable` and the charge
  has to be voided. This is why it is a separate status from `payment_failed`,
  and why it is not reported as a payment failure.
- **`BOOKING_NOT_PENDING` is terminal for this call.** Paying twice does not
  confirm twice. Read `booking_status` to see the real state — it may be
  `confirmed` (already paid), `payment_failed`, `seat_unavailable`, or `cancelled`.

On the last seat, with several payments in flight at once, exactly one ends
`confirmed`; the rest get `CLASS_FULL` with `seat_unavailable`.

---

### Booking statuses

| Status             | Meaning                                                           | Holds a seat |
| ------------------ | ----------------------------------------------------------------- | ------------ |
| `pending_payment`  | Booking created, not yet paid                                     | No           |
| `confirmed`        | Paid and seated. `confirmed_at` is set                            | Yes          |
| `payment_failed`   | Charge declined. No money moved                                   | No           |
| `seat_unavailable` | Charge succeeded but the seat was gone. The charge must be voided | No           |
| `cancelled`        | Reserved. No endpoint writes this status                          | No           |

`pending_payment` and `confirmed` are _live_: a student may hold at most one live
booking per class. The other three are terminal and do not block a retry.

### Error codes

| Code                  | HTTP | Endpoints                                            |
| --------------------- | ---- | ---------------------------------------------------- |
| `INVALID_REQUEST`     | 400  | any                                                  |
| `PAYMENT_FAILED`      | 402  | `POST /api/bookings/[id]/pay`                        |
| `STUDENT_NOT_FOUND`   | 404  | `POST /api/bookings`                                 |
| `CLASS_NOT_FOUND`     | 404  | `GET /api/classes/[id]/roster`, `POST /api/bookings` |
| `BOOKING_NOT_FOUND`   | 404  | `POST /api/bookings/[id]/pay`                        |
| `DUPLICATE_BOOKING`   | 409  | `POST /api/bookings`                                 |
| `CLASS_FULL`          | 409  | `POST /api/bookings`, `POST /api/bookings/[id]/pay`  |
| `BOOKING_NOT_PENDING` | 409  | `POST /api/bookings/[id]/pay`                        |

A raw Postgres error is never surfaced. Anything unmapped — an unreachable
database, a bug — is rethrown and becomes a framework `500` with no envelope, as
is a request to a path or method that does not exist. Branch on the envelope when
it is there; treat its absence as "the request never reached the domain".

---

## The last-seat race

Two parents pay for the fourth seat of a four-seat class at the same moment.
Exactly one may end `confirmed`. The rule is not "usually one" — a rule that
holds only when the application is fast enough is not a rule.

### The approach: one transaction, a pessimistic lock on the class row

```sql
BEGIN;
  SELECT trial_class_id FROM bookings WHERE id = $1;            -- which class to lock
  SELECT capacity FROM trial_classes WHERE id = $2 FOR UPDATE;  -- the mutex
  SELECT * FROM bookings WHERE id = $1;                         -- status, re-read under the lock
  INSERT INTO payment_attempts (...);                           -- the charge is recorded
  SELECT count(*) FROM bookings
    WHERE trial_class_id = $2 AND status = 'confirmed';         -- recounted, never cached
  UPDATE bookings SET status = 'confirmed', confirmed_at = now() WHERE id = $1;
COMMIT;
```

**Why the class row and not the booking rows.** The two payers hold _different_
booking rows, so locking those serialises nothing. A booking belongs to exactly
one class, which makes the class row the one object both contenders must touch.
It also happens to serialise the second race for free: two calls paying the
_same_ booking twice queue on the same row, so `BOOKING_NOT_PENDING` is decided
under the same lock rather than by a status read that was true a moment ago.

**Why the count is taken after the lock, never before.** `capacity` comes from
the locked row, but the confirmed total lives in `bookings`, which any other
payer can change. A count read before acquiring the lock is a fact about the
past. Read after it, every competitor is held at the lock until this transaction
commits, so the number cannot move between the check and the write.

**Why `pending_payment` holds no seat.** Booking creation counts only
`confirmed`, so two parents may both hold a pending booking for the last seat.
That is intentional: the alternative reserves a seat for an abandoned checkout.
`CLASS_FULL` at booking time is therefore advisory — a courtesy that fails fast
— and the payment step is the only place capacity is actually enforced.

### Alternatives rejected

**Optimistic locking** — a version column on `trial_classes`, bumped on confirm,
with a retry on conflict. Rejected because by the time the conflict is detected
the card has already been charged. The retry would either charge again or need a
compensation path, which is more machinery than the lock, for a hot row where
conflicts are the expected case rather than the rare one. Optimistic control
pays off under low contention; the last seat is definitionally high contention.

**Holding the seat at `pending_payment`** — count pending rows toward capacity.
Rejected because it moves the problem rather than solving it: an abandoned
checkout now holds a seat, so it needs an expiry, which needs a background job
and a timeout nobody can pick correctly. It also converts every double-click
into a refused booking.

**`SERIALIZABLE` isolation** — let Postgres detect the anomaly. Rejected for the
same reason as optimistic locking: it surfaces as a serialization failure the
application must retry, after the charge. `FOR UPDATE` blocks _before_ any money
moves, which is the ordering that matters.

**A unique constraint on (class, seat_number)** — make the database refuse the
fifth seat outright. Rejected because trial classes have no seat identity to
model; inventing one turns a capacity change into a data migration.

### Tradeoffs accepted

**Payments for one class are serialised.** Throughput per class is bounded by
transaction duration. This is the cost being paid deliberately: contention is
scoped to a single class row, so classes do not block each other, and a trial
class holds single-digit seats.

**The mock charge runs inside the transaction.** It is a local insert, so it
costs nothing today. A real gateway call must not stay here — it would hold a
row lock across a network round trip, and a provider timeout would become a
class-wide outage. The fix is to charge first and hold the lock only around the
recount and the confirm, accepting that a crash between the two leaves a charge
to reconcile. Called out rather than pre-built, because the reconciliation path
is the larger half of that change.

**There is no `lock_timeout`.** A stuck transaction blocks other payers for that
class indefinitely. This costs liveness, never correctness, and is why lock wait
time on `trial_classes` is on the monitoring list.

**The loser is charged.** `seat_unavailable` means a successful charge with no
seat, and nothing in this codebase voids it. That is a deliberate boundary: the
status exists precisely so the obligation is queryable, and the void belongs to
the payment provider integration that does not exist here.

### Where each invariant is enforced

| Invariant                                     | Enforced by                                                    |
| --------------------------------------------- | -------------------------------------------------------------- |
| No duplicate live booking per student + class | Postgres partial unique index                                  |
| `confirmed` always has a `confirmed_at`       | Postgres check constraint                                      |
| A failed payment never confirms               | Service: status written before the confirm branch is reachable |
| Confirmed never exceeds capacity              | Service: recount under `FOR UPDATE` on the class row           |

The first two survive anything that writes to the database, including psql. The
last two need the transaction, so they live in `service.ts` — which is why tests
import the service directly rather than driving it over HTTP.

---

## The page

`/` is the whole UI. Pick a student and a trial class, create the booking, then
settle it with one of two mock pay actions and see where it landed. It exists to
demonstrate the flow, not to be a product: the spec does not ask for a polished
frontend, so every minute beyond "the flow is visible and the errors are legible"
went into the backend instead.

It talks to nothing but the documented HTTP API. `/` is a Server Component
holding the heading; all interaction lives in one `'use client'` component that
fetches from the route handlers in the browser. Components are barred from the
database, and a Server Component cannot call its own route handlers without an
absolute origin and a new required env var, so the data is fetched client-side.
The cost is no server-rendered data and no loading state, both accepted.

Three behaviours worth knowing before clicking:

- **Full classes stay selectable.** That is the only way to reach `CLASS_FULL`
  from the page. The UI is not where capacity is enforced.
- **Both pay buttons disable once the booking leaves `pending_payment`,** which
  also makes `BOOKING_NOT_PENDING` unreachable from the page. It is covered by
  tests and reachable with curl.
- **The class list is refetched only after a payment settles,** because creating
  a booking changes no confirmed count.

The roster has no UI. It is served by `GET /api/classes/[id]/roster`.

## Tests

```bash
bun run test
```

Tests import the service directly rather than going through HTTP, so a failure
points at the invariant rather than at routing or serialisation. Each test builds
its own parent, student and class and never reads a seeded row.

| Test                                         | Proves                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| Paid booking reaches the roster              | The confirm path writes `confirmed_at` and the roster reads it                   |
| Duplicate live booking rejected              | The partial unique index, surfaced as `DUPLICATE_BOOKING`                        |
| Booking rejected on a full class             | Capacity is refused at creation time                                             |
| Declined payment leaves the roster untouched | A failed charge never seats a student                                            |
| Two payments race the last seat              | Exactly one `confirmed`, one `seat_unavailable`, 4 confirmed                     |
| Two payments race the same booking           | Exactly one `confirmed`, one `BOOKING_NOT_PENDING`, and only one charge recorded |
| A settled booking cannot be paid again       | A terminal status is not resurrected, and no second charge is written            |
| Paying an unknown id                         | `BOOKING_NOT_FOUND`                                                              |

Both race tests were checked against a broken implementation before being
trusted. With `FOR UPDATE` removed, the last-seat test fails ten runs out of ten
and the same-booking test fails five out of five, the latter confirming one
booking twice and recording two charges for it. Restored, both pass every run.

The race tests open both pool connections before firing the two payments.
postgres.js connects lazily, and a cold TLS handshake takes longer than the
critical section, so without that step the second transaction starts after the
first has committed and the test passes against a service with no lock at all.
This was found by deleting the lock and watching the test stay green; see
AI_USAGE.md.

## What I'd monitor

Each of these is something the test suite cannot observe, either because it is a
production-rate signal or because it needs state the tests tear down.

**`seat_unavailable` rate.** This status means a charge succeeded and the seat
was gone, so every occurrence is money taken that owes a void. The race test
proves one is produced correctly under contention; nothing in the system refunds
it. Alert on any non-zero count in a window, not on a threshold, and reconcile
each one against the payment provider.

**`payment_failed` volume and its rate of change.** The mock charge is
deterministic — the caller states the outcome — so the tests exercise the
handling of a decline but say nothing about how often declines happen. A step
change in this rate is a provider incident or a checkout regression, and it is
indistinguishable from normal operation at any single request.

**Lock wait time on `trial_classes` rows.** Payment serialises every payer for a
class behind one row lock, which is what makes the invariant hold. The cost is
queueing that grows with contention. The test races two payers; a popular class
may race twenty, each waiting behind a transaction that includes a payment
record write. Watch `pg_stat_activity` for `Lock` waits on that relation and the
p99 duration of the pay endpoint. A rising wait is the signal to move the
provider call out of the transaction before it becomes a timeout.

**Drift between `payment_attempts.succeeded` and booking status.** Every
successful attempt should correspond to a booking that is `confirmed` or
`seat_unavailable`, and nothing else. A successful attempt against a booking
still in `pending_payment` means a transaction committed the charge and lost the
status, which no test asserts because each test checks only the booking it
created. Run this as a periodic query across all rows; it is the one check that
catches a partial write.

**Bookings aged in `pending_payment`.** Nothing expires them, and they hold no
seat, so they are invisible to capacity but they do block that student from
rebooking the class through the live-booking unique index. The tests always pay
or abandon within a single run, so the aged case never appears. Track the oldest
`pending_payment` age per class.

## Where each check belongs

The same rule is often worth stating in more than one place, but only one of
them is the enforcement. This is the split.

| Layer          | Owns                                                        | Example                                                              |
| -------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| UI             | Nothing. Guidance only                                      | Disables the pay buttons on a settled booking                        |
| Route handler  | Request shape, and the mapping from domain error to status  | zod rejects a malformed uuid as `INVALID_REQUEST`                    |
| Service        | Every transition, and capacity under a lock                 | Recount after `FOR UPDATE`, confirm only while `count < capacity`    |
| Database       | The invariants that must survive any writer, including psql | Partial unique index, `confirmed_at_consistent`, `capacity_positive` |
| Background job | Nothing yet — this is the gap                               | Voiding `seat_unavailable` charges, expiring aged `pending_payment`  |

A check in the UI is a courtesy to the user. A check in the service holds for
every caller of the service. A check in the database holds for everyone,
including a migration or an admin at a psql prompt, which is why the two rules
that must never break live there.

## Assumptions

- A student may hold one live booking per class. A booking that ended
  `payment_failed`, `seat_unavailable` or `cancelled` is a retry, not a
  duplicate.
- Payment is a deterministic mock driven by the caller. There is no provider, no
  idempotency key, and no webhook, so nothing here can be replayed or reconciled
  against an external system.
- No authentication. `student_id` is taken from the request body rather than a
  session, and the roster is open.
- Trial classes have no seat identity, no waitlist, and no cancellation flow.
- One Postgres, reached through the Supabase session pooler. Capacity is
  single-digit, as a trial class is.
- Timestamps are stored and returned in UTC.

## What I deliberately cut

Each of these was a decision, not an oversight.

| Cut                                       | Why                                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication and authorisation          | The exercise is about booking correctness. In production the roster would sit behind teacher/admin authorisation and bookings would derive the parent from the session, not the body |
| Voiding a `seat_unavailable` charge       | There is no payment provider to void against. The status exists precisely so the obligation is queryable; issuing the refund belongs to the integration that does not exist here     |
| `lock_timeout` on the payment transaction | Costs liveness, never correctness. Worth adding the moment there is a real gateway call anywhere near the lock                                                                       |
| Expiring aged `pending_payment` bookings  | Needs a background job and a timeout nobody can pick correctly yet. They hold no seat, so nothing overbooks; they only block that student from rebooking                             |
| Pagination on the list endpoints          | Three classes and ten students. Adding it now would be shape without a reason                                                                                                        |
| `ON DELETE` behaviour on the foreign keys | All `NO ACTION`. Nothing in this slice deletes a class or a student                                                                                                                  |
| A polished frontend                       | The spec says it is not required, and every minute spent there is a minute not spent on the invariants that are graded                                                               |
| HTTP-level tests                          | Tests import the service directly, which is why that boundary exists. The route handlers are thin enough that curl covers them                                                       |

## Next steps

In the order I would actually do them:

1. **Move the charge out of the transaction.** Charge first, then hold the lock
   only around the recount and the confirm. This is the one change the current
   design is waiting on, and the reconciliation path for a crash between the two
   is the larger half of the work.
2. **A void job for `seat_unavailable`.** Every row is money owed back. It needs
   the provider integration from step 1.
3. **Authentication**, so `parent_id` comes from a session and the roster is not
   open.
4. **Expiry for aged `pending_payment` bookings**, once there is data on how long
   a real checkout takes.
5. **`lock_timeout` plus the monitoring below**, so a slow payer degrades
   visibly instead of silently.

## Time spent

Around 3 hours.

## Video walkthrough

TBD

<!-- TODO: paste the unlisted recording link here before submitting. -->
