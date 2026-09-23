# M0実機プロトタイプ

[`worker.ts`](./worker.ts)は公開受付・R2通知・Queue再試行・Workers Cachingの**検証専用**Worker。公開処理の実装ではない。試験結果と残件は[`../../design/m0_verification_log.md`](../../design/m0_verification_log.md)に記録する。

- [`wrangler.jsonc.example`](./wrangler.jsonc.example)をgit管理外のディレクトリへコピーし、専用のbucket/Queue/DLQ/Worker名に置換する。`main`と`$schema`はコピー先からの実パスに直す。専用bucketとQueueの作成、`staging/` prefix・`commit.json` suffixのR2通知rule作成は別途Wranglerで行う。既存のサービス用リソースを使わない。
- 管理用のランダムなsecret `M0_SECRET`はローカルの保護されたJSONファイル（`{"M0_SECRET":"..."}`）に置く。リポジトリに入れない。`wrangler deploy --config <config> --secrets-file <secret-json>`で配備する。アクセス時は`X-M0-Key`ヘッダーを使い、値をログに残さない。
- 配備前に`wrangler types <generated-types-path> --config <config>`でbinding型を生成し、`wrangler deploy --config <config> --secrets-file <secret-json> --dry-run`で確認する。`/claim`、`/begin`、`/finish`、`/owner`はR2単一オブジェクトの条件付き操作を確認するためのもの。`/begin`も検証専用の管理操作であり、本番ではconsumerだけが`processing`へ遷移させる。`processing → free`は`m0-gate-`の通知を処理するQueue consumer自身が行う。`/events`、`/diagnostics`は通知・再試行を調べるためのもの。`/simulate-write`と`/simulation`は**検証専用の模擬公開キー**への遅延書き込みであり、本番公開処理には使用しない。
- 既存の検証専用リソースを使う場合、`python3 experiments/m0/verify_recovery.py`で条件付き受付とQueue再試行・DLQ・旧通知を検証できる。デフォルトでは`/tmp/opencode/castloop-m0-resources.json`のリソース名と`/tmp/opencode/castloop-m0/secrets.json`の管理secretを読む。専用リソース以外は拒否し、secretは標準出力に表示しない。模擬公開データと停止中Showの実験データは専用bucketに残る。
- `python3 experiments/m0/verify_admission_flow.py`は同じ専用リソースでShow対Episode／Episode対Episodeの並行受付を試す。勝者だけがTOMLをstagingし`commit.json`を最後にアップロードし、R2通知からQueueを経て模擬公開状態になる。敗者にはmarkerとTOMLが残らず、勝者の完了後に新たな受付を試せる。`/flow`は認証付きのR2確認用経路で、実際のfeedは更新しない。
- 完了した実機検証では専用Worker・通知rule・Queue/DLQ・bucketを識別して片付ける。300 MBの実験MP3は検証後にR2から削除済み。実験用の`max_retries: 2`は本番設定ではない。
