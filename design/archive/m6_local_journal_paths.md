# M6: local journalの親directoryとlockの安全性

`local-journal-path.ts`をstaging/publication/lifecycle/Show registrationとtarget draft journalへ接続した。workspace root、`.castloop`、family、serviceの既存directoryをlstat検査し、symlink/非directoryを拒否する。新しい親は一段ずつprivate createしてdirectory fsyncし、recursive mkdirでsymlink配下へ書かない。読取も親を再検査し、recordは既存bounded/no-follow readerを使う。

missing親の非書込照会はdirectoryを作らない。broken symlinkもlock存在として観測し、missing journal+retained lockから凍結要求を再作成しない。既存handleもload/lock取得前に親を確認する。

callback終了時は所有descriptorと現在lockのdevice/inode/type/空sizeを照合し、自分のlockだけをunlinkする。callback中に別file/symlink/内容へ差し替えられたり親が変わった場合は、変更されたlockを保持してエラーにする。時間によるlock除去やunknown IOの回復許可ではない。

directory fsyncにもO_DIRECTORY/O_NOFOLLOWを使う。これは静的なsymlinkや観測された差替えへのfail-closed対策であり、悪意ある別local processが検査とsyscallの極短い間へ割り込むTOCTOUを完全排除するdirectory descriptor相対操作ではない。管理workspaceを信頼できるprivate領域に置く必要は残る。

5familyで四つの親階層のsymlink、dangling lock/missing record、既存handle後の親差替え、callback中の他所有lock保持を回帰した。

## 移行journalへの適用

既存flat layoutの`bridge-deployments/<service>.json`、`migration-setups/<service>.json`、`migrations/<bootstrap>.json`も同じ親検査/owned lock返却へ接続した。保存pathや既存frozen requestを変換しない。stat+readFileによる読取は共通bounded/no-follow/regular-file/前後stat検査へ変更し、candidate deployのlock取得にもfile/directory fsyncを追加した。

三layoutの親symlink、record symlink、missing record+dangling lock、他所有lock保持を回帰した。snapshotの親path/cleanup監査、実移行とunknown IOの外部復旧は残る。

## 保存とlock管理の共通化

`local-journal-storage.ts`へ8種類のjournalの初回private create、file fsync、temporary fileからのatomic rename、directory fsync、exclusive lockの取得・返却を集約した。共通層はJSONを保存するだけで、phaseやreceipt、操作の再実行可否を知らない。schema検証、凍結identityの照合、状態遷移、receipt検証は引き続き各journalの責務とする。

保存path、JSON schema、phase、公開journal APIは変更しない。既存recordは初期化で上書きせず、missing record+retained lockも再作成しない。target draftのhistoryは同じprivate create処理を使い、headの切替は取得中のtarget lockに所属するstorageから行う。history identityの再利用禁止と凍結条件はdraft側に残す。

保存失敗時のtemporary fileを自動削除しない従来の挙動も維持する。共通層の検証にはprivate permission、開いた旧recordを変更しないatomic replacement、競合・nested lock、callback/serialization失敗を追加し、既存の操作別回帰テストは削除していない。全833テスト、CLI/試験Workerの型チェック、linux-x64 binary build、standalone read-only operation-status検証が成功した。Cloudflare環境への変更は行っていない。
