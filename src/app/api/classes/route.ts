import { listClasses } from '@/features/booking/queries';

export async function GET() {
  return Response.json({ classes: await listClasses() });
}
