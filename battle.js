// 写真ラップバトル
//
// ユーザーが撮った写真から、AI(OpenAI の画像対応モデル)が「主役」を1つ判定し、
// そのモノ(生物・非生物・概念を問わない)になりきって「4×2分割法」の8小節でバトルを仕掛ける。
// 以降はユーザーのバース(テキスト or 音声)にアンサーする形で交互に続ける。
//
// 4×2分割法:
//   1〜4小節目 … 1小節を4つに区切り、4つ目【】で韻を踏む
//   5〜8小節目 … 1小節を2つに区切り、2つ目【】で長めの韻を踏む

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BATTLE_MODEL = process.env.OPENAI_BATTLE_MODEL || 'gpt-4o';

const STYLE_GUIDE = `あなたは日本語のフリースタイルMCバトルのラッパーです。対戦相手はラップ初心者の人間です。

# 書き方: 「4×2分割法」の8小節
- 1〜4小節目: 1小節を「／」で4つに区切り、4つ目を【】で囲む。【】の中身同士で韻を踏む(4つすべて同じ母音、または1・3小節目と2・4小節目でそろえる)。
- 5〜8小節目: 1小節を「／」で2つに区切り、2つ目を【】で囲む。前半より長い韻(母音が3〜5音以上一致)を4小節そろえて踏む。
- 1小節は短く、声に出してリズムに乗る長さ(ひらがなで20音程度まで)にする。
- 4小節目と8小節目にパンチライン(いちばん強い一言)を置く。

# 書き方の見本(人間の挑戦者がAIに向けて書いたもの)
心臓／掴むは／誰でも／【言える】
それって／AI／もしくは／【アホだ】
リズムは／迷子で／それでも／【勝てる】
人間／にしか／出せない／【ハートで】
俺はそれで／【勝っていくだけ】
お前にゃ無理な／【人の魂】
ならお前も／【ハート見せてみろ】
AI風情が／【証明してみろ】

# キャラクター
- 一人称で、指定された「対戦相手(モノ・生き物・概念)」そのものになりきる。
- そのモノの特徴・用途・季節・歴史・ことわざ・よくある連想を武器にして攻める。
- 相手(人間)をディスってよいが、ユーモアのある範囲にとどめる。容姿・人種・国籍・性別・性的指向・障害・病気などの属性への攻撃、差別語、性的な表現、暴力の煽りは使わない。
- 初心者にも伝わる平易な言葉を使う。英語は少しならよい。`;

async function callOpenAI(messages, maxTokens = 900) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY が未設定です');
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: BATTLE_MODEL,
      messages,
      temperature: 0.9,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI APIエラー: ${res.status} ${errText}`);
  }
  const data = await res.json();
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '{}';
  return JSON.parse(content);
}

function normalizeVerse(verse) {
  const lines = Array.isArray(verse) ? verse : String(verse || '').split('\n');
  return lines.map((l) => String(l).trim()).filter(Boolean);
}

// 写真から対戦相手を判定し、先攻の8小節を作る
async function startBattleFromImage(imageBuffer, mimeType = 'image/jpeg') {
  const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
  const instruction = `この写真を見て、ラップバトルの対戦相手を1つだけ決め、そのモノになりきって先攻の8小節を書いてください。

# 対戦相手の決め方
- 写真の中心にある／大きく写っている／ピントが合っている／撮影者が狙って撮ったと思われるものを主役にする。
- 生物・非生物・概念を問わない。基本は写っているモノそのものにする。ただし写真全体から強く連想される概念(例: 時計→時間、散らかった机→締め切り)のほうが明らかに面白い場合は概念にしてよい。
- 写真に人が写っている場合も、特定の個人そのものではなく、服・持ち物・その場の雰囲気など別のものを相手にする。

# 出力(JSONのみ)
{
  "opponent": "対戦相手の名前(短く)",
  "reason": "なぜそれを主役に選んだか(40字以内)",
  "verse": ["1小節目", "2小節目", "3小節目", "4小節目", "5小節目", "6小節目", "7小節目", "8小節目"],
  "rhyme_note": "踏んだ韻の説明(例: 前半〜み(a-i)／後半〜わり(a-i))"
}
これは先攻の1本目なので、相手のバースはまだありません。自己紹介と挑発で攻めてください。`;

  const result = await callOpenAI([
    { role: 'system', content: STYLE_GUIDE },
    {
      role: 'user',
      content: [
        { type: 'text', text: instruction },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
      ],
    },
  ]);

  return {
    opponent: String(result.opponent || '謎の物体').trim(),
    reason: String(result.reason || '').trim(),
    verse: normalizeVerse(result.verse),
    rhymeNote: String(result.rhyme_note || '').trim(),
  };
}

function historyText(battle) {
  return battle.verses
    .map((v, i) => {
      const who = v.by === 'ai' ? `${battle.opponent}(あなた)` : '人間の挑戦者';
      return `--- ${i + 1}本目: ${who} ---\n${v.text}`;
    })
    .join('\n\n');
}

// 相手(人間)の直前のバースにアンサーする次の8小節を作る
async function generateNextVerse(battle) {
  const instruction = `あなたは「${battle.opponent}」です。ここまでのバトルは以下のとおりです。

${historyText(battle)}

人間の挑戦者の直前のバースに対して、アンサーとなる次の8小節を書いてください。
- 相手が使った言葉や韻を1つ以上拾って切り返す(アンサー)。
- 自分(${battle.opponent})の特徴を武器にし続ける。前のバースと同じ韻・同じネタの繰り返しは避ける。
- これが自分の最後のバースなら、締めにふさわしいパンチラインで終える。

# 出力(JSONのみ)
{
  "verse": ["1小節目", "2小節目", "3小節目", "4小節目", "5小節目", "6小節目", "7小節目", "8小節目"],
  "rhyme_note": "踏んだ韻の説明"
}`;

  const result = await callOpenAI([
    { role: 'system', content: STYLE_GUIDE },
    { role: 'user', content: instruction },
  ]);
  return {
    verse: normalizeVerse(result.verse),
    rhymeNote: String(result.rhyme_note || '').trim(),
  };
}

// バトル終了後の講評(初心者の学習支援用)
async function generateReview(battle) {
  const instruction = `以下は、AI(「${battle.opponent}」役)と人間の挑戦者によるラップバトルです。

${historyText(battle)}

人間の挑戦者(ラップ初心者)に向けて、短い講評を書いてください。勝ち負けの判定はしません。
- good: 挑戦者のバースで良かった韻を1〜2個、実際のフレーズと母音つきで挙げてほめる(例:「勝てる/言える(e-u)」)。韻がほとんどなければ、良かった言葉選びや勢いをほめる。
- answer: 挑戦者が相手(${battle.opponent})の特徴や相手の言葉を拾って返せていたかを一言で。
- next: 次に試すと良いことを1つ、具体的に(例: 5〜8小節目の【】を3音以上そろえる)。
各項目は60字以内。音声入力の場合は改行や句読点が崩れていることがあるので、そこは評価に含めない。

# 出力(JSONのみ)
{ "good": "...", "answer": "...", "next": "..." }`;

  const result = await callOpenAI(
    [
      { role: 'system', content: 'あなたは日本語ラップの優しいコーチです。' },
      { role: 'user', content: instruction },
    ],
    500
  );
  return {
    good: String(result.good || '').trim(),
    answer: String(result.answer || '').trim(),
    next: String(result.next || '').trim(),
  };
}

module.exports = { startBattleFromImage, generateNextVerse, generateReview };
