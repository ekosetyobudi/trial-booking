import { z } from 'zod';

export const createBookingInput = z.strictObject({
  student_id: z.uuid(),
  trial_class_id: z.uuid(),
});

export type CreateBookingInput = z.infer<typeof createBookingInput>;
