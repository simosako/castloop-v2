# ワークスペースのバックアップと復元

設定、管理キー、番組の編集ファイルを暗号化して保存します。管理端末を移すときや、手元のファイルを復元するときに使います。

## 1. 保存するものを確認する

主な保存対象は次のとおりです。

| ファイル | 保存内容 |
| --- | --- |
| `castloop.toml`、`castloop-admin.toml` | サービス設定と管理用設定 |
| `.castloop/` の管理キー・対応する操作記録 | サービスの管理に使う情報 |
| 番組フォルダ直下のTOML・カバー・CSSなど | 手元の編集ファイル |
| 番組フォルダ直下のMP3 | `--include-audio` を付けた場合に保存 |

このバックアップの対象は、手元のワークスペースです。

番組フォルダ以外に置いた音声原本や、RSS取り込み中のフォルダは別途保存します。

## 2. バックアップを作る

ワークスペースでの編集やコマンドの実行を終えてから、新しい保存先を指定します。

```sh
castloop backup-create --workspace /path/to/workspace --output /path/to/backup.clbk
```

パスフレーズを求められたら入力します。復元時に使うため、パスフレーズはバックアップファイルとは別の安全な場所に保管してください。

番組フォルダ直下のMP3も保存する場合は、`--include-audio` を付けます。

```sh
castloop backup-create --workspace /path/to/workspace --output /path/to/backup-with-audio.clbk --include-audio
```

実行結果の保存ファイル一覧と除外一覧を確認します。必要な原本が除外されていた場合は、そのファイルも別途保存してください。

## 3. バックアップを検証する

```sh
castloop backup-verify /path/to/backup.clbk
```

作成時のパスフレーズを入力します。検証結果でファイルの整合性と `config_valid` を確認してください。確認できたバックアップを安全な保管先へコピーします。

管理キー、設定、編集ファイルを変更したときは、新しいバックアップを作成します。

## 4. 別の場所に復元する

まず復元内容をプレビューします。復元先には、まだ存在しないフォルダ名を指定します。

```sh
castloop backup-restore-preview /path/to/backup.clbk --dest /path/to/new-workspace
```

保存先とファイル一覧を確認してから復元します。`confirm` はそのまま入力してください。

```sh
castloop backup-restore /path/to/backup.clbk /path/to/new-workspace confirm
castloop doctor --local --workspace /path/to/new-workspace
```

復元したワークスペースで管理キーと設定を確認できたら、その場所を使って管理を続けられます。

未完了の操作記録がある場合は、[中断後の確認手順](troubleshooting_ja.md#操作が中断した場合)で現在の状態を調べてから続行してください。

## 自動処理で使う場合

`--json` や `--non-interactive` で実行する場合は、パスフレーズをUTF-8のファイルに保存し、`--passphrase-file /path/to/pass.txt` を付けます。ファイルは本人だけが読めるように保護してください。
