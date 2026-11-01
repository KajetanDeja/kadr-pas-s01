"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { CinemaEvent, ReservationView } from "@/lib/types";
import { api, RequestError } from "@/lib/client-api";
import { FilmArt } from "./film-art";

const storageKey = "kadr.reservationId";
const rows = Array.from("ABCDEFGH");
const time = (value: string) => new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Warsaw" }).format(new Date(value));
const day = (value: string) => new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Warsaw" }).format(new Date(value));
const message = (e: unknown) => e instanceof Error ? e.message : "Coś poszło nie tak. Spróbuj ponownie.";
function remember(id: string | null) { try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey); } catch { /* Rezerwacja działa także bez dostępu do storage. */ } }

export function Cinema() {
  const [events, setEvents] = useState<CinemaEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<CinemaEvent | null>(null);
  const [taken, setTaken] = useState<string[]>([]);
  const [selectedSeat, setSelectedSeat] = useState<string | null>(null);
  const [reservation, setReservation] = useState<ReservationView | null>(null);
  const reservationRef = useRef(reservation); reservationRef.current = reservation;
  const [initializing, setInitializing] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mapLoading, setMapLoading] = useState(true);
  const [mapError, setMapError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    async function load() {
      setInitializing(true); setLoadFailed(false); setError("");
      try {
        const { data } = await api<CinemaEvent[]>("/api/events");
        if (!alive) return;
        setEvents(data); setSelectedEvent(data[0] ?? null);
        let id: string | null = null;
        try { id = localStorage.getItem(storageKey); } catch { /* optional storage */ }
        if (id) {
          try {
            const restored = await api<ReservationView>(`/api/reservations/${encodeURIComponent(id)}`);
            if (!alive) return;
            setReservation(restored.data); setSelectedEvent(restored.data.event); setSelectedSeat(restored.data.seatId);
          } catch (e) {
            if (e instanceof RequestError && [400, 404].includes(e.status)) remember(null);
            else throw e;
          }
        }
      } catch (e) { if (alive) { setError(message(e)); setLoadFailed(true); } }
      finally { if (alive) setInitializing(false); }
    }
    void load();
    return () => { alive = false; };
  }, [loadAttempt]);

  const refreshMap = useCallback(async (event: CinemaEvent) => {
    const { data } = await api<{ event: CinemaEvent; takenSeats: string[] }>(`/api/events/${encodeURIComponent(event.id)}`);
    return data.takenSeats;
  }, []);

  useEffect(() => {
    if (!selectedEvent) return;
    let alive = true, pending = false;
    setMapLoading(true); setTaken([]); setMapError("");
    const update = async () => {
      if (pending) return;
      pending = true;
      try {
        const seats = await refreshMap(selectedEvent);
        if (!alive) return;
        setTaken(seats); setMapError("");
        if (!reservationRef.current) setSelectedSeat((current) => {
          if (current && seats.includes(current)) { setError("Ktoś właśnie zajął wybrany fotel. Wybierz inne miejsce."); return null; }
          return current;
        });
      } catch (e) { if (alive) setMapError(message(e)); }
      finally { pending = false; if (alive) setMapLoading(false); }
    };
    void update();
    const timer = setInterval(() => void update(), 5000);
    window.addEventListener("focus", update);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("focus", update); };
  }, [selectedEvent, refreshMap]);

  useEffect(() => {
    if (!reservation || reservation.status !== "active") return;
    const until = new Date(reservation.expiresAt).getTime() - new Date(reservation.serverNow).getTime();
    const start = performance.now();
    const tick = () => setSeconds(Math.max(0, Math.ceil((until - (performance.now() - start)) / 1000)));
    tick(); const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [reservation]);

  useEffect(() => {
    if (reservation?.status !== "active") return;
    let alive = true, pending = false;
    const update = async () => {
      if (pending || inFlight.current) return;
      pending = true;
      try {
        const { data } = await api<ReservationView>(`/api/reservations/${reservation.reservationId}`);
        if (alive && !inFlight.current) {
          setReservation((current) => current?.status === "active" ? data : current);
          setError("");
        }
      } catch (e) { if (alive) setError(message(e)); }
      finally { pending = false; }
    };
    const timer = setInterval(() => void update(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [reservation?.reservationId, reservation?.status]);

  function chooseEvent(event: CinemaEvent) {
    if (reservation || busy) return;
    setSelectedEvent(event); setSelectedSeat(null); setError("");
  }
  function seatKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const offset: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -10, ArrowDown: 10 };
    if (!(event.key in offset)) return;
    event.preventDefault();
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".seat-map button"));
    let next = index + offset[event.key];
    while (next >= 0 && next < buttons.length) {
      if (!buttons[next].disabled) { buttons[next].focus(); break; }
      next += offset[event.key];
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !selectedEvent || !selectedSeat || reservation) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const { data, serverNow } = await api<{ reservationId: string; expiresAt: string }>("/api/reservations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: selectedEvent.id, seatId: selectedSeat, customerName: name, email })
      });
      remember(data.reservationId);
      setReservation({ ...data, event: selectedEvent, seatId: selectedSeat, status: "active", code: null, serverNow: serverNow! });
      setName(""); setEmail(""); setTaken((prev) => [...new Set([...prev, selectedSeat])]);
    } catch (e) {
      setError(message(e));
      if (e instanceof RequestError && e.status === 409) {
        setSelectedSeat(null);
        try { setTaken(await refreshMap(selectedEvent)); } catch { /* error already visible */ }
      }
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function buy() {
    if (inFlight.current || !reservation) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const { data } = await api<{ code: string }>(`/api/reservations/${reservation.reservationId}/purchase`, { method: "POST" });
      setReservation({ ...reservation, status: "purchased", code: data.code });
    } catch (e) {
      setError(message(e));
      if (e instanceof RequestError && e.status === 410) setReservation({ ...reservation, status: "expired" });
    } finally { inFlight.current = false; setBusy(false); }
  }
  function reset() { remember(null); setReservation(null); setSelectedSeat(null); setError(""); }
  const row = (reservation?.seatId ?? selectedSeat)?.slice(0, 1);
  const seatNumber = (reservation?.seatId ?? selectedSeat)?.slice(1);
  const purchased = reservation?.status === "purchased";

  return <div className="app-shell">
    <a href="#repertuar" className="skip-link">Przejdź do repertuaru</a>
    <header className="site-header">
      <a href="/" className="brand" aria-label="Kino KADR — strona główna">
        <span className="brand-mark" aria-hidden="true">KADR</span>
        <span className="brand-name">Kino KADR<span>Rezerwacja biletów</span></span>
      </a>
      <div className="header-date"><span>Repertuar na</span>{selectedEvent ? <time dateTime={selectedEvent.startsAt}>{day(selectedEvent.startsAt)}</time> : <span>Wczytywanie…</span>}</div>
    </header>

    <main>
      {error && <div role="alert" className="notice error-notice">{error}{loadFailed && <button onClick={() => setLoadAttempt((n) => n + 1)}>Spróbuj ponownie</button>}</div>}
      {initializing ? <div className="loading-panel" role="status">Wczytujemy repertuar i rezerwację…</div> : loadFailed || !events.length ? <div className="loading-panel">Nie udało się odczytać repertuaru lub zapisanej rezerwacji.</div> : <div className="booking-layout">
        <div className="booking-main">
          <section id="repertuar" aria-labelledby="repertuar-title">
            <div className="section-heading"><h1 id="repertuar-title">Repertuar</h1><span>{events.length} seanse</span></div>
            <p className="section-instruction">Wybierz seans, a następnie miejsce na sali.</p>
            <div className="film-grid">{events.map((event) => <button key={event.id} className={`film-card ${selectedEvent?.id === event.id ? "selected-film" : ""}`} aria-pressed={selectedEvent?.id === event.id} disabled={!!reservation || busy} onClick={() => chooseEvent(event)} aria-label={`Wybierz seans ${event.title}, ${day(event.startsAt)}, ${time(event.startsAt)}, ${event.hall}`}>
              <div className="art-container"><FilmArt kind={event.artwork} title={event.title}/></div>
              <div className="film-info">
                <h3>{event.title}</h3>
                <p className="film-genre">{event.genre} · {event.duration} min · {event.ageRating}</p>
                <time className="film-date" dateTime={event.startsAt}>{day(event.startsAt)}</time>
                <div className="showtime"><strong>{time(event.startsAt)}</strong><span>{event.hall}</span></div>
                <span className="film-selection">{selectedEvent?.id === event.id ? "✓ Wybrany seans" : "Wybierz seans"}</span>
              </div>
            </button>)}</div>
          </section>

          <section className="hall-section" aria-labelledby="hall-title">
            <div className="section-heading"><h2 id="hall-title">Wybierz miejsce</h2><span className="hall-label">{selectedEvent?.hall} · 80 foteli</span></div>
            <div className="hall-panel" aria-busy={mapLoading}>
              <div className="screen" aria-hidden="true"><div/><span>Ekran</span></div>
              {mapError && <div className="notice map-notice" role="status">{mapError} Mapa może być nieaktualna.</div>}
              <p className="map-scroll-hint" id="map-scroll-hint">Przesuń mapę w bok, aby zobaczyć pozostałe fotele.</p>
              {mapLoading ? <div className="map-loading" role="status">Sprawdzamy wolne fotele…</div> : <div className="map-scroll" role="region" aria-label={`Mapa foteli — ${selectedEvent?.hall}`} aria-describedby="map-scroll-hint" tabIndex={0}><div className="seat-map">
                {rows.map((r,ri)=><div className="seat-row" key={r}><span className="row-label" aria-hidden="true">{r}</span>{Array.from({length:10},(_,i)=>{
                  const id = `${r}${i+1}`, own = reservation?.status !== "expired" && reservation?.seatId === id;
                  const selected = selectedSeat === id && (!reservation || own), occupied = taken.includes(id) && !own;
                  return <button key={id} type="button" className={`seat ${selected ? "chosen-seat" : ""} ${occupied ? "taken-seat" : ""} ${i===4 ? "aisle-after" : ""}`} data-seat={id} aria-label={`Rząd ${r}, miejsce ${i+1}${occupied ? ", zajęte" : selected ? ", wybrane" : ", dostępne"}`} aria-pressed={selected} disabled={occupied || !!reservation || busy} onKeyDown={(e)=>seatKey(e,ri*10+i)} onClick={()=>{setSelectedSeat(id);setError("");}}><span className="seat-number">{i+1}</span>{(occupied || selected) && <span className="seat-state" aria-hidden="true">{occupied ? "×" : "✓"}</span>}</button>;
                })}<span className="row-label" aria-hidden="true">{r}</span></div>)}
              </div></div>}
              <div className="seat-legend"><span><i className="legend-seat"/> Dostępny</span><span><i className="legend-seat legend-selected">✓</i> Twój wybór</span><span><i className="legend-seat legend-taken">×</i> Zajęty</span></div>
              <p className="map-footnote">Klawiatura: Tab i strzałki do poruszania się, Enter do wyboru fotela.</p>
            </div>
          </section>
        </div>

        <aside className={`summary-panel ${purchased ? "ticket-panel" : ""}`} aria-labelledby="summary-title">
          <h2 id="summary-title">{purchased ? "Twój bilet" : "Twoja rezerwacja"}</h2>
          <div className="summary-film"><h3>{selectedEvent?.title}</h3><p>{selectedEvent && <time dateTime={selectedEvent.startsAt}>{day(selectedEvent.startsAt)}</time>}</p></div>
          <dl className="booking-details"><div><dt>Godzina</dt><dd>{selectedEvent && time(selectedEvent.startsAt)}</dd></div><div><dt>Sala</dt><dd>{selectedEvent?.hall.replace("Sala ", "")}</dd></div><div><dt>Rząd</dt><dd>{row ?? "—"}</dd></div><div><dt>Fotel</dt><dd>{seatNumber ?? "—"}</dd></div></dl>
          {!reservation ? <>
            <p className="reservation-explainer">Wybierz fotel i podaj dane. Po rezerwacji potwierdź zakup przed końcem odliczania.</p>
            <form onSubmit={submit} aria-label="Rezerwacja fotela">
              <p className="form-caption">{selectedSeat ? `Twój wybór: Rząd ${row}, miejsce ${seatNumber}` : "Najpierw wybierz wolny fotel na mapie."}</p>
              <label htmlFor="customer-name">Twoje imię</label><input id="customer-name" name="customerName" placeholder="np. Aleksandra" autoComplete="given-name" value={name} onChange={(e)=>setName(e.target.value)} required maxLength={100} disabled={busy}/>
              <label htmlFor="customer-email">Adres e-mail</label><input id="customer-email" name="email" type="email" placeholder="ty@przyklad.pl" autoComplete="email" value={email} onChange={(e)=>setEmail(e.target.value)} required maxLength={254} disabled={busy}/>
              <button className="primary-button" type="submit" disabled={!selectedSeat || mapLoading || busy}>{busy ? "Rezerwujemy fotel…" : "Zarezerwuj"}</button>
              <p className="privacy-note">Dane służą wyłącznie obsłudze tej rezerwacji.</p>
            </form>
          </> : purchased ? <div className="ticket-content">
            <p className="ticket-confirmation">Zakup potwierdzony.</p>
            <div className="ticket-code"><span>Kod biletu</span><strong data-testid="ticket-code">{reservation.code}</strong><p>Zachowaj kod lub wydrukuj bilet.</p></div>
            <button className="primary-button" onClick={()=>window.print()}>Drukuj bilet</button><button className="text-button" onClick={reset}>Wybierz kolejny seans</button>
          </div> : reservation.status === "expired" ? <div className="expired-content" role="status"><p>Rezerwacja wygasła, fotel wrócił do puli</p><span>Możesz ponownie wybrać dostępne miejsce.</span><button className="primary-button" onClick={reset}>Wybieram ponownie</button></div> : <div className="active-content">
            <div className="countdown"><span>Trzymamy Twój fotel jeszcze</span><strong role="timer" aria-label="Pozostały czas rezerwacji">{String(Math.floor(seconds/60)).padStart(2,"0")}:{String(seconds%60).padStart(2,"0")}</strong><p>{seconds === 0 ? "Sprawdzamy ważność rezerwacji na serwerze…" : "Zamień rezerwację w bilet, zanim upłynie czas."}</p></div>
            <button className="primary-button" disabled={busy} onClick={buy}>{busy ? "Przygotowujemy bilet…" : "Kupuję bilet"}</button><p className="privacy-note">Zakup bez płatności online.</p>
          </div>}
        </aside>
      </div>}
    </main>
  </div>;
}
