# Issue #48: Show分離後のWorker更新の小規模実機確認

本書は試験終了時点の記録。その後、ユーザーの別指示で[対象環境を廃棄](cloudflare_issue48_cleanup_20261021.md)した。ローカル原本・journal・私有証跡は保持している。

## 承認と対象

ユーザーは負荷試験を不要とし、リリース前の小規模なWorker更新試験を承認した。対象は[2 Show・6 Episodeの試験済みサービス](do_show_separation_live_retest_20261021.md) `i48-0147da37`だけ。commit `67293e1`から再構築したLinux単体CLIで、同じ設定・SQLite layout・DO namespaceのcode-only更新を1回行う。

- 更新前に個別Resumeでfeed/cover/音源のbaselineを確認し、各Showを再びPauseする。
- 正式`deploy`で共有更新のprepare・配備・全DOの新native version確認・probe・保守拘束解除を確認する。
- 既知配備のnative反映待ち等で止まった場合だけ、保存済みcheckpointを照合して正式`update-service-verify`から検証と未開始activationを続ける。配備・prepare・未知activationは再送しない。
- 更新後も両Showがpausedのまま、ready/drainedへ戻ることを確認する。
- 片方ずつResumeして他方のpaused/503維持、feed/cover/全6音源のhash・ETag・GUID/日時/URL・HEAD/Range/304保持を確認する。各Showで既存Episodeのmetadata-only公開を1件ずつ行い、公開後も既存音源の識別情報を保持する。
- 最後は両Showを個別Pauseし、全資源・ローカル原本・journal・証跡を保持する。

初回blocked環境`i48-dc48db43`、保持環境`sq16r-6ec01dc6`、診断用Worker、DNS、証明書、権限、課金・CPU設定は変更しない。新規資源作成、削除、旧layout移行、故障注入、負荷試験は行わない。

## 結果

**正常更新と、native反映待ちからの明示的な検証続行に成功した。** 製品コードの追加修正は行っていない。実行区間は2026-10-21 10:41:40〜10:47:49 JST（01:41:40〜01:47:49 UTC）。

更新前のbaseline照合とWorker配備は成功した。通常`deploy`と直後の明示`update-service-verify`は、それぞれ最大120回のnative version反映待ちで停止した。配備PUTやprepareの再送はせず、journalはreceiptを保存した`verified`のまま保持した。

その後の読み取りでは、制御DOとA/Bとも新version、同一更新のprepared、paused/drained、全対象の`targets_native_ready=true`を確認できた。その証拠と同じ単体CLIのhashを照合し、正式verifyで検証と未開始activationを続行した。経過時間だけで反映完了を認定したものではない。

| 項目 | 観測値 |
| --- | --- |
| 更新前version | `f7d0cab1-2ab1-4ff1-9753-58887eead4d7` |
| 配備成功応答と照合した新version | `4746ca3b-34d1-4f52-9982-deb454b28cb7` |
| 対象namespace | `e96c1e880730415f8b25ffeec6ec5d43` |
| CLI artifact SHA-256 | `e1a19be4a0b1e71dd452e0425ef8de8e5fe0af21dff04e3e443958ba3fd5030a` |
| 私有証跡 | `.local-test-data/results/20261021/i48-update-970e41df/` |

### 続行後の確認

| 対象 | 結果 |
| --- | --- |
| 同じ配備からの続行 | 同じbinary hash・凍結要求・保存receiptを照合。新たなdeploy/prepareは行わず、未開始activationとprobeを完了 |
| Native runtime | 制御DO・Show A・Show Bすべて新version。各setupはready、runtime updateはcompleted |
| 更新完了直後 | 全Showともpaused/ready/drained。Show別保守拘束とサービスmaintenanceは解除済み。自動Resumeなし |
| Namespace | 更新前後で同一。設定hash・bucket・Worker名も不変 |
| 既存feed | A/Bの個別Resume直後、更新前とbytesのSHA-256・ETagが一致。各3 item、GUID・公開日時・音源URLを維持 |
| 既存cover/audio | 両coverと全6音源のSHA-256を維持。音源のETag・サイズ・HEAD 200・Range 206/先頭128 bytes・条件付き304も一致 |
| 独立したResume | Aの再開・公開中はBがpaused/503、Bの再開・公開中はAがpaused/503 |
| 更新後の公開 | A/Bそれぞれの既存Episode `first`をmetadata-onlyで更新・明示公開し、各jobがsucceeded。新descriptionがfeedへ反映され、元のGUID・日時・音源URL/hash/ETagを維持 |
| 最終状態 | 両Showとも新version・ready/paused/drained、queued 0、active null、保守拘束なし。集約もshow_count 2、paused_shows 2、maintenance null |

完了後の独立した読み取りでもREST receipt/version/ETag/namespaceと3 DOの完了状態を再照合した。`67293e1`の追加診断を含むWorkerは、この対象サービスで配備済みとなった。故障を注入して追加診断fieldを実機発火させたわけではない。

試験は2 Show・6 Episodeの保持とmetadata-only公開2件に限る。native同時負荷・性能、未知prepare/activation/解除の応答喪失やpurge障害の再発、300MBを実証したものではない。初回purge障害の根本原因は未確定のまま。native反映が有限待機内に揃わない場合は、今回のように成功済み配備を保持して明示verifyを使う必要がある。

Worker・bucket・DO・旧revision・原本・journal・証跡は保持した。今回の承認を削除や追加更新へ流用しない。秘密鍵・操作ID・生ログはGitへ追加しない。

## マージ前の確認

- 再度の`bun test`は461 pass / 0 fail（62 files、56.85秒）、`npm run check`も成功。
- CIのsmoke testに残っていた全体Pause/Resumeのhelp確認を、`show-status` / `show-pause` / `show-resume`へ変更した。廃止済み`service-pause` / `service-resume`は拒否確認に移した。
- 修正したworkflowのsmoke script全体を、既存のLinux単体CLIと隔離した一時workspaceで実行し、exit 0を確認した。この変更に追加の実機操作やWorkerコード変更はない。
