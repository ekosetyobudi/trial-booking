import { inArray } from 'drizzle-orm';
import { afterEach, expect, test } from 'vitest';

import { db } from '@/db/client';
import { bookings, parents, students, trialClasses } from '@/db/schema';
import { BookingError } from '@/features/booking/errors';
import { createBooking } from '@/features/booking/service';

// Every test builds its own parent, student and class. Seeded rows exist for
// the demo and are mutated by hand, so a test that read them would pass or fail
// depending on what ran before it.
const createdParentIds: string[] = [];
const createdClassIds: string[] = [];

afterEach(async () => {
  const parentIds = createdParentIds.splice(0);
  const classIds = createdClassIds.splice(0);

  if (classIds.length > 0) {
    await db.delete(bookings).where(inArray(bookings.trialClassId, classIds));
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

test('a second live booking for the same student and class is rejected', async () => {
  const [parent] = await db
    .insert(parents)
    .values({ name: 'Duplicate Parent', email: 'duplicate@test.invalid' })
    .returning();
  createdParentIds.push(parent.id);

  const [student] = await db
    .insert(students)
    .values({ parentId: parent.id, name: 'Duplicate Student' })
    .returning();

  const [trialClass] = await db
    .insert(trialClasses)
    .values({ subject: 'Duplicate Test Class', startsAt: new Date() })
    .returning();
  createdClassIds.push(trialClass.id);

  const first = await createBooking({
    student_id: student.id,
    trial_class_id: trialClass.id,
  });

  expect(first.status).toBe('pending_payment');

  const duplicate = await createBooking({
    student_id: student.id,
    trial_class_id: trialClass.id,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(duplicate).toBeInstanceOf(BookingError);
  expect(duplicate).toMatchObject({ code: 'DUPLICATE_BOOKING' });
});
