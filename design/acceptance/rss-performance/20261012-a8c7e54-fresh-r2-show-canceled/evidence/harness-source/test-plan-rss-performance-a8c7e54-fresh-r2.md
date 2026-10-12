# a8c7e54 性能試験 — 新規環境r2

- ユーザー承認: run1の取り込み入力を再利用し、本物36MP3（1,496,055,589 bytes）で準備する。旧updating環境/Issue #11のjournalや資源は操作しない。
- 新service `rssperf-1012-r2`、bucket `castloop-rss-perf-20261012-r2`、hostname `castloop-rss-perf-r2.otftalk.com`、workspace `workspaces/rss-performance-20261012-r2`。未使用/Zone/routeをAPI GETで確認し、既存資源の採用なし。
- 無改変a8c7e54ビルド済みCLIのhash/commit/source cleanを再確認、再build不要。新規initで同commitのWorkerを作りpaused/readinessを確認、新domain追加・整合確認後に明示resume。compatible deployを使わない。
- DNSは1.1.1.1明示。CLIのdomain到達確認にはこの新hostnameだけのprocess限定CONNECT tunnel（TLS透過）を使用し、OS/routerや権限設定は変更しない。
- 新workspaceから `publish-rss-import imports/rss-20261012-run1` を1回実行。入力はその場に保持し、旧workspaceの.castloop/公開cursorをコピーしない。全36件を順番に公開、各jobのpublished/released確認は正式CLIに任せる。
- 取り込み入力全116hash不変、completed cursor、service open/drained/Show idle、Feed全36件/GUID/日時/metadata/enclosure長・新host参照、catalog整合を確認する。独立MP3再GETは代表2件のみ、カバーhash/HEAD/Rangeも確認し、全36の再downloadは行わない。
- 新規環境ではカタログは初期公開中に構築されるため、36件からのcold構築は測れない。36件完了後、前回と同じEpisode同一metadata-onlyの通常更新1jobを測る。正式Worker Logsを先に接続、consumer終了・Showとservice解放後に今回tailのみ閉じる。
- 計測helperは厳密なpublication_status_changedのread-only再照会だけ許可（300秒/300回、1秒sleep）。それ以外のエラー/timeout/unknown mutationでは停止・記録維持、再送/強制解除なし。
- GUID/feed_inputs/staging.finish/consumer/CLI staging・commit・published/released時間を4781fadの実測と比較。新service/bucket/hostname/配置・初期履歴の違いを記録し、各1標本/metadata-onlyである制限を明示。新旧Feed byte同一は要求せず、各環境内で計測前後byte同一を確認する。
- 資源・旧ホストは削除せず、新環境はopenのまま保持。結果/原本は `evidence/rss-performance-a8c7e54-fresh-r2` と活動log。今回GitHub push/Issue追記は未指示なので行わない。
