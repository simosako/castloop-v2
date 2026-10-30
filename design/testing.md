# テストと検証の設計

ローカル試験は、入力契約、SQLiteの原子性、CLIとWorkerの接続、配信応答を検査する。Cloudflareの実際の実行環境・キャッシュ性能・料金プランへの適合は別に確認する。

## 必須チェック

```sh
bun test
npm run check
```

`bun test` はローカルテスト全体、`npm run check` は `tsc --noEmit` による型検査。文書だけなどコード・ビルド・実行動作に影響しない変更では省略できる。lint・formatterは設定していない。

開発環境とビルド手順は[CONTRIBUTING.md](../CONTRIBUTING.md)を参照する。バイナリの確認はビルド後、例えばLinuxでは次を使う。

```sh
npm run build:cli -- linux-x64
node scripts/smoke-agent-cli.mjs dist/castloop-linux-x64
```

これらのコマンドはCloudflareへ配備しない。

## 試験の層

| 層 | 確認すること | 主な対象 |
| --- | --- | --- |
| 共有契約 | 型・値・項目間条件・入力上限・日時・識別子 | `packages/shared/src/*.test.ts` |
| Show内の処理 | 内容・履歴・予約の一括確定、競合、公開可否、統計 | `src/sqlite-*.test.ts` |
| 配信 | 許可パス、拒否、世代、ETag、HEAD、Range、サイト生成 | Gateway・cache・site・feedテスト |
| CLI結合 | ローカルファイル、管理HTTP、R2・配備・ドメインの要求と応答 | `packages/cli/src/*.test.ts` |
| 単一バイナリ | 埋め込みリソース、ヘルプ、スキーマ、ローカルワークフロー | `scripts/smoke-agent-cli.mjs` とCI |

SQLite試験は `bun:sqlite` を使う。テスト用ストレージがDOのSQL・トランザクション・Alarm・同期インターフェースを再現し、必要な失敗を注入する。CLIの結合試験もローカルのDOサービスと差し替え通信を使い、実アカウントへ接続しない。

## 機能ごとの確認点

| 変更領域 | 主な回帰試験 |
| --- | --- |
| 公開・履歴・公開可否 | [executor](../src/sqlite-publication-executor.test.ts)、[公開基盤](../src/sqlite-publication-queue.test.ts)、[CLI公開](../packages/cli/src/sqlite-publication.test.ts)、[履歴](../packages/cli/src/sqlite-revisions.test.ts)、[ライフサイクル](../packages/cli/src/sqlite-lifecycle.test.ts) |
| Show分離・管理 | [振り分け](../src/sqlite-show-routing.test.ts)、[Show分離](../packages/cli/src/sqlite-show-separation.test.ts)、[サービス実行時](../src/sqlite-service-runtime.test.ts) |
| 予約 | [予約実行](../src/sqlite-publication-schedules.test.ts)、[CLI予約](../packages/cli/src/sqlite-schedule.test.ts)、[時刻解決](../packages/cli/src/schedule-time.test.ts) |
| ドメイン・配備 | [ドメイン操作](../packages/cli/src/sqlite-domain-operation.test.ts)、[Cloudflare接続](../packages/cli/src/sqlite-domain-cloudflare.test.ts)、[初期化](../packages/cli/src/sqlite-initialization.test.ts)、[CLI入口](../packages/cli/src/sqlite-cli-entrypoint.test.ts) |
| 配信・生成・パージ | [Gateway](../src/sqlite-gateway.test.ts)、[キャッシュ](../src/lifecycle-cache.test.ts)、[生成配信](../src/sqlite-generated-delivery.test.ts)、[サイト](../src/site.test.ts)、[パージ](../src/sqlite-cache-purge.test.ts) |
| 統計 | [集計](../src/sqlite-delivery-stats.test.ts)、[HTTP](../src/sqlite-stats-http.test.ts)、[CLI](../packages/cli/src/stats.test.ts) |
| RSS取り込み | [取得](../packages/cli/src/rss-import-download.test.ts)、[解析](../packages/cli/src/rss-import-feed.test.ts)、[事前検査](../packages/cli/src/rss-import-preflight.test.ts)、[順次公開](../packages/cli/src/sqlite-rss-publication.test.ts) |
| ローカル記録・バックアップ | [記録保存](../packages/cli/src/local-journal-storage.test.ts)、[読取](../packages/cli/src/local-journal-read.test.ts)、[バックアップ](../packages/cli/src/backup.test.ts) |
| CLIの操作案内 | [ヘルプ](../packages/cli/src/help.test.ts)、[自己記述](../packages/cli/src/agent-schema.test.ts)、[同梱Skill](../packages/cli/src/admin-skill.test.ts)。全コマンドのヘルプを設定・認証情報なしで実行し、案内の契約と埋め込み元の一致を確認 |

試験を追加するときは、要求仕様またはサポートする実行経路へ結び付ける。通信中断、パージ拒否、Alarm設定失敗等は該当処理の確定範囲を検査するために使う。信頼された内部契約を人工的に破るだけの試験から、不要な防御処理を増やさない。

## CIと配布物

[ビルドワークフロー](../.github/workflows/build-binaries.yml)はLinux x64、macOS arm64、Windows x64でバイナリを作り、各OSでネイティブのスモーク試験を行う。型検査と全ローカルテストはLinuxの参照環境で実行する。

ビルドはWorkerをCLIへ埋め込み、dotenv・bunfigの自動読込とビルド時環境変数の埋込みを無効にする。CIはチェックサム、版、ヘルプ、コマンド一覧、非対応設定の拒否、外部プログラムに依存しないローカル操作を確認する。タグとパッケージ版の一致、ビルドとスモークの成功後にリリースする。

ビルドスクリプトが受け付ける追加ターゲットと、CIで配布・確認しているターゲットは同じとは限らない。

## 実機検証と証明できる範囲

| 検証 | 言えること | 言えないこと |
| --- | --- | --- |
| ローカルSQLite・差し替えHTTP | 実装の分岐、要求形式、ローカルトランザクション、期待する応答 | 実DOのスケジューリング・耐久性、Cloudflareキャッシュの実際の挙動 |
| 各OSのバイナリスモーク | その環境での起動と対象ローカル操作 | 全機能の実Cloudflare動作 |
| 限定した実機スモーク | 指定環境・設定・対象・経路で確認した結果 | 一般的な性能、すべての異常系、本番規模、Freeプラン全体への適合 |

現行版のリリース記録にある実機確認は、非公開環境での初期化、Showと3 Episodeの公開、内蔵サイト再生、東京時間表示の小規模確認である。これを予約・独自ドメイン・RSS一括移行・障害復旧・性能全般の実機検証済みという意味に広げない。

実機試験は[セキュリティの試験条件](security.md)に従い、対象と操作範囲の承認を別に得る。結果は対象コミット・設定・実行環境・観測経路・未確認事項とともに記録し、設計本文へ時系列ログを追記しない。失敗や不足した測定値を成功・0として補わない。

## 文書変更の確認

文書だけの変更では、相対リンクと見出し、コード・スキーマへの参照、用語と単位、対象版を確認する。現在の設計を説明する文書は実装と関連テストに照合し、過去の検証記録だけを根拠に新しい仕様を書かない。
