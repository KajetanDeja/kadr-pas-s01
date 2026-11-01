import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Kino KADR — repertuar i rezerwacja biletów",
  description:
    "Wybierz seans, zarezerwuj fotel i odbierz swój bilet. Kino KADR — projekt PAS S01.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pl">
      <body>{children}</body>
    </html>
  );
}
