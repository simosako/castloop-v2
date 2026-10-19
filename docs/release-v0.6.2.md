# castloop v0.6.2

v0.6.1のSQLite単独構成と入力上限を維持したまま、サーバー側の操作記録、中断後の再開、取消、未公開staging素材の確認削除を追加したLinux x86-64向けCLIです。サービス設定schema versionとcontent/request schema versionは変更しません。インストールだけでは配備済みWorker・資源・公開状態は変更されません。Cloudflareへの配備は別の明示操作です。

## 変更内容（Issue #40）

- 既存DO内のSQLiteに操作・要求・素材・履歴・形式管理の5表を追加する。CLIはupload前に操作を登録し、PUT開始、PUT成功応答、検証、下書き登録を記録する。公開の受付・実行・完了履歴は既存キューのトランザクションへ接続する。
- 新規コマンドは`operation-list`、`operation-status`、`operation-resume`、`operation-cancel`、`operation-cleanup-preview`、`operation-cleanup`である。一覧・詳細・容量表示は読取専用で、journalやロックを変更しない。`--local`は手元の記録だけを読み、`--remote`は管理キーでサーバーへGETする。
- 再開は凍結した入力・Worker・受付window・下書きを照合して続行する。PUT成功応答が保存済みなら同じR2 objectを読み戻して検証し、PUTを繰り返さない。成功応答のない`put_requested`、結果を確認できない変更要求、変更された入力は保留し、同じPUTの再送・取消・削除を拒否して記録を保持する。
- RSS取り込みは全体を親操作、upload・公開・登録を子操作として記録する。再実行は完了済みの公開を再送せず、保存済み要求の照会と検証済み素材から続行し、GUID・公開日時・音源の識別情報を維持する。
- 取消後の未使用staging素材だけを、プレビューと確認hashを経て明示的に削除できる。サーバーは対象の確定と利用禁止を同じSQLiteトランザクションで保存し、R2の識別情報を再照合して削除する。削除結果は`deleted`または`unknown`として残し、完了を確認できない場合は後続の削除を停止する。
- 容量表示はDOの`databaseSize`を`database_bytes`とし、1GBを計画上限として50%で`half`、70%で`high`、85%で`critical`を警告する。自動期限削除や記録表全体の整理は行わない。操作あたりの計画値は20KBのまま維持する。
- 新規のローカル記録形式番号は2を使う。変更中はローカルSQLiteの`BEGIN EXCLUSIVE`で排他し、旧形式の`.lock`は保持する。既存の下書き形式1や未知の旧記録を形式2へ変換しない。
- 診断は固定のallowlistコード・許可した識別子だけを保存し、タイトル・説明・メール・元ファイルのパス・秘密・任意例外文を運用記録へ複製しない。

## 互換性・移行

- protocol、service TOML schema version、content/request/revision schema version、公開object key、公開API、既存の主要コマンドの引数はv0.6.1から変更しない。保存データの移行・変換は不要で、既存履歴の書換えも行わない。
- 操作記録を使うには対応するCLIとWorkerの両方が必要である。旧Workerには操作記録表がなく、新CLIの`--remote`確認・再開・取消・削除は使えない。逆に旧CLIでは新Workerの操作記録を参照しない。
- 唯一の挙動追加は、upload・RSS公開経路が操作記録を書き、RSS再実行が完了済み公開の再送を避けることである。正規範囲内の既存入力・既存公開物の再公開には影響しない。
- Queueサービスは引き続き対応するv0.5.x CLI/Workerで管理する。移行機能は提供しない。物理削除、独自ドメイン、blocked retry/release、未登録uploadの一般cleanupは未提供のままである。

## 検証・性能情報

- ローカル443テスト成功、TypeScript検査clean。配布binaryのbuild・smokeはタグ時のGitHub CI（`build-binaries.yml`）で確認する。
- ローカルではSQL制約・状態確認・応答喪失・公開接続・同時操作・削除・保持・RSS逐次・容量警告・診断除外に加え、正式CLI entrypointの独立プロセス試験と、Linux単体実行形式での同時取得拒否・SIGKILL後の取得確認を行った。2素材×100操作の追加ではDB容量が909,312 bytes増加し、操作あたり約9.1KBだった。これはBun内蔵SQLiteの測定であり、Cloudflareの課金行数やDO内部管理データの再現ではない。
- 小規模な新規Cloudflare隔離環境（`i40-d3a0cacd`、80,501 bytes音源）で、正常公開、PUT成功保存後のSIGKILLからの検証再開とETag・version一致、PUT成功保存前のSIGKILLでの再送拒否と未公開保持を確認した。最終状態はready/paused/drainedで、DB容量は241,664 bytesだった。RSS一括取り込み、300MB音源、取消成功・素材削除の実機確認、CPU・課金行数・全ログ回収は今回の範囲に含めていない。
- ローカル試験はnative性能、全Free適合、300MB実機公開や万能復旧を保証しない。保存ログの全件回収、全Free適合、U1解決や万能復旧は保証しない。

## 配布

GitHub Releaseの`castloop-linux-x64`、`SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md`を取得してください。管理端末にはBun・Node.js・Wrangler・別R2 S3 credentialsは不要です。macOS/Windows向けbinaryは配布しません。
