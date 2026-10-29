# SQLiteのShow単位公開方式

フェーズ2開発版は、新規環境専用の内部queue/content形式 **13/13** を使う。サービス設定はversion 2・`show-v1`、metadataはversion 1のまま。旧形式の変換・資源採用・互換配備は行わない。配布済み版の仕様・実機記録とは区別する。

## 構成と公開

1サービスにprivate R2 bucket、Worker、所属と共有保守を扱う制御DOを置き、ShowごとにSQLite DOと停止・再開状態を分離する。Queues・D1は使わない。

```text
CLI: ローカル入力の検証 → 素材をR2へ直接配置 → metadataと素材参照を送信
Show DO: 公開条件の検証 → 必要なcache purge → 単一SQLiteトランザクション
```

metadataはJSONで直接送り、R2へ置かない。音声・画像はShowとSHA-256から導出したキーへ保存する。CLIは検証した素材を公開済み参照と比較し、同じならR2へ通信せず既存参照を使う。変わったとき・初回だけPUTし、送信元の読取完了、HTTP 200、JSON成功、応答のkey・sizeを確認する。PUT前の存在照合（LIST・HEAD）と、アップロード後の全量ダウンロード、DOでの素材確認・コピーは行わない。確定前に失敗した再実行は同じキーへ同じ素材を再PUTする。音声上限は300,000,000 bytes、画像は5,000,000 bytes。

DOは公開内容・履歴・素材参照・短縮ID・Feed世代を一括更新する。同じmetadata・素材・公開状態なら、パージや履歴追加なしに`unchanged`と現在のrevision IDを返す。内容が異なる場合だけ更新元を照合し、不一致は409にする。パージ失敗・トランザクション失敗では公開内容を変えない。公開job台帳・操作追跡表・公開用journal・専用lockは使わない。

Feed/HTMLは確定済みSQLite内容からオンデマンド生成する。旧音源・revision履歴を保持し、固定cover URL・音源URL・短縮ページURL、停止条件、キャッシュ世代、HEAD/Range/条件付き応答を維持する。未参照素材の自動削除は提供しない。

## 初期化と通常公開

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
castloop init /path/to/workspace --service-id my-service \
  --bucket-name my-private-bucket --workers-subdomain my-account-subdomain --operation-id INIT_UUID
cd /path/to/workspace
castloop create-show my-show --site-mode builtin
castloop show-resume my-show NEW_WINDOW_UUID
# Edit my-show/show.toml and place the cover named in image_path.
castloop preview-show my-show --remote --json
castloop publish-show my-show --expect-preview REVIEWED_HASH
cd my-show
castloop create-episode first
# Edit episode-first.toml and prepare audio.mp3.
castloop preview-episode first audio.mp3 --remote --json
castloop publish-episode first audio.mp3 --expect-preview REVIEWED_HASH
```

初期化は未知資源を採用せず、登録したShowはpausedから始まる。`create-*`と`preview-*`は公開しない。`publish-episode ID [MP3]`はMP3指定時に音声も更新、省略時に公開済み音声を再利用する。初回だけMP3が必須。metadata-onlyではTOML編集後に`publish-episode ID`を実行する。GUID・日時を保持し、公開済みcover拡張子は変えない。

`--expect-preview`はローカル入力と確認した更新元に結び付く。応答喪失後でも既に同じ内容が公開済みなら変更なしになる。CLIは更新元の自動取り直し・再送を行わない。[差分と履歴](published_content_review.md)を参照。

## 予約・RSS・非公開化

- 予約はローカルmetadataと配置済み素材参照を予約表へ凍結する。時刻到来時の公開と実行済み状態は同じトランザクションで確定する。Pause等では`needs_approval`となり、Resumeだけでは再開しない。[予約操作](admin_configuration.md)を参照。
- `publish-rss-import`はShow→各Episodeの順に公開する。取得・新Show登録・一括進捗記録は維持し、個別upload/job追跡は行わない。[RSSガイド](rss_migration.md)を参照。
- 非公開化は`preview-episode-lifecycle SHOW EPISODE unpublish`→計画確認→`lifecycle-execute FILE HASH confirm`。`restore`は保存済み内容を使い、Showの復元で個別非公開Episodeを復活させない。同じ状態は変更なし。物理削除は未実装。

## 停止・再開

`show-admission-pause SHOW UUID`は公開受付だけ、`show-pause`は配信も停止する。`show-delivery-resume`は配信だけ、`show-resume`は受付も再開する。`show-control-status SHOW UUID`で操作適用時の結果と現在状態を区別する。今回、これらの制御記録・保守手順は簡素化しない。[利用ガイド](show_availability.md)を参照。

## 互換Worker更新

**同じ永続形式・設定・namespace間だけ**で行う。旧形式から13/13への更新には使えない。

```sh
castloop show-pause my-show PAUSE_UUID
# Repeat for every Show and confirm paused, drained and ready.
castloop service-status
castloop deploy --operation-id UPDATE_UUID
castloop service-status
castloop show-resume my-show NEW_WINDOW_UUID
```

制御DOで所属を固定し、各Showに保守拘束を保存する。全件準備後に配備し、新versionのAlarm/R2/cache/purgeを確認して保守を解除する。各Showはpausedのまま。部分結果や不明な準備・配備・activationは自動再送・解放しない。

`update-service-reconcile UPDATE_UUID`は正確な完了証拠のGET照合だけ。`update-service-verify UPDATE_UUID`は保存済みの`deploy_acknowledged`／`deployed`／`verified`から、凍結入力・ETag・配備version・namespace・prepared状態を照合し、未実行の初回activation/probeを明示的に続ける。配備・準備・R2 uploadを繰り返さない。receiptのない`deploy_requested`や`activation_requested`は対象外。詳しくは[更新復帰契約](../design/sqlite_worker_update_recovery.md)を参照。

独自ドメイン変更は[専用保守手順](sqlite_custom_domains.md)を使い、通常deployに混ぜない。

## エラーと検証範囲

公開応答が不明なら現在の内容を確認し、同じ承認済み入力でやり直せる。これはinit・登録・Resume・deploy・domainの未知結果を再送してよいという意味ではない。それらのjournal、既存素材、原本、証跡は保持する。空のキューや経過時間を削除・解除の根拠にしない。

`diagnose`は状態、`verify`は確定内容と公開配信を確認する。廃止したjob照会・operation操作・progress/watchは使わない。[診断](observability.md)を参照。

この開発版の確認はローカルSQLite・模擬R2・CLI試験とbuildに限る。native Cloudflare性能、Free適合、実環境配備は未確認であり、別途承認が必要である。
