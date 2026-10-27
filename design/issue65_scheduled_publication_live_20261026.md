# Issue #65 予約公開のCloudflare実機検証（2026-10-26）

Issue #65のサーバー側予約公開をfreshなCloudflare環境へ配備し、3件のEpisode予約公開を実機で確認した記録。対象は隔離した新規サービスだけであり、既存環境・独自ドメイン・本番DNSは変更していない。

> 現在のIssue #65／#70統合版は内部queue/content形式**11/11**。本記録は予約公開単独の**9/9**環境で取得した履歴であり、11/11環境の実配備・実機確認は[別記録](issue65_scheduled_publication_11_live_20261027.md)を参照する。
>
> 2026-10-27追記: 本試験は非公開運用ルールの追加前に実施した。保持していたworkers.dev公開URLの環境は、同日の明示承認を受けてCloudflare資源を削除した。削除前にR2 objectを私有領域へ退避し、size/MD5を照合した。DO SQLite全体のexportは行っておらず、ローカルworkspace・journal・証跡は保持している。詳細は§6。

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

以下は初回3件の時点の記録である。§7でPause／再承認、日時変更・取消、通常FIFOの非占有、直リンクの非公開を追加確認した。残る未確認は§7.6にまとめた。

- Pause／受付停止／保守／runtime・base変更後の`needs_approval`と`schedule-reapprove`はローカル回帰だけで、今回の実機では実行していない。
- Alarm再配送・中断、blocked、同時刻予約、複数Showの同時予約は未確認。
- 予定前のFeed未配信は確認済み。直リンクは§7.4で予定前404・公開後200/206を確認したが、R2 object一覧とCache内部状態は確認していない。
- CPU・duration・Free枠、purgeのnative性能、長期Alarm精度は測定していない。予定時刻は実行開始可能時刻であり、最大遅延の保証ではない。
- 今回はfunctional確認だけであり、Cloudflareの障害注入や再起動試験ではない。

## 6. 保持と削除（2026-10-27）

初回試験後は環境を`open`、`queued=0`、`drained=true`で保持し、workspaceの`castloop.toml`、`.castloop/`の管理鍵・journal、`evidence/`のFeed snapshotとschedule statusを保存した。管理鍵・token・アカウントID・raw秘密はこの文書へ含めない。

2026-10-27、管理者の明示承認を受けて9/9環境のCloudflare資源を削除した。

- 対象Worker `castloop-issue65sched143403-533a3c19`を削除し、HTTP 404、専用DO namespaceの消滅、公開URLの404を確認した。
- private R2の41 object・6,462,289 bytesを削除前に私有directoryへ退避し、全objectのsizeとMD5（weak ETagを含む）を照合した。object削除後の一覧0件を確認してbucketを削除し、GET 404を確認した。
- 9/9専用のAccess applicationは存在せず、他環境のAccess applicationは変更していない。
- 保持サービス`sq16r-6ec01dc6`の設定、11/11非公開環境、DNS、共有証明書、権限、課金・CPU設定は変更していない。
- ローカルworkspace・journal・証跡は保持している。DO SQLite全体のexportは行っていない。

私有の削除証跡は`.local-test-data/results/20261027/issue65-9-cleanup-20261027T001230Z/`に保存した。`cleanup-complete.json`、`r2-backup-summary.json`、`r2-backup-verification.json`、`delete-objects-summary.json`、`delete-bucket.json`、`retained-sq16r-settings-before.json` / `after.json`を含む。

証跡（削除前の試験）:

- `evidence/issue65-preview-ep{1,2,3}.json`: 予約preview、承認hash、解決したUTC/JST。
- `evidence/issue65-schedule-ep{1,2,3}.json`: 予約受付結果。
- `evidence/issue65-feed-{before,after}-ep{1,2,3}.xml`, `issue65-feed-final.xml`: 各時点のFeed。
- `evidence/schedule-list-final.json`, `evidence/schedule-status-*.json`, `evidence/show-status-final.json`: 最終状態。

## 7. 追加実機確認（2026-10-27 JST / 2026-10-26 UTC）

同じ保持環境で、初回の3件では未確認だったPause／再承認、日時変更・取消、通常FIFOの非占有、直リンクの非公開を追加確認した。新しい環境・資源は作成していない。証跡はworkspaceの`evidence/20261027-addendum/`に保存した。

### 7.1 Pause → needs_approval → Resume → 再承認 → 公開

Episode `ep-pause-20261027`をfuture UTCへ予約した直後に`show-pause`した。

| 時点 | 予約状態 | version | 理由 | 公開job |
| --- | --- | ---: | --- | --- |
| 予約直後 | `scheduled` | 1 | - | なし |
| Pause後 | `needs_approval` | 2 | `show_paused` | なし |
| Resume後 | `needs_approval` | 2 | `show_paused` | なし |
| 再承認後 | `scheduled`（15:47:26Z） | 3 | - | なし |
| 到来後 | `dispatched` | 4 | - | `succeeded` |

- Resumeだけでは再開せず、`preview-schedule-reapprove`と`schedule-reapprove`が新しいruntime・admission window・baseで要求を凍結し直した。
- dispatchは予約時刻+22ms。予定前のFeedは3 itemで対象titleなし、公開後は4 itemで対象だけ追加された。
- pause Episodeの`verify`は`pass=3, warn=1, not_checked=1, fail=0`。

### 7.2 日時変更と取消

Episode `ep-cancel-20261027`を16:05:41Zへ予約し、16:15:42Zへ変更後、FIFO投入前に取消した。

- 変更はversion 1→2、取消はversion 2→3。最終状態は`cancelled`、理由`cancelled_by_administrator`。
- 公開jobは作られず、`publication_state=null`。実際の公開音源path（scheduleのjob IDを使用）は404で、Feedにもtitleは出ない。
- 取消後のstatusも`cancelled`、version 3のまま。

### 7.3 遠い未来の予約が即時公開を塞がない

Episode `ep-future-20261027`を18:48:18Z（約3時間後）へ予約したまま、別のEpisode `ep-immediate-20261027`を`publish-episode`で即時公開した。

- 即時公開は開始から2秒で`succeeded`。未来予約は`state=scheduled`、`publication_state=null`のまま保持された。
- Feedは5 itemとなり、即時公開したtitleだけが追加された。未来予約のtitleは出ていない。
- 未来予約の実際の公開音源path（job IDを使用）は予定前404。確認後に取消し、version 2・`cancelled_by_administrator`とした。

### 7.4 予定前の直リンクと公開後の配信

- 予約4件すべてのstaging object key（`staging/uploads/.../audio.mp3`）は予定前404。公開後に再確認したpause分も404のまま。
- 未来予約の公開音源path（job IDを使用）は予定前404。取消した2件の公開音源pathも404。
- 公開後のenclosure URLはHEAD 200、`Range: bytes=0-99`は206。ダウンロードしたMP3のSHA-256はstageした元MP3と一致した（`acb98877...ca0d9`）。

### 7.5 最終状態

`show-status`は`open`、`queued=0`、`active=null`、`drained=true`。予約集計は`scheduled=0`、`needs_approval=0`、`dispatched=4`。Feedは5 item。

### 7.6 残る未確認

Alarm再配送・中断、blocked、同時刻予約、複数Showの同時予約、CPU・duration・Free枠、purgeのnative性能、長期Alarm精度は引き続き未確認。今回は障害注入を行っていない。

### 7.7 future `published_at` 警告の読み取り専用確認

実装後のCLIで、一時的なfuture日時のEpisode TOMLを`preview-episode --local`へ渡し、`warnings[]`に`code=future_published_at`と`published_at`が返ることを確認した。TOMLは確認後に削除し、サーバー状態とuploadは変更していない。証跡は`evidence/20261027-addendum/warning-preview.json`。
