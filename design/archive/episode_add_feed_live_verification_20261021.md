# Issue #50: Episode追加中のFeed継続配信の小規模実機確認

## 承認と範囲

ユーザーは実装commit後に、小規模な実環境テストを指示した。commit `62cd198`のLinux単体CLIを使い、新規の隔離サービス1件、Show 1件、10秒・30秒のEpisode各1件を対象とする。保持サービス`sq16r-6ec01dc6`、DNS・証明書・権限・課金・CPU設定は変更しない。

新環境の作成・配備・対象ShowのResume・3件の明示公開（Show＋Episode 2件）と終了時Pauseに限定する。故障注入、未知要求の再送、blocked解除、既存サービスの更新・移行、資源削除は行わない。終了後も環境と私有証跡を保持する。

## 確認方法

1. 正式単体CLIでfresh initし、`feed_storage="immutable-generation-v1"`とShowの初期paused/ready/drainedを確認する。
2. Showを公開した後、各Episodeを別の確認済みstaging素材から明示公開する。音源原本は既存のテスト用clipをコピーし、原本を書き換えない。
3. Episode公開と並行してShow DOのhealthを読み、その前後でFeed、旧ETag条件付きFeed、未公開音源HEAD、cover HEAD、既存音源Rangeを取得する。各IOと公開コマンドの終了を待ち、不明なmutationを再実行しない。
4. **同じ追加jobが前後ともrunningである取得組**を、実行中の旧Feed継続配信の証拠とする。切替を跨ぎ得る取得組はその証拠へ数えない。観測窓を捕捉できなければ未確認と報告する。
5. 成功後は旧ETagへの要求が新本文200となり、item数が増えることを確認する。新音源の全量SHA-256・サイズ、HEAD、Range、304も確認する。
6. private R2の世代別Feed 3件を読み、異なるsnapshotの保持と最新公開Feedとのhash一致を確認する。世代指定の公開URLは404であることを確認する。
7. Showを明示Pauseし、Feed・cover・音源の条件付き要求でも503/no-storeとなること、最終ready/paused/drained、REST/nativeのversion一致を確認する。

## 結果

**小規模な正常系試験は成功した。** 実行区間は2026-10-21 **04:50:59〜04:51:50 UTC（13:50:59〜13:51:50 JST）**。正式CLIの18コマンドはすべてexit 0で、Show公開1件・Episode公開2件の計3 jobが`succeeded`となった。

- 対象commit: `62cd1982359f00409d8d44d21350e27b88f646da`。製品codeの追加変更・故障注入なし。
- Linux単体CLI SHA-256: `2b46a9c4ca5046ff4dbd46660b9ae289b7fec334f968253afe2b7c93b79d84c1`。
- 音源は10秒80,501 bytes、30秒240,579 bytes。公開後の全量SHA-256・サイズはコピー元と一致した。

| 確認 | 実機結果 |
| --- | --- |
| fresh init / Show登録 | 必須Feed形式を確認。新Showはpaused/ready/drained |
| 追加中のFeed | 取得組は計24回。通常GETは全24回200で、503は観測しなかった |
| running中と確定できた取得組 | 1件目追加8回、2件目追加8回、計16回。前後ともrunningの全組で旧FeedのSHA-256・ETagが一致し、旧ETag条件付きFeedは304 |
| 公開前の新音源 | submit前も404。前後ともrunningだった16回のHEADはすべて404 |
| 旧cover / 音源 | running中のcover HEADは16回とも200。2件目追加中の既存音源Rangeは8回とも206 |
| 公開完了後 | 旧ETag付きFeed要求は新本文200へ切り替わり、item数は0→1→2。新音源のGET/HEADは200、Rangeは206、ETag条件付き取得は304 |
| private R2 snapshot | 世代1/2/3の別objectを読取確認。各サイズは1,154 / 1,647 / 2,143 bytesでhashも異なり、最新snapshotと公開Feedのhashが一致 |
| 保存先の直接公開拒否 | `/podcasts/daily/feeds/1.xml`〜`3.xml`はいずれも404 |
| 明示Pause | Feed・cover・音源2件への条件付き要求はすべて503/no-store |
| 終了状態 | ready/paused/drained、queued 0、active null、1 Show / paused_shows 1、maintenance null。RESTとnativeのWorker versionも一致 |

取得区間を跨いでjobが完了した可能性のある残り8回は、running中の旧内容を証明する件数に含めていない。Feedの200が24回という観測を、無制限の可用性保証には読み替えない。

### 終了後の補助読取

正式CLIの別プロセスによる再照会でもready/paused/drainedを確認し、Bun fetchでもFeedの503/no-storeを再確認した。元manifestの52ファイルは保存後SHA-256が一致し、consoleと補助照会の証跡も非公開で追加保持した。

一方、Pause後の補助的なPython urllib GETは403となった。User-Agentを分けて追加確認したところ、Python urllibでも`Bun/1.4.2`なら503、Bun fetchでも`Python-urllib/3.12`ならCloudflareのAccess deniedページを伴う403だった。**User-Agentに依存したCloudflare側の拒否を観測しており、一般クライアントから常に同じstatusになるという確認ではない。** 拒否ルールの特定や設定変更は行っていない。上記の追加中の観測と正式CLI試験はBunの通常User-Agentで行った結果であり、この補助403を隠したりアプリの503へ読み替えたりしない。

## 保持資源と私有証跡

| 種別 | 対象 |
| --- | --- |
| Service | `i50-722e18c3` |
| Worker | `castloop-i50-722e18c3-de6720b4` |
| Private R2 bucket | `castloop-i50-722e18c3` |
| SQLite DO namespace | `9ad96dbecce04c0e8b6fa1547f708a1c` |
| Worker version | `943adeca-569c-44eb-b242-aeaa8aac271c` |
| 公開origin | `https://castloop-i50-722e18c3-de6720b4.simosako.workers.dev`（現在はShow paused） |

workspace、鍵・要求journal、全CLI出力、healthで前後を挟んだ配信観測、音源hash、Feed snapshot 3件、最終REST/native照合とhash manifestは`.local-test-data/results/20261021/i50-722e18c3/`に保持する。秘密鍵・job/操作ID・素材・本文・生ログはGitへ追加しない。資源やローカル原本・証跡を削除せず、今後のResume・追加公開・配備・cleanupは別承認とする。

## 検証の限界

- 小容量・単一Showの正常追加を対象とし、負荷・CPU・300MB・Free適合の試験ではない。
- `blocked`時の旧内容配信は故障注入しないため実機未確認。ローカルの故障・SQL rollback・再生成回帰と区別する。
- 繰り返し取得や世代別R2 objectの保持だけを、実Workers Cachingのhit/miss・全拠点purge・遅い旧fillの完全実証としない。
- 同時実行を含むplatform全invocationの完全捕捉、Issue #13恒久解消や無条件の可用性保証は主張しない。

## 参照

- [設計とローカル検証](episode_add_feed_availability_plan.md)
- [SQLite操作ガイド](../../docs/getting_started.md)
