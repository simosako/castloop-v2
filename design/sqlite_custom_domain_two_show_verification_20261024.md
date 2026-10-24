# SQLite独自ドメインの2 Show総合実機確認

2026-10-24、Issue #68。管理者から独自ドメインを使う総合実機確認の指示を受け、既存8試行とは別のfresh環境で実施した。**2 Showの小規模総合機能試験は合格**。新しい実装不具合は発見せず、製品コードは変更していない。

## 対象と承認範囲

| 項目 | 対象 |
| --- | --- |
| checkout | `df52fca36d92fdd69e7d89ae483d73f8c4c80c3d`（実行コードは`4fcb398`から不変） |
| Linux単体CLI SHA-256 | `e5ae7af9e647a755637ef2cf5c4662e06d8081b9ccba1befad15e197622d8199` |
| service | `i68r9-b9579ccd` |
| hostname | `castloop-domain68-r9.otftalk.com` |
| Worker | `castloop-i68r9-b9579ccd-86884f15` |
| private R2 bucket | `castloop-i68r9-b9579ccd` |
| SQLite namespace | `c0efe29f337d41dfb0dee816de9eaf38`。initから不変 |
| Show / Episode | `alpha`・`beta`、各1公開Episodeと1ローカル未公開Episode |
| 最終version | `98f229c6-820f-453c-9708-4d612ca90a77` |
| 最終確認 | 2026-10-24 10:33:11 UTC |

同じCloudflare account、active/fullな`otftalk.com` Zoneの未使用専用subdomainを使用した。許可範囲は新規資源作成・初期配備、指定済み短尺素材の公開、個別Pause/Resume、接続と設定/Feed切替、通常更新・review済み非公開化/復元、接続を維持するcode-only deploy、既知接続の切断とworkers.dev復帰。全ShowをPauseして終了する。

`/home/sim/project/castloop-v2/.local-test-data/minimal/`のMP3とJPEGだけをコピーし、新しい試験用metadataを作った。元素材は書き換えず、終了時にhashの一致を確認した。Cloudflareの権限・課金・CPU上限・nameserver、既存環境、非テストDNS、共有証明書は変更対象外。削除/cleanupや旧unknown/残存lockの修復は許可範囲に含めない。

## 結果

| 確認内容 | 実機結果 |
| --- | --- |
| 通常公開の基準 | workers.devでShow 2・Episode 2を公開し、4 jobのsucceededとFeed・画像・音源を確認 |
| domain add | 全対象2 Showのprepare/native/Feed/probe/releaseとlocal completed、設定・接続一致。完了後も両Show paused |
| 正規独自origin | 両ShowのFeed/cover/audio GET、HEAD、音源Range、ETag・日付条件を確認。画像・音源のhashは基準と一致 |
| 旧workers.dev | Feed 301、cover/audio 307をGET/HEADで計12件確認。Locationは同じ公開パスの独自origin、no-store。ダミーquery/認証/Cookie値をLocationへ含めない |
| 公開/管理の分離 | 両originのsystem/staging/内部Feed/未公開音源と、独自originの管理API（無認証・無効ダミー鍵）を計10件確認し404・Locationなし。実管理鍵は独自originへ送らない |
| 個別Pause | alphaだけをPauseすると両originで503。betaは正規originの配信/条件付き応答を継続。alphaだけを明示Resume |
| 停止gate | 前後のPause、個別Pause、配備前、切断前後、最終PauseでGET/HEAD・Range/ETag付き計120件を確認。すべて503/no-store・Locationなし |
| 新configでの通常更新 | alphaのShow titleとEpisode descriptionをmetadata-onlyで明示publishし、2 jobのsucceededを確認。GUID・日時・承認済み音源を維持 |
| 非公開化/復元 | preview/hash確認後に同一Episodeをunpublish/restoreし、2 jobのsucceededを確認。非公開中は独自originの音源404、Feedからitemを除外、旧originの音源も404・転送なし。復元後のrevision/GUID/日時/音源を維持 |
| code-only deploy | 全Show Pause後に通常deploy、既知domainの完全receiptを維持。更新完了・再Resume後も両Showの正規配信とmedia hash一致 |
| domain remove | Feed/設定/Worker/DO/ローカルをworkers.devへ復帰した後だけ正確な既知IDを切断。両Showのremote/local completed、detach_acknowledged true、既知接続null・Cloudflare接続0件 |
| 切断後の配信 | 明示Resume後に両Showのworkers.devから本文・条件付き応答を取得し、GUID・日時・media hashを維持。旧独自originは両ShowともDNS/TLS到達不可（HTTP statusは取得していない） |
| 履歴保持 | 基準の不変Feed 4・cover 2・revision 2、計8 objects / 4,353,240 bytesのhashが切替/更新/lifecycle/配備/切断を通じ不変。新しいmetadata revisionも保持。元公開jobはsucceededのまま照会可能 |

配信一式の検査は基準・切替後・個別Pause中の健全Show・更新/復元後・通常配備後・切断後の計11組。各組でFeed/cover/audioのHEAD/ETagと日付条件を確認し、日付条件33件は304、音源Range11件は206で先頭128 bytesと一致した。Feedの画像・音源URLが各段階の正規originを使うことも照合した。未公開ローカルEpisodeはFeedへ追加されなかった。

## 反映待ちと安全な続行

- addは成功接続を保存したconnectedで`domain_tls_pending`になり、同じ成功receiptから明示continueして完了した。接続PUTは再送しない。
- code-only deployは新versionのnative反映待ちで有限120回の観測後に終了した。保存済み配備を`update-service-verify`で確認し、未開始activation/probeだけを進めてreadyとなった。deployを再実行していない。
- removeはverifiedで2回`domain_rollout_pending`となった。後の読取で正確なversion/configと全対象native readyを確認してから、同じ操作のcontinueで切断・finalizeを完了した。設定/配備PUTを繰り返していない。

これらは成功checkpointからの観測待ちであり、未知mutationを後の存在/不在GETから採用したものではない。CLIには600秒の実行枠を与え、前試行のような120秒の外部強制終了は起こしていない。TLS無効化、OS DNS変更、別APIでの迂回、強制token/lock解放、自動rollbackはしていない。

## 最終状態と保全

最後にalpha・betaをそれぞれ明示Pauseした。最終service状態は**Show 2、paused、drained、publication_ready true、maintenance null、queued 0、active null**。未完了domain操作は0、設定・接続一致、元namespaceを維持している。

前後のDNS/domain/routes一覧は完全一致し、Worker/bucket一覧は今回作成分だけを除くと一致した。以前の8試行は、それぞれ保存済みのversion・paused/drained・ready/保守状態と一致した。元の2試行の4 Showもpausedのまま。未知journal・R5残存lock・原本・証跡は変更/削除していない。既存DBやbucket全objectの完全backupを取得したという意味ではない。

今回のWorker、namespace、bucket内の公開/履歴/運用記録は保持した。Custom Domainと専用DNSは通常の検証済みdomain removeによって切断され、証明書の削除操作や独立したDNS削除は行っていない。

## 証拠と検証の限界

私有証跡はgit-ignoredな`.local-test-data/results/20261024/i68r9-b9579ccd/`。64 CLI操作の送信前記録・stdout/stderr、要求/journal、native/REST、各配信結果、履歴hash、前後一覧、runnerと集計を保存した。秘密・本文・任意例外・未公開操作IDをGitへ追加しない。

369ファイルのSHA-256 manifestを保存後に再照合した。以前のR4〜R8の私有manifestも再検証し、収録済みファイルが不変であることを確認した。

製品コード変更なし。試験runnerは事前にbundle確認した。ローカルの製品回帰は先行修正時の666 tests成功・型検査・Linux CLI buildの記録を引き継ぎ、今回の実機結果とは区別する。文書のみの更新に対する製品テスト再実行は省略した。

**今回証明していないもの**:

- ネイティブの故障注入、未知IOの一般修復、競合操作、purge障害/rate-limit、大量Showやpagination、全負荷/全Free適合、CPU・性能、300MB。
- cache owner内部のhit/missやcold/warmの直接計測。反復取得・条件付き要求とPause優先の結果は保存しているが、内部cache状態の証明にはしない。
- RSS import、audio-only/cover差替の全組合せ、Show自体の非公開/復元、購読アプリ/directoryの移行。301を記憶した購読先が切断だけで自動復帰するという保証は追加しない。

本結果はfresh schema 2 / show-v1・内部6/7の1サービス2 Showによる通常機能確認であり、旧schema/layoutの移行・資源採用・未知操作の修復や旧環境cleanupを承認するものではない。
