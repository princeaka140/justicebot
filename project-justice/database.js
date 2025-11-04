const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

/**
 * initializeDatabase()
 * - Creates schema for users, referrals, tasks, submissions, completed tasks,
 *   bot settings, withdrawals and blacklist.
 * - Adds useful indexes and seeds default settings.
 */
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        username TEXT,
        balance NUMERIC(20,2) DEFAULT 0,
        wallet TEXT,
        referred_by BIGINT,
        verified BOOLEAN DEFAULT FALSE,
        registered_at BIGINT NOT NULL,
        last_seen BIGINT NOT NULL,
        message_count INTEGER DEFAULT 0,
        activity_score DECIMAL(10,4) DEFAULT 0,
        last_bonus_claim BIGINT DEFAULT 0,
        
        -- Streak tracking
        current_streak INTEGER DEFAULT 0,
        longest_streak INTEGER DEFAULT 0,
        last_activity_date DATE,
        
        -- Engagement tier
        engagement_tier TEXT DEFAULT 'Regular',
        tier_updated_at BIGINT,
        
        -- Spam detection
        spam_score DECIMAL(10,4) DEFAULT 0,
        last_spam_check BIGINT DEFAULT 0,
        is_throttled BOOLEAN DEFAULT FALSE,
        throttled_until BIGINT,
        
        -- Activity metrics
        group_message_count INTEGER DEFAULT 0,
        bot_message_count INTEGER DEFAULT 0,
        command_count INTEGER DEFAULT 0,
        button_click_count INTEGER DEFAULT 0,
        last_decay_applied BIGINT DEFAULT 0,
        
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS referrals (
        referrer_id BIGINT NOT NULL,
        referred_id BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (referrer_id, referred_id),
        FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (referred_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        reward NUMERIC(20,2) NOT NULL,
        created_at BIGINT NOT NULL,
        created_by BIGINT,
        status TEXT DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS task_submissions (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        task_id INTEGER NOT NULL,
        task_title TEXT,
        task_reward NUMERIC(20,2),
        description TEXT,
        files JSONB DEFAULT '[]',
        status TEXT DEFAULT 'pending',
        submitted_at BIGINT NOT NULL,
        reviewed_at BIGINT,
        reviewed_by BIGINT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS completed_tasks (
        user_id BIGINT NOT NULL,
        task_id INTEGER NOT NULL,
        completed_at BIGINT NOT NULL,
        reward NUMERIC(20,2),
        PRIMARY KEY (user_id, task_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS bot_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS withdrawal_requests (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        amount NUMERIC(20,2) NOT NULL,
        wallet TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        requested_at BIGINT NOT NULL,
        reviewed_at BIGINT,
        reviewed_by BIGINT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS blacklist (
        user_id BIGINT PRIMARY KEY,
        reason TEXT,
        blacklisted_by BIGINT NOT NULL,
        blacklisted_at BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS user_activity_log (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        activity_type TEXT NOT NULL,
        activity_data JSONB DEFAULT '{}',
        chat_id BIGINT,
        chat_type TEXT,
        timestamp BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_verified ON users(verified);
      CREATE INDEX IF NOT EXISTS idx_users_engagement_tier ON users(engagement_tier);
      CREATE INDEX IF NOT EXISTS idx_users_last_activity_date ON users(last_activity_date);
      CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
      CREATE INDEX IF NOT EXISTS idx_task_submissions_user ON task_submissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_task_submissions_status ON task_submissions(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);
      CREATE INDEX IF NOT EXISTS idx_blacklist_user ON blacklist(user_id);
      CREATE INDEX IF NOT EXISTS idx_activity_log_user ON user_activity_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_activity_log_timestamp ON user_activity_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_activity_log_type ON user_activity_log(activity_type);
    `);

    await client.query(`
      INSERT INTO bot_settings (key, value) VALUES
        ('referralReward', '20'),
        ('bonusAmount', '3'),
        ('withdrawalOpen', 'false'),
        ('tasksSubmitted', '0'),
        ('tasksApproved', '0'),
        ('tasksRejected', '0'),
        ('minWithdrawal', '50'),
        ('maxWithdrawal', '10000')
      ON CONFLICT (key) DO NOTHING;
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
    throw error;
  } finally {
    client.release();
  }
}

/* ----------------------- Basic user functions ----------------------- */
async function getUser(userId) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return result.rows[0] || null;
}

async function createUser(userId, username = '') {
  const now = Date.now();
  const today = new Date().toISOString().split('T')[0];
  const result = await pool.query(
    `INSERT INTO users (
      id, username, balance, wallet, verified, registered_at, last_seen, 
      message_count, activity_score, last_bonus_claim, current_streak, 
      longest_streak, last_activity_date, engagement_tier, spam_score,
      group_message_count, bot_message_count, command_count, button_click_count
    )
     VALUES ($1, $2, 0, '', FALSE, $3, $3, 0, 0, 0, 0, 0, $4, 'Regular', 0, 0, 0, 0, 0)
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       last_seen = EXCLUDED.last_seen
     RETURNING *`,
    [userId, username, now, today]
  );
  return result.rows[0];
}

async function updateUser(userId, updates) {
  const fields = [];
  const values = [];
  let paramCount = 1;

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = $${paramCount}`);
    values.push(value);
    paramCount++;
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(userId);

  const result = await pool.query(
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramCount} RETURNING *`,
    values
  );
  return result.rows[0];
}

async function ensureUser(userId, username = null, updateActivity = false, activityContext = {}) {
  let user = await getUser(userId);

  if (!user) {
    user = await createUser(userId, username);
  } else {
    const updates = { last_seen: Date.now() };
    if (username && username !== user.username) {
      updates.username = username;
    }

    if (updateActivity) {
      // Update streak
      const today = new Date().toISOString().split('T')[0];
      const lastActivityDate = user.last_activity_date;
      
      if (lastActivityDate) {
        const lastDate = new Date(lastActivityDate);
        const todayDate = new Date(today);
        const daysDiff = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));
        
        if (daysDiff === 1) {
          // Consecutive day
          updates.current_streak = (user.current_streak || 0) + 1;
          updates.longest_streak = Math.max(updates.current_streak, user.longest_streak || 0);
        } else if (daysDiff > 1) {
          // Streak broken
          updates.current_streak = 1;
        }
        // Same day, no change to streak
      } else {
        updates.current_streak = 1;
        updates.longest_streak = 1;
      }
      
      updates.last_activity_date = today;
      
      // Update message counts based on context
      const isGroup = activityContext.chatType === 'group' || activityContext.chatType === 'supergroup';
      if (isGroup) {
        updates.group_message_count = (user.group_message_count || 0) + 1;
      } else {
        updates.bot_message_count = (user.bot_message_count || 0) + 1;
      }
      
      updates.message_count = (user.message_count || 0) + 1;
      
      // Update activity score
      const hoursSinceRegistration = (Date.now() - user.registered_at) / (1000 * 60 * 60);
      if (hoursSinceRegistration > 0) {
        updates.activity_score = updates.message_count / Math.max(hoursSinceRegistration, 0.01);
      }
    }

    user = await updateUser(userId, updates);
  }

  return user;
}

/* ----------------------- Referral helpers ----------------------- */
async function addReferral(referrerId, referredId) {
  try {
    await pool.query(
      'INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [referrerId, referredId]
    );
  } catch (error) {
    console.error('Error adding referral:', error);
  }
}

async function getUserReferrals(userId) {
  const result = await pool.query('SELECT referred_id FROM referrals WHERE referrer_id = $1', [userId]);
  return result.rows.map(row => row.referred_id);
}

async function getReferralCount(userId) {
  const result = await pool.query('SELECT COUNT(*) as count FROM referrals WHERE referrer_id = $1', [userId]);
  return parseInt(result.rows[0].count);
}

/* ----------------------- Task management ----------------------- */
async function createTask(title, description, reward, createdBy = null) {
  const result = await pool.query(
    `INSERT INTO tasks (title, description, reward, created_at, created_by, status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING *`,
    [title, description, reward, Date.now(), createdBy]
  );
  return result.rows[0];
}

async function getTasks(status = 'active') {
  const result = await pool.query('SELECT * FROM tasks WHERE status = $1 ORDER BY created_at DESC', [status]);
  return result.rows;
}

async function getTaskById(taskId) {
  const result = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
  return result.rows[0] || null;
}

async function deleteTask(taskId) {
  await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
}

/* ----------------------- Completed tasks ----------------------- */
async function getUserCompletedTasks(userId) {
  const result = await pool.query('SELECT task_id FROM completed_tasks WHERE user_id = $1', [userId]);
  return result.rows.map(row => row.task_id);
}

async function markTaskCompleted(clientOrUserId, taskId, reward) {
  // Accept either client (transaction) or direct call
  if (typeof clientOrUserId === 'object' && clientOrUserId.query) {
    const client = clientOrUserId;
    await client.query(
      `INSERT INTO completed_tasks (user_id, task_id, completed_at, reward)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, task_id) DO NOTHING`,
      [clientOrUserId._userId, taskId, Date.now(), reward]
    );
    return;
  }

  const userId = clientOrUserId;
  await pool.query(
    `INSERT INTO completed_tasks (user_id, task_id, completed_at, reward)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, task_id) DO NOTHING`,
    [userId, taskId, Date.now(), reward]
  );
}

/* ----------------------- Submissions & atomic approvals ----------------------- */
async function createTaskSubmission(userId, taskId, taskTitle, taskReward, description, files) {
  const result = await pool.query(
    `INSERT INTO task_submissions (user_id, task_id, task_title, task_reward, description, files, status, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
     RETURNING *`,
    [userId, taskId, taskTitle, taskReward, description, JSON.stringify(files), Date.now()]
  );

  await incrementSetting('tasksSubmitted');
  return result.rows[0];
}

async function getSubmissionById(submissionId) {
  const result = await pool.query('SELECT * FROM task_submissions WHERE id = $1', [submissionId]);
  return result.rows[0] || null;
}

async function getLatestPendingSubmission(userId) {
  const result = await pool.query(
    `SELECT * FROM task_submissions 
     WHERE user_id = $1 AND status = 'pending'
     ORDER BY submitted_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

// Small helper to run transactional approval (updates submission, user balance, completed_tasks and counters)
async function approveSubmissionAtomic(submissionId, reviewedBy) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const subRes = await client.query('SELECT * FROM task_submissions WHERE id = $1 FOR UPDATE', [submissionId]);
    const submission = subRes.rows[0];
    if (!submission) throw new Error('Submission not found');
    if (submission.status !== 'pending') throw new Error('Submission not pending');

    // Lock user row
    const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [submission.user_id]);
    const user = userRes.rows[0];
    if (!user) throw new Error('User not found');

    // Update submission status
    await client.query(
      `UPDATE task_submissions SET status = 'approved', reviewed_at = $1, reviewed_by = $2 WHERE id = $3`,
      [Date.now(), reviewedBy, submissionId]
    );

    // Credit user balance
    const newBalance = (parseFloat(user.balance) || 0) + parseFloat(submission.task_reward || 0);
    await client.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, user.id]);

    // Insert into completed_tasks
    await client.query(
      `INSERT INTO completed_tasks (user_id, task_id, completed_at, reward)
       VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, task_id) DO NOTHING`,
      [user.id, submission.task_id, Date.now(), submission.task_reward]
    );

    // Increment counters
    const tasksApproved = await getSetting('tasksApproved');
    await client.query(
      `INSERT INTO bot_settings (key, value, updated_at) VALUES ('tasksApproved', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [String((parseInt(tasksApproved) || 0) + 1)]
    );

    await client.query('COMMIT');

    return { success: true, userId: user.id, newBalance };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function rejectSubmissionAtomic(submissionId, reviewedBy) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const subRes = await client.query('SELECT * FROM task_submissions WHERE id = $1 FOR UPDATE', [submissionId]);
    const submission = subRes.rows[0];
    if (!submission) throw new Error('Submission not found');
    if (submission.status !== 'pending') throw new Error('Submission not pending');

    await client.query(
      `UPDATE task_submissions SET status = 'rejected', reviewed_at = $1, reviewed_by = $2 WHERE id = $3`,
      [Date.now(), reviewedBy, submissionId]
    );

    // Increment tasksRejected
    const tasksRejected = await getSetting('tasksRejected');
    await client.query(
      `INSERT INTO bot_settings (key, value, updated_at) VALUES ('tasksRejected', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [String((parseInt(tasksRejected) || 0) + 1)]
    );

    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* ----------------------- Bulk approve/reject helpers ----------------------- */
async function approveAllPendingSubmissions(reviewedBy) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pending = await client.query("SELECT * FROM task_submissions WHERE status = 'pending' FOR UPDATE");
    const rows = pending.rows;
    let approvedCount = 0;

    for (const submission of rows) {
      // lock user
      const userRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [submission.user_id]);
      const user = userRes.rows[0];
      if (!user) continue;

      // update submission
      await client.query(
        `UPDATE task_submissions SET status = 'approved', reviewed_at = $1, reviewed_by = $2 WHERE id = $3`,
        [Date.now(), reviewedBy, submission.id]
      );

      // credit balance
      const newBalance = (parseFloat(user.balance) || 0) + parseFloat(submission.task_reward || 0);
      await client.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, user.id]);

      // mark completed
      await client.query(
        `INSERT INTO completed_tasks (user_id, task_id, completed_at, reward)
         VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, task_id) DO NOTHING`,
        [user.id, submission.task_id, Date.now(), submission.task_reward]
      );

      approvedCount++;
    }

    // increment tasksApproved by approvedCount
    const tasksApproved = await getSetting('tasksApproved');
    await client.query(
      `INSERT INTO bot_settings (key, value, updated_at) VALUES ('tasksApproved', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [String((parseInt(tasksApproved) || 0) + approvedCount)]
    );

    await client.query('COMMIT');
    return { approvedCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function rejectAllPendingSubmissions(reviewedBy) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const pending = await client.query("SELECT * FROM task_submissions WHERE status = 'pending' FOR UPDATE");
    const rows = pending.rows;
    let rejectedCount = 0;

    for (const submission of rows) {
      await client.query(
        `UPDATE task_submissions SET status = 'rejected', reviewed_at = $1, reviewed_by = $2 WHERE id = $3`,
        [Date.now(), reviewedBy, submission.id]
      );
      rejectedCount++;
    }

    const tasksRejected = await getSetting('tasksRejected');
    await client.query(
      `INSERT INTO bot_settings (key, value, updated_at) VALUES ('tasksRejected', $1, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = CURRENT_TIMESTAMP`,
      [String((parseInt(tasksRejected) || 0) + rejectedCount)]
    );

    await client.query('COMMIT');
    return { rejectedCount };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* ----------------------- Settings ----------------------- */
async function getSetting(key) {
  const result = await pool.query('SELECT value FROM bot_settings WHERE key = $1', [key]);
  return result.rows[0]?.value || null;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO bot_settings (key, value, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
    [key, String(value)]
  );
}

async function incrementSetting(key, increment = 1) {
  const current = await getSetting(key);
  const newValue = (parseInt(current) || 0) + increment;
  await setSetting(key, newValue);
  return newValue;
}

/* ----------------------- Users list & analytics ----------------------- */
async function getAllUsers() {
  const result = await pool.query('SELECT * FROM users ORDER BY registered_at DESC');
  return result.rows;
}

async function getVerifiedUsers() {
  const result = await pool.query('SELECT * FROM users WHERE verified = TRUE');
  return result.rows;
}

async function getTotalBalance() {
  const result = await pool.query('SELECT SUM(balance) as total FROM users');
  return parseFloat(result.rows[0].total) || 0;
}

/* ----------------------- Withdrawals ----------------------- */
async function createWithdrawalRequest(userId, amount, wallet) {
  const result = await pool.query(
    `INSERT INTO withdrawal_requests (user_id, amount, wallet, status, requested_at)
     VALUES ($1, $2, $3, 'pending', $4)
     RETURNING *`,
    [userId, amount, wallet, Date.now()]
  );
  return result.rows[0];
}

async function getLatestPendingWithdrawal(userId) {
  const result = await pool.query(
    `SELECT * FROM withdrawal_requests 
     WHERE user_id = $1 AND status = 'pending'
     ORDER BY requested_at DESC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function updateWithdrawalStatus(withdrawalId, status, reviewedBy = null) {
  const result = await pool.query(
    `UPDATE withdrawal_requests 
     SET status = $1, reviewed_at = $2, reviewed_by = $3
     WHERE id = $4
     RETURNING *`,
    [status, Date.now(), reviewedBy, withdrawalId]
  );
  return result.rows[0];
}

/* ----------------------- Blacklist ----------------------- */
async function blacklistUser(userId, reason, blacklistedBy) {
  const result = await pool.query(
    `INSERT INTO blacklist (user_id, reason, blacklisted_by, blacklisted_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET 
       reason = EXCLUDED.reason,
       blacklisted_by = EXCLUDED.blacklisted_by,
       blacklisted_at = EXCLUDED.blacklisted_at
     RETURNING *`,
    [userId, reason, blacklistedBy, Date.now()]
  );
  return result.rows[0];
}

async function unblacklistUser(userId) {
  await pool.query('DELETE FROM blacklist WHERE user_id = $1', [userId]);
}

async function isUserBlacklisted(userId) {
  const result = await pool.query('SELECT * FROM blacklist WHERE user_id = $1', [userId]);
  return result.rows[0] || null;
}

async function getAllBlacklistedUsers() {
  const result = await pool.query('SELECT * FROM blacklist ORDER BY blacklisted_at DESC');
  return result.rows;
}

/* ----------------------- Referral analysis (fraud detection) ----------------------- */
async function analyzeReferralPattern(userId) {
  const referrals = await getUserReferrals(userId);

  if (referrals.length === 0) {
    return { realRefs: 0, suspiciousRefs: 0, score: '⭐⭐⭐⭐⭐', percentage: 100 };
  }

  let realCount = 0;
  let suspiciousCount = 0;

  for (const refId of referrals) {
    const refUser = await getUser(refId);
    if (!refUser) {
      suspiciousCount++;
      continue;
    }

    const messageCount = refUser.message_count || 0;
    const activityScore = refUser.activity_score || 0;
    const hasWallet = refUser.wallet && refUser.wallet.length > 0;
    const isVerified = refUser.verified;
    const accountAge = Date.now() - refUser.registered_at;
    const hoursSinceRegistration = accountAge / (1000 * 60 * 60);

    let score = 0;
    if (messageCount >= 10) score += 3;
    else if (messageCount >= 5) score += 2;
    else if (messageCount >= 1) score += 1;

    if (activityScore > 0.5) score += 2;
    else if (activityScore > 0.1) score += 1;

    if (hasWallet) score += 2;
    if (isVerified) score += 2;
    if (hoursSinceRegistration > 24) score += 2;
    else if (hoursSinceRegistration > 1) score += 1;

    const completedTasks = await getUserCompletedTasks(refId);
    if (completedTasks.length > 0) score += 2;

    if (score >= 5) realCount++;
    else suspiciousCount++;
  }

  const totalRefs = referrals.length;
  const realPercentage = totalRefs > 0 ? (realCount / totalRefs) * 100 : 0;

  let rating;
  if (realPercentage >= 80) rating = '⭐⭐⭐⭐⭐';
  else if (realPercentage >= 60) rating = '⭐⭐⭐⭐';
  else if (realPercentage >= 40) rating = '⭐⭐⭐';
  else if (realPercentage >= 20) rating = '⭐⭐';
  else rating = '⭐';

  return {
    realRefs: realCount,
    suspiciousRefs: suspiciousCount,
    score: rating,
    percentage: realPercentage.toFixed(1)
  };
}

/**
 * Get detailed analysis of each referral with classification and scoring
 */
async function getDetailedReferralAnalysis(userId) {
  const referrals = await getUserReferrals(userId);
  const details = [];

  for (const refId of referrals) {
    const refUser = await getUser(refId);
    
    if (!refUser) {
      details.push({
        userId: refId,
        username: null,
        balance: 0,
        wallet: null,
        classification: 'Deleted User',
        statusEmoji: '❌',
        scoreStars: '❌',
        totalScore: 0,
        messageCount: 0,
        completedTasks: 0,
        activityScore: 0,
        accountAge: 'Unknown',
        verified: false,
        hasWallet: false,
        referralCount: 0,
        totalWithdrawn: 0,
        pendingWithdrawals: 0,
        lastSeen: 'Never',
        isFake: true
      });
      continue;
    }

    const messageCount = refUser.message_count || 0;
    const activityScore = refUser.activity_score || 0;
    const hasWallet = refUser.wallet && refUser.wallet.length > 0;
    const isVerified = refUser.verified;
    const hasUsername = refUser.username && refUser.username.length > 0;
    const accountAge = Date.now() - refUser.registered_at;
    const hoursSinceRegistration = accountAge / (1000 * 60 * 60);
    const daysSinceRegistration = accountAge / (1000 * 60 * 60 * 24);

    // Get additional user stats
    const completedTasks = await getUserCompletedTasks(refId);
    const referralCount = await getReferralCount(refId);
    const withdrawalStats = await getUserWithdrawalStats(refId);
    
    // Calculate detailed score (max 15 points)
    let score = 0;
    
    // Message activity (0-3 points)
    if (messageCount >= 10) score += 3;
    else if (messageCount >= 5) score += 2;
    else if (messageCount >= 1) score += 1;

    // Activity score (0-2 points)
    if (activityScore > 0.5) score += 2;
    else if (activityScore > 0.1) score += 1;

    // Wallet set (0-2 points)
    if (hasWallet) score += 2;

    // Verified status (0-2 points)
    if (isVerified) score += 2;

    // Account age (0-2 points)
    if (hoursSinceRegistration > 24) score += 2;
    else if (hoursSinceRegistration > 1) score += 1;

    // Completed tasks (0-2 points)
    if (completedTasks.length > 0) score += 2;
    
    // Has username (0-2 points) - NEW
    if (hasUsername) score += 2;

    // Determine classification and emoji with enhanced fake detection
    let classification, statusEmoji, scoreStars;
    
    // ENHANCED fake detection logic - automatically flag users without username
    const isFake = (
      !hasUsername || // Automatically flag if no username
      (messageCount === 0 && 
       completedTasks.length === 0 && 
       !isVerified && 
       !hasWallet && 
       hoursSinceRegistration < 1 &&
       referralCount === 0)
    );
    
    const isLikelyBot = (
      !isFake &&
      messageCount === 0 && 
      completedTasks.length === 0 && 
      hoursSinceRegistration < 24 &&
      !isVerified
    );
    
    if (isFake) {
      classification = 'Fake';
      statusEmoji = '🚫';
      scoreStars = '❌';
    } else if (score >= 10) {
      classification = 'Real User';
      statusEmoji = '✅';
      scoreStars = '⭐⭐⭐⭐⭐';
    } else if (score >= 7) {
      classification = 'Real User';
      statusEmoji = '✅';
      scoreStars = '⭐⭐⭐⭐';
    } else if (score >= 4) {
      classification = 'Suspicious';
      statusEmoji = '⚠️';
      scoreStars = '⭐⭐⭐';
    } else if (isLikelyBot) {
      classification = 'Likely Bot';
      statusEmoji = '🤖';
      scoreStars = '⭐';
    } else {
      classification = 'Suspicious';
      statusEmoji = '⚠️';
      scoreStars = '⭐⭐';
    }

    // Format account age
    let ageString;
    if (daysSinceRegistration >= 1) {
      ageString = `${Math.floor(daysSinceRegistration)}d`;
    } else if (hoursSinceRegistration >= 1) {
      ageString = `${Math.floor(hoursSinceRegistration)}h`;
    } else {
      ageString = `${Math.floor(hoursSinceRegistration * 60)}m`;
    }

    // Format last seen
    const timeSinceLastSeen = Date.now() - refUser.last_seen;
    const hoursSinceLastSeen = timeSinceLastSeen / (1000 * 60 * 60);
    const daysSinceLastSeen = timeSinceLastSeen / (1000 * 60 * 60 * 24);
    
    let lastSeenString;
    if (daysSinceLastSeen >= 1) {
      lastSeenString = `${Math.floor(daysSinceLastSeen)}d ago`;
    } else if (hoursSinceLastSeen >= 1) {
      lastSeenString = `${Math.floor(hoursSinceLastSeen)}h ago`;
    } else {
      lastSeenString = `${Math.floor(hoursSinceLastSeen * 60)}m ago`;
    }

    details.push({
      userId: refId,
      username: refUser.username,
      balance: parseFloat(refUser.balance) || 0,
      wallet: refUser.wallet || null,
      classification,
      statusEmoji,
      scoreStars,
      totalScore: score,
      messageCount,
      completedTasks: completedTasks.length,
      activityScore,
      accountAge: ageString,
      verified: isVerified,
      hasWallet,
      hasUsername,
      referralCount,
      totalWithdrawn: withdrawalStats.totalWithdrawn,
      pendingWithdrawals: withdrawalStats.pendingCount,
      lastSeen: lastSeenString,
      registeredAt: new Date(refUser.registered_at).toLocaleString(),
      isFake
    });
  }

  // Sort by score (highest first)
  details.sort((a, b) => b.totalScore - a.totalScore);

  return details;
}

/**
 * Get withdrawal statistics for a user
 */
async function getUserWithdrawalStats(userId) {
  const result = await pool.query(
    `SELECT 
      COALESCE(SUM(CASE WHEN status = 'approved' THEN amount ELSE 0 END), 0) as total_withdrawn,
      COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
      COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved_count,
      COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected_count
     FROM withdrawal_requests 
     WHERE user_id = $1`,
    [userId]
  );
  
  return {
    totalWithdrawn: parseFloat(result.rows[0].total_withdrawn) || 0,
    pendingCount: parseInt(result.rows[0].pending_count) || 0,
    approvedCount: parseInt(result.rows[0].approved_count) || 0,
    rejectedCount: parseInt(result.rows[0].rejected_count) || 0
  };
}

/* ----------------------- Activity Logging ----------------------- */
/**
 * Log user activity to the activity log table
 */
async function logActivity(userId, activityType, activityData = {}, chatId = null, chatType = null) {
  try {
    await pool.query(
      `INSERT INTO user_activity_log (user_id, activity_type, activity_data, chat_id, chat_type, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, activityType, JSON.stringify(activityData), chatId, chatType, Date.now()]
    );
  } catch (error) {
    console.error('Error logging activity:', error);
  }
}

/**
 * Get user activity logs with optional filters
 */
async function getUserActivityLogs(userId, options = {}) {
  const { limit = 100, activityType = null, startTime = null, endTime = null } = options;
  
  let query = 'SELECT * FROM user_activity_log WHERE user_id = $1';
  const params = [userId];
  let paramCount = 2;
  
  if (activityType) {
    query += ` AND activity_type = $${paramCount}`;
    params.push(activityType);
    paramCount++;
  }
  
  if (startTime) {
    query += ` AND timestamp >= $${paramCount}`;
    params.push(startTime);
    paramCount++;
  }
  
  if (endTime) {
    query += ` AND timestamp <= $${paramCount}`;
    params.push(endTime);
    paramCount++;
  }
  
  query += ` ORDER BY timestamp DESC LIMIT $${paramCount}`;
  params.push(limit);
  
  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get activity statistics for a user
 */
async function getUserActivityStats(userId, timeRange = 24 * 60 * 60 * 1000) {
  const startTime = Date.now() - timeRange;
  
  const result = await pool.query(
    `SELECT 
      activity_type,
      COUNT(*) as count,
      MAX(timestamp) as last_occurrence
     FROM user_activity_log
     WHERE user_id = $1 AND timestamp >= $2
     GROUP BY activity_type`,
    [userId, startTime]
  );
  
  return result.rows;
}

/* ----------------------- Spam Detection ----------------------- */
/**
 * Check if user is spamming based on recent activity
 */
async function checkSpamBehavior(userId) {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  const fiveMinutesAgo = now - 300000;
  
  // Count messages in last minute
  const recentResult = await pool.query(
    `SELECT COUNT(*) as count FROM user_activity_log
     WHERE user_id = $1 AND timestamp >= $2 AND activity_type IN ('message', 'command')`,
    [userId, oneMinuteAgo]
  );
  
  const messagesLastMinute = parseInt(recentResult.rows[0].count);
  
  // Count messages in last 5 minutes
  const fiveMinResult = await pool.query(
    `SELECT COUNT(*) as count FROM user_activity_log
     WHERE user_id = $1 AND timestamp >= $2 AND activity_type IN ('message', 'command')`,
    [userId, fiveMinutesAgo]
  );
  
  const messagesLastFiveMin = parseInt(fiveMinResult.rows[0].count);
  
  // Spam thresholds
  const isSpamming = messagesLastMinute > 10 || messagesLastFiveMin > 30;
  const spamScore = (messagesLastMinute * 2) + (messagesLastFiveMin * 0.5);
  
  if (isSpamming) {
    // Throttle user for 5 minutes
    await updateUser(userId, {
      spam_score: spamScore,
      is_throttled: true,
      throttled_until: now + 300000,
      last_spam_check: now
    });
  } else {
    // Decay spam score
    const user = await getUser(userId);
    const newSpamScore = Math.max(0, (user.spam_score || 0) - 1);
    await updateUser(userId, {
      spam_score: newSpamScore,
      last_spam_check: now
    });
  }
  
  return { isSpamming, spamScore, messagesLastMinute, messagesLastFiveMin };
}

/**
 * Check if user is currently throttled
 */
async function isUserThrottled(userId) {
  const user = await getUser(userId);
  if (!user) return false;
  
  if (user.is_throttled && user.throttled_until) {
    if (Date.now() < user.throttled_until) {
      return true;
    } else {
      // Throttle expired, remove it
      await updateUser(userId, {
        is_throttled: false,
        throttled_until: null
      });
      return false;
    }
  }
  
  return false;
}

/* ----------------------- Engagement Tier Classification ----------------------- */
/**
 * Calculate and update engagement tier for a user
 */
async function updateEngagementTier(userId) {
  const user = await getUser(userId);
  if (!user) return null;
  
  const now = Date.now();
  const daysSinceRegistration = (now - user.registered_at) / (1000 * 60 * 60 * 24);
  const hoursSinceLastSeen = (now - user.last_seen) / (1000 * 60 * 60);
  
  // Get activity stats
  const activityStats = await getUserActivityStats(userId, 7 * 24 * 60 * 60 * 1000); // Last 7 days
  const totalActivities = activityStats.reduce((sum, stat) => sum + parseInt(stat.count), 0);
  
  // Get referral quality
  const refAnalysis = await analyzeReferralPattern(userId);
  const referralQuality = parseFloat(refAnalysis.percentage) || 0;
  
  // Get completed tasks
  const completedTasks = await getUserCompletedTasks(userId);
  const taskCount = completedTasks.length;
  
  // Calculate tier score (0-100)
  let tierScore = 0;
  
  // Activity frequency (0-30 points)
  const activitiesPerDay = totalActivities / 7;
  tierScore += Math.min(30, activitiesPerDay * 3);
  
  // Streak bonus (0-15 points)
  tierScore += Math.min(15, (user.current_streak || 0) * 1.5);
  
  // Task completion (0-20 points)
  tierScore += Math.min(20, taskCount * 4);
  
  // Referral quality (0-15 points)
  tierScore += (referralQuality / 100) * 15;
  
  // Verification bonus (10 points)
  if (user.verified) tierScore += 10;
  
  // Account age bonus (0-10 points)
  tierScore += Math.min(10, daysSinceRegistration * 0.5);
  
  // Penalty for inactivity
  if (hoursSinceLastSeen > 168) { // 7 days
    tierScore *= 0.5;
  } else if (hoursSinceLastSeen > 72) { // 3 days
    tierScore *= 0.7;
  }
  
  // Determine tier
  let tier;
  if (tierScore >= 70) {
    tier = 'Elite';
  } else if (tierScore >= 50) {
    tier = 'Active';
  } else if (tierScore >= 30) {
    tier = 'Regular';
  } else if (tierScore >= 15) {
    tier = 'Dormant';
  } else {
    tier = 'Ghost';
  }
  
  // Update user tier
  await updateUser(userId, {
    engagement_tier: tier,
    tier_updated_at: now
  });
  
  return { tier, tierScore };
}

/**
 * Get users by engagement tier
 */
async function getUsersByTier(tier) {
  const result = await pool.query(
    'SELECT * FROM users WHERE engagement_tier = $1 ORDER BY activity_score DESC',
    [tier]
  );
  return result.rows;
}

/**
 * Get tier distribution statistics
 */
async function getTierDistribution() {
  const result = await pool.query(
    `SELECT engagement_tier, COUNT(*) as count
     FROM users
     GROUP BY engagement_tier
     ORDER BY 
       CASE engagement_tier
         WHEN 'Elite' THEN 1
         WHEN 'Active' THEN 2
         WHEN 'Regular' THEN 3
         WHEN 'Dormant' THEN 4
         WHEN 'Ghost' THEN 5
       END`
  );
  return result.rows;
}

/* ----------------------- Decay Systems ----------------------- */
/**
 * Apply idle decay to inactive users
 */
async function applyIdleDecay() {
  const now = Date.now();
  const threeDaysAgo = now - (3 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
  
  // Get inactive users
  const result = await pool.query(
    `SELECT id, activity_score, last_seen FROM users 
     WHERE last_seen < $1 AND (last_decay_applied IS NULL OR last_decay_applied < $2)`,
    [threeDaysAgo, now - (24 * 60 * 60 * 1000)]
  );
  
  const users = result.rows;
  let decayedCount = 0;
  
  for (const user of users) {
    const daysSinceLastSeen = (now - user.last_seen) / (1000 * 60 * 60 * 24);
    let decayFactor = 1;
    
    if (daysSinceLastSeen >= 7) {
      decayFactor = 0.9; // 10% decay per day after 7 days
    } else if (daysSinceLastSeen >= 3) {
      decayFactor = 0.95; // 5% decay per day after 3 days
    }
    
    const newScore = parseFloat(user.activity_score || 0) * decayFactor;
    
    await updateUser(user.id, {
      activity_score: newScore,
      last_decay_applied: now
    });
    
    decayedCount++;
  }
  
  return { decayedCount, totalChecked: users.length };
}

/**
 * Apply referral decay to reduce influence of inactive/fake referrals
 */
async function applyReferralDecay() {
  const allUsers = await getAllUsers();
  let processedCount = 0;
  
  for (const user of allUsers) {
    const referrals = await getUserReferrals(user.id);
    if (referrals.length === 0) continue;
    
    let activeReferrals = 0;
    const now = Date.now();
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
    
    for (const refId of referrals) {
      const refUser = await getUser(refId);
      if (!refUser) continue;
      
      // Check if referral is active
      const isActive = refUser.last_seen > sevenDaysAgo && 
                      (refUser.message_count || 0) > 5 &&
                      refUser.verified;
      
      if (isActive) activeReferrals++;
    }
    
    // Calculate referral quality score
    const qualityRatio = referrals.length > 0 ? activeReferrals / referrals.length : 0;
    
    // This score can be used in tier calculations
    // Store it in activity_data for now
    await logActivity(user.id, 'referral_quality_check', {
      totalReferrals: referrals.length,
      activeReferrals,
      qualityRatio
    });
    
    processedCount++;
  }
  
  return { processedCount };
}

/**
 * Run all decay and maintenance tasks
 */
async function runMaintenanceTasks() {
  console.log('🔄 Running maintenance tasks...');
  
  const idleDecayResult = await applyIdleDecay();
  console.log(`✅ Idle decay applied to ${idleDecayResult.decayedCount} users`);
  
  const referralDecayResult = await applyReferralDecay();
  console.log(`✅ Referral decay processed for ${referralDecayResult.processedCount} users`);
  
  // Update engagement tiers for all users
  const allUsers = await getAllUsers();
  let tiersUpdated = 0;
  
  for (const user of allUsers) {
    try {
      await updateEngagementTier(user.id);
      tiersUpdated++;
    } catch (error) {
      console.error(`Error updating tier for user ${user.id}:`, error);
    }
  }
  
  console.log(`✅ Engagement tiers updated for ${tiersUpdated} users`);
  
  return {
    idleDecay: idleDecayResult,
    referralDecay: referralDecayResult,
    tiersUpdated
  };
}

/* ----------------------- Enhanced Bot Detection ----------------------- */
/**
 * Comprehensive bot/fake user detection
 */
async function detectBotOrFakeUser(userId) {
  const user = await getUser(userId);
  if (!user) return { isFake: true, isBot: true, confidence: 100, reasons: ['User not found'] };
  
  const now = Date.now();
  const hoursSinceRegistration = (now - user.registered_at) / (1000 * 60 * 60);
  const daysSinceRegistration = hoursSinceRegistration / 24;
  
  const reasons = [];
  let botScore = 0;
  let fakeScore = 0;
  
  // Check 1: No activity at all
  if ((user.message_count || 0) === 0 && hoursSinceRegistration > 24) {
    fakeScore += 30;
    reasons.push('No messages after 24h');
  }
  
  // Check 2: No username - AUTOMATICALLY FLAG AS FAKE
  if (!user.username || user.username.length === 0) {
    fakeScore += 40; // Increased from 15 to 40
    reasons.push('No username - automatically flagged as fake');
  }
  
  // Check 3: Very low activity score
  if ((user.activity_score || 0) < 0.01 && daysSinceRegistration > 1) {
    fakeScore += 20;
    reasons.push('Extremely low activity score');
  }
  
  // Check 4: Never verified
  if (!user.verified && daysSinceRegistration > 7) {
    botScore += 10;
    reasons.push('Not verified after 7 days');
  }
  
  // Check 5: No wallet set
  if (!user.wallet && daysSinceRegistration > 3) {
    botScore += 10;
    reasons.push('No wallet after 3 days');
  }
  
  // Check 6: Check activity patterns
  const activityStats = await getUserActivityStats(userId, 7 * 24 * 60 * 60 * 1000);
  const totalActivities = activityStats.reduce((sum, stat) => sum + parseInt(stat.count), 0);
  
  if (totalActivities === 0 && daysSinceRegistration > 1) {
    fakeScore += 25;
    reasons.push('No activity in last 7 days');
  }
  
  // Check 7: Suspicious activity pattern (all same type)
  if (activityStats.length === 1 && totalActivities > 20) {
    botScore += 15;
    reasons.push('Repetitive activity pattern');
  }
  
  // Check 8: No completed tasks
  const completedTasks = await getUserCompletedTasks(userId);
  if (completedTasks.length === 0 && daysSinceRegistration > 7) {
    botScore += 10;
    reasons.push('No completed tasks');
  }
  
  // Check 9: High spam score
  if ((user.spam_score || 0) > 20) {
    botScore += 20;
    reasons.push('High spam score');
  }
  
  // Check 10: Referral pattern analysis
  const refAnalysis = await analyzeReferralPattern(userId);
  if (parseFloat(refAnalysis.percentage) < 20 && (refAnalysis.realRefs + refAnalysis.suspiciousRefs) > 5) {
    botScore += 15;
    reasons.push('Poor referral quality');
  }
  
  const totalScore = Math.max(botScore, fakeScore);
  const isBot = botScore > 50;
  const isFake = fakeScore > 50;
  const confidence = Math.min(100, totalScore);
  
  return {
    isBot,
    isFake,
    botScore,
    fakeScore,
    confidence,
    reasons,
    classification: isFake ? 'Fake' : isBot ? 'Bot' : confidence > 30 ? 'Suspicious' : 'Real'
  };
}

/* ----------------------- Verification advancement helper ----------------------- */
async function verifyUserAndReward(refereeId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock referee
    const refRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [refereeId]);
    const referee = refRes.rows[0];
    if (!referee) throw new Error('Referee not found');

    if (referee.verified) {
      await client.query('COMMIT');
      return { alreadyVerified: true };
    }

    // Mark referee verified
    await client.query('UPDATE users SET verified = TRUE WHERE id = $1', [refereeId]);

    // If referred_by exists, reward the referrer
    if (referee.referred_by) {
      const referrerId = referee.referred_by;
      const rRes = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [referrerId]);
      const referrer = rRes.rows[0];

      if (referrer) {
        const referralReward = parseFloat((await getSetting('referralReward')) || '0');
        const newBalance = (parseFloat(referrer.balance) || 0) + referralReward;
        await client.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, referrerId]);

        // Add referral record (idempotent)
        await client.query('INSERT INTO referrals (referrer_id, referred_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [referrerId, refereeId]);

        // increment referralReward counter? (We keep counters separate)
      }
    }

    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get referrer information for a user
 */
async function getReferrerInfo(userId) {
  const user = await getUser(userId);
  if (!user || !user.referred_by) return null;
  
  const referrer = await getUser(user.referred_by);
  if (!referrer) return null;
  
  return {
    id: referrer.id,
    username: referrer.username,
    verified: referrer.verified,
    registeredAt: referrer.registered_at
  };
}

/**
 * Rebuild activity history from registration to present
 */
async function rebuildUserActivityHistory(userId) {
  const user = await getUser(userId);
  if (!user) return { success: false, message: 'User not found' };
  
  const registrationDate = new Date(user.registered_at);
  const today = new Date();
  const daysSinceRegistration = Math.floor((today - registrationDate) / (1000 * 60 * 60 * 24));
  
  // Get all activity logs for this user
  const activityLogs = await getUserActivityLogs(userId, { limit: 10000 });
  
  // Rebuild streak based on activity logs
  const activityDates = new Set();
  activityLogs.forEach(log => {
    const logDate = new Date(log.timestamp).toISOString().split('T')[0];
    activityDates.add(logDate);
  });
  
  // Calculate current streak
  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 0;
  
  const sortedDates = Array.from(activityDates).sort().reverse();
  const todayStr = today.toISOString().split('T')[0];
  
  for (let i = 0; i < sortedDates.length; i++) {
    const currentDate = new Date(sortedDates[i]);
    const nextDate = sortedDates[i + 1] ? new Date(sortedDates[i + 1]) : null;
    
    tempStreak++;
    
    if (nextDate) {
      const dayDiff = Math.floor((currentDate - nextDate) / (1000 * 60 * 60 * 24));
      if (dayDiff !== 1) {
        longestStreak = Math.max(longestStreak, tempStreak);
        if (i === 0) currentStreak = tempStreak;
        tempStreak = 0;
      }
    } else {
      longestStreak = Math.max(longestStreak, tempStreak);
      if (i === 0) currentStreak = tempStreak;
    }
  }
  
  // Update user with rebuilt data
  await updateUser(userId, {
    current_streak: currentStreak,
    longest_streak: longestStreak
  });
  
  return {
    success: true,
    currentStreak,
    longestStreak,
    totalActivityDays: activityDates.size,
    daysSinceRegistration
  };
}

/**
 * Update submission status (for atomic operations)
 */
async function updateSubmissionStatus(submissionId, status, reviewedBy) {
  await pool.query(
    'UPDATE task_submissions SET status = $1, reviewed_at = $2, reviewed_by = $3 WHERE id = $4',
    [status, Date.now(), reviewedBy, submissionId]
  );
}

/**
 * Flag user as fake (for join/leave tracking)
 */
async function flagUserAsFake(userId, reason = 'Joined and left group') {
  try {
    await logActivity(userId, 'flagged_as_fake', { reason }, null, null);
    
    // Update user to mark as suspicious
    await updateUser(userId, {
      spam_score: Math.min(100, (await getUser(userId))?.spam_score || 0 + 50)
    });
  } catch (error) {
    console.error('Error flagging user as fake:', error);
  }
}

module.exports = {
  initializeDatabase,
  getUser,
  createUser,
  updateUser,
  ensureUser,
  addReferral,
  getUserReferrals,
  getReferralCount,
  getReferrerInfo,
  createTask,
  getTasks,
  getTaskById,
  deleteTask,
  getUserCompletedTasks,
  markTaskCompleted,
  createTaskSubmission,
  getSubmissionById,
  getLatestPendingSubmission,
  approveSubmissionAtomic,
  rejectSubmissionAtomic,
  updateSubmissionStatus,
  getPendingSubmissions: async () => {
    const r = await pool.query("SELECT * FROM task_submissions WHERE status = 'pending' ORDER BY submitted_at ASC");
    return r.rows;
  },
  approveAllPendingSubmissions,
  rejectAllPendingSubmissions,
  getSetting,
  setSetting,
  incrementSetting,
  getAllUsers,
  getVerifiedUsers,
  getTotalBalance,
  createWithdrawalRequest,
  getLatestPendingWithdrawal,
  updateWithdrawalStatus,
  getUserWithdrawalStats,
  blacklistUser,
  unblacklistUser,
  isUserBlacklisted,
  getAllBlacklistedUsers,
  analyzeReferralPattern,
  getDetailedReferralAnalysis,
  verifyUserAndReward,
  flagUserAsFake,
  rebuildUserActivityHistory,
  // Activity tracking
  logActivity,
  getUserActivityLogs,
  getUserActivityStats,
  // Spam detection
  checkSpamBehavior,
  isUserThrottled,
  // Engagement tiers
  updateEngagementTier,
  getUsersByTier,
  getTierDistribution,
  // Decay systems
  applyIdleDecay,
  applyReferralDecay,
  runMaintenanceTasks,
  // Bot detection
  detectBotOrFakeUser,
  pool
};
