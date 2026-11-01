# 配信の無料枠スケーリング検討

対象Issue: [#118 音声配信1応答あたりDOリクエスト2回消費が無料枠の天井になる](https://github.com/simosako/castloop-v2/issues/118)（2026-11-01クローズ。結果は[結果](#結果2026-11-01時点)の節。継続検討は [#122](https://github.com/simosako/castloop-v2/issues/122)）

人気Showで配信要求が増えたときに、Workers FreeのDOリクエスト上限（100,000/日）に到達して配信が止まる事態を避けるための検討。現行の配信経路と1要求あたりの消費はIssue #118にまとめたとおりで、音声1応答につきDOリクエスト2回（配信ゲートと統計記録）を消費するため、上限には音声約5万応答/日で到達する。

本検討の案はいずれも、次の既存保証を維持することを前提とする（[配信とキャッシュ](../components/delivery.md)）:

- 非公開化・削除済みShow/Episodeの即時拒否（404/410）。公開操作前のキャッシュ消去と、同期・アトミックな公開
- Range・HEAD・304・412・416への対応
- `system/`・`staging/` を公開経路に出さないこと

## 構造的な制約（Cloudflare公式仕様に基づく）

| 事実 | 帰結 |
| --- | --- |
| workers.devではWorkerを介さずに応答できない（キャッシュもWorkerの仕組みの一部） | 独自ドメインなしでは「CDN→R2直結」は不可能。Workerリクエスト10万/日の天井は消えない |
| Workers Caching（`cache_options` / `exports`）はヒット時にWorkerコードを実行しない。ただしヒットもリクエストとして課金・カウントされる | コードを実行しない経路は作れるが、Workersリクエスト数は減らせない。削減できるのはDO呼び出し・CPU・R2読み取り |
| サービスバインディング（`ctx.exports`）の呼び出しは追加のリクエストとして課金されない | エントポイント分割それ自体のコストはない |
| DOのRPCはメソッド呼び出しごとに1リクエスト。DO SQLiteの行書き込みは10万行/日 | 配信ゲートと統計記録を別RPCにしている限り、音声1応答=2リクエスト+1行書き込み |
| R2の公開配信（カスタムドメイン）には同一アカウント内のゾーンが必要。`r2.dev`はレート制限・キャッシュなしで本番利用不可 | R2直結は独自ドメイン時のみ選択肢になる |
| ゾーンのキャッシュパージ（URL/Tag/Prefix）は2025年4月から全プランで利用可能（Free: Tag/Prefixパージは流量制限あり） | 独自ドメイン時のR2直結でも「消去してから確定」の順序を組める |
| DOのduration（GB秒）は「要求処理中」または「休止不能でメモリ滞留中」のみ課金。休止可能なアイドル（10秒以内）と休止・退去後は無課金 | WebSocket・タイマー・未完了I/Oを持たないcastloopのDOは休止可能なため、課金は実処理時間の合計（次節） |

## 現在の1要求あたり消費（再掲）

| 経路 | Workers req | DO req | DO行書き込み | R2 |
| --- | --- | --- | --- | --- |
| feed.xml | 1 | 1（ゲート。ミス時さらに描画1） | 0 | なし |
| 音声1応答（200/206/304。Range分割なら分割ごと） | 1 | 2（ゲート+統計） | 約1 | キャッシュミス時 head+get |
| カバー画像 | 1 | 1 | 0 | キャッシュミス時 |
| 内蔵サイトHTML | 1 | 1（ミス時さらに描画1） | 0 | なし |

想定例: リスナー1万人がPodcastアプリで1日2〜4回フィードを確認すると、それだけで音声とは別に2〜4万req/日発生する。フィード経路のDO削減も必須。

## DOのduration（GB秒）は現在の設計では律速しない

DOのduration上限はFreeで13,000 GB秒/日。課金対象は「要求の処理中（内部のawaitを含む）」と「休止条件を満たせずメモリに滞留している時間（退去まで最大70〜140秒）」だけで、休止可能なアイドル（要求がなくなってから10秒）と休止・退去後は課金されない（[DOライフサイクル](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)）。混雑して要求の間隔が10秒未満でも、合間のアイドルが休止可能状態なら課金されない。

castloopのShow DOはWebSocket・タイマー・未完了I/O・レスポンスのストリームを持たず（音声はWorkerエントポイントからR2へ直接流れ、DOは通らない）、すべてのI/Oをメソッド内で完了させるため休止可能。したがって:

- duration消費 ≈ DOリクエスト数 × 実処理時間（SQLiteトランザクションで数ms）× 128MB
- DOリクエストの上限10万/日を使い切っても約125 GB秒/日（10万 × 10ms × 128MB）で、上限の約1%。リクエスト数・行書き込みが先に律速する

durationが問題になるのは次の場合に限られる:

1. **DOが休止不能になる変更**: 未完了I/O・タイマー・WebSocketを残す実装、またはランタイム不具合（SQLite絡みでDOが休止不能になり退去まで課金が続いた実例が workerd issue #6800 にある）。この場合バーストごとに約9〜18 GB秒が発生し、約750〜1,500バースト/日で上限に達する
2. **公開操作のパージ再試行**: レート制限時の再試行で最大6回×12秒待つため、最悪約72秒（約9 GB秒）DOをアクティブに保つ。公開は低頻度なので実害は小さい
3. **DOが音声レスポンスをストリームする構成変更**: 配信時間のすべてがduration課金になる。音声をR2→Workerエントポイントで直接返す現在の分担は、この点でも維持が必要

実運用では、ダッシュボードのDurable Objectsメトリクス（GB秒）を実機試験時に確認し、リクエスト数×実処理時間の見積りと一致することを検証する。

---

## 案1: 配信ゲート判定をキャッシュする（第三のキャッシュエントリポイント）※実装済み

実装は[判定キャッシュ](../components/delivery.md)として設計に反映済み（エントポイント名 `SqliteCachedDecisions`、TTL 300秒、判定タグは本文キャッシュと同一、消去は判定→本文の順）。

現行の「Worker標準エントリポイント→Show DO `delivery()`→`SqliteCachedAssets`」のうち、Show DOへの問い合わせ結果（公開可否・R2キー・`cache_props`のJSON）そのものを、`SqliteCachedAssets` / `SiteCachedPages` と同じWorkers Caching（エントポイント単位キャッシュ）に載せる。ゲートウェイはShow DOを直接呼ばず、`ctx.exports` 経由で判定用エントポイント（例: `SqliteCachedDecisions`）を呼ぶ。

- キャッシュキーはエントポイント+パス。ヒット時はコードもDOも実行されない
- 判定応答には既存と同じ `Cache-Tag`（`show-<id>` / `feed-<id>` / `episode-<id>/<ep>` / `cover-<id>` / site系）と短いTTL（例: 300秒）を付ける
- 正しさの保証は現行の媒体キャッシュと同一: 公開操作はSQLite確定前にタグでパージしており（[パージ](../components/delivery.md#更新時のキャッシュ消去)）、パージ失敗なら公開自体が失敗する。TTLはパージ漏れの際の伝播上限でしかない

**効果**: 音声 = 1 Workers req + **1 DO req（統計のみ）**。フィード・カバー・HTML = 1 Workers req + **0 DO req**。

**メリット**
- workers.dev（独自ドメインなし）でもそのまま有効。新規のCloudflareリソース不要
- 配信統計は現状どおり正確（SQLiteに1応答ずつ記録）
- 即時非公開の保証は、すでに検証済みのタグパージの順序をそのまま流用

**デメリット**
- 音声の統計記録1 DO reqと行書き込み約1行が残る。天井は「音声約9万応答/日+フィード等」（Workersリクエスト10万/日が律速）に上がるが、DO行書き込み10万/日も同水準で迫る
- エントポイントとゲートウェイの分岐が1つ増え、パージ対象タグの管理範囲が広がる

## 案2: 配信統計をWorkers Analytics Engineに移す（案1と組み合わせ）※検討済み・不採用

音声応答の観測（`serveSqliteGateway` の `observeDelivery`）から、Show DOの `recordDeliveryStats` RPCをやめ、Analytics Engineの `writeDataPoint()`（fire-and-forget、await不要）で書き込む。DOにもSQLiteにも書かない。

**効果**: 音声 = **1 Workers req のみ**。DOは公開・管理操作のためだけに使われる。天井はWorkersリクエスト10万/日（全経路の合計）。

**メリット**
- DOリクエスト・DO行書き込み・DO保存量のすべてから配信統計分を除去。DO上限が配信で枯渇しなくなる
- 統計の集計・保持期限・整理・coverage・SQLite 4表・RPC・管理HTTPを削除でき、コードが純減する
- Analytics EngineのFree枠は10万データポイント/日で、超過しても配信には影響しない（統計だけ欠ける）

**デメリット**
- 統計の性質が変わる: 保持が3ヶ月固定で、**Workers Paidにしても延長できない**（有償化で枠が広がるのは書き込み量と読み取りクエリ数のみ。延長はEnterpriseの個別相談のみ）。現行は既定400日、30〜3650日設定可
- 書き込みにackがなく、欠落（Free枠超過など）が検知できない。現行の `partial`/`unmeasured` のような計測範囲表示が失われ、取り込み遅延で照会も即時でなくなる
- 読み取りはAnalytics Engine SQL API（Freeで読み取り10,000クエリ/日。Account Analytics Read権限のトークンが別途必要）。カスタムデータセット用のダッシュボードUIはCloudflareになく、UIは従来どおりCLIが担う
- `show-do.md`・`sqlite.md`・CLIの統計表示など、統計機能の契約変更を伴う。既存サービスのSQLite統計履歴は読めなくなる
- Analytics Engineは現在小額未課金だが、将来的に課金開始の予定が告知されている

サンプリングはindex値（Show単位を想定）への均衡サンプリングで、書き込み時は1 indexあたり約100データポイント/秒（約6,000/分）の持続書き込みから目立ち始める（[FAQ](https://developers.cloudflare.com/analytics/faq/wae-faqs/)。当初本文書に記載していた「約100万/分」は誤り）。Free枠（Workers 10万req/日＝平均約1.2/秒）では1 Showが閾値に達する道は実質なく、正確性は事実上保たれる。読み取り時のABRサンプリングは長期間の一括照会で解像度が落ちるため、月単位の分割照会と `count()` による読み取り行数確認が必要。

**判断（2026-11-01、管理者の判断）**: 保持3ヶ月は短すぎるため不採用。統計は引き続きShow DO SQLiteで保有する。

## 案3: 標準（default）エントポイントのキャッシュを有効にする

`exports.default.cache.enabled` を `true` にし、ゲートウェイが返す**最終応答**自体にエッジ向けTTL（`Cloudflare-CDN-Cache-Control`）と `Cache-Tag` を付ける。リスナー向けの `Cache-Control: public, max-age=0, must-revalidate` は変更しない（ブラウザの再検証はエッジキャッシュが304で応答する）。

**効果**: ヒット時は音声・フィード・カバー・HTMLすべてで**コード・DO・CPUゼロ**（リクエストとしてはカウント）。

**メリット**
- 実装量が最小（応答ヘッダーとメタデータの変更が中心）。応答レイテンシも最速
- 条件付き要求・Rangeはキャッシュ層が処理する

**デメリット**
- **配信統計がキャッシュミスのみになる**。ヒット率が高いためダウンロード指標として使えない水準になる。統計機能を実質放棄する変更要
- Cloudflareは「ゲートウェイ（認証・振り分けをするエントリポイント）はキャッシュ無効が推奨」と明記しており、その推奨パターンから外れる。非公開化の即時性がタグパージのみに依存する（媒体キャッシュと同じ仕組みだが、判定を経由しない分、影響範囲が全公開応答に及ぶ）
- デプロイごとにキャッシュが冷える（`cross_version_cache: false` の現行設定）

## 案4: 独自ドメイン時のみ、メディアをR2カスタムドメインで直接配信（CDN→R2直結）

「理想形」のCDN→R2直結は、**独自ドメイン（ゾーン）があるときのみ実際に可能**。workers.dev時は現行経路（案1適用後）をそのまま使う、という二段構成。

構成:
- メディア用バケットを新設し（音声・カバーのみ。`system/service.toml` は既存の非公開バケットに分離）、ゾーン内のサブドメイン（例: `media.<domain>`）をR2カスタムドメインとして接続。**カスタムドメインはバケット全体を公開する**ため、分割は必須。オブジェクトキーは公開パスと同じ形（`podcasts/<showId>/episodes/...`）で配置し、URL変換なしで直接ヒットさせる
- 公開操作時に、アップロードするオブジェクトへ `Cache-Control` メタデータを設定（音声 `max-age=31536000, immutable`、カバー `max-age=300`）。ゾーンのCDNがキャッシュし、ヒットはR2に到達しない（Class B不発生。CDNリクエストは課金なし）
- feed.xmlのenclosure URLとカバーURL、サイトの `<audio>` をメディアドメインへ向ける。URLの正規化は既存の `canonicalEnclosureUrl` とドメイン変更の仕組みで扱い、GUIDは不変
- feed.xml自体は (4a) Worker配信のまま（案1でDOゼロ）、または (4b) 公開時に生成済みのXMLをメディアバケットへ置き、ゾーンのCache RuleでXMLもキャッシュ（R2がETag/304をネイティブ処理するため、アプリの再確認ポーリングがほぼ無料になる）
- 非公開化は「オブジェクト削除＋ゾーンキャッシュのPrefixパージ」。パージはREST（Tag/PrefixパージはFree可）が必要なため、DO内の「消去してから確定」の順序を保つには、DOにZone Cache Purge権限だけを持つAPIトークンをsecret bindingするか、CLI側でパージ後に公開要求を出す順序に変える

**効果**: 音声・カバー（と4bならフィード）の配信が**Workers・DO・Workersリクエスト上限のすべての外**に出る。CDNリクエストは無制限、R2はミス時のClass Bのみ（1,000万/月）。無料枠の天井は事実上なくなる。

**メリット**
- 人気化に対する唯一の根本解。Workerは管理・内蔵サイト（と4aならフィード）だけを担う
- workers.dev運用の互換性を壊さない（ドメインなし時は現行のまま）

**デメリット**
- **配信統計**: 直配信の音声はコードを通らないため、エピソード別ダウンロード数を取れない（ゾーン分析はあるが番組・エピソード単位の正確な集計にならない）。統計機能は大幅に後退する
- **非公開化と履歴**: 公開バケットでは非公開化=オブジェクト削除が必要になる。現行は「公開音声とリビジョン履歴は不変・保存」のため、削除を許すなら復元（`restore_revision`）時の再取得元（ローカル原本または非公開バケットの写し）を決める必要がある
- バケット分割・メディアドメイン接続・Cache Rule・パージ連携・enclosure URL切り替えと、ドメイン変更手順の拡張が大きい。`public_base_url` 以外にメディア基底URLの設定が増える
- 「R2は非公開」前提の検証手順・設計記載の見直しが必要（`system/` は引き続き非公開）

## 補足: RPCセッション統合（要検証の小変更）

Cloudflareの課金仕様では、RPCメソッド呼び出しの戻り値として返した `RpcTarget` オブジェクトへの追加呼び出しは同一セッションとして課金されない。`delivery()` が統計記録用のtargetを返し、応答後の `ctx.waitUntil` 内で同じtargetに記録すれば、音声1応答のDOリクエストを2→1に減らせる可能性がある。ただし `waitUntil` までセッションが生存するかは実機検証が必要で、案1と重複する効果のため、単独では採用しない。

## 採用しない案

- **`r2.dev` での直接配信**: レート制限（数百req/秒で429）・キャッシュなし・本番非対応
- **現行バケットへのカスタムドメイン接続のみ**: バケット全体（`system/` 含む）が公開される
- **プリサインURL**: 発行にリクエストごとのWorker実行とS3資格情報が必要で、DO削減にならない
- **Worker内メモリでの判定キャッシュ**: パージできず、非公開化の伝播が保証できない

## 比較

| 案 | 音声1応答（ヒット時） | フィード1回 | 正確な統計 | 即時非公開 | workers.devで有効 | 実装規模 | 天井の目安 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 現行 | 1W+2DO+1行 | 1W+1DO | ○ | ○ | ○ | - | 音声約5万/日 |
| 案1 | 1W+1DO+1行 | 1W | ○ | ○ | ○ | 小〜中 | 約9万音声+フィード/日 |
| 案1+2 | 1W | 1W | △（AE・3ヶ月） | ○ | ○ | 中 | Workers 10万req/日合計 |
| 案3 | 1W（コードなし） | 1W（コードなし） | ✗（ミスのみ） | △（パージ専依） | ○ | 小〜中 | Workers 10万req/日合計 |
| 案4（独自ドメイン） | 0W+0DO | 0W（4b）/1W（4a） | ✗（媒体） | △（削除+ゾーンパージ） | ✗（ドメイン必須） | 大 | 事実上なし（CDN） |

## 結果（2026-11-01時点）

1. **案1を採用・実装済み**（PR #120、[実機検証](issue118_decision_cache_live_trial_20261101.md)済み）。両モードで有効・保証を維持したままDO消費を音声1リクエスト/応答・フィード0リクエストに減らした
2. **案2は不採用**。保持3ヶ月固定（有償でも延長不可）が運用要件を満たさない。統計はShow DO SQLiteを維持する
3. **案4は [#122](https://github.com/simosako/castloop-v2/issues/122) に分離**。独自ドメイン運用でWorkersリクエスト10万/日の天井が実際に迫った段階で検討する。workers.dev運用の並行維持を前提に、統計後退と非公開化手順の変更を受け入れられるかで判断する
4. 案3は案1と天井が同じで統計だけ失われるため、引き続き採用しない

どの案でも、単一Show DOへの集中（ソフトリミット約1,000req/秒）はShowごとのDO分離で既に対処済みの構造であり、本検討の範囲外。

## 参照

- [Workers Caching（設定・エントポイント単位）](https://developers.cloudflare.com/workers/cache/configuration/) / [キャッシュキー](https://developers.cloudflare.com/workers/cache/cache-keys/)
- [Workers料金（キャッシュヒットの課金・サービスバインディング）](https://developers.cloudflare.com/workers/platform/pricing/) / [Durable Objects料金](https://developers.cloudflare.com/durable-objects/platform/pricing/) / [DOライフサイクル（duration課金の対象状態）](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [R2 Public buckets（カスタムドメイン・r2.dev）](https://developers.cloudflare.com/r2/buckets/public-buckets/) / [R2とキャッシュ](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/)
- [キャッシュパージの全プラン開放](https://blog.cloudflare.com/instant-purge-for-all/) / [パージの制限](https://developers.cloudflare.com/cache/how-to/purge-cache/)
- [Analytics Engine料金](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) / [制限（保持3ヶ月）](https://developers.cloudflare.com/analytics/analytics-engine/limits/) / [サンプリングFAQ](https://developers.cloudflare.com/analytics/faq/wae-faqs/)
- Issue [#118](https://github.com/simosako/castloop-v2/issues/118)、[配信とキャッシュ設計](../components/delivery.md)、[Show DO設計](../components/show-do.md)
