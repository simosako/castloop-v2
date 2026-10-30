# Show DOの設計

Show DOは1番組の公開状態を所有する。公開内容、履歴、公開可否、予約、配信統計を同じSQLiteに保持し、他番組のDOや制御DOを通常の公開処理へ参加させない。

## 構成と入出力

| 実装 | 責務 |
| --- | --- |
| `SqliteShowService` | Showの登録、管理HTTP、公開配信の窓口、各機能の接続 |
| `SqlitePublicationQueue` | サービス識別と実行可否の検査、公開確定トランザクション |
| `SqlitePublicationContent` | 現在内容、履歴、公開可否、世代、配信対象の読取・更新 |
| 公開実行処理（executor） | 要求を検証し、生成内容の確認とパージ後に確定処理を返す |
| `SqlitePublicationSchedules` | 予約とイベント、Alarmの設定、期限到来時の公開 |
| `SqliteDeliveryStats` | 観測の集計、保持期限処理、統計照会 |

`Queue` は現在のクラス名であり、公開要求を非同期ジョブとして蓄積するものではない。直接公開要求は同期的に結果を返す。

Show IDはDO名と保存された登録情報の両方で照合する。登録済みで、未完了のドメイン変更がないことが `publication_ready` の条件となる。保存する表と列は[SQLite表設計](../data/sqlite.md)を参照する。

## 同期アトミック公開

```text
要求を解析・サービスとShowを照合
  → 同一内容なら現在のrevision_idを返す
  → 更新元と公開可否を検査
  → 反映後のRSS・サイト生成を検証、短縮URLを計画
  → 必要なメディア・サイトキャッシュをパージ
  → 単一SQLiteトランザクション
       更新元とFeed世代を再検査
       短縮URL対応・現在内容・履歴・世代を確定
```

要求は `service_id`、`service_config_sha256`、`expected_show_state_version` を持つ。Episodeでは `base_revision_id` と `expected_episode_lifecycle_version` も照合する。パージ待ちの間に状態が変わる場合があるため、コミット直前にも更新元とFeed世代を再検査する。

同一内容の判定は更新元の検査より先に行う。応答を受け取れず再送した場合でも、すでに同じ内容なら `unchanged` を返せる。異なる内容への変更では、古い更新元を `base_conflict` として拒否する。

Showはメタデータとカバー参照、Episodeはメタデータと音声参照を保存する。新しいリビジョンの追加と現在内容の切り替えは同一トランザクションで行う。R2への読書きはこのexecutorでは行わず、CLIが配置した素材参照を受け取る。

### 失敗時の状態

| 失敗箇所 | 残る状態 |
| --- | --- |
| 入力・更新元・生成結果の検証 | 現在の公開内容を維持 |
| キャッシュパージ | SQLiteの公開内容を更新しない。一部キャッシュが消えていても正本は同じ |
| 確定トランザクション | 内容・履歴・世代の変更をまとめてロールバック |
| 確定後の応答喪失 | 公開済みの場合がある。現在内容の照会と同一内容の再実行で確認 |

R2に配置済みの素材は公開失敗でも削除しない。配信はSQLiteの承認済み参照に限定する。

## 識別子・世代と履歴

| 値 | 用途 |
| --- | --- |
| Show `state_version` | Show内容・公開可否の変更を識別し、公開要求の更新元とキャッシュに使う |
| `feed_generation` | Feed・内蔵サイトの内容変更と、公開確定中の競合を検出する |
| Episode `lifecycle_version` | Episodeの公開可否の切り替えを識別する |
| `revision_id` | メタデータを含む確定内容を識別するUUID |
| `audio_revision_id` | 音声公開URLと承認済み音声参照を識別するUUID |
| `cover_generation` | カバー参照の世代。履歴採用時は保存済みの値を使う |
| `site_id` | Episode個別ページの固定短縮ID |

メタデータだけのEpisode更新では、音声のハッシュ・サイズ・長さが同じなら既存の音声URLを再利用する。音声差し替えでも以前の音声参照とR2オブジェクトは保持し、Episodeが公開中なら承認済みの旧音声URLも配信できる。

通常更新では `episode_id`、GUID、GUIDのpermalink指定の意味、`published_at` を変えない。同じShow内のGUID重複も拒否する。Showカバーの拡張子は初回公開後に変更しない。

過去版の採用は保存済み内容から新しいリビジョンを作り、`restored_from_revision_id` を記録する。元履歴やメディアを書き換えない。同一内容なら新しい履歴を追加しない。

## 公開可否

Showは登録後 `draft`、公開後 `published`、非公開化後 `unpublished`。Episodeは初回公開時に作られ、`published` / `unpublished` を切り替える。`unpublish` と `restore` は内容や履歴を追加せず、公開可否と関連する版・世代を更新する。

Showの非公開化は配下のFeed・サイト・画像・音声を404にする。Episodeの非公開化はFeedと一覧から除外し、個別ページと音声を404にする。非公開化しても履歴と素材は残る。物理削除の管理操作はない。

## 予約公開

予約は公開要求そのものと、解決済みUTC時刻・タイムゾーン情報・プレビューのハッシュを保存する。素材は予約登録前にR2へ配置するため、実行時に管理者のPCを起動しておく必要はない。1対象に対し、未完了の予約は1件だけ持てる。

| 状態 | 意味 |
| --- | --- |
| `scheduled` | 指定時刻待ち。時刻変更・取消が可能 |
| `needs_approval` | 更新元の変化またはドメイン変更により、再確認と再承認が必要 |
| `dispatched` | 公開と予約実行結果を確定済み |
| `cancelled` | 管理者が取消済み |
| `failed` | 保存要求や対象を実行できないと確認された状態 |

DOの時刻通知機能であるAlarmは最も早い実行予定に合わせる。1回に期限到来済みの予約を最大10件、時刻・登録順に処理する。公開の確定と `dispatched` への遷移・イベント追加は同じトランザクションで行う。

更新元が変わっていれば `base_conflict`、ドメイン変更時は `domain_change` で再承認待ちにする。ドメイン準備では未実行予約をまとめて再承認待ちへ移す。コードだけの配備変更は予約を失効させない。パージ等の一般実行エラーは握り潰さずAlarm呼び出しを失敗させる。

## 配信統計

音声の成功応答をWorkerの入口で観測し、`ctx.waitUntil` で対象Show DOへ非同期記録する。保存キーはEpisode・UTC日付・音声リビジョン。IP、Cookie、User-Agent原文は保存しない。

- GET 200、または先頭から `min(65,536 bytes, 音声サイズ)` 以上を返すGET 206を取得開始として数える。
- HEAD、304、小さなRange、既知BotのGETは別のカウンタに分ける。
- 転送量は応答の `Content-Length`。途中切断や実際の聴取人数は測定しない。
- 失敗・拒否・リダイレクト応答は集計しない。

微小Rangeは通常の206件数・転送量にも含み、取得開始数には含めない。BotのGET件数・転送量は通常GETから分離する。

`audio_get_requests` は通常GETの200と206の件数合計、`equivalent_full_downloads` は音声リビジョンごとの応答バイト数を音声サイズで割った値の合計で、小数第2位に丸める。どちらも保存列ではなく照会時に算出する。

記録時に保持期限を進め、UTC日付ごとに最大200行の期限切れ明細を通算用表へ合算して削除する。専用の統計Alarmは使わず、観測記録がない日は物理整理も進まない。通算値は残存明細と整理済み累計から求める。

保持日数は既定400日、30〜3650日で変更できる。変更は冪等な設定更新であり、延長しても整理済み明細は戻らない。照会では `measured`、`partial`、`unmeasured`、`pruned` を区別し、未計測・期限切れを0と表示しない。観測はベストエフォートであり、記録処理の失敗は配信を止めない。

## 定義元と関連テスト

- [Showサービス](../../src/sqlite-show-service.ts)、[公開確定](../../src/sqlite-publication-queue.ts)、[公開executor](../../src/sqlite-publication-executor.ts)、[内容と履歴](../../src/sqlite-publication-content.ts)
- [予約](../../src/sqlite-publication-schedules.ts)、[統計](../../src/sqlite-delivery-stats.ts)、[短縮ID](../../src/sqlite-site-ids.ts)
- [公開executorテスト](../../src/sqlite-publication-executor.test.ts)、[予約テスト](../../src/sqlite-publication-schedules.test.ts)、[統計テスト](../../src/sqlite-delivery-stats.test.ts)、[Show分離テスト](../../packages/cli/src/sqlite-show-separation.test.ts)
