import { notFound } from "next/navigation";
import { Cinema } from "@/components/cinema";
import { reservationId } from "@/server/validation";
export const dynamic = "force-dynamic";
export default async function PaymentReturn({ params }: { params: Promise<{ id: string; result: string }> }) {
  const { id, result } = await params;
  if (!reservationId.safeParse(id).success || !["sukces", "anulowano"].includes(result)) notFound();
  return <Cinema initialReservationId={id} returnMode={result === "sukces" ? "success" : "cancel"} />;
}
