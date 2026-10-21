# Episode更新中のFeed継続配信・小規模実機確認（2026-10-21）

## 結論と対象

**新規隔離環境の正常系試験は成功した。** 1 Show・2短尺Episodeを公開した後、同じEpisodeへmetadata-only、audio-only、metadata/audio同時更新を順に実行した。3種類すべてで更新中の旧Feed配信を観測し、完了後の新Feed切替・音源検証・最終Pauseを確認した。

[承認済み設計](../episode_update_feed_availability_plan.md)の実装・ローカル試験成功後に、小規模実機確認を行うユーザーの承認に基づく。既存保持サービス、DNS・証明書・権限・課金・CPU上限は変更せず、削除・移行・fault injectionも行っていない。

## 実行物とローカル検証

- 基点commit: `62cd1982359f00409d8d44d21350e27b88f646da`。今回の変更は未commitの作業ツリーから構築した。
- 単体CLI: `dist/castloop-linux-x64`。
- CLI SHA-256: `4dc78f26f4c7a7a31cf5619b0238bb4dbd7c091a9e6432406ae9b0ccbb7fcb4b`。
- production source 7ファイルのhash、実装・テスト差分、ローカル試験ログを私有証跡に保存した。
- `bun test`: **511 pass / 0 fail、62 files、59.57秒**。
- `npm run check`、`npm run build:cli -- linux-x64`、`git diff --check`成功。
- 内部queue/content schema **4/5**、healthの`feed_storage="immutable-generation-v1"`と`publication_read_boundary="episode-revision-v1"`を確認した。

ローカルでは実executorとBun SQLite・模擬R2/cacheを接続し、公開段階の待機・候補保存応答不明・purge失敗・完了transaction rollback・再生成・guard破損・旧media破損・検証前中断等を確認した。これらの故障試験と、以下のnative正常系試験を区別する。

## 方法と観測結果

操作は単体CLIで行い、health/inspection、public配信、private snapshotの照合は読み取りで実施した。10秒・30秒の既存派生MP3（80,501 / 240,579 bytes）と既存画像のコピーを使い、原本は変更しなかった。公開はShow 1件、Episode初回2件、更新3件の**計6 job**で、すべて`succeeded`となった。

各更新では、直前のFeed本文hash・ETagと対象baseを取得し、公開CLIと並行して次を観測した。

1. 対象Showのhealthを取得する。
2. Feed GET、旧ETagによる条件付きFeed GET、新候補音源HEAD、旧音源Range、cover HEAD、別Episode音源HEADを並列取得する。
3. healthをもう一度取得する。

前後ともactive=`running`だった取得組だけを、実行中の確認として数えた。同Showには一度に一つの公開だけを投入している。

| 更新 | 全取得組 | 前後ともrunningの取得組 |
| --- | ---: | ---: |
| metadata-only | 7 | 2 |
| audio-only | 10 | 8 |
| metadata/audio同時 | 8 | 6 |
| 合計 | **25** | **16** |

- 全25組の通常Feed GETは**200**。旧音源Rangeは206、coverと別Episode音源HEADは200だった。
- 実行中と判定できる16組では、旧Feedの本文hash・ETagが不変で、条件付きFeedは**304**、候補音源HEADは**404**だった。
- 各更新完了後、旧ETagへのFeed応答は新本文200となり、hashが変化した。Episode件数は2件を維持し、inspectionのbaseは正確なjob IDへ進んだ。
- metadata-onlyは同じ音源URLを参照し、新job IDの音源URLは完了後も404だった。その次のaudio-onlyにより、metadata revisionと音源revisionが異なるbaseからの更新も確認した。
- 音源を含む更新では、新Feedが新job IDの音源を参照した。各更新後に、保持された全音源を全量GETで原本のhash/sizeと照合し、Range bytes・条件付き304も確認した。旧音源は削除・上書きされなかった。
- 6世代のprivate Feed snapshotをREST GETで保存した。snapshot整理・固定Feed keyへのコピーは行っていない。
- 終了時に明示Pauseし、Feed・cover・全旧新音源の503/no-storeを確認した。最終native healthとRESTのWorker versionは一致した。

前後のどちらかがrunningではなかった9組は、実行中の証明には数えていない。観測間隔より短い時間帯を含む、全要求の完全な無停止を証明するものでもない。

## 試験スクリプトの停止と明示続行

初回は`create-show`がexit 0で成功し、作成した`show.toml`のパスを出力した後、試験スクリプトがそれをJSONとしてparseして停止した。製品側の初期化・Show登録失敗ではなく、試験側の出力形式の扱いの誤りだった。その時点ではShowは未公開・pausedだった。

成功応答・正確な出力先・凍結artifact hash・対象configと、nativeのready/paused/drained・draft状態を読取照合し、**init/create-showを再送せず**、未実行の素材準備・Resume以降だけを明示続行した。初回・続行それぞれのrunnerと開始・停止・照合記録を保存している。製品コードや公開済みの資源を修正・再配備したものではない。計22 CLI操作はすべてexit 0で、同じmutationの再送はなかった。

## 保持資源と証跡

| 項目 | 最終状態・識別 |
| --- | --- |
| サービス | `eupd-a8a0a55a` |
| Worker | `castloop-eupd-a8a0a55a-94c6d788` |
| private R2 bucket | `castloop-eupd-a8a0a55a` |
| SQLite DO namespace | `b243c93514c34ecb810845046f0f569e` |
| Worker version | `a6fb87bd-c490-42cb-97c4-6b71feaad3da` |
| 完了時刻 | 2026-10-21 05:23:01.950 UTC（14:23:01.950 JST） |
| native状態 | ready / paused / drained、queued 0、active null、1 Show paused、maintenance null |
| 保持方針 | Worker/bucket/namespace、全音源・Feed・journal・証跡を保持。自動Resume・削除なし |

私有証跡はgit-ignoredな`.local-test-data/results/20261021/eupd-a8a0a55a/`へ保存した。CLI要求前記録と結果、health/inspection、前後の配信結果、6 snapshot、artifact hash、差分・試験ログ、最終REST/native照合を含む。元のmanifest対象**70ファイル**のSHA-256は保存後に再照合した。鍵・未公開job ID・本文・raw応答をGitへ追加しない。

manifestはトップレベルの保存ファイルが対象で、workspace内の全journalやSQLite DBの完全backupではない。既存保持サービス`sq16r-6ec01dc6`、第1段階試験環境、原本・過去証跡は変更しなかった。

終了後の独立した読取でもShowのready/paused/drainedと6公開アセットの503/no-storeを再確認した。CLI binaryとproduction sourceのhashは実行時と不変だった。補助照合・consoleログ等を加えた77ファイルの最終hash一覧も別保存した（一覧自身を除く）。

## 未確認の範囲

- nativeでのblocked故障注入、Alarm再配送・process中断、SQL rollbackは未試験。ローカル故障回帰とは区別する。
- 実Workers Cachingの全hit/miss・全拠点purgeの完了、CPU/負荷、大容量300MBの確認ではない。通常経路でpurgeを含むjob完了を確認した範囲に限る。
- 通常のBun/CLIクライアントで確認した。全User-Agent・全クライアントのCloudflare側アクセス制限は調査していない。
- Show metadata/cover更新の継続配信は未実装。非公開化・復元・Pause等の停止gateは維持する。
- Free適合、Issue #13恒久解消、一般的な性能・将来負荷・完全な無停止を保証しない。
