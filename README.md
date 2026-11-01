# KADR — PAS S01, etap I

Kompletna kasa kina: repertuar → fotel → rezerwacja → zakup → bilet do wydruku. Jedna rezerwacja obejmuje jeden fotel na jednym seansie. Bez kont, panelu administratora i płatności online.

Projekt lokalny: Next.js App Router i Route Handlers, TypeScript, PostgreSQL 17, Prisma 7 z adapterem PostgreSQL, Tailwind CSS 4 i Zod 4. Konkretne wersje zapisano w `package-lock.json`. Nazwa KADR pochodzi z dostarczonego promptu. Filmy i ilustracje są fikcyjnymi danymi demonstracyjnymi.

## 1. Uruchomienie od zera

Wymagania: Node.js **22.12 lub nowszy**, npm oraz uruchomiony Docker Desktop z kontenerami Linux. Komendy poniżej są dla **PowerShell**.

```powershell
cd 'C:\projekt PAS'
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
# W .env ustaw POSTGRES_PASSWORD i to samo hasło w obu URL-ach.
# Najprościej użyć hasła z liter i cyfr; znaki specjalne w URL wymagają kodowania.
npm ci
docker compose up -d --wait db
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Otwórz **http://127.0.0.1:3000**. Jeśli `.env` już istnieje, zachowaj go; nie kopiuj ponownie przykładu. W dostarczonym środowisku `.env`, zależności, migracja i seed zostały już przygotowane.

Tryb produkcyjny lokalnie:

```powershell
npm run build
npm start
```

Zatrzymanie baz bez usuwania danych: `docker compose --profile test stop`. Dane aplikacji są w woluminie `kadr-data`. Testowa baza jest ulotna i całkowicie osobna. Projekt używa portów **54320** i **54321**, ponieważ port 5432 był zablokowany na tym komputerze.

## 2. Zmienne środowiskowe

| Zmienna                   | Znaczenie                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`           | Użytkownik PostgreSQL w Compose, np. `kadr`.                                                                                      |
| `POSTGRES_PASSWORD`       | Hasło lokalnej bazy, wyłącznie w `.env` / magazynie sekretów.                                                                     |
| `POSTGRES_DB`             | Nazwa bazy aplikacji, domyślnie `kadr`.                                                                                           |
| `DATABASE_URL`            | Połączenie aplikacji; lokalnie port 54320.                                                                                        |
| `TEST_DATABASE_URL`       | Oddzielna baza `kadr_test`; lokalnie port 54321.                                                                                  |
| `RESERVATION_TTL_SECONDS` | Dodatnia liczba całkowita 1–86400. Domyślnie **900**, w trybie testowym **120**.                                                 |
| `TRUSTED_PROXY_SECRET`    | Opcjonalny sekret ≥32 znaki. Wymagany przez `deploy/compose.production.yaml`. Bez niego wszystkie lokalne żądania współdzielą jeden limit. |

Konfiguracja jest sprawdzana Zodem przy uruchamianiu serwera przez `src/instrumentation.ts`. Błędny TTL lub niepoprawny URL uniemożliwiają poprawny start. Żadna zmienna z sekretem nie ma prefiksu `NEXT_PUBLIC_`. Plik `.env` jest ignorowany przez Git i Docker.

Przed szkolnym sprawdzaniem ustaw `RESERVATION_TTL_SECONDS=120` na docelowym serwerze i uruchom ponownie aplikację. Lokalnie możesz włączyć ten tryb dla procesu bez zmiany `.env`:

```powershell
$env:RESERVATION_TTL_SECONDS = '120'
npm run dev
```

Jeżeli serwer już działa, zatrzymaj go najpierw przez Ctrl+C. Zmiana TTL dotyczy nowych rezerwacji. Standardowy czas rezerwacji wynosi 900 s, czyli 15 minut. Testy uruchamiane przez runner ustawiają własny TTL i nie zmieniają `.env` ani ustawienia działającej aplikacji.

## 3. Docker, migracje i seed

```powershell
docker compose --profile test up -d --wait
npm run db:generate
npm run db:migrate
npm run db:seed
```

Migracja `prisma/migrations/202611010001_init/migration.sql` tworzy tabele, indeksy, klucze obce, ograniczenia kontrolne i dodatkową zgodność właściciela z konkretnym fotelem. Używaj `migrate deploy`, a nie `db push`, aby zachować również dodatkowe ograniczenia SQL.

Seed dodaje 3 seanse w 2 salach (6 listopada 2026), każdy z 80 fotelami A1–H10. Dwa seanse korzystają z tej samej sali, ale mają niezależną zajętość. `upsert` z pustym `update` i `createMany(skipDuplicates)` sprawiają, że ponowienie **nie usuwa ani nie nadpisuje** istniejących rezerwacji, biletów i dat seansów. Po czasie przykładowego repertuaru można dodać nowe seanse z nowymi ID w seedzie; etap I nie wprowadza ograniczenia zakupu na podstawie daty seansu.

## 4. Zakres repozytorium i testy

Repozytorium zawiera pliki potrzebne do instalacji, budowania i uruchamiania aplikacji: źródła, manifest i lockfile, migracje, seed, konfigurację Next.js/TypeScript/Tailwind/Prisma, Compose, Dockerfile, konfigurację proxy oraz instrukcję uruchomienia.

Repozytorium zawiera testy jednostkowe i API: `tests/unit.test.ts`, `tests/api.test.ts`, `tests/ttl120.test.ts`, `tests/helpers.ts` oraz runner `scripts/run-tests.ts`. Korzystają z wbudowanego `node:test`, istniejącego `tsx` i prawdziwego PostgreSQL. Nie wymagają Playwright ani instalacji przeglądarki.

```powershell
npm ci
npm run db:generate
npm run typecheck
npm run build
```

Przygotuj `.env` zgodnie z sekcją 2, w tym osobną `TEST_DATABASE_URL`, a następnie uruchamiaj zestawy kolejno. Porty 3101 i 3102 muszą być wolne; runner sam uruchamia i zatrzymuje serwery testowe:

```powershell
docker compose --profile test up -d --wait
npm test
# Osobno: rzeczywisty upływ 120 sekund (test trwa około 122 s).
npm run test:120
```

Wymagany jest produkcyjny build z poprzedniego bloku. `npm test` uruchamia 3 testy jednostkowe i 15 testów API. Runner API startuje dwie instancje serwera ze wspólną bazą i TTL 3 s; osobny `test:120` sprawdza TTL 120 s. Baza testowa jest oddzielna, z nazwą zakończoną `_test`; jej zawartość jest resetowana przez testy. Nie ma publicznych endpointów resetowania danych ani zmiany czasu.

Playwright nie jest zależnością repozytorium. Dotychczasowe testy przeglądarkowe, ich konfiguracja i osobny runner `scripts/run-e2e.local.ts` pozostają wyłącznie lokalnie i są ignorowane. Instrukcja ich opcjonalnego uruchomienia jest w lokalnym `TESTING.local.md`. Wyniki wcześniejszej weryfikacji UI opisano w sekcji 8; testy jednostkowe i API nie zastępują sprawdzenia klikania w przeglądarce. Po sklonowaniu repozytorium lokalne pliki Playwright nie będą dostępne.

Ignorowane są także sekrety, zależności, build, wygenerowany klient Prisma i `next-env.d.ts`, cache, logi, raporty, zrzuty i lokalne pliki narzędziowe. Żaden z tych plików nie jest wymagany w Git: zależności instaluje `npm ci`, klienta generuje `db:generate`, a build odtwarza `npm run build`. Polecenie `typecheck` generuje klienta Prisma i typy tras Next.js przed sprawdzeniem TypeScript, więc działa także bez istniejącego `.next`. Plik `.env.example` pozostaje wersjonowany; prawdziwy `.env` pozostaje lokalny.

## 5. Kontrakt API i przykłady

| Metoda i adres                        | Sukces                                      | Odmowy                                                                         |
| ------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/events`                     | `200`, tablica seansów                      | `500` przy awarii infrastruktury                                               |
| `GET /api/events/:id`                 | `200`, `{ event, takenSeats }`              | `404`                                                                          |
| `POST /api/reservations`              | `201`, `{ reservationId, expiresAt }`       | `400`, `404`, `409`, `413`, `415`, `429`; `403` dla pominięcia zaufanego proxy |
| `POST /api/reservations/:id/purchase` | `200`, `{ code }`                           | `400`, `404`, `410`                                                            |
| `GET /api/reservations/:id`           | `200`, stan, seans i fotel, ewentualnie kod | `400`, `404`                                                                   |

Każdy błąd aplikacyjny: `{ "error": { "code": "SEAT_TAKEN", "message": "…" } }`. Brak cache: `Cache-Control: no-store, max-age=0` na wszystkich odpowiedziach API, także błędach. JSON z rezerwacją wymaga `Content-Type: application/json`. Limit ciała 4096 bajtów jest egzekwowany również bez `Content-Length`. Nieobsługiwane metody obsługuje standardowe `405` Next.js.

Przykłady lokalnie, bez skonfigurowanego sekretu proxy:

```powershell
curl.exe -i http://127.0.0.1:3000/api/events
curl.exe -i http://127.0.0.1:3000/api/events/orbita

# Plik pozwala uniknąć różnic w cytowaniu JSON pomiędzy wersjami PowerShell.
'{"eventId":"orbita","seatId":"F7","customerName":"Anna","email":"anna@example.com"}' |
  Set-Content -Encoding ascii reservation.json
curl.exe -i -X POST http://127.0.0.1:3000/api/reservations `
  -H 'Content-Type: application/json' --data-binary '@reservation.json'

# Wstaw reservationId otrzymany powyżej:
curl.exe -i -X POST http://127.0.0.1:3000/api/reservations/TUTAJ_UUID/purchase
curl.exe -i http://127.0.0.1:3000/api/reservations/TUTAJ_UUID
Remove-Item -LiteralPath reservation.json
```

`eventId` i `seatId` są tekstem; w wariancie KINO poprawne fotele to A1–H10. Daty API są ISO 8601 UTC z `Z`; UI wyświetla termin w `Europe/Warsaw`.

## 6. Model i gwarancje

```text
Event ──< EventSeat (eventId, seatId) ──> currentReservationId
                   │                           │
                   └──< Reservation (historia) ┘── 0..1 Ticket
RateLimit (skrót adresu sieci, licznik, koniec okna)
```

**Jeden punkt blokowania.** W każdej transakcji rezerwacji i zakupu `SELECT ... FOR UPDATE` blokuje stały rekord `EventSeat`. Rekordy foteli tworzy wyłącznie seed. Izolacja PostgreSQL `READ COMMITTED` pozwala po oczekiwaniu odczytać aktualnego właściciela. Aplikacja nie używa blokad pamięciowych ani mechanizmu „sprawdź, potem zapisz” poza transakcją. Nie ma pętli ponowień transakcji; `maxWait=10 s`, `timeout=15 s` ograniczają oczekiwanie po stronie Prisma.

**Wspólny czas.** Po uzyskaniu blokady następuje osobne `SELECT clock_timestamp()`. Przyznanie i zakup korzystają z tego czasu. Nie stosujemy `now()`/`transaction_timestamp()`, bo zwracałyby moment sprzed oczekiwania. Rezerwacja jest ważna dokładnie wtedy, gdy `expiresAt > czas bazy`; równość oznacza wygaśnięcie.

**Wygaśnięcie bez procesu w tle.** Odczyt mapy filtruje rezerwacje według `clock_timestamp()`; kupione miejsca są zawsze zajęte. Nowa rezerwacja może pod blokadą zastąpić wskaźnik wygasłego właściciela. Stary rekord pozostaje w historii. Cron, timer serwera i otwarta karta nie są potrzebne. Odczyt nie musi nic zapisywać.

**Idempotentność rezerwacji bez nagłówka.** Klucz to SHA-256 tablicy `[eventId, seatId, customerName, email]` po walidacji i normalizacji. ID są przycięte; imię ma NFC, przycięte brzegi i pojedyncze odstępy, zachowuje wielkość liter; e-mail jest przycięty i zapisany małymi literami. Aktualna ważna lub kupiona rezerwacja o tym kluczu daje to samo ID i termin. Inny klient dostaje 409. Po wygaśnięciu niekupionej rezerwacji można utworzyć nową, również dla identycznych danych. UI ma synchroniczną blokadę `useRef` i blokuje przyciski podczas żądania.

**Idempotentny zakup i trwały bilet.** Pod tą samą blokadą najpierw szukamy istniejącego biletu. Jeśli istnieje, zwracamy jego kod nawet po pierwotnym terminie rezerwacji. W przeciwnym razie weryfikujemy właściciela i ważność, po czym tworzymy bilet. `UNIQUE(reservationId)`, `UNIQUE(code)` i `UNIQUE(eventId, seatId)` uniemożliwiają duplikaty. Dodatkowe złożone klucze obce wymuszają zgodność rezerwacji, fotela i biletu. Wyścig zakupu z ponowną rezerwacją serializuje się na jednym rekordzie.

**Stan przeglądarki.** Mapa odświeża się co 5 s i po odzyskaniu fokusu, stan rezerwacji co 2 s. Licznik oblicza prezentację z czasu serwera i monotonicznego `performance.now()`. Nawet przy zerowym liczniku o ważności rozstrzyga serwer. Tylko UUID rezerwacji trafia do `localStorage`; nie trafiają tam imię ani e-mail. Po zakupie spóźniony odczyt nie może cofnąć interfejsu do stanu rezerwacji. Awaria odtwarzania zapisanej rezerwacji daje ponowienie odczytu.

## 7. Rate limiting i zaufane proxy

Limit: **20 prób utworzenia rezerwacji w 10 s na adres sieciowy**, stałe okno rozpoczynane pierwszą próbą. Także niepoprawne i powtórzone próby zużywają limit. Atomowy `INSERT … ON CONFLICT DO UPDATE` w PostgreSQL współdzieli licznik między procesami. Nadmiar daje 429 i całkowity `Retry-After` w sekundach, co najmniej 1. Inny adres ma osobny rekord. Po końcu okna nowa próba resetuje licznik.

Przed każdą próbą usuwamy rekordy starsze niż minuta od końca okna, także przy 429. Tabela nie rośnie w spoczynku; pierwszy ruch po przerwie usuwa stare wpisy. Indeks na `expiresAt` wspiera sprzątanie. Domyślnie aplikacja ignoruje **wszystkie** przekazane nagłówki adresowe i używa wspólnego lokalnego kubełka.

Wdrożenie: ustaw losowy `TRUSTED_PROXY_SECRET` (co najmniej 32 znaki) w serwerze i zaufanym Nginx. Proxy **nadpisuje** `X-Kadr-Client-IP` wartością `$remote_addr` i `X-Kadr-Proxy-Secret` sekretem z konfiguracji. Aplikacja porównuje sekret w stałym czasie, wymaga pojedynczego poprawnego IP i nie korzysta z `X-Forwarded-For`. Samodzielnie wpisany przez klienta XFF nie zmienia limitu. Port aplikacji nie może być publicznie dostępny; w przygotowanym Compose dostępny jest tylko w sieci kontenerów. Adres w bazie limitera przechowujemy jako SHA-256.

Konfiguracja: [deploy/nginx.conf.template](deploy/nginx.conf.template). Przy dodatkowym load balancerze Nginx musi ufać wyłącznie jego konkretnemu IP/CIDR przez `set_real_ip_from` i `real_ip_header`. Nie wolno globalnie ufać nagłówkom wszystkich klientów. Wiele osób za jednym NAT współdzieli limit — to świadoma konsekwencja limitowania według sieci bez kont.

W B5 testy API symulują dwa adresy IP, przekazując poprawny sekret zaufanego proxy do dwóch lokalnych instancji aplikacji. Sprawdza to wspólny limiter i rozdzielenie klientów. Nie potwierdza konfiguracji Nginx ani rozpoznawania rzeczywistych sieci w docelowym wdrożeniu.

## 8. Kryteria — rzeczywiste wyniki

Weryfikacja lokalna: **1 listopada 2026**, Windows, Node 22.14.0, PostgreSQL 17 w Dockerze, produkcyjny build Next.js i Chromium. Wyniki dotyczą wykonanych testów, nie są deklaracją testowania dowolnego przyszłego wdrożenia.

| Kryterium | Test i sprawdzany efekt                                                                         | Wynik                                      |
| --------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------ |
| A1        | `tests/api.test.ts`, nieistniejący seans, 404                                                   | PASS                                       |
| A2        | Sam GET po naturalnym TTL 3 s, brak fotela w mapie, historia bez zmian                          | PASS                                       |
| B1        | Ponowienia kolejno i 8 równocześnie w 2 instancjach; E2E: podwójne kliknięcie z opóźnieniem 1 s | PASS API + E2E                             |
| B2        | 20 równoczesnych klientów: 1×201, 19×409, jeden rekord i właściciel                             | PASS                                       |
| B3        | Nieistniejący seans/fotel, puste dane, błędne typy, JSON, MIME i rozmiar; zero rezerwacji       | PASS                                       |
| B4        | Nowy klient po naturalnym wygaśnięciu, dwa rekordy historii, jeden właściciel                   | PASS                                       |
| B5        | 100 prób w <10 s: 20×201, 80×429, Retry-After; drugi symulowany adres IP rezerwuje              | PASS lokalnie                              |
| C1        | 8 zakupów równocześnie i kolejny zakup: jeden kod i jeden bilet                                 | PASS                                       |
| C2        | 5 wyścigów przy expiresAt: zawsze ≤1 właściciel, ≤1 bilet i bez 5xx                             | PASS                                       |
| C3        | Losowy nieistniejący UUID i `abc`: 404/400, brak biletu                                         | PASS                                       |
| C4        | Odmowa po TTL, trwały zakup i powtórzony kod po TTL 3 s; osobno prawdziwe 120 s                 | PASS, również po 122 s rzeczywistego czasu |

Wykonane zestawy: TypeScript PASS, build PASS, jednostkowe **3/3**, API **15/15**, rzeczywisty TTL 120 s **1/1**. Przekazany wynik uruchomienia z 1 listopada 2026 potwierdza build, 3 testy jednostkowe, 15 testów API i test upływu 120 s; wszystkie zakończyły się sukcesem. Testy przeglądarkowe **5/5** wykonano wcześniej lokalnie i nie są częścią `npm test` ani repozytorium. Zbudowano też lokalne obrazy Docker na Linux/Alpine i sprawdzono szablon Compose przez `config --quiet`; nie oznacza to wdrożenia. Dodatkowe testy sprawdzają czas po oczekiwaniu na blokadę, integralność bazy, seed bez utraty danych, dwie instancje oraz ponowienia po awarii sieci.

Nie weryfikowano wdrożenia na publicznym serwerze, certyfikatów TLS, fizycznej drukarki ani innych przeglądarek niż Chromium. Sprawdzenie widoków obejmuje 1440 px oraz 390 i 320 px. Zrzuty desktop/mobile i wydruku obejrzano lokalnie.

Weryfikacja UI obejmowała kontrast wybranych tekstów (minimum 4,5:1), fokus klawiatury, symbole i obramowania stanów foteli, przyciski 44×44 px, brak przewijania całej strony w poziomie, pełne proporcje ilustracji oraz zakup biletu na telefonie. Mapa na wąskim ekranie przewija się we własnym obszarze. Wydruk zawiera dane biletu i kod tekstowy, bez dekoracyjnego kodu kreskowego.

Warunek wstępny nauczyciela wymaga działających endpointów **pod adresem firmy** i włączonego TTL 120 s. Lokalny wynik testów nie potwierdza tego warunku i nie jest gwarancją punktacji wdrożenia. Prywatne repozytorium GitHub samo nie uruchamia aplikacji.

## 9. Zagrożenia i zabezpieczenia

| Zagrożenie                                   | Zabezpieczenie / granica                                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Podwójna sprzedaż, wyścig z wygaśnięciem     | Blokada stałego fotela, sprawdzenie czasu po blokadzie, transakcja, unikalności i klucze obce.                                                                        |
| Powtórzone kliknięcie lub utracona odpowiedź | Idempotentne API, synchronizowana blokada UI, ponowienie zakupu zwraca ten sam kod.                                                                                   |
| Zmiana zegara klienta / zamknięcie strony    | Czas PostgreSQL, filtr ważności w odczycie, brak zależności od timera i crona.                                                                                        |
| Flood i podszycie się pod inną sieć          | Wspólny limiter PostgreSQL, nadpisywanie IP przez proxy, sekretny nagłówek, odrzucanie niezweryfikowanego proxy.                                                      |
| SQL injection / błędny JSON / duże body      | Zod, zapytania parametryzowane Prisma, limit strumienia 4 KiB.                                                                                                        |
| XSS / wyciek danych i sekretów               | Escaping React, brak HTML z danych klienta, API odczytu nie zwraca imienia/e-maila, brak PII w logach, `.env` ignorowane.                                             |
| Odgadnięcie lub kradzież rezerwacji          | Losowy UUID v4 jako token dostępu, bez listy rezerwacji. ID należy traktować jak sekret; posiadacz może odczytać bilet i wykonać zakup. Wymagany TLS przy publikacji. |
| Nieaktualna mapa / awaria sieci              | No-store, polling, odświeżenie po konflikcie, komunikaty i możliwość ponowienia; serwer zawsze ponownie sprawdza fotel.                                               |
| Utrata danych                                | Trwały wolumin, migracje, seed bez kasowania; kopie zapasowe i retencja po stronie operatora.                                                                         |

Karty A/B/C działają na stronie `/`: wybór seansu i fotela → formularz → licznik → bilet. Między widokami przekazywane są obiekt seansu i tekstowy `seatId`, następnie `reservationId` i `expiresAt`, a po zakupie `code`. Typy publiczne są w `src/lib/types.ts`. Implementacja pozostaje w etapie I.

Dokumentacja użyta przy doborze konfiguracji: [Next.js — instalacja](https://nextjs.org/docs/app/getting-started/installation), [Prisma ORM 7 — adapter i konfiguracja](https://www.prisma.io/docs/orm/v7).
