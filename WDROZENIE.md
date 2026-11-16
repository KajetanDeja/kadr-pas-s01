# Etap II — co trzeba zrobić na kontach

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
5. Wyślij przygotowane zmiany do GitHub i uruchom deployment z tego commita. Build command jest już zapisany w `vercel.json`: **`npm run vercel-build`**. Wykona obie migracje w razie potrzeby i powtarzalny seed.
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
