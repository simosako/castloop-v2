# castloop v0.6.1

> 旧版のリリース記録です。現行の操作は[利用ガイド](../../README.md)を参照してください。

v0.6.0のSQLite単独構成を維持したまま、新規Show/EpisodeメタデータにApple基準の項目別入力上限を追加したLinux x86-64向けCLIです。保存用schemaとschema versionは変更しません。インストールだけでは配備済みWorker・資源・公開状態は変更されません。Cloudflareへの配備は別の明示操作です。

## 変更内容（Issue #31）

- 新規入力にだけ上限を適用する。Show説明4000 UTF-8 bytes、Episode説明10000文字、title/author/owner_name/owner_email/categories要素/copyrightは255文字、site_urlは2048文字。
- 測定はtrim後・HTML tag除外後のテキストで、文字はUnicode code point数とする。解釈に迷うところは大きい方を取り、ホスト互換の4000ではなくApple RSSの10000をEpisode説明に採用した。
- 適用点はCLI stage時、Worker公開実行時（超過は書込前の`validation_failed`）、RSS取込の`missing_fields`報告。超過分は切り詰めず、項目名付きで拒否する。取込TOMLは無加工で保存し、編集後の再審査を求める。
- 保存用`showMetadataSchema`／`episodeDraftSchema`／`episodeRevisionSchema`と`parseShowMetadata`／`parseEpisodeDraft`は無制限のまま維持する。超過した保存済みsnapshot/revisionの読取・復元は引き続き可能。一覧表示の200文字表示切り詰めも変更しない。

## 互換性・移行

- protocol、service TOML schema version、content/request schema version、公開object key、公開API、主要コマンドの引数はv0.6.0から変更しない。保存データの移行・変換は不要で、既存履歴の書換えも行わない。
- 唯一の挙動変更は、従来は全体上限（TOML 1M、RSS 8M、取込準備8M/rendering換算32M）でのみ止まっていた巨大項目が、早期に項目名付きで拒否されることである。正規範囲内の既存入力・既存公開物の再公開には影響しない。
- Queueサービスは引き続き対応するv0.5.x CLI/Workerで管理する。移行機能は提供しない。

## 検証・性能情報

- ローカル421テスト成功、TypeScript検査clean。配布binaryのbuild・smokeはタグ時のGitHub CI（`build-binaries.yml`）で確認する。
- 本版はWorker実行部の検証追加を含むため、組み込みWorker sourceはv0.6.0の実機合格時hashと一致しない。v0.6.1としての新規Cloudflare隔離試験は行っておらず、v0.6.0の36件公開・CPU記録を超える実機保証は追加しない。
- ローカル試験はnative性能、全Free適合、300MB実機公開や万能復旧を保証しない。保存ログの全件回収、全Free適合、U1解決や万能復旧は保証しない。

## 配布

GitHub Releaseの`castloop-linux-x64`、`SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md`を取得してください。管理端末にはBun・Node.js・Wrangler・別R2 S3 credentialsは不要です。macOS/Windows向けbinaryは配布しません。
