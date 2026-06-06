# MyWallet Telegram Bot 🤖

Logs your daily expenses via Telegram and syncs to Firebase automatically.

## Setup Steps

### 1. Get Gemini API Key (FREE)
1. Go to https://aistudio.google.com
2. Click "Get API Key" → "Create API key"
3. Copy the key

### 2. Get Firebase Service Account
1. Go to Firebase Console → Project Settings (gear icon)
2. Click "Service accounts" tab
3. Click "Generate new private key" → Download JSON file
4. Open the JSON file, copy ALL the content

### 3. Deploy to Railway (FREE)
1. Go to https://railway.app → Sign up with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Upload this folder or connect your GitHub repo
4. Go to "Variables" tab and add:
   - BOT_TOKEN = your telegram bot token
   - YOUR_CHAT_ID = your telegram chat id
   - GEMINI_KEY = your gemini api key
   - FIREBASE_SERVICE_ACCOUNT = paste entire service account JSON (minified, one line)
5. Deploy!

## Bot Commands
- /start — Welcome message
- /log — Log expenses manually
- /summary — See this month's summary
- /cancel — Cancel current operation

## Natural Language Examples
Just type naturally:
- "spent 200 on groceries and 80 on uber"
- "paid electricity bill 1500, had lunch 150"
- "received salary 50000"
- "coffee 60, medicines 200, petrol 500"
