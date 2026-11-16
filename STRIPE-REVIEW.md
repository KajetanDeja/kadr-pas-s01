# KADR — przegląd integracji Stripe

16 listopada 2026 wykonano instalację Stripe CLI i `stripe agent setup`, a następnie dwa rzeczywiste wywołania narzędzia `stripe_implementation_planner` na oficjalnym serwerze MCP Stripe. Narzędzie przyjęło wybór **Stripe-hosted Checkout, web**, zgodny z istniejącą aplikacją. Pełna odpowiedź jest lokalnym artefaktem w ignorowanym katalogu `output/stage-ii`.

## Kontekst przekazany plannerowi

- Szkolny projekt kina KADR, pojedynczy fotel i jednorazowa płatność kartą.
- Wyłącznie Stripe Sandbox/test, cena w groszach PLN, bez prawdziwych środków.
- Next.js App Router, TypeScript, PostgreSQL, Prisma i oficjalny SDK Stripe.
- Istniejący kontrakt API oraz ścisły TTL rezerwacji, w tym 120 sekund podczas oceniania.
- Bilet powstaje tylko po podpisanym webhooku; spóźniona płatność otrzymuje zwrot.
- Brak potrzeby subskrypcji, Connect, Payment Links, wysyłki lub własnego formularza kart.

## Porównanie istniejącego kodu z wybraną integracją

| Obszar | Wynik |
|---|---|
| Checkout Sessions tworzone na serwerze i przekierowanie na Stripe | Zgodne |
| Kwota z niezmiennej rezerwacji, PLN i client_reference_id | Zgodne |
| Dane karty wyłącznie na stronie Stripe | Zgodne |
| Podpis webhooka weryfikowany na surowym body | Zgodne |
| Bilet niezależny od odwiedzenia strony sukcesu | Zgodne |
| Ponowienia sesji, zdarzeń, biletów i zwrotów | Trwała idempotencja i ograniczenia PostgreSQL |
| Wygaśnięcie rezerwacji i wyścigi o fotel | Zachowany szkolny TTL, blokada fotela, pełny zwrot |
| Klucze testowe i sekret webhooka | Lokalny .env, bez logowania wartości i bez publikacji |

Ogólne drzewo planera proponuje także funkcje zwiększające konwersję. Zachowano nadrzędny kontrakt szkolny: PLN i płatność kartą. Adaptive Pricing zostało jawnie wyłączone dla nowych sesji, aby również wyświetlana waluta nie zależała od kraju klienta ani ustawień konta. Nie dodawano subskrypcji, podatków ani dodatkowych metod płatności.

## Lokalna konfiguracja

`npm run stripe:listen` pobiera klucz z .env, uruchamia Stripe CLI w trybie testowym i zapisuje sekret lokalnego webhooka. Klucz nie jest argumentem procesu, a sekrety są ukrywane w logach. Następnie aplikację uruchamia się w drugim terminalu. Nie należy kopiować lokalnego sekretu CLI do publicznego endpointu na Vercel.

## Wyniki z rzeczywistym Stripe Sandbox

Sprawdzono połączenie konta testowym kluczem oraz pełny przepływ przez rzeczywistą stronę Stripe Checkout i lokalny listener CLI:

- Karta 4242: 32 PLN, podpisany webhook HTTP 200, status paid i bilet z kodem.
- Karta odrzucana: brak biletu, status held, zachowany termin i ponowienie tej samej sesji.
- Karta 3D Secure: potwierdzenie na testowym ekranie uwierzytelnienia, następnie status paid i bilet.
- Płatność po terminie: status expired, pełny zwrot 32 PLN w Stripe i refundStatus=refunded, bez biletu.

Do scenariusza wygaśnięcia utworzono osobną rezerwację demonstracyjną i przesunięto wyłącznie jej czas w lokalnej bazie. Nie dodawano publicznej kontroli czasu. Wszystkie operacje były testowe, bez prawdziwych środków. Po doprecyzowaniu waluty ponownie przeszły build przez Webpack, 11 testów jednostkowych i 32 testy API.

Konfiguracja publiczna i dostęp nauczyciela pozostają opisane w [WDROZENIE.md](WDROZENIE.md). Lokalny test Sandbox nie oznacza publikacji aplikacji.
