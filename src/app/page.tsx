import { BookingFlow } from '@/features/booking/components/booking-flow';

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Trial booking</h1>
        <p>
          Pick a student and a trial class, create the booking, then settle it with a mock payment.
        </p>
      </header>
      <BookingFlow />
    </main>
  );
}
