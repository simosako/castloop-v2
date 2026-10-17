# castloop v0.5.1

v0.5.0のSQLite逐次公開方式と既存Queue方式を維持したまま、RSSテキストの検証強化、workspace設定の安全な読み取り、レビューで見つかった未到達実装の削除と共通処理の集約を行ったLinux x86-64向けCLIです。
protocol、TOML schema、R2 object key、公開API、主要コマンドの引数は変更しません。
このReleaseの公開・installだけでは、CloudflareのWorker・資源・データは変更されません。

## 変更内容

### RSSへ出力するテキストのXML 1.0検証

- Showのタイトル・説明・作者・所有者名・メール・カテゴリ・サイトURL・著作権表記と、Episodeのタイトル・説明について、XML 1.0で許可されない制御文字、孤立サロゲート、U+FFFE／U+FFFFを拒否します。GUIDは従来どおり同じ許容範囲です。
- 判定は既存のtrimやURL正規化より前に行います。日本語・絵文字・結合文字・タブ・改行・復帰文字は維持し、フィールドごとの新しい文字数上限は追加しません。RSSレンダラー側でも禁止文字を拒否します。
- CLI入力検証に加え、Queueのstaging検証とSQLiteの公開前検証が公開payloadの書き込み前に拒否します。既存の`validation_failed`診断とowner・素材の保全契約は変わりません。
- 保存済みの不正なmetadataも、新しい読み取り・再生成では拒否します。自動修復、履歴の書き換え、owner解放は行いません。Workerを配備しただけでは既存feedは再生成されません。
- RSS取り込みは入力RSSのXML解析自体が先に失敗するため、不正文字を含む番組は取り込み時点で停止します。

### `castloop.toml`の読み取り

- 無制限の同期読み取りを廃止し、既存の`readLocalMetadata`へ統一しました。`O_NOFOLLOW`／`O_NONBLOCK`で開き、通常ファイルかつ**1〜16,384 bytes**に制限し、読み取り前後のsize・mtime・ctimeと実読取量を照合します。不正UTF-8は置換せず拒否します。
- 設定の読み取りに失敗した場合、管理API呼び出し、journal作成、管理鍵の作成へ進みません。schema version 1／2の振り分け、未知schema・未知キーの拒否、既存操作の再送禁止は維持します。
- **互換性の変更:** `castloop.toml`自体のsymlink、FIFO等の非通常ファイル、16,384 bytesを超える設定（コメント含む）は新たに拒否されます。通常ファイルへ戻し、上限内に収めてください。設定内容は自動修正しません。
- これは最終パス要素のsymlink拒否とdescriptor内の安定性検査であり、親directory全体のsymlink排除、hard linkの拒否、検査後の変更禁止を保証するものではありません。

### 内部整理と共通化

- 現行の配備入口から到達しない旧Worker・公開処理、正式CLIに接続されていない旧migration実装、旧Stage AのCLI送信クライアント、実験用実装と、それらだけを対象とするテストを削除しました。schema-version-1／2の現行経路と、保持済み要求の解釈に必要なschema・consumerは維持しています。
- Worker／sharedのSHA-256・hex変換とHMAC署名・検証、管理JSON応答、上限付きHTTP読み取り、fsync・排他作成、`.gitignore`保護、一覧TSV整形、7種類のjournalのロック確認→parse→load→検証→保存の順序を共通化しました。protocol別の署名prefix、JSON直列化順序、サイズ上限、GET先allowlist、再試行回数・期限、診断コードは変えていません。
- **意図的な挙動変更:** Queue方式の初期化でもSQLite方式と同じ`.gitignore`保護を使います。保護ルールを末尾に置いて後続の否定ルールによる無効化を防ぎ、symlink・非通常ファイル・サイズ上限超過を秘密情報の作成やリモート初期化の前に拒否します。既存のユーザールールは上書きしません。

## 互換性・移行

- 新規SQLiteサービスは引き続き`init --publication-protocol sqlite-sequential-v1`で作成します。flag省略時はschema-version-1のQueue方式のままで、workspace routingは変わりません。
- Queue方式からSQLite方式への変換、既存資源の採用、古いSQLite schemaの変換は提供しません。TOMLのschema／protocolを書き換えて移行しないでください。
- 両方式とも、新しいCLIと対応する検証済みWorkerの組で利用します。既存サービスを更新する場合は、従来どおり明示的なpause・drain確認・配備・検証・resumeが必要です。installやRelease公開だけでは配備されません。
- SQLiteのresume UUIDは新しい受付windowです。Queue方式のpause ID再利用と混同しないでください。
- 未知のmutation、残留journal・lock・実行は保持します。時間経過、HEAD不在、drainedだけを根拠に解除・削除しません。

## 既知の制限

- v0.5.0の制限を継承します。SQLite方式の物理削除、独自ドメイン、既存移行、blocked jobのretry／releaseは未対応です。非公開化はpayloadを保持するため容量を減らしません。
- 新SQLite経路のnative 300MB公開と実機purge rate-limit retryは未検証です。Queue方式の過去の300MB受け入れを流用しません。
- 通常HTTPのCPU測定はv0.5.0までの範囲です。今回の検証変更を含む全負荷・全操作のWorkers Free適合や、[Issue #13](https://github.com/simosako/castloop-v2/issues/13)の恒久解消は保証しません。課金・権限・CPU上限は自動変更しません。
- 保存済みの不正metadataは読み取り・再生成時に拒否されるため、該当するShow／Episodeは管理者がmetadataを修正して新しいjobで公開するまで失敗し得ます。本Releaseは自動移行・修復を行いません。
- 素材・staging・運用記録の自動cleanup、subscriber移行、定期RSS同期、無停止更新、万能復旧は対象外です。

## 検証・配布

Release準備の再検証は**1,245テスト合格／0失敗（138 files、94.71秒）**、TypeScript検証、`git diff --check`、Linux単体CLI buildが成功しました。
単体バイナリの`--version`が`0.5.1`を返すことも確認しています。
CIでも全テスト・型・build、tagと版番号の一致、SHA-256、SQLite固有helpと引数不足拒否を含むCLI smokeを確認してから公開します。

今回の変更に対するCloudflare実機の新規受け入れ・配備・upload・資源変更は行っていません。v0.5.0までに取得したSQLite／Queueの実機測定は、その対象操作・負荷の範囲での証拠であり、今回の入力検証変更や全操作の保証ではありません。

配布対象はLinux x86-64の`castloop-linux-x64`、`SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md`です。
macOS／Windowsは配布対象外です。操作は[README](https://github.com/simosako/castloop-v2/blob/v0.5.1/README.md)、
SQLite方式の詳細は[SQLiteガイド](https://github.com/simosako/castloop-v2/blob/v0.5.1/docs/sqlite_sequential_development.md)、
Queue方式は[Queue方式ガイド](https://github.com/simosako/castloop-v2/blob/v0.5.1/docs/queue_service.md)を参照してください。
