const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        username TEXT,
        balance DECIMAL(20, 2) DEFAULT 0,
        wallet TEXT,
        referred_by BIGINT,
        verified BOOLEAN DEFAULT FALSE,
        registered_at BIGINT NOT NULL,
        last_seen BIGINT NOT NULL,
        message_count INTEGER DEFAULT 0,
        activity_score DECIMAL(10, 4) DEFAULT 0,
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
        reward DECIMAL(20, 2) NOT NULL,
        created_at BIGINT NOT NULL,
        created_by BIGINT,
        status TEXT DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS task_submissions (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        task_id INTEGER NOT NULL,
        task_title TEXT,
        task_reward DECIMAL(20, 2),
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
        reward DECIMAL(20, 2),
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
        amount DECIMAL(20, 2) NOT NULL,
        wallet TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        requested_at BIGINT NOT NULL,
        reviewed_at BIGINT,
        reviewed_by BIGINT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_verified ON users(verified);
      CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
      CREATE INDEX IF NOT EXISTS idx_task_submissions_user ON task_submissions(user_id);
      CREATE INDEX IF NOT EXISTS idx_task_submissions_status ON task_submissions(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);
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

async function getUser(userId) {
  const result = await pool.query(
    'SELECT * FROM users WHERE id = $1',
    [userId]
  );
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
  const result = await pool.query(
    'SELECT referred_id FROM referrals WHERE referrer_id = $1',
    [userId]
  );
  return result.rows.map(row => row.referred_id);
}

async function getReferralCount(userId) {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM referrals WHERE referrer_id = $1',
    [userId]
  );
  return parseInt(result.rows[0].count);
}

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
  const result = await pool.query(
    'SELECT * FROM tasks WHERE status = $1 ORDER BY created_at DESC',
    [status]
  );
  return result.rows;
}

async function getTaskById(taskId) {
  const result = await pool.query(
    'SELECT * FROM tasks WHERE id = $1',
    [taskId]
  );
  return result.rows[0] || null;
}

async function deleteTask(taskId) {
  await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
}

async function getUserCompletedTasks(userId) {
  const result = await pool.query(
    'SELECT task_id FROM completed_tasks WHERE user_id = $1',
    [userId]
  );
  return result.rows.map(row => row.task_id);
}

async function markTaskCompleted(userId, taskId, reward) {
  await pool.query(
    `INSERT INTO completed_tasks (user_id, task_id, completed_at, reward)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, task_id) DO NOTHING`,
    [userId, taskId, Date.now(), reward]
  );
}

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
  const result = await pool.query(
    'SELECT * FROM task_submissions WHERE id = $1',
    [submissionId]
  );
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

async function updateSubmissionStatus(submissionId, status, reviewedBy = null) {
  const result = await pool.query(
    `UPDATE task_submissions 
     SET status = $1, reviewed_at = $2, reviewed_by = $3
     WHERE id = $4
     RETURNING *`,
    [status, Date.now(), reviewedBy, submissionId]
  );
  
  if (status === 'approved') {
    await incrementSetting('tasksApproved');
  } else if (status === 'rejected') {
    await incrementSetting('tasksRejected');
  }
  
  return result.rows[0];
}

async function getPendingSubmissions() {
  const result = await pool.query(
    `SELECT * FROM task_submissions WHERE status = 'pending' ORDER BY submitted_at ASC`
  );
  return result.rows;
}

async function approveAllPendingSubmissions(reviewedBy) {
  const result = await pool.query(
    `UPDATE task_submissions 
     SET status = 'approved', reviewed_at = $1, reviewed_by = $2
     WHERE status = 'pending'
     RETURNING *`,
    [Date.now(), reviewedBy]
  );
  
  const count = result.rows.length;
  await incrementSetting('tasksApproved', count);
  
  return result.rows;
}

async function rejectAllPendingSubmissions(reviewedBy) {
  const result = await pool.query(
    `UPDATE task_submissions 
     SET status = 'rejected', reviewed_at = $1, reviewed_by = $2
     WHERE status = 'pending'
     RETURNING *`,
    [Date.now(), reviewedBy]
  );
  
  const count = result.rows.length;
  await incrementSetting('tasksRejected', count);
  
  return result.rows;
}

async function getSetting(key) {
  const result = await pool.query(
    'SELECT value FROM bot_settings WHERE key = $1',
    [key]
  );
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
  updateSubmissionStatus,
  getPendingSubmissions,
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
  pool
};
