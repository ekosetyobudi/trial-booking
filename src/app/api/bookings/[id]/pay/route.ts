import { z } from 'zod';

import { BookingError, errorStatus } from '@/features/booking/errors';
import { payBookingInput } from '@/features/booking/schema';
import { payBooking } from '@/features/booking/service';

const routeParams = z.object({ id: z.uuid() });

export async function POST(
  request: Request,
  context: RouteContext<'/api/bookings/[id]/pay'>,
) {
  const params = routeParams.safeParse(await context.params);
  const input = payBookingInput.safeParse(await request.json().catch(() => null));

  if (!params.success || !input.success) {
    return Response.json(
      {
        error: {
          code: 'INVALID_REQUEST',
          message: 'Booking id must be a UUID and succeed must be a boolean.',
        },
      },
      { status: 400 },
    );
  }

  try {
    return Response.json({ booking: await payBooking(params.data.id, input.data) });
  } catch (error) {
    // Anything that is not a domain error stays unmapped and surfaces as a 500,
    // so a raw Postgres error never reaches the client.
    if (!(error instanceof BookingError)) {
      throw error;
    }

    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.status === undefined ? {} : { booking_status: error.status }),
        },
      },
      { status: errorStatus[error.code] },
    );
  }
}
