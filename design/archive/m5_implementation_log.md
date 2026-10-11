# M5 実装・実機検証ログ

## 2026-09-25: M5.0 単一 API token の権限・API 経路確認

対象は環境変数 `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` で指定したアカウント。token値、アカウントID、workers.devサブドメインは記録しない。token verify は `active`。token自身の詳細・権限一覧APIは HTTP 403（code 9109）だったため、付与権限の一覧ではなく**現在のtokenによる実際の操作**で確認した。検証専用のbucket・Queue・Worker `castloop-m5-perm-2d154baf` だけを使用し、既存のcastloopサービスは変更していない。

| 操作 | 結果 |
| --- | --- |
| R2 bucket / Queue の作成、R2 objectのPUT | 成功。`CLOUDFLARE_API_TOKEN`を使ったREST APIの書き込みでも成功 |
| R2 Event Notification ruleの作成 | 成功。`m5-probe/` prefix・`commit.json` suffixのPutObjectを検証Queueへ接続 |
| Worker moduleのmultipart upload | R2 binding、Queue producer binding、`secret_text`を指定して成功。script更新時に`inherit` bindingと`bindings_inherit=strict`を使い、secretを保持して更新できた |
| Queue consumer / workers.dev公開 | 1件batch・1並列・2回retryでconsumer作成成功。Worker公開URLはHTTP 200 |
| 通知→Queue→Worker→R2 | REST APIで`commit.json`をPUTすると、consumerがR2にreceiptを書き込んだ。receiptにイベントのbucket・object・actionがあり、継承したsecretも一致 |
| 上限MP3 | 48 kHz、320 kb/sの有効MP3を正確に300,000,000 bytes作成（`ffprobe`: 7500秒）。R2 REST object APIでHTTP 200、12.89秒でupload。GETはHTTP 200、300,000,000 bytes、Content-Type `audio/mpeg`。往復SHA-256が`d62a1884c6c2d5114325322184e601c352f90067fb22c6cab95631da955edf10`で一致 |

この実測で**現tokenにM5で必要な基本的な書き込み権限の不足は見つからなかった**。ダミーMP3は管理者の公開音源ではなく専用bucketのみで検証した。object・通知rule・consumer・Worker・Queue・bucketはすべて削除済み。Workerを先に消すとQueue consumer参照によって削除が拒否され、Queueを先に消すとWorker producer binding参照によって拒否されるため、後片付けはconsumer→Worker→Queueの順とした。

## 2026-09-25: M5.1〜M5.4 Linux x86-64の配布バイナリ受け入れ

専用の新規サービス `castloop-m5-e2e-370ceafb` に、Wranglerを介さず`dist/castloop`から`init`を実行。bucket・Queue/DLQ・Worker・consumer・通知rule・サービスTOMLが作成され、Worker URLのhealth応答も通った。accountの`/workers/settings`は`free_tier: true`を返した。実tokenの認証/権限不足は確認されなかった。

| 検証 | 結果 |
| --- | --- |
| Show初回公開と更新 | `create-show` → `update-show` → `publish-show`で公開完了。更新したタイトルとカバー画像をfeedと公開URLで照合。feedとcoverを両方`HIT`まで暖めた後、Showのタイトル・画像を更新して再公開すると両方`MISS`になり新しい内容が返った |
| Episode初回公開・改訂 | 個別にTOMLとMP3をstagingして初回公開。メタデータのみの更新、音源のみの更新ともに`published`、受付`free`。feedのタイトルとenclosure、MP3の全量ハッシュ、HEAD 200・Range 206を確認 |
| 上限MP3をCLIから公開 | `update-episode-audio`がちょうど300,000,000 bytesのMP3をstaging・再取得・SHA-256照合した後、`publish-episode`が成功。公開URLのHEADはContent-Length `300000000`、Rangeは`bytes 0-9/300000000`、全量GETのSHA-256は`d62a1884c6c2d5114325322184e601c352f90067fb22c6cab95631da955edf10`で元ファイルと一致 |
| 中断後の同じkeyへの再送 | REST object uploadを低速制限付きで開始し、1秒で意図的に中断（curl 28）。GETは404。続いて同じkeyに41,280 bytesのMP3を再送し、サイズ・ハッシュの一致を確認して削除 |
| Worker更新・回復・後片付け | APIによる同一Workerの再deploy後もsecretとconsumerを保持。初期のWorker bundleで発生したEpisodeの処理失敗を修正し、DLQに到達したjobを同一IDで再投入。`processing`のままDLQへ到達した300 MB jobも再投入後`published`かつ受付`free`。公開後の`cleanup-job`はstaging音源だけを削除し公開MP3と履歴を維持 |
| 外部ツールなしのバイナリ | コピーしたstandaloneバイナリを空の`PATH`とCloudflare環境変数だけで`deploy`・Episode metadata staging/commit・`job-status`まで実行し、公開完了と受付解放を確認。ソースやWrangler、Node.js、Bun、`ffprobe`の呼び出しは不要 |

**実装修正:** REST script uploadには`cache_options.enabled: true`が必要。最初は未設定でShow公開時のpurgeが再試行になり、修正後同じjobを回復できた。Worker内のNode crypto shim/JSストリーミングSHA-256は大容量公開で失敗/停止したため、R2 binding `put` のネイティブ`sha256`チェックと戻り値のchecksumを使用するよう変更した。大容量jobではWorkerが`status=processing`のままDLQになる場合があり、管理APIの`retry-job`をDLQかつ同一job・show・episode・受付が保持される場合に限って`processing`も再投入可能にした。最初の失敗と修正後の同一job回復を確認済み。

**既存サービス移行:** M1〜M4でWranglerを使って作成した専用サービス `/tmp/opencode/castloop-m1-smoke/` を発見。移行前のhealthは200、既存Showのfeedは2 Episodeを返した。空の`PATH`で新バイナリによる`deploy`と同workspaceの`init`再実行に成功し、同じadmin secretによるhealthは200のまま。binding 4件、cache設定、2つのQueueに各1件のconsumer、既存feedを保持した。既存Show `demo-show`にEpisodeを新規staging/公開して`published`/受付`free`、公開MP3のハッシュ一致を確認した。この専用サービスは以前から後続の検証用に保持されているため削除していない。

**公開対象:** Linux x86-64のみ。macOS/Windowsのcross compileは実装しているが、各OSからCloudflare管理操作を完走していないため、v0.1.0のRelease配布対象には含めない。別マシンへのコピーは初回リリースの受け入れ条件ではない。

検証完了後に専用サービスの通知rule、主/DLQ consumer、Worker、両Queue、bucket内70 object（合計約900 MB）、bucketを削除した。公開音源の恒久保存規則は通常サービスの挙動として検証し、この検証専用サービスだけを終了した。

## 2026-09-25: リリース後のマイルストーン監査

- `init`はCloudflare resource作成成功後にAPI responseが失われ、ローカルの`init_steps`が進まなかった場合、bucket/Queueを存在確認して採用する処理がない。再実行時に重複作成エラーになる可能性があり、同一workspaceで常に安全に再開するというM5.1条件はこの異常経路まで実証/実装されていない。
- 恒久的なpublication validation errorは`status=failed`を記録するが、`retry-job`はDLQ記録のある`retrying`/`processing`のみを受け付ける。`reserved`のまま失敗したjobを安全に放棄して受付を解放するCLI/APIがなく、そのShowは人手でのR2修復を要する。`processing`を通常操作から強制解放しない方針は維持し、安全な`reserved → free`操作を別途設計・検証する。
- Retry設定は主Queueの`max_retries: 2`。Queue/失敗記録の保持とstaging下書きの削除時期は未確定で、staging音源は完了jobに対する明示cleanupのみ実装。未公開・回復可能データへTTLを一律適用しない。
- RSS Feed ValidatorはM3で合格済み。Apple Podcasts Connectへの実際の番組登録/審査は未実施であり、ディレクトリ側の受け入れ確認は公開後のフォローアップ。
- v0.1.0のtagged sourceはMIT変更前のISC表記を含む。監査修正を含むMIT表記のsource treeをv0.1.1としてtagし、Release workflowで同一commitからバイナリ・LICENSE・checksumを再生成する。
