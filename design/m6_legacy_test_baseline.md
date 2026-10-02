# M6: 既存v0.1.1テスト環境の移行前基準

確認日: 2026-10-01（公開基準）、2026-10-02（Cloudflare管理情報の再確認）

## 管理者からの申告

- 既存環境はテスト用で、削除することもできる。
- CLIと配備済みWorkerはv0.1.1のまま。
- Showは1つ、公開Episodeは2つ。処理中・失敗中のjobはない。
- 公開feed: https://castloop-smoke-20260930-77c8c193.simosako.workers.dev/podcasts/smoke-show/feed.xml

2026-10-01時点のversionと未完了jobの有無は管理者申告だった。2026-10-02に下記のCloudflare管理情報/R2 statusも読み取り確認した。Release tagと配備bundleの同一性は照合しておらず、v0.1.1というversion対応は引き続き管理者申告である。現在は移行前の基準として保存し、deploy・状態変更・payload削除・環境撤去を行わない。運用サービスには触れない。

## 読み取り専用のHTTP確認

公開URLに対してfeed GET、音源HEADと`Range: bytes=0-15` GET、cover HEADだけを実行した。音源全体のdownload、checksum計算、再生確認はしていない。観測coloはNRTで、複数coloの確認ではない。

| 対象 | 結果 | サイズ / Cache-Control |
| --- | --- | --- |
| feed GET | 200、RSS item 2件、CF-Cache-Status HIT | `public, max-age=300` |
| first-episode MP3 HEAD | 200、audio/mpeg、Accept-Ranges bytes、HIT | 46,472,044 bytes、`public, max-age=31536000, immutable` |
| first-episode MP3 Range GET | 206、HIT | Content-Length 16、`bytes 0-15/46472044` |
| second-episode MP3 HEAD | 200、audio/mpeg、Accept-Ranges bytes、HIT | 62,853,537 bytes、`public, max-age=31536000, immutable` |
| second-episode MP3 Range GET | 206、HIT | Content-Length 16、`bytes 0-15/62853537` |
| cover.jpg HEAD | 200、image/jpeg、CF-Cache-Status EXPIRED | 2,173,207 bytes、`public, max-age=300` |

観測した上記応答にETag/Last-Modifiedはない。音源のHEAD総bytesはfeed enclosure lengthと一致する。これは音源内容の同一性や全revisionの存在証明ではない。

## 移行・再開時に維持する公開識別情報

公開base URLは`https://castloop-smoke-20260930-77c8c193.simosako.workers.dev`、Show IDは`smoke-show`。

| Episode ID | GUID | pubDate | enclosure path |
| --- | --- | --- | --- |
| first-episode | 7ce0a9f1-c2d8-4700-9d87-72950f78e73e | Wed, 30 Sep 2026 07:33:43 GMT | `/podcasts/smoke-show/episodes/first-episode/6cefc5cc-5d0c-4cc7-8e3d-aa99711b74e2.mp3` |
| second-episode | c69ac927-8fae-4f60-93a2-223faafd9a62 | Wed, 30 Sep 2026 07:35:05 GMT | `/podcasts/smoke-show/episodes/second-episode/d56517cd-8148-41c2-828a-baf3bd847c33.mp3` |

タイトル・説明文・所有者メールやfeed本文全体はこの基準記録へ複製しない。公開HTTP情報だけではbucket名、Queue設定、staging/revision inventoryは分からない。

## 2026-10-02: WranglerとGET-only RESTによる再確認

管理者の指示で既存環境を読み取り専用で確認した。インストール済みWrangler 4.131.2を使用し、更新・deploy・resource作成/削除・Queue pull/ack/purge・R2書込は行っていない。認証はAccount API Tokenで、published service設定のaccountは環境変数のaccountと一致する。token/管理key/account ID/メールアドレスは本記録へ保存しない。

| 対象 | 確認結果 |
| --- | --- |
| Service | `smoke-20260930`。R2の`system/service.toml`でWorker/bucket/Queue/DLQ/public URLの対応を照合 |
| Worker | `castloop-smoke-20260930-77c8c193` |
| 現在のdeployment | `8953d041-6139-4ca7-a3c9-6233163f33d5`、2026-09-30T07:32:00.973508Z、単一version 100% |
| 現在のWorker version | `5a2601ec-9d1a-497e-90f8-fdb1d2096cfd`、fetch/queue handler、compatibility date `2026-09-23` |
| Cache/preview | Workers Caching enabled、cross-version cache false、workers.dev enabled、version previews disabled。logs/traces enabled |
| R2 | `castloop-smoke-20260930`、APAC、Standard。24 objects、bucket info表示は223 MB |
| R2公開 | r2.dev disabled、R2 Custom Domainなし |
| Primary Queue | `castloop-smoke-20260930-77c8c193`。producerは同Workerと同R2、consumerは同Worker |
| Primary consumer | batch 1、concurrency 1、max_retries 2、max_wait_time_ms 5000、同DLQを指定 |
| DLQ | `castloop-smoke-20260930-dlq-77c8c193`。consumerは同Worker、batch 1、concurrency 1、max_retries 3 |
| Queue retention | primary/DLQとも86,400秒。これは設定観測であり、M6のR2回復記録保持方針とは別 |
| R2 notification | prefix `staging/`、suffix `commit.json`、primary QueueへPutObject/CopyObject/CompleteMultipartUpload通知 |
| Worker bindings | bucket/Queue/DLQの対応と管理keyのsecret_text bindingを確認。secret値は取得しない |

R2の全24 objectsを1ページで列挙した。公開領域はfeed/cover、2 Episodeのimmutable MP3/current metadata/各1 revision。staging領域には公開済みShowと2 Episodeのpayload/commitも残っている。system領域にはservice/show metadata、予約、旧Show受付record、3 job statusがある。M6 service registry・Episode lifecycle・移行記録はこの一覧に存在しない。

| Job対象 | Job ID | R2 status |
| --- | --- | --- |
| Show | `44e13628-c3ff-4f8d-9f3b-2ca3f2d8d884` | `published` |
| first-episode | `6cefc5cc-5d0c-4cc7-8e3d-aa99711b74e2` | `published` |
| second-episode | `d56517cd-8148-41c2-828a-baf3bd847c33` | `published` |

旧`system/show-publications/smoke-show.json`は`state=free`、最後のjob IDはsecond-episodeと一致する。R2上の処理中/失敗中job記録やDLQ markerは今回の一覧にはなかった。Queue内の滞留message数、実行中の旧Worker、管理者端末/別REST PUTの終了は未確認であり、これを移行quiescenceやtoken解放の許可にしない。認証付きWorker管理APIも照会していない。

公開feedは200/3,217 bytes/2 itemsで、既存のGUID・pubDate・enclosure URL/lengthが上記基準と一致した。coverと両MP3のHEADは200でsizeも一致し、両音源のRange `0-15`は206/16 bytes/正確なContent-Range、HITだった。coloはNRT。現在のfeed/coverはmax-age=300、音源はmax-age=31536000, immutableであり、M6の毎要求lifecycle gate・外部再検証へ移行済みという意味ではない。音源全量download/checksum/再生は行っていない。

### 移行adapterで対応すべき実REST形状

この旧Workerのversion GETでは`resources.script.named_handlers`、`resources.script_runtime.compatibility_flags`、`resources.script_runtime.exports`が省略されていた。settings GETでもexportsがなく、compatibility_flagsは空配列である。現在のlegacy移行version schemaはこれらのversion項目を必須としているため、初回bridgeのread-only準備adapterに実応答互換性の残件がある。省略を無条件にM6 runtime証拠や安全なdefault-only/cache設定とみなさず、legacy限定の補完・裏付けと回帰検証を検討する。今回schema修正・移行準備POST・deployは行わない。

## この環境を使う順序

1. M6の本番統合と移行ゲートを完成させ、専用環境で回復/配信/削除を検証する。現時点で最新コードのdeployを案内しない。
2. 管理者向けテストバイナリと手順を用意し、旧CLIからの更新/uploadを止め、未完了job・旧処理の収束と読み取り専用移行inventoryを確認する。v0.1.1からの移行経路はまだ未検証である。
3. 制御recordの移行とWorkerの100%切替を完了してから、上記URL/GUID/date/サイズ、GET/HEAD/Rangeと既存更新処理を回帰確認する。
4. Episode停止/再開、Show停止/再開と個別停止の保持を確認する。cache HITだった既知URLでも停止を回避できないことを確認する。
5. 不可逆削除は復帰と移行の確認後、対象IDを明示して実行する。410、payload除去、必要record保持、ID再利用拒否を確認する。移行後にv0.1.1 Workerへ戻さない。

詳細なCLIコマンドと管理APIの手順は統合後に追加する。現在の公開バイナリにM6コマンドはない。この基準確認はM6受け入れ合格ではない。
