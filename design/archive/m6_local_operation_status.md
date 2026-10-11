# M6: 認証情報不要の読み取り専用local operation診断

更新日: 2026-10-02

現行source buildに`castloop local-operation-status FAMILY ID`を追加した。service workspaceの`castloop.toml`とlocal M6 journalだけを読み、Cloudflareや管理HTTPへ接続しない。既存Release binaryにはまだ含めない。書込・破壊的commandの公開gateは変更しない。

```sh
castloop local-operation-status staging UPLOAD_OPERATION_ID
castloop local-operation-status publication DRAFT_JOB_ID
castloop local-operation-status lifecycle LIFECYCLE_JOB_ID
castloop local-operation-status show-registration SHOW_ID
```

- FAMILYは`staging/publication/lifecycle/show-registration`。stagingはupload操作ID、publication/lifecycleはjob ID、show-registrationはShow slugを使う。ID・対象service/account/Worker/origin、strict schema、phase/receipt/hashを検証する。未知flag/余分な引数/不正IDを拒否する。
- 出力は既存のminimalなclient journalとlock観測、`remote_state_checked=false`、`authorizes_mutation=false`、`authorizes_recovery=false`。本文/source path/secretやlegacy stateを読み込まない。journal欠落は`client_state=null`であり、remote不在・完了・所有権解放を意味しない。
- local lockを作成・削除・期限更新せず、残存lockをそのまま報告する。lock不在からconsumer/PUT/tokenの終了を推定しない。client phaseを変更・昇格せず、POST/Queue送信/再PUTをしない。
- 4familyのjournal readに共通のno-follow/nonblocking open、regular file、16KiB以下の実read上限、前後stat、strict UTF-8を要求する。symlink/非file/過大/途中変更/不正recordは採用せず、診断commandは固定errorだけを表示し、recordを上書きしない。
- 複数recordやremote stateの原子的snapshotではない。成功したlocal診断も再試行・復旧・M6 readinessの許可には使わない。未知応答・残存lock/tokenの安全な外部復旧は未提供である。

source CLIの4family、空workspace非書込、secret/legacy state非読込、残存lock保持、不正record/foreign/過大/引数拒否、no-follow/strict UTF-8を回帰した。Linux x86-64 standalone binaryでもcredentialsなしのjournal/残存lock読取、全file不変、help/versionを確認した。show-registrationについてもrequested状態とepoch日時の古いlockを読み、bytes/mtime不変・lock保持・変更/復旧許可falseを確認した。Cloudflare実機合格やM6書込commandの公開合格ではない。
