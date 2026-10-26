# 管理workspaceのバックアップ・整合性検証・復元支援の実装計画(Issue #63)

status: 採択(2026-10-26実装承認)。実装済み。実装中の細部の判断は本文書と§10の確定内容に従う。検証記録は[バックアップガイド](../docs/workspace_backup.md)末尾を参照。

## 1. 結論(価値評価)

**実装する価値はある。ただし範囲を絞る。**

- **価値が高い**: 第1段階(バックアップ作成・検証)と復元支援。理由は後述のリスク評価どおり、管理キーを失うとデプロイ済みサービスが回復不能になり、バックアップ以外に対策が存在しない。
- **価値が中程度**: 音源原本をバックアップ対象に含めること(`--include-audio`)。公開済み音源はR2に不変保持されるため、対象の中心は未公開原本の保護である。
- **価値が低い(対象外とする)**: 公開済み音源・metadataのリモートエクスポート(Issue第2段階の後半)。metadata全文の取得とTOML書き出しは v0.7.5(Issue #64)の`sync-local-metadata`が、過去版の採用はrevision機能が既に提供している。公開済み音源はR2に不変オブジェクトとrevision履歴で保持されており、読み取り専用エクスポートを新設する追加の利益は小さい。

## 2. 現状と前提

### 2.1 対象workspaceの構成要素

| 要素 | 役割 | 喪失した場合の影響 |
| --- | --- | --- |
| `castloop.toml` | サービス設定(schema 2) | 再作成は可能だが同一内容の保証がない |
| `.castloop/secrets.json` | 管理キー `CASTLOOP_ADMIN_KEY`(32 bytes乱数) | **回復不能**。サーバーはSHA-256照合のみで再発行手段なし。デプロイ済みサービスが管理不能になる |
| `.castloop/sqlite-client/<service>/client.json` | 操作照合に使うクライアントID | 操作記録の照会・要求照合のidentityを失う |
| `.castloop/<family>/<service>/*.json` | 15 familyの操作journal(draft、upload、publication、要求記録等) | 未完了操作の再開・照会不能。応答不明要求の再送は禁止のため、要求IDを失うと照会もできない |
| `<show>/show.toml`・`<show>/<episode>.toml`・カバー画像 | 編集元・素材 | 公開済み分は`sync-local-metadata`で復元可。未公開draftは不可 |
| `<show>/*.mp3` | 音源原本 | 公開済み分はR2に不変保持。未公開分は喪失 |
| `*.lock`・`*.lock.sqlite`(sidecar含む)・`*.tmp` | 排他・一時ファイル | 再生成される。バックアップ対象外 |

journal内の音源・カバー参照は`source_path`として**絶対パスで凍結される**(`packages/cli/src/sqlite-upload.ts` の `resolve(root, path)`)。別パス・別端末へ復元した場合、未完了draftは原本が同一パスに存在しないと続行できない。この制約はmanifestへの記録と復元時の表示で明示する。

### 2.2 既存機能との関係

- `doctor --local`: config・管理キー・未完了制御/domain記録の検査のみ。バックアップ機能はない。
- v0.7.5の`sync-local-metadata`・revision採用: 公開済み内容の取得・復帰は提供済み。本計画はこれと重複しない(local状態の保全が主目的)。
- 手動ファイルコピー: 現状の唯一の代替。しかし(1)何を対象にすべきかの定義がなく、(2)後日の破損・欠落を検証する手段がなく、(3)復元手順と復元後の確認が利用者任せである。Issueが指摘するとおり「復元可能性の確認は利用者任せ」である。

### 2.3 リスク評価

- 管理キー喪失はPC故障・誤削除・作業ディレクトリ損失で現実に起こる。36 Episode・1.50GB規模の運用実績があり、影響は小さくない。
- CLIが書き換えるローカルファイルはすべてatomic rename(一時ファイル書き込み+`renameSync`)で書かれる: journal 15 family(`local-journal-storage.ts`)、`secrets.json`と`sqlite-client/<service>/client.json`(同一storage経由)、`castloop.toml`のdomain同期(`sqlite-domain-operation.ts`)、TOML書き出し(`rss-publication-content.ts`)。in-place書き込みは`.gitignore`(`workspace-protection.ts`)のみで、これはバックアップ対象外(§5.3・復元時に再生成)。したがってバックアップの読み取りは常に各ファイルの完全な新旧いずれかの内容となり、途中が混ざったコピーは生じない。
- バックアップ中に並行操作があった場合も、結果は「ある中間時点のスナップショット」であり、1秒前に取得したバックアップと本質的に同じである(§4.3)。lockファイルの存在は「実行中とは限らない」ため静止点判定には使えず、使う必要もない。CLI管理外の書き込み(ユーザーがエディタ等でTOML・カバー・音源を保存する)だけが破れた読み取りを受け得る経路であり、これが「バックアップ中は編集・他操作をしない」運用推奨(§4.3)の対象である。

## 3. 機能の対象範囲

**含めるもの**: バックアップ作成・検証・復元preview・復元の4操作。いずれも通信しないlocal完結コマンド。

**含めないもの**:
- 公開済みコンテンツの取得・エクスポート(既存の`sync-local-metadata`・revision機能で足りる)
- 自動バックアップ・スケジューリング
- 復元後の自動再開・自動診断の実行(案内の表示のみ)
- 旧schema・旧layoutからのバックアップ読み取り
- 管理キーの再生成・変更

## 4. 方式の比較(複数案)

### 4.1 アーカイブ形式と暗号化

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **A. 単一暗号化アーカイブ(推奨)** | 1ファイル。平文ヘッダ(形式番号・KDF情報・要約統計)+ パスフレーズから導出した鍵でチャンクごとにAES-256-GCM暗号化したペイロード(詳細manifest含む) | 秘密を含む単一ファイルなので誤露出経路が減る。転送・保存が単純。GCM tagで改ざん・誤鍵を自動検出。ヘッダだけでいつ・どの規模のバックアップか判別できる | 内容一覧の確認にもパスフレーズが要る(運用上の利便性がやや低い)。自前のコンテナ形式になる |
| B. 平文ディレクトリコピー+manifest JSON | ディレクトリをそのままコピーし、manifestだけCLIが生成・検証する。暗号化は利用者のツールに委ねる | 実装が最も小さい。標準ツールで内容を直接閲覧できる | 管理キー入りの平文一式ができやすく、誤・露出・誤コミットの事故リスクが実質的に増える。暗号化を任せた先で破損検証と整合性検証が分離し、「検証済み」の意味が弱くなる |
| C. 暗号化アーカイブ+分離平文manifest | アーカイブとは別にファイル一覧・hashを載せた平文manifestを併存させる | パスフレーズなしで内容一覧を確認できる | 2ファイル管理になり、どちらかだけが更新・転送された場合の取り扱いが曖昧になる。パス情報が平文で残る(show/episode IDは公開IDだが、運用名が漏れる) |

**推奨: 案A。** 秘密を含む以上、暗号化を必須にして単一ファイルにするのが、安全条件「秘密情報を含むことを明示し、暗号化と安全な保存を提供する」との整合が最も良い。内容一覧の確認は`backup-verify`(パスフレーズ必須)で行う。

### 4.2 音源原本の扱い

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **A. 既定除外+`--include-audio`(推奨)** | `*.mp3`を既定で対象外とし、flagで含める | 小さく速い日常運用と、大きい完全バックアップを使い分けられる。READMEの「音源原本のバックアップ」要求は完全バックアップで満たせる | flagなしでは音源が守られない。manifestの「不足」表示で補う |
| B. 常に含める | 常に全ファイル | 対象の迷いがない | 数GB規模で毎回の作成・検証が重く、実行頻度が下がる。管理キー・journalなどバックアップ以外に保護手段のない小さな状態の保護まで悪化する |
| C. 常に除外 | 音源は運用者の責任で保全 | 実装が最も小さい | 「必要な情報を含むバックアップ」の要件を満たさない |

**推奨: 案A。** 既定のバックアップで音源が除外された事実はmanifestの`excluded`欄と実行結果に明示し、`--include-audio`の存在をnext_actionsで案内する。音源込みバックアップの頻度は低くてよい。公開済み音源の第一の保護はR2の不変保持であり、`--include-audio`が独自に守るのは未公開原本とアカウント級災害への備えに限られる(§10-1)。

### 4.3 コピー中の整合性(静止点)確認

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **A. 機械的な静止点確認を行わない(推奨)** | 各ファイルを1回だけ読み、size+SHA-256の計算・manifest記録・チャンク暗号化を同一の読み取りで行う。並行操作の可能性は文書で明示するだけ | 全ファイルの読み取りが1回で済む。ファイル単位の整合はjournal書き込みのatomic renameが既に保証する。並行操作があった場合の結果(中間時点のスナップショット)は既存の安全条件が処理できるため、失敗にする利益がない | バックアップ中の並行操作を機械的に検出・阻止しない |
| B. 二段階hash確認 | アーカイブ書き込みの前後に全対象を2回読み、size+SHA-256の一致を確認。不一致なら作成失敗 | 並行操作があった場合に作成を失敗にできる | 全ファイルを2回読む(音源込みGB級で顕著)。検出できるのは「バックアップ中に並行操作があった」ことだけだが、その結果は危険な状態ではなく1秒前のスナップショットと同等のため、失敗と再実行を強いる利益がない |
| C. 全journalの排他lock取得後にコピー | 各familyの`exclusively()`を取得したままコピー | 厳密な静止点 | family×ファイル単位のlockを全取得する経路が現行APIに存在せず、新設とデッドロック管理が必要。実行中の操作と衝突する |

**推奨: 案A。** ファイル単位の整合性はjournalがatomic renameで書き込まれる既存の性質が保証しており、ファイル間のずれは「より早い時点のスナップショット」と同じで、復元後は既存の観測・再送禁止の契約がそのまま適用される。機械的な静止点確認は複雑さと実行コストに見合う利益がない。代わりに、(1)バックアップは他のcastloop操作を実行していないときに行うことを推奨、(2)並行操作があった場合は中間時点のスナップショットになる旨をガイドと実行結果に明示、(3)残存lockはmanifestの事実記録(`retained_locks`)として残し判定には使わない(「残っていても実行中とは限らない」現行仕様と同じ解釈)、の3点で足りる。

### 4.4 コマンド形式

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **A. フラット4コマンド(推奨)** | `backup-create` / `backup-verify` / `backup-restore-preview` / `backup-restore`(既存の`operation-cleanup-preview`→`operation-cleanup ... confirm`と同じ形) | help・describe・`--json`外枠の処理が各コマンド独立で素直。preview→confirmの既存パターンと一致する | コマンド表が4行増える |
| B. サブアクション形式 | `backup create|verify|preview|restore`(`domain`コマンドと同じ形) | コマンド一覧が1行で済む | 引数検証・help記述が`domain`と同様にネストした条件分岐になる |

**推奨: 案A。** 実装・検証・ヘルプのすべてが単純になる。

## 5. 推奨構成のコマンド契約

### 5.1 コマンド一覧

```sh
castloop backup-create --workspace /abs/workspace --output /abs/backup.clbk \
  [--include-audio] [--passphrase-file /abs/passphrase.txt] [--json]
castloop backup-verify /abs/backup.clbk [--passphrase-file /abs/passphrase.txt] [--json]
castloop backup-restore-preview /abs/backup.clbk --dest /abs/new-workspace \
  [--passphrase-file /abs/passphrase.txt] [--json]
castloop backup-restore /abs/backup.clbk /abs/new-workspace confirm \
  [--passphrase-file /abs/passphrase.txt] [--json]
```

- パスフレーズ: `--passphrase-file`(0600推奨のファイル)またはTTYプロンプト。環境変数からは読まない。`--json`・`--non-interactive`では`--passphrase-file`必須。コマンドライン引数`--passphrase`は履歴に残るため**提供しない**。
- 4コマンドとも通信しない。Cloudflare API token・アカウントIDを読まない。
- `--json`は既存の`result`外枠(contract_version/command/ok/target/result)に乗せる。

### 5.2 アーカイブ形式(案Aの詳細)

```
"CASTLOOP-BACKUP-1\n"                     平文マジック+形式番号
{header JSON}\n                           平文: cli_version, created_at, kdf(algo, N, r, p), salt, service_id,
                                          include_audio, entry_count, entry_bytes, cipher("aes-256-gcm"), chunk_bytes
{暗号化チャンク列}                         チャンクごと: 0x00 + u64be長 + nonce(12 bytes) || ciphertext || tag(16 bytes)
  ペイロード復号後: エントリ列+manifest    エントリごと: 型0x01+長+{path,kind,size} → 本文size bytes → 型0x02+SHA-256(32 bytes)
                                          最終record: 型0x03+長+manifest JSON(末尾に置く。1回読み取りでhashが確定するため)
{暗号化領域全体のSHA-256 trailer 32bytes}  転送破損・truncationの検出用(パスフレーズなしで検出可能。改ざん検出はGCMが担う)
```

- 鍵導出: `node:crypto`の`scrypt`(N=2^15, r=8, p=1, salt 16 bytes)で32 bytes。外部依存は追加しない。
- チャンクは固定バイト(例: 4 MiB)とし、GB級の音源を含めてもメモリ使用を一定に保つ。
- 誤鍵・改ざん: 最初のチャンクのGCM tag検証で失敗させる。失敗理由は「パスフレーズ不一致または破損」の固定文のみ。
- manifest(暗号化領域内): 対象ファイル一覧(相対パス・size・sha256・kind)、除外一覧と理由、残存lockの事実、未完了操作の要約、`source_path`絶対パス一覧。

### 5.3 対象・除外の列挙規則

- **対象**: `castloop.toml`、`castloop-admin.toml`(存在時)、`.castloop/`配下の既知journal family全15種(`local-journal-path.ts`定義。`sqlite-client`を含む。`rss-import-downloads`もfamilyの1つだが、取り込み出力ディレクトリ側に作られるためサービスworkspaceには存在しない)、Showディレクトリ(`show.toml`・Episode TOML・カバー画像・`--include-audio`時の`*.mp3`)。
- **除外**: `*.lock`、`*.lock.sqlite`とそのsidecar(`-journal`/`-wal`/`-shm`)、`*.tmp`、`.gitignore`(復元時に`protectLocalState`が再生成する)。除外はmanifestの`excluded`に種別と件数を記録。
- **拒否**: 対象内のsymlink、`..`を含む相対パス。列挙中に現れた未知のトップレベルエントリはmanifestに`unknown`として記録し対象外とする(警告)。既知family配下では、未知の種類のファイルもJSON以外を含めて対象にする(将来のjournal拡張に備えた保守的な選択)。

### 5.4 整合性契約(backup-create)

1. `loadWorkspaceConfig`でconfigを読み、service_idを特定する。
2. 対象を列挙し、各ファイルを1回だけ読み、size+SHA-256の計算・manifest記録・チャンク暗号化によるアーカイブ書き出しを同一の読み取りで行う(§4.3案A)。書き込みエラー時は不完全なアーカイブを残さない。
3. 未完了操作(draftsの非succeeded/failed、未完了control・domain・service-update記録)を既存のpending検知関数で走査し、manifestに要約する。
4. 実行結果には「バックアップ中に並行操作があった場合、アーカイブはある中間時点のスナップショットになる」ことと、未完了操作がある場合「復元後に許されるのは`operation-status`等の観測と既存の安全条件内での続行であること」を表示する。保証範囲の限界は§6のとおり。

### 5.5 復元契約(backup-restore-preview / backup-restore)

- **preview**: 復号+全エントリhash再計算+manifest照合を行い、展開予定(パス・size・衝突検査)とmanifest要約(未完了操作、`source_path`一覧、復元後に必要な追加情報)を表示する。何も書き込まない。
- **restore**: 復元先は**存在しないパス**であること(`skill export`と同じ規則)。既存ディレクトリ・既存ファイルとの衝突は拒否。エントリの相対パス検査(`..`拒否・絶対パス拒否・symlink作成禁止)の後に展開し、展開ファイルのhashを再計算してmanifestと照合する。失敗したら展開先を残さず破棄する。
- 展開後、`protectLocalState`で`.gitignore`を再生成し、`doctor --local`をnext_actionsとして案内する。
- 復元したworkspaceはconfig hash・管理キー・client_idが同一のため、同一サービスの管理をそのまま継続できる。未完了draftは`source_path`絶対パスが同じ実ファイルを配置しない限り続行できない旨を表示する(同一パスを維持できない場合はdraftの観測のみ行い、新規draftを作り直す)。

## 6. 安全条件・対象外

- 4コマンドともremote mutationを行わない。復元・検証を公開・Resume・資源変更の承認としない。
- 秘密(管理キー)・journal本文・パスフレーズを診断ログ・エラー文・Issueに出さない。manifestはhashとパスのみ。
- API token・アカウント情報を環境変数から収集しない。バックアップにCloudflare資格情報は含めない(そもそもworkspaceに保存されていない)。
- 未知IOの再送・採用は既存の安全条件のまま。復元後の未完了操作の続行可否は既存コマンド(`operation-status`等)の契約に従う。
- 旧schema version 1・旧layoutのworkspaceのバックアップ・復元は拒否する。作成時は`loadWorkspaceConfig`の現行判定がそのまま適用され、復元時は展開前にアーカイブ内の`castloop.toml`へ同じ判定を先に行う。
- バックアップの検証成功は、server側SQLite状態の完全復旧、未確認要求の解消、公開の成功を保証しない。

## 7. テスト計画

- **作成**: 正常系(小規模workspace)。symlink・未知エントリ混入。残存lockのみのworkspace(失敗にしない)。未完了draft含有(manifest記録)。`--include-audio`の内外。
- **検証**: 正常。誤パスフレーズ(tag検証失敗)。バイト改変、truncation、trailer hash不一致。
- **復元**: 新規パスへの展開とhash照合。既存ディレクトリ・既存ファイル拒否。`..`・絶対パス・symlinkを含むペイロード(作り直したアーカイブ)の拒否。展開中の失敗で破棄されること。復元後`doctor --local`がキー読取に成功すること。
- **秘密**: ログ出力・エラー文に鍵・パスフレーズ・journal本文が出ないこと。
- 既存の`bun test`全件と`npm run check`を通す。

## 8. 実装ステップ

1. `packages/cli/src/backup-archive.ts`: コンテナ形式の書き込み・読み取り(scrypt鍵導出、チャンクGCM、trailer)。
2. `packages/cli/src/backup-create.ts`: 対象列挙・1回読み取りでのhash計算・未完了操作走査・manifest構築。既存の`pendingSqliteControls`・`pendingLocalDomainChanges`等を再利用。
3. `packages/cli/src/backup-restore.ts`: preview・復元・衝突/path検査・展開後hash照合・`.gitignore`再生成。
4. `packages/cli/src/index.ts`・`help.ts`・`agent-schema.ts`へ4コマンドを登録。`backup-create`だけが`doctor`と同じくworkspace configを読む。restore系はアーカイブから展開するため、既存workspaceを必要としない。4コマンドとも通信しない。
5. テスト・ガイド文書・`design/README.md`・README.md・docs/agent_usage.md・CHANGELOG.mdの更新。

## 9. 受け入れ条件(Issue本文)との対応

| Issueの受け入れ条件案 | 本計画の対応 |
| --- | --- |
| 対象・除外・不足・未完了操作の確認、破損・欠落検出 | manifest(§5.2-5.4)と`backup-verify` |
| 使用中workspaceの不整合コピーを防ぐ契約 | journal書き込みのatomic renameによるファイル単位の整合への依拠と、並行操作時の意味(中間時点のスナップショット、復元後は既存の観測・再送禁止の契約が適用される)の明示(§2.3・§4.3・§5.4) |
| 暗号化・誤鍵・改ざん・展開先衝突の試験 | §5.2・§5.5・§7 |
| 検証・復元previewがremote mutationを起こさない | §6(全コマンド通信なし) |
| 別環境での復元訓練と同一identity維持 | §5.5(config hash・キー・client_id維持、`source_path`制約の明示) |
| 「local管理再開」「公開content保存」「server制御状態の災害復旧」の保証範囲の文書化 | §1・§6とガイド文書で明記 |

## 10. レビューで確定した判断

1. 音源を含む完全バックアップの頻度 → 確定: 低頻度で十分とする。公開済み音源の第一の保護はR2の不変保持であり、音源込みバックアップが独自に守る対象は未公開原本(存在期間は公開までの短い窓)とアカウント・バケット級災害への備えに限られる。ガイドには「失えない未公開原本を追加したとき、または低頻度の定期(例: 月次)」という2-3行のみ記載し、複雑な運用規則は設けない。
2. RSS取り込み出力ディレクトリの扱い → 確定: 対象外のままガイドに明記する。`rss-import-downloads`は取り込み出力ディレクトリ直下の`.castloop/`に作られるjournal family(`control.json`+資産別JSON、小容量)で、サービスworkspaceには存在しない(取り込みは空ディレクトリ必須のため)。取り込み出力ディレクトリは`castloop.toml`を持たないため`backup-create`の対象外となる。移行作業用の一時ディレクトリであり、公開済み分はR2が第一保護、作業中の喪失は元フィードからの再取り込みで復旧できる。任意ディレクトリのバックアップ対応は別の機能になるため本計画では行わない。
3. scryptパラメータ → 確定: N=2^15, r=8, p=1, salt 16 bytesのまま(PBKDF2-SHA-256への変更はしない)。
