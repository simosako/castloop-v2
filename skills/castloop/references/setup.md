# 新規サービスとShow

`describe init`で必要値と副作用を確認する。管理者からservice ID、Cloudflare account、未使用bucket名、workers.dev subdomain、作成・配備範囲を確認する。tokenは環境変数で設定し、チャットへ貼らせない。

`init ABSOLUTE_PATH --service-id ID --account-id ID --bucket-name NAME --workers-subdomain NAME --non-interactive --json`は資源作成・配備・health確認を行う。既存資源の採用・移行は禁止。必要値は変更開始前に揃える。

Showはタイトル、説明、言語、著者、所有者名・メール、カテゴリ、explicit、実在のsite URL（または`--site-mode builtin`）、JPEG/PNG画像を確認する。`template show`はオフラインの例示であり回答の代わりではない。

登録承認後、`create-show ID --site-url URL --workspace PATH --non-interactive --json`で予約・リモート登録とローカル作成を行う。登録したShowは即座に稼働準備完了（`publication_ready: true`）となる。生成された`SHOW/show.toml`を確認済み情報で編集し、画像を配置する。

`validate show ABSOLUTE_TOML --assets --json`で検証する。登録・uploadだけでは公開しない。

`preview-show ID --workspace PATH --remote --json`で内容を確認・承認し、`publish-show ID --workspace PATH --expect-preview HASH --json`で公開する。`changed`／`unchanged`とrevisionを確認してFeed URLを報告する。公開は[手順](publish.md)、中断は[復旧](recovery.md)を参照。
