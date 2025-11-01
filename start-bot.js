// start-bot.js
const path = require('path');

// Resolve the path to your bot's entry point relative to this file
const botPath = path.resolve(__dirname, 'project-justice', 'index.js');

console.log(`[Launcher] Starting bot from: ${botPath}`);

// Start the bot
require(botPath);
