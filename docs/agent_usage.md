# エージェントによるPodcast管理

castloopは、管理者向けSkillと、構文・スキーマ・操作結果を取得できる単一CLIを提供します。エージェントには対象サービス・Showと、準備、公開、配備、ドメイン変更のどこまで許可するかを明示してください。Skill導入やプレビューだけでは、実環境の変更は許可されません。

対応するサービスは[利用ガイド](README.md#対象と用語)を参照してください。構文・確認ハッシュ・原本保全は各機能の利用ガイドを優先し、管理者の不足情報や承認を推測で補わないでください。

管理端末では対応するcastloopバイナリだけを使えます。Node.js・npm・Bun・Wrangler・ffprobeは必須ではなく、MCPは使用しません。

## Skillの導入

利用するエージェントのSkill配置先を選び、存在しないディレクトリを指定する。

```sh
castloop skill export castloop --output /path/to/project/.agents/skills/castloop
```

通信せず、同じCLIに埋め込まれたSkillを出力します。既存ディレクトリや編集は上書きしないため、更新は別ディレクトリへ出力して差分を確認します。リリースの `castloop-skill.tar.gz` と `SKILL_SHA256SUMS` からも取得できます。[配布物とOS別の対応範囲](installation.md)を参照してください。

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

同じワークスペースまたはRSS取り込みディレクトリを変更するCLIは、一度に1プロセスだけ実行します。中断後は元プロセスの終了を確認し、[操作別の確認方法](troubleshooting.md#操作が中断した場合)に従います。

日時の解釈と予約は[予約公開ガイド](scheduling.md)に従います。`preview-schedule-time` は日時変換だけです。未来の `published_at` は予約ではなく、非対話で即時公開するには `--allow-future-published-at` が必要です。予約は `dispatched` とリビジョンで公開確定を確認します。

JSON Schemaはparse後のTOML値を記述する。裸のTOML日時ではなく引用符付きRFC 3339文字列を使う。サービス設定version 2、content version 1、機械出力のcontract_version 1は別物。HTML除外後の文字数、UTF-8 bytes、XML文字、実在日付、URL、field間制約は`x-castloop-validation`を参照し、CLI validateで最終検証する。保存済みsnapshot用schemaに新規入力上限を追加したものではない。

出力スキーマの `result` は共通外枠を記述します。コマンドごとの詳細な結果や、引数の条件付き必須性までを個別のJSON Schemaとして提供するものではありません。入力スキーマの厳密な検証と区別し、引数は `describe COMMAND` とヘルプでも確認してください。

公開可否の変更は[非公開化・復元](lifecycle.md)、過去版の採用は[内容確認](published_content_review.md)、状態確認は[診断](troubleshooting.md)に従います。`doctor` はローカル検査、`diagnose` は読取専用のリモート診断、`verify` は公開配信の照合です。認証情報の存在だけで、有効性や権限を確認したとは判断しません。

## 対象・出力・公開前確認

```sh
castloop preview-episode first audio.mp3 --workspace /absolute/workspace --show daily --json
# Review local metadata/media, the published base and input_fingerprint; obtain approval.
castloop publish-episode first audio.mp3 --workspace /absolute/workspace --show daily --expect-preview REVIEWED_SHA256 --json
```

`--workspace` は指定したサービスルートだけを使います。Episode操作の明示workspaceには `--show` が必須です。Show操作はID位置引数で対象を指定し、`--show` で別対象を指定しません。

| パス | 相対指定の基準 |
| --- | --- |
| 公開用MP3、Showの `image_path` | Showディレクトリ。`image_path` は直下のファイル名のみ |
| lifecycle／revisionの計画ファイル | ワークスペース |
| `--workspace`、`validate` の入力・音声、出力先 | コマンド呼び出し元の作業ディレクトリ |

`--non-interactive`はCLI質問を停止するだけで承認省略ではない。JSONモードもstdout汚染を避けるため質問しない。initの不足入力はディレクトリ作成前に拒否する。

`--json`は成功・失敗をstdoutへ1つの文書で返す。`describe`と`schema`は仕様そのものを返し、管理結果はcontract_version/command/ok/target/result/operation/error/next_actionsの外枠を使う。失敗は終了1、診断はstderr。未知例外文・入力本文をエラーへ転載しない。

`ok`はCLI要求の成否。同期公開の`changed`／`unchanged`とrevisionは確定結果だが、予約の`scheduled`は受付にすぎない。`next_actions`は実行承認ではない。

`preview-show ID`／`preview-episode ID [MP3]`はローカル入力と公開済み全文・base・素材再利用を表示する。uploadや公開用journal・lockは作らない。`--expect-preview`は入力と確認済み更新元を照合する。変更後は再previewするが、既に同じ内容が公開済みなら変更なしで返せる。hash自体は承認の証明ではない。

`--local`ではremote未確認を明示する。一覧やRSSを編集元に逆変換しない。全文の新規ファイルへの書出しと、既存workspaceの記録の再構築は別である。

## バックアップ・復元

4つの `backup-*` コマンドは通信せず、管理キーを含むローカル状態を保存・検証・復元します。非対話では `--passphrase-file` が必須です。MP3原本は `--include-audio` を指定した場合だけ対象です。復元は未完了のリモート操作を継続せず、その確認・承認は別に行います。対象と除外を[バックアップガイド](workspace_backup.md)で確認してください。

## ドメイン変更と実行結果の限界

[独自ドメイン](custom_domains.md)の追加・削除・`continue` は変更操作です。`list`／`status` は読取専用ですが、そこから提示された次の操作も、承認なしには実行しません。診断は修復やキャッシュパージを行いません。

CLIのローカル試験は、実エージェントの判断品質や各製品へのSkill導入、実Cloudflare性能を保証しません。現在の[OS別の検証範囲](installation.md#対応環境と検証範囲)と[テストの責務](../design/testing.md)を区別してください。
