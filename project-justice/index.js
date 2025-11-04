require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const os = require("os");
const si = require('systeminformation');
const process = require("process");
const fs = require('fs');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;

// Parse JSON bodies (needed for webhook POSTs)
app.use(express.json());

app.get('/', (req, res) => {
  res.send("I'm alive! Bot is running.");
});

// Optional endpoint to trigger webhook setup manually (useful for debugging)
app.get('/setup-webhook', async (req, res) => {
  try {
    await setupWebhook();
    res.send("Webhook setup attempted - check logs.");
  } catch (e) {
    res.status(500).send("Failed to setup webhook, see logs.");
  }
});

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Error: BOT_TOKEN is not set in environment variables');
  process.exit(1);
}

// Create bot WITHOUT polling — we'll use webhook
const bot = new TelegramBot(token);

// Webhook configuration
const HOST = process.env.HOST; // e.g. https://yourdomain.com (MUST be HTTPS)
const WEBHOOK_PATH = `/bot${token}`; // route to receive updates
const WEBHOOK_URL = HOST ? `${HOST}${WEBHOOK_PATH}` : null;
const WEBHOOK_CERT_PATH = process.env.WEBHOOK_CERT_PATH || ''; // optional, for self-signed cert upload

// Helper: set webhook (delete/clear previous webhook first)
async function setupWebhook() {
  if (!WEBHOOK_URL) {
    console.warn('HOST not provided. Webhook not set. Set process.env.HOST to your public HTTPS URL (e.g. https://example.com).');
    return;
  }

  if (!WEBHOOK_URL.startsWith('https://')) {
    console.warn('Webhook URL must use HTTPS. Webhook was not set. Use a valid HTTPS URL in process.env.HOST.');
    return;
  }

  try {
    console.log('Deleting existing webhook (if any) and dropping pending updates...');
    // delete existing webhook & drop pending updates to clear state
    await bot.deleteWebHook({ drop_pending_updates: true });
  } catch (err) {
    console.warn('Warning: deleteWebHook returned error (continuing):', err && (err.response?.body || err.message || err));
  }

  try {
    console.log('Setting webhook to:', WEBHOOK_URL);
    if (WEBHOOK_CERT_PATH && fs.existsSync(WEBHOOK_CERT_PATH)) {
      // If you have a self-signed cert, upload it to Telegram
      const certStream = fs.createReadStream(WEBHOOK_CERT_PATH);
      await bot.setWebHook(WEBHOOK_URL, { certificate: certStream });
    } else {
      await bot.setWebHook(WEBHOOK_URL);
    }
    console.log('Webhook set successfully.');
  } catch (err) {
    console.error('Failed to set webhook:', err && (err.response?.body || err.message || err));
    throw err;
  }
}

// Register express route to receive updates from Telegram
app.post(WEBHOOK_PATH, (req, res) => {
  try {
    // Process update with node-telegram-bot-api
    bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('Error processing update:', err && err.message);
    res.sendStatus(500);
  }
});

// Start server and setup webhook
app.listen(PORT, async () => {
  console.log(`Keep-alive server is running on port ${PORT}`);
  try {
    await setupWebhook();
  } catch (err) {
    console.error('Webhook setup failed. Make sure HOST is reachable and HTTPS. You can fallback to polling for local testing.');
  }
});

/* ---------- Database init ---------- */
async function initializeBotDatabase() {
  try {
    await db.initializeDatabase();
    console.log('✅ Bot database initialized successfully');
    
    // Start automatic maintenance tasks every 6 hours
    setInterval(async () => {
      console.log('🔄 Running scheduled maintenance tasks...');
      try {
        await db.runMaintenanceTasks();
        console.log('✅ Scheduled maintenance completed');
      } catch (error) {
        console.error('❌ Maintenance task error:', error);
      }
    }, 6 * 60 * 60 * 1000); // 6 hours
    
    // Start automatic tracking update every 10 minutes
    setInterval(async () => {
      console.log('🔄 Running tracking updates...');
      try {
        const allUsers = await db.getAllUsers();
        for (const user of allUsers) {
          await db.updateEngagementTier(user.id);
        }
        console.log('✅ Tracking updates completed');
      } catch (error) {
        console.error('❌ Tracking update error:', error);
      }
    }, 10 * 60 * 1000); // 10 minutes
    
  } catch (error) {
    console.error('❌ Bot database initialization failed:', error);
    process.exit(1);
  }
}
initializeBotDatabase();

/* ---------- Config constants ---------- */
const ADMIN_IDS = [ 7561048693, 6450400107, 5470178483, 5713536787, 6221435595, -1003140359659];
const ADMIN_GROUP_ID = Number(process.env.ADMIN_GROUP_ID || -1003140359659);
const BROADCAST_CHANNEL = process.env.BROADCAST_CHANNEL || "@livetransactiontrack";

const VERIFY_CHANNELS = [
  "@livetransactiontrack",
  "@Justiceonsolana1",
  "@justiceonsolana",
  "@ComeOEXOfficial",
  "https://x.com/onchain_justice?t=6QUIvpSUESeDRUGwDXoZSQ&s=09"
];

const CHANNELS_TO_VERIFY = [
  "@livetransactiontrack",
  "@Justiceonsolana1",
  "@justiceonsolana"
];

const BOT_USERNAME = process.env.BOT_USERNAME || "justiceonsolana333bot";
const ABOUT_US_URL = process.env.ABOUT_US_URL || "https://t.me/justiceonsolana/5";
const SUPPORT_URL = process.env.SUPPORT_URL || "https://t.me/justiceonsolbot";

const TASK_REVIEW_CHANNEL = process.env.TASK_REVIEW_CHANNEL || "@livetransactiontrack";
const WITHDRAW_REVIEW_CHANNEL = process.env.WITHDRAW_REVIEW_CHANNEL || "@livetransactiontrack";

const CURRENCY_SYMBOL = "⚖️";
const BOT_NAME = "JUSTICE on Sol";

let pendingTasks = {};
let awaitingWallet = {};
const awaitingIntroUpload = {}; // admin flow for /introvideo
global.userLatestMessage = {}; // Track last message per user per chat

/* ---------- Utility helpers (copied & merged from working code) ---------- */
function isAdminId(id) {
  return ADMIN_IDS.indexOf(Number(id)) !== -1;
}

async function getUserIdentifier(userId) {
  const user = await db.getUser(userId);
  if (user && user.username) {
    return `@${user.username}`;
  }
  return userId;
}

async function resolveUserInput(input) {
  if (typeof input === 'string' && input.startsWith('@')) {
    const username = input.substring(1).toLowerCase();
    const users = await db.getAllUsers();
    for (const user of users) {
      if (user.username && user.username.toLowerCase() === username) {
        return user.id;
      }
    }
    return null;
  }
  return input;
}

function getStarRating(percentage) {
  if (percentage >= 100) return "🌟🌟🌟🌟🌟";
  if (percentage >= 70) return "🌟🌟🌟🌟";
  if (percentage >= 40) return "🌟🌟🌟";
  if (percentage >= 25) return "🌟🌟";
  if (percentage >= 10) return "🌟";
  if (percentage >= 8) return "❌";
  return "❌❌❌❌❌";
}

async function logAdmin(text) {
  try {
    await bot.sendMessage(BROADCAST_CHANNEL, text);
  } catch (e) {
    console.error('Error logging to admin:', e && e.message);
  }
}

async function sendEphemeralWarning(chatId, text, timeout = 2000) {
  try {
    const msg = await bot.sendMessage(chatId, text);
    setTimeout(async () => {
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (e) {}
    }, timeout);
  } catch (e) {}
}

async function sendAutoDeleteMessage(chatId, text, timeout = 120000) {
  try {
    const msg = await bot.sendMessage(chatId, text);
    setTimeout(async () => {
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (e) {}
    }, timeout);
    return msg;
  } catch (e) {
    return null;
  }
}

// =============== Auto-delete helper ====================
async function sendAndAutoDelete(chatId, text, timeout = 30000, options = {}) {
  try {
    const sent = await bot.sendMessage(chatId, text, options);
    setTimeout(() => {
      bot.deleteMessage(chatId, sent.message_id).catch(() => {});
    }, timeout);
    return sent;
  } catch (e) { 
    return null; 
  }
}

async function deleteMessageLater(chatId, message_id, timeout = 30000) {
  setTimeout(() => {
    bot.deleteMessage(chatId, message_id).catch(() => {});
  }, timeout);
}

// Broadcast helper (review/admin channel notification)
async function broadcastAdminAction(msgText) {
  try {
    await bot.sendMessage(TASK_REVIEW_CHANNEL, msgText);
  } catch (e) {
    console.error('Error broadcasting admin action:', e && e.message);
  }
}

function isHttpUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/**
 * Sanitize HTML used with parse_mode='HTML' for Telegram.
 * - Replaces <br> tags with newlines.
 * - Keeps allowed tags like <b>, <i>, <a>, <code>, <pre>.
 */
function sanitizeHtmlForTelegram(html) {
  if (!html || typeof html !== 'string') return '';
  // Replace <br> tags with newline
  let out = html.replace(/<br\s*\/?>/gi, '\n');
  // Trim extra spaces
  out = out.trim();
  return out;
}

/**
 * Helper for sending welcome media:
 * - Accepts local file path, Telegram file_id, or direct media URL (mp4/webm/gif).
 * - If provided a web page URL (Vimeo page or similar), it will send the welcome text with a Watch button instead.
 */
async function trySendVideoOrAnimation(source, chatId, welcomeText, replyKeyboard) {
  const directMediaExt = /\.(mp4|webm|mov|mkv|gif)(\?.*)?$/i;
  const isUrl = typeof source === 'string' && isHttpUrl(source);
  const isLocalFile = typeof source === 'string' && fs.existsSync(source);
  const looksLikeDirectMedia = (isUrl && directMediaExt.test(source)) || isLocalFile;

  const sanitizedText = sanitizeHtmlForTelegram(welcomeText);

  // If it's a webpage URL (Vimeo/watch page), send as text + watch button (use inline keyboard)
  if (isUrl && !looksLikeDirectMedia) {
    console.log('Info: welcome source is a webpage — sending text with link button.');
    const inline = { inline_keyboard: [[{ text: "▶️ Watch video", url: source }]] };
    try {
      await bot.sendMessage(chatId, sanitizedText, {
        parse_mode: 'HTML',
        reply_markup: inline
      });
    } catch (err) {
      console.error('Failed to send fallback welcome message:', err && (err.response?.body || err.message || err));
    }
    return;
  }

  // If local file exists, stream it
  if (isLocalFile) {
    try {
      const stream = fs.createReadStream(source);
      const res = await bot.sendVideo(chatId, stream, {
        caption: sanitizedText,
        parse_mode: 'HTML',
        reply_markup: replyKeyboard
      });
      console.log('✅ Sent local video file. file_id:', res.video && res.video.file_id);
      return;
    } catch (err) {
      console.warn('sendVideo from local file failed:', err && (err.response?.body || err.message || err));
      // fall through to trying other methods
    }
  }

  // Try sending as video (works for file_id or direct media URL)
  try {
    const res = await bot.sendVideo(chatId, source, {
      caption: sanitizedText,
      parse_mode: 'HTML',
      reply_markup: replyKeyboard
    });
    console.log('✅ Sent as video (file_id or direct URL). file_id:', res.video && res.video.file_id);
    return;
  } catch (videoError) {
    console.warn('sendVideo failed:', videoError && (videoError.response?.body || videoError.message || videoError));
    // Try as animation (GIF)
    try {
      const res2 = await bot.sendAnimation(chatId, source, {
        caption: sanitizedText,
        parse_mode: 'HTML',
        reply_markup: replyKeyboard
      });
      console.log('✅ Sent as animation. file_id:', res2.animation && res2.animation.file_id);
      return;
    } catch (animError) {
      console.warn('sendAnimation failed:', animError && (animError.response?.body || animError.message || animError));
      // Finally, fallback to sendMessage (use sanitized text)
      try {
        await bot.sendMessage(chatId, sanitizedText, {
          parse_mode: 'HTML',
          reply_markup: replyKeyboard
        });
        console.log('✅ Sent fallback welcome text');
      } catch (msgErr) {
        console.error('❌ Failed to send fallback welcome text:', msgErr && (msgErr.response?.body || msgErr.message || msgErr));
      }
    }
  }
}

/* ---------- Monkey-patch send methods to track replies (used by auto-delete) ---------- */
const recentReplies = new Map();
function patchSend(method) {
  const original = bot[method].bind(bot);
  bot[method] = async (...args) => {
    const msg = await original(...args);
    bot.emit("sent_reply", msg);
    return msg;
  };
}
["sendMessage", "sendPhoto", "sendDocument", "sendVideo", "sendAnimation", "sendAudio", "sendMediaGroup"].forEach(
  patchSend
);

/* ---------- ADMIN: /introvideo and /cancelintro handlers ---------- */
/*
  Usage:
   - /introvideo                -> enter interactive upload mode (send media, URL, or file_id)
   - /introvideo <url-or-fileid> -> quick set (no upload mode)
   - /cancelintro               -> cancel interactive mode
*/
bot.onText(/\/introvideo(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const param = match && match[1] ? match[1].trim() : null;
  if (param) {
    // Quick-set mode: admin provided a URL or file_id inline
    try {
      if (/^https?:\/\//i.test(param)) {
        const type = (/\.(mp4|webm|mov|mkv|gif)(\?.*)?$/i.test(param)) ? 'url_media' : 'url_page';
        await db.setSetting('introVideo', param);
        await db.setSetting('introVideoType', type);
        await bot.sendMessage(chatId, `✅ Intro saved as URL (type: ${type}).`);
      } else {
        // treat as file_id or text
        const t = param;
        const inferredType = /^\d+:[A-Za-z0-9_-]+$/.test(t) ? 'file_id' : 'file_id';
        await db.setSetting('introVideo', t);
        await db.setSetting('introVideoType', inferredType);
        await bot.sendMessage(chatId, '✅ Intro saved as file_id/text.');
      }
    } catch (err) {
      console.error('Error saving intro (quick mode):', err && (err.response?.body || err.message || err));
      await bot.sendMessage(chatId, '❌ Failed to save intro. Check server logs for details.');
    }
    return;
  }

  // Interactive mode
  awaitingIntroUpload[userId] = true;
  await bot.sendMessage(chatId, '📹 Please send the intro video, animation (GIF), document, file_id, or media/web URL. Send /cancelintro to abort.');
});

bot.onText(/\/cancelintro/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  if (awaitingIntroUpload[userId]) {
    delete awaitingIntroUpload[userId];
    await bot.sendMessage(chatId, '❌ Intro upload cancelled.');
  } else {
    await bot.sendMessage(chatId, 'No intro upload in progress.');
  }
});

/* ---------- Activity Tracking Middleware ---------- */
bot.on('message', async (m) => {
  if (!m.from || m.from.is_bot) return;
  const uid = m.from.id;
  const chatId = m.chat.id;
  const text = m.text;
  const username = m.from.username || '';
  const languageCode = m.from.language_code || null;
  
  // Track all activity in admin group and bot
  const isAdminGroup = chatId === ADMIN_GROUP_ID;
  const chatType = m.chat.type || 'private';
  
  // IMPORTANT: Ensure user exists FIRST before logging activity
  try {
    // Note: Telegram doesn't provide country_code directly, we'll try to infer from language_code
    await db.ensureUser(uid, username, true, { chatType, chatId }, null, languageCode);
  } catch (error) {
    console.error('Error ensuring user:', error);
  }
  
  // Log activity AFTER user is created
  try {
    const activityType = text?.startsWith('/') ? 'command' : 
                        m.photo ? 'photo' : 
                        m.video ? 'video' : 
                        m.document ? 'document' : 'message';
    
    await db.logActivity(uid, activityType, {
      chatId,
      chatType,
      text: text?.substring(0, 100),
      hasMedia: !!(m.photo || m.video || m.document)
    }, chatId, chatType);
    
    // Update command count if it's a command
    if (text?.startsWith('/')) {
      const user = await db.getUser(uid);
      if (user) {
        await db.updateUser(uid, {
          command_count: (user.command_count || 0) + 1
        });
      }
    }
    
    // Check for spam
    const spamCheck = await db.checkSpamBehavior(uid);
    if (spamCheck.isSpamming) {
      await bot.sendMessage(chatId, '⚠️ Slow down! You are sending messages too quickly. Please wait a moment.');
      return;
    }
    
    // Check if throttled
    const isThrottled = await db.isUserThrottled(uid);
    if (isThrottled) {
      return; // Silently ignore throttled users
    }
    
  } catch (error) {
    console.error('Activity tracking error:', error);
  }

  // Debug logging for incoming update
  console.log(`Incoming message from ${uid} in chat ${chatId} - text: ${text ? text.substring(0,80) : '<no text>'}`);

  // Log incoming file_ids for debugging
  try {
    if (m.video) console.log('Received video file_id:', m.video.file_id);
    if (m.animation) console.log('Received animation file_id:', m.animation.file_id);
    if (m.document) console.log('Received document file_id:', m.document.file_id);
    if (m.photo) console.log('Received photo file_ids:', m.photo.map(p => p.file_id).join(','));
  } catch (e) {}

  // If admin is in intro upload flow, handle saving intro (higher priority)
  if (awaitingIntroUpload[uid]) {
    try {
      if (m.video) {
        await db.setSetting('introVideo', m.video.file_id);
        await db.setSetting('introVideoType', 'video');
        await bot.sendMessage(chatId, '✅ Intro video saved (video.file_id).');
        delete awaitingIntroUpload[uid];
        return;
      }
      if (m.animation) {
        await db.setSetting('introVideo', m.animation.file_id);
        await db.setSetting('introVideoType', 'animation');
        await bot.sendMessage(chatId, '✅ Intro animation saved (animation.file_id).');
        delete awaitingIntroUpload[uid];
        return;
      }
      if (m.document) {
        await db.setSetting('introVideo', m.document.file_id);
        await db.setSetting('introVideoType', 'document');
        await bot.sendMessage(chatId, '✅ Intro saved as document (document.file_id).');
        delete awaitingIntroUpload[uid];
        return;
      }
      if (m.photo) {
        // Accept first photo as intro document (optional)
        const photo = m.photo[m.photo.length - 1];
        await db.setSetting('introVideo', photo.file_id);
        await db.setSetting('introVideoType', 'photo');
        await bot.sendMessage(chatId, '✅ Intro saved as photo.');
        delete awaitingIntroUpload[uid];
        return;
      }
      if (m.text && m.text.trim()) {
        const t = m.text.trim();
        if (/^https?:\/\//i.test(t)) {
          const type = (/\.(mp4|webm|mov|mkv|gif)(\?.*)?$/i.test(t)) ? 'url_media' : 'url_page';
          await db.setSetting('introVideo', t);
          await db.setSetting('introVideoType', type);
          await bot.sendMessage(chatId, `✅ Intro saved as URL (type: ${type}).`);
        } else {
          // treat as file_id or raw file id text
          await db.setSetting('introVideo', t);
          await db.setSetting('introVideoType', 'file_id');
          await bot.sendMessage(chatId, '✅ Intro saved as file_id/text.');
        }
        delete awaitingIntroUpload[uid];
        return;
      }

      await bot.sendMessage(chatId, '❌ Unsupported message. Please send a video, animation (GIF), document, photo, or paste a file_id/URL. Send /cancelintro to abort.');
    } catch (err) {
      console.error('Error saving intro media:', err && (err.response?.body || err.message || err));
      await bot.sendMessage(chatId, '❌ Failed to save intro. Check server logs for details.');
      delete awaitingIntroUpload[uid];
    }
    return; // important: if we were in intro flow, we handled the message
  }

  // Disable menu buttons in admin group - only commands work
  if (isAdminGroup && text && !text.startsWith('/')) {
    // Check if it's a menu button
    const menuButtons = ["➡️ Continue", "🎯 Task", "🎁 Bonus", "💼 Trade", "💳 Set Wallet", 
                        "👥 Referral", "💰 Balance", "💸 Withdrawal", "ℹ️ About Us", "💬 Support", "📊 Stats"];
    if (menuButtons.includes(text)) {
      await bot.sendMessage(chatId, '⚠️ Menu buttons are disabled in this group. Please use commands instead.');
      return;
    }
  }

  // If the message is a reply-triggering UI button (➡️ Continue)
  if (text === "➡️ Continue") {
    const ch = VERIFY_CHANNELS;
    const inlineKeyboard = [
      [{ text: ch[0], url: ch[0].startsWith("http") ? ch[0] : `https://t.me/${ch[0].replace(/^@/, '')}` }],
      [
        { text: ch[1], url: ch[1].startsWith("http") ? ch[1] : `https://t.me/${ch[1].replace(/^@/, '')}` },
        { text: ch[2], url: ch[2].startsWith("http") ? ch[2] : `https://t.me/${ch[2].replace(/^@/, '')}` }
      ],
      [
        { text: ch[3], url: ch[3].startsWith("http") ? ch[3] : `https://t.me/${ch[3].replace(/^@/, '')}` },
        { text: ch[4], url: ch[4].startsWith("http") ? ch[4] : `https://t.me/${ch[4].replace(/^@/, '')}` }
      ],

      [{ text: "✅ Verify", callback_data: "verify_now" }]
    ];
    await bot.sendMessage(chatId, "📢 Please join all the channels below, then press Verify.", {
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
    return;
  }

  if (text === "🎯 Task") {
    await handleTask(chatId, uid);
    return;
  }
  if (text === "🎁 Bonus") {
    await handleBonus(chatId, uid);
    return;
  }
  if (text === "💼 Trade") {
    await bot.sendMessage(chatId, "💼 Trade feature coming soon!");
    return;
  }
  if (text === "💳 Set Wallet") {
    await handleSetWallet(chatId, uid);
    return;
  }
  if (text === "👥 Referral") {
    await handleReferral(chatId, uid);
    return;
  }
  if (text === "💰 Balance") {
    await handleBalance(chatId, uid);
    return;
  }
  if (text === "💸 Withdrawal") {
    await handleWithdrawalMenu(chatId, uid);
    return;
  }
  if (text === "ℹ️ About Us") {
    await bot.sendMessage(chatId, "About Us", {
      reply_markup: {
        inline_keyboard: [[{ text: "Open About Us", url: ABOUT_US_URL }]]
      }
    });
    return;
  }
  if (text === "💬 Support") {
    const supportLink = SUPPORT_URL.startsWith("http") ? SUPPORT_URL : `https://t.me/${SUPPORT_URL.replace(/^@/, '')}`;
    await bot.sendMessage(chatId, "Support", {
      reply_markup: {
        inline_keyboard: [[{ text: "Open Support", url: supportLink }]]
      }
    });
    return;
  }
  if (text === "📊 Stats") {
    await handleStats(chatId);
    return;
  }

  if (awaitingWallet[uid]) {
    const addr = text.trim();
    await db.updateUser(uid, { wallet: addr });
    delete awaitingWallet[uid];
    await bot.sendMessage(chatId, `✅ Wallet saved: ${addr}`);
    return;
  }

  if (pendingTasks[uid]) {
    if (m.photo) {
      const photo = m.photo[m.photo.length - 1];
      pendingTasks[uid].files.push(photo.file_id);
      const imageCount = pendingTasks[uid].files.length;
      await bot.sendMessage(chatId, `✅ Image ${imageCount} received. Send more images or press Done when finished.`, {
        reply_markup: {
          inline_keyboard: [[{ text: "Done", callback_data: "finish_task_submit" }]]
        }
      });
      return;
    }
    if (text && text !== "Done") {
      pendingTasks[uid].text += "\n" + text;
      await bot.sendMessage(chatId, "✅ Description saved. Send more or press Done.");
      return;
    }
  }
});

/* ---------- /start handler (only one) ---------- */
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || "";
  const languageCode = msg.from.language_code || null;
  const startParam = match[1];

  console.log(`/start triggered by ${userId}. param: ${startParam || '<none>'}`);

  try {
    await db.ensureUser(userId, username, false, {}, null, languageCode);

    if (startParam && startParam !== String(userId)) {
      const user = await db.getUser(userId);
      if (!user.referred_by) {
        await db.updateUser(userId, { referred_by: startParam });
      }
    }

    const localWelcomePath = path.join(__dirname, 'project-justice', 'intro.mp4');

    const welcomeTextRaw = `
<b>Hey there, ${msg.from.first_name || ''}</b> 👋

Welcome to the <b>Justice on Solana</b> community ⚖️

We’re redefining fairness in crypto and Web3 🌐✨  
This isn’t just a project — it’s a <b>movement 🚀</b> for accountability ✅, protection 🛡️, and transparency 🔍 through smart contracts and community governance 🤝

As a member, you’ll:  
• 🪙 Get updates on milestones and drops  
• 🧠 Discuss blockchain law & DeFi safety  
• 🤝 Connect with advocates and builders  
• 🧩 Help shape decentralized justice on Solana  

Your voice matters here.  
Together we build a <b>fairer, safer Web3 🔐✨</b>

<b>On-chain justice is unstoppable ♾️⚖️</b>  
<i>#JusticeOnSolana #Solana #Web3 #CryptoLaw</i>
`;

    const welcomeText = sanitizeHtmlForTelegram(welcomeTextRaw);

    const keyboard = {
      keyboard: [["➡️ Continue"]],
      resize_keyboard: true,
      one_time_keyboard: true
    };

    try {
      const savedIntro = await db.getSetting('introVideo');
      const savedType = await db.getSetting('introVideoType');

      if (savedIntro) {
        if (savedType === 'document') {
          try {
            await bot.sendDocument(chatId, savedIntro, {
              caption: welcomeText,
              parse_mode: 'HTML',
              reply_markup: keyboard
            });
          } catch (err) {
            console.warn('sendDocument failed, falling back:', err && (err.response?.body || err.message || err));
            await trySendVideoOrAnimation(savedIntro, chatId, welcomeText, keyboard);
          }
        } else if (savedType === 'animation') {
          try {
            await bot.sendAnimation(chatId, savedIntro, {
              caption: welcomeText,
              parse_mode: 'HTML',
              reply_markup: keyboard
            });
          } catch (err) {
            console.warn('sendAnimation failed, falling back:', err && (err.response?.body || err.message || err));
            await trySendVideoOrAnimation(savedIntro, chatId, welcomeText, keyboard);
          }
        } else if (savedType === 'photo') {
          try {
            await bot.sendPhoto(chatId, savedIntro, {
              caption: welcomeText,
              parse_mode: 'HTML',
              reply_markup: keyboard
            });
          } catch (err) {
            console.warn('sendPhoto failed, falling back:', err && (err.response?.body || err.message || err));
            await trySendVideoOrAnimation(savedIntro, chatId, welcomeText, keyboard);
          }
        } else {
          await trySendVideoOrAnimation(savedIntro, chatId, welcomeText, keyboard);
        }
      } else {
        if (fs.existsSync(localWelcomePath)) {
          await trySendVideoOrAnimation(localWelcomePath, chatId, welcomeText, keyboard);
        } else {
          const defaultUrl = 'https://vimeo.com/1131147244?share=copy&fl=sv&fe=ci';
          await trySendVideoOrAnimation(defaultUrl, chatId, welcomeText, keyboard);
        }
      }
    } catch (e) {
      console.error('Error in /start welcome flow:', e && (e.response?.body || e.message || e));
      try {
        await bot.sendMessage(chatId, welcomeText, { parse_mode: 'HTML', reply_markup: keyboard });
      } catch (err) {
        console.error('Final fallback sendMessage failed:', err && (err.response?.body || err.message || err));
      }
    }
  } catch (e) {
    console.error('Unhandled error in /start handler:', e && (e.response?.body || e.message || e));
    try {
      await bot.sendMessage(chatId, '❌ An error occurred while processing /start. Please try again later.');
    } catch (err) {}
  }
});

/* ---------- callback_query handlers ---------- */
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  const username = query.from.username || '';
  const languageCode = query.from.language_code || null;
  
  // Ensure user exists first
  try {
    await db.ensureUser(userId, username, false, {}, null, languageCode);
  } catch (error) {
    console.error('Error ensuring user in callback:', error);
  }
  
  // Track button clicks
  try {
    await db.logActivity(userId, 'button_click', { data, chatId }, chatId, query.message.chat.type);
    const user = await db.getUser(userId);
    if (user) {
      await db.updateUser(userId, {
        button_click_count: (user.button_click_count || 0) + 1
      });
    }
  } catch (error) {
    console.error('Error tracking button click:', error);
  }

  if (data === "verify_now") {
    const missing = [];
    for (const ch of CHANNELS_TO_VERIFY) {
      try {
        const member = await bot.getChatMember(ch, userId);
        if (!['member', 'administrator', 'creator'].includes(member.status)) {
          missing.push(ch);
        }
      } catch (e) {
        missing.push(ch);
      }
    }

    if (missing.length > 0) {
      await bot.answerCallbackQuery(query.id, {
        text: "Please join all required Telegram channels and try again.",
        show_alert: true
      });
      return;
    }

    const user = await db.getUser(userId);
    if (!user.verified) {
      await db.updateUser(userId, { verified: true });
      if (user.referred_by) {
        const referralReward = parseFloat(await db.getSetting('referralReward')) || 20;
        const referrer = await db.getUser(user.referred_by);
        await db.updateUser(user.referred_by, { balance: parseFloat(referrer.balance) + referralReward });
        await db.addReferral(user.referred_by, userId);
        try {
          await bot.sendMessage(user.referred_by, `🎉 You earned ${referralReward} ${CURRENCY_SYMBOL} for referring a verified user!`);
        } catch (e) {}
      }
    }

    await bot.answerCallbackQuery(query.id, { text: "Verification successful!" });
    await showMenu(chatId);
    return;
  }

  if (data.startsWith("select_task:")) {
    const taskId = Number(data.split(":")[1]);
    const task = await db.getTaskById(taskId);

    if (!task) {
      await bot.answerCallbackQuery(query.id, { text: "Task not found!" });
      return;
    }

    pendingTasks[userId] = {
      files: [],
      text: "",
      userId: userId,
      taskId: taskId,
      taskTitle: task.title,
      taskReward: parseFloat(task.reward)
    };

    await bot.sendMessage(chatId, `📤 Submitting proof for: ${task.title}\n\nReward: ${task.reward} ${CURRENCY_SYMBOL}\n\n📸 Please send at least one screenshot or image as proof.\n\nYou can also add a description. Press Done when finished.`, {
      reply_markup: {
        inline_keyboard: [[{ text: "Done", callback_data: "finish_task_submit" }]]
      }
    });
    await bot.answerCallbackQuery(query.id);
    return;
  }

  if (data === "finish_task_submit") {
    const pending = pendingTasks[userId];

    if (!pending || !pending.files || pending.files.length === 0) {
      await bot.answerCallbackQuery(query.id, {
        text: "❌ Please send at least one image/screenshot before submitting!",
        show_alert: true
      });
      return;
    }

    await finishTaskSubmit(userId, chatId);
    await bot.answerCallbackQuery(query.id, { text: "Submission sent for review." });
    return;
  }

  if (data.startsWith("task_confirm:")) {
    const parts = data.split(":");
    const targetId = parts[1];
    const submissionId = parts[2];
    const messageType = query.message.photo ? 'photo' : 'text';
    await handleAdminTaskConfirm(userId, targetId, submissionId, query.message.chat.id, query.message.message_id, messageType);
    await bot.answerCallbackQuery(query.id, { text: "Task approved." });
    return;
  }

  if (data.startsWith("task_reject:")) {
    const parts = data.split(":");
    const targetId = parts[1];
    const submissionId = parts[2];
    const messageType = query.message.photo ? 'photo' : 'text';
    await handleAdminTaskReject(userId, targetId, submissionId, query.message.chat.id, query.message.message_id, messageType);
    await bot.answerCallbackQuery(query.id, { text: "Task rejected." });
    return;
  }

  if (data.startsWith("withdraw_confirm:")) {
    const parts = data.split(":");
    const targetId = parts[1];
    const amount = Number(parts[2]);
    await handleAdminWithdrawConfirm(userId, targetId, amount, query.message.chat.id);
    await bot.answerCallbackQuery(query.id, { text: "Withdrawal approved." });
    return;
  }

  if (data.startsWith("withdraw_reject:")) {
    const parts = data.split(":");
    const targetId = parts[1];
    await handleAdminWithdrawReject(userId, targetId, query.message.chat.id);
    await bot.answerCallbackQuery(query.id, { text: "Withdrawal rejected." });
    return;
  }
});

/* ---------- Remaining command handlers (admin & user commands) ----------
   These functions are the same as your working implementations and are included verbatim.
   For brevity they are pasted directly below. You can adjust them if needed.
*/

/* showMenu, handleTask, handleBonus, handleSetWallet, handleReferral, handleBalance,
   handleWithdrawalMenu, handleStats, finishTaskSubmit, handleAdminTaskConfirm,
   handleAdminTaskReject, handleAdminWithdrawConfirm, handleAdminWithdrawReject,
   /requestwithdraw, /addtask, /deletetask, /listtasks, /setconfig, /getconfig,
   /broadcast, /userinfo, /addbalance, /removebalance, /approveall, /rejectall,
   /pendingsubmissions, /openwithdrawal, /closewithdrawal, /stats, /referral,
   /leaderboard, /aboutus, /support, /bonus, /referralreward
*/

/* (Below: verbatim implementations from your original working code) */

async function showMenu(chatId) {
  // Don't show menu in admin group
  if (chatId === ADMIN_GROUP_ID) {
    await bot.sendMessage(chatId, "🏠 Use commands to interact with the bot in this group.");
    return;
  }
  
  const keyboard = {
    keyboard: [
      ["🎯 Task", "🎁 Bonus"],
      ["💼 Trade", "💳 Set Wallet"],
      ["👥 Referral", "💰 Balance"],
      ["💸 Withdrawal", "📊 Stats"],
      ["ℹ️ About Us", "💬 Support"]
    ],
    resize_keyboard: true
  };
  await bot.sendMessage(chatId, "🏠 Main Menu — Choose an option:", { reply_markup: keyboard });
}

async function handleTask(chatId, userId) {
  const completedTaskIds = await db.getUserCompletedTasks(userId);
  const allTasks = await db.getTasks('active');
  
  const availableTasks = allTasks.filter(task => !completedTaskIds.includes(task.id));
  
  if (availableTasks.length === 0) {
    await bot.sendMessage(chatId, "🎯 No tasks available at the moment. You've completed all tasks or check back later!");
    return;
  }
  
  let text = "🎯 Available Tasks:\n\n";
  availableTasks.forEach((task, index) => {
    text += `${index + 1}. ${task.title}\n   ${task.description}\n   Reward: ${task.reward} ${CURRENCY_SYMBOL}\n\n`;
  });
  text += "Select a task to complete:";
  
  const inlineButtons = availableTasks.map(task => ([{
    text: `✅ ${task.title}`,
    callback_data: `select_task:${task.id}`
  }]));
  
  const inlineKeyboard = { inline_keyboard: inlineButtons };
  await bot.sendMessage(chatId, text, { reply_markup: inlineKeyboard });
}

async function handleBonus(chatId, userId) {
  const user = await db.getUser(userId);
  const now = Date.now();
  const lastClaim = user.last_bonus_claim || 0;
  const timeSinceLastClaim = now - lastClaim;
  const twentyFourHours = 24 * 60 * 60 * 1000;
  
  if (timeSinceLastClaim < twentyFourHours) {
    const timeLeft = twentyFourHours - timeSinceLastClaim;
    const hoursLeft = Math.floor(timeLeft / (60 * 60 * 1000));
    const minutesLeft = Math.floor((timeLeft % (60 * 60 * 1000)) / (60 * 1000));
    await bot.sendMessage(chatId, `⏰ Bonus available in ${hoursLeft}h ${minutesLeft}m`);
    return;
  }
  
  const bonus = parseFloat(await db.getSetting('bonusAmount')) || 3;
  const newBalance = parseFloat(user.balance) + bonus;
  
  await db.updateUser(userId, { 
    balance: newBalance,
    last_bonus_claim: now
  });
  
  await bot.sendMessage(chatId, `🎁 Bonus added: ${bonus} ${CURRENCY_SYMBOL}\nCurrent balance: ${newBalance} ${CURRENCY_SYMBOL}\n\nNext bonus in 24 hours!`);
}

async function handleSetWallet(chatId, userId) {
  await bot.sendMessage(chatId, "🔐 Please send your wallet address now.");
  awaitingWallet[userId] = true;
}

async function handleReferral(chatId, userId) {
  const referralReward = parseFloat(await db.getSetting('referralReward')) || 20;
  const refCount = await db.getReferralCount(userId);
  const link = `https://t.me/${BOT_USERNAME}?start=${userId}`;
  const earned = refCount * referralReward;
  
  await bot.sendMessage(chatId, `👥 Your referral link:\n${link}\n\nReferrals: ${refCount}\nEarned: ${earned} ${CURRENCY_SYMBOL}`);
}

async function handleBalance(chatId, userId) {
  const user = await db.getUser(userId);
  await bot.sendMessage(chatId, `${CURRENCY_SYMBOL} Balance: ${user.balance || 0}\nWallet: ${user.wallet || "(not set)"}`);
}

async function handleWithdrawalMenu(chatId, userId) {
  const withdrawalOpen = (await db.getSetting('withdrawalOpen')) === 'true';
  
  if (!withdrawalOpen) {
    await bot.sendMessage(chatId, "❌ Withdrawals are currently closed.");
    return;
  }
  
  const minWithdrawal = parseFloat(await db.getSetting('minWithdrawal')) || 50;
  const maxWithdrawal = parseFloat(await db.getSetting('maxWithdrawal')) || 10000;
  
  await bot.sendMessage(chatId, `💸 To request withdrawal send:\n/requestwithdraw <amount>\n\nMin: ${minWithdrawal} ${CURRENCY_SYMBOL}\nMax: ${maxWithdrawal} ${CURRENCY_SYMBOL}`);
}

async function handleStats(chatId) {
  const allUsers = await db.getAllUsers();
  const totalUsers = allUsers.length;
  const verifiedUsers = allUsers.filter(u => u.verified).length;
  const now = Date.now();
  const onlineUsers = allUsers.filter(u => (now - u.last_seen) < 300000).length;
  const offlineUsers = totalUsers - onlineUsers;

  const totalBalance = await db.getTotalBalance();
  const countryStats = await db.getCountryDistribution();
  
  // Note: systemHealth referenced here in original code; keep compatibility
  // Analyze all users for system health
  let realUsers = 0;
  let suspiciousUsers = 0;
  
  for (const user of allUsers) {
    const analysis = await db.analyzeReferralPattern(user.id);
    if (parseFloat(analysis.percentage) >= 50) {
      realUsers++;
    } else {
      suspiciousUsers++;
    }
  }
  
  const healthPercentage = totalUsers > 0 ? (realUsers / totalUsers) * 100 : 0;
  let healthScore;
  if (healthPercentage >= 80) healthScore = '⭐⭐⭐⭐⭐';
  else if (healthPercentage >= 60) healthScore = '⭐⭐⭐⭐';
  else if (healthPercentage >= 40) healthScore = '⭐⭐⭐';
  else if (healthPercentage >= 20) healthScore = '⭐⭐';
  else healthScore = '⭐';

  const systemHealth = {
    realUsers,
    suspiciousUsers,
    score: healthScore
  };

  let statsText = `📊 System Statistics\n\n` +
    `Total Users: ${totalUsers}\n` +
    `Real Users: ${systemHealth.realUsers}\n` +
    `Suspicious Users: ${systemHealth.suspiciousUsers}\n` +
    `Users Online: ${onlineUsers}\n` +
    `Users Offline: ${offlineUsers}\n` +
    `Total Balance: ${totalBalance} ${CURRENCY_SYMBOL}\n\n` +
    `Progress Score: ${systemHealth.score}`;
  
  // Add country distribution
  if (countryStats.length > 0) {
    statsText += `\n\n🌍 Countries Registered:\n`;
    const topCountries = countryStats.slice(0, 10);
    topCountries.forEach((country, index) => {
      const flag = getCountryFlag(country.country_code);
      statsText += `${index + 1}. ${flag} ${country.country_code || 'Unknown'}: ${country.count} users\n`;
    });
    if (countryStats.length > 10) {
      statsText += `... and ${countryStats.length - 10} more countries`;
    }
  }
  
  await bot.sendMessage(chatId, statsText);
}

// Helper function to get country flag emoji
function getCountryFlag(countryCode) {
  if (!countryCode || countryCode.length !== 2) return '🌐';
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt());
  return String.fromCodePoint(...codePoints);
}

async function finishTaskSubmit(userId, chatId) {
  const pending = pendingTasks[userId];
  if (!pending) {
    await bot.sendMessage(chatId, "No pending submission. Use 🎯 Task to start.");
    return;
  }

  if (!pending.files || pending.files.length === 0) {
    await bot.sendMessage(chatId, "❌ Error: At least one image/screenshot is required. Please upload an image before submitting.");
    return;
  }
  const userIdentifier = await getUserIdentifier(userId);

// Get full task details from DB so we can include its original description
const task = await db.getTaskById(pending.taskId);
const taskDescription = task?.description || "(no task description)";
const userDescription = pending.text && pending.text.trim() ? pending.text.trim() : "(no user comment)";

const caption = `📝 <b>New Task Submission</b>
User: ${userIdentifier}
Task: <b>${pending.taskTitle || 'Unknown'}</b>
Reward: ${pending.taskReward || 0} ${CURRENCY_SYMBOL}

<b>Task Description:</b>
${taskDescription}

<b>User Comment:</b>
${userDescription}

<b>Images:</b> ${pending.files.length}`;

  const submission = await db.createTaskSubmission(
    userId,
    pending.taskId,
    pending.taskTitle,
    pending.taskReward,
    pending.text,
    pending.files
  );

  const inlineKeyboard = {
    inline_keyboard: [[
      { text: "✅ Confirm", callback_data: `task_confirm:${userId}:${submission.id}` },
      { text: "❌ Reject", callback_data: `task_reject:${userId}:${submission.id}` }
    ]]
  };

  if (pending.files.length === 1) {
    await bot.sendPhoto(TASK_REVIEW_CHANNEL, pending.files[0], { 
      caption: caption,
      reply_markup: inlineKeyboard 
    });
  } else {
    const mediaGroup = pending.files.map((fileId, index) => ({
      type: 'photo',
      media: fileId,
      caption: index === 0 ? caption : undefined
    }));
    
    try {
      await bot.sendMediaGroup(TASK_REVIEW_CHANNEL, mediaGroup);
      await bot.sendMessage(TASK_REVIEW_CHANNEL, "👆 Review the submission above:", { reply_markup: inlineKeyboard });
    } catch (e) {
      await bot.sendPhoto(TASK_REVIEW_CHANNEL, pending.files[0], { 
        caption: caption,
        reply_markup: inlineKeyboard 
      });
      for (let i = 1; i < pending.files.length; i++) {
        try {
          await bot.sendPhoto(TASK_REVIEW_CHANNEL, pending.files[i]);
        } catch (err) {}
      }
    }
  }

  await bot.sendMessage(chatId, `✅ Your submission has been sent for review.\n\n📸 Images submitted: ${pending.files.length}`);
  delete pendingTasks[userId];
}

async function handleAdminTaskConfirm(adminId, targetId, submissionId, chatId, messageId, messageType) {
  if (!isAdminId(adminId)) {
    await sendEphemeralWarning(chatId, "⛔ You are not authorized!");
    return;
  }

  const submission = await db.getSubmissionById(submissionId);
  
  if (!submission || submission.status !== 'pending') {
    await sendAutoDeleteMessage(chatId, "❌ Submission not found or already processed.");
    return;
  }

  const actualUserId = submission.user_id;
  const reward = parseFloat(submission.task_reward) || 0;
  const user = await db.getUser(actualUserId);
  const newBalance = parseFloat(user.balance) + reward;
  
  await db.updateUser(actualUserId, { balance: newBalance });
  await db.updateSubmissionStatus(submission.id, 'approved', adminId);
  await db.markTaskCompleted(actualUserId, submission.task_id, reward);

  try {
    await bot.sendMessage(actualUserId, `✅ Your task has been approved!\nReward: ${reward} ${CURRENCY_SYMBOL}\nNew balance: ${newBalance} ${CURRENCY_SYMBOL}`);
  } catch (e) {}

  const userIdentifier = await getUserIdentifier(actualUserId);
  const approvalText = `✅ Task approved for ${userIdentifier}. Reward: ${reward} ${CURRENCY_SYMBOL}`;
  
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: messageId
    });
    
    if (messageType === 'photo') {
      await bot.editMessageCaption(approvalText, {
        chat_id: chatId,
        message_id: messageId
      });
    } else {
      await bot.editMessageText(approvalText, {
        chat_id: chatId,
        message_id: messageId
      });
    }
  } catch (e) {
    console.error('Error editing message:', e.message);
  }
}

async function handleAdminTaskReject(adminId, targetId, submissionId, chatId, messageId, messageType) {
  if (!isAdminId(adminId)) {
    await sendEphemeralWarning(chatId, "⛔ You are not authorized!");
    return;
  }

  const submission = await db.getSubmissionById(submissionId);
  
  if (!submission || submission.status !== 'pending') {
    await sendAutoDeleteMessage(chatId, "❌ Submission not found or already processed.");
    return;
  }

  const actualUserId = submission.user_id;
  
  await db.updateSubmissionStatus(submission.id, 'rejected', adminId);

  try {
    await bot.sendMessage(actualUserId, `❌ Your task submission was rejected. Please try again with better proof.`);
  } catch (e) {}

  const userIdentifier = await getUserIdentifier(actualUserId);
  const rejectionText = `❌ Task rejected for ${userIdentifier}.`;
  
  try {
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: chatId,
      message_id: messageId
    });
    
    if (messageType === 'photo') {
      await bot.editMessageCaption(rejectionText, {
        chat_id: chatId,
        message_id: messageId
      });
    } else {
      await bot.editMessageText(rejectionText, {
        chat_id: chatId,
        message_id: messageId
      });
    }
  } catch (e) {
    console.error('Error editing message:', e.message);
  }
}

async function handleAdminWithdrawConfirm(adminId, targetId, amount, chatId) {
  if (!isAdminId(adminId)) {
    await sendEphemeralWarning(chatId, "⛔ You are not authorized!");
    return;
  }

  const withdrawal = await db.getLatestPendingWithdrawal(targetId);
  
  if (!withdrawal) {
    await sendAutoDeleteMessage(chatId, "❌ No pending withdrawal found.");
    return;
  }

  await db.updateWithdrawalStatus(withdrawal.id, 'approved', adminId);

  try {
    await bot.sendMessage(targetId, `✅ Your withdrawal request has been approved!\nAmount: ${amount} ${CURRENCY_SYMBOL}`);
  } catch (e) {}

  const adminIdentifier = await getUserIdentifier(adminId);
  const userIdentifier = await getUserIdentifier(targetId);
  
  await sendAutoDeleteMessage(chatId, `✅ Withdrawal approved for ${userIdentifier}. Amount: ${amount} ${CURRENCY_SYMBOL}`);
  await logAdmin(`Withdrawal approved by ${adminIdentifier} for ${userIdentifier} - Amount: ${amount}`);
}

async function handleAdminWithdrawReject(adminId, targetId, chatId) {
  if (!isAdminId(adminId)) {
    await sendEphemeralWarning(chatId, "⛔ You are not authorized!");
    return;
  }

  const withdrawal = await db.getLatestPendingWithdrawal(targetId);
  
  if (!withdrawal) {
    await sendAutoDeleteMessage(chatId, "❌ No pending withdrawal found.");
    return;
  }

  await db.updateWithdrawalStatus(withdrawal.id, 'rejected', adminId);

  try {
    await bot.sendMessage(targetId, `❌ Your withdrawal request was rejected.`);
  } catch (e) {}

  const adminIdentifier = await getUserIdentifier(adminId);
  const userIdentifier = await getUserIdentifier(targetId);
  
  await sendAutoDeleteMessage(chatId, `❌ Withdrawal rejected for ${userIdentifier}.`);
  await logAdmin(`Withdrawal rejected by ${adminIdentifier} for ${userIdentifier}`);
}

/* ---------- requestwithdraw and admin commands ---------- */
bot.onText(/\/requestwithdraw\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const amountStr = match[1];
  const amount = parseFloat(amountStr);

  if (isNaN(amount) || amount <= 0) {
    await bot.sendMessage(chatId, "❌ Invalid amount.");
    return;
  }

  const withdrawalOpen = (await db.getSetting('withdrawalOpen')) === 'true';
  
  if (!withdrawalOpen) {
    await bot.sendMessage(chatId, "❌ Withdrawals are currently closed.");
    return;
  }

  const minWithdrawal = parseFloat(await db.getSetting('minWithdrawal')) || 50;
  const maxWithdrawal = parseFloat(await db.getSetting('maxWithdrawal')) || 10000;

  if (amount < minWithdrawal || amount > maxWithdrawal) {
    await bot.sendMessage(chatId, `❌ Amount must be between ${minWithdrawal} and ${maxWithdrawal} ${CURRENCY_SYMBOL}`);
    return;
  }

  const user = await db.getUser(userId);
  
  if (parseFloat(user.balance) < amount) {
    await bot.sendMessage(chatId, `❌ Insufficient balance. Your balance: ${user.balance} ${CURRENCY_SYMBOL}`);
    return;
  }

  if (!user.wallet) {
    await bot.sendMessage(chatId, "❌ Please set your wallet address first using 💳 Set Wallet");
    return;
  }

  await db.createWithdrawalRequest(userId, amount, user.wallet);

  const userIdentifier = await getUserIdentifier(userId);
  const msg_text = `💸 New Withdrawal Request\nUser: ${userIdentifier}\nAmount: ${amount} ${CURRENCY_SYMBOL}\nWallet: ${user.wallet}`;
  
  const inlineKeyboard = {
    inline_keyboard: [[
      { text: "✅ Approve", callback_data: `withdraw_confirm:${userId}:${amount}` },
      { text: "❌ Reject", callback_data: `withdraw_reject:${userId}` }
    ]]
  };

  await bot.sendMessage(WITHDRAW_REVIEW_CHANNEL, msg_text, { reply_markup: inlineKeyboard });
  await bot.sendMessage(chatId, `✅ Withdrawal request submitted for review.\nAmount: ${amount} ${CURRENCY_SYMBOL}`);

  const newBalance = parseFloat(user.balance) - amount;
  await db.updateUser(userId, { balance: newBalance });
});

// ✅ Global system health function
async function analyzeSystemHealth() {
  try {
    const cpuLoad = await si.currentLoad();
    const mem = await si.mem();
    const netStats = await si.networkStats();

    const cpu = cpuLoad.currentLoad.toFixed(1);
    const ramUsed = (mem.active / 1024 / 1024 / 1024).toFixed(2);
    const ramTotal = (mem.total / 1024 / 1024 / 1024).toFixed(2);
    const netIn = (netStats[0].rx_sec / 1024).toFixed(1);
    const netOut = (netStats[0].tx_sec / 1024).toFixed(1);
    const uptime = (process.uptime() / 60).toFixed(1);

    const heart = cpu < 50 ? "💚" : cpu < 80 ? "💛" : "❤️‍🔥";

    return `
⚙️ *System Health Report* ${heart}

🧠 *CPU Load:* ${cpu}%
💾 *Memory:* ${ramUsed}GB / ${ramTotal}GB
🌐 *Network:* ${netIn}KB/s ⬇️ | ${netOut}KB/s ⬆️
⏱️ *Uptime:* ${uptime} minutes
🚦 *Status:* ${heart} ${cpu < 80 ? "Stable" : "High Load"}
    `;
  } catch (err) {
    console.error("System health check failed:", err);
    return "❌ Failed to analyze system health.";
  }
}


bot.onText(/\/health/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id; // ✅ This is your actual Telegram ID

  // ✅ Proper admin check using your ADMIN_IDS array
  if (!isAdminId(userId)) {
    return bot.sendMessage(chatId, "🚫 Access denied. Admins only.");
  }

  try {
    const healthReport = await analyzeSystemHealth();
    await bot.sendMessage(chatId, healthReport, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Health command error:", err);
    await bot.sendMessage(chatId, "❌ Failed to fetch system health.");
  }
});


bot.onText(/\/addtask (.+) \| (.+) \| (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const title = match[1].trim();
  const description = match[2].trim();
  const reward = parseFloat(match[3]);

  if (!title || !description || isNaN(reward)) {
    await bot.sendMessage(chatId, "❌ Usage: /addtask Title | Description | Reward");
    return;
  }

  const task = await db.createTask(title, description, reward, userId);
  await bot.sendMessage(chatId, `✅ Task created:\n${title}\nReward: ${reward} ${CURRENCY_SYMBOL}`);
  await logAdmin(`New task created: ${title} - Reward: ${reward}`);
});

bot.onText(/\/deletetask\s+(\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const taskId = Number(match[1]);
  await db.deleteTask(taskId);
  await bot.sendMessage(chatId, `✅ Task ${taskId} deleted.`);
  await logAdmin(`Task ${taskId} deleted`);
});

bot.onText(/\/listtasks/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const tasks = await db.getTasks('active');
  
  if (tasks.length === 0) {
    await bot.sendMessage(chatId, "No active tasks.");
    return;
  }

  let text = "📋 Active Tasks:\n\n";
  tasks.forEach(task => {
    text += `ID: ${task.id}\nTitle: ${task.title}\nDescription: ${task.description}\nReward: ${task.reward} ${CURRENCY_SYMBOL}\n\n`;
  });
  
  await bot.sendMessage(chatId, text);
});

bot.onText(/\/setconfig\s+(\w+)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const key = match[1];
  const value = match[2];

  await db.setSetting(key, value);
  await bot.sendMessage(chatId, `✅ Config updated: ${key} = ${value}`);
  await logAdmin(`Config updated: ${key} = ${value}`);
});

bot.onText(/\/getconfig\s+(\w+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const key = match[1];
  const value = await db.getSetting(key);
  
  await bot.sendMessage(chatId, `⚙️ ${key} = ${value || '(not set)'}`);
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const message = match[1];
  const users = await db.getAllUsers();
  
  let successCount = 0;
  let failCount = 0;

  for (const user of users) {
    try {
      await bot.sendMessage(user.id, message);
      successCount++;
    } catch (e) {
      failCount++;
    }
  }

  await bot.sendMessage(chatId, `📢 Broadcast complete:\n✅ Sent: ${successCount}\n❌ Failed: ${failCount}`);
  await logAdmin(`Broadcast sent to ${successCount} users`);
});

bot.onText(/\/userinfo\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const input = match[1].trim();
  const targetId = await resolveUserInput(input);

  if (!targetId) {
    await bot.sendMessage(chatId, "❌ User not found.");
    return;
  }

  const user = await db.getUser(targetId);
  if (!user) {
    await bot.sendMessage(chatId, "❌ User not found.");
    return;
  }

  const refCount = await db.getReferralCount(targetId);
  const completedTasks = await db.getUserCompletedTasks(targetId);
  const refAnalysis = await db.analyzeReferralPattern(targetId);
  const withdrawalStats = await db.getUserWithdrawalStats(targetId);
  const referralDetails = await db.getDetailedReferralAnalysis(targetId);
  const referrerInfo = await db.getReferrerInfo(targetId);
  const botDetection = await db.detectBotOrFakeUser(targetId);

  const referralReward = parseFloat(await db.getSetting('referralReward')) || 20;
  const totalReferralEarnings = refAnalysis.realRefs * referralReward;

  let info = `👤 <b>User Information</b>\n\n`;

  // ━━━━━ BASIC INFO ━━━━━
  info += `<b>━━━━━ Basic Info ━━━━━</b>\n`;
  info += `├ ID: <code>${user.id}</code>\n`;
  info += `├ Username: ${user.username ? '@' + user.username : '(none)'}\n`;
  if (referrerInfo) {
    info += `├ Invited By: ${referrerInfo.username ? '@' + referrerInfo.username : referrerInfo.id}\n`;
  }
  if (user.country_code) {
    const flag = getCountryFlag(user.country_code);
    info += `├ Country: ${flag} ${user.country_code}\n`;
  }
  if (user.language_code) {
    info += `├ Language: ${user.language_code}\n`;
  }

  const balance = parseFloat(user.balance) || 0;
  info += `├ Balance: <b>${balance.toFixed(2)} ${CURRENCY_SYMBOL}</b>\n`;
  info += `├ Wallet: <code>${user.wallet || '(not set)'}</code>\n`;
  info += `├ Verified: ${user.verified ? '✅ Yes' : '❌ No'}\n`;
  info += `└ Registered: ${
    user.registered_at ? new Date(user.registered_at).toLocaleString() : 'N/A'
  }\n\n`;

  // ━━━━━ ACTIVITY STATS ━━━━━
  info += `<b>━━━━━ Activity Stats ━━━━━</b>\n`;
  info += `├ Messages Sent: ${user.message_count || 0}\n`;
  info += `├ Group Messages: ${user.group_message_count || 0}\n`;
  info += `├ Bot Messages: ${user.bot_message_count || 0}\n`;
  info += `├ Commands Used: ${user.command_count || 0}\n`;
  info += `├ Button Clicks: ${user.button_click_count || 0}\n`;

  const activityScore = parseFloat(user.activity_score);
  info += `├ Activity Score: ${
    !isNaN(activityScore) ? activityScore.toFixed(2) : '0.00'
  }\n`;
  info += `├ Completed Tasks: ${completedTasks?.length || 0}\n`;
  info += `├ Current Streak: ${user.current_streak || 0} days 🔥\n`;
  info += `├ Longest Streak: ${user.longest_streak || 0} days 🏆\n`;
  info += `├ Engagement Tier: ${user.engagement_tier || 'Regular'}\n`;

  let lastSeenStr = 'N/A';
  if (user.last_seen) {
    const timeSinceLastSeen = Date.now() - user.last_seen;
    const hoursSinceLastSeen = timeSinceLastSeen / (1000 * 60 * 60);
    lastSeenStr =
      hoursSinceLastSeen < 1
        ? `${Math.floor(hoursSinceLastSeen * 60)}m ago`
        : hoursSinceLastSeen < 24
        ? `${Math.floor(hoursSinceLastSeen)}h ago`
        : `${Math.floor(hoursSinceLastSeen / 24)}d ago`;
  }
  info += `└ Last Seen: ${lastSeenStr}\n\n`;
  
  // ━━━━━ BOT/FAKE DETECTION ━━━━━
  info += `<b>━━━━━ Detection Analysis ━━━━━</b>\n`;
  info += `├ Classification: ${botDetection.classification}\n`;
  info += `├ Bot Score: ${botDetection.botScore}/100\n`;
  info += `├ Fake Score: ${botDetection.fakeScore}/100\n`;
  info += `├ Confidence: ${botDetection.confidence}%\n`;
  info += `├ Spam Score: ${user.spam_score || 0}\n`;
  info += `├ Is Throttled: ${user.is_throttled ? 'Yes ⚠️' : 'No ✅'}\n`;
  if (botDetection.reasons.length > 0) {
    info += `└ Flags: ${botDetection.reasons.slice(0, 3).join(', ')}\n`;
  }
  info += `\n`;

  // ━━━━━ WITHDRAWAL STATS ━━━━━
  info += `<b>━━━━━ Withdrawal Stats ━━━━━</b>\n`;
  const totalWithdrawn = parseFloat(withdrawalStats.totalWithdrawn) || 0;
  info += `├ Total Withdrawn: <b>${totalWithdrawn.toFixed(2)} ${CURRENCY_SYMBOL}</b>\n`;
  info += `├ Approved: ${withdrawalStats.approvedCount || 0}\n`;
  info += `├ Pending: ${withdrawalStats.pendingCount || 0}\n`;
  info += `└ Rejected: ${withdrawalStats.rejectedCount || 0}\n\n`;

  // ━━━━━ REFERRAL ANALYSIS ━━━━━
  info += `<b>━━━━━ Referral Analysis ━━━━━</b>\n`;
  info += `├ Total Referrals: ${refCount || 0}\n`;
  info += `├ Real Users: ${refAnalysis?.realRefs || 0} ✅\n`;
  info += `├ Suspicious: ${refAnalysis?.suspiciousRefs || 0} ⚠️\n`;
  info += `├ Quality Score: ${parseFloat(refAnalysis?.score) || 0}\n`;
  info += `├ Quality: ${parseFloat(refAnalysis?.percentage) || 0}%\n`;
  info += `└ Referral Earnings: <b>${parseFloat(totalReferralEarnings) || 0} ${CURRENCY_SYMBOL}</b>\n\n`;

  // ━━━━━ MINI REFERRAL OVERVIEW ━━━━━
  if (referralDetails.length > 0) {
    info += `<b>━━━━━ 👥 Top Referrals ━━━━━</b>\n`;

    // Sort by score descending and show top 3
    const topRefs = referralDetails
      .sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0))
      .slice(0, 3);

    topRefs.forEach((ref, i) => {
      const stars = '⭐'.repeat(Math.min(5, Math.round(ref.totalScore / 2)));
      info += `${i + 1}. ${ref.username ? '@' + ref.username : ref.userId} — ${stars} (${ref.totalScore || 0}/13)\n`;
    });

    // Classification summary
    const realCount = referralDetails.filter(r => r.classification === 'Real User').length;
    const suspiciousCount = referralDetails.filter(r => r.classification === 'Suspicious').length;
    const botCount = referralDetails.filter(r => r.classification === 'Likely Bot').length;
    const fakeCount = referralDetails.filter(r => r.classification === 'Fake').length;

    info += `\n<b>━━━━━ 📊 Classification Summary ━━━━━</b>\n`;
    info += `✅ Real: ${realCount} | ⚠️ Suspicious: ${suspiciousCount} | 🤖 Bots: ${botCount} | 🚫 Fake: ${fakeCount}\n\n`;
  } else {
    info += `<i>No referrals yet.</i>\n\n`;
  }

  // ━━━━━ FINAL USER RATING ━━━━━
  const taskPoints = Math.min(completedTasks.length * 0.5, 5);
  const referralPoints = Math.min(refCount * 0.3, 3);
  const verifiedPoints = user.verified ? 1.5 : 0;
  const activityPoints = Math.min(activityScore / 2, 5);
  const base = 1;
  const totalScore = base + taskPoints + referralPoints + verifiedPoints + activityPoints;
  const maxScore = 10;

  const starRating = Math.round((totalScore / maxScore) * 5);
  const starIcons = '⭐'.repeat(starRating) + '☆'.repeat(5 - starRating);

  let ratingLabel = '🟢 Excellent';
  if (starRating <= 2) ratingLabel = '🔴 Low';
  else if (starRating === 3) ratingLabel = '🟡 Average';

  info += `<b>━━━━━ ⭐ Overall Rating ━━━━━</b>\n`;
  info += `User Score: <b>${totalScore.toFixed(1)}/${maxScore}</b>\n`;
  info += `Rating: ${starIcons} ${ratingLabel}\n`;

  await bot.sendMessage(chatId, info, { parse_mode: 'HTML' });
});

// =============== Admin Command Wrappers with Auto-Delete ===============

// Blacklist with reason
bot.onText(/\/blacklist\s+(@?\w+|\d+)(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) return;
  
  const input = match[1].trim();
  const reason = match[2] ? match[2].trim() : "No reason provided";
  const targetId = await resolveUserInput(input);
  
  let actionMsg = `⛔️ /blacklist by admin: ${adminId} on user ${input} (${targetId})`;
  
  if (!targetId) {
    await sendAndAutoDelete(chatId, "❌ User not found.", 30000);
    await broadcastAdminAction(actionMsg + "\nResult: User not found.");
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  if (isAdminId(targetId)) {
    await sendAndAutoDelete(chatId, "❌ You cannot blacklist another admin.", 30000);
    await broadcastAdminAction(actionMsg + "\nResult: Cannot blacklist admin.");
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  await db.blacklistUser(targetId, reason, adminId);
  await sendAndAutoDelete(chatId, `🚫 User ${input} (${targetId}) has been blacklisted.\nReason: ${reason}`, 30000);
  await broadcastAdminAction(actionMsg + `\nReason: ${reason}\nResult: User blacklisted.`);
  
  // Delete admin command after 30 sec
  deleteMessageLater(chatId, msg.message_id, 30000);
  
  // Delete the blacklisted user's most recent message in this chat
  try {
    if (global.userLatestMessage && global.userLatestMessage[chatId] && global.userLatestMessage[chatId][targetId]) {
      const userMsgId = global.userLatestMessage[chatId][targetId];
      deleteMessageLater(chatId, userMsgId, 30000);
    }
  } catch (e) {}
});

// Unblacklist
bot.onText(/\/unblacklist\s+(@?\w+|\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) return;
  
  const input = match[1].trim();
  const targetId = await resolveUserInput(input);
  
  if (!targetId) {
    await sendAndAutoDelete(chatId, "❌ User not found.", 30000);
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  await db.unblacklistUser(targetId);
  await sendAndAutoDelete(chatId, `✅ User ${input} (${targetId}) has been removed from blacklist.`, 30000);
  await broadcastAdminAction(`✅ /unblacklist by admin ${adminId}: User ${input} (${targetId}) removed from blacklist.`);
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// List blacklisted users
bot.onText(/\/listblacklist/, async (msg) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) return;
  
  const blacklisted = await db.getAllBlacklistedUsers();
  
  if (blacklisted.length === 0) {
    await sendAndAutoDelete(chatId, "📋 No blacklisted users.", 30000);
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  let text = "📋 Blacklisted Users:\n\n";
  for (const entry of blacklisted) {
    const userIdentifier = await getUserIdentifier(entry.user_id);
    text += `User: ${userIdentifier}\nReason: ${entry.reason}\nBlacklisted at: ${new Date(entry.blacklisted_at).toLocaleString()}\n\n`;
  }
  
  await sendAndAutoDelete(chatId, text, 60000);
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// Addbalance
bot.onText(/\/addbalance\s+(@?\w+|\d+)\s+(\d+)(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) return;
  
  const input = match[1].trim();
  const amount = parseFloat(match[2]);
  const reason = match[3] ? match[3].trim() : "No reason provided";
  const targetId = await resolveUserInput(input);
  
  if (!targetId) {
    await sendAndAutoDelete(chatId, "❌ User not found.", 30000);
    await broadcastAdminAction(`❌ /addbalance failed by admin ${adminId}\nTarget: ${input}\nReason: User not found`);
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  const user = await db.getUser(targetId);
  const userIdentifier = await getUserIdentifier(targetId);
  const oldBalance = parseFloat(user.balance) || 0;
  const newBalance = oldBalance + amount;
  await db.updateUser(targetId, { balance: newBalance });
  
  await sendAndAutoDelete(chatId, `✅ Added ${amount} ${CURRENCY_SYMBOL} to ${userIdentifier}\nOld balance: ${oldBalance} ${CURRENCY_SYMBOL}\nNew balance: ${newBalance} ${CURRENCY_SYMBOL}\nReason: ${reason}`, 30000);
  await broadcastAdminAction(`💰 Balance Added\n\nAdmin: ${adminId}\nUser: ${userIdentifier}\nAmount: +${amount} ${CURRENCY_SYMBOL}\nOld Balance: ${oldBalance} ${CURRENCY_SYMBOL}\nNew Balance: ${newBalance} ${CURRENCY_SYMBOL}\nReason: ${reason}`);
  deleteMessageLater(chatId, msg.message_id, 30000);
  
  // Delete user's last message if exists
  try {
    if (global.userLatestMessage && global.userLatestMessage[chatId] && global.userLatestMessage[chatId][targetId]) {
      const userMsgId = global.userLatestMessage[chatId][targetId];
      deleteMessageLater(chatId, userMsgId, 30000);
    }
  } catch (e) {}
});

// Removebalance
bot.onText(/\/removebalance\s+(@?\w+|\d+)\s+(\d+)(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) return;
  
  const input = match[1].trim();
  const amount = parseFloat(match[2]);
  const reason = match[3] ? match[3].trim() : "No reason provided";
  const targetId = await resolveUserInput(input);
  
  if (!targetId) {
    await sendAndAutoDelete(chatId, "❌ User not found.", 30000);
    await broadcastAdminAction(`❌ /removebalance failed by admin ${adminId}\nTarget: ${input}\nReason: User not found`);
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  const user = await db.getUser(targetId);
  const userIdentifier = await getUserIdentifier(targetId);
  const oldBalance = parseFloat(user.balance) || 0;
  const removeAmt = Math.min(amount, oldBalance);
  const newBalance = oldBalance - removeAmt;
  await db.updateUser(targetId, { balance: newBalance });
  
  await sendAndAutoDelete(chatId, `✅ Removed ${removeAmt} ${CURRENCY_SYMBOL} from ${userIdentifier}\nOld balance: ${oldBalance} ${CURRENCY_SYMBOL}\nNew balance: ${newBalance} ${CURRENCY_SYMBOL}\nReason: ${reason}`, 30000);
  await broadcastAdminAction(`💸 Balance Deducted\n\nAdmin: ${adminId}\nUser: ${userIdentifier}\nAmount: -${removeAmt} ${CURRENCY_SYMBOL}\nOld Balance: ${oldBalance} ${CURRENCY_SYMBOL}\nNew Balance: ${newBalance} ${CURRENCY_SYMBOL}\nReason: ${reason}`);
  deleteMessageLater(chatId, msg.message_id, 30000);
  
  // Delete user's last message if exists
  try {
    if (global.userLatestMessage && global.userLatestMessage[chatId] && global.userLatestMessage[chatId][targetId]) {
      const userMsgId = global.userLatestMessage[chatId][targetId];
      deleteMessageLater(chatId, userMsgId, 30000);
    }
  } catch (e) {}
});

// Open withdrawal
bot.onText(/\/openwithdrawal/, async (msg) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) return;
  
  await db.setSetting('withdrawalOpen', 'true');
  await sendAndAutoDelete(chatId, '✅ Withdrawals are now OPEN.', 30000);
  await broadcastAdminAction(`🔓 Withdrawals Opened\n\nAdmin: ${adminId}\nStatus: OPEN`);
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// Close withdrawal
bot.onText(/\/closewithdrawal/, async (msg) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) return;
  
  await db.setSetting('withdrawalOpen', 'false');
  await sendAndAutoDelete(chatId, '✅ Withdrawals are now CLOSED.', 30000);
  await broadcastAdminAction(`🔒 Withdrawals Closed\n\nAdmin: ${adminId}\nStatus: CLOSED`);
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// Set min and max withdrawal
bot.onText(/\/setminandmaxwithdrawal\s+(\d+)\s+(\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) return;
  
  const minW = parseFloat(match[1]);
  const maxW = parseFloat(match[2]);
  
  await db.setSetting('minWithdrawal', minW);
  await db.setSetting('maxWithdrawal', maxW);
  
  await sendAndAutoDelete(chatId, `✅ Withdrawal limits updated\nMin: ${minW} ${CURRENCY_SYMBOL}\nMax: ${maxW} ${CURRENCY_SYMBOL}`, 30000);
  await broadcastAdminAction(`⚙️ Withdrawal Limits Updated\n\nAdmin: ${adminId}\nMin Withdrawal: ${minW} ${CURRENCY_SYMBOL}\nMax Withdrawal: ${maxW} ${CURRENCY_SYMBOL}`);
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// Set referral reward
bot.onText(/\/setreferralreward\s+(\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) return;
  
  const amt = parseFloat(match[1]);
  
  await db.setSetting('referralReward', amt);
  
  await sendAndAutoDelete(chatId, `✅ Referral reward updated: ${amt} ${CURRENCY_SYMBOL}`, 30000);
  await broadcastAdminAction(`👥 Referral Reward Updated\n\nAdmin: ${adminId}\nNew Reward: ${amt} ${CURRENCY_SYMBOL}`);
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// Set daily bonus reward
bot.onText(/\/setdailybonusreward\s+(\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) return;
  
  const amt = parseFloat(match[1]);
  
  await db.setSetting('bonusAmount', amt);
  
  await sendAndAutoDelete(chatId, `✅ Daily bonus reward updated: ${amt} ${CURRENCY_SYMBOL}`, 30000);
  await broadcastAdminAction(`🎁 Daily Bonus Updated\n\nAdmin: ${adminId}\nNew Bonus: ${amt} ${CURRENCY_SYMBOL}`);
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// ================= Log last message id per user per chat ================
bot.on('message', (msg) => {
  if (!msg.from || msg.from.is_bot) return;
  global.userLatestMessage[msg.chat.id] = global.userLatestMessage[msg.chat.id] || {};
  global.userLatestMessage[msg.chat.id][msg.from.id] = msg.message_id;
});

/* ==================== NEW ADMIN COMMANDS ==================== */

// /activitylog - View user activity history
bot.onText(/\/activitylog\s+(@?\w+|\d+)(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }
  
  const input = match[1].trim();
  const limit = match[2] ? parseInt(match[2]) : 20;
  const targetId = await resolveUserInput(input);
  
  if (!targetId) {
    await sendAndAutoDelete(chatId, "❌ User not found.", 30000);
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  const logs = await db.getUserActivityLogs(targetId, { limit });
  const userIdentifier = await getUserIdentifier(targetId);
  
  if (logs.length === 0) {
    await sendAndAutoDelete(chatId, `📋 No activity logs found for ${userIdentifier}`, 30000);
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  let text = `📋 <b>Activity Log for ${userIdentifier}</b>\n\n`;
  logs.forEach((log, i) => {
    const date = new Date(log.timestamp).toLocaleString();
    text += `${i + 1}. ${log.activity_type} - ${date}\n`;
    if (log.chat_type) text += `   Chat: ${log.chat_type}\n`;
  });
  
  await sendAndAutoDelete(chatId, text, 60000, { parse_mode: 'HTML' });
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// /tiers - Show engagement distribution
bot.onText(/\/tiers/, async (msg) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }
  
  const distribution = await db.getTierDistribution();
  
  let text = `🏆 <b>Engagement Tier Distribution</b>\n\n`;
  const tierEmojis = {
    'Elite': '👑',
    'Active': '⭐',
    'Regular': '✅',
    'Dormant': '😴',
    'Ghost': '👻'
  };
  
  distribution.forEach(tier => {
    const emoji = tierEmojis[tier.engagement_tier] || '📊';
    text += `${emoji} ${tier.engagement_tier}: ${tier.count} users\n`;
  });
  
  await sendAndAutoDelete(chatId, text, 60000, { parse_mode: 'HTML' });
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// /updatetier - Recalculate user tier
bot.onText(/\/updatetier\s+(@?\w+|\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }
  
  const input = match[1].trim();
  const targetId = await resolveUserInput(input);
  
  if (!targetId) {
    await sendAndAutoDelete(chatId, "❌ User not found.", 30000);
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  const result = await db.updateEngagementTier(targetId);
  const userIdentifier = await getUserIdentifier(targetId);
  
  await sendAndAutoDelete(chatId, `✅ Tier updated for ${userIdentifier}\nNew Tier: ${result.tier}\nScore: ${result.tierScore.toFixed(2)}`, 30000);
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// /streak - View streak info
bot.onText(/\/streak\s+(@?\w+|\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }
  
  const input = match[1].trim();
  const targetId = await resolveUserInput(input);
  
  if (!targetId) {
    await sendAndAutoDelete(chatId, "❌ User not found.", 30000);
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  const user = await db.getUser(targetId);
  const userIdentifier = await getUserIdentifier(targetId);
  
  let text = `🔥 <b>Streak Info for ${userIdentifier}</b>\n\n`;
  text += `Current Streak: ${user.current_streak || 0} days\n`;
  text += `Longest Streak: ${user.longest_streak || 0} days\n`;
  text += `Last Activity: ${user.last_activity_date || 'Never'}\n`;
  
  await sendAndAutoDelete(chatId, text, 30000, { parse_mode: 'HTML' });
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// /spamcheck - Check spam status
bot.onText(/\/spamcheck\s+(@?\w+|\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }
  
  const input = match[1].trim();
  const targetId = await resolveUserInput(input);
  
  if (!targetId) {
    await sendAndAutoDelete(chatId, "❌ User not found.", 30000);
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  const spamCheck = await db.checkSpamBehavior(targetId);
  const user = await db.getUser(targetId);
  const userIdentifier = await getUserIdentifier(targetId);
  
  let text = `🚨 <b>Spam Check for ${userIdentifier}</b>\n\n`;
  text += `Is Spamming: ${spamCheck.isSpamming ? '⚠️ Yes' : '✅ No'}\n`;
  text += `Spam Score: ${spamCheck.spamScore.toFixed(2)}\n`;
  text += `Messages (1 min): ${spamCheck.messagesLastMinute}\n`;
  text += `Messages (5 min): ${spamCheck.messagesLastFiveMin}\n`;
  text += `Is Throttled: ${user.is_throttled ? '⚠️ Yes' : '✅ No'}\n`;
  
  if (user.throttled_until) {
    const timeLeft = user.throttled_until - Date.now();
    if (timeLeft > 0) {
      const minutesLeft = Math.floor(timeLeft / 60000);
      text += `Throttled Until: ${minutesLeft} minutes\n`;
    }
  }
  
  await sendAndAutoDelete(chatId, text, 30000, { parse_mode: 'HTML' });
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// /unthrottle - Remove throttle
bot.onText(/\/unthrottle\s+(@?\w+|\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }
  
  const input = match[1].trim();
  const targetId = await resolveUserInput(input);
  
  if (!targetId) {
    await sendAndAutoDelete(chatId, "❌ User not found.", 30000);
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  await db.updateUser(targetId, {
    is_throttled: false,
    throttled_until: null,
    spam_score: 0
  });
  
  const userIdentifier = await getUserIdentifier(targetId);
  await sendAndAutoDelete(chatId, `✅ Throttle removed for ${userIdentifier}`, 30000);
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// /detectbot - Run bot detection
bot.onText(/\/detectbot\s+(@?\w+|\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }
  
  const input = match[1].trim();
  const targetId = await resolveUserInput(input);
  
  if (!targetId) {
    await sendAndAutoDelete(chatId, "❌ User not found.", 30000);
    deleteMessageLater(chatId, msg.message_id, 30000);
    return;
  }
  
  const detection = await db.detectBotOrFakeUser(targetId);
  const userIdentifier = await getUserIdentifier(targetId);
  
  let text = `🤖 <b>Bot Detection for ${userIdentifier}</b>\n\n`;
  text += `Classification: ${detection.classification}\n`;
  text += `Is Bot: ${detection.isBot ? '⚠️ Yes' : '✅ No'}\n`;
  text += `Is Fake: ${detection.isFake ? '🚫 Yes' : '✅ No'}\n`;
  text += `Bot Score: ${detection.botScore}/100\n`;
  text += `Fake Score: ${detection.fakeScore}/100\n`;
  text += `Confidence: ${detection.confidence}%\n\n`;
  text += `<b>Reasons:</b>\n`;
  detection.reasons.forEach((reason, i) => {
    text += `${i + 1}. ${reason}\n`;
  });
  
  await sendAndAutoDelete(chatId, text, 60000, { parse_mode: 'HTML' });
  deleteMessageLater(chatId, msg.message_id, 30000);
});

// /maintenance - Run all maintenance tasks
bot.onText(/\/maintenance/, async (msg) => {
  const chatId = msg.chat.id;
  const adminId = msg.from.id;
  
  if (!isAdminId(adminId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }
  
  await sendAndAutoDelete(chatId, '🔄 Running maintenance tasks...', 5000);
  
  try {
    const result = await db.runMaintenanceTasks();
    
    let text = `✅ <b>Maintenance Complete</b>\n\n`;
    text += `Idle Decay: ${result.idleDecay.decayedCount} users\n`;
    text += `Referral Decay: ${result.referralDecay.processedCount} users\n`;
    text += `Tiers Updated: ${result.tiersUpdated} users\n`;
    
    await sendAndAutoDelete(chatId, text, 60000, { parse_mode: 'HTML' });
  } catch (error) {
    await sendAndAutoDelete(chatId, `❌ Maintenance failed: ${error.message}`, 30000);
  }
  
  deleteMessageLater(chatId, msg.message_id, 30000);
});

/* ==================== GROUP MEMBER TRACKING ==================== */

// Track new members joining
bot.on('new_chat_members', async (msg) => {
  const chatId = msg.chat.id;
  
  // Only track in admin group
  if (chatId !== ADMIN_GROUP_ID) return;
  
  for (const member of msg.new_chat_members) {
    if (member.is_bot) continue;
    
    const userId = member.id;
    const username = member.username || '';
    const languageCode = member.language_code || null;
    
    try {
      await db.ensureUser(userId, username, false, {}, null, languageCode);
      await db.logActivity(userId, 'joined_group', { chatId, username }, chatId, 'group');
      
      // Auto-flag if no username
      if (!username) {
        await db.flagUserAsFake(userId, 'No username - joined group');
      }
    } catch (error) {
      console.error('Error tracking new member:', error);
    }
  }
});

// Track members leaving
bot.on('left_chat_member', async (msg) => {
  const chatId = msg.chat.id;
  
  // Only track in admin group
  if (chatId !== ADMIN_GROUP_ID) return;
  
  const member = msg.left_chat_member;
  if (member.is_bot) return;
  
  const userId = member.id;
  const languageCode = member.language_code || null;
  
  try {
    // Ensure user exists before logging
    await db.ensureUser(userId, member.username || '', false, {}, null, languageCode);
    await db.logActivity(userId, 'left_group', { chatId }, chatId, 'group');
    
    // Auto-flag as fake for joining and leaving
    await db.flagUserAsFake(userId, 'Joined and left group');
  } catch (error) {
    console.error('Error tracking member leaving:', error);
  }
});

/* Final: Keep console log so you know the bot started */
console.log("Bot webhook server is running and handlers are registered.");
console.log("✅ Activity tracking enabled");
console.log("✅ Auto-maintenance scheduled (every 6 hours)");
console.log("✅ Auto-tracking updates scheduled (every 10 minutes)");
console.log("✅ Group member tracking enabled");
