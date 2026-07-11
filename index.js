// LINE 日本語単語Bot サーバー
//
// 役割:
//   1. 友だち追加(follow)イベントを受け取り、userId を users.json に保存
//   2. 友だち解除(unfollow)イベントを受け取り、users.json から削除
//   3. 毎日 9:00 (Asia/Tokyo) に、words.json から単語を1つ選び、
//      登録済み全ユーザーに個別 push メッセージを送信(node-cronで自前実行)
//   4. GET /users, POST /test-send は動作確認用(トークンで保護)
//
// 注意: LINE の仕様上、ユーザーが公式アカウントを友だち追加すると
// 自動的に Bot とその人だけの 1:1 トークルームが作られるため、
// ルーム作成のための特別な実装は不要。

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { middleware, Client } = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const USERS_FILE = path.join(__dirname, 'users.json');
const WORDS_FILE = path.join(__dirname, 'words.json');
const STATE_FILE = path.join(__dirname, 'state.json');
const USERS_API_SECRET = process.env.USERS_API_SECRET;

if (!config.channelAccessToken || !config.channelSecret) {
  console.warn('警告: LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET が未設定です。.env を確認してください。');
}
if (!USERS_API_SECRET) {
  console.warn('警告: USERS_API_SECRET が未設定です。/users, /test-send が保護されません。');
}

const client = new Client(config);
const app = express();

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadUsers() {
  return loadJSON(USERS_FILE, []);
}
function saveUsers(users) {
  saveJSON(USERS_FILE, users);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// words.json を順番が偏らないようにシャッフルしながら1つずつ選ぶ
// (全部使い切ったら再シャッフルして繰り返す = 連続で同じ単語が出にくい)
function pickNextWord() {
  const words = loadJSON(WORDS_FILE, []);
  if (words.length === 0) return null;

  let state = loadJSON(STATE_FILE, null);
  if (!state || !Array.isArray(state.order) || state.pointer >= state.order.length) {
    state = { order: shuffle(words.map((_, i) => i)), pointer: 0 };
  }
  const idx = state.order[state.pointer];
  state.pointer += 1;
  saveJSON(STATE_FILE, state);
  return words[idx];
}

function formatMessage(word) {
  return `【今日の単語】\n${word.word}(${word.reading})\n\n意味: ${word.meaning}\n\n例文: ${word.example}`;
}

async function sendDailyWord() {
  const word = pickNextWord();
  if (!word) {
    console.error('words.json が空です。単語データを確認してください。');
    return { ok: false, reason: 'no words' };
  }

  const users = loadUsers();
  if (users.length === 0) {
    console.log('登録ユーザーがいません。送信をスキップしました。');
    return { ok: false, reason: 'no users' };
  }

  const text = formatMessage(word);
  const results = [];
  for (const userId of users) {
    try {
      await client.pushMessage(userId, { type: 'text', text });
      results.push({ userId, ok: true });
      console.log(`送信成功: ${userId}`);
    } catch (err) {
      const detail = (err && err.originalError && err.originalError.response && err.originalError.response.data) || err.message;
      results.push({ userId, ok: false, error: detail });
      console.error(`送信失敗 (${userId}):`, detail);
    }
  }
  return { ok: true, word, results };
}

// 毎日 9:00 (Asia/Tokyo) に自動実行
cron.schedule(
  '0 9 * * *',
  () => {
    console.log('毎日9時の一斉送信を開始します');
    sendDailyWord();
  },
  { timezone: 'Asia/Tokyo' }
);

// --- LINE Webhook ---
app.post('/webhook', middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook処理エラー:', err);
    res.sendStatus(200); // LINE 側の再送を避けるため200を返す
  }
});

async function handleEvent(event) {
  if (event.type === 'follow') {
    const userId = event.source.userId;
    const users = loadUsers();
    if (!users.includes(userId)) {
      users.push(userId);
      saveUsers(users);
      console.log(`新しい友だち登録: ${userId}`);
    }
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '友だち追加ありがとうございます！\n毎朝9時に日本語の単語をお届けします。',
    });
  }

  if (event.type === 'unfollow') {
    const userId = event.source.userId;
    saveUsers(loadUsers().filter((id) => id !== userId));
    console.log(`友だち解除: ${userId}`);
  }

  return null;
}

// --- 動作確認用エンドポイント(?token=USERS_API_SECRET で保護) ---
app.get('/users', (req, res) => {
  if (!USERS_API_SECRET || req.query.token !== USERS_API_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ users: loadUsers() });
});

app.post('/test-send', async (req, res) => {
  if (!USERS_API_SECRET || req.query.token !== USERS_API_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const result = await sendDailyWord();
  res.json(result);
});

app.get('/', (req, res) => {
  res.send('LINE 日本語単語Bot サーバーは稼働中です。');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});
