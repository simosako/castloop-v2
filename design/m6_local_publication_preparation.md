# M6: acknowledged stagingからのpublication要求準備

更新日: 2026-10-02

`prepareLocalPublication`を追加した。callerが固定するpublish control requestと完了staging operation ID集合、必要なlocal audio path/base revisionを受け、privateなpublication journalと既存local-input guarded effectsを準備する。helperはclaim/commit/status/Queue/purgeを実行せず、公開CLIへはまだ組み込まない。

## 凍結内容と入力検査

- 同一service/account/Worker/originのlocal staging journalをbounded/strict読取し、`finished`/`finish_receipt=staged`・残存lockなしを要求する。missing/unfinished/abortedは採用しない。対象/draft ID/期待Episode generationとShow generationの関係は既存local publication guardで照合する。
- Showは1組のmetadata/cover、Episodeは1〜2件のmetadata/audioを要求し、duplicate assets/operation IDとforeign assetを拒否する。新規Episodeはmetadataとaudioの両方が必要で、改訂はstrictなbase revisionに基づくmetadata-only/audio-onlyも扱う。
- staging IDsをコピーしてsortし、同じ集合の列挙順から異なるmanifestを作らない。これはQueue/FIFOやpublication順序の保証ではない。commit timestampはcallerが固定したrequestのcreated_atを使い、再準備のたびに現在時刻へ置き換えない。
- checksum/size/cover extensionはacknowledged stagingから組み立てる。変更audioは現在sourceの全量hashとMP3解析durationを検査する。Show cover source、最新metadata、GUID/date/base metadataの再利用可否は既存guardで検査する。
- 検査済みmanifest/hashだけをprepared publication journalへdurable保存する。source paths・本文・GUID・メール・secret・base metadata本文はjournalへ追加しない。base revisionとlocal入力はメモリ内で保持する。

## 送信前再照合と中断

preparedの同manifestだけを明示再準備できる。requested/claimed/committed/残存lock・different manifestでは既存recordを保持して拒否する。準備中の途中phase/lock変更も拒否する。初回のlocal入力不一致はpublication record作成より先に失敗する。

返すeffectsはclaim/commit直前にstaging journal内容とlock存在を再読し、最新source guardの前後でも同じ記録であることを照合する。準備後にack record/lockが変わった場合、claimはprepared、commitはclaimedを保ち、変更POSTを送らない。状態観測から完了認定・unknown outcome再送・owner/token解放を行わない。

serverの共通CAS受付・current/base/remote staging検証とQueue consumerは別の境界であり、local receiptはremote mutation権限や最新revisionを保証しない。targetごとのdurable draft ID管理・既存workspace移行と公開CLIは別途接続する。

## 検証

local TOML/実MP3→自動staging準備→durable staging runner/実管理handler→finished receipts→自動publication準備→明示claim/commit/marker→owned consumerまで結合した。Show、Episode初回、metadata-only、audio-onlyとaudio-firstを回帰し、GUID/date・旧媒体path/immutable revision history保持を確認した。R2通知によるQueue配信はsimulated consumerへの明示投入であり、実Cloudflareではない。

stale metadata/audio・base identity不一致・missing/unfinished/aborted/locked stages・different draft/不完全初回input・manifest変更/requested再準備拒否・準備後のstaging lock変更・ID列挙順の不変と本文/secret非保持を確認した。

全756テスト/11843 assertions、TypeScript/M6実証tsconfig、内部helper Bun bundleに合格した。前段のMP3解析変更後にbuildしたLinux binaryでも、既存4familyの非書込statusをlocal HTTPS/実内部handlerへ接続し、credentialsなし・requested/古いlock保持・local/remote record不変を再確認した。新しいpublication helperのbinary command公開やCloudflare実機合格とは扱わない。

公開CLI/local draft ID管理、unknown outcomeの外部復旧、full migration cutover/配信・cacheと実Cloudflare/300MB/削除受け入れは残る。
