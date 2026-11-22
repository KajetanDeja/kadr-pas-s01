# PAS S01 — etap III: punkty i mail z biletem

Projekt szkolny, wariant **kino, cena 3200 groszy**. Stripe działa wyłącznie w trybie testowym, Voucherify w firmowym projekcie Sandbox. Nie potrzeba płatnego hostingu ani własnej domeny do pokazu lokalnego.

## Konfiguracja i uruchomienie

1. W `.env` zachowaj działające dane bazy i Stripe z etapu II. Dopisz serwerowe `VOUCHERIFY_APPLICATION_ID`, `VOUCHERIFY_SECRET_KEY`, `VOUCHERIFY_API_URL`, `RESEND_API_KEY` i `RESEND_FROM=onboarding@resend.dev`. Przykład nazw: `.env.example`. Żaden sekret nie ma prefiksu `NEXT_PUBLIC_`.
2. Application Keys Voucherify są w **Sandbox → Project settings → General → Application Keys**. Używamy pary Application ID/Secret Key. W Resend klucz jest w **API Keys**.
3. Wykonaj `npm run loyalty:setup`. Utworzy albo odnajdzie kampanię **KADR PAS S01**, dopisze `VOUCHERIFY_CAMPAIGN_ID` oraz losowy `CRON_SECRET` do lokalnego `.env`. Nie nadpisuje pozostałych ustawień i nie wypisuje sekretów.
4. Kampania korzysta z API `/v1/loyalties` wskazanego w zadaniu: `AUTO_UPDATE`, `join_once=true`, początkowe punkty kart **0**. Jednorazowe 1000 punktów dodaje aplikacja. Nie włączaj równolegle automatycznego naliczania za te same zakupy w panelu Voucherify. Ten interfejs jest obecnie oznaczony jako legacy, ale został sprawdzony na rzeczywistym Sandbox.
5. Przy działającym Docker Desktop wykonaj:

```sh
npm ci
docker compose --profile test up -d --wait
npm run db:generate
npm run db:migrate
npm run db:seed
```

Uruchom w osobnych terminalach, w tej kolejności:

```sh
# Terminal 1: lokalny webhook Stripe; sekret zapisze się do .env.
# Jeśli masz Stripe CLI w PATH:
npm run stripe:listen
# Alternatywnie, bez instalowania globalnie:
# npx --yes --package @stripe/cli -c "node scripts/stripe-listen.mjs"

# Terminal 2: po komunikacie „Webhook gotowy”.
npm run dev

# Terminal 3: odzyskiwanie punktów i ponawianie operacji bez przeglądarki.
npm run jobs
```

Aplikacja: **http://127.0.0.1:3000**. Jednorazowe przetworzenie zadania: `npm run jobs -- --once`. Po zmianie `.env` zrestartuj aplikację i proces zadań. Nie trzeba uruchamiać testów automatycznych podczas pokazu.

Bez konfiguracji Voucherify odczyt i wydawanie punktów zwracają 503; można nadal rozpocząć nowy zakup za pełną kwotę kartą. Bez konfiguracji Resend zakup i bilet działają, a wysyłka czeka w kolejce. Brak usług nie uruchamia produkcyjnych zaślepek ani nie daje fikcyjnego salda.

## Kontrakt A/B/C

| Karta | Zachowanie | Miejsce w kodzie |
|---|---|---|
| A — punkty za zakupy | Konto po znormalizowanym e-mailu, powitanie raz, bieżące saldo z Voucherify, nagroda po potwierdzeniu zakupu | `src/server/loyalty.ts`, `src/server/voucherify.ts` |
| B — płatność punktami | Pole „Użyj punktów”, limit salda i połowy ceny, pomniejszony Checkout, oddawanie punktów po wygaśnięciu | `src/server/payments.ts`, `src/server/jobs.ts`, `src/components/cinema.tsx` |
| C — potwierdzenie | Ten sam kod i podsumowanie na stronie biletu oraz w mailu HTML/tekst | `src/server/mail.ts`, `src/server/booking.ts`, `src/components/cinema.tsx` |

| Endpoint | Kontrakt |
|---|---|
| `GET /api/loyalty?email=…` | `{ email, points }`; normalizacja: trim i małe litery, etykieta po `+` pozostaje częścią identyfikatora. Tworzy konto i powitanie, jeśli potrzebne. |
| `POST /api/reservations/:id/checkout` | Opcjonalny JSON `{ points }`. Pierwszy Checkout bez body lub bez pola używa 0. Punkty muszą być nieujemną liczbą całkowitą; obowiązuje `points <= floor(amount/2)` i saldo Voucherify. Wynik `{ url }`. |
| `GET /api/reservations/:id` | Zachowuje dotychczasowe pola. Dodaje `pointsUsed`, `cardAmount`, `checkoutLocked`, `loyaltyStatus`, `emailStatus` oraz `pointsEarned` po zakupie. |
| `GET /api/reservations/:id/loyalty` | `{ points }`; pozwala odtworzyć koszyk z samego ID bez ujawnienia e-maila w odczycie rezerwacji. |
| `POST /api/webhooks/resend` | Opcjonalne potwierdzenia doręczenia/odbicia. Weryfikuje podpis na surowym body; wymaga `RESEND_WEBHOOK_SECRET`. |
| `GET /api/internal/jobs` | Jedno zaległe zadanie; wymagane `Authorization: Bearer <CRON_SECRET>`. Bez sekretu 401, przy braku konfiguracji 503. |

Odpowiedzi nadal mają `Cache-Control: no-store`. Błędy: `{ error: { code, message } }`. 400 oznacza błędne punkty lub przekroczenie połowy ceny; 409 brak punktów, trwającą operację albo próbę zmiany parametrów otwartego Checkout; 410 wygaśnięcie. Błąd usługi lub limit Voucherify daje 503, limit klienta 429. Limity mają `Retry-After`.

Raz rozpoczęta sesja ma stałą liczbę punktów; ponowienie zwraca tę samą sesję. Pominięcie pola przy ponowieniu zachowuje jej ustawienia. Anulowanie na Stripe nie zamyka rezerwacji ani nie przedłuża TTL; klient może wrócić do tej samej płatności. Po wygaśnięciu zadanie zamyka Checkout i oddaje punkty. Wygasłą sesję można zastąpić dopiero po rozliczeniu jej punktów.

Wszystkie kwoty liczymy jako całkowite grosze:

```text
maxPoints = min(saldo Voucherify, floor(amount / 2))
cardAmount = amount - pointsUsed
pointsEarned = floor(cardAmount / 100) * 10

3200 - 1000 = 2200 groszy kartą
floor(2200 / 100) * 10 = 220 punktów
1000 - 1000 + 220 = 220 punktów po zakupie
```

Po potwierdzeniu płatności bilet jest od razu ważny. Jeżeli Voucherify nie odpowiada, `loyaltyStatus=pending` i `pointsEarned=0` do czasu rzeczywistego naliczenia; interfejs pokazuje „Naliczamy…”. Potwierdzone punkty są zapisywane w rezerwacji, a następnie wysyłany jest mail. Awaria wysyłki nie cofa biletu. Starsze bilety mają 0 punktów i nie dostają nagród wstecz.

## Źródło prawdy, ponowienia i granice

- `LoyaltyAccount` przechowuje identyfikator karty, nie saldo. Każdy odczyt salda i kontrola przed wydaniem korzystają z Voucherify. Istniejąca karta z innego kanału jest używana z jej aktualnym saldem; aplikacja nie zastępuje go 1000 punktów.
- `Reservation` przechowuje podsumowanie zakupu, `PaymentAttempt` parametry danej sesji. `LoyaltyOperation` zapisuje trwałe ID: powitanie, wydanie, nagrodę i oddanie punktów. To historia operacji, nie niezależny portfel.
- Dedykowana blokada klienta w PostgreSQL serializuje operacje naszej aplikacji między instancjami. Wywołania usług nie blokują fotela w transakcji. Inne kanały marketingowe nadal pracują bezpośrednio na Voucherify.
- Przy utracie odpowiedzi zmiany punktów aplikacja szuka operacji po `source_id` w historii Voucherify. `source_id` nie jest traktowany jako gwarancja idempotencji API. Gdy wyniku nie da się ustalić, nie wysyłamy ponownie zmiany w ciemno. Operator musi sprawdzić operację w panelu; automatyczne ponowienia odczytu nie zużyją drugiego bonusu ani obciążenia.
- Lokalny budżet to 95 wywołań Voucherify na godzinę, współdzielony przez instancje. Pozostałe wywołania zostają na panel i diagnostykę. Limity innych kanałów nadal mogą spowodować 429 od dostawcy — wtedy wstrzymujemy kolejne próby. Interfejs nie odpytuje salda co 2 sekundy; odczytuje je po wpisaniu e-maila, odtworzeniu koszyka lub ręcznym ponowieniu.
- `WorkItem` to prosta kolejka w istniejącym PostgreSQL. Obsługuje opóźnione naliczenie/wysyłkę i wygaśnięcie Checkout. Proces ponawia z opóźnieniem, przejmuje porzucone zadania po 2 minutach, a zakończonych nie wykonuje ponownie. **Proces musi działać**; sama otwarta strona nie jest jego zamiennikiem.
- `Delivery` przechowuje niezmienną treść i identyfikator maila. Resend dostaje stały klucz idempotencji. Niejednoznacznej wysyłki nie ponawiamy po 23 godzinach, ponieważ dostawca przechowuje klucze przez 24 godziny; stan `review` wymaga sprawdzenia w panelu.
- Resend może przyjąć wiadomość, a potem ją odbić. `accepted` oznacza przyjęcie do wysyłki, `delivered` doręczenie, `bounced` odbicie. Odebranie odbicia nie odbiera klientowi biletu i nie uruchamia ponownej wysyłki na nieistniejący adres.

Lista zagrożeń i zabezpieczeń jest w README, łącznie z Voucherify, Resend, sekretami i szkolnym modelem identyfikacji e-mailem.

## Pokaz dla prowadzącego

1. Wpisz nowy adres `delivered+pokaz01@resend.dev`. Zobacz 1000 punktów i tę samą kartę w panelu Voucherify.
2. Wybierz seans i fotel, zarezerwuj, kliknij „Użyj maks.”. Koszyk pokazuje **1000 pkt, 22 zł do dopłaty, 220 pkt za zakup**.
3. Zapłać kartą Stripe **4242 4242 4242 4242**, przyszła data, dowolne trzy cyfry CVC. Przy TTL 120 s dokończ przed upływem czasu.
4. Pokaż kod biletu oraz podsumowanie **22 zł / 1000 pkt / 220 pkt**. Odśwież stronę — kod się nie zmienia. W Voucherify saldo wynosi 220 punktów; w panelu Resend jest mail z kodem i takim samym podsumowaniem.
5. Powtórz dla `bounced+pokaz02@resend.dev`. Resend odrzuci doręczenie, ale bilet nadal działa. Testowe adresy są symulacją — wiadomości ogląda się w panelu Resend. Do rzeczywistej skrzynki bez własnej domeny można wysłać na adres właściciela konta.
6. Pokaż odmowę dla 1601 punktów przy cenie 3200 oraz odmowę wykorzystania więcej punktów niż saldo. Po odrzuceniu żądania nie powstaje tańsza sesja Stripe.
7. Opcjonalnie przerwij płatność i poczekaj na TTL. Przy działającym `npm run jobs` punkty wrócą, a rezerwacja nie dostanie biletu ani nagrody.

Za każdym kolejnym pokazem użyj innej etykiety po `+`, aby rzeczywiście był to nowy klient. Testy automatyczne działają na zaślepkach i nie zużywają godzinnego limitu Voucherify.

## Wdrożenie opcjonalne

Na serwerze ustaw te same serwerowe nazwy zmiennych oraz właściwy `APP_URL`. Użyj istniejącego procesu wdrożenia z `prisma migrate deploy`. Dla darmowego Vercel Hobby repozytorium zawiera `.github/workflows/process-jobs.yml`: harmonogram GitHub Actions wywołuje `/api/internal/jobs` co 5 minut. Sekret Actions `CRON_SECRET` musi odpowiadać zmiennej Vercel o tej samej nazwie. Zaległe operacje i oddawanie punktów mogą czekać do kolejnego uruchomienia (GitHub może dodatkowo opóźnić start). W Actions dostępne jest też ręczne Run workflow. Nie zakładaj, że długotrwały proces Node działa w funkcji serverless. Lokalny pokaz nadal korzysta z `npm run jobs`.

Aby strona rozróżniała doręczenie i odbicie w czasie rzeczywistym, w Resend dodaj webhook do publicznego `https://twoja-aplikacja/api/webhooks/resend`, zaznacz `email.delivered`, `email.bounced`, `email.failed`, `email.suppressed` i ustaw sekret w `RESEND_WEBHOOK_SECRET`. Lokalny adres 127.0.0.1 nie jest osiągalny dla Resend — bez tunelu sprawdzaj końcowy status w panelu; strona poprawnie pokazuje wtedy przyjęcie do wysyłki.

## Weryfikacja

```sh
npm run typecheck
npm run build -- --webpack
npm test
npm run test:vercel
npm run test:120
```

22 listopada 2026 sprawdzono rzeczywisty zakup przez Stripe 4242, webhook HTTP 200, Voucherify: 1000 → 0 → 220 pkt, mail doręczony do `delivered+…@resend.dev` i odbity dla `bounced+…@resend.dev`. W obu przypadkach powstał ważny bilet na 22 zł kartą + 1000 pkt, z nagrodą 220 pkt. Końcowy status potwierdzono przez API Resend. Bilet sprawdzono na 1440 px i 390 px; przy 390 px strona nie ma poziomego przewijania. Rzeczywisty test TTL 120 s zakończył się sukcesem po 122 s. Artefakty są w ignorowanym `output/playwright/`.

| Kontrola | Wynik |
|---|---|
| TypeScript i produkcyjny build Webpack | PASS |
| Testy jednostkowe | 13/13 |
| Testy API, wejście Nginx | 53/53 |
| Testy API, symulowane wejście Vercel | 53/53 |
| Rzeczywisty TTL 120 s | 1/1 |
| Render mobilny i desktopowy, rzeczywisty Checkout | PASS |
| Sekrety w 34 plikach JS klienta | Brak wartości sześciu skonfigurowanych sekretów |
| Compose produkcyjny i pakowanie procesu zadań w Dockerze | PASS |

Źródła: [Application Keys](https://docs.voucherify.io/guides/authentication), [zmiana punktów](https://docs.voucherify.io/api-reference/loyalties/adjust-loyalty-card-balance), [historia operacji](https://docs.voucherify.io/api-reference/loyalties/list-loyalty-card-transactions), [testowe adresy Resend](https://resend.com/docs/dashboard/emails/send-test-emails), [weryfikacja webhooków](https://resend.com/docs/webhooks/verify-webhooks-requests).
