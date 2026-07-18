// ひらがな/カタカナの「音(モーラ)数」と「母音のみバージョン」を扱うユーティリティ

const SMALL_YOON = new Set(['ゃ', 'ゅ', 'ょ']); // 拗音(前の文字と合わせて1音)
const SMALL_TSU = new Set(['っ']); // 促音(1音とカウントするが、母音からは抜かす)
const CHOON = new Set(['ー']); // 長音符(伸ばし棒。1音とカウントするが、母音からは抜かす)
const HATSUON = new Set(['ん']); // 撥音(1音とカウントするが、母音からは抜かす)

// 小さい文字(拗音・外来語の小さい母音字)が前の文字の後ろに来た場合、
// その母音は前の文字ではなく、この小さい文字自身の母音を採用する。
// 例: 「ちょ」→ 'o'(「ち」の'i'ではなく「ょ」の'o')、「ふぁ」→ 'a'(「ふ」の'u'ではなく「ぁ」の'a')
const SMALL_VOWEL_MODIFIERS = {
  ゃ: 'a', ゅ: 'u', ょ: 'o',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
};

const VOWEL_TABLE = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'a', き: 'i', く: 'u', け: 'e', こ: 'o',
  が: 'a', ぎ: 'i', ぐ: 'u', げ: 'e', ご: 'o',
  さ: 'a', し: 'i', す: 'u', せ: 'e', そ: 'o',
  ざ: 'a', じ: 'i', ず: 'u', ぜ: 'e', ぞ: 'o',
  た: 'a', ち: 'i', つ: 'u', て: 'e', と: 'o',
  だ: 'a', ぢ: 'i', づ: 'u', で: 'e', ど: 'o',
  な: 'a', に: 'i', ぬ: 'u', ね: 'e', の: 'o',
  は: 'a', ひ: 'i', ふ: 'u', へ: 'e', ほ: 'o',
  ば: 'a', び: 'i', ぶ: 'u', べ: 'e', ぼ: 'o',
  ぱ: 'a', ぴ: 'i', ぷ: 'u', ぺ: 'e', ぽ: 'o',
  ま: 'a', み: 'i', む: 'u', め: 'e', も: 'o',
  や: 'a', ゆ: 'u', よ: 'o',
  ら: 'a', り: 'i', る: 'u', れ: 'e', ろ: 'o',
  わ: 'a', ゐ: 'i', ゑ: 'e', を: 'o',
};

function katakanaToHiragana(str) {
  return str.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
}

// 音(モーラ)数を数える。小さいゃゅょは前の文字と合わせて1音(カウントしない)。
// 促音っ・撥音ん・長音ーはそれぞれ独立した1音として数える。
function countMora(str) {
  const s = katakanaToHiragana(str);
  let count = 0;
  for (const ch of s) {
    if (SMALL_YOON.has(ch)) continue;
    count += 1;
  }
  return count;
}

// 母音のみバージョンを抽出する。
// 伸ばし棒(ー)・ん・促音(っ)は母音に含めない。
// 拗音・外来語の小さい母音字(ゃゅょ,ぁぃぅぇぉ)は、前の文字の母音の代わりにその小さい文字自身の
// 母音を採用する(例: 「ちょう」→ 'ou'、「ふぁん」→ 'a')。
function extractVowels(str) {
  const s = katakanaToHiragana(str);
  const chars = Array.from(s);
  let vowels = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];

    if (CHOON.has(ch) || HATSUON.has(ch) || SMALL_TSU.has(ch)) {
      continue;
    }
    if (SMALL_VOWEL_MODIFIERS[ch]) {
      // 単独で出現した小さい文字(通常は直前の文字の処理で消費される)は無視する
      continue;
    }

    const next = chars[i + 1];
    if (next && SMALL_VOWEL_MODIFIERS[next]) {
      vowels += SMALL_VOWEL_MODIFIERS[next];
      i += 1; // 小さい文字を消費済みとしてスキップ
      continue;
    }

    const v = VOWEL_TABLE[ch];
    if (v) vowels += v;
  }
  return vowels;
}

// お題の母音を半分に分けたときの「後半」を返す(奇数の場合は後半を1文字多くする)
function secondHalf(vowels) {
  const half = Math.floor(vowels.length / 2);
  return vowels.slice(half);
}

// 判定: '○'(完全一致) / '△'(お題の後半母音と一致) / '×'(不一致)
function judge(userVowels, themeVowels) {
  if (!userVowels) return '×';
  if (userVowels === themeVowels) return '○';
  if (userVowels === secondHalf(themeVowels)) return '△';
  return '×';
}

module.exports = { katakanaToHiragana, countMora, extractVowels, secondHalf, judge };
