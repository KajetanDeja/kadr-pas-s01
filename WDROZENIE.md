# Etapy II–III — co trzeba zrobić na kontach

Kod jest przygotowany pod aktualizację istniejącego projektu Vercel powiązanego z `KajetanDeja/kadr-pas-s01`. Poniższe czynności wymagają dostępu właściciela kont. Nie wklejaj sekretów do repozytorium ani rozmowy.

## 1. Stripe w trybie testowym

1. Otwórz własne konto Stripe i wybierz tryb testowy. Przygotuj klucz **`sk_test_…`**.
2. W ustawieniach zespołu zaproś nauczyciela na jego e-mail i wybierz rolę **tylko do odczytu / View only**. Nie nadawaj roli administratora.
3. W Workbench → Webhooks / Event destinations dodaj endpoint **Snapshot** dla własnego konta: `https://TWOJ-OBECNY-ADRES/api/webhooks/stripe`.
4. Ustaw wersję API zgodną z SDK: **2026-10-28.endive**. Wybierz zdarzenia:

```text
checkout.session.completed
checkout.session.expired
refund.created
refund.updated
refund.failed
```

5. Skopiuj sekret tego endpointu **`whsec_…`**. Nie używaj tutaj sekretu wygenerowanego przez lokalne `stripe listen`.

## 2. Istniejący Vercel i baza

1. Wybierz istniejący projekt powiązany z repozytorium. Zachowaj jego domenę i bazę Prisma Postgres. Wykonaj kopię bazy przed wdrożeniem migracji.
2. W Settings → Environment Variables, dla **Production**, ustaw:

| Nazwa | Wartość |
|---|---|
| `STRIPE_SECRET_KEY` | Twój `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` publicznego endpointu z kroku 1 |
| `APP_URL` | `https://TWOJ-OBECNY-ADRES`, bez dodatkowej ścieżki |
| `RESERVATION_TTL_SECONDS` | `120` na sprawdzanie szkolne |

3. Zachowaj istniejące `DATABASE_URL` i `DATABASE_URL_POOLED` od integracji Prisma Postgres. Oba muszą używać `postgres://` lub `postgresql://`. Nie wpisuj lokalnych adresów Dockera, `TEST_DATABASE_URL`, `POSTGRES_*` ani `TRUSTED_PROXY_SECRET` do Vercela.
4. Wybierz Node.js **22.x albo 24.x**, pozostaw dostęp do systemowych zmiennych środowiskowych. Vercel sam dostarcza `VERCEL` i `VERCEL_ENV`.
5. Wyślij przygotowane zmiany do GitHub i uruchom deployment z tego commita. Build command jest już zapisany w `vercel.json`: **`npm run vercel-build`**. Wykona wymagane migracje w razie potrzeby i powtarzalny seed.
6. Sprawdź logi migracji i buildu. Nowe zmienne wymagają nowego deploymentu. Preview powinno mieć oddzielną bazę, sekrety webhooka i `APP_URL`.
7. Adres oraz webhook muszą być publicznie dostępne bez logowania do Vercela. Ustaw Deployment Protection tak, aby Stripe mógł dostarczać webhook na produkcyjny adres.

## 3. Sprawdzenie po publikacji

- `GET /api/events`: trzy seanse, każdy z dodatnią ceną w groszach.
- Rezerwacja: `amount=3200`, termin około 120 s, brak kodu przed zapłatą.
- Karta `4242 4242 4242 4242`: powrót do sklepu, chwilowe oczekiwanie, jeden kod i wydruk.
- Karta `4000 0000 0000 0002`: odmowa w Stripe; można poprawić kartę albo anulować i ponowić w czasie TTL.
- Karta `4000 0025 0000 3155`: przejście dodatkowego potwierdzenia; bilet dopiero po udanej płatności i webhooku.
- Anulowanie: powrót do tej samej rezerwacji z przyciskiem zapłaty i pierwotnym terminem.
- Odświeżenie, nowa karta przeglądarki i ponowione dostarczenie webhooka: ten sam kod, jeden bilet.
- Płatność zakończona po TTL: brak biletu, pełny testowy zwrot w Stripe, fotel pozostaje dostępny lub przy nowym właścicielu.
- W Workbench sprawdź odpowiedź 200 dla poprawnych webhooków. Przy 503 napraw konfigurację i ponów dostarczenie; aplikacja obsłuży duplikat bez drugiego biletu lub zwrotu.
- Potwierdź, że nauczyciel otrzymał dostęp tylko do odczytu.

Wszystkie płatności są testowe. Wyniki lokalnych testów z zastępczym Stripe nie zastępują kontroli publicznego wdrożenia.

## 4. Etap III: Voucherify, Resend i zaległe zadania

Dokładna konfiguracja i pokaz lokalny: [ETAP-III.md](ETAP-III.md). W tym samym projekcie Vercel ustaw również serwerowe `VOUCHERIFY_APPLICATION_ID`, `VOUCHERIFY_SECRET_KEY`, `VOUCHERIFY_API_URL`, `VOUCHERIFY_CAMPAIGN_ID`, `RESEND_API_KEY`, `RESEND_FROM` i losowy `CRON_SECRET` (minimum 32 znaki). Wykonaj nowy deployment. Żaden klucz nie trafia do kodu klienta.

Skonfiguruj cykliczne wywołanie `GET /api/internal/jobs` z `Authorization: Bearer <CRON_SECRET>`, np. raz na minutę. Bez harmonogramu nie można polegać na odrabianiu awarii ani zwrocie punktów porzuconych Checkout. Funkcja Vercel nie utrzymuje procesu `npm run jobs`; ten proces jest przeznaczony dla lokalnego komputera lub własnego serwera. Nie wymagamy płatnego planu do pokazu szkolnego — można użyć wersji lokalnej z działającym procesem zadań.

W Resend opcjonalnie dodaj publiczny webhook `/api/webhooks/resend` dla `email.delivered`, `email.bounced`, `email.failed`, `email.suppressed`, a jego sekret wpisz jako `RESEND_WEBHOOK_SECRET`. Dzięki temu strona pokaże końcowy status doręczenia; bez tego nadal wysyła bilet i pokazuje przyjęcie maila do wysyłki. Testuj na adresach `delivered+etykieta@resend.dev` i `bounced+etykieta@resend.dev`.

W szablonie własnego Dockera `deploy/compose.production.yaml` jest osobna usługa `jobs` korzystająca z tej samej bazy i konfiguracji aplikacji. Obraz zawiera skrypt procesu zadań. Przed uruchomieniem nowej wersji wykonaj migracje i seed; nie resetuj bazy. Samo ustawienie zmiennych lokalnego `.env` nie aktualizuje środowiska Vercel.
