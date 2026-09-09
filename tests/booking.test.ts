import { randomUUID } from "node:crypto";

import { and, count, eq, inArray, sql } from "drizzle-orm";
import { afterEach, expect, test } from "vitest";

import { db } from "@/db/client";
import {
  bookings,
  parents,
  paymentAttempts,
  students,
  trialClasses,
} from "@/db/schema";
import { BookingError } from "@/features/booking/errors";
import { findClassRoster } from "@/features/booking/queries";
import { createBooking, payBooking } from "@/features/booking/service";

// Every test builds its own parent, student and class. Seeded rows exist for
// the demo and are mutated by hand, so a test that read them would pass or fail
// depending on what ran before it.
const createdParentIds: string[] = [];
const createdClassIds: string[] = [];

afterEach(async () => {
  const parentIds = createdParentIds.splice(0);
  const classIds = createdClassIds.splice(0);

  if (classIds.length > 0) {
    const rows = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(inArray(bookings.trialClassId, classIds));
    const bookingIds = rows.map((row) => row.id);

    if (bookingIds.length > 0) {
      await db
        .delete(paymentAttempts)
        .where(inArray(paymentAttempts.bookingId, bookingIds));
      await db.delete(bookings).where(inArray(bookings.id, bookingIds));
    }
  }

  if (parentIds.length > 0) {
    await db.delete(students).where(inArray(students.parentId, parentIds));
  }

  if (classIds.length > 0) {
    await db.delete(trialClasses).where(inArray(trialClasses.id, classIds));
  }

  if (parentIds.length > 0) {
    await db.delete(parents).where(inArray(parents.id, parentIds));
  }
});

async function buildScenario(
  label: string,
  studentCount: number,
  capacity: number,
) {
  const [parent] = await db
    .insert(parents)
    .values({ name: `${label} Parent`, email: `${label}@test.invalid` })
    .returning();
  createdParentIds.push(parent.id);

  const studentRows = await db
    .insert(students)
    .values(
      Array.from({ length: studentCount }, (_, index) => ({
        parentId: parent.id,
        name: `${label} Student ${index + 1}`,
      })),
    )
    .returning();

  const [trialClass] = await db
    .insert(trialClasses)
    .values({ subject: `${label} Class`, startsAt: new Date(), capacity })
    .returning();
  createdClassIds.push(trialClass.id);

  return { students: studentRows, trialClass };
}

// Turns a rejection into a value so a test can assert on the outcome of several
// calls that ran at once, instead of only on whichever rejected first.
function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );
}

async function countConfirmed(trialClassId: string) {
  const [row] = await db
    .select({ confirmed: count() })
    .from(bookings)
    .where(
      and(
        eq(bookings.trialClassId, trialClassId),
        eq(bookings.status, "confirmed"),
      ),
    );

  return row.confirmed;
}

// postgres.js opens pool connections lazily, and the TLS handshake to a remote
// database costs more than a whole payment transaction. Without this, the second
// racer is still connecting while the first commits, and no race occurs.
async function openConnections(howMany: number) {
  await Promise.all(
    Array.from({ length: howMany }, () => db.execute(sql`select 1`)),
  );
}

async function readStatus(bookingId: string) {
  const [row] = await db
    .select({ status: bookings.status })
    .from(bookings)
    .where(eq(bookings.id, bookingId));

  return row.status;
}

test("a paid booking is confirmed and appears in the roster", async () => {
  const {
    students: [student],
    trialClass,
  } = await buildScenario("Happy", 1, 4);

  const created = await createBooking({
    student_id: student.id,
    trial_class_id: trialClass.id,
  });
  expect(created.status).toBe("pending_payment");
  expect(created.confirmed_at).toBeNull();

  const paid = await payBooking(created.id, { succeed: true });
  expect(paid.status).toBe("confirmed");
  expect(paid.confirmed_at).not.toBeNull();

  const roster = await findClassRoster(trialClass.id);
  expect(roster).toEqual({
    class_id: trialClass.id,
    bookings: [
      {
        id: created.id,
        student: { id: student.id, name: student.name },
        confirmed_at: paid.confirmed_at,
      },
    ],
  });
});

test("a second live booking for the same student and class is rejected", async () => {
  const {
    students: [student],
    trialClass,
  } = await buildScenario("Duplicate", 1, 4);

  const first = await createBooking({
    student_id: student.id,
    trial_class_id: trialClass.id,
  });

  expect(first.status).toBe("pending_payment");

  const duplicate = await createBooking({
    student_id: student.id,
    trial_class_id: trialClass.id,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(duplicate).toBeInstanceOf(BookingError);
  expect(duplicate).toMatchObject({ code: "DUPLICATE_BOOKING" });
});

test("a booking is rejected once the class has no free seat", async () => {
  const {
    students: [seated, latecomer],
    trialClass,
  } = await buildScenario("Overbooking", 2, 1);

  const filling = await createBooking({
    student_id: seated.id,
    trial_class_id: trialClass.id,
  });
  await payBooking(filling.id, { succeed: true });

  const rejected = await createBooking({
    student_id: latecomer.id,
    trial_class_id: trialClass.id,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(rejected).toBeInstanceOf(BookingError);
  expect(rejected).toMatchObject({ code: "CLASS_FULL" });
  expect(await countConfirmed(trialClass.id)).toBe(1);
});

test("a declined payment leaves the roster untouched", async () => {
  const {
    students: [seated, declined],
    trialClass,
  } = await buildScenario("Decline", 2, 4);

  const confirmed = await createBooking({
    student_id: seated.id,
    trial_class_id: trialClass.id,
  });
  await payBooking(confirmed.id, { succeed: true });

  const rosterBefore = await findClassRoster(trialClass.id);

  const failing = await createBooking({
    student_id: declined.id,
    trial_class_id: trialClass.id,
  });

  const outcome = await settle(payBooking(failing.id, { succeed: false }));

  expect(outcome.error).toBeInstanceOf(BookingError);
  expect(outcome.error).toMatchObject({
    code: "PAYMENT_FAILED",
    status: "payment_failed",
  });
  expect(await readStatus(failing.id)).toBe("payment_failed");
  expect(await findClassRoster(trialClass.id)).toEqual(rosterBefore);

  const [attempt] = await db
    .select({ succeeded: paymentAttempts.succeeded })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.bookingId, failing.id));
  expect(attempt.succeeded).toBe(false);
});

test("two payments racing for the last seat produce one confirmed booking", async () => {
  const { students, trialClass } = await buildScenario("Race", 5, 4);
  const [first, second, third, ...contenders] = students;

  for (const student of [first, second, third]) {
    const booking = await createBooking({
      student_id: student.id,
      trial_class_id: trialClass.id,
    });
    await payBooking(booking.id, { succeed: true });
  }

  expect(await countConfirmed(trialClass.id)).toBe(3);

  const pending = [];
  for (const student of contenders) {
    pending.push(
      await createBooking({
        student_id: student.id,
        trial_class_id: trialClass.id,
      }),
    );
  }
  expect(pending.map((booking) => booking.status)).toEqual([
    "pending_payment",
    "pending_payment",
  ]);

  await openConnections(pending.length);

  // Both calls are started before either is awaited. Awaiting them in sequence
  // would serialise the transactions and the test would pass without any lock.
  const outcomes = await Promise.all(
    pending.map((booking) => settle(payBooking(booking.id, { succeed: true }))),
  );

  const winners = outcomes.filter(
    (outcome) => outcome.value?.status === "confirmed",
  );
  const losers = outcomes.filter(
    (outcome) =>
      outcome.error instanceof BookingError &&
      outcome.error.code === "CLASS_FULL",
  );

  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0].error).toMatchObject({ status: "seat_unavailable" });

  const statuses = await Promise.all(
    pending.map((booking) => readStatus(booking.id)),
  );
  expect(statuses.filter((status) => status === "confirmed")).toHaveLength(1);
  expect(
    statuses.filter((status) => status === "seat_unavailable"),
  ).toHaveLength(1);

  expect(await countConfirmed(trialClass.id)).toBe(4);
});

test("two payments racing for the same booking confirm it once", async () => {
  const {
    students: [student],
    trialClass,
  } = await buildScenario("DoublePay", 1, 4);

  const booking = await createBooking({
    student_id: student.id,
    trial_class_id: trialClass.id,
  });

  await openConnections(2);

  // The class row is the mutex for this race too. Both payers hold the same
  // booking, so the loser reads its status only after the winner has committed
  // rather than from before the lock was taken.
  const outcomes = await Promise.all([
    settle(payBooking(booking.id, { succeed: true })),
    settle(payBooking(booking.id, { succeed: true })),
  ]);

  const winners = outcomes.filter(
    (outcome) => outcome.value?.status === "confirmed",
  );
  const losers = outcomes.filter(
    (outcome) =>
      outcome.error instanceof BookingError &&
      outcome.error.code === "BOOKING_NOT_PENDING",
  );

  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0].error).toMatchObject({ status: "confirmed" });

  expect(await readStatus(booking.id)).toBe("confirmed");
  expect(await countConfirmed(trialClass.id)).toBe(1);

  // One charge, not two. The status guard runs before payment_attempts is
  // written, so the loser is rejected without any money being recorded.
  const attempts = await db
    .select({ id: paymentAttempts.id })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.bookingId, booking.id));
  expect(attempts).toHaveLength(1);
});

test("a booking that already settled cannot be paid again", async () => {
  const {
    students: [student],
    trialClass,
  } = await buildScenario("Settled", 1, 4);

  const booking = await createBooking({
    student_id: student.id,
    trial_class_id: trialClass.id,
  });
  await settle(payBooking(booking.id, { succeed: false }));
  expect(await readStatus(booking.id)).toBe("payment_failed");

  const retried = await settle(payBooking(booking.id, { succeed: true }));

  expect(retried.error).toBeInstanceOf(BookingError);
  expect(retried.error).toMatchObject({
    code: "BOOKING_NOT_PENDING",
    status: "payment_failed",
  });

  // A terminal booking is not resurrected by a second attempt, and the declined
  // charge stays the only one on record.
  expect(await readStatus(booking.id)).toBe("payment_failed");
  expect(await countConfirmed(trialClass.id)).toBe(0);

  const attempts = await db
    .select({ succeeded: paymentAttempts.succeeded })
    .from(paymentAttempts)
    .where(eq(paymentAttempts.bookingId, booking.id));
  expect(attempts).toEqual([{ succeeded: false }]);
});

test("paying a booking that does not exist is rejected", async () => {
  const outcome = await settle(payBooking(randomUUID(), { succeed: true }));

  expect(outcome.error).toBeInstanceOf(BookingError);
  expect(outcome.error).toMatchObject({ code: "BOOKING_NOT_FOUND" });
});
