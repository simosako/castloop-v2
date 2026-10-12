# 4781fad 性能追試 — 公開成功、計測途中停止

追記: ユーザー承認後の再測定は完了。初回の停止記録はこのまま保持する。最新結果は [`../rss-performance-4781fad-remeasure1/result.md`](../rss-performance-4781fad-remeasure1/result.md) を参照。

## 結論

CLI・Workerの正式更新と、前回と同じEpisodeのmetadata-only公開は実施済み。公開後の読み取りでR2 statusは `published`、progressは `finished` / purge_confirmed=true、serviceはopen/drained、Show未完了なし。公開Feedはbyte一致、metadataはrevision_id/updated_at以外同じ、元取り込み入力/completed cursor/ローカルTOML/設定hashも不変。

**consumer/guard区間の性能改善判定は保留。** 7回目のCLI状態照会が `publication_status_changed` でexit1になり、以前の「エラー時は停止」の指示に従って計測ヘルパーが停止。公開処理の再送・owner解放・記録の削除/復元はしない。CLIは `published/released` を観測するところまで達していない。

これは公開ジョブの失敗とは区別する。`docs/rss_migration.md` と正式RSS待機処理では、この特定の照会競合を再照会対象にしている。今回の単一jobヘルパーは個別 `operation-status` のexit1をすべて停止扱いにしており、その既知コードを分類して待機継続する処理を入れていなかった。製品コードに今回新たな公開失敗が発生したという証拠ではない。

## 実行識別

- commit: `4781fadbbd8a7b5dd1d4957024b165d774e7e2c1`（無改変）
- CLI: `../../bin/castloop-linux-x64-4781fad`
- CLI SHA-256: `10caeff112769710cc8315548fe671ac592e69060db84d92219ae613cc8c25ce`
- 型検査/build成功、971 pass / 0 fail / 110 files / 14754 expects。
- workspace: `workspaces/rss-20261012-run1`、36件の `otftalk-rss`。
- Episode: `ep-004c1392e01cd19ddc26e5c90cfb53446b4cecacda00c1cb03d82371b87ae915`
- 公開job: `ad3884c2-8aac-4486-b7d1-eaeb32212cd2`
- Worker versionは `installed-worker.json`。正式pause/deploy/verified/resume済みで、4781fadを維持。

## 取得できた部分的な比較

| 区間 | a19efb4 前回 | 4781fad 今回 |
| --- | ---: | ---: |
| metadata staging CLI全体 | 31.649秒 | 33.455秒 |
| 公開受付CLI全体 | 10.805秒 | 13.452秒 |
| 公開受付CLI応答→progress finished（近似） | 90.886秒 | 68.215秒 |

最後の区間は約22.7秒短いが、今回のprogress.updated_atは秒精度かつ保存開始前の時刻で、前回はprogress保存応答時点。時計/計測境界が異なるため参考値に限る。**consumer全体、published/releasedをCLIが観測するまでの時間、guard等の改善率には置き換えない。** staging・公開受付には今回のconsumer改善が直接適用されない。各1標本で配置/時刻/負荷の変動もある。

## Worker logs と停止後確認

Cloudflare Tail APIはHTTP200、ライブ接続と取得に成功。Workerログ設定/API権限は変更していない。`worker-logs.jsonl` は55 invocation、認証header/任意例外を保存しないallowlist形式。対象jobのclaim/commitと照会actionログを取得。7回目照会の `publication.status` ログは outcome=error / 671ms。

停止時に今回のtail sessionだけ終了した（DELETE HTTP200）。その時点ではQueue consumerが進行中であり、consumer invocationのログは終了時に配信されるため、consumer/guardのphaseログを取得できなかった。今回の結果だけでは詳細な性能比較を完了できない。以前403となった履歴telemetry APIへの再試行や権限変更は行っていない。

停止後、既知jobを読み取りのみで1回照会したが同じ `publication_status_changed`。そこで再照会は重ねず、独立したservice/Show照会とR2 status/progress、Feed/metadata/hash確認だけを行った。最終確認ではpublished/finished、open/drained、Show未完了なし。ログ喪失を埋めるために公開を自動再送していない。

## 続行案（未実施・確認待ち）

計測ヘルパーを、正式RSS待機と同じく **`publication_status_changed` だけ最大300秒の予算内で読み取り再照会**する形に修正する。他のエラーは止める。tailは公開照会の一時競合では閉じず、consumer終了ログとservice invocation解放を取得した後に閉じる。

現在jobの既知記録をまず読み取り確認し、正式に完了していることを検証してから、同一metadata-onlyの新規正常更新1jobを計測する（同じcommit要求の再送ではない）。追加revision/control generationは保持し、元cursor/入力/音源/旧環境を維持する。ユーザーの続行判断前には実施しない。

詳細: `partial-comparison.json`、`stopped-readonly-summary.json`、`measured-poll-006.stderr`、`stopped-job-inspection.stderr`、`stopped-server-status.toml`、`stopped-server-progress.toml`、`tail-closed.json`。私有workspace backup/metadata/Feed/management応答を無検査で公開しない。本タスクではcommit/push/Issue追記なし。
