import { listStudents } from '@/features/booking/queries';

export async function GET() {
  return Response.json({ students: await listStudents() });
}
