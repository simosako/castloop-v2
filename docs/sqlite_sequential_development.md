# SQLiteのShow単位公開方式

フェーズ3開発版は、新規環境専用の内部queue/content形式 **14/13** を使う。サービス設定はversion 2・`show-v1`、metadataはversion 1のまま。旧形式の変換・資源採用・互換配備は行わない。配布済み版の仕様・実機記録とは区別する。

## 構成と公開

1サービスにprivate R2 bucket、Worker、Show登録・一覧・独自ドメイン状態を扱う制御DOを置き、ShowごとにSQLite DOを分離する。Queues・D1は使わない。

```text
CLI: ローカル入力の検証 → 素材をR2へ直接配置 → metadataと素材参照を送信
Show DO: 公開条件の検証 → 必要なcache purge → 単一SQLiteトランザクション
```

metadataはJSONで直接送り、R2へ置かない。音声・画像はShowとSHA-256から導出したキーへ保存する。CLIは検証した素材を公開済み参照と比較し、同じならR2へ通信せず既存参照を使う。変わったとき・初回だけPUTし、送信元の読取完了、HTTP 200、JSON成功、応答のkey・sizeを確認する。PUT前の存在照合（LIST・HEAD）と、アップロード後の全量ダウンロード、DOでの素材確認・コピーは行わない。確定前に失敗した再実行は同じキーへ同じ素材を再PUTする。音声上限は300,000,000 bytes、画像は5,000,000 bytes。

DOは公開内容・履歴・素材参照・短縮ID・Feed世代を一括更新する。同じmetadata・素材・公開状態なら、パージや履歴追加なしに`unchanged`と現在のrevision IDを返す。内容が異なる場合だけ更新元を照合し、不一致は409にする。パージ失敗・トランザクション失敗では公開内容を変えない。公開job台帳・操作追跡表・公開用journal・専用lockは使わない。

Feed/HTMLは確定済みSQLite内容からオンデマンド生成する。旧音源・revision履歴を保持し、固定cover URL・音源URL・短縮ページURL、キャッシュ世代、HEAD/Range/条件付き応答を維持する。未参照素材の自動削除は提供しない。

## 初期化と通常公開

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
castloop init /path/to/workspace --service-id my-service \
  --bucket-name my-private-bucket --workers-subdomain my-account-subdomain --operation-id INIT_UUID
cd /path/to/workspace
castloop create-show my-show --site-mode builtin
# Edit my-show/show.toml and place the cover named in image_path.
castloop preview-show my-show --remote --json
castloop publish-show my-show --expect-preview REVIEWED_HASH
cd my-show
castloop create-episode first
# Edit episode-first.toml and prepare audio.mp3.
castloop preview-episode first audio.mp3 --remote --json
castloop publish-episode first audio.mp3 --expect-preview REVIEWED_HASH
```

初期化は未知資源を採用せず、登録したShowは即座に稼働可能となる（`show-resume`は不要）。`create-*`と`preview-*`は公開しない。`publish-episode ID [MP3]`はMP3指定時に音声も更新、省略時に公開済み音声を再利用する。初回だけMP3が必須。metadata-onlyではTOML編集後に`publish-episode ID`を実行する。GUID・日時を保持し、公開済みcover拡張子は変えない。

`--expect-preview`はローカル入力と確認した更新元に結び付く。応答喪失後でも既に同じ内容が公開済みなら変更なしになる。CLIは更新元の自動取り直し・再送を行わない。[差分と履歴](published_content_review.md)を参照。

## 予約・RSS・非公開化

- 予約はローカルmetadataと配置済み素材参照を予約表へ凍結する。時刻到来時の公開と実行済み状態は同じトランザクションで確定する。更新元（base revision）の競合や独自ドメイン変更では`needs_approval`となるが、通常のコード配備（`deploy`）では予約はそのまま維持される。[予約操作](admin_configuration.md)を参照。
- `publish-rss-import`はShow→各Episodeの順に公開する。取得・新Show登録・一括進捗記録は維持し、個別upload/job追跡は行わない。[RSSガイド](rss_migration.md)を参照。
- 非公開化は`preview-episode-lifecycle SHOW EPISODE unpublish`→計画確認→`lifecycle-execute FILE HASH confirm`（番組全体は`preview-show-lifecycle SHOW unpublish`）。`restore`は保存済み内容を使い、Showの復元で個別非公開Episodeを復活させない。同じ状態は変更なし。物理削除は未実装。独立したruntime停止コマンド（`show-pause`／`show-resume`等）は廃止し、配信制御はこのlifecycle操作に一本化した。

## 互換Worker更新

**同じ永続形式・設定・namespace間だけ**で行う。旧形式から14/13への更新には使えない。

```sh
castloop deploy
castloop service-status
```

事前Pause、drain待ち、2相コミット、ローカルjournal、手動Resumeは不要。CLIはサービス設定hashと既知ドメインの一致を確認した上でWorkerスクリプトをPUTし、配備の反映とhealthの`publication_ready`を確認して完了する。R2の音源・画像は一切変更せず、通信断等で中断した場合はもう一度 `castloop deploy` を実行すれば完了する。

独自ドメイン変更は[専用保守手順](sqlite_custom_domains.md)を使い、通常deployに混ぜない。

## エラーと検証範囲

公開応答が不明なら現在の内容を確認し、同じ承認済み入力でやり直せる。`init`・`create-show`・`deploy`・`domain continue`も、中断時は現在の状態をAPIで確認して同じ目標状態へ再実行・継続できる。既存素材、原本、履歴は削除しない。

`diagnose`は状態、`verify`は確定内容と公開配信を確認する。廃止したjob照会・operation操作・progress/watchは使わない。[診断](observability.md)を参照。

この開発版の確認はローカルSQLite・模擬R2・CLI試験とbuildに限る。native Cloudflare性能、Free適合、実環境配備は未確認であり、別途承認が必要である。
