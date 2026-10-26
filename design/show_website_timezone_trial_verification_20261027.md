# Issue #70：公開日のタイムゾーン表示・非公開実機確認

2026-10-27。利用者の実機デプロイ承認を受け、既存の本人限定試験サービスを更新した。[採用設計](show_website_timezone_plan.md)の案Aを使い、試験Showへ`site_timezone = "Asia/Tokyo"`を設定した。別サービスの変更・資源削除・証跡削除は対象外である。

## 対象

- サービス：`site70-url-4bbe7647`
- Worker：`castloop-site70-url-4bbe7647-5b798f3f`
- 更新前version：`2dad3614-4a88-41a7-91e7-f61dcc6f4495`
- 更新後version：`3fae65a2-a10f-4a85-90a9-cf879703155a`
- Show：`site70-normal`、通常サイズの既存3 Episode
- レビューURL：<https://castloop-site70-url-4bbe7647-5b798f3f.simosako.workers.dev/podcasts/site70-normal/>
- private R2・専用DO namespace・内部queue/content形式10/11・`static-show-v2`を維持する。DB変換、移行、新規環境作成は行わない。

## 事前確認

実装時に`bun test`は828 pass / 0 fail、TypeScript検査、Linux単体CLI build、empty-PATH smokeと設定検証も成功した。配備する単体CLI、基点`d37e4df`からの差分、未追跡ソースとhashを私有証跡へ固定した。

既存環境はShow／制御DOとも`admission_paused / ready / drained`、activeなし・queued 0・保守拘束なし。未完了操作とローカルlockはなかった。元サンプル8ファイルのhashを確認し、公開済みShow／Episode snapshotとR2一覧を保存した。

Cloudflare Accessは対象ホストの`/podcasts/*`を保護し、本人の正確なメール1件だけをInclude、Cloudflareログインと対象アカウント所属をRequireとする既存Allow policyを維持している。Bypassはない。R2直公開・custom domainは無効、Workerの別domainはなく、preview URLも無効だった。

更新前に一覧・個別3ページ・RSS・cover・3音源のGET／HEAD／条件付きGETと音源Rangeの**30要求すべてがAccessログインへの302**となった。鍵なし管理APIは401、公開対象外のroot・`system/`・`staging/`等は404だった。

## 更新手順と途中の診断

Showの受付と配信を正式CLIでPauseし、ready・drainedを確認した。正式CLIのcode-only更新は配備成功応答とreceiptを保存した後、DOのnative version反映を待つ120回の有限観測で停止した。journalは`verified`で、activationは未開始だった。

同じ更新の状態をGETし、制御DO・Show DOの新versionと正確な`prepared`要求、対象全件のnative readyを確認した。配備やprepareを繰り返さず、正式な`update-service-verify`で同じreceiptの検証・初回activationを完了した。新versionのready・保守解除と全Show pausedを確認した。

再公開前の保護確認では、試験補助スクリプトの読取結果ファイル名が前段階と重複し、上書き禁止で停止した。この時点では設定編集・Resume・upload・公開はいずれも未開始だった。各確認段階の保存先を別directoryにし、保護の読取検査だけをやり直した。成功後、試験workspaceのShow設定だけを編集し、正式CLIでResume→`update-show`→`publish-show`を各1回実行した。公開jobの`succeeded`を確認して受付だけを停止した。

公開後の検査では、「旧R2 objectはすべて不変」という試験側の仮定で停止した。差分を調べると、変更された既存objectは現在のShow設定を保存する`system/shows/site70-normal/show.toml`の1件だけで、540から569 bytesへ増えていた。既存executorがこの現在値を書き換え、別途不変revisionを作る実装であることを照合した。検査をこの正確な現在値objectと不変履歴に分け、設定内容が確定Show metadataと一致することも確認した。アプリの変更・再配備・再公開・音源uploadはせず、読取検査だけを別保存先で完了した。途中の結果も保持した。

## 最終結果

- Show／制御DOとも新versionで`admission_paused / ready / drained`、activeなし・queued 0・保守拘束なし。未完了操作はなく、本人向け配信だけを有効にした。
- Feed／サイト世代は4から5へ進み、一覧1ページと個別3ページを再生成した。元の公開日時を`datetime`属性に保持し、表示を次のように変更した。

| Episode | 元の公開日時 | 一覧・個別ページの表示 |
| --- | --- | --- |
| #35 | `2025-12-16T22:00:00Z` | `2025-12-17 (UTC+09:00)` |
| #28 | `2025-09-16T22:00:00Z` | `2025-09-17 (UTC+09:00)` |
| #20 | `2024-12-10T22:00:00Z` | `2024-12-11 (UTC+09:00)` |

- 4 HTMLを前配備の生成物と比較し、表示日付以外のbytesが同一であることを確認した。短いURL、本文リンク、全文への導線、段落・改行、標準player、フッターなし・scriptなしを維持している。
- Episode 3件の確定metadata・音源参照・短い識別子は前後一致し、RSSの前後bytesも同一だった。元サンプル8ファイルのSHA-256は不変。MP3のkey集合と既存objectのsize／ETagは変わらず、音源を再uploadしていない。今回、音源の全量GET・hash照合は繰り返していない。
- 現在値のShow設定1件以外、更新前の31 objectのkey・size・ETagをすべて保持した。新規9 objectが増え、R2は計41 object・361,118,038 bytes。最終読取検査の前後も一覧は一致した。旧HTML・公開snapshot・音源・必要な履歴は削除していない。
- 更新前、再公開前、最終確認の3段階で、Access設定・private R2・preview無効・別hostnameなしを照合し、各段階30件の未認証要求をすべてAccessログインへの302で拒否した。鍵なし管理APIは401、公開対象外のパスは404だった。共有Access設定は変更していない。
- 保持サービス`sq16r-6ec01dc6`のWorker設定は前後一致した。有料plan・CPU上限・DNS・domain・共有証明書・元データ・過去の証跡は変更していない。
- **本人のブラウザでの新しい日付表示・再生確認はレビュー待ち。** エージェントによる確認は管理者認証付きsnapshotとprivate R2の生成物の照合であり、Accessを迂回する閲覧用tokenや公開コピーは作成していない。

## 証跡と検証限界

私有証跡は既存試験directory内の`.local-test-data/results/20261026/site70-url-4bbe7647/timezone-update-0e299959/`へ保存した。最終結果は`verification-complete/review-ready.json`、日付以外のHTML一致は同directoryの`date-only-html-comparison.json`に保存した。正式CLIのjournalは同サービスの既存workspace内に保持する。秘密鍵、token、非公開job／操作ID、説明文を含む診断をGitへ転記しない。

本人以外の認証済みアカウントによる実ログイン拒否、CDN HIT／MISS、Cloudflare native CPU・duration・アカウント全体のFree消費量は未測定。生成HTMLの検査と本人ブラウザの確認を区別する。
