# Issue #109 制御DO保存表構成の非公開実機試験（2026-11-02）

## 対象と承認範囲

管理者の指示により、アカウントID末尾 `b1523d` に新規サービス `rev-b578f14-acf4` を作成した。対象は専用Worker `castloop-rev-b578f14-acf4-4f85c37e`、非公開R2バケット `castloop-rev-b578f14-acf4`、専用Cloudflare Accessアプリと、内蔵サイトを有効にしたShow `revf14-normal` である。

確認者は管理者が指定した1人に限定した。既存サンプルからカバー1件と音声1件（53,727,816バイト）を選び、コピーを使って公開した。旧環境・既存DNS・独自ドメインの変更や削除、料金・権限・CPU上限の変更は行っていない。

試験対象はコミット `b578f14` に [Issue #109 案B](control-do-storage-issue-109.md)（制御DO専用構成への分割、未コミットの17ファイル）を加えたCLIである。ビルドした単一実行ファイルのSHA-256は `8f8106b95a553110629ce887ac342f123566c3635f8cfc2cabf48f3c848ff1f5`。実施前に `bun test` 451件成功、`npm run check` 成功を確認済みである。

## 公開操作

- `init`（Worker・DO・非公開R2バケット作成）、`create-show --site-mode builtin`、`publish-show`、`preview-episode` → `publish-episode --expect-preview` を実行した。Show・Episodeとも `changed` として公開され、`service-status` は `publication_ready=true`、`show_count=1`、Episodeは公開済み1件だった。
- ShowのTOMLは過去のサンプルからShow IDのみ書き換え、エピソードのGUID・公開日時・音声の対応関係は維持した。

## 保護と素材の照合

- アップロード前検証の初回は匿名リダイレクト確認が0/6で失敗した（Accessアプリ作成直後の伝播遅延で全パス404）。アップロード・公開の前に停止して原因を確認し、伝播後の再実行で6/6 PASSを確認してから公開に進めた。
- 公開後の検証ではR2の音声1件（SHA-256キーで保存）とカバー1件を全量取得し元ファイルと照合した。全件一致し、`system/service.toml` も存在した。
- 公開後の匿名要求19件（HTML・Feed・画像・サイトページ・音声のGET・HEAD・条件付きGET・Range GET）がすべてAccessへ誘導された。管理APIは認証なしで401、ルート・`system/`・`staging/` は404、`/podcasts` は302だった。
- 元ファイル37件は試験前後で不変だった。

## 案B（制御DO構成）に関する確認

- 制御DO経路の管理API `registration-health` と `domain-state` が管理者キーで正常に応答した（識別情報は当該サービス、接続と保留はnull、`publication_ready=true`）。認証なしの同じ呼び出しは401だった。識別情報の照合(`publication_service`)、登録簿、ドメイン状態表を使う制御構成が実機で動作した。
- 制御DOのSQLite表集合そのものは管理APIから観測できないため、実機では直接確認していない。新規制御DOに作られる表が5表だけであることはローカルテスト（`packages/cli/src/sqlite-show-separation.test.ts`）で検証している。
- ドメイン変更フロー(`domain-prepare`/`commit`/`finalize`)と予約は今回実施していない。これらは未確認事項として残る。

詳細な非公開証跡とワークスペースは、主チェックアウトの `.local-test-data/results/20261102/rev-b578f14-acf4/` に保存した。確認者のメールアドレス、認証情報、サイトURL、サンプル本文はこの記録には含めない。

## 確認者の結果と保持

確認者（管理者）がサイトにアクセスし、音声再生と画面表示に問題ないことを報告した。シーク操作を個別に確認したかどうかは報告されていない。今回の結果は性能や無料枠での長期運用を保証しない。

確認者のアクセス後にも匿名拒否の再検証（`post-publication`）を実行し、11項目すべてPASSした（匿名要求19件全件がAccessへ誘導、R2全量照合、管理API・非公開パスの拒否）。再検証の結果は証跡ディレクトリの `post-reviewer-access/` に別途保存し、最初の検証結果は変更していない。元ファイルは試験の最終時点でも不変だった。

## 環境の削除

確認者の動作確認と再検証の後、管理者の明示指示を受け、同じ日にこの試験環境だけを削除した。削除前にWorkerのbinding（当該bucketとDurable Object namespace `dc8c9d43adf1490590ce9ea493dcbabb`）、Accessアプリ（当該Workerの `/podcasts` を対象とする1件だけ）、bucket内のobject（音声1件・カバー1件・`system/service.toml`の計3件）がすべてこの試験と一致し、bucketに公開ドメインがないことを確認した。

Workerを削除してnamespaceが一覧から消えたことを確認し、次に3 objectを完全一致keyで削除してbucketが空になったことを確認してからbucketを削除し、Accessアプリを削除した。最終確認でWorker・bucket・namespace・Accessアプリのいずれも不在（404または一覧に不在）になり、当該ホストのHTTPS要求も到達しなくなった。削除時の応答は証跡ディレクトリの `cleanup-20261102/` に保存した。R2 objectの別backupとDurable Object SQLite databaseのexportは行っていない。ローカル素材・workspace・証跡は削除していない。
