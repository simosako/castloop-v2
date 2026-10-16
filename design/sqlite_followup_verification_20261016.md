# SQLite開発版の観測改善と追加受け入れ

2026-10-16。管理者から、観測・運用面の改善を先に開発し、その後、正式RSS公開・互換更新等の追加確認へ進むよう指示された。
完了済み60件の公開試験と、旧blocked環境を再実行する計画ではない。

## 1. Git管理する試験部品

素材・鍵・実サービス設定・raw証跡・個別launcherは引き続き`.local-test-data/`だけに置く。
共通ロジックと架空の入力による回帰テストを`scripts/test-support/`へ切り出す。

- `trial-read.ts`: GET専用。接続・本文読取の一時失敗と408/429/500/502/503/504だけ最大3回。
  1 attempt最大10秒、backoff込みの全体30秒以内で新しいGETを開始する。進行中IOのsettlementを待ち、PUT/POST/CLIを再実行しない。
  認証拒否・404・部分応答・ETag欠落・size不一致・cleanup失敗は停止する。
  診断は固定reason、HTTP status、回数、経過時間、対象URLのhashだけ。任意exception・URL・header・本文を出さない。
  読み直した可変objectは新しいsnapshotであり、呼出側のidentity/base検証を省略しない。
- `sqlite-observability.ts`: native traceをallowlistで保存。
  空のcanceled DO Alarm、または正確なjob status GET/200だけを「照合待ち」に分ける。
  次のmutation前にservice/config/version/admission window、ready/drained、正確なjob/request/hash/succeededを読取照合する。
  canceled POST、例外、truncation、未知の失敗、終端purge失敗は停止する。取消しを公開成功や再送許可とは扱わない。
- `sqlite-tail.ts`: socket/remote tailのhealthとnative outcomeを別々に監視。
  `X-Castloop-Probe`、外側HTTP、正確なWorker version、数値CPUの一致だけをprobeのCPU証跡にする。
  cache/DO HTTP、異なるversion、0ではなく未取得のCPU、重複identityで欠測を埋めない。
- coverageはprobe CPUとjobの開始/完了ログを列挙する。
  同時status traceにjobログがあっても、そのCPUをAlarm全体のCPUにしない。
  機能成功と測定欠測を分離し、supervisor通知にも`measurement: incomplete`を明示する。

元の観測停止のネットワーク原因や、reader.cancelがCloudflareのcanceled outcomeを起こしたという因果関係は未証明。
完全読了した本文へ不要なcancelは行わないが、これだけで原因解消とは主張しない。

開発後の全自動テストは**1,378件成功 / 0失敗（149 files）**。TypeScriptチェック、Linux単体CLIのbuildも成功。
追加回帰はGETの有限retry/総予算/IO終了/秘密非出力、取消し後のmutation禁止と正確な照合、
終端purge失敗、CPU/jobログ欠測とversion・entrypoint混同の防止、通知での欠測/timeout表示を対象とする。
実機runnerの接続時に、圧縮応答のContent-Lengthをdecoded bytesと誤比較しないことと、
完了済み互換更新の正確なoperation/new versionを含む照合を追加した。共通試験部品の56件も成功した。
この段階ではCloudflareの変更はまだ行っていない。

## 2. 実機確認の順序・境界

実行前に対象と範囲を固定する。旧`sq16-668cbdfa`、旧方式の保持環境は変更しない。
新しい資源・namespace・bucketの作成、削除、force release、migration、domain、権限・課金・CPU制限変更は行わない。
管理者は追加確認に対し、**既存の隔離サービス`sq16r-6ec01dc6`だけで、互換更新1回→新window→小容量3件のRSS公開→pause**を明示承認した。
通常規模36件の再実行や大容量転送を含む許可ではない。

1. 完了済み隔離サービスについて、同じversion/config/namespaceとready/paused/drainedをGETで照合し、R2 inventoryと公開記録を保存する。
2. 正式バイナリの`deploy --operation-id UUID`で同一config/schema/namespaceの更新を一度だけ行う。
   prepared/deploy/activation不明なら停止し、未知要求は再送しない。native Alarm/R2/cache/purge probe後、pausedのまま確認する。
3. 明示的な新windowでresumeし、保存済み小容量MP3から作った3件のローカルRSS取り込みを、正式`publish-rss-import`で新しいShowへ公開する。
   ローカル取り込み準備とCloudflare公開の試験範囲を分け、元の1.5GB音源は再転送しない。
   GUID/permalink/日時、feed件数、内部音源、GET/HEAD/Range、既存Show・media inventoryの不変を照合する。
4. 完了後はpauseし、ready/paused/drained、feed503、監視終了・通知受付を確認する。

300,000,000 bytes境界は既存受け入れと新経路の回帰を先に確認する。
大容量の実機再転送やpurge rate limitを意図的に発生させる負荷試験は、上の小容量試験と混同せず、必要性と追加範囲を判断する。
実機purge retryは未観測のままなら明記し、模擬negative acknowledgment試験を実機証明に置き換えない。

長時間試験はtmux内のsupervisorから起動する。新しい証跡ディレクトリと一度限りのlaunch markerを使い、古いrunnerや完了要求を再起動しない。
成功通知は次のresume・追加試験・削除の許可ではない。

## 互換更新の初回停止と修正

`4d6effc`の実機runnerは11:12:50 UTC、公開0件、互換更新のnative version照合で停止した。
証跡は`.local-test-data/results/20261016/sqlite-followup-8bdcc47f/`。
準備と1回の配備は応答確認済み、journalは`verified`。新配備は`8ace6fc5-aa21-49f5-ac88-f9d3c50ef82e`、
deploymentは`1d87471a-8c9b-4720-a7e6-08f82f882152`。namespaceとsource/ETagは元と同じ。
activationはまだ要求しておらず、resume・RSS登録/転送/公開も未開始。

11:13:45のGET-only照合ではRESTは新version、DOは旧`7be73256-30a7-4261-b0d8-9a6b39d695a6`だった。
DOの同じ更新要求はprepared、ready=false/paused/drained、active=null/queued=0。
Cloudflare文書は、WorkerとDOのcode更新がeventually consistentで、秒〜分のversion差があり得るとする。
この観測は即時一致を前提としたCLIの不足を示すが、伝播完了までの時間・原因の全てを確定したものではない。

CLIは、完全に一致するprepared要求の旧versionだけを最大120回GETで観測するよう修正した。
未確認応答や別versionを採用せず、timeout後もverifiedを保持する。
正式`update-service-verify`はそのexact verified journalと不変source/config/metadata/receipt/namespaceからのみ、
新native versionを照合して未要求のactivationを1回だけ行う。既知の配備を再送せず、未知activationの再実行も行わない。
`update-service-reconcile`は従来どおりGET-onlyである。

修正後は**1,383件成功 / 0失敗（149 files、91.37秒）**、型検査・単体CLI buildが成功。
11:19:26の追加GET-only照合で、DOも記録済み新versionを返し、同じprepared/paused/drained状態を保持していた。
伝播時刻は旧versionを観測した11:13:45と、この確認の間であり、正確な所要時間は測定していない。
継続は同じ更新の初回activationと未開始のRSS公開だけで、新しい配備は行わない。

### 初回activation完了後の観測停止

`20c2a43`の正式`update-service-verify`は、11:22:06 UTCにexit 0 / readyで完了した。
同じ配備・namespaceに対する初回activationとnative Alarm/R2/cache/purge probeであり、再配備はない。
証跡は`.local-test-data/results/20261016/sqlite-followup-b2180705/`。

その後、監視側のframe schema不具合で、RSSを始める前に停止した。
生成済みplatform型の`TraceItemAlarmEventInfo.scheduledTime`は`Date`であり、JSONでは日時文字列になる。
新collectorは数値だけを許しており、この正規形式に対応していなかった。native 19 framesに対し保存18 rowsで1件が欠けた。
raw frameを保存していないため、欠けた1件の値やCPUは復元できない。

collectorをJSON日時文字列/数値へ対応させ、拒否時にはallowlisted field名と固定reasonだけを保存するよう修正した。
null eventはHTTPに分類しない。採取拒否件数・最初の診断と総frame/保存row数も保持する。
coverage集計へcollectorの完全性を必須入力とし、採取失敗があるのに`measurement: complete`とする不具合も修正した。
古いrun-resultのcomplete表示はこの誤判定であり、原記録を書き換えず、本節で欠測と明示する。
修正後の全自動テストは**1,385件成功 / 0失敗（149 files、90.42秒）**。共通試験部品58件、型検査とprivate runnerの型検査も成功した。

完了済みupdate/activation/probeは繰り返さない。次はready/paused/drainedをGET-onlyで照合し、未開始のresume・RSS公開だけを実行する。

## 最終結果（2026-10-17 JST追記）

残るRSS確認は`.local-test-data/results/20261016/sqlite-followup-d2bfc94b/`で通過した。
UTC 2026-10-16 22:05:27開始、22:06:07にsupervisor exit 0 / notification acknowledgedで終了。
最初に同じ更新のready/paused/drained、receipt/version/config/namespaceと旧R2 inventoryをGET-onlyで再照合し、
`update-service-reconcile`だけを使った。deploy・activation・probeは繰り返していない。

- 正式`publish-rss-import`で新Show`rss-8bdcc47f`と小容量3 Episode、計**4 jobすべてsucceeded**。
  CLI全体22.277秒。元の1.5GB音源は転送せず、MP3 uploadは合計**801,568 bytes**。
  ローカルRSS準備は保存済みfixture transportで行っており、公開インターネットからの取得試験ではない。
- GUID、`isPermaLink`のtrue/false、公開日時、metadata、内部音源URL、全量音源hash/sizeを確認。
  各音源のGET/HEAD/Range/ETag条件付き304、feed3件と既存36件feedのbyte不変を確認した。
- 新規RSSの登録前から存在した**233 objectsすべてkey/ETag/size不変**。
  bucket snapshotは253 objects / **24,869,390 bytes**。削除、強制解放、新規資源や権限・課金変更はない。
- 最終状態は`publication_ready=true / paused / drained=true / active=null / queued=0`。
  update/setupは同じoperationでcompleted/ready、新RSS feedは503。全ローカル試験プロセスが終了した。

### CPU・ログの取得範囲

最終runnerはnative 64 framesを64 rowsとして保存し、**schema拒否0、採取faultなし**。
ただしsocket/collector正常は全要求の配送保証ではない。

| 種別 | 採取件数 | CPU最大 |
| --- | ---: | ---: |
| 外側HTTP | 54 | 2 ms |
| cache owner HTTP | 6 | 2 ms |
| cache RPC | 4 | 1 ms |

公開probe **19件中15件**だけCPU identityを捕捉した。最後のRange/条件付きGET、既存feed再確認、paused feed確認の計4件が欠測。
DO/Alarm frameは0件、4 jobの開始・完了ログも欠けた。unknown logを捨てて欠けたのではなく、保存64 framesにこれらのDOイベントが含まれなかった。
配送・sampling・tail有効化の伝播・終了時の遅延のどれが原因かは確定していない。
`run-result`・supervisor・通知は正しく**機能passed / measurement incomplete**とした。
元の欠測を後日の別GETで埋めず、CPU値も推定しない。HTTP最大2msをDO/Alarm全体CPUや全Free適合の証明にはしない。

### 今回完了した範囲と残る確認

共通観測部品の開発・回帰、正式CLIの互換更新と新RSS公開の実機確認は完了。
新方式でも300,000,001 bytesの入力をPUT前に拒否する自動回帰を確認したが、**300,000,000 bytesの新経路実機公開は行っていない**。
実機のpurge rate-limit negative acknowledgment/retry、完全なDO/Alarm CPU採取、恒久的なIssue #13解消・release readinessは未確認。
追加の負荷試験や大容量転送、resume、再配備・再activation、cleanup等はこの完了通知から開始しない。

集計はprivate `followup-summary.json`。素材・raw証跡・鍵・local journalはGitへ追加していない。

参照：[Durable Objects known issues — code updates](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates)。

## 関連

- [先行実機試験と欠測](sqlite_sequential_measurement_20261016.md)
- [通知とR2読取診断](trial_notifications_and_r2_read_diagnostics.md)
- [SQLite開発版の操作](../docs/sqlite_sequential_development.md)
