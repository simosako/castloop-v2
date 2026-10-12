# Issue #10 修正再試験: 別エラーで停止

## 対象と更新

- commit: dc33f75ae7e02beefe5cf37d1d02aa9fd804abec。
- CLI SHA-256: ea9371842d3624579e2083ca24c77d692270d831e2babddb057f1a4a1b26db3f。
- npm ci、npm run check、正式CLI/同梱Worker build成功。bun test: 962 pass / 0 fail、108 files、14682 expects。
- 同じservice rsstest-1012-r1、hostname castloop-rss-r1.otftalk.com、import 908efe60-3585-4a6a-af01-f1c5d8afb206。
- 既存workspace設定/秘密journalを私有backupに保存。前回Episode job published/releasedを確認。
- 全Showを列挙（1件、next_cursor=null）、pause後invocations=[]/unfinished=falseを確認してdeploy。
- 新Worker version: 4d87255c-0d41-43b1-89ce-50c1eb14fb11。runtime verified、設定byte不変、domain整合/未完了操作なし。
- 保存したpause IDで明示resume後、修正CLIで元の取り込み記録を一度続行。

## 停止結果

publish-rss-import exit=1:

```text
Target inspection response was not verified; management operation was not confirmed [reason_code=management_http_rejected]
```

- 元のoperation-status一般エラーとは異なるtarget inspection拒否。根本原因、HTTPの具体的status/bodyは今回stderrでは確定しない。
- 保存cursor: phase=command_requested、step=25、waiting_job_idなし。
- action配列上は6件目のupdate-episode。Episode ID: ep-3b2c6d1cdea50d1a3c6d4d9fbaaf8ea9507ada9ef5796891d8b717bf5635cdc0。
- 停止後の読み取りで5件のEpisodeがactive、next_cursor=null。service open/invocations=[]、target-show unfinished_show_operation=false。
- 取り込み全ファイルのSHA-256/sizeは続行前と完全一致。cursor lockなし。秘密journalの停止時copyを保存。
- command_requestedでは手順書/実装が変更コマンド再送を拒否するため、再実行やcursor改変、owner/lock解除はしていない。
- 公開状態競合の修正をライブで完全合格とは判定しない。5件まで進んだが全36件の公開は未完了。競合の実際の発生/再照会回数はこのCLI出力では観測できない。競合限定再照会/他エラー停止は自動試験で検証。

## 保持・未実施

旧環境/旧ホスト・購読者設定は変更なし。新環境・独自ドメイン・元取り込み記録・既存jobを保持。新環境は停止後確認時open、実行中invocationなしで、公開済み5件はrollbackしていない。

全件配信照合、全36音源hash確認、完了後の重複防止/互換性回帰、終了pauseは未実施。準備した検証scriptはこのエラー後に実行していない。

DNS: 更新/公開時にはこのPCの通常名前解決が成功しており、今回のエラーはDNSエラーとは確認されていない。OS/routerのDNS変更なし。配信検証scriptは1.1.1.1の直接解決とcurl --resolve（TLS検証有効）を使用する準備済み。

主証跡: publish-continued.stderr/exit-code、cursor-stopped.json、stopped-service/target/episodes/domains.stdout、stopped-input-validation.json、deploy/resume証跡。これらは秘密除去前の私有原本であり、そのまま公開しない。
