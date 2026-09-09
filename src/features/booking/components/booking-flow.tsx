"use client";

import { useCallback, useEffect, useState } from "react";

import type { BookingStatus } from "@/db/schema";
import type { BookingErrorCode } from "@/features/booking/errors";
import type { listClasses, listStudents } from "@/features/booking/queries";
import type { createBooking } from "@/features/booking/service";

// Response shapes are derived from what the route handlers return, so the UI
// cannot drift from the JSON it parses. These are type-only imports: no server
// module reaches the client bundle.
type Student = Awaited<ReturnType<typeof listStudents>>[number];
type TrialClass = Awaited<ReturnType<typeof listClasses>>[number];
type Booking = Awaited<ReturnType<typeof createBooking>>;

type ErrorBody = {
  error: {
    code: BookingErrorCode | "INVALID_REQUEST";
    message: string;
    booking_status?: BookingStatus;
  };
};

// The code is the contract and the message is not, so the UI branches on the
// code and falls back to the server wording only for codes it has nothing
// better to say about. The same code means different things per endpoint.
const bookingErrors: Partial<Record<ErrorBody["error"]["code"], string>> = {
  DUPLICATE_BOOKING:
    "This student already has a booking for this class. Pay for that one, or pick another class.",
  CLASS_FULL: "This class is full. Every seat is already confirmed.",
};

const paymentErrors: Partial<Record<ErrorBody["error"]["code"], string>> = {
  PAYMENT_FAILED:
    "The card was declined. No seat was taken, so this class can be booked again.",
  CLASS_FULL:
    "The charge went through, but the last seat was taken first. This booking owes a refund.",
  BOOKING_NOT_PENDING: "This booking is no longer awaiting payment.",
};

export function BookingFlow() {
  const [students, setStudents] = useState<Student[]>([]);
  const [classes, setClasses] = useState<TrialClass[]>([]);
  const [studentId, setStudentId] = useState("");
  const [trialClassId, setTrialClassId] = useState("");
  const [booking, setBooking] = useState<Booking | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadClasses = useCallback(async () => {
    const response = await fetch("/api/classes");
    const body: { classes: TrialClass[] } = await response.json();

    setClasses(body.classes);
  }, []);

  useEffect(() => {
    const loadStudents = async () => {
      const response = await fetch("/api/students");
      const body: { students: Student[] } = await response.json();

      setStudents(body.students);
    };

    void Promise.all([loadStudents(), loadClasses()]).catch(() => {
      setMessage(
        "Could not load students and classes. Is the database migrated and seeded?",
      );
    });
  }, [loadClasses]);

  async function submitBooking(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          student_id: studentId,
          trial_class_id: trialClassId,
        }),
      });

      if (response.ok) {
        const body: { booking: Booking } = await response.json();

        setBooking(body.booking);
        return;
      }

      const body: ErrorBody = await response.json();

      setBooking(null);
      setMessage(bookingErrors[body.error.code] ?? body.error.message);
    } finally {
      setBusy(false);
    }
  }

  async function pay(succeed: boolean) {
    if (!booking) {
      return;
    }

    setBusy(true);
    setMessage(null);

    try {
      const response = await fetch(`/api/bookings/${booking.id}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ succeed }),
      });

      if (response.ok) {
        const body: { booking: Booking } = await response.json();

        setBooking(body.booking);
      } else {
        const body: ErrorBody = await response.json();
        const status = body.error.booking_status;

        setMessage(paymentErrors[body.error.code] ?? body.error.message);

        // The endpoint reports where the booking landed, so a failed payment
        // needs no re-read to show the new status.
        if (status) {
          setBooking({ ...booking, status });
        }
      }

      // Only a settled payment changes the confirmed count.
      await loadClasses();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={submitBooking} className="flex flex-col gap-4 border p-4">
        <label className="flex flex-col gap-1">
          <span className="font-medium">Student</span>
          <select
            required
            value={studentId}
            onChange={(event) => setStudentId(event.target.value)}
            className="border p-2"
          >
            <option value="">Select a student</option>
            {students.map((student) => (
              <option key={student.id} value={student.id}>
                {student.name} — {student.parent.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-medium">Trial class</span>
          <select
            required
            value={trialClassId}
            onChange={(event) => setTrialClassId(event.target.value)}
            className="border p-2"
          >
            <option value="">Select a class</option>
            {classes.map((trialClass) => (
              <option key={trialClass.id} value={trialClass.id}>
                {trialClass.subject} —{" "}
                {new Date(trialClass.starts_at).toLocaleString()} —{" "}
                {trialClass.seats_remaining} of {trialClass.capacity} seats left
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          disabled={busy}
          className="border p-2 font-medium"
        >
          Create booking
        </button>
      </form>

      {message !== null && <p className="text-red-700">{message}</p>}

      {booking !== null && (
        <section className="flex flex-col gap-4 border p-4">
          <h2 className="font-medium">Booking</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt>Status</dt>
            <dd className="font-mono">{booking.status}</dd>
            <dt>Booking id</dt>
            <dd className="font-mono">{booking.id}</dd>
            <dt>Confirmed at</dt>
            <dd className="font-mono">{booking.confirmed_at ?? "—"}</dd>
          </dl>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => pay(true)}
              disabled={busy || booking.status !== "pending_payment"}
              className="border p-2"
            >
              Pay — charge succeeds
            </button>
            <button
              type="button"
              onClick={() => pay(false)}
              disabled={busy || booking.status !== "pending_payment"}
              className="border p-2"
            >
              Pay — charge declines
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
