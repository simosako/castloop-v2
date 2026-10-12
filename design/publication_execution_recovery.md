# publication停止の診断と未知の実行tokenの保全

Issue #13のShow公開と、別環境で報告された断続的なEpisode公開停止を扱う。
2026-10-13の再調査時点では、Episodeの実機job・停止時ログは未取得であり、取消原因は確定していない。
本書はソースで確認した問題、修正、観測方法を区別する。

## 重要な訂正: DLQを根拠にした解放は無効

前回の`ae6f2ed`で追加した「一致するDLQ markerで全実行の終了を証明できる」という判断は誤りだった。
[Cloudflare Queuesはat-least-once配送](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)であり、
markerは同じcommitの古い失敗や重複通知でも残り得る。実行tokenやservice invocationとの対応、
現在のconsumer・未完了I/Oの終了を証明しない。concurrency 1や単一残留tokenでも、この問題は解消しない。

- `releaseAbandonedPublication`と、任意の残留`m6_consumer`を返却するhelperを撤去した。
- 管理APIの`release`はservice invocation取得・R2書込・再送より前に409
  `publication_execution_unsettled`で拒否する。
- `release-job`／`publication-release`も解放POSTを送らず停止する。従来のjournal/schemaは読めるが、
  新しい`release_requested`／`released`記録は作らず、未知の過去POSTを再送しない。
- 前回版の解放コマンドは使用しない。DLQ・経過時間・HEAD不在・platformのcanceled表示だけで
  ownerやregistryを編集しない。CASは所有権保護であり、未知の旧I/Oが終了した証明の代わりにはならない。

万能な外部復旧は追加しない。[既存の安全方針](./m6_review_queue.md)に戻し、未知の実行は保全する。
U1は[未検証仮定](./m6_upload_recovery_options.md)のままで、今回解決したものではない。

## Issue #13の保存済みShow証跡

`a8c7e54`の新規serviceで初回Queue invocationがwall 34,982ms / CPU 146msで`canceled`になり、
Show実行tokenとservice invocationが残った。再試行2・3はbusyで拒否され、DLQに到達した。
statusは`processing / validating`、progressは`feed`で、公開先metadata/cover/feedは未作成だった。

証跡branch `test-evidence/show-publication-canceled-20261012`のexportには、feed進捗PUTの後に
凍結request GETの未完了spanがある。これは最初のmetadata書込前のguard付近で止まったことと整合するが、
spanの欠落・終了記録だけでruntime取消の引き金を特定できない。
前回報告の「142回のR2操作」は関連trace記録数と混同しており、R2呼出回数の確定値として使わない。
CPU/wallの値だけでCPU制限超過を排除せず、platform outcomeと例外も照合する。

## Episodeで停止し得る経路

`consumeOwnedPublication`は凍結commit/owner照合後にexecution tokenをCAS取得する。
Episodeは実行専用envとeffectsを用意して、次の処理を順にawaitする。

| 区間 | 主な処理／ログphase |
| --- | --- |
| 受付・実行準備 | `invocation_acquire`、`frozen_commit`、`owner_check`、`execution_acquire`、`execution_context`、`effects` |
| 検証 | `runner_control`、`runner_manifest`、`journal_read`、`verify_staging`、`snapshots`、`unique_guid` |
| `progress: feed` | 音源HEAD/GET/PUT/検証、feed入力、history/current/feed保存、`catalog_advance`、`feed_generation_write` |
| `purge`／`visibility` | delivery gate、cache purge、lifecycle CAS |
| `finished` | `status_write.published`、`owner_release`、`invocation_release` |
| 例外後処理 | `failure_record`、`execution_cleanup`、`invocation_release` |

phaseには`publication.`接頭辞が付く。guardは`guard_owner`／`guard_delivery`／`guard_recheck`へ分けて記録する。
`progress: feed`は音源コピー以外も含み、status/progressの保存時刻にはずれがある。
音源PUT待ち、後続のカタログ/世代保存待ち、完了解放待ちを進捗だけで区別できない。

正常経路に未awaitの公開書込や無限再試行は見つからなかった。ただしruntime取消でcatch/finallyに
到達しない場合や、その後処理のR2 GET/CASが継続失敗する場合はtokenが残る。
acquire CASの応答喪失も、取得していないと推定して解除してはいけない。
`published`になっていてもShow ownerとservice invocationの返却を別々に確認する。

## ソースで確認して修正した問題

1. **未消費の音源本文**: staging GET後のversion/size不一致、owner再照合失敗、本文未消費のPUT拒否で、
   元実装はbodyを閉じなかった。PUTのPromiseがsettleした後、未lockのbodyをfinallyでcancelし、完了をawaitする。
   PUTが保留中のままcancel/解放しない。本文は全量buffer化せず、checksum・サイズ検証・immutable CASを維持する。
   小さいsnapshotのETag/size不一致でも破棄本文をcancelする。
2. **並列journal/terminal読取のfail-fast**: 元の`Promise.all`は片方のGET例外で、もう片方の開始済みGETや
   未読本文を残してconsumer後処理へ進めた。両方のGETと本文読取を`Promise.allSettled`で待ち、
   その後に例外とschema/identityを検査する。巨大な破棄recordの本文もcancelする。
3. **観測不足**: 以前は終了時ログのみで、保留・強制終了した内部phaseが見えなかった。
   固定phaseの開始ログと対応する終了ログを追加した。catalog/世代保存、実行取得、通常解放、例外後処理も独立計測する。

これらは具体的な不備の修正であり、別環境の実機Freezeの直接原因や解消を証明するものではない。

## ログと読み取り診断

ログはWorkers Logsへ出し、R2に追跡recordを増やさない。

- `worker_phase_started`: `job_id`、固定`phase`、`timing_id`、`started_at`。
- `worker_timing`: 同じ`timing_id`とphase、`outcome`、開始/終了時刻、`duration_ms`。
- `publication_execution_blocked`: 残留tokenでconsumerを拒否したこと。
  `reason_code: retained_execution_token`、`authorizes_recovery: false`。
- `publication_delivery`: 配送attemptsと時刻。繰り返し配信をrequestId/traceIdごとに区別する。

`timing_id`は診断用UUIDで、実行tokenではない。本文・タイトル・メール・秘密・実行/registry token・
任意例外本文を構造化ログに含めない。入れ子phaseの時間は重複するため加算しない。
開始だけのphaseは保留/取消の候補だが、sampling・log失敗・保持期限による終了ログ欠落もあり、解放許可にはしない。

### 別環境で採取する情報

1. CLI/Workerのcommitと配備version、job ID、Show/Episode ID、受付・停止のUTC時刻を固定する。
2. `castloop operation-status publication JOB_UUID`と`castloop service-status`で
   state/phase、progress、ownership、execution_active、dead_letter_present、registry残存を読み取り確認する。
   activeは記録上の所有権であり、生存証明ではない。照会失敗も保存する。
3. 同じjobの全attemptのWorkers Logsを取得する。requestId/traceId、platform outcome/例外、CPU/wallと
   開始/終了の`timing_id`を対応付け、最も内側の終了していないphaseを調べる。
4. retryingでexecutionなしの停止と、execution残留を区別する。前者でもDLQはstatusをfailedへ自動変更しない。
   RSS待機はheld＋DLQ履歴を検知すると停止するが、古い履歴の可能性も表示し、解放を案内しない。
5. `.castloop/`、凍結commit/request、owner、registry、stagingを保持する。手動編集・別jobへの置換・再init・
   強制解放・再配備で未知I/Oを隠さない。通常更新も既存のpause/drain・owner確認を迂回しない。

executionなしの同job retryは既存の厳密なowner/manifest/marker検査を維持する。未知応答や残留tokenを
この診断から昇格させて再送しない。実環境の操作・ログ設定変更は今回実施していない。

## ローカル検証と限界

- 音源PUT、catalog、feed世代、published status、Show解放、service解放をそれぞれ保留し、
  開始のみのphaseと適切な残存ownerを検証した。I/O完了後は通常のpublished/releasedへ進む。
- version不一致・owner照合例外・未消費PUT拒否でcancel完了を待ち、開始済みjournal/terminal GETと本文読取も待つ。
- 後処理のR2継続失敗ではtokenを保持し、後続consumerがbusyとして拒否されることを確認した。
- Show/初回Episode/metadata-only/audio-onlyと、古い一致DLQがある稼働中音源PUTでも、releaseはR2・
  journal・Queueを変更しない。CLI/RSS待機も解放・再送へ誘導しない。

mockはruntime強制取消、300MB実転送、Cloudflareの応答本文や制限の再現ではない。
既存の300MB受け入れを無効にせず、今回のストリーム修正を実機合格と呼ばない。

ローカル検証は`bun test` 1021 pass / 0 fail（114 files）、`npm run check`、
`npm run build:cli`のLinux単一CLI/内蔵Worker buildが成功した。Cloudflareへの配備・再送・token解除は未実施。
