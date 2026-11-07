// AI diagnostics: node demo/ai-check.js
// Tests every Gemini model your key can use and Groq (if GROQ_API_KEY is set),
// using a tiny prompt, and prints how fast each one answers. Results are also appended to ai.log.
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));
process.env.AI_TIMEOUT_MS = process.env.AI_TIMEOUT_MS || '20000';
const s = require('../server.js');
const fs = require('fs');
const PROMPT = 'Return JSON {"ok": true, "answer": "pong"}';
const log = (l) => { console.log(l); try { fs.appendFileSync('ai.log', `${new Date().toISOString()} [CHECK] ${l}\n`); } catch {} };

async function time(fn) {
  const t0 = Date.now();
  try { await fn(); return `OK ${((Date.now() - t0) / 1000).toFixed(1)}s`; }
  catch (e) { return `FAIL ${((Date.now() - t0) / 1000).toFixed(1)}s — ${e.message.slice(0, 120)}`; }
}

(async () => {
  const env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
  const hasGemini = /^GEMINI_API_KEY=\S+/m.test(env) || !!process.env.GEMINI_API_KEY;
  const hasGroq = /^GROQ_API_KEY=\S+/m.test(env) || !!process.env.GROQ_API_KEY;
  log(`Keys: Gemini ${hasGemini ? 'yes' : 'no'}, Groq ${hasGroq ? 'yes' : 'no'}`);
  if (hasGemini) {
    const models = (await s.discoverModels()).slice(0, 4);
    for (const m of models) log(`Gemini ${m}: ${await time(() => s.callGemini(m, PROMPT))}`);
  }
  if (hasGroq) log(`Groq: ${await time(() => s.groqJSON(PROMPT))}`);
  log('Done. Tell Claude "sprawdź" — it reads ai.log.');
  process.exit(0);
})();
