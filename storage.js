// 永続データ(users, sessions, results-log, daily-state)の保存先。
//
// Renderの無料プランはデプロイのたびにファイルシステムが初期化されるため、
// ローカルファイルに保存すると更新のたびにデータが消えてしまう。
// そのため、外部の永続ストア(Upstash Redis, REST API)に保存する。
//
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が未設定の場合は、
// 開発用フォールバックとしてローカルファイルに保存する(本番では設定必須)。

const fs = require('fs');
const path = require('path');

const hasUpstash = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

let redis = null;
if (hasUpstash) {
  const { Redis } = require('@upstash/redis');
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('永続データの保存先: Upstash Redis');
} else {
  console.warn(
    '警告: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が未設定です。' +
      'ローカルファイルに保存しますが、デプロイのたびにデータが消えます。'
  );
}

function localFile(key) {
  return path.join(__dirname, `${key}.json`);
}

async function loadData(key, fallback) {
  if (redis) {
    try {
      const data = await redis.get(key);
      return data === null || data === undefined ? fallback : data;
    } catch (err) {
      console.error(`Redisからの読み込みに失敗しました (${key}):`, err.message);
      return fallback;
    }
  }
  try {
    return JSON.parse(fs.readFileSync(localFile(key), 'utf8'));
  } catch (e) {
    return fallback;
  }
}

async function saveData(key, value) {
  if (redis) {
    try {
      await redis.set(key, value);
    } catch (err) {
      console.error(`Redisへの保存に失敗しました (${key}):`, err.message);
    }
    return;
  }
  fs.writeFileSync(localFile(key), JSON.stringify(value, null, 2));
}

async function deleteData(key) {
  if (redis) {
    try {
      await redis.del(key);
    } catch (err) {
      console.error(`Redisからの削除に失敗しました (${key}):`, err.message);
    }
    return;
  }
  try {
    fs.unlinkSync(localFile(key));
  } catch (e) {
    // ファイルが無ければ何もしない
  }
}

module.exports = { loadData, saveData, deleteData, hasUpstash };
