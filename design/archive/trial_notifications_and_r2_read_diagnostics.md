# 長時間試験の異常通知とR2読取の診断

2026-10-15。管理者から、試験エラーをOpenCodeが認識できるようにした後、
`Private R2 management record was not verified` を調査・修正するよう指示された。
公開の再試験・配備・強制解除はこの変更に含めない。

## 通知が欠落した経路

通常規模試験のtmuxは動き続けたが、OpenCodeの外側shellで待っていたpidfd監視だけでは通知が届かなかった。
OpenCode 2.0.27のローカルログには次の記録がある。

- 09:27:11 UTC：`wait-normal36-trial.py` 起動。
- **10:29:22 UTC：このrepositoryの `location services evicted`。同じ監視shellのoutput APIが404。**
- 10:55:33 UTC：tmux内のrunnerがCLI exit 1を確認し安全停止。

したがって、試験本体をtmuxへ移すだけでは不十分だった。
location evictionとshell消失の関連はログ上確認できるが、OpenCode内部の全終了経路を確定したものではない。
旧waiterが試験失敗をprintするだけで自身はexit 0だった点も修正した。

## 改修した監視

`scripts/test-support/trial-supervisor.ts` をtmux内でrunnerの親として起動する。
private launcherは `.local-test-data/supervise-normal36-trial.ts` を通す。
OpenCodeのshell registryや長時間のblocking toolを監視の唯一の所有者にしない。

- 起動前に `OPENCODE_SESSION_ID` とAPIのsession/projectを照合する。通知先が未検証ならrunnerを起動しない。
- 異常終了、正常終了、terminal結果欠落/不正を判別し、終了codeを伝播する。
  30秒ごとに監視heartbeatを残し、15分間同じrequested commandが未完了なら注意通知する。
- OpenCode V2の `POST /api/session/{sessionID}/synthetic` に
  `delivery: queue` / `resume: true` で、元の同一sessionへdurable inputを送る。
  別agent/sessionの起動、global plugin/configの変更はしない。
- 送信前にmessage IDと通知をprivate outboxへ原子的に保存する。
  応答不明時は同じIDのinbox/配信済みmessageを読取照合し、POSTを盲目的に再送しない。
  確認できなければoutboxはunconfirmed、監視結果も非成功にする。
- 通知は証跡の場所、完了件数、exit codeに限定し、metadata本文・鍵・Cloudflare tokenを含めない。
  通知はmutationの再開・再送・owner返却の許可ではない。
- 監視は実行中のCLI/IOをkillしない。OpenCode API呼出し用の短時間CLIには別の30秒timeoutを適用する。

ローカルの意図的なexit 7を、**外側background shell waiterなしのtmux**で実行し、
同じsessionへの通知受付、outbox acknowledged、exit 7伝播を確認した。
証跡：`.local-test-data/results/20261015/notification-adc5ecfe/`。
API受付とモデルによる通知処理・報告は別段階であり、受付だけを報告完了とは扱わない。
ホスト/tmuxごとの喪失やOpenCode APIの長期停止まで通知を保証するものではない。
通知API不通時のunconfirmed outboxは、再起動後に読み取りで確認する。
既存normal36 launcherの旧実測source/binary guardは保全した。
実機再試験時には未開始7件の新しいplanと凍結バイナリidentityを用意し、完了29件を再実行しない。

## R2エラーの調査

旧 `ManagementR2Reader.read` はHTTP非200、本文なし、Content-Rangeあり、ETagなしを一つの文言にまとめ、
HTTP status・対象・CF-Rayを捨てていた。30件目はこの分岐で9.124秒後に停止した。
HTTPのどの条件が不成立だったかは既存ログから復元できず、**429や5xxだったと断定しない**。
Worker CPU超過やOpenCodeによる試験本体の強制終了とも区別する。

同じ停止対象のtarget照合を改修後にread-onlyで3回行い、計48 GETはすべて成功した。
current revisionは元のまま、open、現在Show ownerなし。一時失敗は再現していない。
証跡：通常規模試験の `r2-readonly-investigation-6ca0ee2f.json`（private）。

## CLI側の修正

- 失敗/再試行時に `management_r2_read` JSONをstderrへ出す。
  reason code、HTTP status、試行回数、経過時間、検証条件のboolean、形式を限定したCF-Ray、
  object種別とkeyのSHA-256だけを記録する。
  raw key、ETag値、本文、任意exception message、認証headerは記録しない。
- GETの接続・読取失敗、408/429、選択した一時的5xxだけ最大3回。
  500/1000ms backoffとRetry-Afterを尊重し、**backoff込みで元の1読取30秒予算を共有**する。
  予算を超えるRetry-Afterなら待たずに停止し、CLIの公開待機上限を拡張しない。
- 401/403、部分応答、ETag/本文欠落、UTF-8/size等の検証失敗は再試行しない。
  404は従来どおり不在snapshotであり、成功や回復権限の証拠ではない。
- 再試行前に前の応答IOのcancel/settlementをawaitする。
  読み取った設定・owner・generation・署名済み結果の整合照合は省略しない。
- PUT、Queue POST、publication mutationは再試行しない。未知送信・既存journalを再開しない。

RSS回帰試験の「1回だけの接続エラー」はGET再試行で回復するようになったため、
同試験の停止注入を再試行しない403へ変更し、未開始updateのjournal保全を引き続き検証する。
本変更は元のCloudflare応答の根本原因を証明するものではなく、診断欠落と一時GET失敗への弱さを修正する。

## 検証

- 全自動テスト **1,177件成功 / 0失敗**、TypeScriptチェック、Linux単体バイナリのbuild/`--help`成功。
- 新規回帰は通知先照合、exit伝播、結果欠落/不正、滞留通知、通知応答喪失のinbox/message照合、
  未確認outbox、再起動禁止、GET retry上限、元のtimeout予算、Retry-After、非retry対象、
  秘密情報非出力、前応答IOのsettlement、service snapshot整合照合を対象とする。
- Cloudflareに対しては上記48 GETだけ。publication/PUT/Queue POST/配備/解除は実行していない。
  ダミー通知のexit 7は意図した受入れ試験で、通常規模試験の新しい失敗ではない。

## 参照

- [36件試験の途中結果](normal36_publication_measurement_20261015.md)
- [OpenCode V2 API](https://opencode.ai/v2/docs/api/)、実行中2.0.27の `/openapi.json`
- [Cloudflare API rate limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/)
