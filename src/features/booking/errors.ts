import type { BookingStatus } from '@/db/schema';

export type BookingErrorCode =
  | 'STUDENT_NOT_FOUND'
  | 'CLASS_NOT_FOUND'
  | 'BOOKING_NOT_FOUND'
  | 'PAYMENT_FAILED'
  | 'DUPLICATE_BOOKING'
  | 'CLASS_FULL'
  | 'BOOKING_NOT_PENDING';

export const errorStatus: Record<BookingErrorCode, number> = {
  STUDENT_NOT_FOUND: 404,
  CLASS_NOT_FOUND: 404,
  BOOKING_NOT_FOUND: 404,
  PAYMENT_FAILED: 402,
  DUPLICATE_BOOKING: 409,
  CLASS_FULL: 409,
  BOOKING_NOT_PENDING: 409,
};

// The message stays a constructor argument because the same code carries
// different wording per endpoint, while the code itself is the contract.
export class BookingError extends Error {
  readonly code: BookingErrorCode;
  // Where the booking landed, so a caller never has to re-read to find out.
  // Left unset by the codes that resolve before any booking has a new status.
  readonly status?: BookingStatus;

  constructor(code: BookingErrorCode, message: string, status?: BookingStatus) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
    this.status = status;
  }
}
