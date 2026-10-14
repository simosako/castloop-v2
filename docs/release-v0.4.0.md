# castloop v0.4.0

RSSから新規Showへの一度限りの移行、公開処理の性能改善・停止診断、限定的なWorker更新続行を含むLinux x86-64向けCLIのリリースです。v0.3.0の一覧・非公開化・復元・削除・独自ドメイン機能を維持します。

## 重要な既知の制限

- **Workers FreeのHTTP CPU 10ms目標は未達です。** 最新実装の取得できた公開HTTP CPUは15〜34msでした。Freeでの安定稼働を保証せず、Paidへの変更を自動実行しません。
- **Issue #13の完全解消と最初のconsumer取消原因は未確定です。** 最新試験ではFreezeを観測しませんでしたが、未知I/O・残留owner／token／lockは引き続き保全します。DLQ履歴・時間経過・HEAD不在を解放証拠にせず、`release-job`／`publication-release`は無効化しています。
- 公開前の確定的入力失敗は`failed / validation_failed`で停止します。Show ownerと凍結draftを保持し、安全な取消し・編集・新jobへの置換は提供しません。

## 追加・改善

- `import-rss SHOW_ID RSS_URL --dry-run`: RSSの件数・不足項目・非対応項目を検査します。
- `import-rss SHOW_ID RSS_URL --output DIRECTORY`: RSS、MP3、JPEG／PNG、TOMLをローカルへ保存し、確認済み素材からdownloadを続行できます。
- `publish-rss-import DIRECTORY`: 確認した入力を新規Showへ明示的に逐次公開します。元のGUID・公開日時を維持し、各jobの`published / released`を確認してから次へ進みます。既存Showへの追加、定期同期、旧ホストの削除、購読者の自動移行は対象外です。
- Episodeカタログ、検証済み不変記録の再利用、重複parse削減により公開処理を改善しました。既存Showの最初の更新ではカタログを構築し、その後は未変更Episodeの個別読取を省きます。カタログは公開配信しません。
- HTTP commitを受付に限定し、staging／base revision／payloadの詳細検証を既存Queue consumerへ集約しました。
- `worker_phase_started`／`worker_timing`の対応ログを追加し、音源保存、feed／catalog、purge、完了保存、後処理、token返却の停止点を区別します。本文・秘密・execution tokenはログに入れません。
- 共有Worker tail IDを観測終了時に削除せず、採取異常・不完全な時間分布を検出する試験用helperを整えました。

## 不具合修正と復旧の境界

- [Issue #10](https://github.com/simosako/castloop-v2/issues/10): 確認済みの状態照会競合だけを再照会し、変更開始前の対象照会失敗と未知mutationを区別します。未知要求は再送しません。
- [Issue #11](https://github.com/simosako/castloop-v2/issues/11): `update-service-continue OPERATION_UUID`で、schema-v2 journalがactivation未開始を証明する確認済みuploadだけを続行できます。再upload・rollback・自動resumeはしません。旧schema-v1や結果不明のactivation、残存lockは対象外です。
- [Issue #13](https://github.com/simosako/castloop-v2/issues/13): 未読音源bodyの終了待ちと、並行読取の開始済みI/O settlementを修正しました。確定失敗とtransient I/Oを区別し、未終了処理の所有権を保全します。本リリースを完全解消の宣言とはしません。

## CLI／Workerの互換性と更新

- **v0.4.0のCLIと、そのバイナリで配備したWorkerの両方が必要です。** 旧CLI／Workerとのclaim・commitプロトコル混用は拒否します。バイナリ交換やRelease公開だけではCloudflareサービスは更新されません。
- `queue-validation-v1`のHTTP `202 / accepted`、CLI `publication-accepted`、journalの`accepted`は凍結要求とmarkerの受付完了です。staging検証済み・公開成功ではありません。`published / released`を確認してください。
- 旧`committed` journalはそのまま読み取り、自動変換しません。結果不明のPOST／PUTは再送せず、journal・lock・ownerを保持します。
- 初期化済みM6サービスはworkspaceと`.castloop/`を保管し、pause・全既存処理の終了確認 → v0.4.0で`deploy` → runtime確認 → 明示resumeで更新します。残存tokenをdrain対象から除外しません。
- 外部GUIDや新カタログを使用した後の旧Workerへのdowngradeは非対応です。v0.1.x変換・資源採用・無停止更新・万能復旧は追加しません。
- RSS公開は各job最大300回、待機開始から5分後は新しい状態照会を開始しません。進行中のHTTP要求には別timeoutがあります。待機終了後もcursorを保持し、同じ取り込みの続行は受付済みjobの確認から行います。

## 検証・配布範囲

統合時とリリース準備後の再検証で**1,057テスト合格／0失敗（117 files）**、TypeScript検証が成功しました。v0.4.0のLinuxバイナリで版番号、配布workflowと同じCLI smoke、管理者所有の実RSSのdry-run（36件）も確認しました。dry-runはRSS読取のみで、素材upload・公開は行いません。配布workflowは型検証・全テスト・Linux単一バイナリbuild、SHA-256、版番号、既存コマンドとRSSコマンドのsmokeを行ってからReleaseを公開します。

最新実装の既存実機試験ではShow更新、初回Episode、36件Showのmetadata更新3回、最小audio更新の**計6公開が成功**し、feed／音源と`published / released`・service token返却を確認しました。CPU取得はHTTP 5/6、consumer 5/6で不完全です。旧実装の通常規模試験、既存300 MB・Lifecycle・互換更新の受け入れを再利用し、このリリース準備ではCloudflareへの新規配備・uploadを行いません。素材・秘密・原本ログはGitに含めません。

CLIから直接Queueへ送る公開要求、commit／claimの非HTTP化は**次期開発の設計提案**であり、v0.4.0には含まれません。

配布するのはLinux x86-64バイナリ、`SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md`です。macOS／Windowsは配布対象外です。

操作と更新は[README](https://github.com/simosako/castloop-v2/blob/v0.4.0/README.md)、移行と復旧は[RSS利用案内](https://github.com/simosako/castloop-v2/blob/v0.4.0/docs/rss_migration.md)、測定と限界は[HTTP受付設計](https://github.com/simosako/castloop-v2/blob/v0.4.0/design/http_publication_commit_optimization_plan.md)を参照してください。
