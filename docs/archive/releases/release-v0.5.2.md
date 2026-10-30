# castloop v0.5.2

> 旧版のリリース記録です。現行の操作は[利用ガイド](../../README.md)を参照してください。

v0.5.1の検証強化とv0.5.0のSQLite逐次公開方式・Queue方式を維持したまま、SQLite Worker更新の検証続行、CLIアップロードのsource完了順序、Cloudflare REST URLのエンコード、管理者キーのネイティブ暗号照合、ドメインprobeの重複R2読取削除、旧M6試験バイナリの削除とドキュメント再編を行ったLinux x86-64向けCLIです。
protocol、TOML schema、R2 object key、公開API、主要コマンドの引数は変更しません。`update-service-verify`が受け付ける更新phaseだけを拡張します。
このReleaseの公開・installだけでは、CloudflareのWorker・資源・データは変更されません。

## 変更内容

### SQLite Worker更新の検証続行（Issue #11）

- 新規SQLite更新journalをローカルformat`schema_version=2`とし、script PUTの成功応答（ETag）をdeployments GETより前に`deploy_acknowledged`として既存のfsync/atomic replaceで保存します。応答喪失・不正本文・checkpoint保存失敗では先へ進まず、GETに見える現在値だけから成功へ昇格しません。
- 同じ組み込みcodeの別更新を区別するため、送信sourceの末尾に動作を変えない`// castloop SQLite update operation: UPDATE_UUID`コメントを付け、`worker_source_sha256`を**実際の送信source**のhashとして束縛します。operation IDは凍結済みUUIDで、config・metadata・Workerの公開動作・DO schemaは変わりません。
- `update-service-verify`は`deploy_acknowledged`／`deployed`／`verified`を対象に、凍結source/config/metadata、PUT成功ETag、単一100%配備、version、namespace、正確なサーバー側prepared状態を再照合し、新native versionで**初回activation/probeだけ**を行います。PUT・準備・R2 uploadは再送しません。
- `prepared`／`prepare_requested`／`maintenance`／`deploy_requested`の応答不明と`activation_requested`以降は拒否します。旧SQLite `deployed`/`verified`journalは元のsource hash/receiptのまま検証でき、receiptのない旧`deploy_requested`は推測で昇格しません。
- これは元のQueue/R2 GET timeout原因の確定や、旧upload-only journalの復旧、blockedの強制解放を行う修正ではありません。

### CLIアップロードのsource完了順序（Issue #30）

- `freezePayloadSources().withPayload()`が、凍結長に達した最終チャンクを次のiterator readでEOFを確認するまでtransportへ渡さないようにしました。短いsnapshot・余分なbytes・未読・部分消費・途中取消は完了扱いにしません。ファイル全体はbuffer化しません。
- 既存のreceipt・全量readbackのsize/hash/ETag照合、単一PUT、未知IOの自動再送禁止は変わりません。SQLite/Queue共通のsource helperへ適用されます。

### Cloudflare REST URLのエンコード

- account ID、bucket名、Worker名、version IDを`encodeURIComponent`でエンコードします。R2 object keyは`/`区切りを保持したまま各要素だけをエンコードし、区切りを`%2F`へ置換しません。
- 既存schemaの文字種・対象照合は維持し、エンコードを入力検証の代わりにしません。PUTと検証GETは同じURLを使い、CLIが生成する固定key・単一PUT・結果照合は変わりません。

### 管理者キーのネイティブ暗号照合

- 受信値と設定値のUTF-8をSHA-256で32 bytesへそろえ、Workersでは`crypto.subtle.timingSafeEqual`で比較します。標準Web Crypto環境（Bunのローカルテストを含む）では非exportableな一時HMAC-SHA-256鍵で固定長比較を行い、JSのXORループや通常の文字列比較へfallbackしません。
- 認証は非同期になり、全呼び出し元は結果をawaitし、認証成功前にbodyやR2/SQLiteの管理処理へ進みません。空の設定鍵は必ず拒否し、暗号処理失敗時は拒否して固定の診断codeだけを記録します。
- CLIの送信形式、鍵の保存形式・更新手順、各routeの401応答、公開配信・domain runtime probe・Queue署名の認証契約は変更しません。

### 内部整理

- ドメインruntime probeから重複したR2設定読取を削除しました。応答内容・稼働検証条件は変わりません。
- 現行の配備入口から到達しない旧M6試験バイナリとそのbuild分岐を削除しました。
- 完了済みの測定・調査記録を`design/archive/`へ移し、`design/README.md`の索引を現行参照と履歴参照に分けました。AGENTS.mdは常時必要なルールへ整理し、履歴は設計文書へ切り出しました。実行時の挙動変更ではありません。

### 試験修正（Issue #29）

- Worker tailのheartbeat試験を、収集器の期限判定（Bun仮想timer）とnative Bunのping/pong疎通（実timerの2秒watchdog）に分離しました。10ms固定sleepとhealthだけの判定をやめ、ping送信と対応するpong受信を必須にしました。
- `worker-tail.ts`の実装・既定10秒間隔・期限切れのsticky failure・安全条件は変更しません。これは元のCI失敗原因を確定したものではなく、収集器の欠測検知を緩和するものでもありません。

## 互換性・移行

- protocol、service TOML schema version、content schema、公開object key、公開API、主要コマンドの引数はv0.5.1から変更しません。`update-service-verify`が受け付ける更新phaseだけが拡張されます。
- 新規SQLite更新journalのformat `schema_version=2`は、service TOMLのschema version 2や旧Queue更新journalのversion 2とは独立した形式番号です。旧SQLite `deployed`/`verified`journalはformat変換せず検証できます。
- Queue方式からSQLite方式への変換、既存資源の採用、古いSQLite schemaの変換は提供しません。両方式とも、新しいCLIと対応する検証済みWorkerの組で利用します。既存サービスを更新する場合は、従来どおり明示的なpause・drain確認・配備・検証・resumeが必要です。installやRelease公開だけでは配備されません。
- 未知のmutation、残留journal・lock・実行は保持します。時間経過、HEAD不在、drainedだけを根拠に解除・削除しません。

## 既知の制限

- v0.5.1／v0.5.0の制限を継承します。SQLite方式の物理削除、独自ドメイン、既存移行、blocked jobのretry／releaseは未対応です。非公開化はpayloadを保持するため容量を減らしません。
- 新SQLite経路のnative 300MB公開と実機purge rate-limit retryは未検証です。Queue方式の過去の300MB受け入れを流用しません。
- 通常HTTPのCPU測定はv0.5.0までの範囲です。全負荷・全操作のWorkers Free適合や、[Issue #13](https://github.com/simosako/castloop-v2/issues/13)の恒久解消は保証しません。課金・権限・CPU上限は自動変更しません。
- 更新検証続行は、元のQueue/R2 GET timeout原因の確定、未開始activationや未知PUT/POSTの応答不明の復旧、旧upload-only journalの救済、blockedの強制解放を扱いません。旧native versionの反映待ちは有限GETで停止し得ます。
- 素材・staging・運用記録の自動cleanup、subscriber移行、定期RSS同期、無停止更新、万能復旧は対象外です。

## 検証・配布

Release準備の再検証は**1,303テスト合格／0失敗（141 files、87.63秒）**、TypeScript検証、`git diff --check`、Linux単体CLI buildが成功しました。
単体バイナリの`--version`が`0.5.2`を返すことも確認しています。
CIでも全テスト・型・build、tagと版番号の一致、SHA-256、SQLite固有helpと引数不足拒否を含むCLI smokeを確認してから公開します。

更新検証続行の実機確認は、管理者が別途承認した新規隔離SQLiteサービス`i11-d79c5c96`で、製品sourceを変えない試験用transportにより選択したGETだけを送信前に失敗させて行いました。2箇所のGET故障注入から再配備せず続行し、同一code更新2回のETag分離とnative readinessを確認しました。公開0件、最終ready/paused/drainedです。元のtimeout原因確定・旧journal復旧・性能測定ではありません。詳細は[実機検証記録](https://github.com/simosako/castloop-v2/blob/v0.5.2/design/archive/sqlite_update_recovery_verification_20261018.md)を参照してください。
今回のRelease準備に対する新規のCloudflare配備・upload・資源変更は行っていません。上記の実機確認は保持済みの隔離環境に対する別承認の記録であり、後続の公開・更新・cleanupの許可ではありません。

配布対象はLinux x86-64の`castloop-linux-x64`、`SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md`です。
macOS／Windowsは配布対象外です。操作は[README](https://github.com/simosako/castloop-v2/blob/v0.5.2/README.md)、
SQLite方式の詳細は[SQLiteガイド](https://github.com/simosako/castloop-v2/blob/v0.5.2/docs/sqlite_sequential_development.md)、
Queue方式は[Queue方式ガイド](https://github.com/simosako/castloop-v2/blob/v0.5.2/docs/queue_service.md)を参照してください。
