# Issue #122：メディアのR2・CDN直配信と長期アクセスログの実装案

検討日：2026-11-03。対象：[Issue #122](https://github.com/simosako/castloop-v2/issues/122)。

本書は、Issue #122の実装方針を決めるための検討書である。Cloudflareの機能・料金は末尾の公式資料に基づく。対象アカウントでの利用可否、性能、費用は、実装・導入時に確認する。

## 1. 推奨方針

**音声・カバーはR2・CDNから直接配信し、HTTP Requests Logpushで取得したアクセスログを非公開R2に400日保存する構成を推奨する。** 独自ドメインを使うサービスが対象で、Feed・HTML・管理APIは引き続きWorkerで処理する（Issueの4a）。

この構成の狙いは、メディア配信によるWorkers・DOの要求数を減らしながら、統計の作成と12か月以上のログ保持を両立することである。実装方針は次の4点にまとめられる。

1. **配信とログ収集を分離する。** メディア要求はCDNからR2へ流し、Logpushがエッジのアクセス記録を別途保存する。Logpushは2026-09-30からFreeを含む全プランで利用でき、R2向け転送にはアカウントあたり月25GBの無料枠がある。[C1][C2]
2. **アクセスごとのログを400日保持する。** ログを再集計の元データとし、Show DOには照会用の日別集計を保存する。
3. **CDN配信に合った統計を提供する。** 要求数や本文バイト数を集計し、既存のBot判定・Range分類との違いを利用者に示す。
4. **400日分のデータを含めて無料枠への適合を判断する。** ログ転送量・保存量・R2操作回数と、原本・公開用メディアの保存量を合算する。

採用にあたって最初に決める必要があるのは、公開操作の途中で障害が起きた場合の扱いである。現行はSQLiteの確定状態を基準に配信するが、直配信ではR2への反映とSQLiteの更新に時間差が生じる。許容する公開タイミングと失敗時の状態を[§7](#7-公開操作とドメイン変更の採用条件)で合意したうえで実装に進む。現行と同じ厳密な一括反映を優先する場合は、Worker配信を継続する。

## 2. Issueの要件と現行実装

### Issueが解決したいこと

- Issue #118の判定キャッシュは実装済み。通常のキャッシュヒットでは、音声は統計用DO呼び出し1回、Feed・カバー・HTMLはDO呼び出し0回になっている。
- 次の制約は、アカウント全体のWorkers Freeの100,000要求/日である。メディアを独自ドメインのCDN→R2へ移し、その要求によるWorkers・DOの消費を減らす。
- `workers.dev`だけのサービスは、引き続き現行経路で配信する。
- 非公開化、再公開、履歴採用、独自ドメイン変更、GUID不変、統計の代替まで検討する必要がある。

実装の前提となる現行仕様は、[配信](components/delivery.md)、[Show DO](components/show-do.md)、[保存構造](data/storage.md)、[セキュリティ](security.md)にある。Issueが参照する旧検討文書は`design/archive/`に保存されている。

### コードで確認した接続点

配信経路と統計処理はCodeGraphで確認した。

| 箇所 | 現行の動作と今回の影響 |
| --- | --- |
| [`src/sqlite-gateway.ts`](../src/sqlite-gateway.ts) | キャッシュを含む音声の200・206・304応答を観測。HEAD、Content-Length、Content-Range、既知Bot判定を統計へ渡す。直配信はここを通らない |
| [`src/sqlite-worker.ts`](../src/sqlite-worker.ts) | `recordDeliveryStats`で対象Show DOへ記録。R2とDOのバインディングは既存のまま維持する |
| [`src/sqlite-delivery-stats.ts`](../src/sqlite-delivery-stats.ts) | Episode・音声リビジョン・UTC日付別のカウンタ。記録時刻で日付を決めるため、遅れて届くログの取り込みにそのまま流用できない |
| [`packages/shared/src/sqlite-stats.ts`](../packages/shared/src/sqlite-stats.ts) | 取得開始はGET 200、または先頭から`min(65,536バイト, 音声サイズ)`以上のGET 206。IP・Cookie・User-Agent原文は保存しない |
| [`src/media-url.ts`](../src/media-url.ts)、[`src/feed.ts`](../src/feed.ts) | 音声の正規URLを組み立てる。現在はFeed・サイト・音声・カバーで同じ公開基底URLを使う |
| [`src/site-renderer.ts`](../src/site-renderer.ts) | 音声は同一オリジンの相対パス、CSPの画像・音声許可は`'self'`。メディアオリジンの明示的な追加が必要 |
| [`src/sqlite-publication-content.ts`](../src/sqlite-publication-content.ts) | 公開状態と承認済み素材参照で配信を制限。Episode公開中は旧音声リビジョンも配信可能 |
| [`packages/cli/src/sqlite-media-upload.ts`](../packages/cli/src/sqlite-media-upload.ts) | SHA-256付きキーへ非公開アップロード。公開URLと保存キーは異なる |

### 今回のログ保持要件

現行機能が既定で400日保持するのは、日別の集計値である。今回必要なのは、アクセスごとの記録を最低12か月参照できることである。本案では、次の方針で400日分の個別ログを保存する。

- 保存する内容はアクセス時刻・対象・メソッド・応答状態などに絞り、個人識別情報の収集を抑える。
- 個別ログを再集計の元データとして保存し、日別集計は照会しやすい形で別途管理する。
- 収集元の保持が7日・31日・3か月のサービスも、失効前にR2へ定期保存する構成で比較する。
- 保持期間と記録の網羅性をそれぞれ評価する。サンプリングを使う案では、保存できるのは抽出されたアクセスの記録になる。

本案では、現行の音声統計と同じ成功応答を中心に、サンプリングせず収集する方式を推奨する。これは再集計のしやすさを重視した提案である。サンプルログを保存して推定統計を作る方式も、選択肢として比較する。

## 3. 配信構成の比較

| 案 | メリット | デメリット・制約 | 判断 |
| --- | --- | --- | --- |
| **4a：音声・カバーのみR2直配信、Feed・HTMLはWorker** | メディア要求をWorkers・DOから外せる。Feed・HTMLの生成、公開状態判定、管理APIを維持できる | 公開バケット、メディアドメイン、ログ、パージ連携が必要。Feed・HTMLのWorkers上限は残る | **推奨** |
| 4b：Feedも生成済みファイルとしてR2へ配置 | Feed要求もWorkers枠外。R2側で条件付き要求を処理できる | メディア・Feed・サイト・SQLiteの反映順序がさらに増える。予約、非公開化、ドメイン変更時の整合性が複雑になる | 将来の拡張候補 |
| 現行Worker配信＋DO統計、またはAnalytics Engineへ統計移管 | 公開状態の判定と既存のHTTP統計を維持しやすい | Analytics Engineに移しても入口の100,000要求/日は解消しない。個別ログの長期保存は別途必要 | 現行の公開仕様を維持する場合の推奨 |

計測用WorkerからR2へリダイレクトする方式では、音声要求ごとにWorkers枠を消費する。要求数の制約を緩和するには、リスナーがCDN・R2へ直接アクセスする経路が必要になる。

## 4. Cloudflareの統計・ログ機能の比較

### 無料枠と観測範囲

| 機能 | 観測できる範囲 | 保持期間・無料枠 | 適した用途 |
| --- | --- | --- | --- |
| **HTTP Requests Logpush → 非公開R2** | エッジのHTTP要求をパス別に記録できる。非サンプリング出力を指定可能 | 全プラン。R2等の内部宛て転送25GB/月。料金は**非圧縮**の転送量。R2保存・操作は別枠。[C1–C4] | **第一候補** |
| GraphQL Analytics APIのHTTPデータセット | エッジ側のサンプル・推定集計。利用可能なフィールド次第でホスト・パス別に取得 | Adaptiveデータは少なくとも31日。Freeの提供フィールド・期間・件数は`settings`で確認する。[C7][C8] | サンプルログの保存と推定統計 |
| Workers Analytics Engine | Workerから書き込んだイベント。直配信を計測するには別途イベントの収集経路が必要 | Freeは100,000点/日・10,000読取/日、保持3か月。書込時・読取時にサンプリングがある。[C9] | Worker経路の統計保存・分析 |
| R2 Data Access Logs | R2まで到達したオブジェクト操作。CDNヒットで完結する要求は対象外 | 保持7日、HTTPステータス400未満の応答のみ。欠損があり得るbest effort方式。2026-12-01からObservabilityのFree枠は0.5GB/日・7日保持。[C10] | 原本アクセス等の調査 |
| R2 Metrics / GraphQL | R2操作をオブジェクト別に分析可能だが、CDNヒットはR2操作にならない | 最大31日範囲の照会。帯域データは100KiB未満の転送を除外。[C11] | R2操作量・費用の監視用 |
| Cloudflare Web Analytics | Webページ上の計測。Podcastアプリの音声HTTP要求は収集範囲外 | 全プランで利用可能。内蔵サイトは現状JavaScript禁止。[C12] | Webサイトの閲覧分析 |
| Workers Logs / Tail Workers | Workerが処理した要求・イベント | 直配信はWorkerを通らないため収集範囲外 | Workerの動作調査 |
| Observabilityの非サンプリングHTTP Requests保存 | CDN要求を調査可能 | Log Explorer系の有料取り込み。共通Observability無料枠とは別で、$1/GB・30日保持。[C10] | 有料でのHTTP要求分析 |

提供範囲が更新されているため、導入時には最新の案内と対象アカウントのデータセット・フィールドを照合する。

### 統計代替案のメリット・デメリット

| 案 | メリット | デメリット | 12か月ログ保持 |
| --- | --- | --- | --- |
| **A：HTTP LogpushをR2へ直接保存** | 配信とログ収集をWorkerから分離できる。ログが継続保存され、後から再集計できる | R2宛て認証とLogpush管理が増える。転送・保存・操作回数の見積もりが必要。ログ配送の障害で欠損が生じる場合がある | **R2で400日保持できる。推奨** |
| B：GraphQLの結果を定期取得してR2へ保存 | コンテンツのWorkerを通さず、比較的小さい集計結果を保存できる。R2とShow DOを使える | サンプリング、Freeのフィールド制限、取得件数制限。全件アクセスログや既存のRange分類は再現できない | 個別サンプルを保存すれば、そのログを400日保持可能。集計だけの保存とは区別する |
| C：WorkerでAnalytics Engineへ記録し、定期保存 | DOへの毎要求書き込みを減らせる。日別・Episode別の推定分析に適する | Workerでのイベント記録が必要で、全件を通すとWorkers上限が残る。サンプリングにより個別記録の取り出し範囲も制限される | 取得できた集計・サンプルを400日保存できる |
| Aの変形：HTTP Logpush → バッチ受信用Worker → R2 | 管理端末にR2用の別認証情報を要求せず、R2 bindingで保存できる。Worker要求はアクセスごとでなくログバッチごと | 受信認証、保存完了応答、FreeのCPU制限の検証が増える。HTTP宛ては外部転送扱い（こちらも25GB/月含む） | 保存成功後はAと同じ。直接R2宛ての認証が運用条件に合わない場合の比較候補 |

直配信のアクセスを個別に記録し、再集計に使う目的にはAが最も適している。Bはサンプルログと推定値で運用する場合の次点、CはWorker配信を続ける場合に適した案である。

### 保持期間の短いサービスを使う場合

B・Cも定期エクスポートを組み合わせれば、取得できたデータを400日保持できる。

- **B：GraphQLを日次取得する。** Cronで前日と直近の取得済み期間を再取得し、31日の失効前に個別サンプルと集計をR2へ保存する。
- **C：Analytics Engineを日次取得する。** CronからSQL APIを呼び、UTC日別・Episode別の集計と取得可能なサンプル行を、3か月の失効前にR2へ保存する。

どちらも、APIの期間・件数上限に合わせて取得範囲を分割する。再取得時は同じ期間の集計を置換し、Show DOには照会用の結果を保存する。長期保存によって参照できる期間は延びるが、記録の網羅性は収集元のサンプリング仕様に従う。

## 5. 推奨構成の具体案

### バケットとURL

```text
リスナー ── public_base_url ── Worker ── Feed・HTML・管理API
         └─ media_base_url  ── CDN ── 公開メディアR2
                                  └─ 公開中の音声・カバーの写しだけ

HTTP Requests Logpush ── 非公開ログR2 ── CLIで再集計 ── 対象Show DOの日別集計

既存の非公開R2 ── 音声・カバー原本、system/service.toml
```

- 既存の非公開バケットは原本・履歴復元元として残す。`system/`、`staging/`、未公開素材もこの非公開領域で管理する。
- 公開メディアバケットには、公開中の音声・カバーの写しだけを置く。
- ログは別の非公開バケットに保存する。Logpushの書き込み権限をこのバケットに限定し、設定・原本から分離する。
- 公開メディアのキーは`podcasts/<show_id>/episodes/<episode_id>/<audio_revision_id>.mp3`と`podcasts/<show_id>/cover.jpg|png`。URLパスから先頭の`/`を除いたものにする。
- `media.<domain>`を同一CloudflareアカウントのR2カスタムドメインへ接続する。公開・ログバケットとも`r2.dev`経路は無効にする。[C3]
- サービス設定には、メディア基底URL、公開メディアバケット名、非公開ログバケット名の追加を想定する。名前と相互条件は実装前に確定する。秘密情報は設定TOMLから分離して管理する。
- `public_base_url`はFeed・HTML用のまま。Feedのenclosure・カバー、HTMLの音声・画像だけをメディアURLへ向ける。GUID、公開日時、音声リビジョンIDは変更しない。
- HTMLのCSPは、設定で検証済みのメディアオリジンだけを`img-src`と`media-src`へ追加する。必要なCORSは公開サイトの用途に限定し、実ブラウザでRange再生を確認する。

### ログの最小内容とプライバシー

Logpushは`http_requests`を使用する。対象メディアホストの公開メディアパスについて、外部リスナーからのGET・HEADに対する200・206・304応答を収集する。CDNヒット・ミスの両方を対象とし、`sample_rate = 1`を指定する。Workerサブリクエスト等は集計対象から外す。[C4]

初版で保存するフィールドは次を候補とする。対象Freeゾーンでの提供確認が必要である。

| フィールド | 用途 |
| --- | --- |
| `EdgeStartTimestamp`、`RayID` | 発生日のUTC集計、同一要求の重複除去 |
| `ClientRequestHost`、`ClientRequestPath` | サービス・Show・Episode・音声リビジョンの対応付け。パスはクエリ文字列を含まない |
| `ClientRequestMethod`、`EdgeResponseStatus` | GET 200・206、HEAD、304の区別 |
| `EdgeResponseBodyBytes` | エッジからクライアントへ送った本文バイト数。ヘッダー込みの`EdgeResponseBytes`とは区別する |
| `CacheCacheStatus`、`ClientRequestSource`、`WorkerSubrequest` | キャッシュ内訳と集計対象の確認 |

長期保存するのは、成功した公開オブジェクトへのアクセス記録である。取り込み時にも公開パスと承認済み音声参照で対象を限定する。IP、Cookie、User-Agent原文、Referer、完全なURI、任意のヘッダーや例外本文は保存対象外とする。

### CDN統計の定義と既存統計との差

| 指標 | 初版の扱い |
| --- | --- |
| Show・Episode・音声リビジョン別の日別要求数 | URLパスから対応付け、GET 200・206、HEAD、304を分けて集計できる |
| 応答バイト数 | エッジ本文バイト数として提供できるが、現行の宣言`Content-Length`集計とは定義が異なる。HEAD・304はダウンロードバイト数に加えない |
| 既知Bot除外、Bot別GET・バイト数 | 最小構成ではBotを含む数値として提供する。既存のUser-Agentパターン判定を再現するには追加の処理が必要で、CloudflareのBot分類とも定義が異なる |
| 取得開始・微小Range | 206の開始位置が必要なため、初版では未提供。標準フィールドでは位置を取得できず、Logpushは要求のRangeヘッダーの記録にも非対応。[C5] |
| 全編取得相当数 | 本文バイト数÷承認済み音声サイズの参考値なら算出可能だが、現行指標とは別名・別定義とする |

CDNログ由来の集計には独自の取得元・指標定義を持たせる。既存の`episode-daily-v1`と区別し、取得元・期間・ホストを添えて表示する。値が0件なのか、未収集・欠損・未対応なのかも判別できる形にする。

取得開始・Bot判定を既存と同じ定義で提供する場合は、応答`Content-Range`・`Content-Length`のcustom fieldsと、User-Agentから保存前に真偽値だけを生成する方法を追加検討する。確認する点は、Freeでの利用可否と、CDNヒット時の応答ヘッダーの記録内容である。Transformersの無料入力枠は月1GBで、月25GBの転送枠とは別に見積もる。初版は標準フィールドによる最小構成とする。[C5][C6]

### 400日保持と再集計

1. Logpushから非公開ログR2の`http/<service_id>/<zone_id>/{DATE}/`へ圧縮NDJSON（1行1件のJSON）を保存する。`{DATE}`は配信ファイルの整理用で、集計日は各イベントの時刻から決める。[C3][C4]
2. ログ用のキー接頭辞に、400日後に削除する有効期限ルール（lifecycle）を設定する。保存クラスは無料枠のあるStandardを使い、400日分の容量を確保する。[C13]
3. 初版の集計は単一バイナリCLIがCloudflare RESTで読み出し、ストリーム処理する。ログの保存はLogpushが継続して行うため、集計の実行頻度と保持期間を分けて運用できる。R2 RESTはアカウントあたり1,200要求/5分の制限があり、一覧を日付で絞って同じファイルの再読込を抑える。実ファイル数で所要時間を確認する。[C20]
4. 日別・Show別の再計算ではRayIDで重複を除き、イベント発生日を使う。再読込や遅着分を反映するときは、対象取得元・日付の集計を置換する。記録時刻を使って加算する既存の`stats.record()`とは別に処理する。
5. 各Showの照会用集計は、そのShow DOに保存する。個別ログはR2で管理し、DOへの書き込みを日別集計単位にまとめる。
6. 生ログの正本はR2とし、400日の保持期間をDO側の集計保持設定から独立させる。自動集計が必要になった場合は、CronのCPU・操作回数を実測して構成を選ぶ。

Logpushは、ジョブの無効化や配送失敗によって欠損が生じる場合がある。その間の記録は後から補完できない場合もある。[C2] 運用上は収集開始、最終受信、既知の欠損期間を表示し、統計の対象期間と欠損の有無を確認できるようにする。400日保持の対象は、R2に到着したログである。

### 認証と運用

CLIは引き続き、`CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_API_TOKEN`を使ってRESTで管理する。管理端末には単一バイナリCLIと、この2つの環境変数を用意する。

LogpushからR2へ直接保存するには、`destination_conf`にR2 access key / secretが必要になる。[C3] CLIからAPIでログバケット専用トークンを作成し、その応答からR2認証値を生成してCloudflareへ設定する方法を確認する。認証値は設定時にメモリ内でのみ扱う。[C14]

導入時には、トークン作成を含む追加権限について明示承認を得る。必要な権限を付与できる運用ではR2への直接保存を採用し、権限の条件が合わない場合はバッチ受信用Worker案と比較する。

運用記録にはジョブ・接続の識別子と変更前後の設定を保存する。秘密情報を含む`destination_conf`は保存対象から外す。

## 6. 無料枠に収まる利用量の見積もり

無料枠はバケット・Showごとではなくアカウント全体で共有する。既存サービスや他用途の消費も差し引く。

| 対象 | 主な無料枠・条件 |
| --- | --- |
| Workers | 100,000要求/日。直配信メディアは消費しないが、Feed・HTML・管理・ログ受信用Worker案の要求は残る |
| R2 Standard | 保存10GB-month、Class A 1,000,000回/月、Class B 10,000,000回/月。egress無料。[C15] |
| Logpush → R2 | 非圧縮の内部転送25GB/月。超過は$0.03/GB。Transformersを使うなら別途1GB/月まで。[C1] |
| SQLite DO | 読取5,000,000行/日、書込100,000行/日、保存合計5GB。本案では日別集計の保存に使う。[C16] |

1日の対象アクセス数を`N`、選択したフィールドの非圧縮1件サイズを`b`バイト、保存時の圧縮後/圧縮前の比率を`c`とすると、概算は次になる。

```text
Logpush月間転送量 ≈ N × 30 × b
400日分のログ保存量 ≈ N × 400 × b × c
R2総保存量 = 非公開原本・履歴素材 + 公開中メディアの写し + ログ + その他の既存利用
```

試算例では、`b = 600バイト、c = 0.2`と仮定する。**いずれも未測定の値**で、GBは10億バイトとして計算する。

| 対象アクセス/日 | Logpush転送/月 | 400日ログ | 評価 |
| --- | --- | --- | --- |
| 100,000 | 約1.8GB | 約4.8GB | 原本・公開写し等が残り約5.2GBに収まるなら、保存量と転送量の条件は満たせる |
| 1,000,000 | 約18GB | 約48GB | 転送枠内でもログ保存だけでR2無料枠を超える |

公式資料による標準的なHTTPログの目安は、選択するフィールドに応じて1件1.5〜3KB程度である。[C2] 採用判断には実際のフィールドで測った値を使い、400日分が蓄積した時点の保存量を見積もる。

- Class Aにはメディア複製・ログファイル保存・一覧取得などが含まれる。Logpushのファイル数は配信状況によって変わるため、代表期間の実測値を使う。[C4]
- Class BにはCDNミス、条件付きのオリジン取得、ログの読出しが含まれる。キャッシュヒット率・Range要求・再検証を含めて評価する。
- 保存量には、原本・履歴素材と公開用の写しの両方を含める。400日のログ保持を固定条件とし、残りの枠から対応できるアクセス量を求める。

無料枠での採用条件は、これらすべてがアカウント全体の残り枠に収まることである。Freeプランでの機能提供、実際の使用量、超過時の料金をそれぞれ確認し、想定トラフィックでの費用を判断する。

## 7. 公開操作とドメイン変更の採用条件

### 維持する公開仕様

- 公開メディアの写しは、明示的な公開操作または承認済み予約の実行時に作成する。preview・素材アップロード・予約登録の段階では、素材を非公開領域で管理する。
- 非公開原本、公開済み音声の内容、履歴、GUID・公開日時・音声リビジョンの同一性を保持する。
- Episodeの公開中は、現行で配信できる旧音声リビジョンの写しも残す。非公開化では対象の**全リビジョンの公開写し**を削除し、原本は消さない。
- 再公開・履歴採用では、非公開原本から写しを作り直す。これにより、手元の原本を再アップロードせずに復元できる。
- 公開の更新元・設定ハッシュ・対象・世代照合、予約の承認、Feed・サイトの必須パージを維持する。

### クライアントとCDNのキャッシュ期間を分ける

非公開化やカバー更新を反映するため、クライアントには再検証を求め、CloudflareのCDN内では長くキャッシュする構成を推奨する。Issue案の`max-age=31536000, immutable`はブラウザにも1年間の保存を許可するため、非公開化後も保存済みの応答が再利用される。ブラウザのキャッシュはゾーンパージの対象外である。[C17]

R2のHTTPメタデータには、現行と同じ`public, max-age=0, must-revalidate`を設定する。Browser Cache TTLはこのヘッダーを尊重し、CDNの保持期間はメディアホスト限定のCache Ruleで設定する。

- 音声：Edge TTLを31536000秒にする。
- カバー：Freeで上書き可能な最小Edge TTLの7200秒にする。現行の300秒より長いため、変更・非公開化時のパージを必須とし、この差を採用条件に含める。[C17]

別案として、R2応答の`s-maxage`で音声31536000秒・カバー300秒を指定し、Cloudflareがそれを尊重する構成もある。ただし`s-maxage`はCloudflare以外の共有キャッシュにも適用され、その保存内容はゾーンパージで消せない。非公開化時のキャッシュ削除を重視し、本案ではCloudflareだけに長いTTLを設定する方を推奨する。[C18]

メディアの失敗応答はキャッシュ対象外とする。対象FreeゾーンでCache Ruleと外向けヘッダーを確認し、公開前に404が返ったURLでも、新規公開後に取得できることを検証する。

### ゾーンパージと実行主体

非公開化には、公開写しの削除→ゾーンパージ→Feed・サイト等のパージ→SQLite確定という順序が候補になる。削除前にパージすると、削除前のオブジェクトでキャッシュが再充填され得る。

FreeでもURL・Hostname・Tag・Prefixパージが利用可能である。Prefix等の制限は5要求/分、バースト25、最大100操作/要求となる。[C19] Episode単位の接頭辞を使えば、全音声リビジョンをまとめて対象にできる。APIの成功応答を確認した後、再取得でも古いHITや本文が残っていないことを確認する。

パージの実行主体は、**公開処理を担当するShow DO**を推奨する。予約Alarmでも同じ処理が必要で、CLIが終了した後にも公開が起きるためである。Show DOにはZone Cache Purgeに限定したトークンをsecret bindingで渡し、公開メディアのR2 bindingと組み合わせる。

### R2とSQLiteの反映タイミングを決める

現行Worker配信では、素材は非公開R2にあり、SQLiteの確定状態が配信可否の唯一の基準になる。このため、確定前の処理が失敗しても、それまでの公開内容と配信対象を維持できる。

このように変更全体を一括で反映する性質を、原子性と呼ぶ。R2直配信では、公開用オブジェクトとSQLiteの更新を同じトランザクションで確定できないため、次の時間差が生じる。

| 操作 | 反映順序によって生じる状態 |
| --- | --- |
| 新規公開・再公開 | R2の写しを先に作るとSQLite確定前からURLを取得できる。SQLiteを先に確定すると、写しの作成失敗時にFeedが未配信音声を指す |
| 非公開化 | 写しの削除後、パージやSQLite確定が失敗すると、DO上は公開中でも音声が欠ける。逆順なら非公開確定後に配信が残る |
| カバー差し替え | 固定URLの書き換えとShow更新を、1回のSQLiteトランザクションでまとめられない |
| ドメイン変更準備中 | 現行Show DOは503にするが、直配信ホストはDOの準備状態を自動では参照しない |

これらは通常の公開API・予約Alarm・ドメイン変更で考慮する必要がある。外部への書き込みやパージが失敗した場合、R2とSQLiteのどちらが反映済みかによって、取得できる内容が変わる。

実装前に、次のどちらを優先するかを決める。

| 優先する方針 | 配信構成と必要な合意 |
| --- | --- |
| 現行と同じ原子性・公開状態による配信制御 | Worker配信を継続する。既存の保証を維持できる一方、音声要求もWorkers枠を消費する |
| メディア要求をWorkers・DOの枠から外すこと | R2直配信を採用する。一時的な先行公開・欠配信・失敗後の差分について、許容範囲を明示的に合意する |

本書の推奨は後者を前提とする。現在の保証から変わる点について承認を得て、その範囲で、現在状態を照会して同じ承認済み入力を再適用できる処理を設計する。この合意が、直配信を採用するための条件になる。

### ドメイン変更と旧URL

- メディアドメイン・公開用バケット・Logpushの対象ホストを既存のドメイン変更手順へ含め、変更前後の設定を保存する。
- 新しいFeedだけでなく、Podcastアプリが保持する旧enclosure URLの扱いを決める。既存Worker URLからの転送は互換経路として残せるが、その要求はWorkers枠を消費する。新しいFeedがメディアを直接指すことで通常経路を移す。
- 旧メディアホストを継続利用する場合は、非公開化・パージ・ログの対象に含める。解除する場合は旧URLの利用終了を仕様として明示する。GUIDはURL変更後も維持する。
- `workers.dev`へ戻す操作では、既存の非公開原本を使って現行Worker配信を再開できることを確認する。

## 8. 実装の進め方

### 段階1：採用条件と仕様を確定する

1. §7の原子性、旧URL、ドメイン変更中の配信について合意する。この合意を、直配信実装の前提とする。
2. 対象Freeゾーンの`http_requests`、必要な標準フィールド、Logpush権限、R2宛て認証の構成方法を確認する。
3. 代表トラフィックでログ1件サイズ・圧縮率・ファイル数を見積もり、原本＋公開写し＋400日ログの予算を確認する。
4. CDN版統計の指標、欠損の表示、400日ログ保持、追加設定と設定ハッシュへの反映を仕様化する。既存の統計形式との区別を明確にする。

### 段階2：ログ取得・保持・集計を実装する

- Logpushの対象・フィールド・非サンプリング設定、専用ログR2、400日lifecycleをREST管理に追加する。
- CLIにログの取得・日別再集計を実装し、Show DOには取得元を分けた日別結果を保存する。個別ログはR2から再計算できるようにする。
- ログと統計の計測開始・保持範囲・既知欠損を照会できるようにする。既存統計も引き続き参照できる形で保持する。
- Episodeの非公開化やドメイン解除後も、過去ログを400日の保持対象にする。

### 段階3：4aの配信と公開処理を実装する

- 公開用メディアの写し、R2カスタムドメイン、Cache Rule、パージ、HTTPメタデータを追加する。
- Feed・HTML・プレビュー・公開前の生成検証で、サイト用とメディア用のURLを分離する。
- 即時公開、予約公開、Show/Episodeの非公開化・再公開・履歴採用に、合意した公開仕様に沿ったメディア反映を組み込む。
- 独自ドメイン変更・解除と設定の照合へ接続する。

### 想定する実装変更箇所

| 領域 | 主な既存ファイル・追加する責務 |
| --- | --- |
| 設定・配備 | `packages/shared/src/sqlite-service.ts`、`sqlite-worker-deployment.ts`、`packages/cli/src/sqlite-service-deploy.ts`：設定、追加binding、限定secret |
| Cloudflare管理 | `packages/cli/src/sqlite-domain-cloudflare.ts`、`sqlite-domain-operation.ts`：R2ドメイン、ゾーンルール、Logpush設定・識別情報 |
| 公開・履歴・予約 | `src/sqlite-publication-executor.ts`、`sqlite-publication-content.ts`、`sqlite-publication-schedules.ts`、`sqlite-worker.ts`：承認済み写しとパージ |
| URL・サイト | `src/media-url.ts`、`feed.ts`、`site-renderer.ts`、`publication-inputs.ts`、`sqlite-gateway.ts`：URL分離、CSP、旧Worker URL |
| ログ・統計 | `packages/shared/src/sqlite-stats.ts`、`src/sqlite-stats-http.ts`、`sqlite-delivery-stats.ts`、CLIの`stats`処理：CDN由来の別定義、日別置換、新規ログ読取処理 |
| 設計・使用方法 | `design/architecture.md`、`components/delivery.md`、`components/show-do.md`、`components/control-do.md`、`data/storage.md`、`data/schemas.md`、`security.md`、`docs/custom_domains.md`と統計の利用ガイド |

実装時は、この責務の対応を基に必要な変更箇所を絞り込む。

## 9. 実装時の確認項目

### ローカルテスト

- Feed・HTMLのメディアURL、CSP、GUID・日時・音声リビジョン不変、メタデータのみの更新時の音声URL再利用。
- 未公開アップロード・予約登録時の素材の非公開維持。旧音声の継続配信、Show全体・Episode単位の全公開写し削除、原本からの再公開・履歴採用。
- ログのUTC日付、GET・HEAD・200・206・304、本文バイト数、Botを含む指標の表示、未対応指標と0件の区別。
- 同じログの再取得や遅着ログを含む日別再計算で、イベント発生日に対して正しい件数が保存されること。
- 400日保持の設定、12か月境界を含むログ読出し、短いDO保持設定からの独立、ログ・秘密情報の出力制限。
- 既存の設定・更新元・世代照合、予約、ドメイン変更、Workerだけのサービスの動作維持。
- 合意した公開仕様に沿った、R2反映・パージ・SQLite確定の失敗時の状態と、同一入力の再適用。
- 実装変更時は`bun test`と`npm run check`を実行する。CLIの埋め込み・配備を変える場合はバイナリのスモーク試験も行う。

### 明示承認を得た非公開実機試験

- 新しいメディアホストにもCloudflare Accessを適用し、指定した確認者IDだけを許可する。原本・ログバケットは非公開を維持し、メディアバケットはAccess保護下のカスタムドメインだけを有効にする。[C3]
- `r2.dev`、別のカスタムドメイン、Workerのpreview URLを含め、全配信経路のアクセス制御を確認する。匿名GET・HEAD・条件付き・Rangeが拒否されることを、サンプルのアップロード前、配備・公開後、キャッシュが温まった後に検証する。
- CDNのHIT・MISS・206・304がLogpushに現れ、Show/Episodeへ対応付けできることを確認する。カスタムフィールドを採用するならその実値も確認する。
- メディアGETの直配信経路と、Feed・HTMLのWorker経路を確認する。メディア要求によるWorker・DOの呼び出しがなくなっていることを測定する。性能評価にはAccess保護下での試験という条件を付記する。
- 非公開化・カバー更新・ドメイン変更後に、旧URLとキャッシュから意図しない本文が配信されないことを確認する。
- 実際のログサイズ・圧縮率・ファイル数・R2操作数・400日後の予想保存量を記録し、無料枠への適合を確認する。

## 10. 実装範囲と作業の境界

初版の実装範囲は、独自ドメインでの音声・カバー直配信、アクセスログの400日保存、CDN由来の日別統計、およびそれらに必要な公開操作・ドメイン管理の変更とする。対応するのは現行のサービス形式である。

Feedの静的配信（4b）やサイト全体の静的化は、追加の効果と整合性を検討する将来の拡張とする。実聴取人数の推定、リスナー識別、IAB準拠のダウンロード認定は、このHTTPアクセス統計とは別の分析機能として扱う。

今回の作業は検討書の作成までである。コード・設定の実装と、デプロイ・DNS・権限・Logpushジョブなどの実環境変更は、それぞれ依頼・承認を受けて実施する。

## 11. 公式資料

機能・料金の調査時に参照した資料。確認日は2026-11-03で、対象アカウントでの検証は実装・導入時に行う。

- [C1：Logpushの料金](https://developers.cloudflare.com/logs/logpush/pricing/)
- [C2：Logpushの提供範囲・配送と欠損](https://developers.cloudflare.com/logs/logpush/)、[2026-09-30の全プラン開放](https://developers.cloudflare.com/changelog/post/2026-09-30-logpush-usage-based-pricing/)
- [C3：R2公開バケット・Access](https://developers.cloudflare.com/r2/buckets/public-buckets/)、[LogpushのR2宛て設定](https://developers.cloudflare.com/logs/logpush/logpush-job/enable-destinations/r2/)
- [C4：HTTP Requestsフィールド](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/http_requests/)、[API設定・サンプリング・バッチ](https://developers.cloudflare.com/logs/logpush/logpush-job/api-configuration/)、[フィルター](https://developers.cloudflare.com/logs/logpush/logpush-job/filters/)
- [C5：Custom fieldsとRangeの制約](https://developers.cloudflare.com/logs/logpush/logpush-job/custom-fields/)
- [C6：Logpush Transformers](https://developers.cloudflare.com/logs/logpush/transformers/)
- [C7：GraphQLの制限・保持](https://developers.cloudflare.com/analytics/graphql-api/limits/)、[settingsによる提供範囲確認](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/)
- [C8：Observabilityのデータセット・FreeのサンプルHTTPログ](https://developers.cloudflare.com/observability/logs/datasets/)
- [C9：Analytics Engine料金](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)、[保持・制限](https://developers.cloudflare.com/analytics/analytics-engine/limits/)、[サンプリング](https://developers.cloudflare.com/analytics/analytics-engine/sampling/)
- [C10：R2 Data Access Logs](https://developers.cloudflare.com/r2/buckets/data-access-logs/)、[Observability料金と2026-12-01からの変更](https://developers.cloudflare.com/observability/pricing/)
- [C11：R2 Metrics and analytics](https://developers.cloudflare.com/r2/platform/metrics-analytics/)
- [C12：Cloudflare Web Analytics](https://developers.cloudflare.com/web-analytics/)
- [C13：R2 Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [C14：R2トークンのAPI作成と認証値の生成](https://developers.cloudflare.com/r2/api/tokens/)
- [C15：R2料金・無料枠](https://developers.cloudflare.com/r2/pricing/)、[Workers料金・無料枠](https://developers.cloudflare.com/workers/platform/pricing/)
- [C16：SQLite DO料金・無料枠](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [C17：Edge / Browser Cache TTL](https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/)
- [C18：Origin Cache Control](https://developers.cloudflare.com/cache/concepts/cache-control/)
- [C19：パージの提供範囲・制限・確認方法](https://developers.cloudflare.com/cache/how-to/purge-cache/)
- [C20：R2 REST APIの要求数制限](https://developers.cloudflare.com/r2/platform/limits/)
- 補足：[HTTP宛てLogpush](https://developers.cloudflare.com/logs/logpush/logpush-job/enable-destinations/http/)、[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
