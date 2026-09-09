import { z } from 'zod';

import { findClassRoster } from '@/features/booking/queries';

const routeParams = z.object({ id: z.uuid() });

export async function GET(
  _request: Request,
  context: RouteContext<'/api/classes/[id]/roster'>,
) {
  const params = routeParams.safeParse(await context.params);

  if (!params.success) {
    return Response.json(
      { error: { code: 'INVALID_REQUEST', message: 'Class id must be a UUID.' } },
      { status: 400 },
    );
  }

  const roster = await findClassRoster(params.data.id);

  if (!roster) {
    return Response.json(
      { error: { code: 'CLASS_NOT_FOUND', message: 'No trial class with that id.' } },
      { status: 404 },
    );
  }

  return Response.json(roster);
}
