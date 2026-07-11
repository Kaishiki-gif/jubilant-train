// LINE 韻トレーニングBot(ラップの韻の練習用)サーバー
//
// 役割:
//   1. 友だち追加(follow)/解除(unfollow)を検知して users.json を更新
//   2. 毎日 9:00 (Asia/Tokyo) に「お題」の単語を全ユーザーに送信(node-cronで自前実行)
//   3. リッチメニューの「お題を受け取る」ボタン(= トリガーメッセージ)で、いつでも自分だけ新しいお題を受け取れる
//   4. ユーザーが単語を送るたびに、お題の単語と韻を踏んでいるか(母音の一致)を判定して返信
//      ○: 母音が完全一致 → カウント+1、リストに追加
//      △: お題の母音の後半部分と一致 → カウントなし、リストに追加
//      ×: 不一致 → カウントなし、リストにも追加しない
//      ○が4つ貯まったら結果リストを表示してそのラウンドは終了
//
// 単語の読み(ひらがな/カタカナ)には kuromoji による形態素解析を使用しているため、
// 未知語・固有名詞などは読みが不正確になる場合があります。

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const kuromoji = require('kuromoji');
const { middleware, Client } = require('@line/bot-sdk');
const { extractVowels, judge } = require('./kana');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const USERS_FILE = path.join(__dirname, 'users.json');
const THEME_WORDS_FILE = path.join(__dirname, 'theme-words.json');
const DAILY_STATE_FILE = path.join(__dirname, 'daily-state.json');
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const RESULTS_LOG_FILE = path.join(__dirname, 'results-log.json');
const USERS_API_SECRET = process.env.USERS_API_SECRET;

const RICHMENU_IMAGE_PATH = path.join(__dirname, 'richmenu.png');
const RICHMENU_NAME = 'rhyme-theme-menu';
// リッチメニューのボタンをタップすると、このテキストがメッセージとして送られてくる
const THEME_TRIGGER_TEXT = '今日のお題を受け取る';
const REQUIRED_COUNT = 4;

if (!config.channelAccessToken || !config.channelSecret) {
  console.warn('警告: LINE_CHANNEL_ACCESS_TOKEN / LINE_CHANNEL_SECRET が未設定です。.env を確認してください。');
}
if (!USERS_API_SECRET) {
  console.warn('警告: USERS_API_SECRET が未設定です。管理用エンドポイントが保護されません。');
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

function loadThemeWords() {
  return loadJSON(THEME_WORDS_FILE, []);
}

function loadSessions() {
  return loadJSON(SESSIONS_FILE, {});
}
function saveSessions(sessions) {
  saveJSON(SESSIONS_FILE, sessions);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// --- kuromoji: 単語の読み(カタカナ)を取得 ---
const tokenizerPromise = new Promise((resolve, reject) => {
  kuromoji.builder({ dicPath: path.join(__dirname, 'node_modules/kuromoji/dict') }).build((err, tokenizer) => {
    if (err) {
      console.error('kuromoji の初期化に失敗しました:', err);
      reject(err);
    } else {
      console.log('kuromoji の初期化が完了しました');
      resolve(tokenizer);
    }
  });
});

async function getReadingKatakana(text) {
  const tokenizer = await tokenizerPromise;
  const tokens = tokenizer.tokenize(text);
  return tokens.map((t) => t.reading || t.surface_form).join('');
}

// --- お題(テーマ単語)のローテーション ---
// 「今日の一問」用: 全ユーザー共通で、使い切るまで重複しないようにシャッフルしながら選ぶ
function pickDailyThemeWord() {
  const words = loadThemeWords();
  if (words.length === 0) return null;

  let state = loadJSON(DAILY_STATE_FILE, null);
  if (!state || !Array.isArray(state.order) || state.pointer >= state.order.length) {
    state = { order: shuffle(words.map((_, i) => i)), pointer: 0 };
  }
  const idx = state.order[state.pointer];
  state.pointer += 1;
  saveJSON(DAILY_STATE_FILE, state);
  return words[idx];
}

// 「いつでもボタン」用: ランダムに1つ選ぶ(直前と同じ単語は避ける)
function pickRandomThemeWord(excludeWord) {
  const words = loadThemeWords();
  if (words.length === 0) return null;
  const candidates = words.filter((w) => w.word !== excludeWord);
  const pool = candidates.length > 0 ? candidates : words;
  return pool[Math.floor(Math.random() * pool.length)];
}

function newSessionWithTheme(theme) {
  return { theme, count: 0, list: [], startedAt: new Date().toISOString() };
}

function formatThemeMessage(theme) {
  return (
    `【今日のお題】\n${theme.word}(${theme.reading}) / 母音: ${theme.vowels}\n\n` +
    `この単語と韻を踏む単語を、${REQUIRED_COUNT}つ送ってください！\n` +
    `(母音が完全に一致で○、後半だけ一致で△です)`
  );
}

function formatJudgmentMessage(session, userWord, userReadingHiragana, userVowels, mark) {
  const theme = session.theme;
  const markLabel = mark === '○' ? '○ 韻が成立しました！' : mark === '△' ? '△ 惜しい、後半だけ韻が一致しました' : '× 韻が成立しませんでした';
  const lines = [
    markLabel,
    '',
    `あなたの単語: ${userWord}(${userReadingHiragana}) 母音: ${userVowels || 'なし'}`,
    `お題: ${theme.word}(${theme.reading}) 母音: ${theme.vowels}`,
    '',
    `カウント: ${session.count}/${REQUIRED_COUNT}`,
  ];
  if (session.count < REQUIRED_COUNT) {
    lines.push('次の単語をどうぞ！');
  }
  return lines.join('\n');
}

function formatResultMessage(session) {
  const lines = [`🎉 ${REQUIRED_COUNT}つ達成！お疲れさまでした`, '', '【結果リスト】'];
  session.list.forEach((entry, i) => {
    lines.push(`${i + 1}. ${entry.mark} ${session.theme.word} → ${entry.userWord}`);
  });
  lines.push('', 'リッチメニューの「お題を受け取る」から、またいつでも挑戦できます！');
  return lines.join('\n');
}

// ラウンド終了時に、結果リストを results-log.json に集約保存する(管理者が /results で閲覧できる)
async function appendResultLog(userId, session) {
  const log = loadJSON(RESULTS_LOG_FILE, []);
  let displayName = userId;
  try {
    const profile = await client.getProfile(userId);
    displayName = profile.displayName || userId;
  } catch (e) {
    // プロフィール取得に失敗しても記録は続ける(表示名の代わりにuserIdを使う)
  }
  log.push({
    userId,
    displayName,
    theme: session.theme,
    list: session.list,
    completedAt: new Date().toISOString(),
  });
  saveJSON(RESULTS_LOG_FILE, log);
}

// --- 毎日 9:00 (Asia/Tokyo) に全ユーザーへお題を配信 ---
async function sendDailyThemeToAll() {
  const theme = pickDailyThemeWord();
  if (!theme) {
    console.error('theme-words.json が空です。');
    return { ok: false, reason: 'no theme words' };
  }
  const users = loadUsers();
  if (users.length === 0) {
    console.log('登録ユーザーがいません。送信をスキップしました。');
    return { ok: false, reason: 'no users' };
  }

  const sessions = loadSessions();
  const results = [];
  for (const userId of users) {
    sessions[userId] = newSessionWithTheme(theme);
    try {
      await client.pushMessage(userId, { type: 'text', text: formatThemeMessage(theme) });
      results.push({ userId, ok: true });
    } catch (err) {
      const detail = (err && err.originalError && err.originalError.response && err.originalError.response.data) || err.message;
      results.push({ userId, ok: false, error: detail });
      console.error(`送信失敗 (${userId}):`, detail);
    }
  }
  saveSessions(sessions);
  return { ok: true, theme, results };
}

cron.schedule(
  '0 9 * * *',
  () => {
    console.log('毎日9時のお題配信を開始します');
    sendDailyThemeToAll();
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
      text:
        '友だち追加ありがとうございます！\n' +
        'これはラップの韻トレーニングBotです。\n' +
        '毎朝9時にお題の単語をお届けします。下のメニューの「お題を受け取る」からも、いつでもすぐに挑戦できます。',
    });
  }

  if (event.type === 'unfollow') {
    const userId = event.source.userId;
    saveUsers(loadUsers().filter((id) => id !== userId));
    console.log(`友だち解除: ${userId}`);
    return null;
  }

  if (event.type === 'message' && event.message && event.message.type === 'text') {
    const userId = event.source.userId;
    const text = event.message.text.trim();

    if (text === THEME_TRIGGER_TEXT) {
      const sessions = loadSessions();
      const prevWord = sessions[userId] && sessions[userId].theme ? sessions[userId].theme.word : null;
      const theme = pickRandomThemeWord(prevWord);
      if (!theme) {
        return client.replyMessage(event.replyToken, { type: 'text', text: 'お題データが見つかりませんでした。' });
      }
      sessions[userId] = newSessionWithTheme(theme);
      saveSessions(sessions);
      return client.replyMessage(event.replyToken, { type: 'text', text: formatThemeMessage(theme) });
    }

    // トリガー以外のテキストは「単語での回答」として判定する
    const sessions = loadSessions();
    const session = sessions[userId];
    if (!session || !session.theme) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'まずはリッチメニューの「お題を受け取る」から始めてください！',
      });
    }

    // お題と全く同じ単語は禁止(判定すら行わず即座に却下し、カウント・リストには一切影響しない)
    if (text === session.theme.word) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text:
          `「${text}」はお題と同じ単語なので使えません。\n` +
          `別の単語を送ってください。\n(カウント: ${session.count}/${REQUIRED_COUNT})`,
      });
    }

    let userReadingKatakana;
    try {
      userReadingKatakana = await getReadingKatakana(text);
    } catch (err) {
      console.error('読み推定エラー:', err);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '単語の読みをうまく判定できませんでした。ひらがなで送ってみてください。',
      });
    }
    const userReadingHiragana = userReadingKatakana.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
    const userVowels = extractVowels(userReadingKatakana);
    const mark = judge(userVowels, session.theme.vowels);

    if (mark === '○') {
      session.count += 1;
      session.list.push({ mark, userWord: text, userReading: userReadingHiragana });
    } else if (mark === '△') {
      session.list.push({ mark, userWord: text, userReading: userReadingHiragana });
    }

    let replyText;
    if (session.count >= REQUIRED_COUNT) {
      replyText = formatJudgmentMessage(session, text, userReadingHiragana, userVowels, mark) + '\n\n' + formatResultMessage(session);
      await appendResultLog(userId, session);
      delete sessions[userId]; // ラウンド終了、セッションをクリア
    } else {
      replyText = formatJudgmentMessage(session, text, userReadingHiragana, userVowels, mark);
      sessions[userId] = session;
    }
    saveSessions(sessions);

    return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
  }

  return null;
}

// --- リッチメニュー(チャット下部の呼び出しボタン)のセットアップ ---
app.get('/setup-richmenu', async (req, res) => {
  if (!USERS_API_SECRET || req.query.token !== USERS_API_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const existing = await client.getRichMenuList();
    for (const menu of existing) {
      if (menu.name === RICHMENU_NAME || menu.name === 'daily-word-menu') {
        await client.deleteRichMenu(menu.richMenuId);
        console.log(`古いリッチメニューを削除: ${menu.richMenuId}`);
      }
    }

    const richMenuId = await client.createRichMenu({
      size: { width: 2500, height: 843 },
      selected: true,
      name: RICHMENU_NAME,
      chatBarText: 'お題を受け取る',
      areas: [
        {
          bounds: { x: 0, y: 0, width: 2500, height: 843 },
          action: { type: 'message', label: 'お題を受け取る', text: THEME_TRIGGER_TEXT },
        },
      ],
    });

    const imageBuffer = fs.readFileSync(RICHMENU_IMAGE_PATH);
    await client.setRichMenuImage(richMenuId, imageBuffer, 'image/png');
    await client.setDefaultRichMenu(richMenuId);

    console.log(`リッチメニューを設定しました: ${richMenuId}`);
    res.json({ ok: true, richMenuId });
  } catch (err) {
    const detail = (err && err.originalError && err.originalError.response && err.originalError.response.data) || err.message;
    console.error('リッチメニュー設定エラー:', detail);
    res.status(500).json({ ok: false, error: detail });
  }
});

// --- 動作確認用エンドポイント(?token=USERS_API_SECRET で保護) ---
app.get('/users', (req, res) => {
  if (!USERS_API_SECRET || req.query.token !== USERS_API_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ users: loadUsers() });
});

app.post('/send-daily-theme', async (req, res) => {
  if (!USERS_API_SECRET || req.query.token !== USERS_API_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const result = await sendDailyThemeToAll();
  res.json(result);
});

// みんなの「4つ達成」結果を一覧で見られるページ(スマホのブラウザでもOK)
app.get('/results', (req, res) => {
  if (!USERS_API_SECRET || req.query.token !== USERS_API_SECRET) {
    return res.status(403).send('forbidden');
  }
  const log = loadJSON(RESULTS_LOG_FILE, []);
  const cards = [...log]
    .reverse()
    .map((entry) => {
      const date = new Date(entry.completedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const items = entry.list
        .map((item) => `<li>${item.mark} ${entry.theme.word} → ${item.userWord}</li>`)
        .join('');
      return `
        <div class="card">
          <div class="meta">${date} ・ ${entry.displayName}</div>
          <div class="theme">お題: ${entry.theme.word}(${entry.theme.reading}) / 母音: ${entry.theme.vowels}</div>
          <ul>${items}</ul>
        </div>`;
    })
    .join('');

  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>韻トレ結果一覧</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif; background:#f2f2f5; margin:0; padding:16px; color:#222; }
  h1 { font-size:20px; margin-bottom:16px; }
  .card { background:#fff; border-radius:12px; padding:14px 16px; margin-bottom:12px; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
  .meta { font-size:12px; color:#888; margin-bottom:4px; }
  .theme { font-weight:bold; margin-bottom:6px; }
  ul { margin:0; padding-left:20px; }
  li { margin:2px 0; }
  .empty { color:#888; text-align:center; margin-top:40px; }
</style>
</head>
<body>
  <h1>韻トレ結果一覧(${log.length}件)</h1>
  ${log.length === 0 ? '<div class="empty">まだ結果がありません</div>' : cards}
</body>
</html>`);
});

app.get('/', (req, res) => {
  res.send('LINE 韻トレーニングBot サーバーは稼働中です。');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});
