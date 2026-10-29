# 管理workspaceのバックアップと復元

Issue #63で導入した管理workspaceのバックアップ・整合性検証・復元支援。4つのコマンドはいずれも**通信せずlocal完結**で動作し、Cloudflare API tokenもアカウント情報も読まない。管理キーを失うとデプロイ済みサービスが回復不能になるため、`.castloop/`を含むworkspaceの保全はバックアップ以外に対策がない。

```sh
castloop backup-create --workspace /abs/workspace --output /abs/backup.clbk --passphrase-file /abs/pass.txt
castloop backup-verify /abs/backup.clbk --passphrase-file /abs/pass.txt
castloop backup-restore-preview /abs/backup.clbk --dest /abs/new-workspace --passphrase-file /abs/pass.txt
castloop backup-restore /abs/backup.clbk /abs/new-workspace confirm --passphrase-file /abs/pass.txt
```

## 対象と除外

**対象**: `castloop.toml`・`castloop-admin.toml`(存在時)、`.castloop/`配下の既知journal family全15種(`sqlite-client`のclient ID、`secrets.json`の管理キー、draft・upload・publication等の操作記録)、Showディレクトリ(`show.toml`・Episode TOML・カバー等の素材)。

**除外**(manifestと実行結果に記録され、黙って落とすことはない): `*.lock`と`*.lock.sqlite`(`-journal`/`-wal`/`-shm` sidecar含む)は再生成されるため対象外。`*.tmp`も対象外。`.gitignore`は復元時に再生成するため対象外。**`*.mp3`音源原本は既定で対象外**で、`backup-create --include-audio`を明示指定したときだけ含まれる。

未知のトップレベルエントリ(workspace直下の関係ないファイル・ディレクトリ、`.castloop/`内の未知family)は`unknown`として記録し対象外にする。対象内のsymlinkはエラーとして作成を拒否する。

RSS取り込み(`import-rss --output`)の出力ディレクトリは`castloop.toml`を持たないため対象外。移行作業用の一時ディレクトリであり、公開済み分はR2が第一保護、作業中の喪失は元フィードからの再取り込みで復旧できる。

## パスフレーズ

アーカイブはscrypt(N=2^15, r=8, p=1, salt 16 bytes)で鍵導出し、4 MiBチャンクごとにAES-256-GCMで暗号化する。パスフレーズは8〜1024 bytesで、`--passphrase-file`(0600推奨のファイル。末尾の改行は1つまで無視される)またはTTYプロンプト(createは2回入力)からだけ読む。コマンドライン引数と環境変数は提供しない。`--json`・`--non-interactive`では`--passphrase-file`が必須。誤パスフレーズと破損は同じ固定文で報告し、区別可能な情報を与えない。

**パスフレーズを忘れるとアーカイブは復元できない。**管理キーと同じく、再発行の手段は存在しない。

## 作成と頻度

`backup-create`は各ファイルを1回だけ読み、SHA-256の計算・manifest記録・暗号化を同一の読み取りで行う。既定のバックアップは管理キー・journal・TOML・カバーだけの小さなアーカイブになり、日常はこちらで十分な頻度で取れる。

音源込み(`--include-audio`)の頻度は**低くてよい**。公開済み音源の第一の保護はR2の不変保持とrevision履歴であり、音源込みバックアップが独自に守るのは「未公開原本」と「アカウント・バケット級災害への備え」に限られる。目安は、失えない未公開原本を追加したとき、または低頻度の定期(例: 月次)の2-3行の運用だけとし、それ以上の複雑な規則は設けない。

並行操作の扱い: journalを含むCLIのローカル書き込みはすべて一時ファイル+renameの原子的な方法で行われるため、バックアップが読むのは常に各ファイルの完全な新旧いずれかであり、破れたコピーは生じない。バックアップ中に他の操作があった場合の結果は「ある中間時点のスナップショット」であり、1秒前に取得したバックアップと本質的に同じで、既存の観測・再送禁止の契約の内側で扱える。ただし利用者自身がエディタ等でTOML・カバー・音源をバックアップ中に保存する書き込みはCLI管理外のため、**バックアップ中はworkspaceの編集・他操作をしない**ことを推奨する。

## 検証

`backup-verify`はアーカイブを完全に復号し、全エントリのSHA-256・manifest・`castloop.toml`の妥当性・ciphertext trailerを検証する。含まれたファイル・除外の一覧・残存lock・未完了操作(観測中のdraft・未解決publication・未完了control/domain/service-update)と、走査できなかったfamilyの有無(`scan_errors`)を報告する。

検証成功はアーカイブの整合性だけを証明する。server側SQLite状態の復旧、未確認要求の解消、公開の成功は保証しない。

## 復元

`backup-restore-preview`は何も書かずに展開予定(パス・size・衝突検査)とmanifest要約を表示する。`backup-restore`は**存在しないパス**だけに展開し、`..`・絶対パス・重複パスを含むアーカイブを拒否し、展開したファイルのhashをmanifestと照合する。失敗した場合は部分展開先を残さず破棄する。`castloop.toml`は必ず先頭エントリで、その検証に成功するまで他のファイルを書かない。

復元したworkspaceはconfig hash・管理キー・client_idが同一のため、同一サービスの管理をそのまま継続できる。復元後は`castloop doctor --local --workspace DEST`で管理キーの読取を確認する。

未完了操作の扱い: 復元後に許されるのは`operation-status`等の**観測**と、既存の安全条件内での続行だけである。未知の要求を再送しない。未完了draftは`source_path`絶対パスに原本が同一パスで存在しない限り続行できないため、manifestの`source_paths`とpreviewで確認する。同一パスを維持できない場合はdraftの観測のみ行い、新規draftを作り直す。

## アーカイブ形式

```
"CASTLOOP-BACKUP-1\n"                 平文マジック+形式番号
{header JSON}\n                       平文: kdf情報, salt, service_id, entry_count, entry_bytes 等
{暗号化チャンク列}                     チャンクごと: 0x00 + u64be長 + nonce(12) + ciphertext + tag(16)
  復号後のペイロード:                  エントリごと: 0x01 + 長 + {path,kind,size} → 本文 → 0x02 + SHA-256(32bytes)
                                      最後: 0x03 + 長 + manifest JSON(対象・除外・残存lock・未完了操作・source_paths)
{暗号化領域全体のSHA-256 trailer}      転送破損・truncationの検出用(パスフレーズなしで検出可能)
```

manifestは単一読み取りでhashが確定するようにペイロード末尾に置く。改ざん・誤鍵の検出はGCM tagが担う。外部依存は追加しておらず、`node:crypto`だけを使う。

## 実装と検証の記録(2026-10-26)

Issue #63の実装として`packages/cli/src/backup-archive.ts`(コンテナ形式)・`backup-create.ts`・`backup-restore.ts`・`backup-passphrase.ts`を追加し、4コマンドをCLIに登録した。

- 自動試験: `bun test` 813 pass / 0 fail(バックアップ追加試験13件を含む。多チャンク境界、誤パスフレーズ、バイト改変・truncation・trailer破損、`..`/絶対パス/重複パス/digest不一致の細工アーカイブ、復元中失敗の破棄、`--include-audio`内外、symlink拒否、scan_errors、CLI外枠)。`npm run check`成功。
- 実データ確認: `.local-test-data`の実workspaceコピー(現行形式に`storage_layout`を補完した旧保持環境 `sq16r-6ec01dc6`（2026-10-29廃棄）のコピー、395エントリ)と実MP3 3件(約128MB)で作成・検証・preview・復元・`doctor --local`を通し、復元先との全tree差分なし・管理キー同一・`.gitignore`再生成を確認した(既定0.4秒/音源込み138MB 0.96秒/復元1.2秒)。旧schema 1 workspaceと`castloop.toml`なしのRSS取り込みディレクトリは拒否されることも確認した。同workspaceの`sqlite-controls`記録は旧形式のため`scan_errors`に記録され、復元前後で`doctor --local`の結果は同一だった。
- 未検証: TTYプロンプト(エコー抑制)は対話試験を行っていない。Cloudflareへの通信・実資源変更は本機能の対象外で行っていない。
