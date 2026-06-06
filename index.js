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
// Your Google Auth UID from Firebase — the same UID your PWA uses
// Set this as FIREBASE_USER_UID in Railway environment variables
// To find it: Firebase Console → Authentication → Users → copy the UID column
const FIREBASE_USER_UID = process.env.FIREBASE_USER_UID || null;

// ── Firebase Admin init ──────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Telegram Bot ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ── Gemini AI ─────────────────────────────────────────────────────────────────
const genAI  = new GoogleGenerativeAI(GEMINI_KEY);
const model  = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

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

// ── Get the correct Firebase UID to use ───────────────────────────────────────
// Priority: FIREBASE_USER_UID env var (your Google UID from PWA) > Telegram chatId
function getFirebaseUid(chatId) {
  return FIREBASE_USER_UID || chatId;
}

// ── Load categories from Firebase ────────────────────────────────────────────
async function getCategories(chatId) {
  try {
    const uid  = getFirebaseUid(chatId);
    const snap = await db.doc(`users/${uid}/settings/categories`).get();
    const custom = snap.exists ? snap.data().categories || {} : {};
    return { ...DEFAULT_CATS, ...custom };
  } catch (e) {
    return { ...DEFAULT_CATS };
  }
}

// ── Save a new custom category ────────────────────────────────────────────────
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

// ── Download Telegram voice file as buffer ──────────────────────────────────
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

// ── List available Gemini models ──────────────────────────────────────────────
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

// ── Transcribe voice using raw REST (no SDK versioning issues) ────────────────
async function transcribeVoice(fileBuffer) {
  const base64Audio = fileBuffer.toString('base64');
  const prompt = 'Transcribe exactly what is said in this audio. Return ONLY the spoken words, nothing else.';

  // Auto-detect working model by listing available ones first
  let modelsToTry = ['gemini-1.5-flash-latest', 'gemini-1.5-flash', 'gemini-pro', 'gemini-1.0-pro'];
  
  try {
    const available = await listGeminiModels();
    console.log('[Voice] Available models:', available.slice(0, 8).join(', '));
    // Prefer flash models that support audio
    const flashModels = available
      .filter(m => m.includes('flash') || m.includes('pro'))
      .map(m => m.replace('models/', ''));
    if (flashModels.length > 0) modelsToTry = [...flashModels, ...modelsToTry];
  } catch (e) {
    console.log('[Voice] Could not list models, using defaults');
  }

  for (const modelName of [...new Set(modelsToTry)]) {
    try {
      console.log(`[Voice] Trying ${modelName} with inline audio...`);
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


// ── AI: parse natural language into structured entries ────────────────────────
async function parseExpenses(text, categories) {
  const catNames = Object.keys(categories).join(', ');
  const prompt = `You are an expense parser for a personal finance app.
The user described their expenses. Extract ALL of them into structured JSON.

Known categories: ${catNames}

Rules:
1. Match to a known category if it clearly fits.
2. If it doesn't fit any known category, use a descriptive name for a NEW category (e.g. "Mutual Funds", "Gym", "Pet Care").
3. Return ONLY a valid JSON array, no markdown, no explanation.

Each item:
- "type": "expense" or "income"
- "amount": number
- "label": short description (2-4 words)
- "category": best matching or new category name
- "isNewCategory": true if brand new, false otherwise

Example:
User: "spent 5000 on mutual funds, 200 food, received 50000 salary"
Output: [
  {"type":"expense","amount":5000,"label":"Mutual funds","category":"Mutual Funds","isNewCategory":true},
  {"type":"expense","amount":200,"label":"Lunch","category":"Food","isNewCategory":false},
  {"type":"income","amount":50000,"label":"Salary","category":"Income","isNewCategory":false}
]

Now parse: "${text}"

Return ONLY the JSON array:`;

  try {
    const res = await geminiREST('gemini-2.5-flash', {
      contents: [{ parts: [{ text: prompt }] }]
    });
    if (res.status !== 200) throw new Error('HTTP ' + res.status + ': ' + JSON.stringify(res.body?.error));
    const raw   = res.body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('AI parse error:', e.message);
    return null;
  }
}

// ── Save entries to Firebase ──────────────────────────────────────────────────
async function saveEntriesToFirebase(chatId, entries) {
  const uid   = getFirebaseUid(chatId);
  const today = new Date();
  const dateObj = { y: today.getFullYear(), m: today.getMonth(), d: today.getDate() };
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

// ── Format entries for preview ────────────────────────────────────────────────
function formatEntries(entries, categories) {
  return entries.map(e => {
    const cat  = categories[e.category];
    const icon = cat ? cat.icon : '📌';
    const sign = e.type === 'income' ? '+' : '-';
    const newTag = e.isNewCategory ? ' ✨ _new category_' : '';
    return `${icon} *${e.label}* — ${sign}₹${e.amount} (${e.category})${newTag}`;
  }).join('\n');
}

// ── Session state ─────────────────────────────────────────────────────────────
const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { state: 'idle', pendingEntries: [], pendingNewCats: [], lastTranscription: null };
  return sessions[chatId];
}

// ── Process text into expense entries (shared logic) ──────────────────────────
async function handleExpenseText(chatId, text, session) {
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
  session.state = 'confirming';

  const preview  = formatEntries(entries, categories);
  const totalExp = entries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  const totalInc = entries.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);

  let summaryLine = '';
  if (totalExp > 0) summaryLine += `\n💸 Total spent: *₹${totalExp}*`;
  if (totalInc > 0) summaryLine += `\n💵 Total income: *+₹${totalInc}*`;

  let newCatNotice = '';
  if (newCats.length > 0) {
    newCatNotice = `\n\n✨ *New categories will be created:*\n` +
      newCats.map(c => `${c.icon} *${c.name}*`).join('\n');
  }

  return bot.sendMessage(chatId,
    `✅ *Got it! Here's what I found:*\n\n${preview}${summaryLine}${newCatNotice}\n\nSave to MyWallet? Reply *yes* or *no*`,
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
    `💰 *MyWallet Daily Check-in*\n\n` +
    `Hey! End of *${dateStr}*.\n\n` +
    `What did you spend or earn today?\n` +
    `You can *type* or send a *🎤 voice message*!\n\n` +
    `_"spent 200 groceries, 5000 mutual funds, 80 uber"_`,
    { parse_mode: 'Markdown' }
  );
  getSession(YOUR_CHAT_ID).state = 'awaiting_entries';
}

// ── MAIN MESSAGE HANDLER ──────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId  = String(msg.chat.id);
  const text    = (msg.text || '').trim();
  const session = getSession(chatId);

  // Security check
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
          `❌ Couldn't transcribe the voice message.\n\n` +
          `*Tips:*\n• Speak clearly and close to mic\n• Keep it under 30 seconds\n• Say amounts clearly: _"spent two hundred on food"_\n\nOr just type: _"200 food, 80 uber"_`,
          { parse_mode: 'Markdown' }
        );
      }

      // Show transcript so user can verify
      await bot.sendMessage(chatId,
        `🎤 *I heard:*\n_"${transcript}"_\n\nProcessing this now...`,
        { parse_mode: 'Markdown' }
      );

      // Now parse the transcript as expenses
      return handleExpenseText(chatId, transcript, session);

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
      `✨ *Pro tip:* Type naturally or send a *voice message* 🎤\n` +
      `_"spent 200 food, 5000 mutual funds, salary 50000"_`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── /log ──
  if (text === '/log') {
    session.state = 'awaiting_entries';
    return bot.sendMessage(chatId,
      `📝 *What did you spend or earn?*\n\nType naturally or send a *🎤 voice message*:\n_"200 food, 5000 mutual funds, salary 50000"_`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── /uid — shows which Firebase UID the bot is writing to ──
  if (text === '/uid') {
    const uid = getFirebaseUid(chatId);
    return bot.sendMessage(chatId,
      `🔑 *Firebase UID in use:*\n\`${uid}\`\n\n` +
      (FIREBASE_USER_UID
        ? `✅ Using your Google Auth UID (from FIREBASE_USER_UID env var)\n\nThis matches your PWA data — entries will sync correctly!`
        : `⚠️ *FIREBASE_USER_UID not set!*\n\nCurrently using your Telegram ID as the UID.\nThis is different from your PWA's Google Auth UID, so data won't sync.\n\n*To fix:* Add FIREBASE_USER_UID to Railway environment variables.\nFind your UID: Firebase Console → Authentication → Users → copy UID`),
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
    return bot.sendMessage(chatId, '✅ Cancelled.');
  }

  // ── /summary ──
  if (text === '/summary') {
    try {
      const uid  = getFirebaseUid(chatId);
      const now  = new Date();
      const snap = await db.collection(`users/${uid}/entries`).get();
      const entries = snap.docs.map(d => d.data())
        .filter(e => e.date && e.date.y === now.getFullYear() && e.date.m === now.getMonth());

      if (entries.length === 0) {
        const uidNote = FIREBASE_USER_UID
          ? ''
          : `\n\n⚠️ _Note: FIREBASE_USER_UID not set — data may not match your PWA. Use /uid to check._`;
        return bot.sendMessage(chatId,
          `📊 No entries for this month yet. Use /log to add some!${uidNote}`,
          { parse_mode: 'Markdown' }
        );
      }

      const income  = entries.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);
      const expense = entries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
      const balance = income - expense;
      const MONTHS  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

      const catTotals = {};
      entries.filter(e => e.type === 'expense').forEach(e => {
        catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
      });
      const cats      = await getCategories(chatId);
      const breakdown = Object.entries(catTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat, amt]) => `${cats[cat]?.icon || '📌'} ${cat}: *₹${amt}*`)
        .join('\n');

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

  // ── Awaiting entries (text) ──
  if ((session.state === 'awaiting_entries' || session.state === 'idle') && text && !text.startsWith('/')) {
    const expenseKeywords = /spent|paid|bought|cost|expense|bill|food|lunch|dinner|breakfast|uber|taxi|salary|income|earned|received|got|mutual|invest|fund|gym|rent|petrol|fuel|recharge/i;
    if (session.state === 'idle' && !expenseKeywords.test(text)) {
      return bot.sendMessage(chatId,
        `Use /log to add expenses, /summary for overview, or /categories to list all categories.\nYou can also send a 🎤 voice message!`
      );
    }
    return handleExpenseText(chatId, text, session);
  }

  // ── Confirming yes/no ──
  if (session.state === 'confirming') {
    const lower = text.toLowerCase().trim();

    if (['yes','y','yeah','yep','ok','okay','sure','yup','haan','ha'].includes(lower)) {
      try {
        for (const cat of session.pendingNewCats) {
          await saveNewCategory(chatId, cat.name, cat.icon, cat.color, cat.type);
        }
        await saveEntriesToFirebase(chatId, session.pendingEntries);

        const count    = session.pendingEntries.length;
        const newCount = session.pendingNewCats.length;
        session.state = 'idle';
        session.pendingEntries = [];
        session.pendingNewCats = [];

        let reply = `🎉 *Saved!* ${count} entr${count === 1 ? 'y' : 'ies'} added to MyWallet.`;
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
      return bot.sendMessage(chatId, '❌ Cancelled. Nothing saved.');
    }

    return bot.sendMessage(chatId, `Reply *yes* to save or *no* to cancel.`, { parse_mode: 'Markdown' });
  }
});

// ── Daily cron at 9 PM IST ────────────────────────────────────────────────────
cron.schedule('0 21 * * *', () => {
  console.log('[CRON] Sending daily reminder...');
  sendDailyReminder().catch(console.error);
}, { timezone: 'Asia/Kolkata' });

// ── Express keep-alive ────────────────────────────────────────────────────────
const app = express();
app.get('/',     (_, res) => res.send('MyWallet Bot is running! 🤖'));
app.get('/ping', (_, res) => res.send('pong'));
app.listen(process.env.PORT || 3000, () => console.log('✅ Server up on port', process.env.PORT || 3000));

console.log('🤖 MyWallet Bot started!');
console.log('📅 Daily reminder: 9:00 PM IST');
console.log('🔑 Firebase UID:', FIREBASE_USER_UID ? `Using ${FIREBASE_USER_UID}` : 'WARNING: FIREBASE_USER_UID not set — using Telegram ID');
