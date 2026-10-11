# M6: generation/current/baseの読み取り専用契約

未公開`POST /admin/target`は`schema_version=1`、service ID、kind、Show IDとEpisodeだけEpisode IDを受ける。job IDや期待generationを事前に知る必要はない。`TargetInspectionClient`は固定HTTPS origin/no redirects/一回限り送信/strict応答とexact target照合を行う。

認証、16KB bounded request、M6 readiness/version/cache ownerとservice/config snapshotの前後一致を必須にする。service token取得・制御record初期化・受付・payload書込・Queue送信は行わない。paused serviceも読めるが、新規mutationの許可にはならない。通常candidateには公開せず、内部`fetchM6ManagementIntegration`だけへ接続した。

応答はShow/Episodeのlifecycle/generation、unfinished Show operationの有無、Episodeのcurrent revisionと三つの固定flag（snapshot_only=true、authorizes_operation=false、payloads_verified=false）を返す。owner/execution tokenや任意exceptionは返さない。現在のmediaを全量検証せず、cache purgeや旧IOの終了も証明しない。

- active/unpublished Episodeではcurrent metadataとimmutable historyを各1MB以内でparseし、exact内容/対象IDと読取前後ETag/sizeを照合する。
- unfinished Show ownerがある場合はcurrent revisionを読まず、再利用できるbaseを返さない。
- draft/missing Episodeのorphan current metadata、部分Show登録、missing/異なるhistoryはfail closed。
- deleted/deleting Episodeからbase payloadを返さない。
- TOML本文を含むcurrent revisionは認証応答内だけに扱い、operational journal/logへコピーしない。target responseは2MBに制限し、他の管理応答の64KiB上限は維持する。

これは原子的なremote snapshotではない。期待generation/current/baseは後のmutation側で再照合する。statusからlocal requested phaseを進めたり、lock/tokenを返したり、新しいjobへ差し替えたりしない。

CLI更新/公開のsnapshot取得とtarget draft初期化/rotationへの接続、公開書込command、移行/復旧・実Cloudflare受け入れは残る。
