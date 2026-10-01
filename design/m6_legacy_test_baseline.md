# M6: 既存v0.1.1テスト環境の移行前基準

確認日: 2026-10-01

## 管理者からの申告

- 既存環境はテスト用で、削除することもできる。
- CLIと配備済みWorkerはv0.1.1のまま。
- Showは1つ、公開Episodeは2つ。処理中・失敗中のjobはない。
- 公開feed: https://castloop-smoke-20260930-77c8c193.simosako.workers.dev/podcasts/smoke-show/feed.xml

versionと未完了jobの有無は管理者申告であり、管理API/R2/Queueから確認した結果ではない。現在は移行前の基準として保存し、deploy・状態変更・payload削除・環境撤去を行わない。運用サービスには触れない。

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

## この環境を使う順序

1. M6の本番統合と移行ゲートを完成させ、専用環境で回復/配信/削除を検証する。現時点で最新コードのdeployを案内しない。
2. 管理者向けテストバイナリと手順を用意し、旧CLIからの更新/uploadを止め、未完了job・旧処理の収束と読み取り専用移行inventoryを確認する。v0.1.1からの移行経路はまだ未検証である。
3. 制御recordの移行とWorkerの100%切替を完了してから、上記URL/GUID/date/サイズ、GET/HEAD/Rangeと既存更新処理を回帰確認する。
4. Episode停止/再開、Show停止/再開と個別停止の保持を確認する。cache HITだった既知URLでも停止を回避できないことを確認する。
5. 不可逆削除は復帰と移行の確認後、対象IDを明示して実行する。410、payload除去、必要record保持、ID再利用拒否を確認する。移行後にv0.1.1 Workerへ戻さない。

詳細なCLIコマンドと管理APIの手順は統合後に追加する。現在の公開バイナリにM6コマンドはない。この基準確認はM6受け入れ合格ではない。
