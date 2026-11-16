export interface CinemaEvent {
  id: string; title: string; tagline: string; genre: string; duration: number;
  ageRating: string; startsAt: string; hall: string; artwork: string; price: number;
}
export interface ReservationView {
  reservationId: string; event: CinemaEvent; seatId: string; expiresAt: string;
  status: "held" | "expired" | "paid"; amount: number; code?: string; serverNow: string;
  refundStatus?: "pending" | "refunded" | "failed";
}
