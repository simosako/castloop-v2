# Show更新中のFeed継続配信：小規模実機確認（2026-10-21）

## 結果

**第3段階のShow更新は、新規隔離環境の小規模正常系試験で成功した。** 1 Show・10秒のEpisode 1件を公開し、metadataのみ・coverのみ・両方の編集後に明示公開した。さらに観測用の別metadata更新を1回行い、3種類すべてで取得前後がrunningだった区間の旧Feed読取を確認した。Episode metadata更新とShow非公開化／復元も成功した。

最終的にサービス・Showとも`ready / paused / drained`、`active=null / queued=0`を確認した。資源・原本・journal・私有証跡は保持し、cleanupしていない。保持サービスやEpisode追加／更新の既存試験環境への変更、移行、DNS／権限／課金／CPU上限変更は行っていない。

## 承認と対象

管理者が[設計書](show_update_feed_availability_plan.md)§12の全項目を承認し、開発・ローカルテスト・小規模実機テストを指示した。対象は新規隔離環境と、その同じ環境への小規模な追加観測に限る。

| 項目 | 値 |
| --- | --- |
| サービス | `supd-89e9af78` |
| Worker | `castloop-supd-89e9af78-01010e3b` |
| private R2 bucket | `castloop-supd-89e9af78` |
| DO namespace | `3a36797520e24b1889ff9b05cac6179d` |
| Worker version | `e59efc5d-01a8-4354-bbe5-16e7e583f741` |
| deployment | `f6b656df-1c9f-4964-8085-1127676a31ac` |
| 試験開始／最終health・REST照合 | 2026-10-21 07:22:13.729／07:27:34.646 UTC |
| 検証artifact | `c4f2b9d`を基点とする未commit実装。試験中のsource・binary hash不変を照合 |
| Linux x64 CLI SHA-256 | `f6d43de9cdf7f67b0f47fb4b267668f04e24bdbe72271f612766001a80c525f2` |

本開発版の内部queue/content schemaは**5/6**。healthの`feed_storage`／`cover_storage`は`immutable-generation-v1`、`publication_read_boundary`は`show-episode-v1`。単体CLIから直接REST管理を使用し、管理者環境にWrangler・別R2資格情報は要求していない。

## 手順と観測

1. 新規init、Show登録と明示Resume、metadata／JPEG画像をstageして初回Show公開。
2. 短尺Episode 1件をmetadata／MP3とともに明示公開。
3. 同一拡張子でbytesが異なる2画像を用意し、metadataのみ・coverのみ・両方を編集。`update-show`直後に旧Feed／画像hashが不変であることを確認してから`publish-show`を実行。
4. 公開待機と並行して、Show health→Feed／画像／音源取得→Show healthを記録。**前後ともrunningの取得組だけ**を実行中の根拠とした。
5. Episode metadata更新、Showの非公開化／復元を正式preview→hash確認→executeで実施。
6. 初回metadata更新の実行中観測を取り逃したため、同じartifact／既知のpaused・drained状態を再照合し、**別のmetadata編集・新draft／requestの公開を1回だけ追加**。大きい画像の全量取得をHEADへ変えた短い観測組を使用した。元の成功要求は再送していない。
7. 再びPauseし、最後に独立した読み取り専用監査を実施。

全30 CLIコマンドの終了コードは0。公開／lifecycleの9 jobはすべて`succeeded`で、未知応答の再送・成功操作の再実行・再配備はなかった。

### 実行中の継続配信

| 更新 | 前後ともrunningの取得組 | 確認した旧内容 |
| --- | ---: | --- |
| metadataのみ（追加観測） | 4 | Feed本文200・旧hash／ETag、条件付き304、cover HEAD 200・旧ETag／条件付きHEAD 304 |
| coverのみ | 1 | Feed本文200・旧hash／ETag、条件付き304、画像本文200・旧hash／ETag、画像条件付き304、旧音源Range 206 |
| metadata＋cover | 3 | 同上 |

初回10取得組と追加6取得組の**計16取得組**でFeedはすべて200、coverはGETまたはHEAD 200だった。最初の10組では旧音源Rangeもすべて206。実行中の根拠は上記8組であり、queued／完了をまたぐ組は実行中の証拠へ数えていない。metadataのみの初回1組には実行中の上下限がなく、追加観測でも画像全量hashを実行中に取得したとは主張しない。

### 完了後・保持・停止

- metadataのみ：Feed hashが変化し、旧ETagへの条件付き要求は200。画像hashは不変で304。
- coverのみ：画像hashが変化し、条件付き要求は200。**Feed hashは不変で304**。固定公開cover URLの設計どおりであり、世代切替の失敗ではない。
- 両方：Feed／画像hashが変化し、条件付き要求はともに200。
- 各Show更新後、Episode revision・GUID等のinspection情報はShow状態世代を除いて不変。承認済み音源URLをFeedが維持し、全量SHA-256も原本と一致した。
- Show更新後のEpisode metadata公開が成功。Show非公開化ではFeed／画像404、復元では200へ戻った。復元で新しい画像objectを作らず、確定coverを再利用した。
- privateな**Feed snapshot 8世代とcover snapshot 5世代、計13 object**を最終監査でGETし、保存済みhash／sizeとの一致を確認。Episode更新・Show非公開化・復元のsequence 6/7/8にはcover objectが存在しないことも読取監査で確認し、Feed世代を誤ってcover世代としていない。
- 固定R2 key `public/podcasts/daily/cover.jpg`は404。不変coverと固定coverの二重書込はない。世代指定の公開URL、`system/`、`staging/`も404。
- 最終監査で承認済みFeed／cover／音源の3経路が503／`no-store`。service／ShowのhealthとREST versionも一致した。監査自体のmutationは0。

## ローカル検証と実証の限界

- `bun test`: **549 pass / 0 fail、63 files、59.63秒**。
- `npm run check`、`npm run build:cli -- linux-x64`、`git diff --check`成功。
- ローカルでは保存待機点・SQL／Alarm予約rollback・再生成・未知結果・旧cover破損・guard混在／欠落・旧形式拒否・遅い旧世代読取・cacheモデルのhit／purge後miss／旧fill隔離を確認した。
- **nativeでの故障注入、blocked／Alarm再配送、実cache hit／miss判別、全拠点purge、遅いHTTP読取競合、CPU／負荷測定は未実施。** 小規模正常系の観測であり、完全な無停止・Free適合・Issue #13恒久解消を証明しない。別HTTP要求間の旧Feed／画像の世代一致も設計上保証しない。

一次証拠はgit-ignoredな`.local-test-data/results/20261021/supd-89e9af78/`へ保持した。最初のmanifest 81ファイルと後続98ファイルを再照合し、追加のcover不在確認も含む100ファイルのSHA-256を最終manifestへ保存した。workspace／管理鍵／未公開job ID／本文をGitやIssueへ掲載していない。本結果は資源の追加変更・再開・削除の許可ではない。
