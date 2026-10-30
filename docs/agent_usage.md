# エージェントによるPodcast管理

v0.8.0は、認証付き全文取得・公開済み内容とローカル入力の項目別差分、revision履歴、素材再uploadなしの過去版採用に対応する。`preview-*`は管理鍵のあるworkspaceでは既定でremote読取を行い、`--local`は通信なし。サービス設定version 2・`show-v1`、内部queue/content形式14/13の新規環境専用で、ステージング・公開job台帳は使わない。構文・確認hash・原本保全は[公開内容の確認ガイド](published_content_review.md)を優先する。

[独自ドメイン管理](sqlite_custom_domains.md)にも対応する。`describe domain --json`と`help domain`で構文を確認し、追加・削除・continueは管理者が明示した対象と範囲でだけ実行する。list/statusは読取専用、continueは変更を含み得る。doctorは未完了domain記録も読取検査するが修復しない。旧versionの環境への移行は提供しない。

管理者側は対応するcastloopバイナリだけで利用でき、Node.js/npm/Bun/Wrangler/ffprobe等は不要。MCPは使用しない。Skillの導入だけではCloudflare環境を変更せず、旧版サービスを現行版へ移行することもない。[v0.8.0の互換性と検証範囲](release-v0.8.0.md)を参照する。

## Skillの導入

利用するエージェントのSkill配置先を選び、存在しないディレクトリを指定する。

```sh
castloop skill export castloop --output /path/to/project/.agents/skills/castloop
```

通信せず同じCLIに埋め込まれたSkillを出力する。既存ディレクトリ・編集は上書きしない。更新は別ディレクトリへexportして差分確認する。releaseには静的な`castloop-skill.tar.gz`と、その検証用の`SKILL_SHA256SUMS`も添付する。既存のバイナリ用`SHA256SUMS`は維持し、Issue #73以降はLinux・macOS（Apple Silicon）・Windows x64の3バイナリを列挙する。配布対象とOS別の検証範囲は[CLIバイナリ配布](cli_binary_distribution.md)を参照する。

Node.js/npmを既に使う場合の任意の導入方法:

```sh
npx skills add simosako/castloop-v2 --skill castloop
```

既定ブランチのSkillである。v0.8.0に固定する場合は次を使う。配置するエージェントとproject/global範囲を選び、開発用Skillをまとめて導入しない。使用するCLIと同じ版を選ぶ。

```sh
npx skills add https://github.com/simosako/castloop-v2/tree/v0.8.0/skills/castloop --skill castloop
```

## 利用仕様と入力

```sh
castloop describe --json
castloop describe publish-episode --json
castloop schema show-input --format json-schema
castloop schema episode-input
castloop schema service-config
castloop schema result
castloop template show
castloop template episode
castloop validate show /absolute/workspace/show/show.toml --assets --json
castloop validate episode /absolute/workspace/show/episode-first.toml --audio /absolute/audio.mp3 --json
castloop doctor --local --workspace /absolute/workspace --json
```

describe/schema/template/validate/doctorは通信しない。検証・診断は鍵、journal、lockを生成せず、入力を書き換えない。Skill exportだけは指定先に書き込む。雛形の値は例であり、所有者情報・URL・言語・explicit・日時等は管理者に確認する。offline Episode GUID/dateを実登録identityへ使わず、`create-episode`の保存済み値を保持する。

同じworkspaceまたはRSS取り込みディレクトリで、変更するCLIを同時に複数起動しない。ローカル記録にロックファイルは使わない。中断後は元プロセスの終了を確認してから同じ操作を再実行する。

任意の`castloop-admin.toml`は管理用timezoneを設定する。`preview-schedule-time`はオフライン日時変換だけであり、予約には`preview-episode-schedule ID [MP3]`／`schedule-episode ID [MP3]`（Showは`preview-show-schedule`／`schedule-show`）を使う。承認hashを`--expect-preview`へ渡し、予約の`dispatched`とrevisionで確定を確認する。更新元競合・ドメイン変更で`needs_approval`になった予約は明示再承認が必要。未来の`published_at`は予約ではなく、非対話での即時公開には`--allow-future-published-at`が必要。[管理用設定ガイド](admin_configuration.md)を参照する。

JSON Schemaはparse後のTOML値を記述する。裸のTOML日時ではなく引用符付きRFC 3339文字列を使う。サービス設定version 2、content version 1、機械出力のcontract_version 1は別物。HTML除外後の文字数、UTF-8 bytes、XML文字、実在日付、URL、field間制約は`x-castloop-validation`を参照し、CLI validateで最終検証する。保存済みsnapshot用schemaに新規入力上限を追加したものではない。

取得できる出力schemaは現段階では共通外枠の`result`であり、コマンドごとの詳細payloadはJSON値として扱う。全管理コマンドの詳細result型・flagの条件付き必須性までを個別JSON Schema化する補強は残る。入力schemaの取得・strict検証とは区別する。

公開可否の切り替えは `preview-show-lifecycle` / `preview-episode-lifecycle` と `lifecycle-execute`（`unpublish` / `restore`）で行う。詳しくは[SQLite開発・運用ガイド](sqlite_sequential_development.md)を参照する。

doctorは人向け1項目1行とJSONの`result.checks`を同じ検査から生成する。pass/warn/fail/not_checkedを区別し、failは終了1、warnだけは終了0。認証情報の存在は有効性・権限を証明しない。remote検査・自動修復は行わない。

`diagnose SHOW_ID [SHOW_ID...]`は明示指定Showの読取専用remote診断。管理APIへのGETとCloudflare accountへの読取GET 1件を行い、`--external`指定時だけ公開配信も検査する。各検査にscope（local/remote/cross/external）とpass/warn/fail/not_checkedを付けて分類する。修復・purge・再送は行わない。failが1つでもあれば終了1、warnのみは終了0。同時指定は既定5 Showまでで、`--max-shows N`（1〜20）で変更できる。予約受付やCLIの`ok`を公開完了と混同しない。

`verify SHOW_ID [--episode ID]`は確定済み内容と公開pathの配信を比較する。公開jobを廃止したため`progress`／`watch`／`job-status`はない。[診断ガイド](observability.md)を参照する。

## 対象・出力・公開前確認

```sh
castloop preview-episode first audio.mp3 --workspace /absolute/workspace --show daily --json
# Review local metadata/media, the published base and input_fingerprint; obtain approval.
castloop publish-episode first audio.mp3 --workspace /absolute/workspace --show daily --expect-preview REVIEWED_SHA256 --json
```

`--workspace`は指定rootだけを使う。Episodeの明示workspaceには`--show`が必須。Show操作は従来のID位置引数を使い、`--show`による別対象指定は拒否する。従来のcwd方式も維持する。MP3相対パスはShow directory、lifecycle planはworkspace、validateのFILE/--audioと--workspace自体は呼出元cwd基準。image_pathはShow directory基準。

`--non-interactive`はCLI質問を停止するだけで承認省略ではない。JSONモードもstdout汚染を避けるため質問しない。initの不足入力はディレクトリ作成前に拒否する。

`--json`は成功・失敗をstdoutへ1つの文書で返す。`describe`と`schema`は仕様そのものを返し、管理結果はcontract_version/command/ok/target/result/operation/error/next_actionsの外枠を使う。失敗は終了1、診断はstderr。未知例外文・入力本文をエラーへ転載しない。

`ok`はCLI要求の成否。同期公開の`changed`／`unchanged`とrevisionは確定結果だが、予約の`scheduled`は受付にすぎない。`next_actions`は実行承認ではない。

`preview-show ID`／`preview-episode ID [MP3]`はローカル入力と公開済み全文・base・素材再利用を表示する。uploadや公開用journal・lockは作らない。`--expect-preview`は入力と確認済み更新元を照合する。変更後は再previewするが、既に同じ内容が公開済みなら変更なしで返せる。hash自体は承認の証明ではない。

`--local`ではremote未確認を明示する。一覧やRSSを編集元に逆変換しない。全文の新規ファイルへの書出しと、既存workspaceの記録の再構築は別である。

## バックアップ・復元

workspaceのバックアップ・検証・復元は4つの`backup-*`コマンドで行う。いずれも通信せず、Cloudflare API用の環境変数を読まない。ローカルの管理キーはバックアップ対象である。`backup-create`のパスフレーズは`--passphrase-file`またはTTYプロンプトからだけ読み、`--json`・`--non-interactive`では`--passphrase-file`が必須になる。音源原本のバックアップは利用者・エージェントが`--include-audio`を明示したときだけ行われ、既定のバックアップではmanifestに除外として記録される。復元は`backup-restore-preview`で確認してから`backup-restore ARCHIVE DEST confirm`で行う。復元自体は未完了操作を再送・継続せず、別途状態確認と承認が必要。旧journal familyの除外を含む対象・保証範囲は[バックアップガイド](workspace_backup.md)を優先する。

## 検証範囲

ローカル模擬Cloudflareによる公開・中断後の再実行試験、独立CLI processのcwd非依存操作、オフラインコマンドとSkill exportを検証する。`node scripts/smoke-agent-cli.mjs dist/castloop-linux-x64`は開発用テストであり、実行する子バイナリは空PATH・ソース不在の作業場所から動かす。Nodeは管理者環境の依存ではない。

実エージェントによる質問判断の品質、`npx skills`による各製品への導入、Cloudflare native性能、300MB実機公開、全Free互換はこのローカル検査で証明しない。ローカル検査はデプロイ・公開・実資源変更を行わない。v0.8.0の限定的な非公開実機確認は[リリースノート](release-v0.8.0.md#verification-and-limitations)と区別する。

v0.7.2導入時のローカル確認では、`bun test`は579 pass / 0 fail（70 files）、型検査・CLI build・standalone smokeが成功した。これは当時の記録であり、現行版のテスト件数や全機能の検証結果ではない。現在の配布・OS別の検証範囲は[CLIバイナリ配布](cli_binary_distribution.md)を参照する。
