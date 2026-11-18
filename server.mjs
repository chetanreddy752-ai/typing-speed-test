import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'typesprint.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    wpm INTEGER NOT NULL,
    raw_wpm INTEGER NOT NULL,
    accuracy INTEGER NOT NULL,
    correct INTEGER NOT NULL,
    incorrect INTEGER NOT NULL,
    total INTEGER NOT NULL,
    duration INTEGER NOT NULL,
    difficulty TEXT NOT NULL,
    consistency INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_results_user_date ON results(user_id, date DESC);
`);

const PORT = Number(process.env.PORT || 3001);
const SESSION_DAYS = 30;
const COOKIE_NAME = 'typesprint_session';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': 'http://localhost:5173',
    'Access-Control-Allow-Credentials': 'true'
  });
  res.end(payload);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf('=');
    return [i >= 0 ? x.slice(0, i) : x, i >= 0 ? decodeURIComponent(x.slice(i + 1)) : ''];
  }));
}

function setCookie(res, value, maxAge) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function safeUser(row) {
  return { id: row.id, name: row.name, email: row.email, createdAt: row.created_at };
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), userId, expires);
  setCookie(res, token, SESSION_DAYS * 86400);
}

function getUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at > ?
  `).get(hashToken(token), new Date().toISOString());
  return row || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1000000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validResult(r) {
  return r && typeof r.id === 'string' && typeof r.date === 'string' &&
    Number.isFinite(r.wpm) && Number.isFinite(r.rawWpm) && Number.isFinite(r.accuracy) &&
    Number.isFinite(r.correct) && Number.isFinite(r.incorrect) && Number.isFinite(r.total) &&
    Number.isFinite(r.duration) && ['easy', 'medium', 'hard'].includes(r.difficulty) &&
    Number.isFinite(r.consistency);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': 'http://localhost:5173',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });

    if (req.method === 'POST' && url.pathname === '/api/auth/signup') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (name.length < 2 || name.length > 60) return json(res, 400, { error: 'Name must be 2–60 characters.' });
      if (!validEmail(email)) return json(res, 400, { error: 'Enter a valid email address.' });
      if (password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters.' });
      if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return json(res, 409, { error: 'An account with that email already exists.' });
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const { hash, salt } = hashPassword(password);
      db.prepare('INSERT INTO users(id,name,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?,?)').run(id, name, email, hash, salt, createdAt);
      createSession(res, id);
      return json(res, 201, { user: { id, name, email, createdAt } });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      if (!user) return json(res, 401, { error: 'Email or password is incorrect.' });
      const { hash } = hashPassword(password, user.password_salt);
      const a = Buffer.from(hash, 'hex');
      const b = Buffer.from(user.password_hash, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(res, 401, { error: 'Email or password is incorrect.' });
      createSession(res, user.id);
      return json(res, 200, { user: safeUser(user) });
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      const token = parseCookies(req)[COOKIE_NAME];
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
      clearCookie(res);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const user = getUser(req);
      return json(res, 200, { user: user ? safeUser(user) : null });
    }

    if (req.method === 'GET' && url.pathname === '/api/results') {
      const user = getUser(req);
      if (!user) return json(res, 401, { error: 'Sign in to view cloud results.' });
      const rows = db.prepare('SELECT id,date,wpm,raw_wpm as rawWpm,accuracy,correct,incorrect,total,duration,difficulty,consistency FROM results WHERE user_id=? ORDER BY date DESC LIMIT 100').all(user.id);
      return json(res, 200, { results: rows });
    }

    if (req.method === 'POST' && url.pathname === '/api/results') {
      const user = getUser(req);
      if (!user) return json(res, 401, { error: 'Sign in to save results.' });
      const r = await readBody(req);
      if (!validResult(r)) return json(res, 400, { error: 'Invalid test result.' });
      db.prepare(`INSERT OR REPLACE INTO results
        (id,user_id,date,wpm,raw_wpm,accuracy,correct,incorrect,total,duration,difficulty,consistency)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        r.id, user.id, r.date, Math.round(r.wpm), Math.round(r.rawWpm), Math.round(r.accuracy),
        Math.round(r.correct), Math.round(r.incorrect), Math.round(r.total), Math.round(r.duration),
        r.difficulty, Math.round(r.consistency)
      );
      return json(res, 201, { ok: true });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/results') {
      const user = getUser(req);
      if (!user) return json(res, 401, { error: 'Sign in to clear cloud results.' });
      db.prepare('DELETE FROM results WHERE user_id=?').run(user.id);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    json(res, 500, { error: 'Server error. Check the terminal running the database server.' });
  }
});

server.listen(PORT, () => {
  console.log(`TypeSprint database server: http://localhost:${PORT}`);
  console.log(`SQLite database: ${path.join(dataDir, 'typesprint.db')}`);
});
