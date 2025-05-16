#!/usr/bin/env node
require('dotenv').config();

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

// ── CONFIG ─────────────────────────────────────────────────────────────────

if (!process.env.TELEGRAM_TOKEN || !process.env.CHAT_ID) {
  console.error("⚠️  Please set TELEGRAM_TOKEN and CHAT_ID");
  process.exit(1);
}
const BOT_TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID     = process.env.CHAT_ID;
const THREAD_ID   = process.env.THREAD_ID; // optional
// NEW endpoint:
const API_URL       = 'https://believe.xultra.fun/api/coins';
const ETHOS_URL     = 'https://believe.xultra.fun/api/ethos';
const POLL_INTERVAL = 3000;

// ── STATE FILES ─────────────────────────────────────────────────────────────

const PROCESSED_FILE = path.join(__dirname, 'processed.json');

// load processed token‐IDs
let processed = new Set();
if (fs.existsSync(PROCESSED_FILE)) {
  try {
    JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'))
        .forEach(id => processed.add(id));
  } catch {}
}

// ── HELPERS ─────────────────────────────────────────────────────────────────

const http = axios.create({ timeout: 10_000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function escapeHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

// ── TELEGRAM SENDER ─────────────────────────────────────────────────────────

async function sendMessage(html) {
  const body = { chat_id: CHAT_ID, text: html, parse_mode: 'HTML' };
  if (THREAD_ID) body.message_thread_id = THREAD_ID;
  try {
    await http.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, body);
  } catch (e) {
    const resp = e.response?.data;
    if (resp?.error_code === 429 && resp.parameters?.retry_after) {
      await sleep((resp.parameters.retry_after + 1) * 1000);
      return sendMessage(html);
    }
    console.error("sendMessage error:", resp || e.message);
  }
}

async function sendWithImage(photoUrl, caption) {
  if (!photoUrl) return sendMessage(caption);

  const body = {
    chat_id:    CHAT_ID,
    photo:      photoUrl,
    caption,
    parse_mode: 'HTML'
  };
  if (THREAD_ID) body.message_thread_id = THREAD_ID;

  try {
    await http.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, body);
  } catch (e) {
    const resp = e.response?.data;
    if (resp?.error_code === 429 && resp.parameters?.retry_after) {
      await sleep((resp.parameters.retry_after + 1) * 1000);
      return sendWithImage(photoUrl, caption);
    }
    console.warn("sendPhoto failed, falling back to sendMessage:", resp || e.message);
    return sendMessage(caption);
  }
}

// ── DATA FETCHER ────────────────────────────────────────────────────────────

async function fetchTokens() {
  try {
    const r = await http.get(API_URL);
    if (!r.data || !Array.isArray(r.data.tokens)) {
      console.warn("fetchTokens: invalid JSON:", r.data);
      return [];
    }
    return r.data.tokens;
  } catch (e) {
    console.error("fetchTokens error:", e.response?.status, e.message);
    // on server errors back off 1s:
    if (e.response?.status >= 500) await sleep(1000);
    return [];
  }
}

// ── ETHOS FETCH ─────────────────────────────────────────────────────────────

async function fetchEthos(username) {
  if (!username) return 0;
  try {
    const r = await http.post(
      ETHOS_URL,
      { usernames: [username] },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return r.data.scores?.[username.toLowerCase()] ?? 0;
  } catch {
    return 0;
  }
}

// ── STATE PERSISTENCE ───────────────────────────────────────────────────────

function markProcessed(token) {
  processed.add(token.id);
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processed]), 'utf8');
}

// ── PROCESS & SEND ──────────────────────────────────────────────────────────

async function processToken(token) {
  // skip if already posted
  if (processed.has(token.id)) return;

  // destructure the new shape
  const {
    symbol,
    name,
    address,
    imageUrl,
    metadata
  } = token;

  // metadata.creator holds creator info now
  const creatorInfo = metadata?.creator || {};
  const username       = creatorInfo.twitterUsername || '';
  const followers      = creatorInfo.followersCount    || 0;
  const smartFollowers = creatorInfo.smartFollowersCount || 0;

  // fetch ethos
  const ethosScore = await fetchEthos(username);

  // build caption
  const caption = [
    `<b>Ticker:</b> $${escapeHtml(symbol)}`,
    `<b>Token Name:</b> ${escapeHtml(name)}`,
    `<b>Creator:</b> <a href="https://x.com/${escapeHtml(username)}">${escapeHtml(username)}</a>`,
    `<b>Followers:</b> ${followers.toLocaleString()}`,
    `<b>Smart Followers:</b> ${smartFollowers.toLocaleString()}`,
    `<b>Ethos:</b> ${ethosScore.toLocaleString()}`,
    `<b>CA:</b> <code>${escapeHtml(address)}</code>`
  ].join('\n');

  // send to Telegram
  await sendWithImage(imageUrl, caption);

  // persist so we don’t re-send
  markProcessed(token);
}

// ── POLLING LOOP ────────────────────────────────────────────────────────────

async function poll() {
  const tokens = await fetchTokens();
  // oldest first
  for (const tok of tokens.slice().reverse()) {
    await processToken(tok);
  }
}

// ── BOOTSTRAP ───────────────────────────────────────────────────────────────

;(async () => {
  console.info(`🔔 Bot started (already posted ${processed.size} tokens)`);
  await poll();
  setInterval(poll, POLL_INTERVAL);
})();
