# エージェントによるPodcast管理

Issue #64の開発版は、認証付き全文取得・公開中/local/stagedの項目別差分、revision履歴、素材再uploadなしの過去版採用に対応する。`preview-*`は管理鍵のあるworkspaceでは既定でremote読取を行い、`--local`は通信なし。内部形式7/8の新規環境専用。構文・確認hash・原本保全は[公開内容の確認ガイド](published_content_review.md)を優先する。

未リリースのIssue #68対応版では[独自ドメイン管理](sqlite_custom_domains.md)を追加する。`describe domain --json`と`help domain`で対応を確認し、接続/切断/continueは管理者が明示した対象と範囲でだけ実行する。list/statusは読取専用、continueは変更を含み得る。doctorは未完了domain journalやlockも読取検査するが修復しない。旧versionの環境への移行は提供しない。

v0.7.2で追加したIssue #5のCLI機能。管理者側は対応するcastloopバイナリだけで利用でき、Node.js/npm/Bun/Wrangler/ffprobe等は不要。MCPは使用しない。既存のCloudflare環境・永続形式・公開プロトコルは変更しない。[リリースノート](release-v0.7.2.md)を参照する。

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

既定ブランチのSkillである。v0.7.2に固定する場合は次を使う。配置するエージェントとproject/global範囲を選び、開発用Skillをまとめて導入しない。

```sh
npx skills add https://github.com/simosako/castloop-v2/tree/v0.7.2/skills/castloop --skill castloop
```

## 利用仕様と入力

```sh
castloop describe --json
castloop describe update-episode --json
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

Issue #65の開発版では`schema admin-config`／`template admin-config`／`validate admin-config FILE`と、任意の`castloop-admin.toml`のdoctor検査を追加する。`preview-schedule-time DATETIME --workspace PATH [--timezone IANA_ZONE] --json`はローカル日時変換だけで、予約も公開もしない。設定と日時解決規則は[管理用設定ガイド](admin_configuration.md)を参照する。サーバー側予約は未実装であり、preview結果を予約受付や公開承認の証拠にしない。

JSON Schemaはparse後のTOML値を記述する。裸のTOML日時ではなく引用符付きRFC 3339文字列を使う。サービス設定version 2、content version 1、機械出力のcontract_version 1は別物。HTML除外後の文字数、UTF-8 bytes、XML文字、実在日付、URL、field間制約は`x-castloop-validation`を参照し、CLI validateで最終検証する。保存済みsnapshot用schemaに新規入力上限を追加したものではない。

取得できる出力schemaは現段階では共通外枠の`result`であり、コマンドごとの詳細payloadはJSON値として扱う。全管理コマンドの詳細result型・flagの条件付き必須性までを個別JSON Schema化する補強は残る。入力schemaの取得・strict検証とは区別する。

Issue #66の開発版は`show-admission-pause SHOW UUID`、`show-delivery-resume SHOW UUID`、`show-control-status SHOW UUID`を追加した。対応CLIのhelp/describeで確認し、対象workspaceを明示する。受付だけの停止では素材アップロードも止まり、配信だけの再開でも既受付処理の終了と動作確認を待つ。`result.control.result`は過去の適用結果、`result.state`は現在状態であり、過去の再開成功を新たな再開許可にしない。`doctor --local`は手元の未完了制御記録を検査するだけで、照会や再送はしない。詳しくは[停止・再開ガイド](show_availability.md)を参照する。新機能は内部形式7/7の新規環境専用で、既存環境を変換しない。

doctorは人向け1項目1行とJSONの`result.checks`を同じ検査から生成する。pass/warn/fail/not_checkedを区別し、failは終了1、warnだけは終了0。認証情報の存在は有効性・権限を証明しない。remote検査・自動修復は行わない。

`diagnose SHOW_ID [SHOW_ID...]`は明示指定Showの読取専用remote診断。管理APIへのGETとCloudflare accountへの読取GET 1件だけを行い、各検査にscope（local/remote/cross）とpass/warn/fail/not_checkedを付けて分類する。修復・Resume・purge・再送は行わない。failが1つでもあれば終了1、warnのみは終了0。同時指定は既定5 Showまでで、`--max-shows N`（1〜20）で変更できる。queuedやCLIの`ok`を公開成功として表示しない。

`progress JOB`、`verify SHOW_ID [--episode ID]`、`watch JOB`は[観測コマンドの利用方法](observability.md)を参照。progressは1 jobの進捗と待機理由を統合表示し、verifyは公開pathへのGET/HEADで処理成功と配信確認を分けて報告し、watchは予算付きで終端または観測不能まで観測する（終了code 0/1/2、SIGINT 130）。watchは通知送信を行わず、成功時のnext_actionsがverifyへ誘導する。

## 対象・出力・公開前確認

```sh
castloop update-episode first --workspace /absolute/workspace --show daily --non-interactive --json
castloop preview-episode first --workspace /absolute/workspace --show daily --json
# Review metadata, staged hashes, base and input_fingerprint; obtain publication approval.
castloop publish-episode first --workspace /absolute/workspace --show daily --expect-preview REVIEWED_SHA256 --json
```

`--workspace`は指定rootだけを使う。Episodeの明示workspaceには`--show`が必須。Show操作は従来のID位置引数を使い、`--show`による別対象指定は拒否する。従来のcwd方式も維持する。MP3相対パスはShow directory、lifecycle planはworkspace、validateのFILE/--audioと--workspace自体は呼出元cwd基準。image_pathはShow directory基準。

`--non-interactive`はCLI質問を停止するだけで承認省略ではない。JSONモードもstdout汚染を避けるため質問しない。initの不足入力はディレクトリ作成前に拒否する。

`--json`は成功・失敗をstdoutへ1つの文書で返す。`describe`と`schema`は取得する仕様そのものを返し、管理結果はcontract_version/command/ok/target/result/operation/error/next_actionsの外枠を使う。**従来から--jsonがあった一覧・操作照会も、結果本体はresultへ移る。** 既定の人向け出力は維持する。失敗は終了1、診断・progressはstderr。未知例外文・入力本文をエラーへ転載しない。

`ok`はCLI要求の成否であり公開完了の別名ではない。publicationのqueued/runningは同じjobを観測し、succeededで初めて完了。失敗時に取得できる保存済みjob/stateは最後の既知状態であり、未知IOの解放や再送を許可しない。next_actionsも実行承認ではない。

`preview-show ID`/`preview-episode ID`はローカル全文・stage済みhashとの一致・base identity・素材再利用を表示する。ローカル検査のみでuploadやjournal作成・要求凍結はしない。`--expect-preview`は同じ入力fingerprintとstage一致を公開時のlock内・要求凍結前に再照合する。素材・metadata・対象・base・stage情報が変われば再previewと再承認が必要。hash自体は承認の証明ではなく、既存の原子的な受付条件・identity照合も残す。

上のlocal-only説明はv0.7.2時点の仕様。Issue #64の開発版はremote差分に対応し、未取得やlocal指定時だけ`not_checked`とする。一覧やRSSを編集元に逆変換しない。全文の取得・新規ファイルへの書出しと、既存workspaceのjournal再構築は別である。

## バックアップ・復元

workspaceのバックアップ・検証・復元は4つの`backup-*`コマンドで行う。いずれも通信せず、Cloudflare資格情報も読まない。`backup-create`のパスフレーズは`--passphrase-file`またはTTYプロンプトからだけ読み、`--json`・`--non-interactive`では`--passphrase-file`が必須になる。音源原本のバックアップは利用者・エージェントが`--include-audio`を明示したときだけ行われ、既定のバックアップではmanifestに除外として記録される。復元は`backup-restore-preview`で確認してから`backup-restore ARCHIVE DEST confirm`で行い、復元後の未完了操作は観測のみで再送しない。対象・頻度・保証範囲は[バックアップガイド](workspace_backup.md)を優先する。

## 検証範囲

ローカル模擬Cloudflareによる従来の公開・復旧試験、独立CLI processのcwd非依存操作、オフラインコマンドとSkill exportを検証する。`node scripts/smoke-agent-cli.mjs dist/castloop`は開発用テストであり、実行する子バイナリは空PATH・ソース不在の作業場所から動かす。Nodeは管理者環境の依存ではない。

実エージェントによる質問判断の品質、`npx skills`による各製品への導入、Cloudflare native性能、300MB実機公開、全Free互換はこのローカル検査で証明しない。デプロイ・公開・Resume・実資源変更は行わない。

実装時のローカル確認: `bun test`は579 pass / 0 fail（70 files）、`npm run check`と`npm run build:cli`は成功。構築した`dist/castloop`で上記standalone smokeも成功し、空PATHでの素材検証・Skill内容一致・上書き拒否・local-only previewの無書き込みを確認した。release workflow自体のGitHub上での実行や新releaseの発行は行っていない。
