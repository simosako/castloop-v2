# Issue #71 配信統計の実機小規模検証（2026-10-25）

Issue #71（Episode別・日別の配信統計）の実装（main統合前の実装コミット `05ccbd6`、ブランチ `feat/issue-71-delivery-statistics`）に対する、新規Cloudflare環境での小規模実機検証の記録。管理者が「小規模で良いので実機検証をしてください（新規に環境を作る）」と指示し、サンプルデータ `.local-test-data/minimal/`（Show 1件・Episode 3件・短尺MP3）の利用を許可した。検証実行後、本ブランチはIssue #70（番組サイト、queue `8`・`website`識別）を含むmainへrebaseした。統計機能の観測・集計・保持の各処理はrebaseで変更しておらず、検証結果はそのまま参照できる。

本記録は一部の成功事例の証跡であり、全負荷でのFree枠適合、大規模番組での容量・書込み上限、長期運用での保持期限削除の実地確認を含まない。

## 環境

| 項目 | 値 |
| --- | --- |
| service_id | `stats71r1`（テスト専用の新規環境。保持対象の `sq16r-6ec01dc6` および既存 `site70-1cd434d0` には非干渉） |
| Worker | `castloop-stats71r1-b4c96324.simosako.workers.dev` |
| bucket | `castloop-stats71r1` |
| workspace | `/tmp/opencode/castloop-stats71-live`（ローカル。Git管理外） |
| CLI | main統合前の実装コミット `05ccbd6` を `npm run build:cli -- linux-x64` で単一バイナリ化したもの |
| 内部形式 | queue/content **7/9**（Issue #70統合前のコミットによる検証時点。統合後の新規環境は **8/9** で `website="static-show-v1"` も必須）、health `delivery_statistics="episode-daily-v1"` をinit完了時から使用 |
| サンプル | `otftalk-minimal`（Episode 3件。音声は 240,579 / 80,501 / 480,488 bytes） |

## 検証手順と観測

`init`（operation `5f7c2a41-...-710000000001`）→ `create-show` → `show-resume` → `update-show` → `publish-show` → Episode 3件（`update-episode` / `update-episode-audio` / `publish-episode`）はすべて `succeeded`。`verify otftalk-minimal` は全項目 pass（audio は `--episode` 未指定のため not_checked）。

その後、公開音声URL（`ed5f4ec1-86b3-4c5f-bc96-a2547f702301.mp3`、240,579 bytes）へ次のリクエストを送り、`stats` でカウンタを照合した。初期判定閾値は `min(65536, 240579) = 65536`。

| リクエスト | 期待する計上 | 観測 |
| --- | --- | --- |
| `HEAD` ×3（ETag確認含む） | `head_requests +3` | ✓ |
| `GET If-None-Match`（既知ETag）→ 304 | `not_modified_requests +1`、他増えず | ✓ |
| `GET` 全文（200、`cf-cache-status: HIT`） | `get_200 +1`、`initial +1`、bytes +240,579 | ✓ |
| `GET Range: bytes=0-65535`（206） | `get_206 +1`、`initial +1`、bytes +65,536 | ✓ |
| `GET Range: bytes=0-0`（206） | `get_206 +1`、`probe +1`、`initial` 増えず | ✓ |
| `GET Range: bytes=100000-101023`（206） | `get_206 +1` のみ、bytes +1,024 | ✓ |
| `GET` 全文（`User-Agent: Twitterbot/1.0`） | `bot_get +1`、`bot_response_bytes +240,579`、本編増えず | ✓ |
| `GET Range: bytes=0-0`（`User-Agent: castloop-verify/0.7.5`） | bot側へ `bot_get +1`、`bot_response_bytes +1` | ✓ |
| 未承認revision UUIDへのGET → 404 | 計上なし | ✓ |
| 他Episode 2件への全文GET | 各 `get_200 +1`、`initial +1` | ✓ |

累計照合（1つ目のEpisode、`stats --json`）: `get_200=1, get_206=3, audio_get=4, initial_downloads=2, response_bytes=307,140, probe=1, head=3, not_modified=1, bot_get=2, bot_response_bytes=240,580, equivalent_full_downloads=1.28`（307,140÷240,579=1.2766…の小数第2位）— **すべて手計算と一致。`recording_error_count=0`。**

キャッシュヒット（`cf-cache-status: HIT`）で応答されたリクエストも Gateway 通過後に1回だけ計上されていた（欠落・二重計上なし）。

### 継続集計とページング、保持日数

- **metadata-only更新の非分断**: 1つ目のEpisodeのタイトルだけを変えて再公開（`publish-episode`）。feed のenclosure URLは同じ `ed5f4ec1-...` のままで、更新後の全文GETが同一revision行へ累積した（`get_200=2`、`initial=3`、bytes=547,719、`equivalent=2.28`、`revisions` は1件で `is_current_enclosure=true`）。設計§5のとおり集計は分断しない。
- **日別表示**: 直近30日照会で、計測開始日（2026-10-25）より前の日がすべて `unmeasured`（人向け表示 `-`、JSON `counters: null`）となり、当日は `partial` で観測値を返した。
- **日別ページング**: 366日窓で31日×2ページ（2025-10-25〜 / 2025-11-25〜）を `--cursor` で正しく辿れた。`from > to` は拒否。
- **保持日数変更（案8-α-2）**: `stats-retention otftalk-minimal 90`（操作ID `...0003`）で `retention_days=90` が適用され、`stats` 応答へ反映。同一操作IDの再実行は保存済み結果の照会となり `applied_at_ms` が一致（POSTの再送なし）。`retention_days=10`（30未満）は拒否。
- **総合**: `diagnose otftalk-minimal` は 15 pass / 0 warn / 0 fail。`show-status` は `open`・`publication_ready`・`delivery_statistics="episode-daily-v1"`。

## 未検証・留意

- 保持期限による実際の削除（400日/90日経過）と追い込み削除・`pruned` 表示・`lifetime` 合算の実地確認は行っていない（ローカルテストでのみ検証）。
- 音声差し替え（新audio revision）・非公開化中の404/503・大規模アクセスでのDO書込み行数・CPUへの実影響は未測定。Workers Free枠の実課金行数は未確認。
- テスト環境 `stats71r1`（Worker・bucket・DO namespace）とローカルworkspace `/tmp/opencode/castloop-stats71-live` は本検証の時点で残置。削除には別途管理者の指示を要する。
