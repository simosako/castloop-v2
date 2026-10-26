# 配信統計（Episode別・日別）の利用ガイド

Issue #71の配信統計の操作ガイド。内部queue/content形式 **9/9**（content `9` と識別 `delivery_statistics="episode-daily-v1"` は本機能、queue `9` はIssue #70の番組サイトとIssue #65の予約表を含む）を使う新規環境専用。旧形式（queue `8` 以前、content `8` 以前）の環境への統計機能追加・データ移行は行わない（[設計](../design/episode_delivery_statistics_plan.md)参照）。

## 何を数えるか・数えないか

集計対象は公開済みEpisode音声（`/podcasts/<showId>/episodes/<episodeId>/<audioRevisionId>.mp3`）へのリクエストのみ。Feed（`feed.xml`）とカバー画像は対象外。統計はUTC日付単位の整数カウンタとして、その番組（Show）のDurable Object内のSQLiteに保存される。

| 指標 | 意味 |
| --- | --- |
| `initial_downloads` | 先頭からの本編取得開始数。`GET 200`、または先頭（`offset = 0`）から `min(64KiB, 音源サイズ)` 以上を返した `GET 206` |
| `equivalent_full_downloads` | ファイルサイズ換算値。`response_bytes ÷ 音源サイズ`（小数第2位）。分割Rangeでも合計1本分で `1.0` |
| `audio_get_requests` | 音声を返したGET総数（`get_200_requests + get_206_requests`） |
| `response_bytes` | 応答ヘッダーの `Content-Length` 合計。**クライアントの途中切断は差し引かない** |
| `head_requests` / `not_modified_requests` | `HEAD` 成功数 / `304 Not Modified` 数（音声本文なし） |
| `probe_range_requests` | `bytes=0-0` 等の微小Range確認数（`initial_downloads` に含めない） |
| `bot_get_requests` / `bot_response_bytes` | 既知bot・クローラ・`castloop-verify` のGET応答（本編統計から分離） |

これらは「サーバーが観測した事実の分類」であって、実際に聴いたユニーク人数や再生完了率ではない。IPアドレス、Cookie、User-Agent文字列は保存しない（bot判定はbooleanのみ）。

## 使い方

```sh
# Show内のEpisode別集計（既定: 直近30日・UTC。1ページ20 Episode）
castloop stats my-show

# 期間指定とJSON出力（最大366日）
castloop stats my-show --from 2026-10-01 --to 2026-10-25 --json

# 特定Episodeの日別推移（1ページ31日）と音源revision別内訳
castloop stats my-show --episode first --by-revision

# 次ページ
castloop stats my-show --cursor 'TOKEN_FROM_PREVIOUS_PAGE'
```

`--json` は他のコマンドと同じ `agentEnvelope` 規約（Issue #67）で1文書を返す。通信に失敗した場合は `0` や空一覧へフォールバックせず、exit code 1 で失敗を報告する。

## 「0件」「未計測」「保持期限切れ」の区別

各日の `coverage`（表示の `STATUS` 列）は次の4値で、**未計測・期限切れは `0` と表示しない**（JSONでは `counters: null`）。

| coverage | 意味 |
| --- | --- |
| `measured` | 通日計測済み。アクセスがなければ明確に `0` |
| `partial` | 計測開始日の途中（00:00Z開始でない）、または照会日の当日 |
| `unmeasured` | 統計機能の計測開始日より前 |
| `pruned` | 保持日数Nによる削除済み期間。`lifetime`（通算）には含まれる |

`lifetime` は削除分を合算したEpisode×音源revision別の通算累計で、`period`（期間合計）とは独立に返される。metadata-only更新（タイトル等の変更）では音源URLが変わらないため集計は分断しない。音声差し替えでは旧音源と新音源がrevision別に区別され、Episode合計では両者が合算される。

## 保持日数の変更

既定の保持日数は **400日**（30〜3650日の範囲で変更可能）。Showごとに、再配備なしで変更できる。

```sh
# 180日へ短縮（次のUTC日替わり削除から適用）
castloop stats-retention my-show 180 --operation-id UUID

# 同じ操作IDでの再実行は保存済み結果の照会になる（二重適用しない）
```

- 現在値は `castloop stats my-show --json` の応答（`retention_days`）で確認する。
- **延長**しても、すでに削除済みの日別明細は戻らない（通算累計には残っている）。
- **短縮**すると、期限を過ぎた行が1日1バッチ（最大200行）ずつ削除され、削除分は通算累計へ合算されるため通算合計は失われない。複数日に分かれても表示は一貫する。
- 操作は送信前にローカルjournal（`.castloop/sqlite-stats-controls/`）へ記録され、応答不明時は同じ操作IDでの照会のみを行う（`show-pause` 等と同じ規律）。

## 記録の仕組みと限界

- 観測はGateway（`serveSqliteGateway`）で応答確定後に行われ、`ctx.waitUntil` でShow DOへ非同期記録される。キャッシュヒット／ミスの両方でちょうど1回カウントされる。**統計記録の失敗が配信を止めることは構造的にない**（失敗は `recording_error_count` として応答に含まれ、隠されない）。
- 失敗・拒否応答（404/410/412/416/503）や旧URLからの307リダイレクトは計上しない。未承認の音源revisionは公開可否gateで拒否され、記録されない。
- `User-Agent` はクライアントの自己申告であり、一般ブラウザを名乗るクローラはbot側へ分類できない。

## リスナー向けのプライバシー説明（番組サイト等への記載例）

> 当番組の配信サーバー（Castloop）では、エピソードごとの日別配信回数および転送データ量の合計を集計しています。この集計処理において、リスナー個人のIPアドレス、Cookie、端末識別子、User-Agent文字列などの個人情報をデータベースへ保存したり、個人を追跡したりすることはありません。（なお、配信インフラであるCloudflareのネットワーク運用・セキュリティ保護のために処理される通信情報については、Cloudflareのプライバシーポリシーが適用されます。）
