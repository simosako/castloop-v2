# M6: 新規Episodeのstaging受付とdraft制御の初期化

更新日: 2026-10-02

## 範囲

内部`claimStageUpload`へ、存在しないEpisodeのgeneration-zero draft初期化を接続した。local `create-episode`がTOMLだけを作る仕様を維持し、最初のmetadataまたはaudio stagingでremote制御を作る。事前にR2へdraft制御を手動投入する必要はない。

通常candidate・公開CLI書込・既存legacy upload経路は変更しない。内部管理APIは既存のservice registry/readiness/version/cache gateを通り、初期化のためにgateを迂回しない。Cloudflare書込・既存環境への適用・M6受け入れ合格はこの変更に含まれない。

## 初期化条件と順序

1. strict upload manifest、Episode ID、期待Episode generation=0を検査する。既存制御はstrictに読み、停止/deleting/deletedや世代不一致を既存受付規則で拒否する。
2. 制御がない場合、Episode単位の公開metadata/history、immutable audio、stagingの3 prefixをそれぞれlimit=1で照会する。既存object・未知key・truncated結果があれば拒否し、既存payloadを採用/削除/上書きしない。prefix末尾の`/`で兄弟IDを区別する。
3. upload manifestとcontrol requestを凍結し、公開中Showの共通CASで`uploading` ownerを取得する。Show全体の他のupload/publication/lifecycleと競合する。genericな`claimShowOperation`は引き続き欠落Episodeを拒否し、検査済みstagingだけが明示optionで欠落generation-zeroの受付を許可する。
4. exact owner/action/kind/Episode/hash/generationとverification token不在を照合する。既にupload progressがあるのに制御がない場合は、破損として拒否し再作成しない。3 prefixをowner取得後にも照会する。
5. `system/episode-lifecycle/<showId>/<episodeId>.toml`へ`If-None-Match: *`でgeneration=0/lifecycle=draftだけを作る。本文・GUID・title/email・secretは複製しない。CAS競合時はstrictな同一initial recordだけを照合し、別状態/tombstoneを上書きしない。
6. ownerを再確認してから既存のready progress作成へ進む。PUT permissionは別の一度限りbegin操作だけが発行する。draft初期化は公開・媒体保存・Queue送信・purgeではない。

Episode generationはstagingで進めず、公開処理が進める。audio-firstにもmetadata-firstにも対応し、後続stagingでは既存draftを保持する。abort後もdraft制御を残し、ID履歴を消さない。

## 中断と競合

初期化PUTの正常/例外終了をawaitする。owner取得後の失敗ではShow ownerを保持し、時間・HEAD不在で解放しない。初期化前後の応答喪失でも、同じ凍結manifestをserverへ明示再提示した場合だけ不足する制御/progressを照合できる。これはdurable clientの`claim_requested`を自動昇格/再送する許可ではなく、既存clientのunknown outcome非再送を維持する。

同一requestの競合は同一draftだけを作れる。別Episode/requestとの競合はShow CASの勝者だけが制御を作る。owner取得後にorphan/tombstone/不明progressを見つけた場合も保持状態を検査し、任意prefix削除や古い制御再初期化で修復しない。

この排他はM6共通受付と、移行時の旧IO収束が成立していることを前提とする。別のlegacy REST writerをCASだけで停止したという保証ではない。

## 検証

unit testでmetadata/audio-first、初期化順序、最小record、一度限りbegin、同request/異request競合、generic actionの欠落拒否、停止Show/tombstone/世代不一致、orphan全prefix、兄弟ID、欠落list/incomplete inventory、不正/過大control、PUT前後応答喪失、late orphan/tombstone、progressだけ残った破損を回帰した。

Episode publication/staging管理fixtureの事前draft投入を除き、内部管理API/client/Queueの既存初回公開テストも実際のstaging初期化経路を通すようにした。mockの合格を実Cloudflareや公開CLI受け入れの合格とはしない。
