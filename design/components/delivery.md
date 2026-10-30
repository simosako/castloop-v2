# 公開配信とキャッシュの設計

公開配信は、配信可否を判定する処理と、本文を取得・生成する処理に分かれます。Workerが要求を受け、Show DOの公開状態を確認してから、キャッシュ用エントリポイントを呼び出します。音声・画像は非公開R2、RSS・HTMLはShow DOのデータから取得します。

## 公開ルート

| パス | 内容 |
| --- | --- |
| `/podcasts/<showId>/feed.xml` | RSS |
| `/podcasts/<showId>/cover.jpg` または `cover.png` | 現在のカバー画像 |
| `/podcasts/<showId>/episodes/<episodeId>/<audioRevisionId>.mp3` | 承認済み音声 |
| `/podcasts/<showId>/` | 内蔵サイトの最初の一覧ページ |
| `/podcasts/<showId>/page/<n>/` | 内蔵サイトの一覧ページ |
| `/podcasts/<showId>/<siteId>/` | Episode個別ページ |

GETとHEADに対応します。サイトのルートは `site_mode = "builtin"` のShowで有効になります。これらのルートとSQLiteの素材参照によって配信対象を限定します。

## 要求から本文取得まで

1. Workerがオリジン、パス、HTTPメソッドを確認します。
2. パスのShow IDに対応するShow DOへ問い合わせます。
3. Show DOが公開状態と対象の存在を確認し、素材参照や世代番号を返します。
4. Workerがその情報を使い、`SqliteCachedAssets` または `SiteCachedPages` を呼び出します。
5. キャッシュに本文がなければ、R2から取得するか、SQLiteのデータから生成します。

管理要求では `X-Castloop-Show-Id` でShowを選び、指定がなければ制御DOへ送ります。公開要求はURLのパスからShowを選びます。

### 配信できない場合の応答

| 条件 | ステータス |
| --- | --- |
| 未登録・未公開・非公開化済み、未承認音声、音声オブジェクト不在、不明なページ | 404 |
| 保存状態が `deleted` | 410 |
| Show未準備、ドメイン変更準備中、生成失敗、カバー取得異常など | 503 |
| 対応しないメソッド | 405 |

拒否応答は `Cache-Control: no-store` とします。Showの非公開化は配下全体に、Episodeの非公開化はその音声・個別ページに適用します。旧音声URLも同じ公開状態の判定を通ります。

### オリジンとリダイレクト

要求を受け付けるのは、管理用オリジンと公開オリジンです。独自ドメインの利用時は、配信可否を確認した後、管理用オリジンの公開パスを正規URLへ転送します。Feedは301、音声・画像・HTMLは307です。独自ドメインの `/admin/*` は404を返します。

## キャッシュの構成

Workerの標準エントリポイントで配信可否を判定し、`ctx.exports` 経由でキャッシュ用エントリポイントを呼びます。キャッシュはそのエントリポイントで有効にし、Worker版をまたぐ共有は無効にします。

| 対象 | キャッシュの識別に使う属性 |
| --- | --- |
| Feed | Show状態版、Feed世代 |
| カバー | Show状態版、カバー世代、R2キー |
| 音声 | Show状態版、Episode公開状態版、R2キー |
| サイト一覧 | Feed世代、Show状態版 |
| サイト個別 | Feed世代、Show状態版、Episode公開状態版 |

内部要求には、固定の内部オリジンと正規パスを使い、必要な条件付き・Rangeヘッダーを渡します。キャッシュ属性は公開状態の判定結果から作ります。本文を生成するときも現在の世代と照合し、判定後に状態が変わった要求を検出します。

### キャッシュ期間と外向けヘッダー

キャッシュ内の成功応答は、音声が `max-age=31536000`、Feed・カバー・HTMLが `max-age=300` です。消去用のキャッシュタグも付けます。

リスナーへの応答では内部タグとCDN用ヘッダーを除き、`public, max-age=0, must-revalidate` を返します。ブラウザから次の要求が来たときも、公開状態の確認を通すためです。

## 本文とHTTP条件

| 対象 | 条件付き要求などの処理 |
| --- | --- |
| 音声・カバー | R2メタデータのETagと更新日時を使用。単一Range、HEAD、304、412、416に対応 |
| RSS | 生成本文のSHA-256をETagに使用。RangeとHEADに対応 |
| HTML | 生成本文のSHA-256をETagに使用。ETagの条件判定とHEADに対応 |

RSSとHTMLには `Last-Modified` を付けません。

### RSS生成

Showメタデータと公開中のEpisodeからRSSを生成します。音声URLは現在の公開オリジンを使い、音声リビジョンの識別子を維持します。XMLエスケープと[描画サイズの制限](../data/schemas.md)を適用し、生成結果をキャッシュします。

### 内蔵サイトの生成

一覧は公開日時の新しい順、同時刻はEpisode ID順で、1ページ20件です。SQLiteから対象ページの分だけ取得します。個別ページでは対象Episodeを1件取得します。

`site_id` はEpisode IDのSHA-256の先頭16文字から作り、衝突時は4文字ずつ延長します。保存した対応は更新・非公開化・再公開でも維持します。

HTMLはサーバー側で生成します。説明文は、表示に使うリンク・段落・改行を安全な形に組み直します。一覧の抜粋は最大160文字と省略記号です。日付は `site_timezone`（既定UTC）で整形します。この設定はサイトの表示に使います。

カスタムCSSは公開メタデータと履歴に保存し、標準CSSとともにHTMLへ埋め込みます。CSSの上限は65,536バイト、HTMLは1,000,000バイトです。CSPはスクリプトを禁止し、埋め込むスタイルのハッシュを指定して許可します。

## 更新時のキャッシュ消去

公開内容の確定前に、変更対象に応じてFeed、カバー、Episode音声、サイト一覧・個別ページのキャッシュを消去します。タグとパス接頭辞を使い、ドメイン変更ではShow全体を対象にします。

キャッシュAPIから明示的なレート制限応答が返った場合は、12秒間隔で最大6回試行します。その他のエラーは失敗として返します。必要な消去が完了してから、公開内容をSQLiteに確定します。

## 配信統計との接続

音声応答をWorkerの入口で観測し、対象Show DOへ1回渡します。キャッシュから返す音声も対象です。記録は非同期に行い、詳細は[Show DOの配信統計](show-do.md)で説明しています。

## 実装と関連テスト

- 要求の振り分け：[Worker](../../src/sqlite-worker.ts)、[公開Gateway](../../src/sqlite-gateway.ts)、[サイトGateway](../../src/site-gateway.ts)
- キャッシュ：[メディア・RSS](../../src/lifecycle-cache.ts)、[サイト](../../src/site-cache.ts)、[パージ](../../src/sqlite-cache-purge.ts)
- 生成：[RSS](../../src/feed.ts)、[公開前の生成検証](../../src/publication-inputs.ts)、[サイト描画](../../src/site-renderer.ts)、[説明文整形](../../src/site-description.ts)
- テスト：[Gateway](../../src/sqlite-gateway.test.ts)、[キャッシュ](../../src/lifecycle-cache.test.ts)、[生成配信](../../src/sqlite-generated-delivery.test.ts)、[サイトページング](../../src/sqlite-site-pagination.test.ts)、[パージ](../../src/sqlite-cache-purge.test.ts)
