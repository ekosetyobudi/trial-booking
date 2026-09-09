import { BookingError, errorStatus } from "@/features/booking/errors";
import { createBookingInput } from "@/features/booking/schema";
import { createBooking } from "@/features/booking/service";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const input = createBookingInput.safeParse(body);

  if (!input.success) {
    return Response.json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "Body must contain student_id and trial_class_id as UUIDs.",
        },
      },
      { status: 400 },
    );
  }

  try {
    return Response.json(
      { booking: await createBooking(input.data) },
      { status: 201 },
    );
  } catch (error) {
    // Anything that is not a domain error stays unmapped and surfaces as a 500,
    // so a raw Postgres error never reaches the client.
    if (!(error instanceof BookingError)) {
      throw error;
    }

    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: errorStatus[error.code] },
    );
  }
}
