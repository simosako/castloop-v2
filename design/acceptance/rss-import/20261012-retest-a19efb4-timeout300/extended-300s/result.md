# RSS既存取り込み続行 — 300秒試験CLIで公開完了

## 結果

- 元のpublish-rss-importはexit0、rss-import-published、episode_count=36、subscriber_migration_completed=false。
- feed: https://castloop-rss-r1.otftalk.com/podcasts/otftalk-rss/feed.xml
- 同じservice rsstest-1012-r1 / import 908efe60-3585-4a6a-af01-f1c5d8afb206 / 既存workspaceを使用。21件目の既知jobから続行、公開済み分の置換なし。
- cursor completed / step148 / waiting_job_idなし。入力全116ファイルhash/size不変。
- 完了後の読み取りでservice open / invocations=[]、target-show unfinished_show_operation=false、domain configuration/connections一致、local_operations=[]。
- 全36件RSSのGUID集合/件数/日時/isPermaLink/タイトル/説明/任意項目/音源URL/length、番組情報を独立XML照合し成功。
- DNSは1.1.1.1直接指定、curl --resolve、TLS検証有効、OS DNS変更なし。カバーGET/hash/size成功。
- 代表2音源（比較一覧のindex0/35、合計85,381,535 bytes）の全量GET/hash/size、HEAD、Range206/先頭1024bytes一致。
- workers.devでも同一feed、feed conditional304、system/stagingパス404。独立配信照合12リクエスト成功。

## build識別と合格範囲

- base commit a19efb4cfc95507787fa54c335c67b5722de414b + 試験専用patch。
- CLI公開待機だけ120秒/120回→300秒/300回。対応する自動試験waits期待値2か所を変更。source-diff-final.stdoutを保存。
- binary SHA-256: 4c1388be1a91d5ce4343a78aec359edf36d29c3a4358a27fa8e14a57965a7c20。
- check/build成功、最終bun test 965 pass/0 fail、108 files、14705 expectations。
- 初回build試験は合計待機回数期待値123の変更漏れで964 pass/1 fail。実際303に合わせて修正して再試験成功。初回証跡も保持。
- Workerは既にdeploy済みのa19efb4版を維持。今回再deployなし。安全確認/未知変更再送拒否を省略していない。
- 標準120秒buildは既に2回待機上限に達したため、この完了を無改変CLIの全件合格とは扱わない。延長試験CLI + 修正Workerで既存記録からの全件公開成功。
- 旧command_requested step25の未開始確認/復旧は標準a19efb4 CLIで既に成功し、今回completed記録にもreconciled_unstarted_update_step=25を保持。

## 独立照合スクリプトの補正

- attempt1でShow description、attempt2でEpisode descriptionの比較assert失敗。
- shared schemaのtitle/description/author/owner_name等にはtrimがある。試験が生TOML/原RSS文字列とbyte相当比較していたため、末尾改行/前後空白の仕様上の除去を不一致と誤認した。
- Episode全36件でfeed descriptionが取り込みdraft.description.trimに一致することをオフライン確認。試験側だけスキーマの比較規則へ補正。入力/source/Worker/feedは変更していない。
- attempt1/2の失敗証跡は保持し、attempt3で独立照合全工程成功。最終根拠はpublic-checks-attempt3/public-validation.jsonとrss-metadata-validation.json。

## 未実施・終了状態

- 全36音源の独立再GET/hash、R2全件snapshot、完了後再実行での重複確認、unpublish/restore等追加回帰、管理API未認証負例、旧RSS再GET、最終pauseは未実施。計画の優先順位変更によりまず全件公開+RSS全件/代表配信確認を完了。
- 全音源独立照合の合格と混同しない。CLIによる各音源staging全量readback/hash検証は公開処理内で行われているが独立GETの代わりではない。
- 新環境はopenのまま保持。最後に確認した状態は処理なし/未完了Showなし。旧ホスト変更/購読者切替/環境削除なし。
- 性能調査/権限変更/待機上限以外の製品修正は実施していない。
- GitHubへの今回証跡push/Issue追記/closeは未実施。秘密backup/journal/metadataやsource素材はそのまま公開しない。
