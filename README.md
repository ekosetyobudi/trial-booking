# Trial Booking

Trial class booking for a tuition centre: a parent picks a student and a trial class,
creates a booking, and pays for it. Capacity and duplicate rules are enforced in
Postgres, so they hold across concurrent requests and multiple app instances.

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
so the open, one-seat-left, and full cases are all reachable without setup.

## API

Base URL `http://localhost:3000`. Every endpoint accepts and returns JSON only.

**Conventions**

- Field names are `snake_case`. Timestamps are ISO 8601 in UTC (`2026-09-10T07:17:26.614Z`).
- Every successful response is a JSON object. Arrays are always nested under a
  plural key, never returned at the top level.
- Reads are never cached. Every response reflects committed state at request time.
- Seat availability is always derived from `bookings`; there is no counter column.

**Error envelope**

Every non-2xx response has this shape and no other:

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

| Status | Code               | When                                |
| ------ | ------------------ | ----------------------------------- |
| 400    | `INVALID_REQUEST`  | `id` is not a UUID                  |
| 404    | `CLASS_NOT_FOUND`  | `id` is a UUID with no matching row |

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

| Status | Code                 | When                                                                 |
| ------ | -------------------- | -------------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`    | Body is not JSON, a field is missing, or a UUID is malformed          |
| 404    | `STUDENT_NOT_FOUND`  | `student_id` has no matching row                                      |
| 404    | `CLASS_NOT_FOUND`    | `trial_class_id` has no matching row                                  |
| 409    | `DUPLICATE_BOOKING`  | This student already has a **live** booking for this class            |
| 409    | `CLASS_FULL`         | The class already has `capacity` **confirmed** bookings               |

**A seat is not reserved at this step.** Two parents may both hold a
`pending_payment` booking for the same last seat; the race is settled at payment,
not at booking. This is why `CLASS_FULL` here counts confirmed bookings only.

**Live** means `pending_payment` or `confirmed`. A student whose earlier booking
ended in `payment_failed`, `seat_unavailable`, or `cancelled` may book the same
class again — that is a retry, not a duplicate.

`DUPLICATE_BOOKING` does not return the id of the existing booking.

---

### POST /api/bookings/[id]/pay

Settles a `pending_payment` booking. Payment is a deterministic mock: the caller
states the outcome, and it is never random. Every attempt is recorded, whether it
succeeds or fails.

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

| Status | Code                  | `booking_status` | When                                                |
| ------ | --------------------- | ---------------- | --------------------------------------------------- |
| 400    | `INVALID_REQUEST`     | absent           | `id` is not a UUID, or `succeed` is missing/not a boolean |
| 402    | `PAYMENT_FAILED`      | `payment_failed` | Called with `succeed: false`                        |
| 404    | `BOOKING_NOT_FOUND`   | absent           | `id` is a UUID with no matching row                 |
| 409    | `BOOKING_NOT_PENDING` | current status   | The booking is not in `pending_payment`             |
| 409    | `CLASS_FULL`          | `seat_unavailable` | Charge succeeded, but the class filled up first   |

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

| Status            | Meaning                                                          | Holds a seat |
| ----------------- | ---------------------------------------------------------------- | ------------ |
| `pending_payment` | Booking created, not yet paid                                     | No           |
| `confirmed`       | Paid and seated. `confirmed_at` is set                            | Yes          |
| `payment_failed`  | Charge declined. No money moved                                   | No           |
| `seat_unavailable`| Charge succeeded but the seat was gone. The charge must be voided | No           |
| `cancelled`       | Reserved. No endpoint writes this status                          | No           |

`pending_payment` and `confirmed` are *live*: a student may hold at most one live
booking per class. The other three are terminal and do not block a retry.

### Error codes

| Code                  | HTTP | Endpoints                                    |
| --------------------- | ---- | -------------------------------------------- |
| `INVALID_REQUEST`     | 400  | any                                          |
| `PAYMENT_FAILED`      | 402  | `POST /api/bookings/[id]/pay`                |
| `STUDENT_NOT_FOUND`   | 404  | `POST /api/bookings`                         |
| `CLASS_NOT_FOUND`     | 404  | `GET /api/classes/[id]/roster`, `POST /api/bookings` |
| `BOOKING_NOT_FOUND`   | 404  | `POST /api/bookings/[id]/pay`                |
| `DUPLICATE_BOOKING`   | 409  | `POST /api/bookings`                         |
| `CLASS_FULL`          | 409  | `POST /api/bookings`, `POST /api/bookings/[id]/pay` |
| `BOOKING_NOT_PENDING` | 409  | `POST /api/bookings/[id]/pay`                |

A raw Postgres error is never surfaced. Any unmapped failure is a `500` with no
error envelope.
