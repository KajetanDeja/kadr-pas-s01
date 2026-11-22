# KADR — PAS S01, etap III

Kasa kina: repertuar i cena → fotel → rezerwacja → punkty Voucherify + Stripe Checkout → potwierdzenie webhookiem → bilet do wydruku i mail przez Resend. Jedna rezerwacja obejmuje jeden fotel na jednym seansie. Wyłącznie płatności testowe, bez prawdziwych pieniędzy.

Etap III: 1000 punktów na start, 10 punktów za każdy pełny złoty zapłacony kartą, do połowy ceny punktami (1 pkt = 1 gr). Saldo pochodzi z Voucherify. **[Konfiguracja, kontrakt A/B/C i scenariusz szkolnego pokazu: ETAP-III.md](ETAP-III.md).**

Stos: Next.js App Router, TypeScript, PostgreSQL 17, Prisma 7, React, Tailwind CSS, Zod i oficjalny SDK Stripe. Wersje są przypięte w package-lock.json. Node.js: **22.12+ z linii 22 lub 24+**; Prisma nie obsługuje Node 23. Filmy i ilustracje są fikcyjne.

## Uruchomienie lokalne

Wymagania: Node.js, npm, działający Docker Desktop. Skopiuj .env.example do .env tylko wtedy, gdy nie masz własnego pliku. Ustaw losowe POSTGRES_PASSWORD i to samo hasło w obu adresach bazy. Nie publikuj .env.

```sh
cp .env.example .env
npm ci
docker compose --profile test up -d --wait
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

W PowerShell kopiowanie: `Copy-Item .env.example .env`. Pozostałe polecenia działają tak samo. Aplikacja: **http://127.0.0.1:3000**. Zwykła baza jest na porcie 54320, osobna baza testowa na 54321. Zatrzymanie bez usuwania danych: `docker compose --profile test stop`.

Bez konfiguracji Stripe repertuar i rezerwacje działają; próby Checkout i webhook zwracają 503. Nie istnieje zastępczy zakup bez zapłaty.

## Konfiguracja i Stripe

| Zmienna | Znaczenie |
|---|---|
| POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB | Lokalny Compose; domyślna nazwa bazy kadr. |
| DATABASE_URL | Bezpośredni adres PostgreSQL dla migracji, seeda i aplikacji. |
| DATABASE_URL_POOLED | Opcjonalny pooler TCP preferowany przez aplikację; CLI używa połączenia bezpośredniego. |
| TEST_DATABASE_URL | Osobna, resetowana przez testy baza z nazwą zakończoną _test. |
| RESERVATION_TTL_SECONDS | 1–86400, domyślnie 900; do szkolnego sprawdzenia **120**. |
| STRIPE_SECRET_KEY | Wyłącznie sk_test_…, po stronie serwera. Klucze live i publishable są odrzucane. |
| STRIPE_WEBHOOK_SECRET | Sekret podpisu whsec_…; inny lokalnie dla CLI i dla endpointu na Vercel. |
| APP_URL | Stały origin sklepu bez ścieżki/query, np. https://twoje-kino.vercel.app. Lokalnie http://127.0.0.1:3000. |
| TRUSTED_PROXY_SECRET | Tylko dla własnego Nginx, minimum 32 znaki; na Vercel zbędny. |

Sekrety nie mają prefiksu NEXT_PUBLIC_. Hosted Checkout nie wymaga klucza publishable ani Stripe.js w przeglądarce. Konfiguracja sprawdzana jest przy starcie; komunikaty walidacji nie zawierają wartości sekretów. Wszystkie trzy zmienne płatności są wymagane, aby płatności były dostępne.

1. Załóż własne konto Stripe lub wybierz Sandbox. Wpisz klucz jako STRIPE_SECRET_KEY=sk_test_… do lokalnego .env.
2. Zainstaluj [Stripe CLI](https://docs.stripe.com/stripe-cli) i wykonaj:

```sh
npm install -g @stripe/cli
npm run stripe:listen
```

3. Skrypt używa klucza z .env, uruchamia lokalne przekazywanie webhooków i sam zapisuje STRIPE_WEBHOOK_SECRET, ukrywając go w logach. Nie wymaga stripe login. Ustaw APP_URL=http://127.0.0.1:3000 i dopiero po komunikacie „Webhook gotowy” uruchom lub zrestartuj aplikację w drugim terminalu. Pozostaw listener działający podczas płacenia. Sekret CLI dotyczy wyłącznie lokalnego serwera; na Vercel potrzebny jest sekret publicznego endpointu.
4. Rezerwuj fotel, kliknij „Zapłać 32 zł” i płać na stronie Stripe. Sam powrót na stronę sukcesu nie wystawia biletu.

| Karta testowa | Wynik |
|---|---|
| 4242 4242 4242 4242 | Sukces |
| 4000 0000 0000 0002 | Odmowa |
| 4000 0025 0000 3155 | Dodatkowe potwierdzenie 3D Secure |

Data ważności: przyszła, CVC: trzy dowolne cyfry. Odmowa pozostaje na Stripe; klient może poprawić kartę. Anulowanie wraca do ważnej rezerwacji i pozwala ponowić Checkout bez wydłużania TTL.

## Kontrakt API i połączenie kart A/B/C

Typy publiczne: src/lib/types.ts. Każdy seans ma jedną cenę fotela price w groszach. Nowe dane demonstracyjne kosztują 3200 groszy. amount to cena skopiowana w chwili rezerwacji; zmiana ceny wydarzenia nie zmienia istniejącej rezerwacji. Baza blokuje późniejszą zmianę amount.

| Metoda i adres | Sukces | Główne odmowy |
|---|---|---|
| GET /api/events | Tablica seansów z price | — |
| GET /api/events/:id | { event, takenSeats }, event.price | 404 |
| POST /api/reservations | 201, { reservationId, expiresAt, amount } | 400, 404, 409, 413, 415, 429; 403 przy pominięciu zaufanego proxy |
| POST /api/reservations/:id/checkout | 200, { url } | 400, 404, 409 dla opłaconej lub przetwarzanej, 410 dla wygasłej, 429 |
| GET /api/loyalty?email=… | { email, points }; nowy klient 1000 pkt | 400, 409 przy równoległym rozliczeniu, 429; 503 przy awarii lub limicie Voucherify |
| GET /api/reservations/:id | Stan opisany poniżej | 400, 404 |
| POST /api/webhooks/stripe | 200, { received: true } | 400 dla podpisu, trybu live i niezgodnych danych, 413 dla rozmiaru |
| POST /api/reservations/:id/purchase | { code } wyłącznie dla istniejącego biletu | 402 dla nieopłaconej, 400, 404, 410 |

Odczyt rezerwacji zwraca `{ reservationId, status, amount, pointsUsed, pointsEarned?, cardAmount, loyaltyStatus, checkoutLocked, emailStatus, expiresAt, event, seatId, serverNow, code?, refundStatus? }`. Status: held, paid albo expired. Kod i pointsEarned występują tylko po zakupie. Opcjonalny refundStatus: pending, refunded, failed. Nie zwracamy imienia ani e-maila. Checkout przyjmuje opcjonalne `{ points }`; brak pola na pierwszym żądaniu oznacza 0. Kwota Stripe to `amount - pointsUsed`.

Wszystkie odpowiedzi API, również błędy, mają Cache-Control: no-store, max-age=0. Błąd ma postać `{ "error": { "code": "…", "message": "…" } }`. 2xx oznacza sukces, 4xx odmowę, 5xx błąd infrastruktury. Brak konfiguracji płatności lub przejściowa awaria Stripe daje 503. Utworzenie rezerwacji dodaje X-Server-Time. Daty to ISO 8601 UTC; interfejs wyświetla Europe/Warsaw.

**Checkout (etap II, rozszerzony w III):** formularz na / przekazuje eventId, seatId, customerName, email; odpowiedź przekazuje ID, termin i kwotę. Checkout nie przyjmuje ceny ani adresów powrotu od klienta. Serwer używa mode=payment, PLN, jednej sztuki i karty; SDK 23/API 2026-10-28 używa allowed_payment_method_types: ["card"]. client_reference_id wskazuje rezerwację. Parametry żądania, punkty i próba płatności są zapisane przed kontaktem ze Stripe. Powtórzenia korzystają z tej samej sesji i klucza idempotencji; liczba punktów otwartej sesji jest stała. Wygasłą sesję można zastąpić, jeśli nadal obowiązuje rezerwacja, po rozliczeniu poprzednich punktów.

**B — Webhook:** surowe ciało jest czytane bez parsowania JSON przed weryfikacją stripe.webhooks.constructEvent. Limit 256 KiB działa również bez Content-Length; rezerwacje mają osobny limit 4 KiB. Podpis, testowy tryb, powiązanie sesji, client_reference_id, kwota, PLN, mode, status i payment_status muszą się zgadzać. Nieznane sesje z CLI lub innych aplikacji są potwierdzane i ignorowane. Samo stripe trigger checkout.session.completed nie opłaca dowolnej rezerwacji — zdarzenie musi dotyczyć sesji zapisanej przez nasz Checkout. Automatyczne testy B tworzą taką próbę jako fixture, niezależnie od karty A.

**C — powrót:** adresy ustalone w kontrakcie to /platnosc/:id/sukces i /platnosc/:id/anulowano. Strona bierze ID z adresu, działa bez localStorage i odczytuje tylko nasze API. Sukces pokazuje „Płatność w toku…” i odpytuje co 2 s; po 60 s zmienia komunikat i udostępnia dodatkowe ręczne sprawdzenie, nadal automatycznie odpytując API. Opóźnione potwierdzenie samo zmienia ekran w bilet. paid pokazuje trwały bilet i wydruk; anulowanie udostępnia ponowny Checkout do pierwotnego terminu. Tylko ID rezerwacji trafia do localStorage.

## Model, idempotencja i wygaśnięcie

```text
Event(price) → EventSeat → aktualna Reservation(amount) → 0..1 Ticket
                             │
                             └→ PaymentAttempt(sessionId, paymentIntentId, refundId)
StripeEvent(event.id) — zakończone webhooki
RateLimit — wspólne liczniki PostgreSQL
```

Zachowujemy SELECT … FOR UPDATE na stałym rekordzie fotela oraz clock_timestamp() odczytany po uzyskaniu blokady. Rezerwacja jest ważna wyłącznie przy expiresAt > czas bazy i zgodnym właścicielu. Zakup, ponowna rezerwacja i webhook serializują się na tym samym fotelu. Unikalności biletu, miejsca, kodu i identyfikatorów Stripe są wymuszane przez PostgreSQL. Wywołania sieciowe Stripe odbywają się poza transakcją blokującą fotel.

Rezerwacja pozostaje idempotentna po normalizacji danych: SHA-256 [eventId, seatId, customerName, email]. Imię ma NFC i pojedyncze odstępy, e-mail jest małymi literami. Ważna lub opłacona rezerwacja tego klienta daje ten sam identyfikator, termin i historyczną kwotę. Po wygaśnięciu można utworzyć nową rezerwację.

Wygaśnięcie nie wymaga crona ani otwartej przeglądarki. Mapa filtruje ważność przy odczycie; nowy klient może przejąć wygasły fotel, zachowując historię. Mapa odświeża się co 5 s i po fokusie, rezerwacja co 2 s. Licznik korzysta z czasu serwera i performance.now(). Bilety etapu I pozostają ważne, mimo braku historycznej płatności Stripe.

**Ścisły TTL:** wydanie biletu musi nastąpić przed końcem rezerwacji, także gdy sama płatność rozpoczęła się wcześniej. Jeśli webhook dotrze po terminie, nie ma biletu i uruchamiany jest pełny zwrot. Dotyczy to również opóźnionego webhooka po zapłacie wykonanej przed terminem. Nie odbieramy miejsca nowemu właścicielowi. Druga opłacona sesja tej samej rezerwacji również otrzymuje zwrot, zachowując pierwszy bilet.

Stripe pozwala ustawić automatyczne wygaśnięcie Checkout najwcześniej po 30 minutach; sesja w tej aplikacji korzysta z domyślnego terminu Stripe, niezależnego od krótszego TTL fotela. Po wygaśnięciu rezerwacji strona Stripe może jeszcze przyjąć testową płatność — sklep ją zwróci. Nie przedłużamy rezerwacji podczas Checkout.

Zwrot ma trwały stan refund_pending i stały klucz idempotencji. Ponowienie najpierw szuka istniejącego zwrotu w Stripe, również po utracie odpowiedzi lub przekroczeniu retencji klucza. Awaria wywołania daje 503 i pozwala Stripe ponowić webhook. Zdarzenie zapisujemy jako zakończone dopiero po trwałej obsłudze. Zdarzenia refund.* aktualizują stan zwrotu; stan jest odczytywany ze Stripe, aby obsłużyć inną kolejność dostarczenia. Ostateczna odmowa zwrotu daje failed i komunikat wymagający pomocy kina; operator sprawdza log oraz płatność w panelu Stripe.

## Rate limiting i zagrożenia

Rezerwacja i Checkout mają oddzielne limity **20 prób na 10 s na adres sieciowy**. Liczniki są atomowe i współdzielone przez PostgreSQL, również między instancjami; niepoprawne żądania też zużywają limit. 429 ma Retry-After. Stare wpisy są usuwane oportunistycznie. Webhook nie podlega limiterowi klientów — chroni go podpis Stripe.

Na Vercel zaufanie do x-vercel-forwarded-for włącza wyłącznie serwerowe VERCEL=1 z VERCEL_ENV=production/preview. Inne nagłówki IP są ignorowane; brak poprawnego IP daje 400. Lokalnie bez proxy używany jest wspólny kubełek. Przy własnym Nginx wymagamy sekretu ≥32 znaki i nadpisanych przez proxy nagłówków X-Kadr-Client-IP, X-Kadr-Proxy-Secret; port aplikacji pozostaje niepubliczny. Nie konfiguruj globalnego zaufania do dowolnych adresów proxy.

| Zagrożenie | Zabezpieczenie / granica |
|---|---|
| Podwójna sprzedaż i wyścig z TTL | Blokada fotela, czas bazy po blokadzie, transakcje, unikalności i złożone FK. |
| Zmiana ceny, waluty lub ilości przez klienta | Kwota z bazy, PLN, jedna sztuka, niezmienny snapshot amount, weryfikacja webhooka. |
| Darmowy zakup przez stary endpoint lub fałszywy powrót | /purchase nie tworzy biletu, strona sukcesu tylko odczytuje stan; wyłącznie webhook wystawia nowy bilet. |
| Fałszywy, zmieniony lub stary webhook | Podpis SDK na surowym body, tolerancja czasu SDK, odrzucenie live, kontrola sesji i danych. |
| Duplikaty, utrata odpowiedzi i inna kolejność zdarzeń | Trwałe próby, klucze idempotencji, blokady, tabela zdarzeń, monotoniczny stan biletu. |
| Stripe jako zewnętrzna usługa: awaria lub opóźnienie | 503 i ponowienie, brak transakcji DB obejmujących sieć, strona oczekiwania, ścisły TTL i pełny zwrot; operator obsługuje ostatecznie odrzucony zwrot. |
| Voucherify jako zewnętrzna usługa: awaria, nieznany wynik zapisu, limit 100/h | 503, limit lokalny 95/h współdzielony w PostgreSQL, Retry-After, trwały dziennik i uzgadnianie po source_id. Nie ponawiamy w ciemno niejednoznacznych zmian salda. |
| Powielone powitanie, wydanie lub naliczenie punktów | Blokada klienta między instancjami, trwałe ID operacji, historia Voucherify; punkty za zakup wyłącznie od części kartowej potwierdzonego biletu. |
| Porzucona sesja, wygasła rezerwacja i punkty | Trwałe zadanie zamyka sesję Stripe przed oddaniem punktów; zadziała bez przeglądarki przy uruchomionym procesie zadań. |
| Resend jako zewnętrzna usługa: błąd API, utrata odpowiedzi, odbicie maila | Trwały stan wysyłki, stała treść i klucz idempotencji, ponowienia, podpisany webhook; bilet pozostaje ważny. Po końcu okna idempotencji niejednoznaczna wysyłka wymaga sprawdzenia. |
| Podszycie się pod właściciela e-maila | Szkolny kontrakt identyfikuje klienta e-mailem i nie wymaga logowania. Nie jest to uwierzytelnienie właściciela konta; prawdziwy program wymagałby weryfikacji tożsamości. |
| Flood i podszycie się pod inną sieć | Oddzielne limity w PostgreSQL, weryfikowane wejście proxy, limit surowego body. |
| SQL injection, błędne dane i XSS | Zod, parametryzacja Prisma, limity rozmiaru, escaping React. |
| Wyciek kluczy, danych osobowych lub karty | Sekrety wyłącznie na serwerze, .env ignorowany, bez treści żądań w logach; kartę zbiera wyłącznie Stripe. Stripe otrzymuje e-mail i opis biletu. |
| Kradzież ID rezerwacji | UUID v4 jest tokenem dostępu: posiadacz może odczytać bilet. Brak publicznej listy rezerwacji, HTTPS, no-referrer, brak PII w API odczytu. |
| Utrata danych i regresja migracji | Migracje bez kasowania historii, powtarzalny seed z pustym update, trwały wolumin; kopia przed migracją i retencja należą do operatora. |

## Testy

```sh
npm run typecheck
npm run build
docker compose --profile test up -d --wait
npm test
npm run test:vercel
npm run test:120
```

Jeśli lokalny sandbox blokuje pomocniczy proces Turbopack, można zbudować przez npm run build -- --webpack. To ten sam kod aplikacji z drugim bundlerem Next.js. Testy wymagają gotowego produkcyjnego buildu.

Runner uruchamia migracje i seed na **osobnej** TEST_DATABASE_URL, dwie instancje aplikacji (3101, 3102), zastępcze Stripe (3103) oraz Voucherify/Resend (3104). Nadpisuje oba URL-e bazy, tryb platformy i wszystkie sekrety usług, aby nie dotknąć produkcji ani zużywać limitu Sandbox. Kolejne zestawy należy uruchamiać sekwencyjnie. Testy resetują wyłącznie bazę _test; nie ma publicznych endpointów resetowania ani zmiany czasu. Transport testowy jest wstrzykiwany przez preload Node wyłącznie w runnerze — żadna zmienna aplikacji ani żądanie HTTP nie przełącza usług w tryb zaślepki.

Testy jednostkowe: konfiguracja, sekrety, surowe body, normalizacja i zaufane proxy. Testy API: regresje etapu I, konkurencja i limiter, snapshot ceny, Checkout i jego ponowienia, podpisy, duplikaty webhooków, trwałość kodu, zwroty i ich uzgadnianie, zdarzenia poza kolejnością oraz strony powrotu. test:120 czeka na rzeczywisty upływ ponad dwóch minut.

Weryfikacja lokalna 16 listopada 2026: macOS, Node.js 22.23.5, PostgreSQL 17 w Dockerze, produkcyjny build i Google Chrome.

| Sprawdzenie | Wykonany wynik |
|---|---|
| TypeScript | PASS |
| Produkcyjny build przez Webpack | PASS; domyślny Turbopack napotkał blokadę pomocniczego procesu w tym środowisku |
| Testy jednostkowe | 11/11 |
| Testy API z wejściem Nginx | 32/32, w tym migracja istniejącego biletu etapu I |
| Testy API z symulowanym wejściem Vercel | 32/32, w tym migracja istniejącego biletu etapu I |
| Rzeczywisty TTL 120 s | 1/1, po 122 s czasu rzeczywistego |
| Chrome: rezerwacja, przekierowanie, anulowanie, powrót bez storage, webhook, bilet, odświeżenie i PDF | PASS, zastępczy Stripe |
| Chrome: bilet na 390/320 px i wygasła rezerwacja ze zwrotem | PASS, bez poziomego przewijania strony i błędów JS |
| Chrome: potwierdzenie po ponad 60 s oczekiwania | PASS, symulowany zegar przeglądarki; bilet pojawia się automatycznie, a polling kończy się po paid |
| Chrome: wygaśnięcie i zwrot po ponad 60 s oczekiwania | PASS, symulowany zegar przeglądarki; oba stany pojawiają się automatycznie |
| Szablon produkcyjnego Compose i składnia Nginx | PASS |
| Rzeczywiste Stripe Sandbox: karta 4242, webhook i kod biletu | PASS, 32 PLN i HTTP 200 webhooka |
| Rzeczywiste Stripe Sandbox: odmowa karty i ponowienie tej samej sesji | PASS, brak biletu i zachowany termin |
| Rzeczywiste Stripe Sandbox: karta wymagająca 3D Secure | PASS po potwierdzeniu testowego uwierzytelnienia, status paid |
| Rzeczywiste Stripe Sandbox: płatność po wygaśnięciu | PASS, pełny zwrot 32 PLN, status expired/refunded i brak biletu |

Zrzuty i PDF sprawdzano lokalnie w ignorowanym katalogu output/stage-ii; Playwright i skrypt przeglądarkowy pozostają w katalogu tymczasowym, nie są zależnością repozytorium ani częścią npm test.

Rzeczywiste testy Sandbox wykonano w Google Chrome na lokalnej aplikacji z webhookami przekazywanymi przez Stripe CLI. Test zwrotu używał osobnej nowo utworzonej rezerwacji demonstracyjnej, której termin przesunięto bezpośrednio w lokalnej bazie; nie dodano publicznego endpointu zmiany czasu. Wszystkie płatności i zwroty były testowe, bez prawdziwych pieniędzy.

Wyniki lokalne nie potwierdzają publicznego wdrożenia. Publiczny endpoint webhooka, sekrety na Vercel oraz zaproszenie nauczyciela wymagają konfiguracji kont operatora. Instrukcja: [WDROZENIE.md](WDROZENIE.md). Przegląd zgodności z plannerem Stripe: [STRIPE-REVIEW.md](STRIPE-REVIEW.md).

## Migracje i wdrożenie

Nowa migracja 202611160001_stripe_checkout dodaje ceny, kwoty, próby płatności i zdarzenia. Uzupełnia istniejące seanse ceną 3200 i kopiuje ją do dotychczasowych rezerwacji. Nie usuwa historii ani biletów i nie wymaga dowodu Stripe dla biletów wydanych w etapie I. Używaj prisma migrate deploy, nie db push, aby zachować triggery i ograniczenia SQL.

Migracja 202611220001_loyalty dodaje rozliczenia punktów, identyfikatory kont Voucherify, dziennik operacji, wysyłki oraz zadania. Stare bilety zachowują kod i mają 0 użytych/zebranych punktów; nie naliczamy im bonusów wstecz. Dla etapu III uruchom również `npm run jobs` lub zewnętrzny harmonogram wywołujący chronione `/api/internal/jobs` — szczegóły w ETAP-III.md.

Seed pozostaje powtarzalny: trzy seanse, dwie sale, 240 foteli A1–H10; nie nadpisuje istniejących cen, dat, rezerwacji ani biletów. Demonstracyjne daty to 6 listopada 2026; zachowano regułę etapu I bez odrzucania zakupu na podstawie daty seansu.

Vercel wykonuje npm run vercel-build: generowanie Prisma, migracje, seed i build. Własny Docker wymaga migracji i seeda przed startem nowej wersji. Przed publiczną aktualizacją wykonaj kopię istniejącej bazy. Po migracji nie wdrażaj starego zapisu etapu I, który nie podaje obowiązkowego amount; w razie problemów przywróć zgodny kod etapu II, a odtwarzanie kopii bazy uzgodnij osobno, aby nie utracić nowych płatności.

Źródła: [Checkout](https://docs.stripe.com/api/checkout/sessions/create), [webhooki](https://docs.stripe.com/webhooks), [realizacja płatności](https://docs.stripe.com/checkout/fulfillment.md?ui=full-page), [idempotencja](https://docs.stripe.com/api/idempotent_requests), [zwroty](https://docs.stripe.com/api/refunds/create).
