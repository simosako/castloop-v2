# SQLite独自ドメインの初回実機確認・停止記録（2026-10-24）

## 結論

**受け入れ未完了。接続PUT後の成功receipt検証で停止し、後続mutationは行っていない。** 新規隔離環境の初期化、2 Show・各1 Episodeの公開と通常配信、個別Pause/drainまでは成功した。接続後の読取一覧では40文字のWorker domain IDが見えたが、実装が32桁に限定していた。元PUTの成功receiptは保存されていないため、そのGETを接続完了の証拠として採用していない。

停止後はstatus/list/health・REST一覧・公開GET/HEADのみで状態を保全した。接続の再送・採用、設定切替、Worker再配備、activation、切断、Resume、保守拘束の解除、資源削除は行っていない。**全Showはpaused/drained、保守はpreparedのまま、publication_readyはfalse**である。正常終了のready/paused/drainedとは区別する。

## 承認と対象

管理者は、これまでと同じCloudflare accountで新規の`*.otftalk.com`専用subdomainと隔離環境を作り、指定素材の利用、新規作成・配備・公開・各ShowのPause/Resume・domain接続/切断を承認した。終了時は全ShowをPauseする。既存環境・他用途DNS・原本・証跡の変更やcleanup、証明書削除、権限・課金・CPU上限変更は含まない。

| 項目 | 対象・最終状態 |
| --- | --- |
| service | `i68-994770e0` |
| Worker | `castloop-i68-994770e0-6b550405` |
| private R2 bucket | `castloop-i68-994770e0` |
| SQLite namespace | `b01619981767432c8a8c6324a13d1924` |
| Worker version | `7f0e2433-c338-4655-a607-366954667de4`（initから不変） |
| 専用hostname | `castloop-domain68.otftalk.com` |
| 正規origin | workers.devのまま。独自originへの設定切替なし |
| 接続 | REST一覧には対象Workerへの1件と管理AAAA recordが見える。ローカルは`connection_requested`、成功receiptなし |
| Show | `alpha` / `beta`ともpaused/drained、active null、queued 0、setup ready、domain保守拘束あり |
| 最終読取照合 | 2026-10-24 03:59:29 UTC |

## 実行物と修正

1. `675d83e`から構築したLinux CLIでfresh initが成功した。その後の読取preflightで、空のWorker domain一覧の`errors: null`、`per_page: 0`、`total_pages`省略を受け付けず停止した。初期化journalはreadyであり、initを再送しなかった。
2. `4332cfe`で成功envelopeの空errors表現と単一page一覧を修正した。count/total_count一致、`success: true`、非空errors拒否を維持し、DNS全ページの厳密な検証は緩めていない。**633 tests成功**、型検査・Linux CLI build成功後、読取preflightだけを再確認した。
3. 同CLIで2 ShowとEpisodeを公開し、Pause/drain後に専用UUIDでdomain addを1回だけ実行した。prepareが完了した後、接続成功receiptを保存できず`connection_requested`で停止した。
4. 読取一覧では、公開仕様でstringとされているWorker domain IDが40文字だった。共有receipt schemaとREST一覧parserの32桁固定は不適切な制限だった。PUTの生応答は保存しておらず、その全内容や停止原因をGETだけから復元できたとは扱わない。
5. `806be31`でdomain IDを長さ1〜256の英数字・`_`・`-`からなるopaque path segmentとして保持し、GET/DELETEのURL encodeを追加した。account/Zone/namespaceの32桁制限は維持した。模擬RESTの発行IDも40文字にしてadd/remove/通常deploy/CLI回帰を実行した。未知接続の続行・採用を許す変更はしていない。

ID修正後は635 tests、さらに「不正な成功receiptを後の正常GETから復元・採用しない」回帰を追加した最終ローカル検証は**636 pass / 0 fail、76 files、79.88秒**。`npm run check`、`npm run build:cli -- linux-x64`、`git diff --check`成功。最終Linux CLI SHA-256は`77097f3a69c4865ab8bcb3a3a70bca9264e8bbe694595f9c264d97677e80af5b`。最終CLIはこの環境に対する読取確認だけに使用し、修正版Workerは配備していない。

## 確認できたこと

- retained環境のローカルconfigと同じaccount、active/fullな`otftalk.com` Zone、専用hostnameの未使用、Worker routesなしを確認してから作成した。
- 内部queue/content 6/7に対応する新規Worker/SQLite DOのnative setupを完了し、Feed世代予約・domain能力識別をhealthで確認した。
- 各Showの初回公開とEpisode公開の**計4 jobがsucceeded**。承認されたminimal素材の80,501 bytes MP3とJPEGをコピーして使用し、原本は変更していない。別の未公開Episodeも各Showにローカル作成したが、upload/publishしていない。
- 両ShowでFeed/cover/audioのGET 200、Feed/coverのHEAD 200・ETag条件304、audioのHEAD 200・Range 206（先頭128 bytes一致）・ETag条件304を確認し、全量audio hash/sizeを素材と照合した。Feed本文、GUID/日時、inspectionを切替前の基準値として私有保存した。
- `system/`・`staging/`・内部Feed世代URLを404で拒否した。
- 接続前に各Showを明示Pauseし、Feed/cover/audioのGET/HEAD（条件付きheaderとRange付き）が503/no-storeとなった。停止後のworkers.devでも同じ拒否を再確認した。
- 停止後、独自hostnameは通常のTLS検証を有効にしたBun GETで到達し、未設定originとしてFeed/cover/audioを404/no-storeで拒否した。**正規独自domainの配信成功やCLIのTLS checkpoint完了とは異なる**。
- 最終`domain status`はremote prepared・対象2・prepared 2・completed/released 0。`domain list`は設定一致だが接続不一致と未完了ローカル操作を報告した。未知結果を隠していない。
- 前後のREST一覧から新規対象だけを除き、既存DNS全8件・Worker metadata・bucket一覧・routesが一致した。既存bucketの全object hashや全DB状態まで検証したという意味ではない。

## 試験補助コードの停止・欠測

製品のAPI応答検証問題とは別に、補助runnerが`--workspace`指定時のEpisode操作へ`--show`を付けず、CLIが`missing_show / not_started`として拒否した。成功済みShow公開の応答とinspectionを照合し、成功操作を再送せず、引数を修正して未開始のEpisode操作以降へ進んだ。

最終読取runnerも、まだ正規originへ設定していない独自hostnameに503を期待して止まった。期待値をunknown-originの404に修正し、読取確認だけを完了した。別途Python/urllibのGETでは両originにCloudflare側403が返り、通常Bunのworkers.dev 503・独自origin 404と異なった。このUser-Agent等による差異は未調査であり、アプリの拒否応答の代わりに403を合格証拠として数えない。

## 証跡・未実施・次の境界

私有証跡はgit-ignoredな`.local-test-data/results/20261024/i68-994770e0/`に保持する。要求前記録・全CLI応答、stage停止理由、artifact hash、素材/配信hash、Feed基準値、native status/inspection、前後の資源一覧、runnerとローカル試験ログを含む。鍵・未公開ID・本文・生HTTPをGitへ追加しない。workspace/journal/原本は削除せず、214ファイルのSHA-256 manifestを保存後に再照合した。manifestは証跡の改変検出用で完全なDB backupではない。

未実施は正規独自originへの設定/配備/Feed切替、301/307、独自originでの管理API拒否・通常publish/lifecycle/RSS、接続維持deploy、切断とworkers.dev復帰。保存された301を持つアプリの挙動、native故障注入、全cache hit/miss、全拠点purge、CPU/負荷・300MB・全Free適合も証明していない。tail/保存ログを収集した実験ではない。

この環境の現在値を元PUTの成功receiptへ昇格したり、journalを書き換えたり、別IDで同じ接続をやり直したりしない。保守拘束・接続・DNSは保持する。別の未使用hostnameとfresh環境での再試験や、この停止環境の廃棄は対象・範囲を別途確認してから行う。この記録は後続mutationやcleanupの承認ではない。
