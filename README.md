# Nagrywanie filmu demo / Recording the demo video

**PL – z prawdziwym AI i PayPal Sandbox (Windows, w folderze capcart):**
```
npm i playwright
npx playwright install chromium
node demo/record-demo.js --real
```
Otworzy się okno przeglądarki i film nagra się sam. Gdy pojawi się strona PayPal, zaloguj się **testowym kontem Sandbox** i kliknij „Pay” (masz na to 4 minuty). Film trafi do folderu `..\capcart-video` (plik .mp4, a jeśli nie masz ffmpeg, to .webm, który YouTube też przyjmuje).

**EN – offline (simulated AI + payments):** `node demo/record-demo.js`
