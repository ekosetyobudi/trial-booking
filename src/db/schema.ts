import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// payment_failed and seat_unavailable are distinct because only the second
// leaves a successful charge that has to be voided. cancelled is reserved.
export const bookingStatus = pgEnum("booking_status", [
  "pending_payment",
  "confirmed",
  "payment_failed",
  "seat_unavailable",
  "cancelled",
]);

export type BookingStatus = (typeof bookingStatus.enumValues)[number];

export const parents = pgTable("parents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // A parent is identified by their email, so two rows sharing one are the same
  // person recorded twice, and every booking under the duplicate is misfiled.
  email: text("email").notNull().unique(),
});

export const students = pgTable("students", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentId: uuid("parent_id")
    .notNull()
    .references(() => parents.id),
  name: text("name").notNull(),
});

export const trialClasses = pgTable(
  "trial_classes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subject: text("subject").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    capacity: integer("capacity").notNull().default(4),
  },
  // A class with no seats is not a class. Capacity is the only input to every
  // seat check, so a zero or negative value would make CLASS_FULL permanent.
  (t) => [check("capacity_positive", sql`${t.capacity} > 0`)],
);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id),
    trialClassId: uuid("trial_class_id")
      .notNull()
      .references(() => trialClasses.id),
    status: bookingStatus("status").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    statusReason: text("status_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Covers pending_payment as well as confirmed, so repeated submissions
    // cannot pile up live bookings. Terminal statuses fall out of the index,
    // which is what lets a declined parent retry.
    uniqueIndex("bookings_one_live_per_student_class")
      .on(t.studentId, t.trialClassId)
      .where(sql`${t.status} in ('pending_payment', 'confirmed')`),
    // Seat availability is always counted from bookings, never a counter column.
    index("bookings_class_status").on(t.trialClassId, t.status),
    check(
      "confirmed_at_consistent",
      sql`(${t.status} = 'confirmed') = (${t.confirmedAt} is not null)`,
    ),
  ],
);

export const paymentAttempts = pgTable("payment_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingId: uuid("booking_id")
    .notNull()
    .references(() => bookings.id),
  succeeded: boolean("succeeded").notNull(),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
