# Wdrożenie CapCart na Render (darmowy plan) — krok po kroku

Efekt: publiczny adres typu `https://capcart.onrender.com`, który możesz wkleić do Devpost.

## Wymagania
- Repozytorium CapCart na GitHubie (z plikiem `render.yaml` w głównym katalogu).
- Klucze (wszystkie opcjonalne — bez nich aplikacja działa w trybie offline/symulacji):
  - `GEMINI_API_KEY` — Google AI Studio
  - `PAYPAL_CLIENT_ID` i `PAYPAL_CLIENT_SECRET` — aplikacja **sandbox** na developer.paypal.com

## Kroki
1. Wejdź na https://render.com i załóż darmowe konto (najwygodniej przez „Sign in with GitHub").
2. W panelu kliknij **New +** → **Blueprint**.
3. Połącz GitHub i wybierz repozytorium z CapCart (przy pierwszym razie nadaj Renderowi dostęp do tego repo).
4. Render wczyta `render.yaml` i pokaże usługę `capcart` (plan **Free**). Wklej wartości zmiennych:
   - `GEMINI_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` — Twoje klucze,
   - `BASE_URL` — możesz zostawić puste (aplikacja użyje adresu nadanego przez Render). Jeśli panel nie pozwala na puste pole, wpisz przewidywany adres, np. `https://capcart.onrender.com`.
5. Kliknij **Apply** / **Deploy Blueprint**. Pierwsze wdrożenie trwa 1-3 minuty.
6. Gdy status to **Live**, otwórz adres usługi (u góry strony usługi). Sprawdź: `/api/status` oraz `/openapi.yaml`.
7. Wklej ten adres w zgłoszeniu Devpost.

## Ważne uwagi
- **Pamięć jest tymczasowa.** Na darmowym planie dysk jest ulotny: `wallet.json` (miesięczny portfel) oraz zapisane plany znikają przy każdym restarcie i redeployu. Dla demo to wystarczy; portfel zacznie od pełnego limitu. Plik zapisujemy w `/tmp/wallet.json`.
- **Usypianie.** Darmowa usługa usypia się po ok. 15 minutach bezczynności; pierwsze wejście potem trwa ok. 30-60 s. Otwórz stronę chwilę przed pokazem dla jury.
- **PayPal sandbox.** Płatności zatwierdzaj kontem *sandbox personal*; prawdziwe pieniądze nie są pobierane.
- Zmiana kluczy później: Render → usługa → **Environment** → edytuj → zapisz (usługa uruchomi się ponownie).
