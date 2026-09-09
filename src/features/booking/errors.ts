export type BookingErrorCode =
  | 'STUDENT_NOT_FOUND'
  | 'CLASS_NOT_FOUND'
  | 'DUPLICATE_BOOKING'
  | 'CLASS_FULL';

// The message stays a constructor argument because the same code carries
// different wording per endpoint, while the code itself is the contract.
export class BookingError extends Error {
  readonly code: BookingErrorCode;

  constructor(code: BookingErrorCode, message: string) {
    super(message);
    this.name = 'BookingError';
    this.code = code;
  }
}
