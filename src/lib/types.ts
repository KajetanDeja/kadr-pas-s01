export interface CinemaEvent {
  id: string; title: string; tagline: string; genre: string; duration: number;
  ageRating: string; startsAt: string; hall: string; artwork: string;
}
export interface ReservationView {
  reservationId: string; event: CinemaEvent; seatId: string; expiresAt: string;
  status: "active" | "expired" | "purchased"; code: string | null; serverNow: string;
}
