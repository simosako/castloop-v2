# castloop v0.7.0

> 旧版のリリース記録です。現行の操作は[利用ガイド](../../README.md)を参照してください。

Show単位のDurable Object分離と、公開中の更新を妨げないFeed継続配信を追加したLinux x86-64向けCLIです。サービス設定の`storage_layout = "show-v1"`を必須とし、配布済みv0.6.2のサービス単位layoutとは非互換です。サービス設定schema version 2、共有content/request schema version 1、公開object keyと公開APIは変更しません。インストールだけでは配備済みWorker・資源・公開状態は変更されません。Cloudflareへの配備は別の明示操作です。

## 変更内容

### Show単位のDO分離（Issue #48、PR #51）

- 各Showを独立したSQLite-backed Durable Objectに分離する。ShowごとのFIFO・Alarm・受付windowを持ち、異なるShowのIO待機は並行できる。所属と共有Worker更新の進行は小さい制御DOが管理する。
- Pause/ResumeをShow単位に変更する。新規登録Showはpausedで開始し、明示的な個別Resumeが必要である。サービス全体のPause/Resumeは廃止した。
- `blocked`は該当ShowのFIFOと配信だけを停止する。他のShowは操作・Pause/Resume・新規登録を独立して続行できる。ただしblocked Showが1つでもあると共有Worker更新は開始できない。
- サービス設定に`storage_layout = "show-v1"`を必須とする。欠落・旧値・未知値は管理要求・配備・鍵/journal作成より前に拒否する。
- remote操作記録コマンド（`operation-status --remote`等）は`--show SHOW_ID`を必須にする。`--local`と保存済みlifecycle jobの照会はShow指定不要である。

### Feed継続配信（Issue #50およびその継続、PR #52）

- Episode追加、Episode更新、公開済みShowのmetadata/cover更新のいずれの実行中も、確定済みFeed・cover画像・承認済み音源を読み取れる。
- Feedとcoverはprivate R2の世代別・不変snapshotへ保存する。検証済み書き込みと必要なcache purgeが完了した後、同じSQL transactionでmetadata・cover参照・Feed世代を切り替える。公開URLは変わらない。
- cover URLは不変である。切替をまたぐ別HTTP要求間のsnapshot一貫性は保証しない。画像だけの編集ではFeed bytes/ETagが同じまま304になり得る。公開済みcoverの拡張子変更は対応しない。
- 隔離を確認できる`blocked`では旧内容を配信するが、job・後続FIFOの停止、Resume/共有配備の禁止、未知IO保全は変わらない。Show初回公開とlifecycle実行に継続配信の例外はなく、Pause/readiness/保守拘束の503は優先する。
- 旧世代snapshot・旧音源・revision履歴は自動削除しない。この機能には内部queue/content schema **5/6**、healthの`feed_storage`と`cover_storage`が共に`immutable-generation-v1`、`publication_read_boundary="show-episode-v1"`を必要とする。

### 診断とドキュメント

- 初期化/更新probe失敗に`probe_stage`を、cache purge失敗に`failure_kind`（`call_threw`/`invalid_acknowledgement`）と型だけの応答分類を追加した。サービスID・実行Worker version・config hash・操作IDも記録する。秘密値・任意例外文・内容テキストは運用記録へ保存しない。
- 共有Worker更新は新layoutでの実機確認を経た。native反映待ちで停止した場合も、保存済みcheckpoint照合の上で正式`update-service-verify`から検証と未開始activationを続行できる。配備・prepare・未知activationの再送は行わない。
- READMEにbadges・status・disclaimerを追加し、CONTRIBUTING/SECURITY/CODE_OF_CONDUCTとCHANGELOG索引を整備した。Issue #40/#48の試験環境廃棄と証跡保持を記録した。

## 互換性・移行

- **v0.7.0は新規`show-v1`環境専用である。** 配布済みv0.6.2の旧layout、および内部schema 1〜4の途中段階のshow-v1環境からの互換更新・移行機能は提供しない。旧環境へlayout fieldを追記して回避することも意図していない。
- サービスTOML schema version 2、共有content/request schema version 1、公開object key、公開API、既存の主要コマンド引数は変更しない。保存データの変換は不要で、既存履歴の書換えも行わない。remote操作記録コマンドの`--show`必須化が唯一の引数変更である。
- v0.6.2までの配布済みCLI/WorkerはShow分離・Feed継続配信を持たない。逆にv0.7.0は旧layout環境を管理できない。
- Queueサービス（schema version 1）は引き続き対応するv0.5.x CLI/Workerで管理する。移行機能は提供しない。物理削除、独自ドメイン、blocked jobのretry/release、未登録uploadの一般cleanupは未提供のままである。

## 検証・性能情報

- ローカル: `bun test` 549 pass / 0 fail（63 files）、`npm run check`、`npm run build:cli -- linux-x64`が成功。配布binaryのbuild・smokeはタグ時のGitHub CI（`build-binaries.yml`）で確認する。
- Show分離の実機確認（新規隔離環境・小規模）: 2 Show・6 Episodeの公開、個別Pause/Resume、feed/cover/audio配信のhash・ETag・HEAD・Range・304確認に成功した。初回はcache purgeの成功確認で停止したが、診断改善後の別環境再試験で公開・配信・個別Pause/Resumeを確認した。初回障害の根本原因は未確定である。
- 共有Worker更新の実機確認: 2 Show・6 Episodeを保持するcode-only更新で、native反映待ちによる2回の停止後に再配備せず明示verifyを続行し、全DOの新version・probe・保守解除・更新後の個別Resumeと公開2件・最終pausedを確認した。
- Feed継続配信の実機確認: Episode追加・Episode更新・Show更新の各段階で、取得前後ともrunningだった要求組において旧Feed 200/304・旧画像・候補新音源404を確認し、完了後の切替とhash一致を確認した。nativeのblocked故障注入・CPU/負荷測定は行っていない。
- 実機試験に使った隔離環境は試験後に廃棄した。ローカル原本・journal・私有証跡は保持している。ローカル試験はnative性能、全Free適合、300MB音源の実機公開、万能復旧を保証しない。単一PUTのR2強整合（U1）は未検証の仮定のままである。

## 配布

GitHub Releaseの`castloop-linux-x64`、`SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md`を取得してください。管理端末にはBun・Node.js・Wrangler・別R2 S3 credentialsは不要です。macOS/Windows向けbinaryは配布しません。
