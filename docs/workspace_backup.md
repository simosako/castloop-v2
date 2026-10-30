# ワークスペースのバックアップと復元

管理キー、設定、編集元、操作記録を暗号化ファイルへ保存し、別の場所へ復元します。4つのコマンドはいずれも**通信せずローカルだけで動作**し、Cloudflare API認証用の環境変数を読みません。対象は[現行形式](README.md#対象と用語)のワークスペースです。

**R2のメディアと、サーバーのSQLite（公開内容・履歴・予約・統計）は取得しません。** サービス全体の災害復旧用バックアップではありません。管理キーの再発行機能はないため、`.castloop/` を含むワークスペースを保全してください。

```sh
castloop backup-create --workspace /abs/workspace --output /abs/backup.clbk --passphrase-file /abs/pass.txt
castloop backup-verify /abs/backup.clbk --passphrase-file /abs/pass.txt
castloop backup-restore-preview /abs/backup.clbk --dest /abs/new-workspace --passphrase-file /abs/pass.txt
castloop backup-restore /abs/backup.clbk /abs/new-workspace confirm --passphrase-file /abs/pass.txt
```

## 対象と除外

| 対象 | 扱い |
| --- | --- |
| `castloop.toml`、任意の `castloop-admin.toml` | 保存 |
| `.castloop/secrets.json` と対応する操作記録 | 管理キーを含めて保存。対象記録は[保存構造](../design/data/storage.md)を参照 |
| Show直下のTOML・カバー・CSS等の通常ファイル | 保存。サブディレクトリは対象外 |
| Show直下のMP3原本 | **既定で除外**。`--include-audio` 指定時だけ保存 |
| ロック・一時ファイル、再生成する `.gitignore` | 除外 |
| 未知のファイル・記録種別 | `unknown` として除外。必要なものは別途保存 |

除外は実行結果とマニフェスト（対象ファイル等の一覧）に記録します。作成・検証後に必ず確認してください。対象として走査する記録・Showディレクトリ内にシンボリックリンクがあれば、作成を拒否します。古い記録形式は変換しません。

RSS取り込みの出力先は `castloop.toml` を持たないため対象外です。公開完了までは、取り込み元のTOML・素材・`.castloop/` を別途保全してください。元フィードからの再取得では、手元の編集や取り込み進捗までは復元できません。

## パスフレーズ

パスフレーズはUTF-8で8〜1024 bytesです。`--passphrase-file` または対話端末のプロンプトから入力します。作成時のプロンプトは2回確認します。ファイルは0600権限を推奨し、末尾の改行は1つまで無視します。`--json`・`--non-interactive` ではファイル指定が必須です。パスフレーズを直接指定する引数や環境変数はありません。

内容はAES-256-GCMで暗号化しますが、ヘッダーのサービスID・日時・件数等は平文です。アーカイブとパスフレーズを適切に保管してください。誤パスフレーズと暗号データ破損は同じ固定メッセージで報告します。

**パスフレーズを忘れるとアーカイブは復元できない。**管理キーと同じく、再発行の手段は存在しない。

## 作成と頻度

最初の例の `backup-create` で、指定した新規ファイルへ保存します。管理キー・設定・編集元が変わったときは、それらを失わない頻度で保存してください。

音源原本も保存する場合は `backup-create --include-audio` を指定します。対象はShow直下のMP3で、別ディレクトリの原本まで自動収集するものではありません。未公開音源を含め、失えない原本をどこで保全するか確認してください。

**バックアップ中は、ワークスペースの編集や他の変更操作をしないでください。** 個別記録の原子的な置換は、バックアップ全体が同じ時点の状態であることまでは保証しません。

## 検証

`backup-verify` は全体を復号して、ファイルのハッシュ・一覧・暗号データの整合性を検証します。サービス設定の妥当性は `config_valid` で報告します。保存ファイルと除外一覧、未完了のドメイン変更（`pending.domain_changes`）、その記録を走査できなかった場合の `scan_errors` を確認してください。

検証成功が示すのはアーカイブの整合性です。サーバー状態の復旧、応答不明の要求の解消、公開成功は保証しません。

## 復元

`backup-restore-preview`は何も書かずに展開予定(パス・size・衝突検査)とmanifest要約を表示する。`backup-restore`は**存在しないパス**だけに展開し、`..`・絶対パス・重複パスを含むアーカイブを拒否し、展開したファイルのhashをmanifestと照合する。失敗した場合は部分展開先を残さず破棄する。`castloop.toml`は必ず先頭エントリで、その検証に成功するまで他のファイルを書かない。

復元したworkspaceはconfig hash・管理キー・client_idが同一のため、同一サービスの管理をそのまま継続できる。復元後は`castloop doctor --local --workspace DEST`で管理キーの読取を確認する。

復元だけではリモート操作を再送・継続しません。未完了のドメイン変更は `domain status OPERATION_UUID --workspace DEST` で確認し、対象と範囲の承認後に[専用手順](custom_domains.md#照会と中断後の継続)で `domain continue` を実行します。公開の応答不明は、[現在内容を確認して同じ承認済み入力で再実行](troubleshooting.md#操作が中断した場合)します。

内部の暗号化・保存形式は[バックアップ設計](../design/components/workspace-backup.md)に記載しています。
