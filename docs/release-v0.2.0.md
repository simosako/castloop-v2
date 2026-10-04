# castloop v0.2.0

M6機能を備えたLinux x86-64向けCLIのリリースです。

## 変更

- 新規M6サービスの初期化、認証付き稼働検証、paused完了と明示再開。
- Show/Episodeの公開停止・復元・不可逆削除。削除はpayloadを物理削除し、必要な小さい操作記録と削除済みIDを永久保持します。
- 公開配信の状態検査・cache再検証、owner/generation/token付き受付とQueue処理。
- データ形式を変えないM6 Worker更新。停止・処理終了確認・配備/検証後もpausedで完了します。
- 300,000,000-byte MP3対応。完全性検証はCLIの全量読み戻しとR2のSHA-256検証へ集約し、Worker内の全量再ハッシュを除きました。Paid契約は変更していません。
- 正式CLIと試験CLIが既存runnerを共有し、旧CLIの重複処理を削減しました。

## 利用上の変更と上限

- v0.1.x workspaceの自動変換・既存資源の採用はありません。新規M6 workspaceを作成してください。既存資源の削除は自動実行しません。
- 音源をstageしたEpisodeの公開は`publish-episode ID MP3`、metadata-onlyは`publish-episode ID`です。`job-status JOB`/`retry-job JOB`にはShow/Episode flagsを付けません。
- lifecycleはプレビューJSONとrequest hashを確認し、`lifecycle-execute`で明示承認します。削除には`confirm-delete-retain-records`が必要です。
- 不明なIO/残存lockは停止・ブロックを保持します。万能な復旧、強制unlock、時間経過によるtoken解放はありません。
- staging音源の一般cleanup、旧形式変換、独自domain、無停止更新、費用/停止時間測定は今回の範囲外です。

操作例・復旧可能な範囲は[README](https://github.com/simosako/castloop-v2/blob/v0.2.0/README.md)、検証の証拠と限定条件は[M6受け入れ記録](https://github.com/simosako/castloop-v2/blob/v0.2.0/design/m6_standalone_acceptance.md)を参照してください。Linux x86-64のみを配布対象とし、MIT Licenseと第三者ライセンス通知を同梱します。
