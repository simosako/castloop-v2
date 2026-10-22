# castloop v0.7.1

v0.7.0後のコードレビュー修正（PR #54〜#59）を含むLinux x86-64向けpatch releaseです。Show単位のSQLite FIFO・Alarm・Pause/ResumeとFeed継続配信を維持します。インストールだけではCloudflareのWorker・資源・公開状態は変わりません。

## 変更内容

- **公開容量の事前検証**：追加・更新・復元後のEpisode一覧とFeed予算を公開書込前に検査し、超過は`validation_failed`として扱う。予算超過で後続の公開・非公開化を止めない。
- **RSS事前検証**：取り込み後に編集されたShow/Episodeの項目別入力上限を、素材走査・管理IO・公開journal作成より前に検査する。
- **ローカル操作記録**：永続lock sidecarをupload件数へ数えず、単一IDの照会は対象familyとjournalへ限定する。大量履歴の全走査がすべて解消されたわけではない。
- **一覧と読取処理**：サービスのShow一覧に架空のpaused状態を表示しない。上限付きHTTP読取を共通化し、読取専用Show照会を最大4件ずつ並行化する。変更操作は逐次実行のままで、native性能改善は未測定。
- **観測・セキュリティ・CI**：観測guardが現行APIのerror event・HTTP失敗を検知する。緊急停止手順をShow単位の正式コマンドへ修正し、リリースActionsをupstreamの完全commit SHAへ固定する。

## 互換性と更新

- サービス設定schema version 2、`sqlite-sequential-v1`、必須`storage_layout="show-v1"`、内部queue/content schema **5/6**、公開API・object key・履歴形式はv0.7.0から変更しない。共有content/request schema version 1も引き続き対応する。
- 対応するv0.7.0環境の同config/schema/namespace更新は既存のcode-only更新手順を使う。全Showを明示Pauseしてdrainし、正式`deploy`で検証する。これは別途管理者が実行する操作であり、今回のリリースで配備しない。
- v0.6.2以前の旧layoutや途中段階のshow-v1環境の採用・移行・fallbackは提供しない。旧journalは対応する旧CLI/sourceも保持し、凍結要求を別binaryで再送しない。
- 物理削除・独自ドメイン・blocked jobのretry/releaseは未提供。既存音源・snapshot・操作記録を自動削除しない。

## 検証と既知の制約

- 修正統合後のローカル回帰は**571 pass / 0 fail**、型・未使用宣言check成功。統合mainのGitHub CIもbuild・Linux binary smokeに成功した。リリース版binaryはタグ時のCIでもversion・checksum・正式CLI入口を検証する。
- 新規隔離環境の2 Show・合成音源3件で公開・更新・非公開化・復元の**11 jobが成功**し、最後に両ShowをPauseして配信停止を確認した。これはバージョン表記更新前の同じ製品修正一式の実機確認であり、リリース版binaryを新たに配備した試験ではない。
- **観測検証は未完了**。音源UUIDの秘匿化と試験のpath完全一致条件の不適合を特定した。tail欠測の元の404/409は保存ログで回収したが、tail配送の内部原因と`sqlite_service_control`診断1件の欠落は未確定。
- 保存ログのcanceled Alarmは、同じDO・version・予定時刻の成功Alarmの291ms後で、成功後の重複配送を実行前に取り消した説明が有力。platform内部の取消理由や全過去IOのsettlementまで証明したものではない。
- 容量境界のnative負荷試験、大量履歴、切断・不明PUT故障注入、300MB公開、全Free適合は未検証。単一PUTのU1も未検証の仮定のまま。

詳細は[修正一覧](../design/code_review_fixes_20261022.md)、[実機確認](../design/archive/code_review_fixes_live_verification_20261022.md)、[観測調査](../design/archive/review_observation_investigation_20261022.md)、[SQLite操作ガイド](sqlite_sequential_development.md)を参照してください。

## 配布

GitHub Releaseの`castloop-linux-x64`、`SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md`を取得してください。管理端末にBun・Node.js・Wrangler・別R2 credentialsは不要です。macOS/Windows向けbinaryは配布しません。
