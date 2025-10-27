require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;

app.get('/', (req, res) => {
  res.send("I'm alive! Bot is running.");
});

app.listen(PORT, () => {
  console.log(`Keep-alive server is running on port ${PORT}`);
});

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Error: BOT_TOKEN is not set in environment variables');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : [7561048693, 6450400107, 5470178483, 5713536787, 6221435595, 5713536787, -1003140359659];
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

async function initializeBot() {
  try {
    await db.initializeDatabase();
    console.log('✅ Bot initialized successfully');
  } catch (error) {
    console.error('❌ Bot initialization failed:', error);
    process.exit(1);
  }
}

initializeBot();

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
  if (input.startsWith('@')) {
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

async function analyzeReferralPattern(userId) {
  const referralIds = await db.getUserReferrals(userId);
  
  if (!referralIds || referralIds.length === 0) {
    return { realRefs: 0, suspiciousRefs: 0, percentage: 100, score: "🌟🌟🌟🌟🌟" };
  }

  let suspiciousCount = 0;
  const referralTimes = [];

  for (const refId of referralIds) {
    const refUser = await db.getUser(refId);
    if (!refUser) continue;

    let suspiciousScore = 0;
    
    const accountAge = (Date.now() - refUser.registered_at) / (1000 * 60 * 60);
    const accountAgeDays = accountAge / 24;
    
    if (accountAgeDays > 2 && refUser.message_count < 3) suspiciousScore += 2;
    if (accountAgeDays > 1 && refUser.activity_score < 0.2) suspiciousScore += 1;
    if (accountAgeDays > 3 && !refUser.verified) suspiciousScore += 2;
    if (accountAgeDays > 7 && refUser.message_count === 0) suspiciousScore += 2;

    referralTimes.push(refUser.registered_at);
    
    if (suspiciousScore >= 4) {
      suspiciousCount++;
    }
  }

  referralTimes.sort((a, b) => a - b);
  let rapidSignups = 0;
  for (let i = 1; i < referralTimes.length; i++) {
    const timeDiff = (referralTimes[i] - referralTimes[i - 1]) / 1000;
    if (timeDiff < 30) {
      rapidSignups++;
    }
  }
  
  if (rapidSignups > 5) {
    suspiciousCount += Math.floor(rapidSignups / 3);
  }

  const realRefs = Math.max(0, referralIds.length - suspiciousCount);
  const percentage = referralIds.length > 0 ? (realRefs / referralIds.length) * 100 : 100;
  const score = getStarRating(percentage);

  return {
    realRefs: realRefs,
    suspiciousRefs: suspiciousCount,
    percentage: percentage,
    score: score
  };
}

async function analyzeSystemHealth() {
  const allUsers = await db.getAllUsers();
  const totalUsers = allUsers.length;
  
  if (totalUsers === 0) {
    return { realUsers: 0, suspiciousUsers: 0, percentage: 100, score: "🌟🌟🌟🌟🌟" };
  }

  let suspiciousUsers = 0;

  for (const user of allUsers) {
    let suspiciousScore = 0;

    const accountAge = (Date.now() - user.registered_at) / (1000 * 60 * 60);
    const accountAgeDays = accountAge / 24;
    
    if (accountAgeDays > 2 && user.message_count < 2) suspiciousScore += 2;
    if (accountAgeDays > 1 && user.activity_score < 0.1) suspiciousScore += 1;
    if (accountAgeDays > 3 && !user.verified) suspiciousScore += 2;
    if (accountAgeDays > 7 && user.message_count === 0) suspiciousScore += 2;

    if (suspiciousScore >= 4) {
      suspiciousUsers++;
    }
  }

  const realUsers = totalUsers - suspiciousUsers;
  const percentage = totalUsers > 0 ? (realUsers / totalUsers) * 100 : 100;
  const score = getStarRating(percentage);

  return {
    realUsers: realUsers,
    suspiciousUsers: suspiciousUsers,
    percentage: percentage,
    score: score
  };
}

async function logAdmin(text) {
  try {
    await bot.sendMessage(BROADCAST_CHANNEL, text);
  } catch (e) {
    console.error('Error logging to admin:', e.message);
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

function getStarRating(percentage) {
  if (percentage >= 100) return "🌟🌟🌟🌟🌟";
  if (percentage >= 70) return "🌟🌟🌟🌟";
  if (percentage >= 40) return "🌟🌟🌟";
  if (percentage >= 25) return "🌟🌟";
  if (percentage >= 10) return "🌟";
  if (percentage >= 8) return "❌";
  return "❌❌❌❌❌";
}

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || "";
  const startParam = match[1];

  await db.ensureUser(userId, username);

  if (startParam && startParam !== String(userId)) {
    const user = await db.getUser(userId);
    if (!user.referred_by) {
      await db.updateUser(userId, { referred_by: startParam });
    }
  }

  const welcomeVideo = 'CgACAgQAAxkBAAEDB0Ro_-WjtBmGV0HMXxDJaJ0zT2BeygACuR4AAgrS-FN2hA87R-M-DjYE'; // your file_id
  const welcomeText = `Hey there, ${msg.from.first_name || ''}\n` +
    `Welcome to the Justice on Solana community — where we’re redefining what fairness means in the world of crypto and Web3.\n\n` +
    `This isn’t just another blockchain project.\n` +
    `It’s a movement — a mission to bring accountability, protection, and transparency to the decentralized world through smart contracts, on-chain arbitration, and community-driven governance.\n\n` +
    `Here’s what you can expect as a member:\n\n` +
    `• Stay updated on project milestones and token drops.\n` +
    `• Participate in discussions on blockchain law and DeFi protection.\n` +
    `• Connect with innovators, builders, and justice advocates.\n` +
    `• Be part of the first decentralized legal ecosystem on Solana.\n\n` +
    `Your voice matters here.\n` +
    `Together, we’re building a fairer, safer, and more transparent Web3.\n\n` +
    `Welcome to the future of justice — on-chain and unstoppable.\n⚖️\n#JusticeOnSolana #Solana #Web3 #CryptoLaw`;

  const keyboard = {
    keyboard: [["➡️ Continue"]],
    resize_keyboard: true,
    one_time_keyboard: true
  };

  try {
    await bot.sendVideo(chatId, welcomeVideo, {
      caption: welcomeText,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } catch (error) {
    console.error('Error sending video:', error);
    await bot.sendMessage(chatId, welcomeText, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }
});



bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || "";
  const text = msg.text;

  if (!text && !msg.photo) return;

  await db.ensureUser(userId, username, true);

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
    await handleTask(chatId, userId);
    return;
  }
  if (text === "🎁 Bonus") {
    await handleBonus(chatId, userId);
    return;
  }
  if (text === "💼 Trade") {
    await bot.sendMessage(chatId, "💼 Trade feature coming soon!");
    return;
  }
  if (text === "💳 Set Wallet") {
    await handleSetWallet(chatId, userId);
    return;
  }
  if (text === "👥 Referral") {
    await handleReferral(chatId, userId);
    return;
  }
  if (text === "💰 Balance") {
    await handleBalance(chatId, userId);
    return;
  }
  if (text === "💸 Withdrawal") {
    await handleWithdrawalMenu(chatId, userId);
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

  if (awaitingWallet[userId]) {
    const addr = text.trim();
    await db.updateUser(userId, { wallet: addr });
    delete awaitingWallet[userId];
    await bot.sendMessage(chatId, `✅ Wallet saved: ${addr}`);
    return;
  }

  if (pendingTasks[userId]) {
    if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      pendingTasks[userId].files.push(photo.file_id);
      const imageCount = pendingTasks[userId].files.length;
      await bot.sendMessage(chatId, `✅ Image ${imageCount} received. Send more images or press Done when finished.`, {
        reply_markup: {
          inline_keyboard: [[{ text: "Done", callback_data: "finish_task_submit" }]]
        }
      });
      return;
    }
    if (text && text !== "Done") {
      pendingTasks[userId].text += "\n" + text;
      await bot.sendMessage(chatId, "✅ Description saved. Send more or press Done.");
      return;
    }
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

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
        
        await db.updateUser(user.referred_by, { 
          balance: parseFloat(referrer.balance) + referralReward 
        });
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
    const originalContent = query.message.photo ? query.message.caption : query.message.text;
    await handleAdminTaskConfirm(userId, targetId, submissionId, query.message.chat.id, query.message.message_id, messageType, originalContent);
    await bot.answerCallbackQuery(query.id, { text: "Task approved." });
    return;
  }

  if (data.startsWith("task_reject:")) {
    const parts = data.split(":");
    const targetId = parts[1];
    const submissionId = parts[2];
    const messageType = query.message.photo ? 'photo' : 'text';
    const originalContent = query.message.photo ? query.message.caption : query.message.text;
    await handleAdminTaskReject(userId, targetId, submissionId, query.message.chat.id, query.message.message_id, messageType, originalContent);
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

async function showMenu(chatId) {
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
  
  const systemHealth = await analyzeSystemHealth();
  const totalBalance = await db.getTotalBalance();
  
  const statsText = `📊 System Statistics\n\n` +
    `Total Users: ${totalUsers}\n` +
    `Real Users: ${systemHealth.realUsers}\n` +
    `Suspicious Users: ${systemHealth.suspiciousUsers}\n` +
    `Users Online: ${onlineUsers}\n` +
    `Users Offline: ${offlineUsers}\n` +
    `Total Balance: ${totalBalance} ${CURRENCY_SYMBOL}\n\n` +
    `Progress Score: ${systemHealth.score}`;
  
  await bot.sendMessage(chatId, statsText);
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
  const caption = `📝 New Task Submission\nUser: ${userIdentifier}\nTask: ${pending.taskTitle || 'Unknown'}\nReward: ${pending.taskReward || 0} ${CURRENCY_SYMBOL}\n\nDescription:\n${pending.text || "(no description)"}\n\nImages: ${pending.files.length}`;
  
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
  const refAnalysis = await analyzeReferralPattern(targetId);

  const info = `👤 User Info\n\n` +
    `ID: ${user.id}\n` +
    `Username: ${user.username || '(none)'}\n` +
    `Balance: ${user.balance} ${CURRENCY_SYMBOL}\n` +
    `Wallet: ${user.wallet || '(not set)'}\n` +
    `Verified: ${user.verified ? 'Yes' : 'No'}\n` +
    `Referrals: ${refCount}\n` +
    `Real Refs: ${refAnalysis.realRefs}\n` +
    `Suspicious Refs: ${refAnalysis.suspiciousRefs}\n` +
    `Ref Quality: ${refAnalysis.score}\n` +
    `Completed Tasks: ${completedTasks.length}\n` +
    `Messages: ${user.message_count}\n` +
    `Activity Score: ${user.activity_score?.toFixed(2) || 0}\n` +
    `Registered: ${new Date(user.registered_at).toLocaleString()}`;

  await bot.sendMessage(chatId, info);
});

bot.onText(/\/addbalance\s+(.+)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const input = match[1].trim();
  const amountToAdd = parseFloat(match[2]);

  if (isNaN(amountToAdd)) {
    await bot.sendMessage(chatId, "❌ Invalid amount.");
    return;
  }

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

  const newBalance = parseFloat(user.balance) + amountToAdd;
  await db.updateUser(targetId, { balance: newBalance });

  const userIdentifier = await getUserIdentifier(targetId);
  await bot.sendMessage(chatId, `✅ Added ${amountToAdd} ${CURRENCY_SYMBOL} to ${userIdentifier}. New balance: ${newBalance}`);
  
  try {
    await bot.sendMessage(targetId, `💰 Admin added ${amountToAdd} ${CURRENCY_SYMBOL} to your balance!\nNew balance: ${newBalance} ${CURRENCY_SYMBOL}`);
  } catch (e) {}

  await logAdmin(`Admin added ${amountToAdd} to ${userIdentifier}`);
});

bot.onText(/\/removebalance\s+(.+)\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const input = match[1].trim();
  const amountToRemove = parseFloat(match[2]);

  if (isNaN(amountToRemove)) {
    await bot.sendMessage(chatId, "❌ Invalid amount.");
    return;
  }

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

  const newBalance = Math.max(0, parseFloat(user.balance) - amountToRemove);
  await db.updateUser(targetId, { balance: newBalance });

  const userIdentifier = await getUserIdentifier(targetId);
  await bot.sendMessage(chatId, `✅ Removed ${amountToRemove} ${CURRENCY_SYMBOL} from ${userIdentifier}. New balance: ${newBalance}`);
  
  try {
    await bot.sendMessage(targetId, `⚠️ Admin removed ${amountToRemove} ${CURRENCY_SYMBOL} from your balance.\nNew balance: ${newBalance} ${CURRENCY_SYMBOL}`);
  } catch (e) {}

  await logAdmin(`Admin removed ${amountToRemove} from ${userIdentifier}`);
});

bot.onText(/\/approveall/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const submissions = await db.approveAllPendingSubmissions(userId);
  
  for (const submission of submissions) {
    const reward = parseFloat(submission.task_reward) || 0;
    const user = await db.getUser(submission.user_id);
    const newBalance = parseFloat(user.balance) + reward;
    
    await db.updateUser(submission.user_id, { balance: newBalance });
    await db.markTaskCompleted(submission.user_id, submission.task_id, reward);

    try {
      await bot.sendMessage(submission.user_id, `✅ Your task has been approved!\nReward: ${reward} ${CURRENCY_SYMBOL}\nNew balance: ${newBalance} ${CURRENCY_SYMBOL}`);
    } catch (e) {}
  }

  await bot.sendMessage(chatId, `✅ Approved ${submissions.length} submissions.`);
  await logAdmin(`Approved all ${submissions.length} pending submissions`);
});

bot.onText(/\/rejectall/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const submissions = await db.rejectAllPendingSubmissions(userId);
  
  for (const submission of submissions) {
    try {
      await bot.sendMessage(submission.user_id, `❌ Your task submission was rejected. Please try again with better proof.`);
    } catch (e) {}
  }

  await bot.sendMessage(chatId, `❌ Rejected ${submissions.length} submissions.`);
  await logAdmin(`Rejected all ${submissions.length} pending submissions`);
});

bot.onText(/\/pendingsubmissions/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const submissions = await db.getPendingSubmissions();
  
  if (submissions.length === 0) {
    await bot.sendMessage(chatId, "No pending submissions.");
    return;
  }

  let text = `📋 Pending Submissions (${submissions.length}):\n\n`;
  
  for (const sub of submissions) {
    const userIdentifier = await getUserIdentifier(sub.user_id);
    text += `ID: ${sub.id}\nUser: ${userIdentifier}\nTask: ${sub.task_title}\nReward: ${sub.task_reward} ${CURRENCY_SYMBOL}\n\n`;
  }
  
  await bot.sendMessage(chatId, text);
});

bot.onText(/\/openwithdrawal/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  await db.setSetting('withdrawalOpen', 'true');
  await bot.sendMessage(chatId, "✅ Withdrawals are now OPEN.");
  await logAdmin('Withdrawals opened by admin');
});

bot.onText(/\/closewithdrawal/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  await db.setSetting('withdrawalOpen', 'false');
  await bot.sendMessage(chatId, "❌ Withdrawals are now CLOSED.");
  await logAdmin('Withdrawals closed by admin');
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await handleStats(chatId);
    return;
  }

  const allUsers = await db.getAllUsers();
  const totalUsers = allUsers.length;
  const verifiedUsers = allUsers.filter(u => u.verified).length;
  const now = Date.now();
  const onlineUsers = allUsers.filter(u => (now - u.last_seen) < 300000).length;
  const offlineUsers = totalUsers - onlineUsers;
  
  const systemHealth = await analyzeSystemHealth();
  const totalBalance = await db.getTotalBalance();
  
  const tasksSubmitted = await db.getSetting('tasksSubmitted') || 0;
  const tasksApproved = await db.getSetting('tasksApproved') || 0;
  const tasksRejected = await db.getSetting('tasksRejected') || 0;
  
  const statsText = `📊 Admin Statistics\n\n` +
    `👥 Users:\n` +
    `Total Users: ${totalUsers}\n` +
    `Verified: ${verifiedUsers}\n` +
    `Real Users: ${systemHealth.realUsers}\n` +
    `Suspicious: ${systemHealth.suspiciousUsers}\n` +
    `Online: ${onlineUsers}\n` +
    `Offline: ${offlineUsers}\n\n` +
    `💰 Balance:\n` +
    `Total Balance: ${totalBalance} ${CURRENCY_SYMBOL}\n\n` +
    `📝 Tasks:\n` +
    `Submitted: ${tasksSubmitted}\n` +
    `Approved: ${tasksApproved}\n` +
    `Rejected: ${tasksRejected}\n\n` +
    `Quality Score: ${systemHealth.score}`;
  
  await bot.sendMessage(chatId, statsText);
});

bot.onText(/\/referral\s+(.+)/, async (msg, match) => {
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

  const refAnalysis = await analyzeReferralPattern(targetId);
  const refCount = await db.getReferralCount(targetId);
  const userIdentifier = await getUserIdentifier(targetId);

  const refText = `👥 Referral Analysis for ${userIdentifier}\n\n` +
    `Total Referrals: ${refCount}\n` +
    `Real Refs: ${refAnalysis.realRefs}\n` +
    `Suspicious Refs: ${refAnalysis.suspiciousRefs}\n\n` +
    `Score: ${refAnalysis.score}`;

  await bot.sendMessage(chatId, refText);
});

bot.onText(/\/leaderboard/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const allUsers = await db.getAllUsers();
  
  const sortedByBalance = allUsers
    .sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance))
    .slice(0, 10);

  let leaderboardText = `🏆 Top 10 Users by Balance\n\n`;
  
  for (let i = 0; i < sortedByBalance.length; i++) {
    const user = sortedByBalance[i];
    const userIdentifier = await getUserIdentifier(user.id);
    leaderboardText += `${i + 1}. ${userIdentifier}\n   Balance: ${user.balance} ${CURRENCY_SYMBOL}\n\n`;
  }

  await bot.sendMessage(chatId, leaderboardText);
});

bot.onText(/\/aboutus/, async (msg) => {
  const chatId = msg.chat.id;

  // Ensure proper link formatting
  const aboutLink = ABOUT_US_URL.startsWith("http")
    ? ABOUT_US_URL
    : `https://t.me/${ABOUT_US_URL.replace(/^@/, '')}`;

  const aboutText = `ℹ️ About JUSTICE on Sol\n\n` +
    `${BOT_NAME} is a community-driven ecosystem that helps fight fraud and unfairness in the crypto space.\n\n` +
    `Tap below to learn more 👇`;

  await bot.sendMessage(chatId, aboutText, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🌐 About Us", url: aboutLink }]
      ]
    }
  });
});


bot.onText(/\/support/, async (msg) => {
  const chatId = msg.chat.id;

  const supportLink = SUPPORT_URL.startsWith("http")
    ? SUPPORT_URL
    : `https://t.me/${SUPPORT_URL.replace(/^@/, '')}`;

  await bot.sendMessage(chatId, "💬 Need help? Tap below to contact support 👇", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💬 Contact Support", url: supportLink }]
      ]
    }
  });
});


bot.onText(/\/bonus\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const newBonus = parseFloat(match[1]);

  if (isNaN(newBonus) || newBonus < 0) {
    await bot.sendMessage(chatId, "❌ Invalid bonus amount.");
    return;
  }

  await db.setSetting('bonusAmount', newBonus.toString());
  await bot.sendMessage(chatId, `✅ Daily bonus amount updated to ${newBonus} ${CURRENCY_SYMBOL}`);
  await logAdmin(`Bonus amount updated to ${newBonus}`);
});

bot.onText(/\/referralreward\s+(.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!isAdminId(userId)) {
    await sendEphemeralWarning(chatId, "⛔ Admin only!");
    return;
  }

  const newReward = parseFloat(match[1]);

  if (isNaN(newReward) || newReward < 0) {
    await bot.sendMessage(chatId, "❌ Invalid reward amount.");
    return;
  }

  await db.setSetting('referralReward', newReward.toString());
  await bot.sendMessage(chatId, `✅ Referral reward updated to ${newReward} ${CURRENCY_SYMBOL}`);
  await logAdmin(`Referral reward updated to ${newReward}`);
});

const recentReplies = new Map();

bot.on('message', async (msg) => {
  // Skip bot messages
  if (!msg.from || msg.from.is_bot) return;

  const chatId = msg.chat.id;
  const userMsgId = msg.message_id;

  // Track replies the bot sends for this message
  bot.once('sent_reply', (botMsg) => {
    if (botMsg.chat.id === chatId) {
      if (!recentReplies.has(userMsgId)) recentReplies.set(userMsgId, []);
      recentReplies.get(userMsgId).push(botMsg.message_id);
    }
  });

  // Wait 30 seconds, then delete both user + bot reply
  setTimeout(async () => {
    try {
      // Delete user's message
      await bot.deleteMessage(chatId, userMsgId);
    } catch (e) {}

    // Delete any bot messages we recorded for this user message
    const botMsgs = recentReplies.get(userMsgId) || [];
    for (const botMsgId of botMsgs) {
      try {
        await bot.deleteMessage(chatId, botMsgId);
      } catch (e) {}
    }
    recentReplies.delete(userMsgId);
  }, 30000);
});

// Monkey-patch sendMessage to emit an event we can track
const originalSendMessage = bot.sendMessage.bind(bot);
bot.sendMessage = async (...args) => {
  const msg = await originalSendMessage(...args);
  bot.emit('sent_reply', msg);
  return msg;
};

console.log('Bot is running...');