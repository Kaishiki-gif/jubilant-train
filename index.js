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
//   5. リッチメニューの「韻リストを見る」で、母音ごとにまとめた自分の韻リストをFlex Messageで確認できる
//      (お題として出た単語は太字、重複は1つにまとめる)
//   6. 奇数日の17時に「韻テスト」を配信。自分の韻リストの中から母音グループを1つランダムに選び、
//      そのお題を表示。お題以外の単語をすべて思い出して送るまで終わらない(○/×判定)。
//   7. お題ゲーム・韻テストともに、最初の回答から30秒経過すると自動的に締め切る。
//      締め切り後は roundId で照合し、次のラウンドに古い締め切り処理が誤って干渉しないようにしている。
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
const { loadData, saveData, deleteData, hasUpstash } = require('./storage');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// 永続データ(Upstash Redisのキー名 / フォールバック時はローカルファイル名)
const USERS_KEY = 'users';
const DAILY_STATE_KEY = 'daily-state';
const RESULTS_LOG_KEY = 'results-log';

// セッションはユーザーごとに別々のキーに保存する(全員分を1つのオブジェクトにまとめると、
// 複数の処理が同時に走ったときに読み込み→書き込みの間に他ユーザーの更新が上書きされてしまうため)
function sessionKey(userId) {
  return `session:${userId}`;
}
function testSessionKey(userId) {
  return `test-session:${userId}`;
}

// theme-words.json はコードと一緒にデプロイされる静的な参照データなので、ローカルファイルのままでよい
const THEME_WORDS_FILE = path.join(__dirname, 'theme-words.json');
const USERS_API_SECRET = process.env.USERS_API_SECRET;

if (!hasUpstash) {
  console.warn('警告: Upstash未設定のため、デプロイのたびに友だちリスト・結果が消える可能性があります。');
}

const RICHMENU_IMAGE_PATH = path.join(__dirname, 'richmenu.png');
const RICHMENU_NAME = 'rhyme-theme-menu-v2';
// リッチメニューのボタンをタップすると、このテキストがメッセージとして送られてくる
const THEME_TRIGGER_TEXT = '今日のお題を受け取る';
const RHYME_LIST_TRIGGER_TEXT = '韻リストを見る';
const REQUIRED_COUNT = 4;
const MAX_RHYME_GROUPS = 30; // Flexメッセージが大きくなりすぎないようにする上限
const ANSWER_TIME_LIMIT_MS = 30 * 1000; // お題ゲーム・韻テスト共通の制限時間(最初の回答から30秒)

// 制限時間タイマー(Node プロセスのメモリ上で管理。userId -> setTimeout のハンドル)。
// サーバーが再起動するとタイマー自体は失われるが、その場合でも次にユーザーがメッセージを送った際に
// deadline を過ぎているかその場でチェックして締め切る(保険)。
const activeThemeTimers = new Map();
const activeTestTimers = new Map();

function clearThemeTimer(userId) {
  const t = activeThemeTimers.get(userId);
  if (t) {
    clearTimeout(t);
    activeThemeTimers.delete(userId);
  }
}
function clearTestTimer(userId) {
  const t = activeTestTimers.get(userId);
  if (t) {
    clearTimeout(t);
    activeTestTimers.delete(userId);
  }
}

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

async function loadUsers() {
  return loadData(USERS_KEY, []);
}
async function saveUsers(users) {
  return saveData(USERS_KEY, users);
}

function loadThemeWords() {
  return loadJSON(THEME_WORDS_FILE, []);
}

async function loadSession(userId) {
  return loadData(sessionKey(userId), null);
}
async function saveSession(userId, session) {
  return saveData(sessionKey(userId), session);
}
async function clearSession(userId) {
  return deleteData(sessionKey(userId));
}

async function loadTestSession(userId) {
  return loadData(testSessionKey(userId), null);
}
async function saveTestSession(userId, testSession) {
  return saveData(testSessionKey(userId), testSession);
}
async function clearTestSession(userId) {
  return deleteData(testSessionKey(userId));
}

// Asia/Tokyo での「今日は何日か」を取得する(奇数日判定用)
function getJstDayOfMonth() {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', day: 'numeric' });
  return parseInt(fmt.format(new Date()), 10);
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
async function pickDailyThemeWord() {
  const words = loadThemeWords();
  if (words.length === 0) return null;

  let state = await loadData(DAILY_STATE_KEY, null);
  if (!state || !Array.isArray(state.order) || state.pointer >= state.order.length) {
    state = { order: shuffle(words.map((_, i) => i)), pointer: 0 };
  }
  const idx = state.order[state.pointer];
  state.pointer += 1;
  await saveData(DAILY_STATE_KEY, state);
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

function makeRoundId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function newSessionWithTheme(theme) {
  // usedWords: このラウンドで既に使った単語(お題自身も含む)。同じ単語の使い回しを防ぐ。
  // roundId: このラウンド固有のID。制限時間タイマーが、既に終わった/切り替わった別のラウンドを
  //          誤って締め切ってしまわないようにするための照合用。
  // deadline: 最初の回答があった時刻から30秒後のタイムスタンプ(まだ未回答ならnull)。
  return {
    theme,
    count: 0,
    list: [],
    usedWords: [theme.word],
    startedAt: new Date().toISOString(),
    roundId: makeRoundId(),
    deadline: null,
  };
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

// 制限時間(30秒)になったときのお題ゲームの締め切りメッセージ
function formatTimeUpThemeMessage(session) {
  const lines = [`⏰ 制限時間になりました`, '', `お題: ${session.theme.word}(${session.theme.reading})`, ''];
  if (session.list.length > 0) {
    lines.push('【この回で答えられたもの】');
    session.list.forEach((entry, i) => {
      lines.push(`${i + 1}. ${entry.mark} ${session.theme.word} → ${entry.userWord}`);
    });
  } else {
    lines.push('今回は1つも答えられませんでした。');
  }
  lines.push('', `カウント: ${session.count}/${REQUIRED_COUNT}`);
  lines.push('', 'リッチメニューの「お題を受け取る」から、またいつでも挑戦できます！');
  return lines.join('\n');
}

// お題ゲームの制限時間タイマーを(再)セットする。同じユーザーの古いタイマーがあれば先にキャンセルする。
function scheduleThemeTimeout(userId, roundId) {
  clearThemeTimer(userId);
  const timer = setTimeout(() => {
    finalizeThemeRoundByTimeout(userId, roundId);
  }, ANSWER_TIME_LIMIT_MS);
  activeThemeTimers.set(userId, timer);
}

// 制限時間経過でお題ゲームを締め切る。roundId が一致する場合のみ実行する
// (すでに完了・切り替わった別のラウンドを誤って締め切らないようにするため)。
async function finalizeThemeRoundByTimeout(userId, roundId) {
  activeThemeTimers.delete(userId);
  const session = await loadSession(userId);
  if (!session || !session.theme || session.roundId !== roundId) {
    return; // 既に終了しているか、別のラウンドに切り替わっている
  }
  const replyText = formatTimeUpThemeMessage(session);
  await appendResultLog(userId, session); // 締め切りまでに答えられた分をリストに記録する
  await clearSession(userId);
  try {
    await client.pushMessage(userId, { type: 'text', text: replyText });
  } catch (err) {
    console.error(`お題ゲームの締め切り通知に失敗 (${userId}):`, err.message);
  }
}

// ラウンド終了時に、結果リストを results-log に集約保存する(管理者が /results で閲覧できる)
async function appendResultLog(userId, session) {
  const log = await loadData(RESULTS_LOG_KEY, []);
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
  await saveData(RESULTS_LOG_KEY, log);
}

// --- ユーザーごとの「韻リスト」(母音ごとにまとめた単語一覧) ---
// お題の単語(太字扱い)と、これまで判定された(○/△)単語を、母音の文字列ごとにグルーピングする。
// 同じ母音グループ内で同じ単語が重複する場合は1つにまとめ、お題として出た単語は太字を優先する。
async function buildRhymeGroups(userId) {
  const groups = new Map(); // vowels -> Map<word, isTheme>

  function addWord(vowels, word, isTheme) {
    if (!vowels || !word) return;
    if (!groups.has(vowels)) groups.set(vowels, new Map());
    const wordMap = groups.get(vowels);
    const existing = wordMap.get(word) || false;
    wordMap.set(word, existing || isTheme);
  }

  function addRound(theme, list) {
    if (theme) addWord(theme.vowels, theme.word, true);
    for (const entry of list || []) {
      const vowels = entry.vowels || extractVowels(entry.userReading || '');
      addWord(vowels, entry.userWord, false);
    }
  }

  const log = await loadData(RESULTS_LOG_KEY, []);
  for (const entry of log) {
    if (entry.userId === userId) {
      addRound(entry.theme, entry.list);
    }
  }

  // 現在進行中のラウンド(まだ4つ達成していない)の分も含める
  const currentSession = await loadSession(userId);
  if (currentSession && currentSession.theme) {
    addRound(currentSession.theme, currentSession.list);
  }

  return groups;
}

// 韻リストをLINEのFlex Message(お題の単語だけ太字で表示できる)に組み立てる
function buildRhymeListFlexMessage(groups) {
  const vowelKeys = Array.from(groups.keys()).sort();
  const limitedKeys = vowelKeys.slice(0, MAX_RHYME_GROUPS);

  const bodyContents = limitedKeys.map((vowels) => {
    const wordMap = groups.get(vowels);
    const words = Array.from(wordMap.entries()); // [word, isTheme][]
    const spans = words.map(([word, isTheme], i) => ({
      type: 'span',
      text: i < words.length - 1 ? `${word}、` : word,
      weight: isTheme ? 'bold' : 'regular',
    }));
    return {
      type: 'box',
      layout: 'vertical',
      margin: 'lg',
      contents: [
        { type: 'text', text: `母音: ${vowels}`, weight: 'bold', size: 'sm', color: '#7B61FF' },
        { type: 'text', wrap: true, size: 'sm', margin: 'xs', contents: spans },
      ],
    };
  });

  const omittedNote =
    vowelKeys.length > MAX_RHYME_GROUPS
      ? [{ type: 'text', text: `(他 ${vowelKeys.length - MAX_RHYME_GROUPS} グループは省略)`, size: 'xs', color: '#aaaaaa', margin: 'md' }]
      : [];

  return {
    type: 'flex',
    altText: '韻リスト',
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📖 あなたの韻リスト', weight: 'bold', size: 'md' },
          { type: 'text', text: '太字はお題として出た単語です', size: 'xs', color: '#aaaaaa', margin: 'sm' },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents:
          bodyContents.length > 0
            ? [...bodyContents, ...omittedNote]
            : [{ type: 'text', text: 'まだ記録がありません。お題に挑戦してみましょう！', wrap: true, color: '#888888' }],
      },
    },
  };
}

// --- 奇数日の17時に送る「韻テスト」(自分の韻リストからの復習クイズ) ---
// お題(太字)とそれ以外の単語がどちらも存在する母音グループの中からランダムに1つ選び、
// そのグループのお題をランダムに表示、お題以外の単語をすべて思い出せるまでテストする。
async function pickRhymeTestForUser(userId) {
  const groups = await buildRhymeGroups(userId);
  const eligible = [];
  for (const [vowels, wordMap] of groups) {
    const themeWords = [];
    const nonThemeWords = [];
    for (const [word, isTheme] of wordMap) {
      if (isTheme) themeWords.push(word);
      else nonThemeWords.push(word);
    }
    if (themeWords.length > 0 && nonThemeWords.length > 0) {
      eligible.push({ vowels, themeWords, nonThemeWords });
    }
  }
  if (eligible.length === 0) return null;

  const chosen = eligible[Math.floor(Math.random() * eligible.length)];
  const themeWord = chosen.themeWords[Math.floor(Math.random() * chosen.themeWords.length)];
  return { vowels: chosen.vowels, themeWord, nonThemeWords: chosen.nonThemeWords };
}

function formatRhymeTestMessage(testSession) {
  return (
    `【韻テスト】\n` +
    `お題: ${testSession.themeWord}(母音: ${testSession.vowels})\n\n` +
    `この母音の韻が、お題を除いてあと${testSession.remaining.length}個あります。\n` +
    `思い出して送ってください！`
  );
}

// 制限時間(30秒)になったときの韻テストの締め切りメッセージ(答えられた/答えられなかったものを表示)
function formatTimeUpTestMessage(testSession) {
  const lines = [`⏰ 制限時間になりました`, '', `お題: ${testSession.themeWord}(母音: ${testSession.vowels})`, ''];
  lines.push('【答えられたもの】');
  if (testSession.recalled.length > 0) {
    testSession.recalled.forEach((w, i) => lines.push(`${i + 1}. ○ ${w}`));
  } else {
    lines.push('(なし)');
  }
  lines.push('', '【答えられなかったもの】');
  if (testSession.remaining.length > 0) {
    testSession.remaining.forEach((w, i) => lines.push(`${i + 1}. × ${w}`));
  } else {
    lines.push('(なし)');
  }
  return lines.join('\n');
}

// 韻テストの制限時間タイマーを(再)セットする
function scheduleTestTimeout(userId, roundId) {
  clearTestTimer(userId);
  const timer = setTimeout(() => {
    finalizeTestByTimeout(userId, roundId);
  }, ANSWER_TIME_LIMIT_MS);
  activeTestTimers.set(userId, timer);
}

// 制限時間経過で韻テストを締め切る。roundId が一致する場合のみ実行する。
async function finalizeTestByTimeout(userId, roundId) {
  activeTestTimers.delete(userId);
  const testSession = await loadTestSession(userId);
  if (!testSession || testSession.roundId !== roundId) {
    return; // 既に終了しているか、別のラウンドに切り替わっている
  }
  const replyText = formatTimeUpTestMessage(testSession);
  await clearTestSession(userId);
  try {
    await client.pushMessage(userId, { type: 'text', text: replyText });
  } catch (err) {
    console.error(`韻テストの締め切り通知に失敗 (${userId}):`, err.message);
  }
}

async function sendRhymeTestToAll() {
  const users = await loadUsers();
  if (users.length === 0) {
    console.log('登録ユーザーがいません。韻テストの送信をスキップしました。');
    return { ok: false, reason: 'no users' };
  }

  const results = [];
  for (const userId of users) {
    const picked = await pickRhymeTestForUser(userId);
    if (!picked) {
      console.log(`韻テスト対象なし (${userId}): お題以外の単語がある母音グループがまだありません`);
      results.push({ userId, ok: false, reason: 'no eligible rhyme group' });
      continue;
    }
    clearTestTimer(userId); // 前回分のタイマーが残っていれば念のためキャンセルする
    const testSession = {
      vowels: picked.vowels,
      themeWord: picked.themeWord,
      remaining: shuffle(picked.nonThemeWords),
      total: picked.nonThemeWords.length,
      recalled: [],
      startedAt: new Date().toISOString(),
      roundId: makeRoundId(),
      deadline: null,
    };
    await saveTestSession(userId, testSession);
    try {
      await client.pushMessage(userId, { type: 'text', text: formatRhymeTestMessage(testSession) });
      results.push({ userId, ok: true });
    } catch (err) {
      const detail = (err && err.originalError && err.originalError.response && err.originalError.response.data) || err.message;
      results.push({ userId, ok: false, error: detail });
      console.error(`韻テスト送信失敗 (${userId}):`, detail);
    }
  }
  return { ok: true, results };
}

// --- 毎日 9:00 (Asia/Tokyo) に全ユーザーへお題を配信 ---
async function sendDailyThemeToAll() {
  const theme = await pickDailyThemeWord();
  if (!theme) {
    console.error('theme-words.json が空です。');
    return { ok: false, reason: 'no theme words' };
  }
  const users = await loadUsers();
  if (users.length === 0) {
    console.log('登録ユーザーがいません。送信をスキップしました。');
    return { ok: false, reason: 'no users' };
  }

  const results = [];
  for (const userId of users) {
    clearThemeTimer(userId); // 前回分のタイマーが残っていれば念のためキャンセルする
    // 放置されたままの韻テストが残っていると、次に送る単語がそちらの判定に横取りされてしまうため、
    // 新しいお題を配信するタイミングで韻テストも片付けておく
    clearTestTimer(userId);
    await clearTestSession(userId);
    await saveSession(userId, newSessionWithTheme(theme));
    try {
      await client.pushMessage(userId, { type: 'text', text: formatThemeMessage(theme) });
      results.push({ userId, ok: true });
    } catch (err) {
      const detail = (err && err.originalError && err.originalError.response && err.originalError.response.data) || err.message;
      results.push({ userId, ok: false, error: detail });
      console.error(`送信失敗 (${userId}):`, detail);
    }
  }
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

// 奇数日の17時だけ、韻テストを配信する
cron.schedule(
  '0 17 * * *',
  () => {
    const day = getJstDayOfMonth();
    if (day % 2 === 1) {
      console.log(`奇数日(${day}日)の17時、韻テストを配信します`);
      sendRhymeTestToAll();
    } else {
      console.log(`偶数日(${day}日)の17時なので韻テストの配信はスキップします`);
    }
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
    const users = await loadUsers();
    if (!users.includes(userId)) {
      users.push(userId);
      await saveUsers(users);
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
    const users = await loadUsers();
    await saveUsers(users.filter((id) => id !== userId));
    console.log(`友だち解除: ${userId}`);
    return null;
  }

  if (event.type === 'message' && event.message && event.message.type === 'text') {
    const userId = event.source.userId;
    const text = event.message.text.trim();
    console.log(`メッセージ受信 (${userId}): "${text}"`);

    if (text === THEME_TRIGGER_TEXT) {
      const prevSession = await loadSession(userId);
      const prevWord = prevSession && prevSession.theme ? prevSession.theme.word : null;
      const theme = pickRandomThemeWord(prevWord);
      if (!theme) {
        return client.replyMessage(event.replyToken, { type: 'text', text: 'お題データが見つかりませんでした。' });
      }
      clearThemeTimer(userId); // 前のラウンドのタイマーが残っていれば念のためキャンセルする
      // 放置されたままの韻テストが残っていると、次に送る単語がそちらの判定に横取りされてしまうため、
      // 新しいお題を受け取るタイミングで韻テストも片付けておく
      clearTestTimer(userId);
      await clearTestSession(userId);
      await saveSession(userId, newSessionWithTheme(theme));
      return client.replyMessage(event.replyToken, { type: 'text', text: formatThemeMessage(theme) });
    }

    if (text === RHYME_LIST_TRIGGER_TEXT) {
      const groups = await buildRhymeGroups(userId);
      return client.replyMessage(event.replyToken, buildRhymeListFlexMessage(groups));
    }

    // 韻テスト(奇数日17時に配信)が進行中なら、そちらを優先して判定する。
    // 全部答え終わるまでは通常のお題ゲームより韻テストを優先する。
    const testSession = await loadTestSession(userId);
    if (testSession) {
      // 保険: サーバー再起動などでタイマーが発火できなかった場合、次のメッセージ受信時に締め切る
      if (testSession.deadline && Date.now() >= testSession.deadline) {
        const timeUpText = formatTimeUpTestMessage(testSession);
        clearTestTimer(userId);
        await clearTestSession(userId);
        return client.replyMessage(event.replyToken, { type: 'text', text: timeUpText });
      }

      const isCorrect = testSession.remaining.includes(text);
      if (isCorrect) {
        testSession.remaining = testSession.remaining.filter((w) => w !== text);
        testSession.recalled.push(text);
      }

      // 最初の回答のタイミングで制限時間(30秒)のカウントダウンを開始する
      if (!testSession.deadline) {
        testSession.deadline = Date.now() + ANSWER_TIME_LIMIT_MS;
        scheduleTestTimeout(userId, testSession.roundId);
      }

      if (isCorrect && testSession.remaining.length === 0) {
        clearTestTimer(userId);
        await clearTestSession(userId);
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `○ 正解！\n\n🎉 「${testSession.themeWord}」の韻を全部答えられました！お疲れさまでした。`,
        });
      }

      await saveTestSession(userId, testSession);
      if (isCorrect) {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: `○ 正解！\n(残り ${testSession.remaining.length}個)`,
        });
      }
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `× 違います。\n(残り ${testSession.remaining.length}個)`,
      });
    }

    // トリガー以外のテキストは「単語での回答」として判定する(ユーザーごとの最新セッションを都度読み込む)
    const session = await loadSession(userId);
    if (!session || !session.theme) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'まずはリッチメニューの「お題を受け取る」から始めてください！',
      });
    }

    // 保険: サーバー再起動などでタイマーが発火できなかった場合、次のメッセージ受信時に締め切る
    if (session.deadline && Date.now() >= session.deadline) {
      const timeUpText = formatTimeUpThemeMessage(session);
      clearThemeTimer(userId);
      await appendResultLog(userId, session);
      await clearSession(userId);
      return client.replyMessage(event.replyToken, { type: 'text', text: timeUpText });
    }

    // 古いセッション(usedWords導入前)との互換用
    if (!Array.isArray(session.usedWords)) {
      session.usedWords = [session.theme.word];
    }

    // お題と同じ単語、またはこのラウンドで既に使った単語は禁止
    // (判定すら行わず即座に却下し、カウント・リストには一切影響しない)
    if (session.usedWords.includes(text)) {
      console.log(`使用済み単語のため却下 (${userId}): "${text}" (既に使用: ${session.usedWords.join(', ')})`);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text:
          `「${text}」は既に使った単語(またはお題と同じ単語)なので使えません。\n` +
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
    console.log(`判定 (${userId}): "${text}"(${userVowels}) vs お題"${session.theme.word}"(${session.theme.vowels}) => ${mark}`);

    // 判定結果にかかわらず、送った単語は「使用済み」として記録する(次回以降の使い回しを防ぐ)
    session.usedWords.push(text);

    if (mark === '○') {
      session.count += 1;
      session.list.push({ mark, userWord: text, userReading: userReadingHiragana });
    } else if (mark === '△') {
      session.list.push({ mark, userWord: text, userReading: userReadingHiragana });
    }

    // 最初の回答のタイミングで制限時間(30秒)のカウントダウンを開始する
    if (!session.deadline) {
      session.deadline = Date.now() + ANSWER_TIME_LIMIT_MS;
      scheduleThemeTimeout(userId, session.roundId);
    }

    let replyText;
    if (session.count >= REQUIRED_COUNT) {
      replyText = formatJudgmentMessage(session, text, userReadingHiragana, userVowels, mark) + '\n\n' + formatResultMessage(session);
      clearThemeTimer(userId); // 時間内に完了したので、保留中の締め切りタイマーは不要
      await appendResultLog(userId, session);
      await clearSession(userId); // ラウンド終了、セッションをクリア
    } else {
      replyText = formatJudgmentMessage(session, text, userReadingHiragana, userVowels, mark);
      await saveSession(userId, session);
    }

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
      if (menu.name === RICHMENU_NAME || menu.name === 'rhyme-theme-menu' || menu.name === 'daily-word-menu') {
        await client.deleteRichMenu(menu.richMenuId);
        console.log(`古いリッチメニューを削除: ${menu.richMenuId}`);
      }
    }

    const richMenuId = await client.createRichMenu({
      size: { width: 2500, height: 843 },
      selected: true,
      name: RICHMENU_NAME,
      chatBarText: 'メニュー',
      areas: [
        {
          bounds: { x: 0, y: 0, width: 1250, height: 843 },
          action: { type: 'message', label: 'お題を受け取る', text: THEME_TRIGGER_TEXT },
        },
        {
          bounds: { x: 1250, y: 0, width: 1250, height: 843 },
          action: { type: 'message', label: '韻リストを見る', text: RHYME_LIST_TRIGGER_TEXT },
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
app.get('/users', async (req, res) => {
  if (!USERS_API_SECRET || req.query.token !== USERS_API_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ users: await loadUsers() });
});

app.post('/send-daily-theme', async (req, res) => {
  if (!USERS_API_SECRET || req.query.token !== USERS_API_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const result = await sendDailyThemeToAll();
  res.json(result);
});

app.post('/send-rhyme-test', async (req, res) => {
  if (!USERS_API_SECRET || req.query.token !== USERS_API_SECRET) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const result = await sendRhymeTestToAll();
  res.json(result);
});

// みんなの「4つ達成」結果を一覧で見られるページ(スマホのブラウザでもOK)
app.get('/results', async (req, res) => {
  if (!USERS_API_SECRET || req.query.token !== USERS_API_SECRET) {
    return res.status(403).send('forbidden');
  }
  const log = await loadData(RESULTS_LOG_KEY, []);
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
