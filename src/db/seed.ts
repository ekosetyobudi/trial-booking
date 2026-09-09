import { sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { bookings, parents, students, trialClasses } from '@/db/schema';

const NAMES = [
  'Aaron Tan',
  'Bella Lim',
  'Caleb Ng',
  'Dania Rahman',
  'Ethan Chua',
  'Faith Wong',
  'Gavin Koh',
  'Hana Ismail',
  'Isaac Goh',
  'Jia Ying Toh',
  'Kiran Menon',
  'Lena Sim',
];

const hoursFromNow = (hours: number) =>
  new Date(Date.now() + hours * 60 * 60 * 1000);

async function seed() {
  await db.execute(
    sql`truncate table payment_attempts, bookings, students, trial_classes, parents cascade`,
  );

  const parentRows = await db
    .insert(parents)
    .values(
      ['Tan Wei Ming', 'Lim Hui Ling', 'Ng Kok Leong', 'Chua Siew Mei'].map(
        (name, i) => ({ name, email: `parent${i + 1}@example.com` }),
      ),
    )
    .returning();

  let studentSeq = 0;
  const createStudents = (count: number) =>
    db
      .insert(students)
      .values(
        Array.from({ length: count }, () => {
          const i = studentSeq++;
          return {
            parentId: parentRows[i % parentRows.length]!.id,
            name: NAMES[i % NAMES.length]!,
          };
        }),
      )
      .returning();

  const confirm = (studentRows: { id: string }[], trialClassId: string) =>
    db.insert(bookings).values(
      studentRows.map((student) => ({
        studentId: student.id,
        trialClassId,
        status: 'confirmed' as const,
        confirmedAt: new Date(),
      })),
    );

  // capacity is left to the column default so the seed never restates it.
  const [openSeats, oneSeatLeft, full] = await db
    .insert(trialClasses)
    .values([
      { subject: 'Primary 4 Mathematics', startsAt: hoursFromNow(24) },
      { subject: 'Primary 5 Science', startsAt: hoursFromNow(48) },
      { subject: 'Primary 3 English', startsAt: hoursFromNow(72) },
    ])
    .returning();

  if (!openSeats || !oneSeatLeft || !full) {
    throw new Error('seed: trial class insert returned fewer rows than expected');
  }

  // The already-confirmed student sits in a class that still has seats, so the
  // duplicate path is reached before any capacity check.
  await confirm(await createStudents(1), openSeats.id);

  // One seat short of capacity: the race test creates two competing pending
  // bookings here, which is why the next two students are left unbooked.
  await confirm(await createStudents(oneSeatLeft.capacity - 1), oneSeatLeft.id);

  await confirm(await createStudents(full.capacity), full.id);

  await createStudents(2);

  const summary = await db.execute<{
    subject: string;
    capacity: number;
    confirmed: number;
  }>(sql`
    select
      ${trialClasses.subject} as subject,
      ${trialClasses.capacity} as capacity,
      count(${bookings.id}) filter (where ${bookings.status} = 'confirmed')::int as confirmed
    from ${trialClasses}
    left join ${bookings} on ${bookings.trialClassId} = ${trialClasses.id}
    group by ${trialClasses.id}
    order by ${trialClasses.startsAt}
  `);

  console.table([...summary]);
}

await seed();
await db.$client.end();
