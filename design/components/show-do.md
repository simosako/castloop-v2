# Show DOの設計

Show DOは、1番組の公開内容を管理するDurable Objectです。現在の内容、履歴、公開状態、予約、配信統計を同じSQLiteに保存します。公開内容の更新はこのDO内で確定し、配信時もこのDOのデータを参照します。

## 内部構成

| 実装 | 役割 |
| --- | --- |
| `SqliteShowService` | Show登録、管理HTTP、配信問い合わせ、各機能の接続 |
| `SqlitePublicationQueue` | サービス・対象・準備状態の確認と、公開トランザクションの実行 |
| `SqlitePublicationContent` | 現在内容、履歴、公開状態、世代番号の読み書き |
| 公開実行処理（executor） | 更新内容の検証、キャッシュ消去、確定処理の組み立て |
| `SqlitePublicationSchedules` | 予約とイベントの保存、Alarmによる実行 |
| `SqliteDeliveryStats` | 配信統計の集計、保持期限の管理、照会 |

`SqlitePublicationQueue` は公開処理をまとめるクラス名です。直接公開の要求では、その呼び出し中に処理を実行して結果を返します。

DO名のShow IDと、SQLiteに保存した登録情報を照合して対象を固定します。登録済みで、未完了のドメイン変更がない場合に `publication_ready = true` となります。

## 公開を確定するまで

1. 要求を解析し、サービス設定と対象Showを照合します。
2. すでに同じ内容なら、現在の `revision_id` と `unchanged` を返します。
3. 更新元の版と公開状態を確認します。
4. 更新後のRSS・サイトを検証し、短縮URLの対応を決めます。
5. 必要なメディア・サイトキャッシュを消去します。
6. SQLiteトランザクション内で更新元とFeed世代を再確認し、内容・履歴・短縮URL・世代番号をまとめて確定します。

パージなどの待機中には別の要求が進む可能性があるため、確定直前にも版を確認します。これにより、確認時点の古い内容で別の更新を上書きすることを防ぎます。

### 更新元の照合

要求には `service_id`、`service_config_sha256`、`expected_show_state_version` が含まれます。Episodeでは、さらに `base_revision_id` と `expected_episode_lifecycle_version` を照合します。不一致は `base_conflict` などの理由コードで返します。

同一内容の判定は更新元の照合より先に行います。公開が成功した後に応答だけを受け取れなかった場合も、同じ入力の再送で `unchanged` を返せます。

素材はCLIが事前にR2へアップロードします。公開実行処理はその参照を保存し、Showにはメタデータとカバー参照、Episodeにはメタデータと音声参照を確定します。

### 失敗時に残る状態

| 失敗箇所 | 状態 |
| --- | --- |
| 入力・更新元・生成内容の検証 | 公開内容を維持する |
| キャッシュ消去 | 公開内容を維持する。消去済みキャッシュは同じ内容から再生成できる |
| SQLiteトランザクション | 内容・履歴・世代の変更をまとめてロールバックする |
| 確定後の応答 | 公開済みの場合があるため、現在内容の照会と同一内容の再実行で確認する |

アップロード済みの素材は保持します。実際の配信対象は、SQLiteで承認された参照から決まります。

## リビジョンと世代番号

| 値 | 用途 |
| --- | --- |
| Showの `state_version` | Show内容・公開状態の変更を識別する。更新元の照合とキャッシュに使う |
| `feed_generation` | Feed・内蔵サイトの内容変更を識別する。公開確定時の競合検出にも使う |
| Episodeの `lifecycle_version` | Episodeの公開状態の切り替えを識別する |
| `revision_id` | 確定した内容を識別するUUID |
| `audio_revision_id` | 音声の公開URLと音声参照を識別するUUID |
| `cover_generation` | カバー参照の世代。過去版の採用では保存済みの値を使う |
| `site_id` | Episode個別ページの固定短縮ID |

メタデータだけのEpisode更新では、音声のハッシュ・サイズ・長さが同じなら音声URLを再利用します。音声を差し替えた場合も旧音声の参照とR2オブジェクトを保持し、Episodeの公開中は旧URLでも配信できます。

Episodeの `episode_id`、GUID、`guid_is_permalink` の意味、`published_at` は更新後も保持します。GUIDは同じShow内で一意です。Showカバーは初回公開時の拡張子を維持します。

過去版を採用すると、その内容から新しいリビジョンを作り、採用元を `restored_from_revision_id` に記録します。現在内容と同じ場合は `unchanged` となります。

## 公開状態と再公開

Showは登録時に `draft`、公開後に `published`、非公開化後に `unpublished` になります。Episodeは初回公開で作られ、`published` と `unpublished` を切り替えます。

`unpublish` と `restore` は公開状態を変更する操作です。内容と履歴を保持したまま、関連する版と世代番号を更新します。

| 操作 | 配信への反映 |
| --- | --- |
| Showを非公開化 | Feed・サイト・カバー・音声を404にする |
| Episodeを非公開化 | Feedと一覧から外し、個別ページと音声を404にする |
| 再公開 | 保存済み内容を再び配信する。Showの再公開ではEpisode個別の公開状態を維持する |

## 予約公開

予約には、公開要求、実行するUTC時刻、タイムゾーンの解釈、承認したプレビューのハッシュを保存します。素材も登録前にR2へ配置するため、実行時は保存済み要求と素材を使えます。同じ対象が持てる未完了予約は1件です。

| 状態 | 意味 |
| --- | --- |
| `scheduled` | 実行時刻待ち |
| `needs_approval` | 更新元やドメインの変更により再承認が必要 |
| `dispatched` | 公開と実行結果を確定済み |
| `cancelled` | 管理者が取り消した |
| `failed` | 保存要求や対象を実行できないと確認された |

DOの時刻通知機能であるAlarmを、最も早い実行予定に合わせます。1回のAlarmでは、期限が来た予約を時刻・登録順に最大10件処理します。公開内容の確定、`dispatched` への更新、イベント追加は同じトランザクションで行います。

更新元の競合は `base_conflict`、ドメイン変更は `domain_change` として `needs_approval` に移します。ドメイン変更の準備時には未実行予約をまとめて移します。コードだけの配備では予約を維持します。パージなどの実行エラーはAlarm呼び出しの失敗として返します。

## 配信統計

Workerが音声応答を観測し、`ctx.waitUntil` で対象Show DOへ非同期に記録します。集計キーはEpisode・UTC日付・音声リビジョンです。統計記録の完了を待たずに音声を返します。

### 観測する値

- GET 200、または先頭から `min(65,536バイト, 音声サイズ)` 以上を返すGET 206を取得開始として数えます。
- HEAD、304、小さなRange、既知BotのGETは個別に数えます。
- 小さなRangeも通常の206件数と応答バイト数に含めます。BotのGETとバイト数は通常GETから分けます。
- バイト数は応答の `Content-Length` を使います。IP、Cookie、User-Agentの原文は保存しません。
- 失敗・拒否・リダイレクト応答は集計対象から外します。

`audio_get_requests` は通常GETの200・206件数の合計です。`equivalent_full_downloads` は、音声リビジョンごとの応答バイト数を音声サイズで割って合計し、小数第2位に丸めます。どちらも照会時に計算します。これらはHTTP応答の集計値であり、実際の聴取人数を表すものではありません。

### 保持期限と照会

保持日数は既定400日、設定範囲は30〜3650日です。観測の記録時に、期限切れの日別行をUTC日付ごとに最大200行、通算用の表へ合算して削除します。通算値は残った明細と整理済み累計から計算します。

整理は観測の記録時に進みます。保持日数を延ばしても、整理済みの明細は戻りません。照会では `measured`、`partial`、`unmeasured`、`pruned` により計測範囲を示し、未計測と0件を区別します。記録失敗は配信を継続したまま診断情報に反映します。

## 実装と関連テスト

- 公開：[Showサービス](../../src/sqlite-show-service.ts)、[公開トランザクション](../../src/sqlite-publication-queue.ts)、[公開実行処理](../../src/sqlite-publication-executor.ts)、[内容と履歴](../../src/sqlite-publication-content.ts)
- 機能：[予約](../../src/sqlite-publication-schedules.ts)、[統計](../../src/sqlite-delivery-stats.ts)、[短縮ID](../../src/sqlite-site-ids.ts)
- テスト：[公開](../../src/sqlite-publication-executor.test.ts)、[予約](../../src/sqlite-publication-schedules.test.ts)、[統計](../../src/sqlite-delivery-stats.test.ts)、[Show分離](../../packages/cli/src/sqlite-show-separation.test.ts)
- データ：[SQLite表設計](../data/sqlite.md)、[スキーマ](../data/schemas.md)
