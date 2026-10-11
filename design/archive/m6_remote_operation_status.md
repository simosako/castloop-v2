# M6: 非書込remote operation診断CLI

更新日: 2026-10-02

## 範囲と前提

source CLI/build binaryへ`castloop operation-status FAMILY ID`を追加した。service workspaceのstrictなローカルM6 journalから凍結要求を読み、対応する管理APIの`action=status`だけを一回送る。4familyとIDはoffline診断と同じである。

```sh
castloop operation-status staging UPLOAD_OPERATION_ID
castloop operation-status publication DRAFT_JOB_ID
castloop operation-status lifecycle LIFECYCLE_JOB_ID
castloop operation-status show-registration SHOW_ID
```

ローカル管理keyとM6管理status routeが必要で、Cloudflare API credentialsは不要である。released v0.1.2には含めない。legacy Workerと通常candidateの未公開管理routeは拒否する。今回通常candidateのroute/readinessを開けず、実Cloudflareへdeployしない。未公開fetch結合入口での状態照会だけを検証する。

## 検査と非変更

- family/ID/strict journal/service/account/Worker/固定HTTPS originを検査した後だけ管理keyを読む。欠落・foreign・破損・symlink recordの場合、secret/HTTPを使わず固定診断で拒否する。欠落recordから別jobやUUIDを生成しない。
- 既存clientの固定origin/redirect拒否/no-store/bounded UTF-8 JSON/strict応答検査を使い、service・operation/Show/reservation ID・完全manifest/control hash・resultを照合する。claim/commit/reserve/begin/PUT/settle/finish/retryを送らない。
- publication/lifecycle等のserverが照会に必要な保持recordを持たない場合、成功やremote不在とは扱わず拒否する。ローカルprepared/requestedの存在だけではremote status取得を保証しない。
- HTTP完了後に同じlocal診断を再読し、client stateの意味的内容とlock存在観測が変わっていればsnapshotを拒否する。複数file/remoteの原子的snapshotやlockの同一性証明ではない。
- 既存の内部staging/publication/lifecycle inspectorもstatus完了後にlocal journalを再照合する。CLIを経由しない照会でも、途中phase変更を古いclient stateとの成功snapshotにしない。Show登録inspectorの既存照合規則は維持する。
- 出力はlocal診断に一致する`client_state`/`lock_present`、検査済み`server_status`、`remote_state_checked=true`を返す。`authorizes_mutation=false`と`authorizes_recovery=false`は維持する。serverのheld/released/finished/reservedもlocal phase昇格・再送・PUT再許可・consumer終了・lock/token解放の根拠にしない。
- local journal/legacy state/lock/metadataを作成・更新・削除しない。残存lockがあっても観測だけを行い、期限による奪取をしない。未知応答/偽receipt/途中変更は固定診断だけを返し、任意exception/secretを表示・記録しない。

## 検証

local disk→4内部client→未公開fetch結合入口→実管理handlerの結合で、4family、正常statusとrequested非昇格、local全file bytes/mtime不変、remote全record/ETag不変、Queue/purgeなし、既存lock保持を確認した。欠落/不正引数/foreign/symlink/破損record、途中local state/lock存在変更、応答喪失/偽identity、通常candidate拒否と一回限り送信を回帰した。source CLIも4familyをcredentialsなしで検査した。

Linux x86-64 standalone binaryでは専用local HTTPS server・一時CAとsimulated R2/実内部handlerを使用した。4familyすべてでrequested状態とepoch日時の古いlockを保持し、4 status requestsだけ・credentialsなし・local files/remote records不変を確認した。TLS検証を無効化せず、試験用CAだけをchild環境へ渡した。これはCloudflare実機検証ではない。

再現はLinux CLI binaryをbuild後、次を実行する。試験helperだけがBun/OpenSSLを必要とし、standalone管理者workflowの依存追加ではない。

```sh
bun packages/cli/src/test-support/verify-operation-status-binary.ts dist/castloop-linux-x64
```

全732テスト/11628 assertions、TypeScript、M6実証tsconfig、candidate/bridge browser bundleとLinux binary build/command helpに合格した。公開書込command/安全な外部復旧、full cutover/通常管理routing・実Cloudflare受け入れは残る。

内部inspectorのlocal途中変更回帰を追加後、全735テスト/11648 assertionsとTypeScript、3内部runner Bun bundleに合格した。binary HTTPSの確認は上記732件時点のCLI接続に対する検証であり、内部runner変更を公開commandの拡張として扱わない。
