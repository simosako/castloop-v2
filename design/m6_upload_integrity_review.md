# M6: 音源の完全性検証をR2/CLIへ集約する調査

更新日: 2026-10-04

状態: **公式仕様と専用Cloudflare環境で代替手段を確認。方式の提案であり、現行runtimeの変更・M6受け入れ完了ではない。Workers Paidは使用しない。**

## 結論

Workerで300MBのSHA-256を再計算する必要はない。目的は「凍結した入力と保存済み音源が同じ全長・内容であること」であり、検証する場所をWorkerのCPUに限定する理由はない。

推奨は、**stagingは既存CLIの全量SHA-256読み戻しを保存objectのidentityへ結び付け、公開時はR2 bindingのSHA-256検証へ任せる**方式である。これならSHA-256による照合を維持し、REST単一PUT・既存の読み戻し・公開時のstream保存を使える。Worker内のstaging/publication二箇所の全量再ハッシュをなくし、新しいupload方式・credential・製品・状態機械を追加しない。

さらにCLIの読み戻しもなくす候補として、R2が自動保存するMD5とlocal MD5の比較も成立する。ただしこれはstaging時点のSHA-256照合と同じ保証ではないため、最小改修の第一案とは分ける。

## 現行の重複

| 区間 | 現行処理 | 見直し対象 |
| --- | --- | --- |
| local入力→staging | CLIが入力SHA-256を凍結し、REST PUT後に全量GET/size/SHA-256を照合 | 読み戻し結果を返さず破棄している。PUT receiptもsuccess/sizeしか検査しない |
| staging完了 | Workerが同じ音源をGETし、全量SHA-256を再計算 | CLIの照合結果をexact objectへ結び付ければ、音源bodyの再読取は不要 |
| staging→公開immutable音源 | Workerの`bucket.put(..., { sha256 })`でR2へ検証を要求 | 既に利用している機能。保存済みのnative checksumを確認すればよい |
| 公開保存後 | Workerが公開音源をGETし、さらに全量SHA-256を再計算 | R2の検証済みchecksum/sizeをHEADで確認する処理に置き換える |

対象コードは`packages/cli/src/staging-rest.ts`、`src/staging-verification.ts`、`src/publication-episode-runner.ts`。publication admissionは既に検証記録とHEADのETag/sizeを照合しており、ここへ別の全量検証を追加しない。

## R2機能: アクセス経路を区別する

### 現行のCloudflare REST object PUT

`PUT /accounts/{account_id}/r2/buckets/{bucket_name}/objects/{object_key}`の[公式仕様](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/upload/)にはchecksum入力が記載されていない。

専用bucketの新規`probe/checksum/<UUID>/`へ28-byte bodyを送り、ヘッダーなし・正しい/誤った`Content-MD5`・正しい/誤った`x-amz-checksum-sha256`を比較した。**五件ともHTTP 200で保存され、GETのbodyは送信内容と一致した。誤ったchecksumでも拒否されない。** この経路にS3用ヘッダーを追加するだけでは検証を任せられない。

これらのobjectにはR2 native MD5が保存されていたが、SHA-256は保存されていなかった。`customMetadata.sha256`に文字列を書いても、それ自体は検証済みchecksumにならない。

### Workers R2 binding

[Workers API仕様](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2putoptions)は`put`の`sha256`等を受信内容の完全性検証に使うと定める。指定したchecksumは`R2Object.checksums`に保存され、HEADでbodyを読まず取得できる。非multipart objectのMD5は既定で含まれる。

実機では正しいSHA-256付き28-byte PUTが成功し、PUT結果とHEADのnative SHA-256が一致した。誤ったSHA-256は`BadDigest`相当のcode `10037`で拒否され、対象keyのHEADはnullだった。

続いて既知の300,000,000-byte staging音源を条件付きGETし、診断用の別keyへ`put(object.body, { sha256, onlyIf })`した。**HTTP 200、CPU 2ms、wall 16,449ms、HEADのsize/native SHA-256一致**を確認した。Workerの全量buffer・JavaScript hash・DigestStreamは使っていない。CLIによるコピー先の全量GETでもsize/SHA-256が一致した。

CPU limitやPaid契約は変更していない。2msはこの単独保存試験の実測であり、M6の全処理・全colo・常時のCPU上限保証ではない。bindingによるchecksum検証を、300MBのWorker内再ハッシュと同じCPU費用として扱う必要はない。

### S3互換API

[S3互換性仕様](https://developers.cloudflare.com/r2/api/s3/api/)には`Content-MD5`等の対応があるが、現行の管理REST APIとは別経路である。multipart checksumは全量hashと合成hashを区別する必要もある。別credential/署名処理やupload方式の変更なしに解決できるため、今回S3への移行は推奨しない。

## 選択肢と保証の違い

| 案 | stagingの確認 | 公開音源の確認 | 評価 |
| --- | --- | --- | --- |
| A: R2 native checksum中心 | local size/MD5を凍結し、Worker HEADのsize/native MD5と比較 | R2 PUTのSHA-256検証＋HEADのnative SHA-256 | 全量読み戻しも不要。偶発的破損・欠落の検出には有効だが、MD5は意図的衝突への耐性が弱い。stagingのSHA-256照合を同等に維持する案ではない |
| **B: CLI SHA-256読み戻し＋R2公開検証** | **現在のCLI GETで全量size/SHA-256を照合し、Workerがその結果と保存objectのidentityを確認** | **R2 PUTのSHA-256検証＋HEADのnative SHA-256** | **推奨。既存の全量SHA-256照合を残し、Workerでの二重計算をなくす。新しいMD5 manifestも不要** |
| C: stagingをR2 SHA-256付きで再保存 | R2 bindingで既存stagingを読み、SHA-256検証付きで再保存 | 同上 | server独立のSHA-256検証は可能だが、検証だけのために300MBを再書込し、書込副作用も増やす。MVPでは不要 |

Aでも公開時のR2 SHA-256検証は維持できるため、MD5を全量SHA-256の代用品として最終公開証拠へ流用する必要はない。Bの全量読み戻しは転送時間を増やすが、既に実機300MBで成功している。R2の保存耐久性やHTTP 200だけをlocal入力との照合の代わりにはしない。

## 推奨Bの最小実装契約

1. `createStagingRestPut`は成功申告だけでなく、固定asset/key、PUT receiptのsize/ETag/versionと、全量GETの実測size/SHA-256/ETagを返す。PUT結果のidentityとGETのidentityを照合する。REST receiptのversion提供・binding HEADとの対応は接続時の実機検証事項とし、欠落/不一致を成功として補完しない。
2. その小さい証拠だけを既存local journalと認証付きsettlement要求へ保存する。操作ID・draft ID・凍結manifestへ厳密に結び付け、 arbitrary keyや`verified: true`だけの要求を受け付けない。本文・source path・secretは保持記録へ追加しない。
3. Workerはexact owner/generation・client終了確認と証拠を照合し、音源のHEADでsize/ETag/versionを確認する。音源のGET/全量hashはしない。metadataのschema/identityとcoverの形式検証は別責務として維持する。
4. verified assetsへidentityと照合済みSHA-256を残し、publication admissionとsource取得時にも同じobjectであることを確認する。サイズだけ・ETagだけ・任意のcustom metadataだけを内容証明にしない。
5. `persistAudio`は既存のSHA-256付きR2 PUTを維持する。成功後と再実行時はHEADのsize/**native** `checksums.sha256`を凍結commitに照合する。native checksumがない既存objectをcustom metadataだけで成功扱いせず、安全な互換/回復の扱いを別途決める。
6. 受付/token/既存phaseは使い続ける。未返却PUT/consumerをHEADや時間だけで解放しない。新規の巨大な汎用状態機械や分割upload sessionは作らない。

BのCLI証拠は、認証された準拠管理CLIの観測結果であり、悪意ある管理者から独立した暗号学的証明ではない。現行管理者はCloudflare tokenでbucketへ直接書け、現在もPUT終了を自己申告する信頼モデルである。この境界を明示し、Workerが実際にSHA-256を再計算したように表示しない。一方、公開先のSHA-256はR2が実内容を検証するため、異なる内容は公開保存に成功しない。

checksumは原本との同一性検査であり、原本自体のMP3破損・再生品質を保証するものではない。既存のCLIによるMP3解析、300MB上限、全量size照合は維持する。

## 証拠と残る検証

- [sanitized結果](../experiments/m6/checksum-results-20261004.json)。raw観測とprivate実行記録は`/tmp/opencode/castloop-m6-checksum-8057dd2f/`。secretを含む`binding-before.json`を外部報告へ添付しない。
- 新規診断Workerは`castloop-m6-test-checksum-913cb489`。既存service Worker/control/Queueには書き込まず、既知staging音源は読取だけ。今回作った成功済みprobe payload七件のみexact keyで削除し、GET 404を確認した。資源自体は削除していない。
- 元serviceのpaused状態・未返却owner/token・回復可能な300MB staging payloadは維持する。この試験は旧IO収束/強制解放の証拠ではない。[U1](./m6_upload_recovery_options.md)の扱いも変更しない。
- Bの証拠伝達はまだ未実装。接続後はreceipt/GET/HEADのidentity一致・途中差替え・証拠欠落/不一致・manifest/owner/generation不一致を適切な層で検証する。native checksumの実動作は今回の実機証拠を使い、各層へ同じ大容量検証testを重複させない。
- 300MBのM6 publication全体、二種改訂、配信、明示deleteまでの受け入れは別に残る。今回の成功はその合格の代わりではない。
