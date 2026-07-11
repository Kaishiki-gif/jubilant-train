// ひらがな/カタカナの「音(モーラ)数」と「母音のみバージョン」を扱うユーティリティ

const SMALL_YOON = new Set(['ゃ', 'ゅ', 'ょ']); // 拗音(前の文字と合わせて1音・母音は前の文字を無視して抜かす)
const SMALL_VOWELS = new Set(['ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ']); // 外来語の小さい母音字(抜かす)
const SMALL_TSU = new Set(['っ']); // 促音(1音とカウントするが、母音からは抜かす)
const CHOON = new Set(['ー']); // 長音符(伸ばし棒。1音とカウントするが、母音からは抜かす)
const HATSUON = new Set(['ん']); // 撥音(1音とカウントするが、母音からは抜かす)

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

// 母音のみバージョンを抽出する。伸ばし棒(ー)・ん・小さい文字(っ,ゃゅょ,ぁぃぅぇぉ)は抜かす。
function extractVowels(str) {
  const s = katakanaToHiragana(str);
  let vowels = '';
  for (const ch of s) {
    if (CHOON.has(ch) || HATSUON.has(ch) || SMALL_TSU.has(ch) || SMALL_YOON.has(ch) || SMALL_VOWELS.has(ch)) {
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
