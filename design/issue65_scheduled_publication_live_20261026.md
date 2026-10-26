# Issue #65 予約公開のCloudflare実機検証（2026-10-26）

Issue #65のサーバー側予約公開をfreshなCloudflare環境へ配備し、3件のEpisode予約公開を実機で確認した記録。対象は隔離した新規サービスだけであり、既存環境・独自ドメイン・本番DNSは変更していない。

## 1. 対象と前提

- 実装: Show DO内の予約表、既存Alarmによる到来時のFIFO投入、`needs_approval`への停止、CLIの予約preview・作成・一覧・詳細・日時変更・取消・再承認。
- 内部queue/content形式: **9/9**。予約表の追加でqueueを8から9へ進めたfresh環境専用。
- 検証指示: 新規環境をdeployし、2〜3回の予約公開を、予定前の未配信と予定後の配信開始に分けて確認する。
- 資源作成・予約公開・配信確認の範囲だけを実施した。削除、既存環境の変更、独自ドメイン、課金・権限変更は行っていない。

## 2. 環境

| 項目 | 値 |
| --- | --- |
| 環境 | 新規隔離サービス `issue65sched143403` |
| Worker | `castloop-issue65sched143403-533a3c19` |
| Public/management origin | `https://castloop-issue65sched143403-533a3c19.simosako.workers.dev` |
| Worker version | `964b1509-49cf-4d90-8576-3a9d4397a750` |
| Show | `otftalk-minimal`（サンプル3 Episode、外部サイトURL） |
| 初期化 | `phase=ready`、Showはpausedで登録後に明示Resume |
| ローカルworkspace | `castloop-v2/.local-test-data/issue65-schedule-20261026-143403`（Git管理外） |

Show公開後、サンプル3 Episodeをmetadata＋MP3でstageした。予約はすべて`schedule-episode`を使い、`preview-episode-schedule`が返した`approval_sha256`を`--expect-preview`へ渡した。

## 3. 予約と結果

3件を同時に予約し、それぞれ約3分間隔で到来させた。すべて`publication_state=succeeded`となり、Feedに追加された。

| Episode | 予約UTC | 予約のtimezone解決 | schedule ID | dispatched | 結果 |
| --- | --- | --- | --- | --- | --- |
| `ep-29f89...f9079`（Apache Iceberg） | 2026-10-26T14:39:07Z | 明示`Z`、表示は設定`Asia/Tokyo` | `2282b722-2e0a-4527-aab0-ecd64279d0af` | 14:39:07.002Z | succeeded |
| `ep-c84f4...1d8a`（OTF入門） | 2026-10-26T14:42:46Z | offsetなし、設定`Asia/Tokyo` | `70adddb0-8f46-41f1-9bb2-a2f6f2383811` | 14:42:46.002Z | succeeded |
| `ep-fef74...b767d`（Icebergとセキュリティ） | 2026-10-26T14:45:53Z | offsetなし、CLI`--timezone Asia/Tokyo` | `bf57d021-b9e1-441b-bd87-15e254bde5b6` | 14:45:53.002Z | succeeded |

`dispatched_at_ms`は予約時刻の2ms後。予約表からFIFOへの投入は予定時刻を待ち、投入後は既存の公開処理が完了した。

## 4. 予定前後の配信確認

公開originのFeedを取得し、各Episodeのtitleを確認した。表の時刻はUTC。

| 確認 | 時刻 | Feed item数 | 予定前後の状態 |
| --- | --- | ---: | --- |
| 予約直後 | 14:37:06 | 0 | 3件とも未配信 |
| 1件目の予定25秒前 | 14:38:42 | 0 | 3件とも未配信 |
| 1件目の予定44秒後 | 14:39:51 | 1 | Apache Icebergだけ配信 |
| 2件目の予定11秒前 | 14:42:35 | 1 | OTF入門は未配信 |
| 2件目の予定44秒後 | 14:43:30 | 2 | OTF入門まで配信 |
| 3件目の予定25秒前 | 14:45:28 | 2 | Icebergとセキュリティは未配信 |
| 3件目の予定35秒後 | 14:46:28 | 3 | 3件とも配信 |

各予定前に、そのEpisodeのtitleがFeedに存在しないことを確認した。予定後は対象Episodeだけが追加され、他の未到来予約は追加されなかった。`verify SHOW --episode EPISODE`は3件とも`pass=3, warn=1, not_checked=1, fail=0`だった。warn/not_checkedの内容は公開処理の成功判定には使っていない。

最終状態:

- `show-status`: `state=open`、`queued=0`、`active=null`、`drained=true`。
- 予約集計: `scheduled=0`、`needs_approval=0`、`dispatched=3`、`next_scheduled_at_ms=null`。
- Feed: 3 item。各`schedule-status`は`state=dispatched`、`version=2`、`publication_state=succeeded`。

## 5. 未確認範囲

- Pause／受付停止／保守／runtime・base変更後の`needs_approval`と`schedule-reapprove`はローカル回帰だけで、今回の実機では実行していない。
- `schedule-reschedule`／`schedule-cancel`の実機操作、Alarm再配送・中断、blocked、同時刻予約、複数Showの同時予約は未確認。
- 予定前のFeed未配信は確認したが、推測した音源直リンク、R2 object一覧、Cache内部状態は確認していない。
- CPU・duration・Free枠、purgeのnative性能、長期Alarm精度は測定していない。予定時刻は実行開始可能時刻であり、最大遅延の保証ではない。
- 今回はfunctional確認だけであり、Cloudflareの障害注入や再起動試験ではない。

## 6. 保持

環境は削除せず、`open`、`queued=0`、`drained=true`で保持した。workspaceには`castloop.toml`、`.castloop/`の管理鍵・journal、`evidence/`のFeed snapshotとschedule statusを保存している。管理鍵・token・アカウントID・raw秘密はこの文書へ含めない。

証跡:

- `evidence/issue65-preview-ep{1,2,3}.json`: 予約preview、承認hash、解決したUTC/JST。
- `evidence/issue65-schedule-ep{1,2,3}.json`: 予約受付結果。
- `evidence/issue65-feed-{before,after}-ep{1,2,3}.xml`, `issue65-feed-final.xml`: 各時点のFeed。
- `evidence/schedule-list-final.json`, `evidence/schedule-status-*.json`, `evidence/show-status-final.json`: 最終状態。
