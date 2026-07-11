# LINE 日本語単語Bot セットアップガイド

毎朝9時(日本時間)に、友だち登録した一人ひとりに個別で日本語の単語(読み方・意味・例文)を届けるLINE Botです。

## 仕組みと設計判断

- LINEの仕様上、ユーザーが公式アカウントを友だち追加すると自動的にBotとその人だけの1:1トークルームが作られます。グループ機能などは使わないので、追加の実装は不要です。
- 毎日9時の送信と単語選びは、`webhook-server` 1つのサーバー内で完結します(`node-cron`で `Asia/Tokyo` の9:00にトリガー)。
- 当初はCowork（このチャット環境）のスケジュールタスクから直接LINEに送信する設計を検討しましたが、この環境のネットワークはアクセス先が許可リスト制になっており、`api.line.me` を含む外部APIへ到達できないことを確認しました。そのため送信ロジックは常時起動できるサーバー側（後述のRenderなど）に置く方式に変更しています。
- 単語は `words.json` に41個収録し、順序をシャッフルしながら使い切るまで重複しないように送ります(尽きたら再シャッフル)。固定リストなので「日によって内容が変わる」要件は満たしつつ、外部AI APIのコストや失敗リスクを避けています。もし将来的にAnthropic APIキーなどを使ってその場でAI生成する方式に切り替えたい場合は、`sendDailyWord()` 内の単語選択部分を差し替えるだけで対応できます。

## ファイル構成

```
webhook-server/
  index.js       サーバー本体(Webhook受信 + 毎日9時の自動送信)
  words.json     単語データ(41件、自由に追加・編集可)
  package.json
  .env.example   環境変数のサンプル
  users.json     友だち登録したuserIdの保存先(自動生成・自動更新)
```

## 手順1: LINE公式アカウント/チャネルを作る

1. [LINE Official Account Manager](https://manager.line.biz/) にLINEアカウントでログインし、公式アカウントを新規作成する。
2. 作成した公式アカウントの管理画面右上「設定」→左メニュー「Messaging API」を開き、「Messaging APIを利用する」を選択してプロバイダーを指定・同意する。
3. 同じアカウントで [LINE Developers コンソール](https://developers.line.biz/console/) にログインし、チャネルが作成されていることを確認する。
4. チャネルの「Messaging API設定」タブで以下を控える。
   - チャネルアクセストークン(長期): 「発行」ボタンから発行
   - チャネルシークレット: 「チャネル基本設定」タブに表示
5. 同じ画面で「応答メッセージ」をオフ、「Webhookの利用」を後で有効にできるようにしておく(手順3でURLを設定してから有効化)。

## 手順2: サーバーをデプロイする(例: Render)

Render以外でも動きますが、無料枠があり手順が簡単なため一例として案内します。

1. `webhook-server` フォルダをGitHubリポジトリにアップロードする。
2. [Render](https://render.com/) で「New +」→「Web Service」→ 該当リポジトリを選択。
3. Build Command: `npm install` / Start Command: `npm start` を設定。
4. 環境変数(Environment)に以下を設定する。
   - `LINE_CHANNEL_ACCESS_TOKEN`: 手順1で発行したトークン
   - `LINE_CHANNEL_SECRET`: 手順1で確認したシークレット
   - `USERS_API_SECRET`: 好きなランダム文字列(動作確認用エンドポイントの保護に使う)
5. デプロイが完了すると `https://<サービス名>.onrender.com` のようなURLが発行される。

**注意:** Renderの無料プランは一定時間アクセスがないとスリープします。9:00の自動送信タイミングでスリープしていると`node-cron`のタイマー自体が止まってしまうため、無料運用する場合は外部の死活監視サービス(UptimeRobotなど)で数分おきに `/` にアクセスさせ、スリープさせない工夫を推奨します。予算が許せば有料プラン(常時起動)にするのが確実です。

## 手順3: Webhook URLをLINE側に設定する

1. LINE Developersコンソールのチャネル→「Messaging API設定」タブを開く。
2. 「Webhook URL」に `https://<サービス名>.onrender.com/webhook` を入力して保存。
3. 「Webhookの利用」をオンにする。
4. 「検証」ボタンを押し、200 OKが返ることを確認する。

## 手順4: 友だち追加してテストする

1. Messaging API設定タブにあるQRコードを読み取り、Botを友だち追加する。
2. 「友だち追加ありがとうございます」という返信が来て、1:1のトークルームができていることを確認する。
3. 動作確認用エンドポイントで、即座にテスト送信できます。

```
curl -X POST "https://<サービス名>.onrender.com/test-send?token=<USERS_API_SECRET>"
```

4. 実際に9:00になれば自動で全登録ユーザーに送信されます(タイムゾーンは Asia/Tokyo)。

## 無料利用時の制限

LINE公式アカウントの無料プラン(コミュニケーションプラン)は、月200通まで無料です。通数は「送信人数 × 1通あたりのバブル数」で計算されるため、例えば10人に毎日1通送ると月300通(10人×30日)となり無料枠を超えます。無料枠内で運用したい場合は、対象者を月200÷30 ≒ 6人程度までにするか、有料プラン(ライトプラン: 月5,000円で5,000通など)への切り替えを検討してください。

Sources:
- [Messaging APIの料金 | LINE Developers](https://developers.line.biz/ja/docs/messaging-api/pricing/)
- [Messaging APIを始めよう | LINE Developers](https://developers.line.biz/ja/docs/messaging-api/getting-started/)
