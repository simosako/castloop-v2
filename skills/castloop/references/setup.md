# 新規サービスとShow

`describe init`で必要値と副作用を確認する。管理者からservice ID、Cloudflare account、未使用bucket名、workers.dev subdomain、作成・配備範囲を確認する。tokenは環境変数で設定し、チャットへ貼らせない。

`castloop init ABSOLUTE_PATH --service-id ID --account-id ID --bucket-name NAME --workers-subdomain NAME --non-interactive --json`は資源作成・配備・稼働確認を行う。既存資源の採用・移行は禁止。必要値は変更開始前に揃える。試験環境はサンプルを置かずに初期化し、素材配置前にアクセス保護を確認する。

初期化の中断後は元の設定・`.castloop/`を保持し、同じ保存先へ`castloop init ABSOLUTE_PATH --non-interactive --json`を実行する。保存した入力を使うため、初回の作成用フラグを付け直さない。

Showはタイトル、説明、言語、著者、所有者名・メール、カテゴリ、explicit、実在のsite URL（または`--site-mode builtin`）、JPEG/PNG画像を確認する。`template show`はオフラインの例示であり回答の代わりではない。

登録承認後、`create-show ID --site-url URL --workspace PATH --non-interactive --json`でShow IDの確保・リモート登録・ローカル作成を行う。内蔵サイトなら`--site-url URL`の代わりに`--site-mode builtin`を使う。登録したShowは即座に稼働準備完了（`publication_ready: true`）となる。生成された`SHOW/show.toml`を確認済み情報で編集し、画像を配置する。既存Showの更新で作成コマンドを実行し直さない。

`validate show ABSOLUTE_TOML --assets --json`で検証する。登録・uploadだけでは公開しない。

`preview-show ID --workspace PATH --remote --json`で内容と`input_fingerprint`を確認・承認し、その値を`publish-show ID --workspace PATH --expect-preview HASH --json`へ渡す。`changed`／`unchanged`とrevisionを確認してFeed URLを報告する。公開は[手順](publish.md)、中断は[復旧](recovery.md)を参照。
