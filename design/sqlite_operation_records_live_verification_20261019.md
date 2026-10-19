# Issue #40: 小規模なCloudflare実機確認

2026-10-19。管理者の指示により、新しい隔離環境で正常公開とプロセス強制終了を確認する。既存環境、DNS、権限、課金・CPU設定は変更しない。

## 対象と方法

- 専用サービス: `i40-d3a0cacd`。新規Worker、private R2、SQLite DOを使用する。
- 音源はプロジェクト内の既存サンプル80,501 bytesをコピーして使用する。原本は保持する。
- 正常公開と再開は、今回ビルドしたLinux単体CLIで行う。
- 強制終了は、正式な`runSqliteCommand`を呼ぶ独立プロセスに試験用transportを渡して行う。WorkerやR2は実環境のまま、選択した実HTTP応答をCLIへ返す直前に待機し、親プロセスがSIGKILLする。
- 音源のPUT成功を保存した後のGET応答と、PUT成功応答を保存する前の2か所で停止する。後者は、実際には保存が成功していても、CLIに成功の証拠がない場合の扱いを確認する試験である。

初期化・公開・再開・強制終了の各記録は、git-ignoredな`.local-test-data/results/20261019/i40-d3a0cacd/`に保存する。管理キー、凍結要求、未公開の操作ID、元journalは公開文書へ転記しない。試験環境と証跡は保持する。

実行バイナリ、製品sourceのsnapshot、workspace、独立した最終照合を含む235ファイルを`final-manifest.json`へ記録した。manifestのSHA-256は`e1800404d758910df8a3a867229742e88b70b316147e1904bc55093a5022acb6`。

## 結果

**正常系と2種類の強制終了試験は通過した。** 製品コードの追加修正は不要だった。

| 確認 | 実機の結果 |
| --- | --- |
| 新規導入 | Linux単体CLIで初期化・明示resume。DO SQLite、Alarm、R2、cache/purgeの稼働確認成功 |
| 正常公開 | ShowとEpisode `normal`を公開し、各jobの`succeeded`を確認 |
| PUT成功保存後のSIGKILL | Episode `resumed`の音源が`put_acknowledged`の時点で強制終了。別の単体CLIによる明示再開で`attached`になり、公開まで成功 |
| 再PUTの防止 | 再開前後でETagとobject versionが一致。音源の`begin_upload`要求は1件のまま |
| PUT成功保存前のSIGKILL | Episode `unknown`は`put_requested`、成功応答なしとして保持。明示再開と取消はいずれも失敗し、開始要求は1件のまま。公開されていない |
| 配信 | 公開した2件を全量取得し、各80,501 bytesと元音源のSHA-256一致を確認。RSSのitem数も2件 |
| 最終照合 | 別プロセスの単体CLIとGETで、ready / paused / drained、queued=0、active=nullを確認。未完了の操作は結果不明の音源1件 |
| DB容量 | ネイティブ`databaseSize`は241,664 bytes。警告は`normal`。アカウント全体の日次使用量は未測定 |

音源のSHA-256は`acb988772a03a89847bc72966b88598d28580de4fd80d510f614f6c59a1ca0d9`。

### 保持した試験環境

| 資源 | 識別情報 |
| --- | --- |
| Worker | `castloop-i40-d3a0cacd-36baef52` |
| private R2 bucket | `castloop-i40-d3a0cacd` |
| SQLite DO namespace | `9bfc3be6b01f49148501a15dbfe93490` |
| Worker version | `b6282add-cba2-4549-914a-cb2e720c3e7c` |

試験後はサービスをpausedにし、資源・元音源・操作記録・証跡を保持した。キューのdrainedは、結果不明の音源の送信終了や削除許可を意味しない。

## 確認範囲

今回確認したのは、小容量音源での正常公開、既知の成功応答からの検証再開、成功応答を失った場合の保留である。故障注入側は試験用transport付きの正式command runner、再開側はビルド済み単体CLIを使った。実行中のPUT接続そのものを途中で切断する試験や、R2の取消保証の検証ではない。

実機での取消成功・素材削除、RSS一括取り込み、300MB音源、CPU・課金行数・全ログの回収は今回の範囲に含めていない。過去の未知PUTを復旧・削除したものでもない。
