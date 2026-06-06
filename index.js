require('dotenv').config();
const TelegramBot  = require('node-telegram-bot-api');
const admin        = require('firebase-admin');
const cron         = require('node-cron');
const express      = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Config ─────────────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const YOUR_CHAT_ID = process.env.YOUR_CHAT_ID;
const GEMINI_KEY   = process.env.GEMINI_KEY;

// ── Firebase Admin init ────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Telegram Bot ───────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ── Gemini AI ──────────────────────────────────────────────────────────────
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// ── Color palette for auto-assigning new categories ───────────────────────
const COLOR_PALETTE = [
  '#6366F1','#EC4899','#14B8A6','#F97316','#84CC16',
  '#06B6D4','#A855F7','#EF4444','#10B981','#F59E0B',
  '#3B82F6','#E11D48','#0EA5E9','#D946EF','#22C55E',
  '#FB923C','#8B5CF6','#2DD4BF','#FACC15','#F43F5E',
];

// Icon pool for auto-assigned categories
const ICON_POOL = ['💡','🎯','📈','🏦','🎓','✈️','🎮','🐾','🌿','💎',
                   '🔧','🎵','📱','🏋️','🧴','🍕','⚽','📚','🚀','🌟'];

// ── Default categories (always present) ───────────────────────────────────
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

// ── Load categories from Firebase (merges default + custom) ───────────────
async function getCategories(userId) {
  try {
    const snap = await db.doc(`users/${userId}/settings/categories`).get();
    const custom = snap.exists ? snap.data().categories || {} : {};
    return { ...DEFAULT_CATS, ...custom };
  } catch (e) {
    return { ...DEFAULT_CATS };
  }
}

// ── Save a new custom category to Firebase ────────────────────────────────
async function saveNewCategory(userId, name, icon, color, type = 'expense') {
  const snap = await db.doc(`users/${userId}/settings/categories`).get();
  const existing = snap.exists ? snap.data().categories || {} : {};
  existing[name] = { icon, color, type, custom: true };
  await db.doc(`users/${userId}/settings/categories`).set({ categories: existing });
}

// ── Pick next unused color from palette ───────────────────────────────────
function pickColor(existingCats) {
  const usedColors = Object.values(existingCats).map(c => c.color);
  return COLOR_PALETTE.find(c => !usedColors.includes(c)) || COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
}

function pickIcon(existingCats) {
  const usedIcons = Object.values(existingCats).map(c => c.icon);
  return ICON_POOL.find(i => !usedIcons.includes(i)) || '📌';
}

// ── AI: parse natural language into structured entries ─────────────────────
async function parseExpenses(text, categories) {
  const catNames = Object.keys(categories).join(', ');
  const prompt = `
You are an expense parser for a personal finance app.
The user described their expenses. Extract ALL of them into structured JSON.

Known categories: ${catNames}

Rules:
1. Match to a known category if it clearly fits.
2. If it doesn't fit any known category, use the most descriptive name for a NEW category (e.g. "Mutual Funds", "Gym", "Rent", "Pet Care").
3. Return ONLY a valid JSON array, no markdown, no explanation.

Each item must have:
- "type": "expense" or "income"
- "amount": number
- "label": short description (2-4 words)
- "category": best matching or new category name
- "isNewCategory": true if this is a brand new category not in the known list, false otherwise

Example:
User: "spent 5000 on mutual funds, 200 food, 80 uber, received 50000 salary"
Known: Food, Transport, Income, Other
Output: [
  {"type":"expense","amount":5000,"label":"Mutual funds","category":"Mutual Funds","isNewCategory":true},
  {"type":"expense","amount":200,"label":"Lunch","category":"Food","isNewCategory":false},
  {"type":"expense","amount":80,"label":"Uber","category":"Transport","isNewCategory":false},
  {"type":"income","amount":50000,"label":"Salary","category":"Income","isNewCategory":false}
]

Now parse: "${text}"

Return ONLY the JSON array:`;

  try {
    const result = await model.generateContent(prompt);
    const raw    = result.response.text().trim();
    const clean  = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('AI parse error:', e.message);
    return null;
  }
}

// ── Save entries to Firebase ───────────────────────────────────────────────
async function saveEntriesToFirebase(userId, entries) {
  const today   = new Date();
  const dateObj = { y: today.getFullYear(), m: today.getMonth(), d: today.getDate() };
  const batch   = db.batch();

  for (const entry of entries) {
    const id  = Date.now() + Math.floor(Math.random() * 99999);
    const ref = db.collection(`users/${userId}/entries`).doc(String(id));
    batch.set(ref, { id, type: entry.type, amount: entry.amount, label: entry.label, category: entry.category, date: dateObj });
    await new Promise(r => setTimeout(r, 3));
  }
  await batch.commit();
}

// ── Format entries for Telegram preview ───────────────────────────────────
function formatEntries(entries, categories) {
  return entries.map(e => {
    const cat  = categories[e.category];
    const icon = cat ? cat.icon : '📌';
    const sign = e.type === 'income' ? '+' : '-';
    const newTag = e.isNewCategory ? ' ✨ _new category_' : '';
    return `${icon} *${e.label}* — ${sign}${e.amount} (${e.category})${newTag}`;
  }).join('\n');
}

// ── Session state ──────────────────────────────────────────────────────────
const sessions = {};
function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { state: 'idle', pendingEntries: [], pendingNewCats: [] };
  return sessions[chatId];
}

// ── Daily reminder ─────────────────────────────────────────────────────────
async function sendDailyReminder() {
  const today   = new Date();
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  await bot.sendMessage(YOUR_CHAT_ID,
    `💰 *MyWallet Daily Check-in*\n\n` +
    `Hey! End of *${dateStr}*.\n\n` +
    `What did you spend or earn today? Just tell me naturally:\n\n` +
    `_"spent 200 groceries, 5000 mutual funds, 80 uber, got salary 50000"_\n\n` +
    `New categories are created automatically! 🚀`,
    { parse_mode: 'Markdown' }
  );
  getSession(YOUR_CHAT_ID).state = 'awaiting_entries';
}

// ── /categories command helper ─────────────────────────────────────────────
async function showCategories(chatId) {
  const cats = await getCategories(chatId);
  const lines = Object.entries(cats).map(([name, c]) => `${c.icon} *${name}*`);
  return bot.sendMessage(chatId,
    `📂 *Your Categories (${lines.length})*\n\n${lines.join('\n')}\n\n_New ones are created automatically when you mention them!_`,
    { parse_mode: 'Markdown' }
  );
}

// ── Main message handler ───────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId  = String(msg.chat.id);
  const text    = (msg.text || '').trim();
  const session = getSession(chatId);

  if (chatId !== String(YOUR_CHAT_ID)) {
    return bot.sendMessage(chatId, '🔒 Private bot. Access denied.');
  }

  // ── /start ──
  if (text === '/start') {
    session.state = 'idle';
    return bot.sendMessage(chatId,
      `💰 *Welcome to MyWallet Bot!*\n\n` +
      `I remind you every *9 PM IST* to log expenses.\n\n` +
      `*Commands:*\n` +
      `/log — Log expenses now\n` +
      `/summary — This month's summary\n` +
      `/categories — View all your categories\n` +
      `/cancel — Cancel current action\n\n` +
      `✨ *Pro tip:* Mention any category — even new ones like "Mutual Funds" or "Gym" — and I'll create it automatically with a unique color!`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── /log ──
  if (text === '/log') {
    session.state = 'awaiting_entries';
    return bot.sendMessage(chatId,
      `📝 *What did you spend or earn?*\n\nJust type naturally:\n_"200 food, 5000 mutual funds, salary 50000"_`,
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
      const now  = new Date();
      const snap = await db.collection(`users/${chatId}/entries`).get();
      const entries = snap.docs.map(d => d.data())
        .filter(e => e.date && e.date.y === now.getFullYear() && e.date.m === now.getMonth());
      const income  = entries.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);
      const expense = entries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
      const balance = income - expense;
      const MONTHS  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

      // Category breakdown
      const catTotals = {};
      entries.filter(e => e.type === 'expense').forEach(e => {
        catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
      });
      const cats = await getCategories(chatId);
      const breakdown = Object.entries(catTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat, amt]) => `${cats[cat]?.icon || '📌'} ${cat}: *${amt}*`)
        .join('\n');

      return bot.sendMessage(chatId,
        `📊 *${MONTHS[now.getMonth()]} ${now.getFullYear()} Summary*\n\n` +
        `💵 Income:  *+${income}*\n` +
        `💸 Spent:   *-${expense}*\n` +
        `${balance >= 0 ? '✅' : '⚠️'} Balance: *${balance >= 0 ? '+' : ''}${balance}*\n\n` +
        (breakdown ? `*Top categories:*\n${breakdown}\n\n` : '') +
        `_Open MyWallet app for full breakdown_`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      return bot.sendMessage(chatId, '❌ Could not fetch summary.');
    }
  }

  // ── Awaiting entries ──
  if ((session.state === 'awaiting_entries' || session.state === 'idle') && text && !text.startsWith('/')) {
    const expenseKeywords = /spent|paid|bought|cost|expense|bill|food|lunch|dinner|breakfast|uber|taxi|salary|income|earned|received|got|mutual|invest|fund|gym|rent|petrol|fuel|recharge/i;
    if (session.state === 'idle' && !expenseKeywords.test(text)) {
      return bot.sendMessage(chatId,
        `Use /log to add expenses, /summary for overview, or /categories to see all categories.`
      );
    }

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

    // Find new categories and auto-assign color + icon
    const newCats = [];
    for (const entry of entries) {
      if (entry.isNewCategory && !categories[entry.category]) {
        const color = pickColor({ ...categories, ...Object.fromEntries(newCats.map(c => [c.name, c])) });
        const icon  = pickIcon({ ...categories, ...Object.fromEntries(newCats.map(c => [c.name, c])) });
        const type  = entry.type === 'income' ? 'income' : 'expense';
        newCats.push({ name: entry.category, icon, color, type });
        categories[entry.category] = { icon, color, type }; // add to local for formatting
      }
    }

    session.pendingEntries = entries;
    session.pendingNewCats = newCats;
    session.state = 'confirming';

    const preview  = formatEntries(entries, categories);
    const totalExp = entries.filter(e => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
    const totalInc = entries.filter(e => e.type === 'income').reduce((s, e) => s + e.amount, 0);

    let summaryLine = '';
    if (totalExp > 0) summaryLine += `\n💸 Total spent: *${totalExp}*`;
    if (totalInc > 0) summaryLine += `\n💵 Total income: *+${totalInc}*`;

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

  // ── Confirming ──
  if (session.state === 'confirming') {
    const lower = text.toLowerCase().trim();

    if (['yes','y','yeah','yep','ok','okay','sure','yup'].includes(lower)) {
      try {
        const categories = await getCategories(chatId);

        // Save new categories first
        for (const cat of session.pendingNewCats) {
          await saveNewCategory(chatId, cat.name, cat.icon, cat.color, cat.type);
        }

        // Save entries
        await saveEntriesToFirebase(chatId, session.pendingEntries);

        const count   = session.pendingEntries.length;
        const newCount = session.pendingNewCats.length;
        session.state = 'idle';
        session.pendingEntries = [];
        session.pendingNewCats = [];

        let msg = `🎉 *Saved!* ${count} entr${count === 1 ? 'y' : 'ies'} added to your wallet.`;
        if (newCount > 0) {
          msg += `\n✨ ${newCount} new categor${newCount === 1 ? 'y' : 'ies'} created with unique colors!`;
        }
        msg += `\n\nOpen MyWallet app to see your updated balance! 💰`;

        return bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      } catch (e) {
        console.error('Save error:', e);
        return bot.sendMessage(chatId, '❌ Error saving. Please try again.');
      }
    }

    if (['no','n','nope','cancel','nah'].includes(lower)) {
      session.state = 'idle';
      session.pendingEntries = [];
      session.pendingNewCats = [];
      return bot.sendMessage(chatId, '❌ Cancelled. Nothing saved.');
    }

    return bot.sendMessage(chatId, `Reply *yes* to save or *no* to cancel.`, { parse_mode: 'Markdown' });
  }
});

// ── Daily cron at 9 PM IST ─────────────────────────────────────────────────
cron.schedule('0 21 * * *', () => {
  console.log('[CRON] Sending daily reminder...');
  sendDailyReminder().catch(console.error);
}, { timezone: 'Asia/Kolkata' });

// ── Express keep-alive ─────────────────────────────────────────────────────
const app = express();
app.get('/',     (_, res) => res.send('MyWallet Bot is running! 🤖'));
app.get('/ping', (_, res) => res.send('pong'));
app.listen(process.env.PORT || 3000, () => console.log('Server up'));

console.log('🤖 MyWallet Bot started!');
console.log('📅 Daily reminder: 9:00 PM IST');
