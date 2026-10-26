# Issue #70: 自動短縮URL・リンク表示版の非公開試験

2026-10-26。利用者から、開発内容の事前commit、自動短縮URL・HTTP(S)リンク・copyrightフッター削除の実装と本人限定のテスト配備を承認された。新規環境を使う場合は旧テスト環境を削除する指示に従う。本書はこの試験の記録であり、別環境の変更・公開・証跡削除の許可ではない。

追補：本人から本書の変更が画面へ反映されているとの確認を得た。その後、別の明示承認で[同じ環境をタイムゾーン表示版へ更新](show_website_timezone_trial_verification_20261027.md)した。以下のversion・結果・レビュー待ちは本書の試験時点の記録である。

## 対象と事前検証

- これまでのCSS・説明全文・安全なリンク復元・フッター削除等をローカルcommit `299b00c`に保存した。後続の自動短縮URLは[採用設計](show_website_site_slug_proposal.md)に従う。
- 内部queue/content形式は10/11、サイト識別は`static-show-v2`。旧DBの変換や旧ページ入口の転送は実装しない。
- `bun test`: **823 pass / 0 fail**（94ファイル、12,646 assertions）。型検査・Linux x64単体CLI build・空PATHでのsmoke試験も成功した。
- 配備に使う単体CLIを私有証跡へ固定し、SHA-256、追跡済み差分、未追跡ソースとhashを保存した。配備バイナリ・凍結TypeScript・検証対象の一致を確認した。後続の文書更新とは区別する。

## 旧環境の削除

対象は直前の専用サービス`site70-css-b1eec9cd`のみ。

- Worker `castloop-site70-css-b1eec9cd-f56b258a`と専用R2、DO namespace `252404bdef734407833b845506637a47`、専用Access applicationを照合した。他Workerからの共有bindingや独自domainがないことを確認した。
- Show／制御DOは`admission_paused / ready / drained`でactiveなし・queued 0・保守拘束なし。操作記録13件はすべて`succeeded`で、未完了操作とローカルlockはなかった。
- R2全**41オブジェクト・361,116,710 bytes**を私有directoryへ退避し、サイズ・ETag・全量SHA-256を確認した。退避後と削除直前の一覧も一致した。これはR2の退避であり、DO SQLite全体のexportではない。
- Worker削除に伴う専用namespaceの消滅を確認した後、正確な退避一覧のobject、空bucket、専用Access applicationを削除し、それぞれの不存在を確認した。Access削除のHTTP 202も成功応答と後続GET 404で照合した。
- 保持サービス`sq16r-6ec01dc6`のWorker設定は前後一致した。DNS・共有証明書・ログイン元・元サンプル・旧workspace／journal／証跡は削除していない。

## 新環境

- サービス: `site70-url-4bbe7647`
- Worker: `castloop-site70-url-4bbe7647-5b798f3f`、version `2dad3614-4a88-41a7-91e7-f61dcc6f4495`
- 専用DO namespace: `bb8e56ca603f4688b23f30a8ca142629`
- private R2: `castloop-site70-url-4bbe7647`
- Show: `site70-normal`、`[TEST] OTF Talk`、内蔵サイト・標準CSS
- レビューURL: `https://castloop-site70-url-4bbe7647-5b798f3f.simosako.workers.dev/podcasts/site70-normal/`

空のサービスを正式CLIでfresh initした。以下の保護確認後に、元の`normal/`から別workspaceへコピーした3回だけを正式CLIでstage・明示公開し、Showと3 Episodeの全公開jobが`succeeded`になった。元GUID・日時・Episode IDと音源は維持し、Showの試験名・ID・サイト方式だけをコピー先で変更した。

| Episode | MP3 bytes | 自動ページ識別子 |
| --- | ---: | --- |
| #35 ハイトラフィックな更新処理が必要な環境でのApache Iceberg検証 | 62,853,537 | `db0a48404cdf5c53` |
| #28 マイクロアドでのOTF活用とIcebergテーブルの最適化 | 59,560,018 | `b5eea97c4f6d008e` |
| #20 Apache Hudiを巨大トラフィックのシステムに導入しようと検証して得た知見（後編） | 53,727,816 | `65781014884d7e94` |

## 非公開性と結果の記録方針

`/podcasts/*`にCloudflare Accessを設定し、本人メール1件のInclude、Cloudflareアカウント所属とCloudflareログインのRequireを一つのAllow policyで組み合わせる。共有ログイン元は変更せず、Bypassは設けない。R2直公開・別hostname・preview URLは使わない。`/admin/*`の管理者鍵認証は維持する。

サンプルupload前と公開後に、一覧・3個別ページ・RSS・cover・3音源のGET／HEAD／条件付きGETと音源Rangeを未認証で検査した。各30要求はすべてAccessログインへの302で、コンテンツを返さなかった。private R2に保存されたHTML・Feed・全量音源と管理APIの確定内容を照合した。Accessを迂回して公開サイト本文を取得する仕組みは作っていない。

Access作成後、API上のdomain・許可条件・private R2・別hostnameなしの照合は成功したが、最初の未認証GETはまだWorkerの404だった。その時点ではサンプルを一切uploadせず停止した。追加の読取診断でdomain／destinationが新hostnameに一致することと、同じGETがAccessログインへの302に変わったことを確認した。APIの設定保存と配信経路への適用に時間差が観測されたが、内部の反映処理までは測定していない。Access作成を繰り返さず、設定と全30要求を同じ判定条件で再照合してから公開へ進んだ。

公開後の生成物検査では、最初の試験スクリプトが「どのサンプル回にも、表示文字列がURL以外の既存リンクがある」と誤って仮定して停止した。元の説明を独立に解析すると、#35と#28には元の`a`がなく、#20にはHTTP(S)の既存リンクが2件あった。#35の生成HTMLには本文URLの自動リンク5件が確認できた。製品コードやサンプルは変更せず、試験を元データ内の既存リンクの有無に合わせて修正し、元リンクの表示文字列・行き先が生成物に残ることを照合した。最初の検査結果は保存し、公開・uploadは再実行せず、後続は読取検査だけを行った。

読取の再検査では、最初の2音源の全量hash照合が成功した後、3本目のCloudflare管理APIによるGETが`IncompleteRead`で中断した。期待53,727,816 bytesに対して3,932,160 bytesだけを受信し、その要求では本文を完了できなかった。元uploadや公開の失敗とは扱わず、同じGET・同じ60秒timeoutで応答headerを先に保存する診断を追加し、3本目の読取だけを再実施した。通信中断の内部原因は未特定であり、公開・upload・既存2音源の照合はやり直していない。

## 最終結果と未確認範囲

- Showと3 Episodeの公開は成功し、Show／制御DOとも`admission_paused / ready / drained`、activeなし・queued 0・保守拘束なしで終了した。新しいupload・公開受付は止め、本人向け配信だけを有効にしている。
- 生成HTMLの一覧には新しい順の3回、160文字＋省略記号のタグなし抜粋、標準player 3個がある。一覧・全文・RSS item link・canonical・OGPは同じShow直下の16文字URLを使う。本文の段落・改行を保持し、フッター・scriptはない。
- Show本文のURLはリンクになり、Episode全文のHTTP(S)リンクは順に5／8／7件。#20に元からある2件のリンクは、URLではない表示文字列と行き先の両方が復元された。元metadata・RSSの説明文は変えていない。
- 3音源合計**176,141,371 bytes**はそれぞれ全量SHA-256で元サンプルと一致した。3本目の同条件GETは完了し、サイズ・ETag・SHA-256も一致した。通信中断の原因そのものは未特定のまま記録し、成功した読取をupload再実行の根拠にはしていない。
- private R2は32オブジェクト・356,727,789 bytes。公開後の読取検査前後でkey・size・ETagの一覧は一致し、元サンプル8ファイルのhashも不変だった。
- 最終照合でも本人1件だけのAllow policy、private R2、preview無効、別hostnameなしを確認した。鍵なし管理APIは401、公開対象外のroot／`system/`／`staging/`は404だった。
- **最新UIのブラウザ表示・クリック・再生・seek・スマートフォン操作は本人のレビュー待ち。** 認証済み本人の代わりにAccessを迂回した試験はしていない。他人の実ログイン拒否、CDN HIT／MISS、native CPU・duration・アカウント全体のFree消費量は未測定である。

途中の検査記録も保持し、最終結果は私有証跡内の`verification-complete/review-ready.json`に保存した。旧長いページ入口・`e/`付き入口の404と衝突・更新／復元・cache purgeの整合はローカル回帰で確認したものであり、本人認証後の実HTTP試験とは区別する。

私有証跡は元checkoutのgit-ignored `.local-test-data/results/20261026/site70-url-4bbe7647/`に保存する。管理鍵・token・非公開job／操作ID・本文入り診断をGitへ転記しない。Cloudflareの有料plan・CPU上限・DNSやdomain・共有設定は変更しない。機能成功を、アカウント全体のFree枠適合やnative性能の測定結果へ読み替えない。
