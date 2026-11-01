"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="standalone-error"><h1>Przerwa techniczna.</h1><p>Nie udało się wyświetlić kina. Spróbuj ponownie.</p><button className="primary-button" onClick={reset}>Odśwież widok</button></main>;
}
