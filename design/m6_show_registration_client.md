# M6: Show登録のdurable client journal

更新日: 2026-10-02

## 範囲

内部Show登録clientを、送信前のprivateなローカルjournalと一度限りのrunnerへ接続した。公開`create-show`の切替や通常candidateの書込gate変更は行わない。server側のcontrol-first登録/partial gateは`m6_show_registration.md`参照。

`.castloop/show-registrations/<serviceId>/<showId>.json`を使う。同じShow IDの別reservation IDを別fileへ逃がさず、既存fileのfrozen request/identityを検査して拒否する。保存するのはservice/account/Worker/HTTPS origin、予約request、phase、最小reserved receiptだけであり、Show本文・site URL・メール・secret・source path・任意exceptionは複製しない。

## Phaseと非再送

| phase | 意味 |
| --- | --- |
| `prepared` | ローカルidentity/reservation requestを凍結。HTTP未送信 |
| `reserve_requested` | POSTより前にdurable保存済み。結果不明の可能性がある |
| `registered` | identity/result一致のreserve receiptを受信・保存済み |

`runShowRegistration`はexclusive非期限lockを取り、effectsのservice/account/Worker/originもjournalと一致させる。preparedからrequested保存→一回POST→strictな一致receipt保存の順で進む。registeredでは再送しない。requestedで止まった場合は観測や時間から再送/昇格せず、未知状態を保持する。

POST前の保存失敗ならprepared/未送信を保ち、元の要求による別の明示実行は可能である。POST応答喪失・偽receipt・receipt保存失敗ではrequestedを保持する。serverの明示的同ID補完能力を、このclientの自動retry許可として流用しない。unknown outcomeの外部復旧は別の残件である。

## Private保存と照会

directoryは0700、record/temp/lockは0600。初期fileはexclusive create/file fsync/directory fsyncで保存し、更新は一意temp/file fsync/rename/directory fsyncを使う。identity/request変更、phase飛ばし/後退、receipt変更、不正originを拒否する。全HTTP/保存Promiseが終了するまでlockを保持し、既存lockを削除/期限更新/奪取しない。

読み取りは既存の`readBoundedLocalJournal`によるno-follow/nonblocking regular file/実16KiB上限/前後stat/strict UTF-8を使う。不正/foreign/symlink recordを採用・上書きしない。空workspaceの照会でfileを作らない。

`inspectShowRegistrationOperation`はremote statusを照合し、local stateも読取前後で変わっていないことを検査する。statusからreceiptやphaseを補完せず、POSTのstatus actionもserverではread-onlyである。

source CLI/build binaryのoffline診断へ4番目のfamilyを追加した。

```sh
castloop local-operation-status show-registration SHOW_ID
```

IDはreservation UUIDではなくShow slugである。返す`operation_id`はこの診断引数のShow ID、`client_state.reserve.reservation_id`は凍結reservation UUIDである。認証情報/管理key/legacy state/HTTP/書込を使わず、lock観測と`remote_state_checked=false`、変更/復旧許可falseを維持する。released v0.1.2 binaryには含まれない。

## 検証と残件

local disk→内部client→M6 Show登録handlerの結合で、送信前requested保存/private permission、正常receipt、HTTP応答喪失、POST前/receipt保存失敗、偽receipt、foreign effects/request、phase飛ばし/後退、稼働/残存lock、read-only remote/offline照会、不正/symlink file保持とsource CLIのcredential不要・file不変を回帰した。

全716テスト/11442 assertions、TypeScript/M6実証tsconfig、candidate/bridge browser bundle、内部runner Bun bundle、Linux単一バイナリbuildに合格した。standalone binaryでもcredentialsなしでrequested状態とepoch日時の古いlockを照会し、全fileのbytes/mtime不変・lock保持・変更/復旧許可falseを確認した。Cloudflareへの書込/deployは行っていない。

公開`create-show`のTOML/既存local state連携、unknown outcomeの明示的な外部復旧、実Cloudflare/次version受け入れは未完了である。記録されたregistered phaseもM6全体のreadinessやShow公開完了を意味しない。
