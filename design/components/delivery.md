# 公開配信とキャッシュの設計

公開配信は、Workerの入口での公開可否判定と、キャッシュ対応入口での本文取得に分ける。R2バケットは非公開のまま使い、オブジェクトキーを指定して任意のファイルを取得する公開APIは設けない。

## 許可する公開パス

| パス | 配信元 |
| --- | --- |
| `/podcasts/<showId>/feed.xml` | SQLiteから生成したRSS |
| `/podcasts/<showId>/cover.jpg` または `cover.png` | 現在のカバー参照が指すR2オブジェクト |
| `/podcasts/<showId>/episodes/<episodeId>/<audioRevisionId>.mp3` | 承認済み音声参照が指すR2オブジェクト |
| `/podcasts/<showId>/` | 内蔵サイトの最初の一覧ページ |
| `/podcasts/<showId>/page/<n>/` | 内蔵サイトの一覧ページ |
| `/podcasts/<showId>/<siteId>/` | 内蔵サイトのEpisode個別ページ |

公開パスはGETとHEADだけを受け付ける。サイトは `site_mode = "builtin"` の場合だけ有効。`system/`、R2のハッシュキー、任意のCSSファイル等は公開ルートにしない。

## 公開可否とオリジン

パスからShow IDを取り出し、そのShow DOへ問い合わせる。管理要求だけは `X-Castloop-Show-Id` で対象を指定し、指定がなければ制御DOへ送る。

| 状態 | 公開応答 |
| --- | --- |
| 未登録・未公開・非公開化済み、未承認音声、不在の音声オブジェクト、不明なページ | 404 |
| 内部の `deleted` 状態 | 410。現行CLIに削除操作はない |
| Show未準備、ドメイン変更準備中、生成失敗、カバー不在等の取得異常 | 503 |
| 許可しないメソッド | 405 |

拒否応答は `Cache-Control: no-store`。Showを非公開化すれば配下全体、Episodeを非公開化すればその音声と個別ページを拒否する。旧音声リビジョンも、Episodeが非公開なら配信しない。

要求オリジンは管理用オリジンと公開オリジンに限定する。独自ドメインを利用するときは、公開可否を確認した後に管理用オリジン上の公開パスから正規URLへ転送する。Feedは301、音声・画像・HTMLは307。独自ドメイン上の `/admin/*` は404とし、管理APIへ転送しない。

## キャッシュの境界

Workerの標準入口はキャッシュしない。公開可否を通った要求だけを `SqliteCachedAssets` または `SiteCachedPages` へ渡す。これらのWorkerエントリポイントは `ctx.exports` 経由で呼び、配備設定でキャッシュを有効にする。Worker版をまたぐキャッシュ共有は無効にする。

| 対象 | 渡すキャッシュ属性 |
| --- | --- |
| Feed | Show状態版、Feed世代 |
| カバー | Show状態版、カバー世代、R2キー |
| 音声 | Show状態版、Episode公開可否の版、R2キー |
| サイト一覧 | Feed世代、Show状態版 |
| サイト個別 | Feed世代、Show状態版、Episode公開可否の版 |

内部要求のURLは固定した内部用オリジンと正規パスから作り、必要な条件付き・Rangeヘッダーだけを転送する。利用者が任意のキャッシュ属性やR2キーを指定することはできない。生成時にも属性と現在の世代が一致することを確認し、判定後に状態が進んだ要求を古い条件のまま生成しない。

キャッシュ入口の成功応答は、音声が `max-age=31536000`、Feed・カバー・HTMLが `max-age=300` とキャッシュタグを持つ。外向けには内部用タグ・CDNヘッダーを除き、`public, max-age=0, must-revalidate` を返す。ブラウザに長期固定させず、次の要求でも入口の公開可否を適用する。

## 本文とHTTP条件

音声・カバーはR2のメタデータを確認してから本文を取得する。ETagとR2更新日時で条件付き要求を処理し、単一Range、HEAD、304、前提不成立の412、範囲外の416に対応する。

FeedとHTMLは生成本文のSHA-256をETagにし、`Last-Modified` は付けない。FeedはRangeにも対応する。HTMLはETagによる条件判定とHEADに対応する。

### RSS

Showメタデータと現在公開中のEpisodeから生成する。音声のURLは現在の公開オリジンへ正規化するが、音声リビジョンの識別子を変えない。XMLエスケープと全体予算を適用する。RSSをR2へ保存する処理はない。

### 内蔵サイト

一覧は公開日時の新しい順、同時刻はEpisode ID順で1ページ20件。SQLiteから対象ページ分だけ取得し、個別ページは対象1件を取得する。`site_id` はEpisode IDのSHA-256の先頭16文字から決め、衝突時は4文字ずつ延長する。保存済みの対応は更新・非公開化・復元でも維持する。

HTMLはサーバー側で生成し、JavaScriptは使わない。説明文は元HTMLをそのまま埋め込まず、許可したリンク・段落・改行を再構成する。一覧の抜粋は最大160文字と省略記号。日付は `site_timezone`（既定UTC）でサーバー側整形し、RSS日時や予約時刻には影響させない。

カスタムCSSは公開メタデータ・履歴に保存し、標準CSSとともにHTMLへ埋め込む。CSSは最大65,536 bytes、HTMLは最大1,000,000 bytes。CSPはスクリプトを禁止し、実際に埋め込むスタイルのハッシュだけを許可する。

## パージと失敗

公開内容を変更する前に、変更対象に応じてFeed、カバー、Episode音声、サイト一覧・個別ページをパージする。タグとパス接頭辞を使い、ドメイン変更ではShow全体を対象にする。

キャッシュAPIの明示的なレート制限応答だけは、12秒間隔で最大6回試行する。例外、未確認の応答、レート制限以外の拒否では自動反復せず失敗する。パージ未完了なら公開のSQLite更新を確定しない。

音声応答の統計観測は、この配信経路で一度だけ引き渡す。キャッシュヒットでも観測するが、記録完了を待って音声を返すことはしない。集計仕様は[Show DO](show-do.md)を参照する。

## 定義元と関連テスト

- [Worker入口](../../src/sqlite-worker.ts)、[公開Gateway](../../src/sqlite-gateway.ts)、[サイトGateway](../../src/site-gateway.ts)
- [メディア・Feedキャッシュ](../../src/lifecycle-cache.ts)、[サイトキャッシュ](../../src/site-cache.ts)、[パージ](../../src/sqlite-cache-purge.ts)
- [RSS生成](../../src/feed.ts)、[公開時の生成検証](../../src/publication-inputs.ts)、[サイト描画](../../src/site-renderer.ts)、[説明文整形](../../src/site-description.ts)
- [Gatewayテスト](../../src/sqlite-gateway.test.ts)、[キャッシュテスト](../../src/lifecycle-cache.test.ts)、[生成配信テスト](../../src/sqlite-generated-delivery.test.ts)、[サイトページングテスト](../../src/sqlite-site-pagination.test.ts)、[パージテスト](../../src/sqlite-cache-purge.test.ts)
