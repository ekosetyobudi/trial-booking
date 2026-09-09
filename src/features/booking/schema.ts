import { z } from 'zod';

export const createBookingInput = z.strictObject({
  student_id: z.uuid(),
  trial_class_id: z.uuid(),
});

export type CreateBookingInput = z.infer<typeof createBookingInput>;

export const payBookingInput = z.strictObject({
  succeed: z.boolean(),
});

export type PayBookingInput = z.infer<typeof payBookingInput>;
