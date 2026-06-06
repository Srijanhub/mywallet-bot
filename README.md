# MyWallet Telegram Bot 🤖

Logs your daily expenses via text or **voice message** 🎤 and syncs to Firebase.

## What's Fixed in This Version
- ✅ Voice messages now work — send a 🎤 voice note, Gemini transcribes it
- ✅ Firebase data sync fixed — add FIREBASE_USER_UID so bot writes to same place as your PWA

## Setup Steps

### 1. Get Gemini API Key (FREE)
1. Go to https://aistudio.google.com
2. Click "Get API Key" → "Create API key"
3. Copy the key

### 2. Get Firebase Service Account
1. Firebase Console → Project Settings (gear icon) → "Service accounts" tab
2. Click "Generate new private key" → Download JSON
3. Open the JSON, copy ALL the content (minify to one line for Railway)

### 3. Get YOUR Firebase Auth UID (important!)
This fixes the "data shows zero" bug — your PWA uses your Google UID, not your Telegram ID.
1. Firebase Console → Authentication → Users tab
2. Find your email → copy the UID column (looks like: abc123XYZetc)
3. Add it as FIREBASE_USER_UID in Railway

### 4. Deploy to Railway (FREE)
Add these environment variables in Railway → Variables tab:

| Key | Value |
|-----|-------|
| BOT_TOKEN | your telegram bot token |
| YOUR_CHAT_ID | your telegram chat id (8798778166) |
| GEMINI_KEY | your gemini api key |
| FIREBASE_SERVICE_ACCOUNT | entire service account JSON on one line |
| FIREBASE_USER_UID | your Google Auth UID from Firebase (fixes data sync!) |

## Bot Commands
- /start — Welcome message
- /log — Log expenses (text or voice)
- /summary — This month's summary
- /categories — View all categories
- /uid — Check which Firebase UID is being used
- /cancel — Cancel current operation

## Voice Message Usage
Just send a voice note saying:
> "spent 200 on groceries, 80 uber, 5000 mutual funds, got salary 50000"

The bot will transcribe it, show you what it heard, then ask you to confirm before saving.
