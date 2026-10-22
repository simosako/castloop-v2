# castloop v0.7.2

Issue #5のエージェント連携を、**管理者Skillと自己記述できる単一CLI**で提供するLinux x86-64向けreleaseです。MCPは採用しません。管理端末に追加runtimeや外部プログラムは不要です。

## 変更内容

- **仕様・schema取得**: `describe [COMMAND] --json`で構文・option・副作用・中断時の方針を確認し、`schema service-config|show-input|episode-input|result`で同梱schemaを取得できる。
- **オフライン入力作成**: `template service-config|show|episode`でTOML例を出力し、`validate service|show|episode FILE`で通信・書き込みなしに既存の入力規則を検証できる。Showの`--assets`、Episodeの`--audio MP3`で素材検査も行える。
- **明示対象・非対話実行**: `--workspace PATH`、Episode操作の`--show ID`、`--non-interactive`を追加。initの必須入力・指定UUIDは作成先への書き込み前に検証する。
- **機械可読な結果**: 管理コマンドの`--json`で成功・失敗とも版付きの文書を返す。未知例外文を転載せず、公開処理の失敗時は取得できる保存済みjobと最後の既知状態を返す。受付と公開完了、結果不明と再送許可を混同しない。
- **公開前確認**: `preview-show`/`preview-episode`でローカル全文・stage済み素材hash・baseを確認し、`publish-* --expect-preview HASH`で承認後の入力変更を公開要求の凍結前に拒否する。既存の原子的な受付・identity照合も維持する。
- **doctor**: `doctor --local`で短い一覧、`--json`で同じ検査の構造化結果を出す。警告・失敗・未検査、認証情報の存在と有効性を区別し、自動修復はしない。
- **管理者Skill**: `castloop skill export castloop --output DIRECTORY`でCLI内蔵のSkillを配置できる。既存配置は上書きしない。不足情報を推測せず管理者へ質問し、準備・upload・公開・中断対応の範囲を守る手順を提供する。

## 互換性と更新

- **`--json`の互換変更**: 従来から対応していた一覧・操作照会を含め、結果本体は`result`配下へ移る。外枠は`contract_version=1`、`command`、`ok`、`target`、`result`、`operation`、`error`、`next_actions`。利用scriptは更新が必要。`describe`と`schema`は取得する仕様そのものを返す。
- 既定の人向け出力と従来のcwd指定方式は維持する。明示workspaceでのEpisode操作には`--show`が必要。相対MP3はShow directory、lifecycle planはworkspace、validateのFILE/MP3は呼出元cwd基準。
- Workerの製品ソース・配信処理・Cloudflare API仕様・永続形式はv0.7.1から変更しない。サービス設定version 2、必須`show-v1`、`sqlite-sequential-v1`、内部queue/content schema **5/6**、共有content/request schema version 1を維持する。
- このCLI追加機能のためにWorkerを再配備する必要はない。リリース・インストールはdeploy、Resume、公開、資源変更を行わない。凍結済み初期化・更新journalには対応する旧CLI/sourceを保持し、未知要求を別binaryで再送しない。
- 旧layoutの採用・移行・fallback、物理削除、独自ドメイン、予約配信、blocked jobのretry/releaseは追加しない。

## 検証と制限

- 製品変更のローカル回帰は**579 pass / 0 fail（70 files）**。型チェック、単体バイナリ構築、空PATH・ソースのない作業場所でのschema・雛形・素材検証・doctor・Skill export・local previewのsmokeに成功した。
- バージョン更新後もローカル回帰・型チェック・Linux binary smokeを実施し、タグのCIでbuild・smoke成功後に配布する。
- **今回のCloudflare実機検証は省略する。** Worker・native配信は変更しておらず、CLI公開経路は模擬Cloudflareによる回帰で確認する。これは新しいnative性能測定・300MB実機公開・全Free互換の証明ではない。
- 出力schemaは共通外枠まで。全コマンドの詳細result型・条件付き引数要件の個別JSON Schema化は残る。公開済み全文取得・publishedとのfield単位差分は未提供と明示し、一覧やRSSから推測して補完しない。
- 実エージェントの判断品質、`npx skills`による各製品への導入は自動試験で証明していない。`--expect-preview`のhash自体も管理者承認の証明ではない。

## 配布とSkill導入

[v0.7.2 release](https://github.com/simosako/castloop-v2/releases/tag/v0.7.2)から`castloop-linux-x64`、`SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md`を取得する。Linux x86-64のみを配布し、管理端末にNode.js/Bun/Wrangler/ffprobe/Git/curl/jqを要求しない。

```sh
castloop skill export castloop --output /path/to/project/.agents/skills/castloop
```

静的Skillは`castloop-skill.tar.gz`と`SKILL_SHA256SUMS`でも提供する。Node.js/npmが既にある場合だけ、任意でtag固定の導入も使える。

```sh
npx skills add https://github.com/simosako/castloop-v2/tree/v0.7.2/skills/castloop --skill castloop
```

詳細は[利用ガイド](agent_usage.md)と[改善案・実装範囲](../design/agent_integration_plan.md)を参照する。
