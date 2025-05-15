#!/usr/bin/env node
require('dotenv').config();   // ← load .env into process.env

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

// ── CONFIGURATION ───────────────────────────────────────────────────────────

if (!process.env.TELEGRAM_TOKEN || !process.env.CHAT_ID) {
  console.error("⚠️ Please set TELEGRAM_TOKEN and CHAT_ID");
  process.exit(1);
}
const BOT_TOKEN     = process.env.TELEGRAM_TOKEN;
const CHAT_ID       = process.env.CHAT_ID;
const THREAD_ID     = process.env.THREAD_ID; // optional
const API_URL       = 'https://believe.xultra.fun/api/transactions';
const CREATOR_URL   = 'https://believe.xultra.fun/api/creator';
const ETHOS_URL     = 'https://believe.xultra.fun/api/ethos';
const POLL_INTERVAL = 3000;  // 3 seconds

// ── STATE FILES ─────────────────────────────────────────────────────────────

const PROCESSED_FILE = path.join(__dirname, 'processed.json');
const TIMESTAMP_FILE = path.join(__dirname, 'last_block_time.txt');

// load processed IDs
let processed = new Set();
if (fs.existsSync(PROCESSED_FILE)) {
  try {
    JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'))
      .forEach(id => processed.add(id));
  } catch {}
}

// ── UTILITIES ────────────────────────────────────────────────────────────────

const http = axios.create();
const IPFS_GATEWAYS = [
  'https://cloudflare-ipfs.com',
  'https://dweb.link',
  'https://gateway.pinata.cloud',
  'https://ipfs.io'
];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── TELEGRAM SENDING ────────────────────────────────────────────────────────

async function sendMessage(html) {
  const body = { chat_id: CHAT_ID, text: html, parse_mode: 'HTML' };
  if (THREAD_ID) body.message_thread_id = THREAD_ID;
  try {
    await http.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, body);
  } catch (e) {
    const resp = e.response?.data;
    if (resp?.error_code === 429 && resp.parameters?.retry_after) {
      const ms = (resp.parameters.retry_after + 1) * 1000;
      console.warn(`Rate limited sendMessage, waiting ${ms/1000}s`);
      await sleep(ms);
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
      const ms = (resp.parameters.retry_after + 1) * 1000;
      console.warn(`Rate limited sendPhoto, waiting ${ms/1000}s`);
      await sleep(ms);
      return sendWithImage(photoUrl, caption);
    }
    console.warn("sendPhoto failed, falling back to sendMessage:", resp || e.message);
    return sendMessage(caption);
  }
}

// ── DATA FETCHERS ────────────────────────────────────────────────────────────

async function fetchTxns() {
  try {
    const r = await http.get(API_URL, { timeout: 10_000 });
    if (!r.data || !Array.isArray(r.data.transactions)) {
      console.warn("fetchTxns: invalid JSON, skipping this round");
      return [];
    }
    return r.data.transactions;
  } catch (e) {
    const status = e.response?.status;
    if (status >= 500) {
      console.warn(`fetchTxns: server error ${status}, backing off 1s`);
      await sleep(1000);
    } else {
      console.error("fetchTxns error:", e.message);
    }
    return [];
  }
}

async function fetchMetadata(uri) {
  let ipfsPath;
  try { ipfsPath = new URL(uri).pathname; }
  catch { throw new Error(`Invalid metadata URI: ${uri}`); }

  let lastErr;
  for (const gw of IPFS_GATEWAYS) {
    try {
      const r = await http.get(gw + ipfsPath, { timeout: 10_000 });
      return r.data;
    } catch (err) {
      lastErr = err;
    }
  }
  // final fallback
  const r = await http.get(uri, { timeout: 10_000 });
  return r.data;
}

async function fetchCreatorInfo(addr) {
  try {
    const r = await http.get(`${CREATOR_URL}?address=${addr}`, { timeout: 5_000 });
    return {
      username:       r.data.username       || '',
      followers:      r.data.followersCount ?? 0,
      smartFollowers: r.data.smartFollowersCount ?? 0
    };
  } catch {
    return { username:'', followers:0, smartFollowers:0 };
  }
}

async function fetchEthos(u) {
  try {
    const r = await http.post(
      ETHOS_URL,
      { usernames:[u] },
      { headers:{ 'Content-Type':'application/json' }, timeout:5_000 }
    );
    return r.data.scores?.[u.toLowerCase()] ?? 0;
  } catch {
    return 0;
  }
}

// ── STATE PERSISTENCE ───────────────────────────────────────────────────────

function markProcessed(txn) {
  processed.add(txn.id);
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processed]), 'utf8');
  if (typeof txn.block_time === 'number') {
    fs.writeFileSync(TIMESTAMP_FILE, String(txn.block_time), 'utf8');
  }
}

// ── PROCESS & SEND ───────────────────────────────────────────────────────────

async function processTxn(txn) {
  if (processed.has(txn.id)) return;
  if (!txn.tokenInfo) {
    markProcessed(txn);
    return;
  }

  const { symbol, address, uri } = {
    symbol:  txn.tokenInfo.symbol  || '',
    address: txn.tokenInfo.address || '',
    uri:     txn.tokenInfo.uri
  };

  let meta = {};
  try { meta = await fetchMetadata(uri); }
  catch (err) { console.warn("metadata failed:", err.message); }

  const rawImage = meta.image || '';
  const imageUrl = rawImage.startsWith('http') ? rawImage : '';

  const { username: creator, followers, smartFollowers } =
    await fetchCreatorInfo(address);

  const ethosScore = creator ? await fetchEthos(creator) : 0;

  const caption = [
    `<b>Ticker:</b> $${escapeHtml(symbol)}`,
    `<b>Token Name:</b> ${escapeHtml(meta.name||'')}`,
    `<b>Creator:</b> <a href="https://x.com/${escapeHtml(creator)}">${escapeHtml(creator)}</a>`,
    `<b>Followers:</b> ${followers.toLocaleString()}`,
    `<b>Smart Followers:</b> ${smartFollowers.toLocaleString()}`,
    `<b>Ethos:</b> ${ethosScore.toLocaleString()}`,
    `<b>CA:</b> <code>${escapeHtml(address)}</code>`
  ].join('\n');

  await sendWithImage(imageUrl, caption);
  markProcessed(txn);
}

async function poll() {
  const txns = await fetchTxns();
  for (const txn of txns.slice().reverse()) {
    await processTxn(txn);
  }
}

// ── STARTUP & POLLING ───────────────────────────────────────────────────────

;(async () => {
  console.info(`🔔 Bot started (processed ${processed.size} txns)`);
  await poll();
  setInterval(poll, POLL_INTERVAL);
})();
