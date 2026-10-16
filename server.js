'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4000;

// env config
let shopeeToken = process.env.SHOPEE_TOKEN || '';
const apiKey = process.env.API_KEY || '';
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramChatID = process.env.TELEGRAM_CHAT_ID || '';
const qrisStatic = process.env.QRIS_STATIC || '';


const qrisStore = new Map();
const usedTransactionIds = new Map();

let tokenValid = true;
let tokenNotifSent = false;

const logs = [];
const MAX_LOGS = 100;

// Logging
function logEvent(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
  logs.push({ timestamp, level, message });
  if (logs.length > MAX_LOGS) logs.shift();
}

// User-Agent Rotation
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

function randomUA() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Status Map
const statusMap = {
  1: 'pending',
  2: 'failed',
  3: 'success',
  4: 'refunded',
  5: 'expired',
};

// Express Middleware
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// API Key Auth Middleware
function apiKeyMiddleware(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== apiKey) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or missing API key',
    });
  }
  next();
}

// Format Transaction
function formatTransaction(tx) {
  const UTC_OFFSET_MINUTES = 7 * 60; // WIB (UTC+7)
  const rawDate = new Date(tx.createTime * 1000);
  const localDate = new Date(
    rawDate.getTime() + UTC_OFFSET_MINUTES * 60 * 1000
  );

  const pad = (v) => String(v).padStart(2, '0');
  const time =
    localDate.getUTCFullYear() +
    '-' +
    pad(localDate.getUTCMonth() + 1) +
    '-' +
    pad(localDate.getUTCDate()) +
    ' ' +
    pad(localDate.getUTCHours()) +
    ':' +
    pad(localDate.getUTCMinutes()) +
    ':' +
    pad(localDate.getUTCSeconds());

  const amountStr = String(tx.amount || '0')
    .replace(/\./g, '')
    .replace(/,/g, '');
  const amount = parseInt(amountStr, 10) || 0;

  const status = statusMap[tx.status] || 'unknown_' + tx.status;

  return { amount, status, time };
}

// Get Token from Request or Default
function getReqToken(req) {
  return req.headers['x-shopee-token'] || shopeeToken;
}

// ShopeePay API: Get Transaction List
async function callShopeeAPI(
  startTime,
  endTime,
  pageSize,
  nextPosition,
  token = shopeeToken
) {
  const payload = {
    data: {
      metadata: {
        token: token,
        language: 'id',
        timezone: 'Asia/Jakarta',
      },
      pageSize: pageSize,
      filter: {
        startTime: startTime,
        endTime: endTime,
        serviceList: [1, 3],
      },
      sorter: {
        field: 'createTime',
        order: 'descend',
      },
      next_position: nextPosition || '',
    },
  };

  const headers = {
    'Content-Type': 'application/json',
    Origin: 'https://partner.shopee.co.id',
    Referer: 'https://partner.shopee.co.id/',
    'User-Agent': randomUA(),
    'X-Timestamp-Ms': String(Date.now()),
  };

  const response = await axios.post(
    'https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-list',
    payload,
    { headers, timeout: 20000 }
  );

  return response.data;
}

// ShopeePay API: Get Transaction Detail
async function callShopeeDetailAPI(orderSn, token = shopeeToken) {
  const payload = {
    data: {
      metadata: {
        token: token,
        language: 'id',
        timezone: 'Asia/Jakarta',
      },
      order_sn: orderSn,
    },
  };

  const headers = {
    'Content-Type': 'application/json',
    Origin: 'https://partner.shopee.co.id',
    Referer: 'https://partner.shopee.co.id/',
    'User-Agent': randomUA(),
    'X-Timestamp-Ms': String(Date.now()),
  };

  const response = await axios.post(
    'https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-detail',
    payload,
    { headers, timeout: 20000 }
  );

  return response.data;
}

// Telegram Notification
async function sendTelegramNotif(text) {
  if (!telegramBotToken || !telegramChatID) {
    console.log('[TELEGRAM] Bot token atau chat ID belum diset');
    return;
  }

  const url =
    'https://api.telegram.org/bot' + telegramBotToken + '/sendMessage';

  try {
    await axios.post(
      url,
      { chat_id: telegramChatID, text: text, parse_mode: 'HTML' },
      { timeout: 10000 }
    );
    console.log('[TELEGRAM] Notif sent');
  } catch (err) {
    console.error('[TELEGRAM] Send failed:', err.message);
  }
}

// QRIS TLV Parser
function parseTLV(qrisString) {
  const result = [];
  let pos = 0;

  while (pos < qrisString.length) {
    if (pos + 4 > qrisString.length) break;

    const tag = qrisString.slice(pos, pos + 2);
    const length = parseInt(qrisString.slice(pos + 2, pos + 4), 10);

    if (isNaN(length)) break;

    pos += 4;

    if (pos + length > qrisString.length) break;

    const value = qrisString.slice(pos, pos + length);
    pos += length;

    result.push([tag, value]);
  }

  return result;
}

// QRIS TLV Builder
function buildTLV(entries) {
  let result = '';
  for (const [tag, value] of entries) {
    result += tag + String(value.length).padStart(2, '0') + value;
  }
  return result;
}

// CRC16-CCITT Checksum
function crc16CCITT(str) {
  let crc = 0xffff;

  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;

    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// Generate Dynamic QRIS
function generateDynamicQRIS(staticQris, amount) {
  if (!staticQris) {
    throw new Error('QRIS_STATIC belum diset di .env');
  }

  const tlvEntries = parseTLV(staticQris);

  if (tlvEntries.length === 0) {
    throw new Error('invalid QRIS format');
  }

  const newEntries = [];
  let amountInjected = false;

  for (const entry of tlvEntries) {
    // Skip existing CRC (tag 63)
    if (entry[0] === '63') continue;

    // Replace existing amount (tag 54)
    if (entry[0] === '54') {
      newEntries.push(['54', String(amount)]);
      amountInjected = true;
      continue;
    }

    newEntries.push(entry);
  }

  // If tag 54 didn't exist, insert it after tag 53 (currency)
  if (!amountInjected) {
    const withAmount = [];
    for (const entry of newEntries) {
      withAmount.push(entry);
      if (entry[0] === '53') {
        withAmount.push(['54', String(amount)]);
      }
    }
    newEntries.length = 0;
    newEntries.push(...withAmount);
  }

  // Build TLV string and append CRC tag placeholder
  let qrisData = buildTLV(newEntries);
  qrisData += '6304';

  // Calculate and append CRC
  const crc = crc16CCITT(qrisData);
  return qrisData + crc;
}

// Token Health Checker
async function checkToken() {
  const nowSec = Math.floor(Date.now() / 1000);
  const startTime = nowSec - 3600;
  const endTime = nowSec;

  try {
    const result = await callShopeeAPI(startTime, endTime, 1, '');

    if (!result || result.code !== 0) {
      const errMsg = result ? result.msg : 'Invalid response format';
      logEvent('ERROR', 'Token invalid: ' + errMsg);
      tokenValid = false;

      if (!tokenNotifSent) {
        await sendTelegramNotif(
          '⚠️ <b>Shopee API</b>\n\nToken invalid: ' +
            errMsg +
            '\n\nUpdate token via POST /update-token'
        );
        tokenNotifSent = true;
      }
      return;
    }

    logEvent('INFO', 'Token valid');
    tokenValid = true;
    tokenNotifSent = false;
  } catch (err) {
    logEvent('ERROR', 'Token check failed: ' + err.message);
    tokenValid = false;

    if (!tokenNotifSent) {
      await sendTelegramNotif(
        '⚠️ <b>Shopee API</b>\n\nToken error: ' +
          err.message +
          '\n\nUpdate token via POST /update-token'
      );
      tokenNotifSent = true;
    }
  }
}

function startTokenChecker() {
  checkToken();
  setInterval(checkToken, 5 * 60 * 1000); // every 5 minutes
}

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'ShopeePay API Service is running',
    timestamp: new Date().toISOString(),
  });
});

// Update Token
app.post('/update-token', apiKeyMiddleware, (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({
      success: false,
      error: 'Provide token in body',
    });
  }

  shopeeToken = token;
  logEvent('INFO', 'Token updated via API');

  res.json({
    success: true,
    data: { message: 'Token updated' },
  });
});

// Token Status
app.get('/token-status', apiKeyMiddleware, (req, res) => {
  const status = tokenValid ? 'valid' : 'invalid';

  res.json({
    success: tokenValid,
    data: {
      token_status: status,
      message: tokenValid
        ? 'Token is working'
        : 'Token expired/invalid. Please update via POST /update-token',
    },
  });
});

// Create Dynamic QRIS
app.post('/create-qris', apiKeyMiddleware, (req, res) => {
  const { amount } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({
      success: false,
      error: 'Provide valid amount (positive integer)',
    });
  }

  try {
    const qrisData = generateDynamicQRIS(qrisStatic, amount);
    const qrId = crypto.randomBytes(4).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    qrisStore.set(qrId, { data: qrisData, expiresAt });

    const host = req.get('host');
    const protocol = req.protocol;
    const qrisUrl = protocol + '://' + host + '/qr/' + qrId;

    const UTC_OFFSET_MINUTES = 7 * 60;
    const localExpiry = new Date(
      expiresAt.getTime() + UTC_OFFSET_MINUTES * 60 * 1000
    );
    const pad = (v) => String(v).padStart(2, '0');
    const expiresAtStr =
      localExpiry.getUTCFullYear() +
      '-' +
      pad(localExpiry.getUTCMonth() + 1) +
      '-' +
      pad(localExpiry.getUTCDate()) +
      ' ' +
      pad(localExpiry.getUTCHours()) +
      ':' +
      pad(localExpiry.getUTCMinutes()) +
      ':' +
      pad(localExpiry.getUTCSeconds());

    res.json({
      success: true,
      data: {
        qris_url: qrisUrl,
        amount: amount,
        expires_at: expiresAtStr,
        expires_in: '15 menit',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// QR Redirect
app.get('/qr/:id', (req, res) => {
  const qrId = req.params.id;
  const entry = qrisStore.get(qrId);

  if (!entry) {
    return res.status(404).send('QR not found');
  }

  if (Date.now() > entry.expiresAt.getTime()) {
    qrisStore.delete(qrId);
    return res.status(410).send('QR expired');
  }

  const qrImageUrl =
    'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' +
    encodeURIComponent(entry.data);

  res.redirect(302, qrImageUrl);
});

// Get Transactions
app.get('/transactions', apiKeyMiddleware, async (req, res) => {
  const nowSec = Math.floor(Date.now() / 1000);

  let startTime = parseInt(req.query.startTime, 10);
  let endTime = parseInt(req.query.endTime, 10);
  let pageSize = parseInt(req.query.pageSize, 10);
  const nextPosition = req.query.next_position || '';

  if (isNaN(startTime) || startTime === 0) {
    startTime = nowSec - 3 * 24 * 3600; // default: 3 days ago
  }
  if (isNaN(endTime) || endTime === 0) {
    endTime = nowSec;
  }
  if (isNaN(pageSize) || pageSize === 0) {
    pageSize = 10;
  }

  const token = getReqToken(req);

  try {
    const result = await callShopeeAPI(
      startTime,
      endTime,
      pageSize,
      nextPosition,
      token
    );

    if (!result) {
      return res.status(500).json({
        success: false,
        error: 'Empty response from ShopeePay API',
      });
    }

    if (result.code !== 0) {
      return res.status(400).json({
        success: false,
        error: result.msg || 'API error code ' + result.code,
      });
    }

    const txList = (result.data && result.data.list) || [];
    const transactions = [];

    for (const tx of txList) {
      const formatted = formatTransaction(tx);

      try {
        const detail = await callShopeeDetailAPI(
          tx.displayTransactionId || tx.transactionId,
          token
        );
        if (detail && detail.code === 0 && detail.data) {
          formatted.issuer = detail.data.issuer;
        }
      } catch (detailErr) {
        logEvent(
          'ERROR',
          'Error checking detail for ' +
            tx.transactionId +
            ': ' +
            detailErr.message
        );
      }

      transactions.push(formatted);
    }

    res.json({
      success: true,
      total_amount:
        (result.data && result.data.totalNetSales) || '0',
      data: { transactions },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get All Transactions (Current Month)
app.get('/transactions/all', apiKeyMiddleware, async (req, res) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  // Start of current month in WIB (UTC+7)
  const UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
  const monthStart = new Date(Date.UTC(year, month, 1, 0, 0, 0) - UTC_OFFSET_MS);
  const startTimeSec = Math.floor(monthStart.getTime() / 1000);
  const endTimeSec = Math.floor(now.getTime() / 1000);

  const allTransactions = [];
  let nextPosition = '';
  const pageSize = 100;
  const token = getReqToken(req);

  try {
    while (true) {
      const result = await callShopeeAPI(
        startTimeSec,
        endTimeSec,
        pageSize,
        nextPosition,
        token
      );

      if (!result) {
        return res.status(500).json({
          success: false,
          error: 'Empty response from ShopeePay API',
        });
      }

      if (result.code !== 0) {
        return res.status(400).json({
          success: false,
          error: result.msg || 'API error code ' + result.code,
        });
      }

      const txList = (result.data && result.data.list) || [];

      for (const tx of txList) {
        const formatted = formatTransaction(tx);

        try {
          const detail = await callShopeeDetailAPI(
            tx.displayTransactionId || tx.transactionId,
            token
          );
          if (detail && detail.code === 0 && detail.data) {
            formatted.issuer = detail.data.issuer;
          }
        } catch (detailErr) {
          logEvent(
            'ERROR',
            'Error checking detail for ' +
              tx.transactionId +
              ': ' +
              detailErr.message
          );
        }

        allTransactions.push(formatted);
      }

      // Stop if no more pages
      if (
        !result.data ||
        !result.data.next_position ||
        txList.length < pageSize
      ) {
        break;
      }

      nextPosition = result.data.next_position;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Build period string
    const pad = (v) => String(v).padStart(2, '0');
    const periodStart = new Date(monthStart.getTime() + UTC_OFFSET_MS);
    const periodEnd = new Date(now.getTime() + UTC_OFFSET_MS);

    const periodStr =
      periodStart.getUTCFullYear() +
      '-' +
      pad(periodStart.getUTCMonth() + 1) +
      '-' +
      pad(periodStart.getUTCDate()) +
      ' s/d ' +
      periodEnd.getUTCFullYear() +
      '-' +
      pad(periodEnd.getUTCMonth() + 1) +
      '-' +
      pad(periodEnd.getUTCDate());

    res.json({
      success: true,
      total_amount: String(allTransactions.length),
      data: {
        period: periodStr,
        total_count: allTransactions.length,
        transactions: allTransactions,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Check Payment (Stateless Verification)
app.post('/check-payment', apiKeyMiddleware, async (req, res) => {
  const { amount, startTime: rawStartTime } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({
      success: false,
      error: 'Provide valid amount (positive integer)',
    });
  }

  const token = getReqToken(req);
  const nowSec = Math.floor(Date.now() / 1000);

  let startTime = parseInt(rawStartTime, 10);
  if (isNaN(startTime) || startTime === 0) {
    startTime = nowSec - 30 * 60; // default: 30 minutes ago
  }

  logEvent(
    'INFO',
    'Memulai pengecekan pembayaran stateless. Nominal: Rp ' +
      amount +
      ', Waktu Mulai: ' +
      new Date(startTime * 1000).toISOString()
  );

  try {
    const result = await callShopeeAPI(startTime, nowSec, 50, '', token);

    if (!result) {
      logEvent('ERROR', 'Respons dari ShopeePay API kosong.');
      return res.status(500).json({
        success: false,
        error: 'Empty response from ShopeePay API',
      });
    }

    if (result.code !== 0) {
      logEvent(
        'ERROR',
        'API ShopeePay mengembalikan kode ' +
          result.code +
          ': ' +
          result.msg
      );
      return res.status(400).json({
        success: false,
        error: result.msg || 'API error code ' + result.code,
      });
    }

    const txList = (result.data && result.data.list) || [];
    const targetAmount = Number(amount);

    // Find matching transaction
    const matchedTx = txList.find((tx) => {
      const amountStr = String(tx.amount || '0')
        .replace(/\./g, '')
        .replace(/,/g, '');
      const txAmount = parseInt(amountStr, 10) || 0;
      const txId = tx.displayTransactionId || tx.transactionId;

      return (
        tx.status === 3 &&
        txAmount === targetAmount &&
        tx.createTime >= startTime &&
        !usedTransactionIds.has(txId)
      );
    });

    // Not found
    if (!matchedTx) {
      logEvent(
        'INFO',
        'Pengecekan selesai. Nominal Rp ' + amount + ' BELUM ditemukan.'
      );
      return res.json({ success: true, paid: false });
    }

    // Found! Mark as used (anti-double-claim)
    const transactionId =
      matchedTx.transactionId || matchedTx.displayTransactionId;
    usedTransactionIds.set(transactionId, matchedTx.createTime);

    // Purge entries older than 24 hours
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
    for (const [id, createTime] of usedTransactionIds.entries()) {
      if (createTime < cutoff) {
        usedTransactionIds.delete(id);
      }
    }

    logEvent(
      'INFO',
      'Pencocokan berhasil! Transaksi ditemukan: ' +
        transactionId +
        '. Mengambil detail...'
    );

    const formatted = formatTransaction(matchedTx);

    // Get transaction detail for issuer info
    try {
      const detail = await callShopeeDetailAPI(
        matchedTx.displayTransactionId || matchedTx.transactionId,
        token
      );
      if (detail && detail.code === 0 && detail.data) {
        formatted.issuer = detail.data.issuer;
      }
    } catch (detailErr) {
      logEvent(
        'WARN',
        'Gagal mengambil detail transaksi ' +
          matchedTx.transactionId +
          ': ' +
          detailErr.message
      );
    }

    logEvent(
      'INFO',
      'Pembayaran terverifikasi lunas via ' +
        (formatted.issuer || 'ShopeePay/QRIS') +
        '.'
    );

    res.json({
      success: true,
      paid: true,
      transaction: {
        transactionId:
          matchedTx.transactionId || matchedTx.displayTransactionId,
        amount: formatted.amount,
        status: formatted.status,
        time: formatted.time,
        issuer: formatted.issuer || 'QRIS / ShopeePay',
      },
    });
  } catch (err) {
    logEvent(
      'ERROR',
      'Pengecekan gagal karena exception: ' + err.message
    );
    res.status(500).json({ success: false, error: err.message });
  }
});

// View Logs
app.get('/api/logs', apiKeyMiddleware, (req, res) => {
  res.json({ success: true, data: { logs } });
});

// Root
app.get('/', (req, res) => {
  res.send('Shoppe API Running');
});

// Start Server
app.listen(PORT, () => {
  console.log(
    'ShopeePay API (express) running at http://localhost:' + PORT
  );
  console.log('Endpoints:');
  console.log(
    '  POST /update-token       - Update ShopeeToken'
  );
  console.log(
    '  GET  /token-status       - Check ShopeeToken Validity status'
  );
  console.log(
    '  POST /create-qris        - Generate Dynamic QRIS from static template'
  );
  console.log(
    '  GET  /qr/:id             - Fetch Dynamic QRIS Image Redirect'
  );
  console.log(
    '  GET  /transactions       - Fetch transactions list'
  );
  console.log(
    '  GET  /transactions/all   - Fetch all transactions of the month'
  );
  console.log(
    '  POST /check-payment      - Stateless payment verification'
  );
  console.log(
    '  GET  /api/logs           - View recent logs'
  );

  if (shopeeToken && apiKey) {
    startTokenChecker();
  } else {
    console.warn(
      'WARNING: SHOPEE_TOKEN and API_KEY must be set in .env to run checks.'
    );
  }
});
