# castloop v0.2.1

ShowとEpisodeの読み取り専用一覧を追加した、Linux x86-64向けCLIのリリースです。

## 変更

- `castloop list-shows`: Show ID、状態、タイトル、未完了操作の有無、Feed URLを表示します。
- `castloop list-episodes SHOW_ID`: 指定ShowのEpisode ID、状態、タイトル、公開日時を表示します。SHOW_ID省略はエラーです。
- 両コマンドで、表形式／`--json`、削除済みIDを含める`--include-deleted`、次ページを取得する`--cursor TOKEN`に対応しました。
- 既存の認証・サービス稼働確認を再利用します。一覧は読み取り専用で、データ、lock、ownerを変更しません。

## 利用・更新時の注意

- 一覧機能には**v0.2.1のCLIと、そのバイナリで配備したWorkerの両方**が必要です。CLIの置換やRelease公開だけでは既存Cloudflareサービスは更新されません。
- v0.2.0のM6サービスは、workspaceと管理記録を保管し、明示的なpause・処理終了確認 → v0.2.1で`deploy` → 検証 → 明示resumeの手順で更新します。データ形式の変換はありません。
- サービスworkspaceから実行してください。一覧取得にはローカルの管理鍵が必要ですが、Cloudflare API tokenは不要です。Worker更新には従来どおりCloudflareの管理用認証が必要です。
- 一覧はサーバー側の制御記録が対象です。ローカルTOMLだけのEpisode下書きは含みません。削除済みは通常表示から除外しますが、削除処理中は表示します。
- 1回につき最大20制御記録を取得します。削除済みを除外した結果、空のページでも次ページがある場合があります。返されたcursorで、同じShow／オプションを指定して続けてください。
- タイトルは最大100文字の要約です。大きい／不正／未取得のmetadataや未完了操作等では、タイトル・日時が表示できないことがあります。親Showの停止やサービスのpauseは、Episode自身の状態と区別します。
- 表示は原子的なsnapshotでも、配信可能性や変更操作の許可を保証するものでもありません。音源・revision履歴の読み込みや、強制unlockは行いません。

## 検証・配布範囲

一覧API・正式CLIの自動テストを含む903テスト、TypeScript検証、Linuxバイナリのビルド・起動・新コマンドhelp・SHOW_ID省略エラーを確認しました。新しい一覧経路のCloudflare実機受け入れは未実施です。M6の既存受け入れ範囲と復旧の制約は維持します。

独自ドメイン、ローカル下書き・操作一覧、予約公開、統計、一般的なcleanupは今回の追加範囲に含みません。Linux x86-64バイナリ、SHA256SUMS、MIT License、第三者ライセンス通知を配布します。

操作例と更新手順は[README](https://github.com/simosako/castloop-v2/blob/v0.2.1/README.md)、設計・検証範囲は[管理機能の記録](https://github.com/simosako/castloop-v2/blob/v0.2.1/design/podcast_management_features_draft.md)を参照してください。
