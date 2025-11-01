// start-bot.js
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// --- 1. Resolve and start the bot ---
const botPath = path.resolve(__dirname, 'project-justice', 'index.js');
console.log(`[Launcher] Starting bot from: ${botPath}`);
require(botPath);

// --- 2. Auto-manage webhook ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // set in your env
const WEBHOOK_URL = process.env.WEBHOOK_URL;       // e.g., Choreo endpoint

if (!TELEGRAM_TOKEN || !WEBHOOK_URL) {
  console.warn('[Webhook] TELEGRAM_TOKEN or WEBHOOK_URL not set. Skipping webhook setup.');
  process.exit(0);
}

const bot = new TelegramBot(TELEGRAM_TOKEN);

// Delete any existing webhook first
bot.deleteWebhook()
  .then(() => {
    console.log('[Webhook] Previous webhook deleted successfully.');

    // Set new webhook
    return bot.setWebHook(WEBHOOK_URL);
  })
  .then(() => {
    console.log(`[Webhook] New webhook registered: ${WEBHOOK_URL}`);
  })
  .catch((err) => {
    console.error('[Webhook] Error setting webhook:', err.message);
  });
