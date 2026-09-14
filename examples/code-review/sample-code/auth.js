// auth.js — sample code with intentional issues for demo
const crypto = require('crypto');
const db = require('./db');

const SECRET = 'supersecret123';  // hardcoded secret

async function login(req, res) {
  const { username, password } = req.body;

  // SQL query
  const user = await db.query(
    `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`
  );

  if (user.length === 0) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Generate token
  const token = crypto.createHmac('sha256', SECRET)
    .update(username)
    .digest('hex');

  // Set cookie without flags
  res.cookie('session', token);

  return res.json({
    message: 'Login successful',
    user: user[0],  // returns entire user object including password hash
    token: token
  });
}

async function resetPassword(req, res) {
  const { email } = req.query;  // GET request with email in URL
  const newPassword = Math.random().toString(36).slice(2, 10);

  await db.query(
    `UPDATE users SET password = '${newPassword}' WHERE email = '${email}'`
  );

  return res.json({ message: 'Password reset', newPassword });  // returns password in response
}

module.exports = { login, resetPassword };
