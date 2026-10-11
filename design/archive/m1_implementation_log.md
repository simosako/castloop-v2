# M1 実装・実機確認記録

## 2026-09-23: ローカルモデル・サービス初期化・Show ID予約

- `packages/shared`にstrictな`parseServiceConfig`、`parseShowMetadata`、`parseEpisodeDraft`、`stringifyToml`とslug検証を実装。入力TOMLから未知のキー・生成済み公開項目を拒否し、Episodeの日時は引用符付きの秒・offsetを含むRFC 3339文字列に制限する。
- `packages/cli`に`init`、`create-show`、`create-episode`を実装。`init`はサービス設定を作り、Wranglerでprivate R2 bucket・Queue・DLQ・Worker・通知ruleを作成し、R2の`system/service.toml`へ設定を保存する。ローカルの`.castloop/`に秘密の管理keyと進捗・Show予約IDを保持し、作業ディレクトリの`.gitignore`に追加する。途中失敗時には作成済みリソースを削除せず、同じ設定で再試行する。
- Workerの認証付き`POST /admin/shows/reserve`はR2の`system/show-reservations/<showId>.json`へ`If-None-Match: *`の条件付きPUTを行う。ローカル下書きを先に保存し、通信断後は同じ予約IDで再送できる。予約キーと`system/shows/<showId>/show.toml`の公開snapshotは分離。管理用経路以外は非公開で、公開処理のconsumerはM2実装まで失敗を返す。

### 確認結果

専用のM1検証サービス（作業ディレクトリ `/tmp/opencode/castloop-m1-smoke/`、リソース名の控え `/tmp/opencode/castloop-m1-smoke-resource.json`）で実機確認した。アカウントID・API token・管理用keyの値は記録しない。後続のM2検証で利用できるよう専用リソースは保持する。

| 検証 | 結果 |
| --- | --- |
| `init` | API tokenでR2/Queue/DLQ/Workerの作成・deploy、R2への`system/service.toml` upload、`staging/` prefix・`commit.json` suffixの通知rule登録が成功。管理keyを使ったWorkerのhealth確認も成功。再実行は成功し、既存設定を上書きしない |
| `create-show` | `demo-show`のWebサイトURLをローカル`show.toml`へ記入し、R2に予約記録を作成。同じローカル予約IDの再送は成功。別のIDを使った同一Showへの12件同時要求は`201`が1件、`409`が11件 |
| `create-episode` | ShowディレクトリにGUIDと実行時の秒・offset付き日時を含むTOMLを作成。同一ファイルへの再作成は`EEXIST`で拒否 |
| 公開経路 | 未対応の管理用GET・`system/`・`staging/`のGETは`404`。管理用のPOST/healthには管理keyが必要。R2にはサービス設定とShow予約記録が存在するが、未公開Showのfeedや画像は作られない |
| ローカル検証 | `bun test`（TOMLの厳格性と予約の競合）、`npm run check`、Wrangler `deploy --dry-run`に合格 |

**M1の現状:** 必要なローカルモデル、初期化、Show/Episode下書き生成、原子的なShow ID予約を実装・確認した。製品の公開consumer、feed、音源、job status、Show/Episodeの更新と公開コマンドはM2以降の対象。独自ドメインへの切替、初期化コマンドのリソース作成成功直後に応答を失った場合の自動照合、別端末に置いたローカル予約IDの移行は今後の運用課題とする。
