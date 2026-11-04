# Issue 122: メディアのCDN→R2直結配信の実装計画

対象Issue: [#122 feature: 独自ドメイン時のメディアR2直配信で無料枠の天井を外す（#118 案4）](https://github.com/simosako/castloop-v2/issues/122)

主な検討の経緯は [配信の無料枠スケーリング検討](delivery-free-tier-scaling.md) を参照してください。本書は Issue #122 を実装するための計画で、複数の案がある判断については得失と推奨案を示します。**本書は計画であり、未実装です。**

## 1. 目的と範囲

- workers.dev経路の次の天井はWorkersリクエスト10万req/日（全経路合計）。独自ドメイン運用時に、音声・カバーの配信をゾーンCDN→R2直結に移すことで、Workers・DO・Workersリクエスト上限のすべての外に出す
- 既存の配信統計（音声応答をWorker入口で観測しShow DOのSQLiteに記録する仕組み）は直配信では動かなくなるため、**Cloudflareの無料枠で使える機能による代替**と、**最低12か月のアクセスログ保持**を本計画に含める
- workers.dev運用（独自ドメインなし）は現行経路（#118 案1適用後）のまま変更しない

範囲外: この文書の作業は計画の作成までとし、コード実装・実機検証・Cloudflareリソースの操作は行わない。フィード直置き（4b）とShow別メディアホスト名（統計案S2）は計画には含めるが、実装は独立フェーズとする。

## 2. 現行構造の確認

配信と統計の現行構造（実装確認済み。詳細は[配信とキャッシュ](../components/delivery.md)）:

- リスナー → Worker標準エントリポイント → 判定キャッシュ（`SqliteCachedDecisions`）→ Show DO → 本文キャッシュ（`SqliteCachedAssets` / `SiteCachedPages`）→ 非公開R2バケット（[sqlite-gateway.ts](../../src/sqlite-gateway.ts)）
- 公開パスとR2キーは**別物**。判定（`SqliteDeliveryDecision`）が対応付ける:

| 公開パス | R2キー（非公開バケット） |
| --- | --- |
| `/podcasts/<showId>/feed.xml` | 置かない（SQLiteから生成） |
| `/podcasts/<showId>/cover.jpg` / `cover.png` | `public/podcasts/<showId>/covers/<sha256>.jpg|png` |
| `/podcasts/<showId>/episodes/<episodeId>/<audioRevisionId>.mp3` | `public/podcasts/<showId>/audio/<sha256>.mp3` |

- 統計は音声応答（200/206/304）のみ観測（`observeDelivery`）。`ctx.waitUntil` でShow DOの `recordDeliveryStats` に渡し、Episode×UTC日付×音声リビジョン単位の日別表と整理済み累計に集計。保持は既定400日、30〜3650日で設定可（[Show DO](../components/show-do.md)、[SQLite表](../data/sqlite.md)）
- 素材のアップロード・R2操作はCLIから直接RESTで行い、DOはCloudflare APIトークンを持たない

## 3. Cloudflare仕様の確認結果（2026-11-03時点）

| 事項 | 確認結果 | 出典 |
| --- | --- | --- |
| R2カスタムドメイン | 同一アカウント内のゾーンにあるホスト名をバケットに接続。`r2.dev`は本番非対応。APIは `POST/GET/PUT/DELETE /accounts/{id}/r2/buckets/{bucket}/domains/custom` | [Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/) |
| カスタムドメインのキャッシュ | 既定では拡張子ベース。`.mp3` `.jpg` `.png` は既定キャッシュ対象、**`.xml` は対象外**（4bではCache Ruleが必須）。オブジェクトの `Cache-Control` メタデータが尊重される | [同上](https://developers.cloudflare.com/r2/buckets/public-buckets/#caching) |
| ゾーンキャッシュパージ | URL/Tag/Prefixパージは全プランで利用可（FreeはTag/Prefixに流量制限） | [Instant Purge for All](https://blog.cloudflare.com/instant-purge-for-all/) |
| ゾーン分析（GraphQL `httpRequestsAdaptiveGroups` / SQL API `events.httpRequests`） | **全プランで利用可能**な基本データセット。**2026-10-02からFree/Proでも31日以上保持**（1要求あたりの照会窓は30日）。Adaptiveサンプリング適用 | [Changelog](https://developers.cloudflare.com/changelog/post/2026-10-02-30-days-analytics-on-every-plan/)、[Limits](https://developers.cloudflare.com/analytics/graphql-api/limits/)、[SQL API](https://developers.cloudflare.com/analytics/sql-api/datasets/) |
| ゾーン分析の次元のプラン差 | ホスト名・応答ステータス・キャッシュステータス・時間は全プランで照会例あり。**パス（`clientRequestPath`）はEnterprise限定との報告が複数ある**（コミュニティ情報。正確な判定はSettingsノードの `availableFields` で実機確認） | [ホスト名別照会例](https://developers.cloudflare.com/analytics/graphql-api/tutorials/end-customer-analytics/)、[コミュニティ](https://community.cloudflare.com/t/cloudflare-graphql-analytics-api-does-not-have-access-to-the-path/395176) |
| Workers Analytics Engine | 保持3か月固定（有償でも延長不可）。`writeDataPoint` はWorker実行経由のみ | [Limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) |
| Cloudflare Logs（Logpush） | Enterprise限定。無料では使えない | [Cloudflare Logs](https://developers.cloudflare.com/cloudflare/logs/) |
| Workersリクエストの課金・カウント | エントリポイントキャッシュのヒットもリクエストとしてカウント。**Workerを経由させる限り10万req/日の天井は消えない** | [Workers料金](https://developers.cloudflare.com/workers/platform/pricing/) |
| R2無料枠 | ストレージ10GB（月平均）、Class A 100万/月、Class B 1,000万/月 | [R2料金](https://developers.cloudflare.com/r2/pricing/) |

## 4. 目標構成

```text
workers.dev運用（現行のまま）:
  リスナー → Worker → 判定キャッシュ → Show DO → 本文キャッシュ → 非公開R2バケット

独自ドメイン + media配信（本計画）:
  リスナー → ゾーンCDN（media.<domain>） ─ヒット→ 応答（Worker・DO・R2不使用）
                                 └ミス→ メディアバケット（音声・カバーの公開写しのみ）
  管理・内蔵サイト・フィード(4a) → Worker経路を維持
```

- メディアバケットを新設し、音声・カバーの**公開写し**を公開パスと同形のキーで置く。原本（内容アドレスキー）は既存の非公開バケットに保持
- `system/service.toml` は既存バケットに残す（カスタムドメインはバケット全体を公開するため分割は必須）
- フィードのenclosure URL・カバーURL・サイトの `<audio>` をメディアオリジンへ向ける。GUIDは不変
- Worker経路（公開パスのまま音声を配信）は並行して存続させ、旧enclosure URLと緊急時のフォールバックを維持する

## 5. 設計判断

### 5.1 バケット分割とオブジェクト配置

音声の配置は確定事項: 公開パスと同形のキー `podcasts/<showId>/episodes/<episodeId>/<audioRevisionId>.mp3` に公開写しを置き、アップロード時に `Cache-Control: public, max-age=31536000, immutable` を付ける。リビジョンごとに一意なキーのため不変であり、更新時のゾーンパージは不要。

カバーの配置には3案ある。

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| A. 安定パス上書き | `podcasts/<showId>/cover.jpg` を上書きし、更新時にprefixパージ | 公開URLの形状がWorker経路と同一 | 上書きが「公開音声とリビジョン履歴は不変・保存」の現行方針と矛盾。上書き→パージ→確定のいずれの順序でも数秒の不一致窓（確定前に新カバーが出る、または一瞬404）が生じ、同期・アトミックな公開の保証を崩す |
| B. 内容アドレスキー（推奨） | `podcasts/<showId>/covers/<sha256>.jpg|png`。音声と同じ不変パターン。`max-age=31536000, immutable` | 更新は常に新キーのためゾーンパージ不要でアトミック性を維持。原本（非公開バケット）と同じ規則 | メディア経路のカバーURLがWorker経路（`cover.jpg`）と異なる形状になる。フィードの `<itunes:image>` はカバー更新のたびURLが変わる（GUIDではないため許容） |
| C. Worker配信のまま | カバーは現行経路（1W+0DO）を維持 | 実装が最小。カバーURL・非公開化の保証が無変更 | カバーがWorkersリクエストに残る。配信起源が2つに分かれ、ドメイン変更の対象が増える |

**推奨**: 案B。ただしフェーズ2の第1段階は音声のみ（案C相当）とし、カバー移行は同一フェーズ内の後続ステップに分ける。音声が配信量の大半を占め、カバーは件数が少なく影響が小さいため、段階的に確認しながら進められる。

公開写しは公開操作時にCLIからメディアバケットへ直接RESTアップロードする（現行の素材アップロードと同じ段階。新キーへのアップロードは確定前に参照される経路がないため、公開のアトミック性を壊さない）。`staging/` は従来どおり非公開バケットだけで扱い、メディアバケットには確定分の公開写しのみを置く。メディア配信の有効化時には、非公開バケットの公開中音声・カバー（過去リビジョンを含む全分。旧リビジョンの公開URLも現行は配信し続けるため）を一括で写す。

### 5.2 フィードの配信（4a / 4b）

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| 4a. Worker配信のまま（推奨・第1段階） | 案1適用後の経路（フィード1回 = 1W+0DO）を維持 | 404/410/503の即時性・判定の仕組みが無変更。フィード取得観測（5.4のS3）が正確にできる。実装が最小 | フィード取得（アプリの定期ポーリング）がWorkersリクエストにカウントされ続ける。大規模化するとこれ自体が天井に近づく |
| 4b. メディアバケットに生成済みXML | 公開時に生成した `feed.xml` をメディアバケットへ置き、Cache Rule（`.xml` は既定非キャッシュのため必須）でキャッシュ。ETag/304はR2が処理 | フィード取得もWorkers・DO・Workersリクエストの外へ出る。アプリの再確認ポーリングがほぼ無料 | フィード更新のたび「XMLアップロード→URLパージ→確定」が必要。予約公開を含むフィード生成をDOが確定時に書き込むため、DOにメディアバケットへの書き込みbindingが必須になる。非公開化の即時404が削除＋パージ順序に依存 |

**推奨**: 4aで開始し、フィードポーリングがWorkersリクエストの天井に実際に迫った時点で4bを独立フェーズとして追加する。4bの設計要件（DO書き込みbinding、Cache Rule管理、フィードの削除＋パージ順序）は本書に含めたが、実装は4aの効果を測ってから判断する。

### 5.3 非公開化とキャッシュ消去の順序・責務

音声のエッジ保持期間は1年のため、**ゾーンのprefixパージが唯一の除去経路**になる。順序は現行の「消去してから確定」を維持する: 公開写しの削除（R2 REST）→ 削除確認（HEADで404）→ prefixパージ（`media.<domain>/podcasts/<showId>/` の接頭辞指定。Show全体の非公開化ではShow全体に広げる）→ パージ伝搬確認（匿名GET/HEADで404）→ Show DOへ非公開化要求 → 確定。

削除するのはメディアバケットの公開写しのみで、原本（非公開バケット・内容アドレスキー）は保持する。このため再公開・過去版の採用では、公開写しを原本から再配置してから確定する。復元（`restore_revision`）時の再取得元は現行と同じ非公開バケットである。

パージの実行主体には2案ある。

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| CLI駆動（推奨） | CLIがCloudflare APIトークンで削除・パージまで行い、完了後にShow DOへ非公開化要求を出す | DOにCloudflare APIトークンを持たせない（現行の「シークレットはWorkerに入れない」「CLIから直接REST管理」方針を維持）。中断時もCLIからの再実行で冪等に完了する | 非公開化は必ずCLI実行を経由する（現行も非公開化の予約・自動経路は存在しないため新たな制約ではないが、前提として設計書に明記する） |
| DOにパージ専用トークン | DOにZone Cache Purge権限のみのAPIトークンをsecret bindingする | DOが単独で順序を完結できる | Workerにシークレットが入る。トークンの配布・更新手順が増える |

**推奨**: CLI駆動。中断時の再実行は「削除済み→404確認→パージ→確認」を最初からやり直すだけで冪等であり、多段階の状態機械は作らない。パージ要求がレート制限で失敗した場合は既存のパージ再試行（12秒×最大6回）の慣行に合わせ、それでも失敗すれば非公開化を失敗として中断する。削除後・パージ前の間、キャッシュに残った音声は配信され続けるがキャッシュミスは404になるため、公開範囲は単調に縮小する。

なお、エピソード更新（新リビジョン公開）とカバー更新（案B）は常に新キーのためゾーンパージ不要。フィード・サイトは既存のWorkersキャッシュパージのまま。

### 5.4 配信統計の代替（本計画の核心）

#### なぜ現行統計が効かなくなるか

直配信の音声はWorkerコードを通らないため `observeDelivery` が実行されず、Show DOへの統計記録も Analytics Engine の `writeDataPoint` も発生しない。**メディア要求を無料枠で観測できるのは、CDNヒットを含むゾーンへの全要求を記録するゾーン分析（GraphQL `httpRequestsAdaptiveGroups` / SQL API `events.httpRequests`）だけ**である。

| 観測手段 | 直配信メディアを観測可 | 無料枠 | 保持 | 判定 |
| --- | --- | --- | --- | --- |
| ゾーン分析（GraphQL / SQL API） | 可（CDNヒット含む。ホスト名・ステータス・cacheStatus・時間の次元） | 可（全プランの基本データセット） | 31日以上（2026-10-02改訂） | **採用（データソース）** |
| Workers Analytics Engine | 不可（Worker実行が必要） | 可 | 3か月固定 | 不採用（メディア対象外。フィード観測の書き込み先に使う利点もない。DO直接書き込みで足りる） |
| Cloudflare Logs（Logpush） | 可 | 不可（Enterprise） | − | 範囲外 |
| R2の分析（バケット単位） | ミスのみ・オブジェクト単位なし | 可 | − | 不採用（ダウンロード指標にならない） |
| Workerを経由させる（リダイレクト計数・キャッシュ有効化） | 可 | 可 | SQLite任意 | 不採用（Workersリクエスト10万/日の天井が復活し、案4の目的が消える） |

#### 統計代替の案

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| S1. 単一メディアホスト名＋ゾーン分析の定期エクスポート（推奨） | `media.<domain>` を1つだけ使い、GraphQLでmediaホスト名に絞った日別集計（ステータス別要求数・バイト数・cacheStatus）を定期取得して制御DOのSQLiteへ保存 | 構成が最小（DNS・カスタムドメイン1つ）。無料枠で成立 | 音声指標がサービス単位になり、Show別・Episode別の音声数は取れない |
| S2. Show別メディアホスト名＋エクスポート | `<showId>-media.<domain>`（フラットな1階層なのでユニバーサル証明書 `*.<domain>` でカバーされる）をShowごとに接続し、ホスト名次元でShow別に集計して各Show DOのSQLiteへ保存 | Show別の音声要求数・バイト数が保持できる。既存の「統計はShow DOに局所化」境界を維持 | Show登録・分離がDNS・R2カスタムドメインの作成・削除と結合し、ドメイン変更手順が大幅に複雑化する。Show数ぶんのCloudflareリソース管理が発生 |
| S3. フィード取得観測の追加（推奨・4aと組み合わせ） | フィード応答（GET/HEADの200/304、既知Bot判定）をWorker入口で観測し、Show DOに日別で記録 | Show単位の**正確・即時**な指標が追加で取れる。メディア移行で空いたDOリクエスト・行書き込みの枠を使うため収支が釣り合う。購読者数の代理指標としてフィード取得は音声より安定 | フィード1回につきDO 1リクエスト＋行書き込みが戻る（音声統計分の枠を再利用するため上限の実効は変わらない） |
| S4. リダイレクト計数 | enclosure URLをWorker経由の302にしてからメディアへ飛ばす | Episode別に正確 | 音声1回=Workersリクエスト1回が復活し、天井が消えない。不採用 |
| S5. Analytics Engine + エクスポート | 案2の再検討 | — | メディア要求を書き込む経路が存在しないため成立しない。不採用 |

**推奨**: **S1＋S3**。単一のメディアホスト名でサービス単位の音声指標（要求数・バイト数・キャッシュヒット率・ステータス分布）を確保し、Show単位の正確な指標はフィード取得観測で補う。複数Showを運用しShow別の音声要求数が必須になった時点でS2を拡張として検討する。

#### 12か月以上の保持の実現（要件）

ゾーン分析の保持は31日以上のため、**定期エクスポートでSQLiteに取り込む**ことで保持を延長する。

```text
CLI（cronまたは手動、推奨日次・最低31日以内に1回）
  → GraphQL httpRequestsAdaptiveGroups（mediaホスト名絞り込み、日次×edgeResponseStatus×cacheStatus）
  → 制御DOの管理HTTP（既存の管理者キー認証）へUPSERT
  → 制御DO SQLiteの日別表（保持は既定400日、30〜3650日。≥12か月を満たす）
```

- 実行コマンド案: `stats import-zone --from YYYY-MM-DD [--to YYYY-MM-DD]`（日付キーへのべき等UPSERTのため、再実行で重複しない）
- トークン権限: 管理者のCloudflare APIトークンにAnalytics Read（ゾーンまたはアカウントスコープ）を追加する
- GraphQL APIの照会quotaは300クエリ/5分のため、日次運用には十分余裕がある
- エクスポートされていない期間は「未計測」として表示する。既存のcoverage表現（`measured` / `partial` / `unmeasured` / `pruned`）の考え方を流用し、ゾーン分析由来の行は近似（Adaptiveサンプリング）である旨を表示に添える
- 集計行の保持期限が切れた場合は既存の統計と同じく整理済み累計へ合算する

#### 取れる指標と取れなくなる指標

| 指標 | Worker経路（現行・旧URL） | メディア直配信（ゾーン分析） |
| --- | --- | --- |
| 音声の要求数（200/206/304別） | Episode別に正確 | サービス単位・ステータス別（HEADとGETの区別は不可） |
| 応答バイト数 | Episode別に正確 | サービス単位 |
| キャッシュヒット率 | — | 可（cacheStatus別） |
| `equivalent_full_downloads` | 可 | 不可（Episode別の分母がないため。バイト数の参考値のみ） |
| Bot判定 | 可（既知パターン） | 不可 |
| フィード取得数 | 記録なし → S3でShow別に正確（200/304/Bot別） | 対象外（フィードは4aでWorker経路のまま。S3で同じ） |

既存の `publication_episode_daily_stats` は媒体直接期間は記録されない。照会UIは「Worker経路で観測した期間」「ゾーン分析から取り込んだ期間」を区別して表示する。Worker経路（旧enclosure URL）への直接アクセスは並行存続させるため、その分は引き続き正確に記録される。

#### 表設計の概要

- 制御DO: `service_media_daily_stats`（`date_utc`、`hostname`、`edge_status`、`cache_status`、`requests`、`bytes`、`updated_at_ms`。主キーは `(date_utc, hostname, edge_status, cache_status)`）と、計測開始日・最終取込日などのmeta。制御DOの担当は「Show登録・一覧・ドメイン状態」が現行境界のため、この拡張は[制御DO設計](../components/control-do.md)の境界記載を更新して明示する
- Show DO（S3）: `publication_feed_daily_stats`（`date_utc` 主キー。GET/HEAD/304/Bot別カウンタ）を統計表の並列に追加

### 5.5 サービス設定とドメイン変更

`service.toml` に任意項目を追加する（スキーマは `.strict()` のため、任意項目として追加しても既存設定のパースとハッシュは不変。`schema_version=2`・`storage_layout="show-v1"` は維持）:

```toml
media_bucket_name = "<worker_name>-media"   # 任意。未指定なら現行経路のみ
media_base_url = "https://media.<domain>"   # media配信の起点オリジン
```

- `media_base_url` は既存のorigin検証（https・ポート・パスなし）に加え、独自ドメイン運用中（`public_base_url` が `workers_dev_base_url` と異なる）でのみ指定可能とする
- 設定変更は既存のドメイン変更手順（prepare → 接続確認 → 配備 → 確定）を拡張して適用する。手順の拡張内容:
  1. メディアバケット作成（既存の `createBucket` と同じ検証付きREST）
  2. 公開中音声・カバー（過去リビジョン含む全分）の公開写しをCache-Control付きで一括アップロード
  3. R2カスタムドメイン接続（`POST /accounts/{id}/r2/buckets/{bucket}/domains/custom`）とDNS・TLSの確認（既存の `SqliteDomainCloudflare` の検証形式を流用）
  4. 各Show DOのフィード・サイト再生成（enclosure URL・カバーURLの切替。GUID不変）と設定確定
  5. 無効化（media解除）は逆順（メディアドメイン切断 → 公開写し削除 → 設定確定）。旧enclosure URL（Worker経路）は引き続き配信されるため、購読者への影響はない
- メディアドメインの変更（ゾーン自体の変更）も同一手順の対象に含める。メディアバケットはサービスごとに1つで、ホスト名の付け替えはバケット設定の変更のみで済む（オブジェクトの再配置は不要）

### 5.6 workers.devとの互換性とWorkerの変更

- `media_*` 設定がなければ動作・設定・配信は一切現行のまま（workers.dev運用は影響なし）
- media配信時もWorkerの公開パス（`/podcasts/...`）は現行どおり応答する。旧enclosure URL・キャッシュ済みURL・緊急時のフォールバックとして機能し、それらの応答は引き続き正確に統計記録される
- Worker本体の変更は、描画時の音声・カバーURL組み立て（`canonicalEnclosureUrl` へ渡す基底、`feed.ts`・`site-renderer.ts`）と設定の読み込みに限られる。新しいエントリポイントやメディアバケットへのWorker binding（4a・CLI駆動のため）は不要

## 6. 実装フェーズと主な変更対象

| フェーズ | 内容 | 主な変更対象 |
| --- | --- | --- |
| 0. 実機検証 | 7章の検証項目を非公開の試験環境で確認し、仕様前提を確定させる | なし（記録のみ） |
| 1. 設定と配備 | `service.toml` スキーマ拡張、メディアバケット作成・カスタムドメイン接続・ドメイン変更手順の拡張 | `packages/shared/src/sqlite-service.ts`、`packages/cli/src/sqlite-domain-cloudflare.ts`、`sqlite-domain-operation.ts`、`sqlite-cloudflare.ts`、関連テスト |
| 2. 公開と配信 | 公開写しのデュアルライト（Cache-Control付き）、enclosure URL・カバーURL・`<audio>` の切替、非公開化の削除＋パージ順序、`verify` のメディアURL確認 | `packages/cli/src/sqlite-media-upload.ts`、`sqlite-publish.ts`、`sqlite-commands.ts`、`src/feed.ts`、`src/media-url.ts`、`src/site-renderer.ts`、`src/sqlite-publication-content.ts` |
| 3. 統計代替 | S1のゾーン分析エクスポート（`stats import-zone`）、制御DOの新表と管理HTTP、S3のフィード観測とShow DOの新表、`stats` 表示のcoverage拡張 | `packages/cli/src/`（新規エクスポート処理、`stats.ts`）、`src/sqlite-service-control.ts`、`src/sqlite-stats-http.ts`、`src/sqlite-gateway.ts`（フィード観測）、`packages/shared/src/sqlite-stats.ts` |
| 4.（独立）4bフィード直置き | 生成済みXMLのメディア配信、Cache Rule、DOの書き込みbinding | 別途計画。4aの効果測定後に判断 |

各フェーズは現行の自動テスト（`bun test`）と `npm run check` を満たす単位で分割する。

## 7. 実機検証項目（フェーズ0）

1. メディアホスト名で `.mp3` がCache-Controlメタデータ通りにCDNキャッシュされること（ヒットでR2へのClass Bが発生しないこと）、Range・HEAD・304・ETagの挙動
2. prefixパージの伝搬時間と、Freeプランの流量制限が非公開化運用に支障ないこと
3. **メディアホスト名へのリクエストがゾーン分析（GraphQL `httpRequestsAdaptiveGroups` / SQL API `events.httpRequests`）に現れること**（統計代替の前提）
4. Settingsノードで当該ゾーンの `availableFields` を確認し、Freeプランでホスト名・ステータス・cacheStatusが照会可能で `clientRequestPath` が不可であることを実証すること
5. 非公開化シーケンス（削除→404確認→パージ→匿名GET/HEAD拒否確認→確定）とその中断・再実行
6. カバー（内容アドレスキー）の配信と、フィードの `<itunes:image>` 切替後のアプリ表示
7. 匿名での `system/`・`staging/` 相当がメディア経路に存在しないこと（メディアバケットには公開写しのみを置く構成であることの確認）

## 8. 無料枠の収支（media配信有効時）

| 資源 | 消費 | 備考 |
| --- | --- | --- |
| Workersリクエスト（10万/日） | 管理・内蔵サイト・フィード（4a）のみ | 音声・カバーは消費なし。CDNリクエストは無制限 |
| DOリクエスト（10万/日） | 公開・予約・管理に加えS3のフィード観測（フィード1回=1） | 音声統計分（音声1回=1）の枠を再利用 |
| R2 Class B（1,000万/月） | キャッシュミス時のみ | 不変オブジェクトのためヒット率が高い |
| R2ストレージ（10GB・月平均） | 原本＋公開写しで**音声・カバー分の約2倍** | 公開音声が5GBを超えると有料扱い。留意点として記録 |
| ゾーン分析の読み取り | 日次エクスポートで数クエリ | quota 300クエリ/5分 |

## 9. 更新が必要なドキュメント

- [全体アーキテクチャ](../architecture.md)、[配信とキャッシュ](../components/delivery.md): 経路の追加、media配信の節
- [Show DO](../components/show-do.md)、[SQLite表](../data/sqlite.md): 統計の範囲・coverage・新表
- [制御DO](../components/control-do.md): メディアドメインを含むドメイン変更と、サービス単位統計表の担当範囲
- [CLI](../components/cli.md): コマンド拡張（ドメイン変更、`stats import-zone`、`verify`）
- [スキーマ](../data/schemas.md)、[保存構造](../data/storage.md): `service.toml` の任意項目、メディアバケットの構成
- [セキュリティ](../security.md)、[実機試験手順](../live-trial.md): 「R2は非公開」記載の修正（メディアバケットは公開。`system/` は引き続き非公開）、検証手順へのメディア経路追加
- 利用ガイド（[独自ドメイン](../../docs/custom_domains.md)ほか）: media配信の説明と統計の見え方の変化

## 10. 未解決・実機確認待ち

- ゾーン分析へのR2カスタムドメイン要求の可視性と、Freeプランで照会できる次元（7章3・4項）。これが成立しない場合、統計代替はS1を導入できず、「メディア指標はCloudflareダッシュボードで確認（取り込みなし）」に後退するため、フェーズ3の前に必ず確認する
- R2カスタムドメイン接続APIがDNSレコードを自動作成するか、CLIからのDNS作成が別途必要か（既存の `dns_list` による検証で吸収できる見込み）
- prefixパージのFreeプラン流量制限の実測値（非公開化・カバー運用の頻度上限の根拠）
- GraphQLとSQL APIのどちらをエクスポートに使うか（GraphQLを基本とし、SQL APIは代替。フェーズ0で両方確認）
