# M6: local journalの親directoryとlockの安全性

`local-journal-path.ts`をstaging/publication/lifecycle/Show registrationとtarget draft journalへ接続した。workspace root、`.castloop`、family、serviceの既存directoryをlstat検査し、symlink/非directoryを拒否する。新しい親は一段ずつprivate createしてdirectory fsyncし、recursive mkdirでsymlink配下へ書かない。読取も親を再検査し、recordは既存bounded/no-follow readerを使う。

missing親の非書込照会はdirectoryを作らない。broken symlinkもlock存在として観測し、missing journal+retained lockから凍結要求を再作成しない。既存handleもload/lock取得前に親を確認する。

callback終了時は所有descriptorと現在lockのdevice/inode/type/空sizeを照合し、自分のlockだけをunlinkする。callback中に別file/symlink/内容へ差し替えられたり親が変わった場合は、変更されたlockを保持してエラーにする。時間によるlock除去やunknown IOの回復許可ではない。

directory fsyncにもO_DIRECTORY/O_NOFOLLOWを使う。これは静的なsymlinkや観測された差替えへのfail-closed対策であり、悪意ある別local processが検査とsyscallの極短い間へ割り込むTOCTOUを完全排除するdirectory descriptor相対操作ではない。管理workspaceを信頼できるprivate領域に置く必要は残る。

5familyで四つの親階層のsymlink、dangling lock/missing record、既存handle後の親差替え、callback中の他所有lock保持を回帰した。

## 移行journalへの適用

既存flat layoutの`bridge-deployments/<service>.json`、`migration-setups/<service>.json`、`migrations/<bootstrap>.json`も同じ親検査/owned lock返却へ接続した。保存pathや既存frozen requestを変換しない。stat+readFileによる読取は共通bounded/no-follow/regular-file/前後stat検査へ変更し、candidate deployのlock取得にもfile/directory fsyncを追加した。

三layoutの親symlink、record symlink、missing record+dangling lock、他所有lock保持を回帰した。snapshotの親path/cleanup監査、実移行とunknown IOの外部復旧は残る。
