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

      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_verified ON users(verified);
      CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
      CREATE INDEX IF NOT EXISTS idx_task_submissions_user ON task_submissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_task_submissions_status ON task_submissions(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);
      CREATE INDEX IF NOT EXISTS idx_blacklist_user ON blacklist(user_id);
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
  const result = await pool.query(
    `INSERT INTO users (id, username, balance, wallet, verified, registered_at, last_seen, message_count, activity_score, last_bonus_claim)
     VALUES ($1, $2, 0, '', FALSE, $3, $3, 0, 0, 0)
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       last_seen = EXCLUDED.last_seen
     RETURNING *`,
    [userId, username, now]
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

async function ensureUser(userId, username = null, updateActivity = false) {
  let user = await getUser(userId);

  if (!user) {
    user = await createUser(userId, username);
  } else {
    const updates = { last_seen: Date.now() };
    if (username && username !== user.username) {
      updates.username = username;
    }

    if (updateActivity) {
      updates.message_count = (user.message_count || 0) + 1;
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
        lastSeen: 'Never'
      });
      continue;
    }

    const messageCount = refUser.message_count || 0;
    const activityScore = refUser.activity_score || 0;
    const hasWallet = refUser.wallet && refUser.wallet.length > 0;
    const isVerified = refUser.verified;
    const accountAge = Date.now() - refUser.registered_at;
    const hoursSinceRegistration = accountAge / (1000 * 60 * 60);
    const daysSinceRegistration = accountAge / (1000 * 60 * 60 * 24);

    // Get additional user stats
    const completedTasks = await getUserCompletedTasks(refId);
    const referralCount = await getReferralCount(refId);
    const withdrawalStats = await getUserWithdrawalStats(refId);
    
    // Calculate detailed score (max 13 points)
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

    // Determine classification and emoji with enhanced fake detection
    let classification, statusEmoji, scoreStars;
    
    // Enhanced fake detection logic
    const isFake = (
      messageCount === 0 && 
      completedTasks.length === 0 && 
      !isVerified && 
      !hasWallet && 
      hoursSinceRegistration < 1 &&
      referralCount === 0
    );
    
    const isLikelyBot = (
      messageCount === 0 && 
      completedTasks.length === 0 && 
      hoursSinceRegistration < 24 &&
      !isVerified
    );
    
    if (isFake) {
      classification = 'Fake';
      statusEmoji = '🚫';
      scoreStars = '❌';
    } else if (score >= 8) {
      classification = 'Real User';
      statusEmoji = '✅';
      scoreStars = '⭐⭐⭐⭐⭐';
    } else if (score >= 5) {
      classification = 'Real User';
      statusEmoji = '✅';
      scoreStars = '⭐⭐⭐⭐';
    } else if (score >= 3) {
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
      referralCount,
      totalWithdrawn: withdrawalStats.totalWithdrawn,
      pendingWithdrawals: withdrawalStats.pendingCount,
      lastSeen: lastSeenString,
      registeredAt: new Date(refUser.registered_at).toLocaleString()
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

module.exports = {
  initializeDatabase,
  getUser,
  createUser,
  updateUser,
  ensureUser,
  addReferral,
  getUserReferrals,
  getReferralCount,
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
  pool
};
