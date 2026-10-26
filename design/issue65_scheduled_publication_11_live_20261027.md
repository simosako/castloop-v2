# Issue #65 予約公開の11/11 非公開実機検証（2026-10-27）

main `4731257`（Issue #70 のサイト改善、Issue #63 の workspace backup、Issue #65 の予約公開と future `published_at` 警告を統合）を、新規の本人限定 Cloudflare 環境へ配備し、予約公開を3件、取消を1件確認した。サンプル内容の upload / publish 前に `/podcasts/*` 全体の Access 保護を検証し、公開後とレビュー状態でも未認証要求を再確認した。既存環境・DNS・domain・課金・CPU 上限の変更、環境削除は行っていない。

## 1. 目的と範囲

- fresh な11/11環境で、Show DO の予約表・Alarm・FIFO 統合が実際に動作すること。
- Pause → `needs_approval` → Resume → 明示再承認 → 公開。
- 日時変更 → 取消（FIFO投入前）と、取消内容が配信されないこと。
- 未来の予約を残したまま通常の予約公開が進むこと。
- 11/11 の builtin サイト・Feed・音源・`site_timezone` が予約公開後も整合すること。
- 未認証のブラウザ・HTTP から全コンテンツパスへ到達できないこと。

対象外: Alarm 再配送の強制、blocked 状態、同時刻予約、native CPU / Free 枠の測定、既存環境の変更・削除。障害注入は行っていない。

## 2. 環境

| 項目 | 値 |
| --- | --- |
| サービス | `issue65sc11-f93cd6` |
| Worker | `castloop-issue65sc11-f93cd6-e5e0231f` |
| Worker version | `125cab22-0e2a-45ee-b36c-87624e866eeb` |
| 専用 DO namespace | `0771effa76df497bb156fa4790501528` |
| Show | `issue65sched11`、builtin サイト |
| 内部 queue/content | **11/11**、`website="static-show-v2"` |
| Show 設定 | `site_mode="builtin"`、`site_timezone="Asia/Tokyo"` |
| レビューURL | `https://castloop-issue65sc11-f93cd6-e5e0231f.simosako.workers.dev/podcasts/issue65sched11/` |
| private R2 | `castloop-issue65sc11-f93cd6-929e1d7a` |

Cloudflare Access は対象 host の `/podcasts/*` だけを保護する。許可条件は、本人の正確なメール1件を Include、Cloudflare ログインと対象アカウント所属を Require とする単一の Allow policy で、Bypass / Exclude はない。Access の許可メール、管理鍵、token はこの文書へ記載しない。`/admin/*` は従来の管理者鍵認証のままで、Access の対象外である。

## 3. サンプル公開前の保護確認

空のサービスを fresh init し、Show 内容を一切 upload / publish しない段階で Access application と policy を作成した。最初の `/podcasts/probe/` は Access ログインへの302となり、設定保存と配信経路の反映遅延は観測されなかった。

- 一覧、ページ、Feed、cover、3音源の GET / HEAD / 条件付き GET と音源 Range の**33要求すべてが Access ログインへの302**。コンテンツ本文は返らなかった。
- 鍵なしの `/admin/sqlite-publication/status` と `/admin/sqlite-schedules` は401。
- `/`、`/system/service.toml`、`/staging/uploads/...` は404。
- R2 の managed public domain は `enabled=false`、custom domain は0件。
- Worker の custom domain は0件。deployed version の `has_preview` は false。
- Access は `/podcasts/*` の1 application / 1 Allow policy だけで、より広い許可や Bypass はない。

上記の成功後にだけ、Show の metadata / cover を公開し、4 Episode を stage した。Show 公開後にも30要求、全予約公開後にも33要求、レビュー状態でも33要求を未認証で実行し、**合計129要求がすべて Access の302**だった。

## 4. 予約シナリオと結果

すべて `schedule-episode` と `preview-episode-schedule` の承認 hash を使い、stage 済みの Episode だけを対象にした。時刻は UTC。

| 試験 | 予約時刻 | 操作 | 予約状態 | dispatch | 公開結果 |
| --- | --- | --- | --- | --- | --- |
| A: Pause / 再承認 | 2026-10-26T22:38:08Z | 予約直後に `show-pause` → Resume → `schedule-reapprove` | v1 scheduled → v2 `needs_approval/show_paused` → Resume後もv2 → v3 scheduled | 22:38:08.072Z（+72ms） | `succeeded` |
| B: 変更 / 取消 | 22:39:26Z → 22:40:27Z | `schedule-reschedule` → `schedule-cancel` | v1 → v2 → v3 `cancelled_by_administrator` | なし | 公開jobなし |
| C: 通常予約 | 22:41:28Z | `schedule-episode` | v1 → v2 dispatched | 22:41:28.071Z（+71ms） | `succeeded` |
| D: 通常予約 | 22:43:29Z | `schedule-episode` | v1 → v2 dispatched | 22:43:29.068Z（+68ms） | `succeeded` |

- A は Resume だけでは再開せず、再承認が現在の runtime・admission window・base を凍結し直した後にだけ実行された。
- B は FIFO 投入前に取消され、`publication_state` は null のまま。公開音源 object は0件で、Feed とサイトのどちらにも title が出ない。
- C / D は予定時刻の約70ms後に既存 FIFO へ投入され、同じ job の `succeeded` で公開完了を確認した。
- Feed 世代は 1→4、item 数は 0→1→2→3。A の予定前は0件、C の予定前は A だけ、D の予定前は A と C だけであり、B は最後まで現れなかった。
- 3件の予約公開は、Issue の2〜3回という確認範囲を満たす。

## 5. 11/11 のサイト・Feed・音源

- サイト世代4の一覧に3 Episodeが新しい順で表示され、各 Episode ページは世代2〜4に生成された。3ページとも `site_timezone="Asia/Tokyo"` による `UTC+09:00` 表示、`<audio>`、本文を含み、script と footer はない。
- Feed 世代4は3 item。A・C・D の title を含み、B の title を含まない。
- 公開音源3件の SHA-256 は、stage した元 MP3 とすべて一致した。
- 取消した B の公開音源 prefix は0 object。
- R2 は private のまま。最終 inventory は34 object・6,086,539 bytes（public 21、staging 10、system 3）。
- 公開後の Access 302、鍵なし管理401、公開対象外404、R2/Worker の別 host なしを再確認した。

## 6. 最終状態

`show-admission-pause` で新しい upload / 公開受付だけを停止し、本人向け配信は維持した。

- `state=admission_paused`、`admission=closed`、`delivery=enabled`、`queued=0`、`active=null`、`drained=true`。
- 予約は `dispatched=3`、`cancelled=1`、`scheduled=0`、`needs_approval=0`。
- 環境は削除せず、Access 保護と private R2 を維持して保持する。

## 7. 未確認・限界

- エージェントは本人として Access にログインしていない。本人ブラウザでの表示・再生・seek・スマートフォン操作は未確認。
- Alarm 再配送・中断、blocked、同時刻予約、複数Showの同時予約は未確認。
- native CPU / duration、Cloudflare Free 枠、CDN HIT/MISS、purge 性能は測定していない。予定時刻は実行開始可能時刻であり、最大遅延の保証ではない。
- 障害注入・再起動試験は行っていない。
- Access を迂回する token や公開コピーは作成していない。

## 8. 証跡

秘密情報・Access 許可メール・非公開 job ID を含まない範囲で、私有の git-ignored directory `.local-test-data/results/20261027/issue65-11-f93cd6/` に保存した。

- `access-app.json`、`access-policies.json`（許可条件の件数と decision。メールは保存するが Git へ転記しない）
- `protection-before.ndjson` / summary、`protection-after-show.ndjson` / summary、`protection-final.ndjson` / summary、`protection-review.ndjson` / summary
- `test-a-*`、`test-b-*`、`test-c-*`、`test-d-*`（予約・Pause/Resume・再承認・変更・取消・到来結果）
- `feed-gen{1..4}-*.xml`、`site-gen4-final-index.html`、`site-episode-{a,c,d}.html`
- `audio-hashes.txt`、`r2-inventory-final.json`、`verification-summary.json`、`admission-pause.json`

本記録は11/11統合版の非公開実機結果であり、9/9導入時環境の[初回記録](issue65_scheduled_publication_live_20261026.md)とは別である。
