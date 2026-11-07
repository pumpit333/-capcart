// CapCart — an AI shopping agent that never overspends.
// Zero dependencies: Node 18+ (built-in fetch + http).
// AI proposes, code guarantees: the LLM plans the cart, deterministic guardrails
// enforce the budget, and a human approves before any PayPal order is created.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- config ----------
loadDotEnv(path.join(__dirname, '.env'));
const PORT = Number(process.env.PORT || 3000);
// Public URL used for PayPal return links: explicit BASE_URL, else Render's RENDER_EXTERNAL_URL, else localhost.
const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const GROQ_API_KEY = (process.env.GROQ_API_KEY || '').trim(); // optional free fallback provider (console.groq.com)
const GROQ_MODEL = (process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim();
const HAS_AI = !!(GEMINI_API_KEY || GROQ_API_KEY);
let lastProvider = null; // e.g. "gemini-3.5-flash" or "groq llama-3.3-70b-versatile"
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const PAYPAL_CLIENT_ID = (process.env.PAYPAL_CLIENT_ID || '').trim();
const PAYPAL_CLIENT_SECRET = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
const PAYPAL_API = process.env.PAYPAL_API || 'https://api-m.sandbox.paypal.com';
const HARD_CAP = Number(process.env.HARD_CAP || 500); // absolute ceiling per order, USD
const CURRENCY = 'USD';

// Mirror [AI] log lines to ai.log (helps debugging without copying terminal output)
const AI_LOG = path.join(__dirname, 'ai.log');
for (const level of ['log', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    const line = args.map(String).join(' ');
    if (line.startsWith('[AI]') || line.startsWith('CapCart running')) { try { fs.appendFileSync(AI_LOG, `${new Date().toISOString()} ${line}\n`); } catch {} }
  };
}
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
const POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, 'policies.json'), 'utf8'));
const WALLET_FILE = process.env.WALLET_FILE || path.join(__dirname, 'wallet.json');
const MONTHLY_BUDGET = Number(process.env.MONTHLY_BUDGET || POLICY.monthlyBudget || 300);
const sessions = new Map(); // planId -> { request, intent, plan, audit, order }

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const money = (n) => Math.round(n * 100) / 100;

// ---------- wallet: monthly budget persisted in a JSON file ----------
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
function walletLoad() {
  let w = null;
  try { w = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8')); } catch { /* new wallet */ }
  if (!w || w.month !== monthKey()) w = { month: monthKey(), limit: MONTHLY_BUDGET, spent: 0, history: [] }; // new month resets
  w.limit = MONTHLY_BUDGET;
  w.remaining = money(w.limit - w.spent);
  return w;
}
function walletSpend(amount, ref) {
  const w = walletLoad();
  if (amount > w.remaining) throw new Error(`Wallet: ${amount} exceeds remaining monthly budget ${w.remaining}.`);
  w.spent = money(w.spent + amount);
  w.history.push({ at: new Date().toISOString(), amount, ref });
  const { remaining, ...onDisk } = w;
  fs.writeFileSync(WALLET_FILE, JSON.stringify(onDisk, null, 2));
  return walletLoad();
}

// ---------- prompt-injection defense ----------
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(the\s+)?(system|previous|above)/i,
  /\b(admin|developer|system)\s+mode\b/i,
  /you\s+are\s+now\b/i,
  /(disable|bypass|remove|override)\s+(the\s+)?(budget|limit|guardrails?|cap|policy)/i,
  /approve\s+(the\s+)?payment/i,
  /\b(system|assistant)\s*:/i,
];
const looksInjected = (text) => INJECTION_PATTERNS.some((re) => re.test(String(text || '')));
// Untrusted catalog text never reaches the model prompt unless it passes this filter.
const productInjected = (p) => looksInjected(p.name) || looksInjected(p.description) || (p.tags || []).some(looksInjected);

// ---------- AI layer ----------
// Models are tried in order; the first one that works is remembered.
const MODEL_CHAIN = [...new Set([GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-flash-lite-latest'])];
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 30000);
const AI_TOTAL_MS = Number(process.env.AI_TOTAL_MS || 50000); // max AI time per step before falling back
const deadModels = new Set(); // models that returned 404 / 'no longer available'
let workingModel = null;

const noThinkingCfg = new Set(); // models that rejected thinkingConfig
function thinkingCfgFor(model) {
  if (noThinkingCfg.has(model)) return undefined;
  if (/gemini-3/.test(model)) return { thinkingLevel: 'low' };
  if (/gemini-2\.5/.test(model)) return { thinkingBudget: 0 };
  return undefined;
}

async function callGemini(model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const ctrl = new AbortController();
  const tmo = GROQ_API_KEY ? Math.min(AI_TIMEOUT_MS, 12000) : AI_TIMEOUT_MS; // with a fallback configured, don't wait long
  const timer = setTimeout(() => ctrl.abort(), tmo);
  const t0 = Date.now();
  let res;
  try {
  res = await fetch(url, {
    method: 'POST',
    signal: ctrl.signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2, ...(thinkingCfgFor(model) ? { thinkingConfig: thinkingCfgFor(model) } : {}) },
    }),
  });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? `Gemini ${model} timed out after ${tmo / 1000}s` : `Gemini ${model}: ${e.message}`);
    err.status = e.name === 'AbortError' ? 504 : 0;
    throw err;
  } finally { clearTimeout(timer); }
  if (res.ok) console.log(`[AI] ${model} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!res.ok) {
    let msg = await res.text();
    try { msg = JSON.parse(msg)?.error?.message || msg; } catch {}
    if (res.status === 400 && /thinking/i.test(String(msg)) && !noThinkingCfg.has(model)) { noThinkingCfg.add(model); console.error(`[AI] ${model} rejected thinkingConfig, retrying without it`); return callGemini(model, prompt); }
    const err = new Error(`Gemini ${model} HTTP ${res.status}: ${String(msg).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  let text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim() || '{}';
  if (!parts.length) console.error(`[AI] empty response: ${JSON.stringify(data).slice(0, 300)}`);
  text = text.replace(/^```(?:json)?\s*|\s*```$/g, '');
  return JSON.parse(text);
}

// Ask Google which models this key can use; prefer small, fast "flash" text models.
let discovered = null;
async function discoverModels() {
  if (discovered) return discovered;
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': GEMINI_API_KEY } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const names = ((await res.json()).models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /flash/.test(n) && !/(image|tts|audio|live|embedding|vision|exp|preview-\d{2}-\d{2})/.test(n));
    const score = (n) => (/lite/.test(n) ? 1 : 0) + (/latest/.test(n) ? 0.5 : 0) - (parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]) || 0) / 10;
    discovered = names.sort((a, b) => score(a) - score(b));
    console.log(`[AI] models available for this key: ${discovered.slice(0, 6).join(', ') || 'none found'}`);
  } catch (e) {
    console.error(`[AI] could not list models (${e.message}); using built-in list`);
    discovered = [];
  }
  return discovered;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let aiCooldownUntil = 0; // set when every model reports quota exhaustion (429)
async function geminiJSON(prompt) {
  if (!GEMINI_API_KEY) { const e = new Error('no GEMINI_API_KEY'); e.status = 0; throw e; }
  if (Date.now() < aiCooldownUntil) { const e = new Error(`Gemini quota exhausted for all models — pausing AI for ${Math.ceil((aiCooldownUntil - Date.now()) / 1000)}s`); e.status = 429; throw e; }
  const models = workingModel
    ? [workingModel, ...MODEL_CHAIN.filter((m) => m !== workingModel)]
    : [...new Set([GEMINI_MODEL, ...(await discoverModels()), ...MODEL_CHAIN])];
  let lastErr;
  const deadline = Date.now() + (GROQ_API_KEY ? Math.min(AI_TOTAL_MS, 13000) : AI_TOTAL_MS);
  for (const m of models.filter((x) => !deadModels.has(x)).slice(0, 4)) {
    if (Date.now() > deadline) break;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() > deadline) break;
      try {
        const out = await callGemini(m, prompt);
        if (workingModel !== m) console.log(`[AI] using model ${m}`);
        workingModel = m;
        lastProvider = m;
        return out;
      } catch (e) {
        lastErr = e;
        console.error(`[AI] ${e.message}`);
        if (e.status === 503 || e.status === 500) { await sleep(1000); continue; } // overloaded: retry, then next model
        if (e.status === 404) deadModels.add(m);
        break; // 404/400 etc.: try next model
      }
    }
    if (lastErr && (lastErr.status === 401 || lastErr.status === 403)) break; // bad key: no point trying other models
  }
  if (lastErr && lastErr.status === 429) { aiCooldownUntil = Date.now() + 60000; console.error('[AI] all models out of quota — pausing AI calls for 60s'); }
  throw lastErr;
}

// --- Groq (OpenAI-compatible) fallback ---
let groqModel = GROQ_MODEL;
async function groqJSON(prompt, retried = false) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: groqModel, temperature: 0.2, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: 'You are a JSON API. Reply with exactly one JSON object and nothing else.' }, { role: 'user', content: prompt }] }),
    });
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? `Groq ${groqModel} timed out after ${AI_TIMEOUT_MS / 1000}s` : `Groq: ${e.message}`); err.status = e.name === 'AbortError' ? 504 : 0; throw err;
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    let msg = await res.text(); try { msg = JSON.parse(msg)?.error?.message || msg; } catch {}
    if (!retried && (res.status === 404 || /decommission|does not exist|not found/i.test(String(msg)))) {
      try {
        const list = await (await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${GROQ_API_KEY}` } })).json();
        const pick = (list.data || []).map((m) => m.id).find((id) => /llama|gpt-oss|qwen|kimi/i.test(id) && !/guard|whisper|tts|vision|instant/i.test(id));
        if (pick) { console.log(`[AI] Groq model ${groqModel} unavailable, switching to ${pick}`); groqModel = pick; return groqJSON(prompt, true); }
      } catch {}
    }
    if (!retried && (res.status === 429 || res.status === 503)) { await sleep(1500); return groqJSON(prompt, true); }
    const err = new Error(`Groq ${groqModel} HTTP ${res.status}: ${String(msg).slice(0, 200)}`); err.status = res.status; throw err;
  }
  const data = await res.json();
  console.log(`[AI] groq ${groqModel} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  let text = (data?.choices?.[0]?.message?.content || '{}').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  lastProvider = `groq ${groqModel}`;
  return JSON.parse(text);
}

let geminiSkipUntil = 0;
// Gemini first, Groq as fallback (either can be configured alone).
async function llmJSON(prompt) {
  if (!HAS_AI) return null; // offline/mock mode
  if (GEMINI_API_KEY && Date.now() > geminiSkipUntil) {
    try { return await geminiJSON(prompt); }
    catch (e) {
      if (!GROQ_API_KEY) throw e;
      geminiSkipUntil = Date.now() + 5 * 60000; // Gemini is struggling: use Groq for the next 5 minutes
      console.error(`[AI] Gemini failed (${e.message}) — using Groq for the next 5 min`);
    }
  }
  try { return await groqJSON(prompt); }
  catch (e) { console.error(`[AI] ${e.message}`); throw e; }
}

// Preferences (size/color) pulled from free text by regex; also used to back up the AI's answer.
const COLOR_WORDS = ['black', 'white', 'blue', 'red', 'green', 'yellow', 'grey', 'gray', 'pink', 'orange', 'purple', 'brown'];
const SIZE_RE = /\b(?:size|rozmiar)\s*[:=]?\s*(xxl|xl|xs|s|m|l|\d{1,2}(?:[.,]5)?)\b/i;
function extractPreferences(request) {
  const prefs = {};
  const sm = String(request).match(SIZE_RE);
  if (sm) prefs.size = sm[1].replace(',', '.').toUpperCase();
  const cm = String(request).toLowerCase().match(new RegExp(`\\b(${COLOR_WORDS.join('|')})\\b`));
  if (cm) prefs.color = cm[1] === 'gray' ? 'grey' : cm[1];
  return prefs;
}
function cleanPrefs(p) {
  const out = {};
  if (p && typeof p === 'object' && !Array.isArray(p)) for (const [k, v] of Object.entries(p)) if (v != null && v !== '' && typeof v !== 'object') out[String(k).toLowerCase()] = String(v);
  return out;
}

// Step 1: understand the request (goal, budget, keywords).
async function interpret(request, opts = {}) {
  const prompt = `You are the intake step of a shopping agent. Extract structured intent from the user's request.
Return JSON: {"goal": string, "budget": number|null, "keywords": string[] (3-8 lowercase words useful to match products), "maxItems": number (1-5), "preferences": object (optional, e.g. {"size":"42","color":"blue"}; only values the user explicitly stated)}.
If no budget is stated, budget = null. Request: """${request}"""`;
  let ai = opts.skipAI ? null : await llmJSON(prompt).catch((e) => ({ error: e.message }));
  if (Array.isArray(ai)) ai = ai[0] || {};
  if (ai && !ai.error) {
    let kw = ai.keywords ?? ai.keyword ?? ai.tags;
    if (typeof kw === 'string') kw = kw.split(/[,\s]+/);
    if (Array.isArray(kw) && kw.length) {
      const budget = ai.budget == null || ai.budget === '' ? null : Number(String(ai.budget).replace(/[^0-9.]/g, '')) || null;
      return { goal: ai.goal || request, budget, keywords: kw.map((k) => String(k).toLowerCase()), maxItems: Math.min(5, Math.max(1, Number(ai.maxItems) || 3)), preferences: { ...extractPreferences(request), ...cleanPrefs(ai.preferences) }, source: 'ai' };
    }
    ai = { error: `AI returned an unexpected format (keys: ${Object.keys(ai || {}).join(', ') || 'none'})` };
    console.error(`[AI] ${ai.error}`);
  }
  // heuristic fallback
  const b = request.replace(new RegExp(SIZE_RE.source, 'ig'), ' ').match(/\$?\s?(\d+(?:[.,]\d+)?)\s?(?:\$|usd|dollars)?/i);
  const words = request.toLowerCase().match(/[a-z]+/g) || [];
  const stop = new Set(['a', 'an', 'the', 'for', 'my', 'me', 'buy', 'get', 'under', 'up', 'to', 'with', 'and', 'of', 'who', 'is', 'loves', 'likes', 'something', 'some', 'gift', 'usd', 'dollars']);
  const keywords = [...new Set(words.filter((w) => !stop.has(w) && w.length > 2))]
    .map((w) => w.replace(/s$/, ''))
    .slice(0, 8);
  if (/gift|present/i.test(request)) keywords.push('gift');
  return { goal: request, budget: b ? Number(b[1].replace(',', '.')) : null, keywords, maxItems: 3, preferences: extractPreferences(request), source: 'heuristic', aiError: ai?.error };
}

// Step 2: retrieve candidates deterministically.
function retrieve(intent) {
  const kw = (intent.keywords || []).map((k) => k.toLowerCase());
  return CATALOG.map((p) => {
    const hay = [p.name.toLowerCase(), p.category, ...p.tags].join(' ');
    const score = kw.reduce((s, k) => s + (hay.includes(k) ? 1 : 0), 0);
    return { ...p, score, injected: productInjected(p) };
  })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.price - b.price)
    .slice(0, 10);
}

// One-call mode: intent + cart plan in a single Gemini request (halves quota use and latency).
async function agentPlanOneCall(request) {
  if (!HAS_AI) return null;
  const visible = CATALOG.filter((p) => !productInjected(p)).map(({ id, name, category, price, tags, variants }) => ({ id, name, category, price, tags, ...(variants ? { variants: Object.keys(variants) } : {}) }));
  const prompt = `You are CapCart, a careful shopping agent. Only these products exist (JSON): ${JSON.stringify(visible)}
User request: """${request}"""
Return ONE JSON object: {"goal": string, "budget": number|null (only if the user stated one), "keywords": string[] (3-8 lowercase words), "preferences": object (only values the user explicitly stated, e.g. {"size":"42","color":"blue"}), "items": [{"id": string, "qty": number, "reason": string}], "summary": string, "tradeoffs": string}.
Rules: pick at most 5 items, only from the list above; stay within the budget; if nothing in the list matches the request, return "items": [] and explain in "summary"; never choose sizes or colours yourself (the system asks the user).`;
  let ai = await llmJSON(prompt).catch((e) => ({ error: e.message }));
  if (Array.isArray(ai)) ai = ai[0] || {};
  if (!ai || ai.error || !Array.isArray(ai.items)) return { error: ai?.error || `AI returned an unexpected format (keys: ${Object.keys(ai || {}).join(', ') || 'none'})` };
  let kw = ai.keywords ?? [];
  if (typeof kw === 'string') kw = kw.split(/[,\s]+/);
  const budget = ai.budget == null || ai.budget === '' ? null : Number(String(ai.budget).replace(/[^0-9.]/g, '')) || null;
  const intent = { goal: ai.goal || request, budget, keywords: kw.map((k) => String(k).toLowerCase()).filter(Boolean), maxItems: 5, preferences: { ...extractPreferences(request), ...cleanPrefs(ai.preferences) }, source: 'ai (single call)' };
  const plan = { items: ai.items.map((it) => (typeof it === 'string' ? { id: it, qty: 1 } : { id: it.id || it.productId, qty: it.qty || it.quantity || 1, reason: it.reason || '' })), summary: ai.summary || '', tradeoffs: ai.tradeoffs || '', source: 'ai' };
  return { intent, plan };
}

// Step 3: AI plans the cart from candidates.
async function planCart(intent, candidates, opts = {}) {
  if (!candidates.filter((c) => !c.injected).length) {
    return { items: [], summary: '', tradeoffs: '', source: 'code (no matching products, AI call skipped)' };
  }
  const prompt = `You are a careful shopping agent. Goal: "${intent.goal}". Budget: ${intent.budget ?? 'not stated'} USD (must not be exceeded). Max items: ${intent.maxItems || 3}.
Some products have variants (size/color). Never invent, choose or output variants: the system asks the user for them afterwards.
Choose the best combination ONLY from these candidates (use their ids):
${JSON.stringify(candidates.filter((c) => !c.injected).map(({ id, name, price, tags }) => ({ id, name, price, tags })))}
Return JSON: {"items":[{"id":string,"qty":number,"reason":string}], "summary": string, "tradeoffs": string}.`;
  let ai = opts.skipAI ? null : await llmJSON(prompt).catch((e) => ({ error: e.message }));
  let plan = ai;
  if (Array.isArray(plan)) plan = { items: plan };
  if (plan && !plan.error) {
    const items = plan.items || plan.cart || plan.selected || plan.products;
    if (Array.isArray(items)) {
      return { items: items.map((it) => (typeof it === 'string' ? { id: it, qty: 1 } : { id: it.id || it.productId, qty: it.qty || it.quantity || 1, reason: it.reason || '' })), summary: plan.summary || '', tradeoffs: plan.tradeoffs || '', source: 'ai' };
    }
    plan = { error: `AI returned an unexpected format (keys: ${Object.keys(plan).join(', ') || 'none'})` };
    console.error(`[AI] ${plan.error}`);
  }
  ai = plan;
  // greedy fallback: highest relevance first, fit in budget
  const budget = intent.budget ?? HARD_CAP;
  const items = [];
  let total = 0;
  for (const c of candidates) {
    if (c.injected) continue;
    if (items.length >= (intent.maxItems || 3)) break;
    if (total + c.price <= budget) {
      items.push({ id: c.id, qty: 1, reason: `Matches ${c.score} of your keywords` });
      total += c.price;
    }
  }
  return { items, summary: 'Greedy plan (offline mode): most relevant items that fit the budget.', tradeoffs: '', source: 'heuristic', aiError: ai?.error };
}

// Step 4: guardrails — code, not the model, has the final word.
// Order: injection quarantine -> blocked categories -> per-category caps -> budget (incl. wallet).
function enforceGuardrails(intent, plan, opts = {}) {
  const policy = opts.policy || POLICY;
  const walletRemaining = opts.walletRemaining ?? walletLoad().remaining;
  const audit = [];
  const budget = money(Math.min(intent.budget ?? HARD_CAP, HARD_CAP, walletRemaining));
  if (budget < (intent.budget ?? HARD_CAP)) {
    audit.push(`Effective cap lowered to ${budget} ${CURRENCY} (hard cap ${HARD_CAP}, monthly wallet left ${walletRemaining}).`);
  }
  let lines = [];
  for (const it of plan.items || []) {
    const p = CATALOG.find((c) => c.id === it.id);
    if (!p) { audit.push(`Rejected unknown product id "${it.id}" (possible hallucination).`); continue; }
    if (productInjected(p)) { audit.push(`BLOCKED prompt injection in catalog item "${p.name}" (${p.id}): untrusted text tried to give the agent instructions. Item quarantined.`); continue; }
    if ((policy.blockedCategories || []).includes(p.category)) { audit.push(`Policy: category "${p.category}" is blocked — removed ${p.name}.`); continue; }
    const qty = Math.max(1, Math.min(5, Math.floor(Number(it.qty) || 1)));
    if (qty !== it.qty) audit.push(`Normalised quantity for ${p.name} to ${qty}.`);
    lines.push({ ...p, qty, reason: it.reason || '', lineTotal: money(p.price * qty) });
  }
  // per-category caps: reduce quantity first, then drop the line
  for (const [cat, cap] of Object.entries(policy.categoryCaps || {})) {
    const catTotal = () => money(lines.filter((l) => l.category === cat).reduce((s, l) => s + l.lineTotal, 0));
    while (catTotal() > cap) {
      const l = lines.filter((x) => x.category === cat).sort((a, b) => b.lineTotal - a.lineTotal)[0];
      if (l.qty > 1) { l.qty -= 1; l.lineTotal = money(l.price * l.qty); audit.push(`Policy: ${cat} capped at ${cap} per order — reduced ${l.name} to qty ${l.qty}.`); }
      else { lines = lines.filter((x) => x !== l); audit.push(`Policy: ${cat} capped at ${cap} per order — dropped ${l.name}.`); }
    }
  }
  let total = money(lines.reduce((s, l) => s + l.lineTotal, 0));
  while (total > budget && lines.length) {
    lines.sort((a, b) => b.lineTotal - a.lineTotal);
    const dropped = lines.shift();
    audit.push(`Over budget (${total} > ${budget}) — dropped ${dropped.name}.`);
    total = money(lines.reduce((s, l) => s + l.lineTotal, 0));
  }
  audit.push(`Final total ${total} ${CURRENCY} ≤ cap ${budget} ${CURRENCY}. Waiting for human approval.`);
  return { lines, total, budget, audit };
}

// ---------- variants & clarifying questions (code decides, never the model) ----------
const matchOption = (options, v) => (options || []).find((o) => String(o).toLowerCase() === String(v).toLowerCase());
const variantLabel = (l) => (l.variant && Object.keys(l.variant).length ? ` (${Object.entries(l.variant).map(([k, v]) => `${k} ${v}`).join(', ')})` : '');
// Fill variants from stated preferences when valid, then (re)build the list of open questions.
function resolveVariants(cart, preferences = {}) {
  const questions = [];
  for (const l of cart.lines) {
    if (!l.variants) continue;
    l.variant = l.variant || {};
    for (const [attr, options] of Object.entries(l.variants)) {
      if (l.variant[attr]) continue;
      const hit = preferences[attr] != null ? matchOption(options, preferences[attr]) : undefined;
      if (hit) { l.variant[attr] = hit; continue; }
      questions.push({ productId: l.id, name: l.name, attribute: attr, options, question: `What ${attr} should the ${l.name} be?` });
    }
  }
  return questions;
}

// ---------- PayPal (sandbox) ----------
async function paypalToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status}`);
  return (await res.json()).access_token;
}

async function createPayPalOrder(planId, cart) {
  if (!PAYPAL_CLIENT_ID) {
    return { id: `SIMULATED-${planId.slice(0, 8)}`, approveUrl: `${BASE_URL}/return?token=SIMULATED-${planId.slice(0, 8)}&plan=${planId}`, simulated: true };
  }
  const token = await paypalToken();
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: planId,
      description: 'CapCart agent order',
      amount: {
        currency_code: CURRENCY,
        value: cart.total.toFixed(2),
        breakdown: { item_total: { currency_code: CURRENCY, value: cart.total.toFixed(2) } },
      },
      items: cart.lines.map((l) => ({ name: (l.name + variantLabel(l)).slice(0, 127), quantity: String(l.qty), unit_amount: { currency_code: CURRENCY, value: l.price.toFixed(2) }, sku: l.id })),
    }],
    payment_source: { paypal: { experience_context: { return_url: `${BASE_URL}/return?plan=${planId}`, cancel_url: `${BASE_URL}/?cancelled=1`, user_action: 'PAY_NOW', brand_name: 'CapCart' } } },
  };
  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal create order failed: ${JSON.stringify(data)}`);
  const approve = (data.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return { id: data.id, approveUrl: approve?.href, simulated: false };
}

async function capturePayPalOrder(orderId) {
  if (orderId.startsWith('SIMULATED-')) return { status: 'COMPLETED', id: orderId, simulated: true };
  const token = await paypalToken();
  const res = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`PayPal capture failed: ${JSON.stringify(data)}`);
  return { status: data.status, id: data.id, simulated: false };
}

// ---------- HTTP ----------
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

function planResponse(planId, s) {
  return { planId, intent: s.intent, summary: s.plan.summary, tradeoffs: s.plan.tradeoffs, cart: s.cart, questions: s.questions || [], audit: s.audit };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/openapi.yaml') {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'openapi.yaml'), 'utf8'), 'application/yaml; charset=utf-8');
    }
    if (req.method === 'GET' && /^\/img\/[A-Za-z0-9_-]+\.svg$/.test(url.pathname)) {
      const imgDir = path.join(__dirname, 'public', 'img');
      const file = path.resolve(imgDir, path.basename(url.pathname));
      if (!file.startsWith(imgDir + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
      return send(res, 200, fs.readFileSync(file), 'image/svg+xml');
    }
    if (req.method === 'GET' && url.pathname === '/api/catalog') {
      return send(res, 200, CATALOG.filter((p) => !productInjected(p)).map(({ id, name, category, price, image, variants, tags }) => ({ id, name, category, price, image, variants, tags })));
    }
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, { ai: HAS_AI ? (lastProvider || [GEMINI_API_KEY && `gemini (${workingModel || GEMINI_MODEL})`, GROQ_API_KEY && `groq (${groqModel})`].filter(Boolean).join(' + ')) : 'offline heuristic — no AI key', paypal: PAYPAL_CLIENT_ID ? 'sandbox' : 'simulated', hardCap: HARD_CAP });
    }
    if (req.method === 'GET' && url.pathname === '/api/wallet') {
      return send(res, 200, { wallet: walletLoad(), policy: POLICY });
    }
    if (req.method === 'POST' && url.pathname === '/api/plan') {
      const { request } = await readBody(req);
      if (!request || request.length > 500) return send(res, 400, { error: 'Request must be 1-500 characters.' });
      let intent, candidates, plan, oneCallError;
      const one = await agentPlanOneCall(request);
      if (one && !one.error) {
        ({ intent, plan } = one);
        candidates = CATALOG.filter((p) => productInjected(p) || plan.items.some((it) => it.id === p.id)).map((p) => ({ ...p, injected: productInjected(p) }));
      } else {
        oneCallError = one?.error;
        intent = await interpret(request, { skipAI: !!oneCallError });
        if (oneCallError) intent.aiError = oneCallError;
        candidates = retrieve(intent);
        plan = await planCart(intent, candidates, { skipAI: !!oneCallError });
        if (oneCallError) plan.aiError = oneCallError;
      }
      const cart = enforceGuardrails(intent, plan);
      const planId = crypto.randomUUID();
      const audit = [
        `Intent parsed by ${intent.source}: budget=${intent.budget ?? 'none'}, keywords=${(intent.keywords || []).join(', ')}`,
        one && !one.error ? `AI reviewed the full catalogue (${CATALOG.length - CATALOG.filter(productInjected).length} products) in one call.` : `Retrieved ${candidates.length} candidate products from catalog.`,
        ...candidates.filter((c) => c.injected).map((c) => `Quarantined "${c.name}" (${c.id}) before planning: its text contains a prompt-injection attempt, so it is hidden from the AI.`),
        ...(!HAS_AI ? ['AI offline: no GEMINI_API_KEY or GROQ_API_KEY in .env, so heuristic fallback was used.'] : (one && !one.error && lastProvider ? [`AI provider: ${lastProvider}.`] : [])),
        ...(intent.aiError ? [`AI unavailable for intent, used fallback — ${intent.aiError}`] : []),
        `Cart planned by ${plan.source}.`,
        ...(plan.aiError && plan.aiError !== intent.aiError ? [`AI unavailable for planning, used fallback — ${plan.aiError}`] : []),
        ...cart.audit,
      ];
      const questions = resolveVariants(cart, intent.preferences);
      for (const l of cart.lines) if (l.variant && Object.keys(l.variant).length) audit.push(`Variant for ${l.name} set from your request:${variantLabel(l)}.`);
      audit.push(`Agent asked ${questions.length} clarifying question(s)${questions.length ? ' — answer them before approving.' : '.'}`);
      // If guardrails changed the AI's cart, replace the AI's (now wrong) summary with an honest, code-generated one.
      const proposed = (plan.items || []).map((it) => ({ p: CATALOG.find((c) => c.id === it.id), qty: Math.max(1, Math.floor(Number(it.qty) || 1)) })).filter((x) => x.p);
      const finalIds = new Set(cart.lines.map((l) => l.id));
      const removed = proposed.filter((x) => !finalIds.has(x.p.id));
      const changedQty = cart.lines.some((l) => { const o = proposed.find((x) => x.p.id === l.id); return o && o.qty !== l.qty; });
      if (plan.source === 'ai' && (removed.length || changedQty)) {
        const proposedTotal = money(proposed.reduce((s, x) => s + x.p.price * x.qty, 0));
        const finalNames = cart.lines.map((l) => l.name).join(', ') || 'nothing';
        plan.aiSummary = plan.summary;
        plan.summary = `The AI proposed ${proposed.length} item(s) for $${proposedTotal.toFixed(2)}, which broke your rules (budget $${cart.budget.toFixed(2)} / spending policies). Code ${removed.length ? `removed ${removed.map((x) => x.p.name).join(', ')}` : 'reduced quantities'} before anything could be paid. Final cart: ${finalNames} for $${cart.total.toFixed(2)}.`;
        plan.tradeoffs = '';
        audit.push(`Guardrails overrode the AI plan: $${proposedTotal.toFixed(2)} → $${cart.total.toFixed(2)}.`);
      }
      if (!cart.lines.length) {
        const cats = [...new Set(CATALOG.filter((p) => !p.injected && !/poison|injection/i.test(p.description || '')).map((p) => p.category).filter((c) => !(POLICY.blockedCategories || []).includes(c)))].join(', ');
        plan.summary = `I couldn't find anything matching "${request.slice(0, 80)}" in this store's catalogue, so I didn't add anything — I won't buy a substitute without asking. This store carries: ${cats}. Try e.g. "running T-shirt size M under $30".`;
        plan.tradeoffs = '';
        audit.push('No matching products: agent declined to substitute and asked the user to rephrase.');
      }
      sessions.set(planId, { request, intent, plan, cart, audit, questions, approved: false });
      return send(res, 200, planResponse(planId, sessions.get(planId)));
    }
    if (req.method === 'POST' && url.pathname === '/api/answer') {
      const { planId, answers } = await readBody(req);
      const s = sessions.get(planId);
      if (!s) return send(res, 404, { error: 'Unknown plan.' });
      if (s.order) return send(res, 400, { error: 'Plan already approved.' });
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return send(res, 400, { error: 'answers must be an object like {"p23":{"size":"42"}}.' });
      const chosen = [];
      for (const [pid, attrs] of Object.entries(answers)) {
        const line = s.cart.lines.find((l) => l.id === pid);
        if (!line) return send(res, 400, { error: `Product ${pid} is not in the cart.` });
        if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return send(res, 400, { error: `Answers for ${pid} must be an object.` });
        for (const [attr, val] of Object.entries(attrs)) {
          const opts = line.variants && line.variants[attr];
          if (!opts) return send(res, 400, { error: `${line.name} has no "${attr}" option.` });
          const hit = matchOption(opts, val);
          if (!hit) return send(res, 400, { error: `Invalid ${attr} "${val}" for ${line.name}. Options: ${opts.join(', ')}.` });
          chosen.push([line, attr, hit]);
        }
      }
      for (const [line, attr, hit] of chosen) {
        line.variant = { ...(line.variant || {}), [attr]: hit };
        s.audit.push(`User chose ${attr} ${hit} for ${line.name}.`);
      }
      s.questions = resolveVariants(s.cart);
      s.audit.push(s.questions.length ? `${s.questions.length} clarifying question(s) still open.` : 'All clarifying questions answered. Waiting for human approval.');
      return send(res, 200, planResponse(planId, s));
    }
    if (req.method === 'GET' && url.pathname === '/api/plan') {
      const s = sessions.get(url.searchParams.get('id'));
      if (!s) return send(res, 404, { error: 'Unknown plan.' });
      return send(res, 200, { cart: s.cart, questions: s.questions || [], audit: s.audit, order: s.order || null });
    }
    if (req.method === 'POST' && url.pathname === '/api/approve') {
      const { planId } = await readBody(req);
      const s = sessions.get(planId);
      if (!s) return send(res, 404, { error: 'Unknown plan.' });
      if (!s.order && (s.questions || []).length) return send(res, 400, { error: "Answer the agent's questions first." });
      if (!s.cart.lines.length) return send(res, 400, { error: 'Empty cart — nothing to pay.' });
      if (s.cart.total > s.cart.budget || s.cart.total > HARD_CAP) return send(res, 400, { error: 'Guardrail: total exceeds cap.' });
      if (s.order) return send(res, 200, { order: s.order, audit: s.audit, wallet: walletLoad() });
      const w = walletLoad();
      if (s.cart.total > w.remaining) return send(res, 400, { error: `Guardrail: total exceeds remaining monthly budget (${w.remaining}).` });
      s.approved = true;
      s.order = await createPayPalOrder(planId, s.cart);
      const after = walletSpend(s.cart.total, s.order.id);
      s.audit.push(`Wallet: ${s.cart.total} ${CURRENCY} charged to monthly budget — ${after.remaining} of ${after.limit} left this month.`);
      s.audit.push(`Human approved. PayPal order ${s.order.id} created${s.order.simulated ? ' (simulated)' : ' in sandbox'}.`);
      return send(res, 200, { order: s.order, audit: s.audit, wallet: walletLoad() });
    }
    if (req.method === 'GET' && url.pathname === '/return') {
      const planId = url.searchParams.get('plan');
      const s = sessions.get(planId);
      const orderId = url.searchParams.get('token') || s?.order?.id;
      if (!s || !orderId) return send(res, 400, 'Unknown order', 'text/plain');
      const cap = await capturePayPalOrder(orderId);
      s.audit.push(`Payment ${cap.status} (order ${cap.id}).`);
      res.writeHead(302, { Location: `/?paid=1&plan=${encodeURIComponent(planId)}` });
      return res.end();
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`CapCart running on ${BASE_URL} — AI: ${[GEMINI_API_KEY && GEMINI_MODEL, GROQ_API_KEY && 'groq ' + GROQ_MODEL].filter(Boolean).join(' + ') || 'offline'}, PayPal: ${PAYPAL_CLIENT_ID ? 'sandbox' : 'simulated'}`));
}
module.exports = { callGemini, groqJSON, discoverModels, extractPreferences, resolveVariants, interpret, retrieve, planCart, enforceGuardrails, walletLoad, walletSpend, looksInjected, server };
