# castloop v0.1.2

Linux x86-64向けCLIの修正リリースです。

## 修正内容

- 全サブコマンドで`--help`・`-h`と`help COMMAND`に対応しました。ヘルプは設定ファイルや認証情報なしで表示でき、Cloudflareへの接続やリソース作成は行いません。
- 初回`init`のWorker health待機を、約10秒で使い切る6回固定の再試行から、通信時間を含む最大2分の待機へ変更しました。404・429・5xx・通信失敗を5秒間隔で再試行し、待機状況と残り時間を表示します。認証エラーは即時停止します。
- READMEと別マシンでの動作確認手順を更新しました。

## 配布物と更新

配布対象は**Linux x86-64のみ**です。`castloop-linux-x64`、`SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md`を取得し、同じディレクトリで`sha256sum --check SHA256SUMS`を実行してからインストールしてください。`castloop --version`は`0.1.2`と表示されます。

検証先にNode.js/npm、Bun、Wrangler、`ffprobe`、R2 S3 credentialsは不要です。既存workspaceを更新する場合は`castloop.toml`と非公開の`.castloop/`を保持してください。Workerの更新は各サービスworkspaceから`castloop deploy`で行います。`init`が途中で止まった場合は同じworkspaceでフラグなしの`castloop init /path/to/workspace`を再実行できます。完了済みの作成手順は保持されます。

## 対象外・検証範囲

- 独自ドメイン対応は開発中です。基礎コードは含まれますが、`domain add/list/remove`は利用できません。今回の公開URLは引き続き`workers.dev`です。
- feedの音源URLは保存済みpathを検証して現在の公開基点から生成します。既存のimmutable音源・改訂履歴は書き換えません。
- v0.1.1の外部環境テストで判明した問題を修正しました。修正版のCloudflare上での初回反映待ちは、実機再試験が必要です。
- Cloudflareリソース作成成功後にAPI応答を失った場合の自動reconcileや、恒久失敗jobの安全なabandonは引き続き未実装です。

プロジェクトはMIT Licenseです。バイナリ再配布時は`LICENSE`と`THIRD_PARTY_NOTICES.md`を同梱してください。
