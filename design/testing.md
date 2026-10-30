# テストと検証

変更は、ローカルテスト、型検査、バイナリ試験で確認します。Cloudflare固有の実行・キャッシュの挙動を調べる場合は、保護した実環境で検証します。本書では、変更に応じた確認方法とテストの配置を説明します。

## 変更後の基本チェック

```sh
bun test
npm run check
```

`bun test` はローカルテスト全体、`npm run check` は `tsc --noEmit` による型検査です。文書だけの変更では、後述の文書確認を行います。開発環境は [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。

CLIのビルドや埋め込みリソースを変えた場合は、バイナリを作ってスモーク試験を行います。Linuxの例です。

```sh
npm run build:cli -- linux-x64
node scripts/smoke-agent-cli.mjs dist/castloop-linux-x64
```

## テストの構成

| 層 | 確認する内容 | 主な配置 |
| --- | --- | --- |
| 共有スキーマ | 値、項目間の条件、上限、日時、識別子 | `packages/shared/src/*.test.ts` |
| Show内の処理 | 内容・履歴・予約の一括確定、競合、公開状態、統計 | `src/sqlite-*.test.ts` |
| 配信 | 公開パス、公開状態の判定、世代、ETag、HEAD、Range、生成結果 | Gateway・cache・site・feedのテスト |
| CLI結合 | ローカルファイル、管理HTTP、R2・配備・ドメインAPIとの接続 | `packages/cli/src/*.test.ts` |
| 単一バイナリ | 起動、埋め込みリソース、ヘルプ、スキーマ、ローカル操作 | `scripts/smoke-agent-cli.mjs` とCI |

SQLiteテストは `bun:sqlite` を使います。テスト用ストレージでDOのSQL・トランザクション・Alarm・同期インターフェースを再現します。CLIの結合テストもローカルのDOサービスと差し替えたHTTP通信を使います。

## 変更箇所ごとのテスト

| 変更箇所 | 関連テスト |
| --- | --- |
| 公開・履歴・公開状態 | [公開実行処理](../src/sqlite-publication-executor.test.ts)、[公開基盤](../src/sqlite-publication-queue.test.ts)、[CLI公開](../packages/cli/src/sqlite-publication.test.ts)、[履歴](../packages/cli/src/sqlite-revisions.test.ts)、[公開状態](../packages/cli/src/sqlite-lifecycle.test.ts) |
| Showの分離・管理 | [振り分け](../src/sqlite-show-routing.test.ts)、[Show分離](../packages/cli/src/sqlite-show-separation.test.ts)、[サービス実行時](../src/sqlite-service-runtime.test.ts) |
| 予約 | [予約実行](../src/sqlite-publication-schedules.test.ts)、[CLI予約](../packages/cli/src/sqlite-schedule.test.ts)、[時刻解決](../packages/cli/src/schedule-time.test.ts) |
| ドメイン・配備 | [ドメイン操作](../packages/cli/src/sqlite-domain-operation.test.ts)、[Cloudflare接続](../packages/cli/src/sqlite-domain-cloudflare.test.ts)、[初期化](../packages/cli/src/sqlite-initialization.test.ts)、[CLI入口](../packages/cli/src/sqlite-cli-entrypoint.test.ts) |
| 配信・生成・キャッシュ消去 | [Gateway](../src/sqlite-gateway.test.ts)、[キャッシュ](../src/lifecycle-cache.test.ts)、[生成配信](../src/sqlite-generated-delivery.test.ts)、[サイト](../src/site.test.ts)、[パージ](../src/sqlite-cache-purge.test.ts) |
| 統計 | [集計](../src/sqlite-delivery-stats.test.ts)、[HTTP](../src/sqlite-stats-http.test.ts)、[CLI](../packages/cli/src/stats.test.ts) |
| RSS取り込み | [取得](../packages/cli/src/rss-import-download.test.ts)、[解析](../packages/cli/src/rss-import-feed.test.ts)、[事前検査](../packages/cli/src/rss-import-preflight.test.ts)、[順次公開](../packages/cli/src/sqlite-rss-publication.test.ts) |
| ローカル記録・バックアップ | [記録保存](../packages/cli/src/local-journal-storage.test.ts)、[読み取り](../packages/cli/src/local-journal-read.test.ts)、[バックアップ](../packages/cli/src/backup.test.ts) |
| CLIの操作案内 | [ヘルプ](../packages/cli/src/help.test.ts)、[自己記述](../packages/cli/src/agent-schema.test.ts)、[Skill](../packages/cli/src/admin-skill.test.ts) |
| 入力例・雛形 | [テンプレート整合](../packages/cli/src/doctor-templates.test.ts) |

操作案内のテストでは、全コマンドのヘルプ、引数と説明、同梱Skillの埋め込み元との一致を確認します。入力例のテストでは、CLIの4種の雛形、`examples/` と `design/` のTOML、内蔵サイト・CSS・外部サイトへの切り替えを確認します。

### テストを追加するとき

要求仕様または実際にサポートする処理に対応させて、期待する結果を定めます。失敗時のテストでは、通信中断、パージ拒否、Alarm設定失敗など、対象の処理で起こり得る失敗と、その後に残る状態を確認します。たとえば公開では、確定前の失敗が現在内容・履歴・世代を変えないことを検査します。

## CIと配布バイナリ

[ビルドワークフロー](../.github/workflows/build-binaries.yml)は、Linux x64、macOS arm64、Windows x64でバイナリを作り、各OSでスモーク試験を実行します。型検査とローカルテスト全体はLinuxで実行します。

ビルド時にはWorkerをCLIへ埋め込みます。dotenv・bunfigの自動読み込みと、ビルド時環境変数の埋め込みを無効にし、ビルド端末の設定や秘密情報が配布物に入ることを防ぎます。

CIでは、チェックサム、版、ヘルプ、コマンド一覧、設定検証、単一バイナリでのローカル操作を確認します。タグとパッケージ版の一致、ビルド、スモーク試験を確認した後にリリースします。配布の手順は[リリース資料](../docs/development/releasing.md)を参照してください。

## 実機での検証

実DOのスケジューリングや耐久性、Cloudflareのキャッシュ挙動、性能・リソース使用量は、対象環境を定めて検証します。[非公開の実機試験手順](security.md)に従い、対象と操作範囲の承認を得てから実施します。

結果には、対象コミット、設定、実行環境、操作、観測した経路、結果、未確認事項を記録します。これにより、ローカルの再現結果と実環境で観測した結果を区別できます。性能やプランへの適合を記載する場合は、その条件での測定結果を示します。

実施記録は[アーカイブ](archive/README.md)やリリース資料へまとめ、設計本文には現行の仕組みと検証方法を記載します。

## 文書の確認

文書だけの変更では、次を確認します。

- 相対リンク、見出しへのリンク、実装・テストへの参照が有効であること。
- 用語、単位、フィールド名、形式の版が実装と一致すること。
- 説明が現行の処理順に沿っており、必要な前提を読者が理解できること。
- 設計上の仕組みと、実機で確認した結果が区別されていること。
