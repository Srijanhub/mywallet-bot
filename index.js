require('dotenv').config();
const TelegramBot  = require('node-telegram-bot-api');
const admin        = require('firebase-admin');
const cron         = require('node-cron');
const express      = require('express');
const https        = require('https');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Config ──────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const YOUR_CHAT_ID = process.env.YOUR_CHAT_ID;
const GEMINI_KEY   = process.env.GEMINI_KEY;
const FIREBASE_USER_UID = process.env.FIREBASE_USER_UID || null;

// ── Firebase Admin init ──────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Telegram Bot ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ── Gemini AI ─────────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

// ── Color + Icon pools ────────────────────────────────────────────────────────
const COLOR_PALETTE = [
  '#6366F1','#EC4899','#14B8A6','#F97316','#84CC16',
  '#06B6D4','#A855F7','#EF4444','#10B981','#F59E0B',
  '#3B82F6','#E11D48','#0EA5E9','#D946EF','#22C55E',
  '#FB923C','#8B5CF6','#2DD4BF','#FACC15','#F43F5E',
];
const ICON_POOL = ['💡','🎯','📈','🏦','🎓','✈️','🎮','🐾','🌿','💎',
                   '🔧','🎵','📱','🏋️','🧴','🍕','⚽','📚','🚀','🌟'];

// ── Default categories ────────────────────────────────────────────────────────
const DEFAULT_CATS = {
  Food:      { icon: '🍔', color: '#F97316', type: 'expense' },
  Transport: { icon: '🚗', color: '#3B82F6', type: 'expense' },
  Shopping:  { icon: '🛍️', color: '#A855F7', type: 'expense' },
  Health:    { icon: '💊', color: '#10B981', type: 'expense' },
  Bills:     { icon: '📋', color: '#EF4444', type: 'expense' },
  Housing:   { icon: '🏠', color: '#6366F1', type: 'expense' },
  Fun:       { icon: '🎉', color: '#F59E0B', type: 'expense' },
  Savings:   { icon: '💰', color: '#14B8A6', type: 'both'    },
  Income:    { icon: '💵', color: '#22C55E', type: 'income'  },
  Other:     { icon: '📦', color: '#94A3B8', type: 'both'    },
};

function getFirebaseUid(chatId) { return FIREBASE_USER_UID || chatId; }

// ── Load categories from Firebase ────────────────────────────────────────────
async function getCategories(chatId) {
  try {
    const uid  = getFirebaseUid(chatId);
    const snap = await db.doc(`users/${uid}/settings/categories`).get();
    const custom = snap.exists ? snap.data().categories || {} : {};
    return { ...DEFAULT_CATS, ...custom };
  } catch (e) { return { ...DEFAULT_CATS }; }
}

async function saveNewCategory(chatId, name, icon, color, type = 'expense') {
  const uid  = getFirebaseUid(chatId);
  const snap = await db.doc(`users/${uid}/settings/categories`).get();
  const existing = snap.exists ? snap.data().categories || {} : {};
  existing[name] = { icon, color, type, custom: true };
  await db.doc(`users/${uid}/settings/categories`).set({ categories: existing });
}

function pickColor(existingCats) {
  const used = Object.values(existingCats).map(c => c.color);
  return COLOR_PALETTE.find(c => !used.includes(c)) || COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
}
function pickIcon(existingCats) {
  const used = Object.values(existingCats).map(c => c.icon);
  return ICON_POOL.find(i => !used.includes(i)) || '📌';
}

// ── Download Telegram voice file ──────────────────────────────────────────────
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Raw REST call to Gemini ───────────────────────────────────────────────────
function geminiREST(model, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('Parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function listGeminiModels() {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models?key=${GEMINI_KEY}`,
      method: 'GET',
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const audioModels = (parsed.models || [])
            .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
            .map(m => m.name);
          resolve(audioModels);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Transcribe voice ──────────────────────────────────────────────────────────
async function transcribeVoice(fileBuffer) {
  const base64Audio = fileBuffer.toString('base64');
  const prompt = 'Transcribe exactly what is said in this audio. Return ONLY the spoken words, nothing else.';
  let modelsToTry = ['gemini-1.5-flash-latest', 'gemini-1.5-flash', 'gemini-pro'];
  try {
    const available = await listGeminiModels();
    console.log('[Voice] Available models:', available.slice(0, 8).join(', '));
    const flashModels = available
      .filter(m => m.includes('flash') || m.includes('pro'))
      .map(m => m.replace('models/', ''));
    if (flashModels.length > 0) modelsToTry = [...flashModels, ...modelsToTry];
  } catch (e) {
    console.log('[Voice] Could not list models, using defaults');
  }
  for (const modelName of [...new Set(modelsToTry)]) {
    try {
      console.log(`[Voice] Trying ${modelName}...`);
      const res = await geminiREST(modelName, {
        contents: [{
          parts: [
            { inline_data: { mime_type: 'audio/ogg', data: base64Audio } },
            { text: prompt }
          ]
        }]
      });
      if (res.status === 200) {
        const text = res.body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text && text.length > 2) {
          console.log(`[Voice] SUCCESS with ${modelName}: "${text}"`);
          return text;
        }
      } else {
        console.log(`[Voice] ${modelName} failed: ${res.status} ${JSON.stringify(res.body?.error?.message || '').slice(0, 100)}`);
      }
    } catch (e) {
      console.log(`[Voice] ${modelName} error: ${e.message}`);
    }
  }
  console.log('[Voice] All models failed');
  return null;
}

// ── Parse date from natural language ─────────────────────────────────────────
// Returns { y, m, d } or null for "today"
async function parseIntent(text) {
  const now = new Date();
  const prompt = `Today is ${now.toISOString().split('T')[0]} (${now.toLocaleDateString('en-US', {weekday:'long'})}).

Analyze this user message and return ONLY a JSON object with these fields:
- "intent": one of "log", "delete", "edit", "query"
  - "log" = adding new expenses/income
  - "delete" = removing an existing entry
  - "edit" = changing an existing entry (amount or category)
  - "query" = asking a question (summary, etc.)
- "date": the date they want to log/edit/delete FOR, in "YYYY-MM-DD" format. If no date mentioned, use today's date.
- "isDateRange": true if they said "all entries from [date]" or "all from today" etc.
- "rangeDate": if isDateRange is true, the date string "YYYY-MM-DD" for the range

Examples:
"spent 200 food yesterday" → {"intent":"log","date":"${new Date(Date.now()-86400000).toISOString().split('T')[0]}","isDateRange":false}
"delete the 500 petrol from June 3rd" → {"intent":"delete","date":"${now.getFullYear()}-06-03","isDateRange":false}
"delete all entries from today" → {"intent":"delete","date":"${now.toISOString().split('T')[0]}","isDateRange":true,"rangeDate":"${now.toISOString().split('T')[0]}"}
"change the 200 food to 350" → {"intent":"edit","date":"${now.toISOString().split('T')[0]}","isDateRange":false}
"200 food 80 uber" → {"intent":"log","date":"${now.toISOString().split('T')[0]}","isDateRange":false}

User message: "${text}"
Return ONLY the JSON:`;

  try {
    const res = await geminiREST('gemini-2.5-flash', { contents: [{ parts: [{ text: prompt }] }] });
    if (res.status !== 200) return { intent: 'log', date: toDateObj(new Date()), isDateRange: false };
    const raw = res.body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return parsed;
  } catch (e) {
    return { intent: 'log', date: toDateObj(new Date()), isDateRange: false };
  }
}

function toDateObj(d) {
  return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate() };
}

function parseDateStr(str) {
  // Already a date object (AI sometimes returns {y,m,d} directly)
  if (str && typeof str === 'object' && 'y' in str) return str;
  // "YYYY-MM-DD" → date obj
  const parts = String(str).split('-').map(Number);
  return { y: parts[0], m: parts[1] - 1, d: parts[2] };
}

function dateObjToLabel(dateObj) {
  const d = new Date(dateObj.y, dateObj.m, dateObj.d);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── Autocorrect categories ────────────────────────────────────────────────────
// Common voice mishearings for expense categories
const AUTOCORRECT_MAP = {
  'foot': 'food', 'flood': 'food', 'good': 'food', 'mood': 'food',
  'over': 'uber', 'oba': 'uber', 'uber eats': 'food',
  'transport': 'transport', 'taxi': 'transport',
  'fun': 'fun', 'fan': 'fun',
  'heal': 'health', 'health care': 'health',
  'bill': 'bills', 'bills': 'bills',
};

async function parseExpenses(text, categories) {
  const catNames = Object.keys(categories).join(', ');
  const now = new Date();
  const prompt = `You are an expense parser for a personal finance app with smart autocorrect for voice mishearings.

Known categories: ${catNames}

Common voice mishearing corrections you MUST apply:
- "foot" → "Food" (most common voice error)
- "over" → "Uber" (transport)
- "fan" → "Fun"
- "heal" → "Health"
- "flood" → "Food"
- Apply common sense: if a word sounds like a category name or common expense, correct it

Rules:
1. Extract ALL expense/income items from the text.
2. Match to a known category (case-insensitive, fuzzy matching OK).
3. If no known category fits, create a NEW one with a descriptive name.
4. Apply autocorrect for obvious voice mishearings.
5. Return ONLY valid JSON array.

Each item must have:
- "type": "expense" or "income"
- "amount": number (required)
- "label": short description 2-4 words
- "category": matched or new category name (Title Case)
- "isNewCategory": true if brand new
- "originalWord": if you autocorrected something, the original word the user said (else null)
- "correctedTo": if you autocorrected, what you corrected it to (else null)

Example:
User: "spent 200 foot, 80 over"
Output: [
  {"type":"expense","amount":200,"label":"Food expense","category":"Food","isNewCategory":false,"originalWord":"foot","correctedTo":"Food"},
  {"type":"expense","amount":80,"label":"Uber ride","category":"Transport","isNewCategory":false,"originalWord":"over","correctedTo":"Uber"}
]

Now parse: "${text}"
Return ONLY the JSON array:`;

  try {
    const res = await geminiREST('gemini-2.5-flash', { contents: [{ parts: [{ text: prompt }] }] });
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    const raw   = res.body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('AI parse error:', e.message);
    return null;
  }
}

// ── Parse DELETE intent ───────────────────────────────────────────────────────
async function parseDeleteIntent(text, existingEntries, categories) {
  const entriesList = existingEntries.map((e, i) => {
    const cat = categories[e.category];
    return `[${i}] id:${e.id} | ${cat?.icon || '📌'} ${e.label} | ${e.category} | ₹${e.amount} | ${dateObjToLabel(e.date)}`;
  }).join('\n');

  const prompt = `User wants to delete entries from their expense tracker.

Available entries:
${entriesList || '(no entries found)'}

User said: "${text}"

Match which entries they want to delete. Return ONLY a JSON object:
{
  "indices": [list of indices from the list above],
  "isAll": true if they want to delete ALL entries from a date
}

Examples:
- "delete the 200 food" → {"indices":[matching index],"isAll":false}
- "cancel the uber I just logged" → {"indices":[matching index],"isAll":false}  
- "delete all from today" → {"indices":[all indices],"isAll":true}
- "remove 500 petrol" → {"indices":[matching index],"isAll":false}

If no match found, return {"indices":[],"isAll":false}
Return ONLY the JSON:`;

  try {
    const res = await geminiREST('gemini-2.5-flash', { contents: [{ parts: [{ text: prompt }] }] });
    const raw   = res.body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    return { indices: [], isAll: false };
  }
}

// ── Parse EDIT intent ─────────────────────────────────────────────────────────
async function parseEditIntent(text, existingEntries, categories) {
  const entriesList = existingEntries.map((e, i) => {
    const cat = categories[e.category];
    return `[${i}] id:${e.id} | ${cat?.icon || '📌'} ${e.label} | ${e.category} | ₹${e.amount} | ${dateObjToLabel(e.date)}`;
  }).join('\n');

  const prompt = `User wants to edit an entry in their expense tracker.

Available entries:
${entriesList || '(no entries found)'}

User said: "${text}"

Figure out which entry they want to edit and what to change. Return ONLY a JSON object:
{
  "index": the index number of the entry to edit (or -1 if no clear match),
  "newAmount": new amount as number (or null if not changing),
  "newCategory": new category name (or null if not changing),
  "newLabel": new short label (or null if not changing)
}

Examples:
- "change the 200 food to 350" → {"index":0,"newAmount":350,"newCategory":null,"newLabel":null}
- "change food to transport" → {"index":0,"newAmount":null,"newCategory":"Transport","newLabel":null}
- "update the uber 80 to 120" → {"index":1,"newAmount":120,"newCategory":null,"newLabel":null}

Return ONLY the JSON:`;

  try {
    const res = await geminiREST('gemini-2.5-flash', { contents: [{ parts: [{ text: prompt }] }] });
    const raw   = res.body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    return { index: -1, newAmount: null, newCategory: null, newLabel: null };
  }
}

// ── Save entries to Firebase ──────────────────────────────────────────────────
async function saveEntriesToFirebase(chatId, entries, dateObj) {
  const uid   = getFirebaseUid(chatId);
  const batch = db.batch();
  for (const entry of entries) {
    const id  = Date.now() + Math.floor(Math.random() * 99999);
    const ref = db.collection(`users/${uid}/entries`).doc(String(id));
    batch.set(ref, {
      id, type: entry.type, amount: entry.amount,
      label: entry.label, category: entry.category, date: dateObj
    });
    await new Promise(r => setTimeout(r, 3));
  }
  await batch.commit();
}

// ── Fetch entries from Firebase ───────────────────────────────────────────────
async function fetchEntries(chatId, dateObj) {
  const uid  = getFirebaseUid(chatId);
  const snap = await db.collection(`users/${uid}/entries`).get();
  return snap.docs
    .map(d => ({ docId: d.id, ...d.data() }))
    .filter(e => e.date && e.date.y === dateObj.y && e.date.m === dateObj.m && e.date.d === dateObj.d);
}

async function fetchAllEntriesThisMonth(chatId) {
  const uid  = getFirebaseUid(chatId);
  const now  = new Date();
  const snap = await db.collection(`users/${uid}/entries`).get();
  return snap.docs
    .map(d => ({ docId: d.id, ...d.data() }))
    .filter(e => e.date && e.date.y === now.getFullYear() && e.date.m === now.getMonth());
}

// ── Delete entries from Firebase ──────────────────────────────────────────────
async function deleteEntriesFromFirebase(chatId, entries) {
  const uid   = getFirebaseUid(chatId);
  const batch = db.batch();
  for (const e of entries) {
    const ref = db.collection(`users/${uid}/entries`).doc(String(e.docId));
    batch.delete(ref);
  }
  await batch.commit();
}

// ── Update a single entry in Firebase ────────────────────────────────────────
async function updateEntryInFirebase(chatId, entry, updates) {
  const uid = getFirebaseUid(chatId);
  const ref = db.collection(`users/${uid}/entries`).doc(String(entry.docId));
  await ref.update(updates);
}

// ── Format entries for display ────────────────────────────────────────────────
function formatEntries(entries, categories) {
  return entries.map(e => {
    const cat  = categories[e.category];
    const icon = cat ? cat.icon : '📌';
    const sign = e.type === 'income' ? '+' : '-';
    const newTag = e.isNewCategory ? ' ✨ _new category_' : '';
    return `${icon} *${e.label}* — ${sign}₹${e.amount} (${e.category})${newTag}`;
  }).join('\n');
}

function formatEntryLine(e, categories, index) {
  const cat  = categories[e.category];
  const icon = cat ? cat.icon : '📌';
  const sign = e.type === 'income' ? '+' : '-';
  return `${index !== undefined ? `[${index + 1}] ` : ''}${icon} *${e.label}* — ${sign}₹${e.amount} (${e.category}) | ${dateObjToLabel(e.date)}`;
}

// ── Session state ─────────────────────────────────────────────────────────────
const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = {
    state: 'idle',
    pendingEntries: [],
    pendingNewCats: [],
    pendingDelete: [],
    pendingEdit: null,
    pendingEditUpdates: null,
    pendingDateObj: null,
    lastTranscription: null,
  };
  return sessions[chatId];
}

// ── Process text into expense entries ────────────────────────────────────────
async function handleExpenseText(chatId, text, session, dateObj) {
  session.state = 'awaiting_entries';
  await bot.sendMessage(chatId, '⏳ Parsing your expenses...');

  const categories = await getCategories(chatId);
  const entries    = await parseExpenses(text, categories);

  if (!entries || entries.length === 0) {
    session.state = 'idle';
    return bot.sendMessage(chatId,
      `❓ Couldn't understand that. Try:\n_"200 food, 80 uber, 5000 mutual funds"_`,
      { parse_mode: 'Markdown' }
    );
  }

  // Auto-assign color + icon to new categories
  const newCats = [];
  for (const entry of entries) {
    if (entry.isNewCategory && !categories[entry.category]) {
      const color = pickColor({ ...categories, ...Object.fromEntries(newCats.map(c => [c.name, c])) });
      const icon  = pickIcon({ ...categories, ...Object.fromEntries(newCats.map(c => [c.name, c])) });
      const type  = entry.type === 'income' ? 'income' : 'expense';
      newCats.push({ name: entry.category, icon, color, type });
      categories[entry.category] = { icon, color, type };
    }
  }

  session.pendingEntries = entries;
  session.pendingNewCats = newCats;
  session.pendingDateObj = dateObj;
  session.state = 'confirming';

  const preview  = formatEntries(entries, categories);
  const totalExp = entries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  const totalInc = entries.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);

  let summaryLine = '';
  if (totalExp > 0) summaryLine += `\n💸 Total spent: *₹${totalExp}*`;
  if (totalInc > 0) summaryLine += `\n💵 Total income: *+₹${totalInc}*`;

  // Show autocorrect notes
  const corrections = entries.filter(e => e.originalWord && e.correctedTo);
  let autocorrectNote = '';
  if (corrections.length > 0) {
    autocorrectNote = `\n\n🔤 *Autocorrected:*\n` +
      corrections.map(e => `"_${e.originalWord}_" → *${e.correctedTo}*`).join('\n') +
      `\n_If any correction is wrong, reply *no* and retype manually._`;
  }

  let newCatNotice = '';
  if (newCats.length > 0) {
    newCatNotice = `\n\n✨ *New categories will be created:*\n` +
      newCats.map(c => `${c.icon} *${c.name}*`).join('\n');
  }

  // Show the date being logged to (if not today)
  const today = toDateObj(new Date());
  const isToday = dateObj.y === today.y && dateObj.m === today.m && dateObj.d === today.d;
  const dateNote = isToday ? '' : `\n📅 Logging to: *${dateObjToLabel(dateObj)}*`;

  return bot.sendMessage(chatId,
    `✅ *Got it! Here's what I found:*\n\n${preview}${summaryLine}${dateNote}${autocorrectNote}${newCatNotice}\n\nSave to MyWallet? Reply *yes* or *no*`,
    { parse_mode: 'Markdown' }
  );
}

// ── Handle DELETE flow ────────────────────────────────────────────────────────
async function handleDeleteRequest(chatId, text, session, intentData) {
  await bot.sendMessage(chatId, '🔍 Searching for matching entries...');

  const dateObj  = intentData.date ? parseDateStr(intentData.date) : toDateObj(new Date());
  const categories = await getCategories(chatId);

  // Fetch entries — if range, fetch all this month; else fetch for the date
  let entries;
  if (intentData.isDateRange) {
    const rangeDate = intentData.rangeDate ? parseDateStr(intentData.rangeDate) : dateObj;
    entries = await fetchEntries(chatId, rangeDate);
  } else {
    // Fetch recent entries across last 30 days for better matching
    entries = await fetchAllEntriesThisMonth(chatId);
  }

  if (entries.length === 0) {
    session.state = 'idle';
    return bot.sendMessage(chatId, '📭 No entries found to delete.');
  }

  const parsed = await parseDeleteIntent(text, entries, categories);

  if (!parsed.indices || parsed.indices.length === 0) {
    session.state = 'idle';
    return bot.sendMessage(chatId,
      `❓ Couldn't find a matching entry. Try being more specific:\n_"delete the 200 food from today"_\n_"remove uber 80 from yesterday"_`,
      { parse_mode: 'Markdown' }
    );
  }

  const toDelete = parsed.indices.map(i => entries[i]).filter(Boolean);

  if (toDelete.length === 0) {
    session.state = 'idle';
    return bot.sendMessage(chatId, '❓ No matching entries found.');
  }

  session.pendingDelete = toDelete;
  session.state = parsed.isAll ? 'confirming_bulk_delete' : 'confirming_delete';

  const entriesList = toDelete.map((e, i) => formatEntryLine(e, categories, i)).join('\n');

  if (parsed.isAll && toDelete.length > 1) {
    return bot.sendMessage(chatId,
      `⚠️ *Delete ALL ${toDelete.length} entries?*\n\n${entriesList}\n\n⚠️ This cannot be undone! Reply *yes* to delete all or *no* to cancel.`,
      { parse_mode: 'Markdown' }
    );
  } else {
    return bot.sendMessage(chatId,
      `🗑️ *Delete this entry?*\n\n${entriesList}\n\nReply *yes* to delete or *no* to cancel.`,
      { parse_mode: 'Markdown' }
    );
  }
}

// ── Handle EDIT flow ──────────────────────────────────────────────────────────
async function handleEditRequest(chatId, text, session, intentData) {
  await bot.sendMessage(chatId, '🔍 Looking for matching entries...');

  const categories = await getCategories(chatId);
  const entries = await fetchAllEntriesThisMonth(chatId);

  if (entries.length === 0) {
    session.state = 'idle';
    return bot.sendMessage(chatId, '📭 No entries found to edit.');
  }

  const parsed = await parseEditIntent(text, entries, categories);

  if (parsed.index === -1 || !entries[parsed.index]) {
    // Show list and ask them to pick
    session.state = 'idle';
    const list = entries.slice(0, 10).map((e, i) => formatEntryLine(e, categories, i)).join('\n');
    return bot.sendMessage(chatId,
      `❓ Couldn't find a specific entry. Your recent entries:\n\n${list}\n\nTry: _"change the 200 food to 350"_ or _"update uber 80 to 120"_`,
      { parse_mode: 'Markdown' }
    );
  }

  const entry = entries[parsed.index];
  const updates = {};
  if (parsed.newAmount !== null) updates.amount = parsed.newAmount;
  if (parsed.newCategory !== null) updates.category = parsed.newCategory;
  if (parsed.newLabel !== null) updates.label = parsed.newLabel;

  if (Object.keys(updates).length === 0) {
    session.state = 'idle';
    return bot.sendMessage(chatId, `❓ Couldn't figure out what to change. Try: _"change the 200 food to 350"_`, { parse_mode: 'Markdown' });
  }

  session.pendingEdit = entry;
  session.pendingEditUpdates = updates;
  session.state = 'confirming_edit';

  const cat  = categories[entry.category];
  const icon = cat ? cat.icon : '📌';
  const sign = entry.type === 'income' ? '+' : '-';

  let changeDesc = [];
  if (updates.amount !== undefined) changeDesc.push(`₹${entry.amount} → *₹${updates.amount}*`);
  if (updates.category !== undefined) changeDesc.push(`${entry.category} → *${updates.category}*`);
  if (updates.label !== undefined) changeDesc.push(`"${entry.label}" → *"${updates.label}"*`);

  return bot.sendMessage(chatId,
    `✏️ *Edit this entry?*\n\n${icon} *${entry.label}* — ${sign}₹${entry.amount} (${entry.category})\n\n*Changes:* ${changeDesc.join(', ')}\n\nReply *yes* to update or *no* to cancel.`,
    { parse_mode: 'Markdown' }
  );
}

// ── Show categories ───────────────────────────────────────────────────────────
async function showCategories(chatId) {
  const cats  = await getCategories(chatId);
  const lines = Object.entries(cats).map(([name, c]) => `${c.icon} *${name}*`);
  return bot.sendMessage(chatId,
    `📂 *Your Categories (${lines.length})*\n\n${lines.join('\n')}\n\n_New ones are created automatically!_`,
    { parse_mode: 'Markdown' }
  );
}

// ── Daily reminder ────────────────────────────────────────────────────────────
async function sendDailyReminder() {
  const today   = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  await bot.sendMessage(YOUR_CHAT_ID,
    `💰 *MyWallet Daily Check-in*\n\nHey! End of *${dateStr}*.\n\nWhat did you spend or earn today?\nYou can *type* or send a *🎤 voice message*!\n\n_"spent 200 groceries, 5000 mutual funds, 80 uber"_`,
    { parse_mode: 'Markdown' }
  );
  getSession(YOUR_CHAT_ID).state = 'awaiting_entries';
}

// ── MAIN MESSAGE HANDLER ──────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId  = String(msg.chat.id);
  const text    = (msg.text || '').trim();
  const session = getSession(chatId);

  if (chatId !== String(YOUR_CHAT_ID)) {
    return bot.sendMessage(chatId, '🔒 Private bot. Access denied.');
  }

  // ── Handle VOICE messages ──
  if (msg.voice || msg.audio) {
    try {
      const fileId   = msg.voice ? msg.voice.file_id : msg.audio.file_id;
      const mimeType = msg.voice ? 'audio/ogg' : (msg.audio.mime_type || 'audio/mpeg');
      await bot.sendMessage(chatId, '🎤 Got your voice message! Transcribing...');
      const fileInfo = await bot.getFile(fileId);
      const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
      const buffer   = await downloadBuffer(fileUrl);
      const transcript = await transcribeVoice(buffer, mimeType);
      if (!transcript) {
        return bot.sendMessage(chatId,
          `❌ Couldn't transcribe. Tips:\n• Speak clearly\n• Under 30 seconds\n• Say amounts clearly\n\nOr just type: _"200 food, 80 uber"_`,
          { parse_mode: 'Markdown' }
        );
      }
      await bot.sendMessage(chatId,
        `🎤 *I heard:*\n_"${transcript}"_\n\nProcessing this now...`,
        { parse_mode: 'Markdown' }
      );
      session.lastTranscription = transcript;

      // If we're waiting for a yes/no confirmation, handle it directly without AI parsing
      const confirmationStates = ['confirming', 'confirming_delete', 'confirming_edit', 'confirming_bulk_delete'];
      if (confirmationStates.includes(session.state)) {
        const normalized = transcript.trim().toLowerCase().replace(/[^a-z]/g, '');
        const isYes = ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'confirm', 'go', 'save', 'doit', 'haan', 'ha'].includes(normalized);
        const isNo  = ['no', 'nope', 'nah', 'cancel', 'stop', 'abort', 'nevermind', 'never', 'nahi'].includes(normalized);
        if (isYes || isNo) {
          const answer = isYes ? 'yes' : 'no';
          await bot.sendMessage(chatId,
            `🎤 *I heard:* _"${transcript}"_ → treating as *${answer}*`,
            { parse_mode: 'Markdown' }
          );
          // Directly handle confirmation without going through AI parser
          return handleVoiceConfirmation(chatId, answer, session);
        }
      }

      return processMessage(chatId, transcript, session);
    } catch (e) {
      console.error('Voice error:', e);
      return bot.sendMessage(chatId, '❌ Error processing voice message. Please try typing instead.');
    }
  }

  // ── /start ──
  if (text === '/start') {
    session.state = 'idle';
    return bot.sendMessage(chatId,
      `💰 *Welcome to MyWallet Bot!*\n\n` +
      `I remind you every *9 PM IST* to log your expenses.\n\n` +
      `*Commands:*\n` +
      `/log — Log expenses now\n` +
      `/summary — This month's summary\n` +
      `/categories — View all your categories\n` +
      `/uid — Check your linked Firebase UID\n` +
      `/cancel — Cancel current action\n\n` +
      `✨ *Pro tips:*\n` +
      `• Type or 🎤 voice: _"200 food, 80 uber, salary 50000"_\n` +
      `• Specific date: _"500 petrol yesterday"_ / _"200 food on June 3rd"_\n` +
      `• Delete: _"delete the 200 food from today"_\n` +
      `• Edit: _"change the 80 uber to 120"_\n` +
      `• Delete all: _"delete all entries from yesterday"_`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── /log ──
  if (text === '/log') {
    session.state = 'awaiting_entries';
    return bot.sendMessage(chatId,
      `📝 *What did you spend or earn?*\n\nType naturally or send a *🎤 voice message*:\n_"200 food, 5000 mutual funds, salary 50000"_\n\nYou can also specify a date:\n_"500 petrol yesterday"_ or _"200 food on June 3rd"_`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── /uid ──
  if (text === '/uid') {
    const uid = getFirebaseUid(chatId);
    return bot.sendMessage(chatId,
      `🔑 *Firebase UID in use:*\n\`${uid}\`\n\n` +
      (FIREBASE_USER_UID
        ? `✅ Using your Google Auth UID — entries sync with your PWA!`
        : `⚠️ *FIREBASE_USER_UID not set!*\nAdd it to Railway environment variables.`),
      { parse_mode: 'Markdown' }
    );
  }

  // ── /categories ──
  if (text === '/categories') return showCategories(chatId);

  // ── /cancel ──
  if (text === '/cancel') {
    session.state = 'idle';
    session.pendingEntries = [];
    session.pendingNewCats = [];
    session.pendingDelete = [];
    session.pendingEdit = null;
    session.pendingEditUpdates = null;
    return bot.sendMessage(chatId, '✅ Cancelled.');
  }

  // ── /summary ──
  if (text === '/summary') {
    try {
      const entries = await fetchAllEntriesThisMonth(chatId);
      const now = new Date();
      if (entries.length === 0) {
        return bot.sendMessage(chatId, `📊 No entries for this month yet. Use /log to add some!`);
      }
      const income  = entries.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);
      const expense = entries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
      const balance = income - expense;
      const MONTHS  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const catTotals = {};
      entries.filter(e => e.type === 'expense').forEach(e => {
        catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
      });
      const cats = await getCategories(chatId);
      const breakdown = Object.entries(catTotals)
        .sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([cat, amt]) => `${cats[cat]?.icon || '📌'} ${cat}: *₹${amt}*`).join('\n');
      return bot.sendMessage(chatId,
        `📊 *${MONTHS[now.getMonth()]} ${now.getFullYear()} Summary*\n\n` +
        `💵 Income:  *+₹${income}*\n` +
        `💸 Spent:   *-₹${expense}*\n` +
        `${balance >= 0 ? '✅' : '⚠️'} Balance: *${balance >= 0 ? '+' : ''}₹${balance}*\n\n` +
        (breakdown ? `*Top categories:*\n${breakdown}\n\n` : '') +
        `_Open MyWallet app for full breakdown_`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.error('Summary error:', e);
      return bot.sendMessage(chatId, '❌ Could not fetch summary.');
    }
  }

  // ── Confirming log ──
  if (session.state === 'confirming') {
    const lower = text.toLowerCase().trim();
    if (['yes','y','yeah','yep','ok','okay','sure','yup','haan','ha'].includes(lower)) {
      try {
        for (const cat of session.pendingNewCats) {
          await saveNewCategory(chatId, cat.name, cat.icon, cat.color, cat.type);
        }
        const dateObj = session.pendingDateObj || toDateObj(new Date());
        await saveEntriesToFirebase(chatId, session.pendingEntries, dateObj);
        const count    = session.pendingEntries.length;
        const newCount = session.pendingNewCats.length;
        session.state = 'idle';
        session.pendingEntries = [];
        session.pendingNewCats = [];
        session.pendingDateObj = null;
        const today = toDateObj(new Date());
        const isToday = dateObj.y === today.y && dateObj.m === today.m && dateObj.d === today.d;
        const dateNote = isToday ? '' : ` to *${dateObjToLabel(dateObj)}*`;
        let reply = `🎉 *Saved!* ${count} entr${count === 1 ? 'y' : 'ies'} added${dateNote}.`;
        if (newCount > 0) reply += `\n✨ ${newCount} new categor${newCount === 1 ? 'y' : 'ies'} created!`;
        reply += `\n\nOpen MyWallet to see your updated balance! 💰`;
        return bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('Save error:', e);
        return bot.sendMessage(chatId, '❌ Error saving. Please try again.');
      }
    }
    if (['no','n','nope','cancel','nah','nahi'].includes(lower)) {
      session.state = 'idle';
      session.pendingEntries = [];
      session.pendingNewCats = [];
      session.pendingDateObj = null;
      return bot.sendMessage(chatId, '❌ Cancelled. Nothing saved.');
    }
    return bot.sendMessage(chatId, `Reply *yes* to save or *no* to cancel.`, { parse_mode: 'Markdown' });
  }

  // ── Confirming delete (single) ──
  if (session.state === 'confirming_delete') {
    const lower = text.toLowerCase().trim();
    if (['yes','y','yeah','yep','ok','okay','sure','yup','haan','ha'].includes(lower)) {
      try {
        await deleteEntriesFromFirebase(chatId, session.pendingDelete);
        const count = session.pendingDelete.length;
        session.state = 'idle';
        session.pendingDelete = [];
        return bot.sendMessage(chatId, `🗑️ *Deleted!* ${count} entr${count === 1 ? 'y' : 'ies'} removed from MyWallet.`, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('Delete error:', e);
        return bot.sendMessage(chatId, '❌ Error deleting. Please try again.');
      }
    }
    if (['no','n','nope','cancel','nah','nahi'].includes(lower)) {
      session.state = 'idle';
      session.pendingDelete = [];
      return bot.sendMessage(chatId, '✅ Cancelled. Nothing deleted.');
    }
    return bot.sendMessage(chatId, `Reply *yes* to delete or *no* to cancel.`, { parse_mode: 'Markdown' });
  }

  // ── Confirming bulk delete ──
  if (session.state === 'confirming_bulk_delete') {
    const lower = text.toLowerCase().trim();
    if (['yes','y','yeah','yep','ok','okay','sure','yup','haan','ha'].includes(lower)) {
      try {
        await deleteEntriesFromFirebase(chatId, session.pendingDelete);
        const count = session.pendingDelete.length;
        session.state = 'idle';
        session.pendingDelete = [];
        return bot.sendMessage(chatId, `🗑️ *All deleted!* ${count} entr${count === 1 ? 'y' : 'ies'} removed.`, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('Bulk delete error:', e);
        return bot.sendMessage(chatId, '❌ Error deleting. Please try again.');
      }
    }
    if (['no','n','nope','cancel','nah','nahi'].includes(lower)) {
      session.state = 'idle';
      session.pendingDelete = [];
      return bot.sendMessage(chatId, '✅ Cancelled. Nothing deleted.');
    }
    return bot.sendMessage(chatId, `Reply *yes* to delete ALL or *no* to cancel.`, { parse_mode: 'Markdown' });
  }

  // ── Confirming edit ──
  if (session.state === 'confirming_edit') {
    const lower = text.toLowerCase().trim();
    if (['yes','y','yeah','yep','ok','okay','sure','yup','haan','ha'].includes(lower)) {
      try {
        await updateEntryInFirebase(chatId, session.pendingEdit, session.pendingEditUpdates);
        session.state = 'idle';
        session.pendingEdit = null;
        session.pendingEditUpdates = null;
        return bot.sendMessage(chatId, `✅ *Updated!* Entry has been changed in MyWallet.`, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('Edit error:', e);
        return bot.sendMessage(chatId, '❌ Error updating. Please try again.');
      }
    }
    if (['no','n','nope','cancel','nah','nahi'].includes(lower)) {
      session.state = 'idle';
      session.pendingEdit = null;
      session.pendingEditUpdates = null;
      return bot.sendMessage(chatId, '✅ Cancelled. Nothing changed.');
    }
    return bot.sendMessage(chatId, `Reply *yes* to update or *no* to cancel.`, { parse_mode: 'Markdown' });
  }

  // ── Free text (log/delete/edit) ──
  if ((session.state === 'awaiting_entries' || session.state === 'idle') && text && !text.startsWith('/')) {
    const expenseKeywords = /spent|paid|bought|cost|expense|bill|food|lunch|dinner|breakfast|uber|taxi|salary|income|earned|received|got|mutual|invest|fund|gym|rent|petrol|fuel|recharge|delete|remove|cancel|change|update|edit|modify/i;
    if (session.state === 'idle' && !expenseKeywords.test(text)) {
      return bot.sendMessage(chatId,
        `Use /log to add expenses, /summary for overview, or /categories.\nYou can also send a 🎤 voice message!\n\nOr try: _"delete the 200 food"_ / _"change 80 uber to 120"_`,
        { parse_mode: 'Markdown' }
      );
    }
    return processMessage(chatId, text, session);
  }
});

// ── Route message to correct handler based on intent ──────────────────────────
async function handleVoiceConfirmation(chatId, answer, session) {
  // Routes a voice yes/no directly to the right confirmation handler, bypassing AI parsing
  const lower = answer.toLowerCase();
  if (session.state === 'confirming') {
    if (lower === 'yes') {
      try {
        for (const cat of session.pendingNewCats) {
          await saveNewCategory(chatId, cat.name, cat.icon, cat.color, cat.type);
        }
        const dateObj = session.pendingDateObj || toDateObj(new Date());
        await saveEntriesToFirebase(chatId, session.pendingEntries, dateObj);
        const count    = session.pendingEntries.length;
        const newCount = session.pendingNewCats.length;
        session.state = 'idle';
        session.pendingEntries = [];
        session.pendingNewCats = [];
        session.pendingDateObj = null;
        const today = toDateObj(new Date());
        const isToday = dateObj.y === today.y && dateObj.m === today.m && dateObj.d === today.d;
        const dateNote = isToday ? '' : ` to *${dateObjToLabel(dateObj)}*`;
        let reply = `🎉 *Saved!* ${count} entr${count === 1 ? 'y' : 'ies'} added${dateNote}.`;
        if (newCount > 0) reply += `\n✨ ${newCount} new categor${newCount === 1 ? 'y' : 'ies'} created!`;
        reply += `\n\nOpen MyWallet to see your updated balance! 💰`;
        return bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('Save error:', e);
        return bot.sendMessage(chatId, '❌ Error saving. Please try again.');
      }
    } else {
      session.state = 'idle';
      session.pendingEntries = [];
      session.pendingNewCats = [];
      session.pendingDateObj = null;
      return bot.sendMessage(chatId, '❌ Cancelled. Nothing saved.');
    }
  }
  if (session.state === 'confirming_delete') {
    if (lower === 'yes') {
      try {
        for (const e of session.pendingDelete) {
          await deleteEntryFromFirebase(chatId, e.dateObj, e.id);
        }
        const count = session.pendingDelete.length;
        session.state = 'idle';
        session.pendingDelete = [];
        return bot.sendMessage(chatId, `🗑️ *Deleted!* ${count} entr${count === 1 ? 'y' : 'ies'} removed.`, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('Delete error:', e);
        return bot.sendMessage(chatId, '❌ Error deleting. Please try again.');
      }
    } else {
      session.state = 'idle';
      session.pendingDelete = [];
      return bot.sendMessage(chatId, '❌ Cancelled. Nothing deleted.');
    }
  }
  if (session.state === 'confirming_bulk_delete') {
    if (lower === 'yes') {
      try {
        for (const e of session.pendingDelete) {
          await deleteEntryFromFirebase(chatId, e.dateObj, e.id);
        }
        const count = session.pendingDelete.length;
        session.state = 'idle';
        session.pendingDelete = [];
        return bot.sendMessage(chatId, `🗑️ *Deleted all ${count} entries!*`, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('Bulk delete error:', e);
        return bot.sendMessage(chatId, '❌ Error deleting. Please try again.');
      }
    } else {
      session.state = 'idle';
      session.pendingDelete = [];
      return bot.sendMessage(chatId, '❌ Cancelled. Nothing deleted.');
    }
  }
  if (session.state === 'confirming_edit') {
    if (lower === 'yes') {
      try {
        await updateEntryInFirebase(chatId, session.pendingEdit.dateObj, session.pendingEdit.id, session.pendingEditUpdates);
        session.state = 'idle';
        session.pendingEdit = null;
        session.pendingEditUpdates = null;
        return bot.sendMessage(chatId, '✅ *Entry updated!*', { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('Edit error:', e);
        return bot.sendMessage(chatId, '❌ Error updating. Please try again.');
      }
    } else {
      session.state = 'idle';
      session.pendingEdit = null;
      session.pendingEditUpdates = null;
      return bot.sendMessage(chatId, '❌ Cancelled. Nothing changed.');
    }
  }
}

async function processMessage(chatId, text, session) {
  try {
    const intentData = await parseIntent(text);
    console.log('[Intent]', JSON.stringify(intentData));

    if (intentData.intent === 'delete') {
      return handleDeleteRequest(chatId, text, session, intentData);
    } else if (intentData.intent === 'edit') {
      return handleEditRequest(chatId, text, session, intentData);
    } else {
      // Log intent
      const dateObj = intentData.date ? parseDateStr(intentData.date) : toDateObj(new Date());
      return handleExpenseText(chatId, text, session, dateObj);
    }
  } catch (e) {
    console.error('processMessage error:', e);
    // Fallback to log
    return handleExpenseText(chatId, text, session, toDateObj(new Date()));
  }
}

// ── Daily cron at 9 PM IST ────────────────────────────────────────────────────
cron.schedule('0 21 * * *', () => {
  console.log('[CRON] Sending daily reminder...');
  sendDailyReminder().catch(console.error);
}, { timezone: 'Asia/Kolkata' });

// ── Express keep-alive ────────────────────────────────────────────────────────
const app = express();
app.get('/',     (_, res) => res.send('MyWallet Bot v4 is running! 🤖'));
app.get('/ping', (_, res) => res.send('pong'));
app.listen(process.env.PORT || 3000, () => console.log('✅ Server up on port', process.env.PORT || 3000));

console.log('🤖 MyWallet Bot v4 started!');
console.log('📅 Daily reminder: 9:00 PM IST');
console.log('🔑 Firebase UID:', FIREBASE_USER_UID ? `Using ${FIREBASE_USER_UID}` : 'WARNING: FIREBASE_USER_UID not set');
