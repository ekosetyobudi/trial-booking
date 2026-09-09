import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, parents, students, trialClasses } from "@/db/schema";

export async function listStudents() {
  return db
    .select({
      id: students.id,
      name: students.name,
      parent: {
        id: parents.id,
        name: parents.name,
        email: parents.email,
      },
    })
    .from(students)
    .innerJoin(parents, eq(parents.id, students.parentId))
    .orderBy(asc(students.name), asc(students.id));
}

export async function listClasses() {
  const rows = await db
    .select({
      id: trialClasses.id,
      subject: trialClasses.subject,
      startsAt: trialClasses.startsAt,
      capacity: trialClasses.capacity,
      confirmedCount: sql<number>`count(${bookings.id}) filter (where ${bookings.status} = 'confirmed')::int`,
    })
    .from(trialClasses)
    .leftJoin(bookings, eq(bookings.trialClassId, trialClasses.id))
    .groupBy(trialClasses.id)
    .orderBy(asc(trialClasses.startsAt), asc(trialClasses.id));

  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    starts_at: row.startsAt.toISOString(),
    capacity: row.capacity,
    confirmed_count: row.confirmedCount,
    // Capacity can be lowered after seats are taken, so an over-subscribed
    // class reports 0 rather than a negative number of seats.
    seats_remaining: Math.max(row.capacity - row.confirmedCount, 0),
  }));
}

// Returns null only when the class does not exist, so the route can tell a
// missing class apart from a real class whose roster is empty.
export async function findClassRoster(trialClassId: string) {
  const [trialClass] = await db
    .select({ id: trialClasses.id })
    .from(trialClasses)
    .where(eq(trialClasses.id, trialClassId));

  if (!trialClass) {
    return null;
  }

  const rows = await db
    .select({
      id: bookings.id,
      confirmedAt: bookings.confirmedAt,
      student: {
        id: students.id,
        name: students.name,
      },
    })
    .from(bookings)
    .innerJoin(students, eq(students.id, bookings.studentId))
    .where(
      and(
        eq(bookings.trialClassId, trialClassId),
        eq(bookings.status, "confirmed"),
      ),
    )
    .orderBy(asc(bookings.confirmedAt), asc(bookings.id));

  return {
    class_id: trialClass.id,
    // The confirmed_at_consistent check constraint pairs a timestamp with every
    // confirmed booking, so the discarded branch is unreachable and the roster
    // can promise confirmed_at on every entry.
    bookings: rows.flatMap((row) =>
      row.confirmedAt === null
        ? []
        : [
            {
              id: row.id,
              student: row.student,
              confirmed_at: row.confirmedAt.toISOString(),
            },
          ],
    ),
  };
}
