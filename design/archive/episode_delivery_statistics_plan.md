# Issue #71: Episode別・日別の基本的な配信統計の設計案

> 履歴資料。現行の統計設計は[Show DO](../components/show-do.md#配信統計)と[SQLite表設計](../data/sqlite.md)を参照する。本文の提案・仕様・検証範囲は記載当時のものであり、現在の実環境操作の許可ではない。

> **現行版との関係：** 以下は導入当時の設計・比較検討を含む。v0.8.0は新規14/13環境専用で、統計の分類・保持・通算累計は維持するが、`stats-retention`専用の操作台帳・journal・結果照会は[フェーズ4](phase4_code_and_test_cleanup_plan.md)で廃止した。保持日数は直接更新し、同じ日数で再実行できる。旧Pause/Resume・operation表の説明を現行手順に適用せず、操作は[配信統計ガイド](../../docs/delivery_statistics.md)、構成は[現行全体設計](initial_design.md)を優先する。

作成日: 2026-10-25。

**本資料は管理者レビュー用の設計提案であり、実Cloudflare環境での配備・設定変更・資源操作の承認を含まない。**
2026-10-25レビューにより、選択肢1〜7（案1-A、2-A、3-A、4-A、5-A、6-A、7-A）を採用し、本番稼働前のため既存データのマイグレーションは不要と確定した。追って保持日数を設定で変更可能という要件が追加されたため§3.8を再検討し、同年の再レビューで保持日数の置き場所（§3.8.1: 案8-α-2）と削除方式（§3.8.2: 案8-A）も採用が確定した。実装を開始する。

- 対象: [Issue #71](https://github.com/simosako/castloop-v2/issues/71)
- 調査基準: `1d53d0e`（v0.7.5。Issue #64の公開済み差分・revision履歴・過去版採用、Issue #66の受付・配信停止分離、Issue #67の観測コマンド、Issue #68の独自ドメイン対応を含む）
- 対象構成: サービス設定 `schema_version = 2`、`publication_protocol = "sqlite-sequential-v1"`、`storage_layout = "show-v1"`

---

## 1. 目的と今回の対象範囲

### 1.1 目的

番組（Show）の運営者が、「どのエピソード（Episode）の音源が、いつ、どの程度取得されているか」を日別・期間別で確認できるようにする。公開直後の反応や、過去回への継続的なアクセス傾向を、外部の解析サービスを別途構築せずにCLIとJSON出力で把握できるようにすることが目的である。

### 1.2 今回作るもの・作らないもの

HTTPによる音声ファイルの取得は、Podcastアプリの事前確認（`HEAD`）、分割取得（`Range`）、再試行、検索クローラ（bot）、途中での再生停止などを含むため、**HTTPリクエストの件数はそのまま「聴いた人数」や「最後まで再生された回数」にはならない。** 本設計では、推測を混ぜずにサーバーが観測した事実を分類・集計し、その算出条件と限界を明示する。

| 今回作るもの | 今回作らないもの（非目標・保証しないこと） |
| --- | --- |
| Episode別・日別（UTC基準）の音源配信集計 | 「実際に聴いたユニーク人数」「再生完了率」「IAB（Interactive Advertising Bureau）統計ガイドライン準拠」の保証 |
| 「音源GETリクエスト数」「応答バイト数」「一定条件で定義したダウンロード数（先頭取得数・ファイルサイズ換算値）」の区別と併記 | リスナーのIPアドレス、Cookie、端末識別子、User-Agent文字列そのものの保存や追跡 |
| `HEAD`、`304`、微小な先頭Rangeプローブ、既知botアクセスの分離集計 | 個々のHTTPリクエストを1行ずつ残すアクセスログDBや、既存の操作記録（`operations`表など）への混在 |
| 音源revision（音声ファイル世代）別の集計と、Episode全体の合計の両立（タイトル等の説明文だけを更新しても集計が分断されない仕組み） | 全Showを横断する集約データベースや、サービス制御用Durable Objectへの配信ごとの通信 |
| 計測開始時点の記録と、「0件」「未計測期間」「保持期限切れ」「取得失敗」を区別した期間指定CLI表示・JSON出力 | Webブラウザ向けのグラフ画面（GUI）や、外部サービスへの自動送信 |
| 日別明細の保持期間上限（保持日数は設定で変更可能、§3.8）によるデータ量の頭打ちと、削除分の通算累計保持（案8-A採用時） | 既存環境（内部形式7/8以前）への統計機能追加やデータ移行 |

---

## 2. 本書で使う言葉

| 言葉 | この設計での意味 |
| --- | --- |
| Show DO（番組用Durable Object） | 番組（Show）ごとに1つ作られるサーバー上の処理・SQLiteデータベースの単位。その番組の公開状態、エピソード一覧、音源情報を管理する |
| Gateway（入口処理） | リスナーからのHTTP要求を最初に受け取るWorker処理（`src/sqlite-gateway.ts`）。対象Show DOへ公開可否を確認したうえで、キャッシュまたはR2からファイルを返す |
| キャッシュオーナー（`SqliteCachedAssets`） | 承認された公開ファイルをCloudflareのエッジキャッシュ経由で読み出す専用の入口（`src/sqlite-worker.ts`）。キャッシュにデータがあれば、`SqliteCachedAssets`内のR2読取コードを実行せずにキャッシュから応答が返る |
| Episode revision（エピソード改訂版） | エピソードの公開・更新のたびに発行される版ID（UUID）。タイトルや説明文だけを直した場合も新しい版IDになる |
| 音源revision（`audio_revision_id`） | 実際に配信されるMP3ファイル（`/podcasts/<showId>/episodes/<episodeId>/<audioRevisionId>.mp3`）を識別するID。音声ファイルを差し替えたときだけ新しくなり、タイトルや説明文だけの更新（metadata-only更新）では前の音源revision IDがそのまま使われる |
| `Range`（部分取得要求） | MP3ファイルの一部（例: 先頭64KiBや、途中の1MiB分）だけを求めるHTTP要求。成功するとステータス `206 Partial Content` で指定範囲のデータが返る |
| プローブ要求 | 再生前にファイルサイズやRange対応の有無だけを調べるための、`HEAD`要求や1〜2バイト等の極小`Range`要求（例: `bytes=0-0`、`bytes=0-1`） |

---

## 3. 現状の配信経路と、検討すべき8つの設計選択肢

現在の音声配信は、次の順序で動作している。

```text
[リスナーのアプリ / ブラウザ / クローラ]
   │ GET または HEAD /podcasts/<showId>/episodes/<episodeId>/<audioRevisionId>.mp3
   ▼
[1. Gateway (serveSqliteGateway)]
   │ - URL形式とHTTPメソッド（GET/HEAD）を確認
   │ - 対象Show DOの `delivery(pathname)` を呼び出し、公開中か・配信停止中でないか・承認済み音源かを確認
   │   （未公開404、削除済み410、停止中503、旧workers.dev URLからの307リダイレクトはここで返却）
   ▼
[2. キャッシュオーナー (SqliteCachedAssets)]
   │ - キャッシュヒット時: Cloudflareのキャッシュから直接 200 / 206 / 304 を返す（R2読取コードは動かない）
   │ - キャッシュミス時: R2バケットから音声データを読み出し、200 / 206 / 304 / 412 / 416 / 503 を返す
   ▼
[3. Gateway (serveSqliteGateway の応答返却直前)]
   │ - キャッシュヒット・キャッシュミスの両方とも必ずここを通る
   │ - 最終的なHTTPステータス（200 / 206 / 304 等）と応答ヘッダー（Content-Length / Content-Range）が確定している
   ▼
[リスナーへ応答ストリームを返却]
```

この構造を踏まえ、実装方式の選択肢とメリット・デメリットを以下に比較する。

### 3.1 選択肢1: どこで配信を観測・記録するか（観測点と通信経路）

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **案1-A: Gatewayの応答確定後（上記[3]）で観測し、`ctx.waitUntil`でShow DOへ非同期記録する（推奨）** | `cachedFetch`から応答が返った時点でステータスとヘッダーを確認し、音声応答をリスナーへ返しながら、裏でShow DOの統計記録処理を呼び出す | ・**キャッシュヒット時もキャッシュミス時も必ず1回だけ通り、欠落や二重計上が起きない**<br>・実際のHTTP応答（`200`/`206`/`304`/`416`/`503`）と返却サイズを正確に区別できる<br>・公開可否判定（`delivery()`）を読取専用のまま保てるため、統計の不具合が公開可否判定を壊さない | ・Episode音声へのアクセス1回につき、Show DOへの呼び出しが「公開可否判定」と「統計記録」の2回になる（Feed・画像アクセスや404/503/307時は増えない） |
| 案1-B: Show DOの公開可否判定（上記[1] `delivery()`）の中で同時に記録する | `delivery()`にリクエストヘッダーを渡し、公開可否の確認と同時にSQLiteへ統計を書き込む | ・Show DOへの呼び出し回数が1リクエスト1回のまま増えない | ・キャッシュやR2を読む前なので、`304 Not Modified`になるか、キャッシュミス時にR2障害で`503`になるかを実際の応答と一致させられない<br>・本来は読取専用である公開可否判定のたびにDB書込みが発生する |
| 案1-C: `SqliteCachedAssets`（上記[2]）の中で記録する（**不採用**） | R2からファイルを読み出す処理の中でカウントする | ・R2読取の直後で記録できる | ・**致命的欠陥**: キャッシュヒット時には`SqliteCachedAssets.fetch`自体が実行されないため、キャッシュから配信された分がすべて欠落する |

**決定（2026-10-25レビュー）: 案1-Aを採用。** キャッシュヒット／ミスによる欠落・二重化を防ぎ、かつ公開可否gateの安全性を損なわないためである。

### 3.2 選択肢2: 応答バイト数と「途中切断」をどう扱うか

HTTPの音声配信では、サーバーが応答ヘッダーとストリームの準備を終えた後、リスナーの端末が少しずつデータを受信する。リスナーが途中で再生を止めたり通信が切れたりした場合の扱いには2つの方式がある。

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **案2-A: 応答確定時のヘッダー（`Content-Length`）基準で計上し、音声ストリームの中継加工を行わない（推奨）** | `cachedFetch`が返した`200`/`206`の`Content-Length`（サーバーが送出を開始した応答サイズ）を記録する。`response.body`は加工せずそのまま返す | ・音声データの全チャンクをJavaScriptで中継・計測しないため、**最大300MBの配信でも追加のCPU負荷やメモリ消費が増えない**<br>・実装が単純で、ストリーム転送の不具合を起こさない | ・クライアントが受信の途中で切断した場合も、その要求範囲（`200`なら全文、`206`なら要求されたRange分）のバイト数が計上される |
| 案2-B: `response.body`を監視用ストリームで包み、ストリーム終了・切断までに流れたバイト数を記録する | チャンクが流れるたびにバイト数を加算し、`close`または`cancel`された時点でShow DOへ記録する | ・途中で通信がキャンセルされた場合に、サーバーがストリームへ書き出した時点までのバイト数に近づけられる | ・音声データの全チャンクをWorkerのJSコードで中継するため、CPU時間が増える<br>・OSやCDNの送信バッファに溜まった分と、リスナーが実際に聴いた分はどのみち一致しない |

**決定（2026-10-25レビュー）: 案2-Aを採用。** Podcastアプリは再生位置より先をまとめてバッファリングするため、仮にストリーム切断を監視しても「実際に聴いた秒数・完了率」にはならない。ストリームを素通ししてCPU負荷を増やさない案2-Aを採り、仕様書とCLIのヘルプに「応答ヘッダー上の送出バイト数であり、クライアントの途中切断は差し引かない」と明記する。

### 3.3 選択肢3: Range要求・重複取得・「ダウンロード」の算出方法とプライバシー

Podcastの再生では、1回の聴取が多数の`206 Partial Content`（部分取得）に分かれたり、再生前に先頭1〜2バイトだけの確認要求が飛んだりする。一方で、IPアドレス等を使った名寄せを行うかどうかはプライバシーとDB容量に直結する。

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **案3-A: IP等を一切扱わない決定的カウンタ＋「先頭からの本編取得開始数」と「ファイルサイズ換算値」の2指標を併記する（推奨）** | 個々の要求の性質だけで分類する。<br>① **`initial_downloads`（先頭からの本編取得開始数）**: `GET 200`、または先頭（`offset = 0`）から始まり `min(65536, 音源サイズ)` バイト以上を取得する `GET 206`。<br>② **`equivalent_full_downloads`（ファイルサイズ換算値）**: `応答バイト数合計 ÷ 音源ファイルサイズ` | ・**IPアドレスやUser-Agent文字列を一切保存・ハッシュ化しない**ため、個人情報がDBに残らない<br>・1〜2バイトのプローブ（`bytes=0-0`等）や後半チャンク（`offset > 0`）でダウンロード数が何十倍にも水増しされる問題を防げる<br>・1日1エピソードあたり1行のカウンタ更新だけで済み、アクセス数が増えても行数が増えない | ・同じ人が1日に何度も先頭から再取得した場合、IPによる名寄せをしないため複数回として数えられる<br>・`offset > 0`（途中位置）だけを取得した要求は①には入らず、②（サイズ換算値）にのみ反映される |
| 案3-B: 日替わりソルト＋IPアドレス＋User-Agentのハッシュで「同一端末の同日アクセス」を1件に名寄せする | `SHA-256(日次ソルト + IP + UA + episode_id)` を計算し、Show DO内の重複排除テーブルに保存して1日1回だけカウントする | ・同じIP・同じアプリからの同日の再取得や分割取得を1件にまとめやすい | ・アクセス元ごとにSQLiteへハッシュ行を追加・削除する必要があり、書込み行数（Free枠10万行/日）と容量を消費する<br>・家庭やモバイル回線（CGNAT）で同じIPを共有する別リスナーが1人に潰れ、移動でIPが変わる1人は複数に分かれる<br>・IPアドレスを処理対象に含めるため、プライバシー上の説明・管理コストが増える |

**決定（2026-10-25レビュー）: 案3-Aを採用。** Issue #71の設計条件（「初期段階で実際に聴いた人数やIAB準拠を保証しない」「個人情報を最小化する」）に最も合致し、Show DOのSQLite容量と書込み行数を最小限に抑えられる。

### 3.4 選択肢4: 集計データの保存先

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **案4-A: 対象Show DO内のSQLiteに日別集計テーブルを持つ（推奨）** | 各Show DOのSQLiteに `(episode_id, date_utc, audio_revision_id)` を主キーとする日別カウンタ表を置き、`UPSERT`（既存行があれば加算、なければ1行追加）で更新する | ・新しいCloudflareリソースや権限が不要（既存の管理キーだけで照会できる）<br>・Show単位のDO分離（Issue #48）と一致し、制御DOへの通信が一切発生しない<br>・同じShow DO内の`publication_episodes`／`publication_media`と直接照合できる | ・音声配信1件ごとにShow DOで1行のSQLite書込みが発生する（負荷評価は§8参照） |
| 案4-B: Show DOのメモリに一定時間ためてからSQLiteへまとめて書き込む | メモリ上のカウンタに加算し、一定件数またはAlarmでSQLiteへフラッシュする | ・短時間に集中するRange要求のSQLite書込み行数を減らせる | ・**DOの再起動や退去（eviction）が起きると未保存の集計が失われる**<br>・公開処理や保守で使っている単一のDO Alarmとの競合調停が複雑になる |
| 案4-C: Cloudflare Workers Analytics Engine / Workers Logs を使う | 統計イベントを外部の分析基盤へ送り、CLIからCloudflare APIで集計取得する | ・Show DOのSQLite書込み枠を消費しない | ・新しいバインディング設定やCloudflare APIトークンが照会時にも必要になる<br>・サンプリング（間引き）や保持期間制限（FreeのLogsは数日）があり、過去のEpisode別日次集計を単体で保持できない |

**決定（2026-10-25レビュー）: 案4-Aを採用。** なお、日別行を無期限に記録し続けるとデータ量が増え続けるため、保持期間上限と古いデータの削除方式を **§3.8** で追加検討する。

### 3.5 選択肢5: 集計対象をEpisode音声に絞るか、Feed・カバー画像も含めるか

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **案5-A: 初版はEpisode音声（`.mp3`）の配信統計に限定する（推奨）** | `/podcasts/<showId>/episodes/<episodeId>/<audioRevisionId>.mp3` への要求だけを集計する。`feed.xml` と `cover.jpg|png` は統計記録の対象外とする | ・Issue #71の目的（どのEpisodeがいつ取得されているか）に直結する<br>・**Feedは購読アプリが数分〜数時間おきに自動巡回するため要求数が非常に多いが、それを記録対象から外すことで、通常のFeed取得では追加のDO呼び出しやSQL書込みが一切発生しない** | ・RSSフィード自体の巡回回数やカバー画像の取得回数は集計されない |
| 案5-B: Show単位のFeed・カバー画像の日別取得数も別テーブルで集計する | 音声に加えて、`feed.xml` と `cover.jpg|png` の日別リクエスト数・304数も記録する | ・RSSフィードのポーリング頻度も確認できる | ・頻繁なFeed巡回のたびにShow DOへの統計書込みが発生し、Workers FreeのDO要求枠・SQL書込み枠を大きく消費する |

**決定（2026-10-25レビュー）: 案5-Aを採用。** Feed巡回による無料枠の消費を避け、Episode音源の統計に集中する。

### 3.6 選択肢6: CLIコマンドの体系

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **案6-A: 単一コマンド `castloop stats SHOW_ID [--episode EPISODE_ID]`（推奨）** | `--episode` 省略時はShow内のEpisode別集計一覧を返し、`--episode EPISODE_ID` 指定時はそのEpisodeの日別推移（および`--by-revision`で音源revision別内訳）を返す | ・Issue #67の `verify SHOW_ID [--episode EPISODE_ID]` と同じ引数体系で直感的に使える<br>・追加コマンドが `stats` の1つだけで済む | ・`--episode` の有無によって、`result` JSONの形式が「Episode一覧」と「単一Episodeの日別推移」の2通りになる（`mode: "show_episodes" \| "episode_daily"` で明示区別する） |
| 案6-B: 2コマンドに分離（`show-stats SHOW_ID` と `episode-stats SHOW_ID EPISODE_ID`） | 番組内のEpisode一覧集計と、個別Episodeの日別推移を別コマンドにする | ・コマンドごとにJSONスキーマが1種類に固定される | ・コマンド名が2つ増える |

**決定（2026-10-25レビュー）: 案6-Aを採用。**

### 3.7 選択肢7: データベース保存形式（スキーマ番号）の扱い

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **案7-A: 内部コンテンツ形式番号を `8` から `9` へ進め、`delivery_statistics="episode-daily-v1"` をhealthの必須項目にする（新規環境専用・採用）** | Show DOの初期化時から統計テーブルと計測開始時刻を必須作成する。旧7/8環境への自動変換は行わない。採用時点の組み合わせはqueue/content `7/9`。その後mainへ統合したIssue #70がqueueを `8` へ進めたため、統合後の新規環境は `8/9` となり `website="static-show-v1"` も必須 | ・Showの作成時点から確実に統計計測が有効になり、「途中からテーブルが作られた」という曖昧な状態がない<br>・CLIがサーバーのhealthを見て統計対応版かを事前検証できる<br>・本リポジトリの一貫した方針（新規環境専用・旧形式変換なし）に沿う | ・既存の7/8環境へそのまま `deploy` するだけでは統計機能を追加できず、新規環境の初期化が必要になる |
| 案7-B: 既存の `7/8` を維持し、独立した `delivery_stats_schema (version = 1)` テーブルを遅延作成する | 既存7/8環境のWorker更新時にも統計テーブルを自動作成し、その作成時刻を `measurement_started_at` とする | ・既存の7/8環境をコード更新するだけで、更新時点から統計を取り始められる | ・「Show自体は公開済みだが、統計テーブルが後から初期化された」ケースを扱う分岐が増える |

**決定（2026-10-25レビュー）: 案7-Aを採用。** Castloopはまだ本番稼働で利用されていないため、既存データのマイグレーションは想定せず、マイグレーション機能も作成しない。なお、「指定した照会期間の開始日が、Showの作成日（計測開始日）より前だった場合」に、計測開始日より前の日付を「未計測（`unmeasured`）」として `0` と明確に区別する仕組みは実装する。

### 3.8 選択肢8: 日別統計データの保持期間上限と古いデータの削除方式（追加検討）

案4-A（Show DO内のSQLiteへの日別統計保存）において、日別行を無期限に蓄積し続けるとデータ量が増え続ける。2026-10-25レビューで「保持日数は配信者によって異なるので、固定値ではなく変更可能にしたい（設定ファイルに書いておきたい）」という要件が追加されたため、①保持日数Nの置き場所（§3.8.1）と、②削除方式としての案8-A／案8-Bの再比較（§3.8.2）に分けて検討する。

#### 3.8.1 選択肢8-α: 保持日数Nの置き場所

まず前提となる事実を確認する。サービス設定`castloop.toml`全体のhash（`service_config_sha256`）はWorkerとDOの配備identityの一部であり、通常のcode-only更新でconfig値が変わることは拒否される（`src/sqlite-runtime-update.ts`の照合）。現行でconfig値の変更を許す経路は独自ドメイン変更の保守flow（`sqlite-domain-change-v1`）だけだが、その要求検証は「`public_base_url`以外の全項目が変更前と完全一致すること」を要求する（`packages/shared/src/sqlite-domain.ts`）。したがって「`castloop.toml`に保持日数を書く」場合は、その値を後から変える手段が現行の製品には存在しない。

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| 案8-α-1: `castloop.toml`（サービス設定）に `delivery_stats_retention_days`（既定400日）を追加 | `init`時に値を決める。Show DOは既存のconfig bindingから直接読むため、新しいAPI・コマンド・表は不要 | ・設定ファイルで管理できる<br>・サーバー側の追加実装が最小（config schemaへの項目追加だけ）<br>・厳密なschema検証とconfig hashによる改変検知の対象になる | ・**値の事後変更ができない**: config hashが配備identityの一部のため通常deployでは拒否され、設定変更を許す保守flowは独自ドメイン（`public_base_url`）限定。事後変更を可能にするには配備契約そのものの拡張が必要になる<br>・サービス単位の値（同一サービス内の全Showで共通） |
| **案8-α-2: Show DO内のShow別設定値とし、管理コマンドで変更する（推奨）** | `publication_delivery_stats_meta.retention_days`（初期値400日）を持ち、`castloop stats-retention SHOW DAYS [--operation-id UUID]` のような管理コマンドで変更する。既存の管理経路（管理者キー認証・`X-Castloop-Show-Id`・Show DOへのRPC）を使う | ・**再配備なしでいつでも変更でき、次の日替わり削除から適用される**（レビュー要件の「変更可能」を満たす）<br>・Show単位で異なる保持日数を使える<br>・変更は操作ID付きの管理要求として記録・照会できる（Issue #66の停止・再開と同じ規律） | ・テキストファイルを直接編集する方式ではなく、コマンドで変更する<br>・変更用API・CLIコマンド・試験が1組増える |
| 案8-α-3: `castloop-admin.toml`（CLI側管理設定）に書き、CLI操作時にサーバーへ反映する | ファイルを正本とみなし、CLIが管理APIを呼ぶ際にShow DOの保持日数を同期する | ・既存の管理用設定ファイルで管理できる | ・サーバーはこのファイルを読めないため、CLIが値を押し込む同期の仕組みが必要で、ファイルの意図とサーバー適用値の**2つの正本**が発生する<br>・CLIを長期間実行しないと削除処理が古い値のまま動く<br>・Issue #65で確定した「`castloop-admin.toml`はCLIの入力・表示の好みのみ」（サーバー動作の設定は入れない）という責務分離に反する |

**決定は案8-α-2（2026-10-25レビュー）。** レビュー要件は「変更可能」であるため、再配備なしで変更できる方式を採用した。ただし「`init`時に一度決めてしまえば変更しない」運用で十分なら、新しい変更機構を作らない案8-α-1が最も単純である（この場合、値の変更が必要になった時点で別途変更経路を設計する）。案8-α-3は2つの正本と責務分離の問題から不採用とした。

いずれの案でも共通の規則:

- 保持日数Nは範囲検査を行う（案: **30日以上3650日以下、既定400日**。厳密な上下限は実装時に確定する）。
- Nを**延長**しても、すでに削除済みの日別明細は復活しない。この旨を出力に含める。
- Nを**短縮**した場合、期限を過ぎた行の追い込み削除が数日に分かれ得る。削除宣言（`retained_from_date_utc`の前倒し）は短縮後の最初の日替わり処理で行い、その間の通算累計の算出方法は§3.8.2のとおり一貫させる。

#### 3.8.2 削除方式の再比較（案8-A／案8-B、保持日数Nが設定可能という前提で）

| 観点 | **案8-A: 削除＋通算累計保持（推奨）** | 案8-B: 削除のみ |
| --- | --- | --- |
| 日別行数の上限 | N日分で頭打ち。新しいUTC日付で最初の統計記録時に1日1回、期限超過分を上限付きバッチ（例: 1バッチ200行、1日あたりのバッチ数に上限）で削除し、`retained_from_date_utc`を進める | 同左（累計表だけを持たない） |
| **Nを短縮したとき（例: 400→90）** | 91〜400日目の行は次回以降のバッチ削除で**累計表へ合算されてから**消える。各Episodeの通算合計（`lifetime`）は失われない（**非破壊**） | 91〜400日目の行は単に削除され、その期間の実績は消える（**破壊**。事前のJSONエクスポートが唯一の保全手段） |
| Nを延長したとき（例: 90→400） | すでに削除済みの日別は戻らないが、通算累計には削除時点から含まれているため表示は一貫する | 同様に戻らない |
| 設定を誤ったときのコスト | 低い。短くしすぎても通算合計は残る | 高い。短くしすぎると取り返しがつかない |
| 追い込み削除中の一貫性 | `lifetime` は「累計表の合計 ＋ まだ削除されていない残存日別行すべての合計」として計算するため、削除の途中でも通算は常に正確 | 削除宣言より後の残存行は誰からも参照されず、削除の完了だけで整合する |
| 実装量 | 累計表（1表）と合算処理が増える | 最小 |
| 評価 | **決定（2026-10-25レビュー）。** 保持日数を運営者が後から変えられる前提では、値の変更が非破壊になる案8-Aが特に有利になる（短いNを選んでも通算が残るため、Nの選択の失敗コストが小さい） | 「直近N日分の明細だけ見られればよく、過去の通算実績は不要」と割り切れる場合の選択肢 |

（参考）案8-C（管理者の明示コマンドによる手動削除）は、案8-α-2を採用すれば「保持日数の変更」をコマンドで行いつつ「削除の実行」は自動になるため役割が重なり、今回は非推奨とする。案8-D（保持上限なし・削除なし）は、レビュー指摘の「データが増え続ける」問題を解決しないため非採用とする。

いずれの削除方式でも、削除された過去の日付が「アクセス0件（`0`）」と誤認されないよう、`publication_delivery_stats_meta` に **`retained_from_date_utc`（日別データの保持開始日）** を記録し、それより前の日付は `pruned`（保持期限切れにより日別明細なし、`counters: null`）として `0` と明確に区別する。

---

## 4. 指標の定義と各種リクエストの分類規則

### 4.1 記録・算出する指標一覧

1つの `(episode_id, date_utc, audio_revision_id)` につき、以下の整数カウンタを保存する。人の聴取完了やユニーク人数を推測する項目は持たない。

| 区分 | 項目名 | 意味と算出条件 |
| --- | --- | --- |
| **本編GET配信** | `get_200_requests` | 非botからの `GET` 要求に対し、ステータス `200 OK`（ファイル全体）を返した回数 |
| **本編GET配信** | `get_206_requests` | 非botからの `GET` 要求に対し、ステータス `206 Partial Content`（部分Range）を返した回数 |
| **本編GET配信（合算）** | `audio_get_requests` | `get_200_requests + get_206_requests`。音源データを返したGET要求の総数（分割Range要求をすべて含む） |
| **転送量** | `response_bytes` | 非botからの `GET 200` および `GET 206` でサーバーが応答した `Content-Length` の合計バイト数 |
| **条件付きダウンロード指標①** | `initial_downloads` | **先頭からの本編取得開始数**。非botの `GET 200`、または先頭（`offset = 0`）から始まり返却長が `min(65536, 音源サイズ)` バイト以上である `GET 206` の回数。後半チャンク（`offset > 0`）や微小プローブを除いた「先頭から本編取得を開始した回数」 |
| **条件付きダウンロード指標②（算出値）** | `equivalent_full_downloads` | **ファイルサイズ換算の取得回数**。`response_bytes ÷ その音源revisionのファイルサイズ（length_bytes）`（小数第2位まで、例: `14.25`）。分割Range取得でも合計でファイル1本分が応答されれば `1.0` となる |
| **補助カウンタ** | `probe_range_requests` | 非botの `GET 206` のうち、先頭（`offset = 0`）から始まるが返却長が `min(65536, 音源サイズ)` バイト未満の微小要求（`bytes=0-0` や `bytes=0-1` 等）の回数 |
| **補助カウンタ** | `head_requests` | `HEAD` 要求に対し `200` / `206` / `304` を返した回数（アプリの事前確認や `castloop verify` を含む。転送バイト数は0） |
| **補助カウンタ** | `not_modified_requests` | 非botの条件付き `GET` 要求に対し `304 Not Modified` を返した回数（転送バイト数は0） |
| **bot分離カウンタ** | `bot_get_requests` | `User-Agent` が既知のbot／クローラ／自動検証ツールに一致した `GET 200` / `GET 206` の回数（上記の本編カウンタには含めない） |
| **bot分離カウンタ** | `bot_response_bytes` | 上記 `bot_get_requests` で応答したバイト数の合計（上記の `response_bytes` には含めない） |

### 4.2 ケース別の扱い（何を数え、何を数えないか）

| ケース | HTTPメソッド・応答 | 統計での扱い | 理由 |
| --- | --- | --- | --- |
| 通常の全文ダウンロード | `GET` → `200 OK` | `get_200_requests + 1`<br>`initial_downloads + 1`<br>`response_bytes + 全長` | ファイル全体の取得開始・応答であるため |
| 先頭からの実質的なRange取得（例: `bytes=0-` や `bytes=0-524287`） | `GET` → `206 Partial Content`（`offset = 0` かつ返却長 `>= min(64KiB, 全長)`） | `get_206_requests + 1`<br>`initial_downloads + 1`<br>`response_bytes + 返却長` | ストリーミング再生や分割取得の開始要求であるため |
| 続きの位置からのRange取得（例: `bytes=524288-1048575`） | `GET` → `206 Partial Content`（`offset > 0`） | `get_206_requests + 1`<br>`response_bytes + 返却長`<br>（`initial_downloads` は増やさない） | 分割取得の2個目以降のチャンクや途中シークであり、そのたびに「1ダウンロード」と数えると大幅な水増しになるため。転送量は `response_bytes` と `equivalent_full_downloads` に反映される |
| 先頭1〜2バイト等のRange対応確認（例: `bytes=0-0`、`bytes=0-1`） | `GET` → `206 Partial Content`（`offset = 0` かつ返却長 `< min(64KiB, 全長)`） | `get_206_requests + 1`<br>`probe_range_requests + 1`<br>`response_bytes + 返却長`<br>（`initial_downloads` は増やさない） | プレーヤーが再生前にサーバーのRange対応を確認する微小要求や `verify` のフォールバックを、本編ダウンロード数に入れないため |
| ヘッダーのみ取得 | `HEAD` → `200` / `206` / `304` | `head_requests + 1` のみ | 音声本文は送出されないため、GET数やバイト数、ダウンロード数と明確に分離する |
| キャッシュ有効確認 | `GET`（`If-None-Match`等）→ `304 Not Modified` | `not_modified_requests + 1` のみ | 音声本文は送出されないため |
| 既知bot・クローラ・`castloop verify` | `User-Agent` がbot規則に一致する `GET` → `200` / `206` | `bot_get_requests + 1`<br>`bot_response_bytes + 返却長` | クローラや外形監視による取得を本編の統計から分離しつつ、アクセスがあった事実自体は隠さず確認できるようにする |
| 旧 `workers.dev` URLからの転送 | `GET` / `HEAD` → `307 Temporary Redirect` | **カウントしない** | 音声は返しておらず、直後に転送先の独自ドメインへ届く要求でカウントされるため（二重計上の防止） |
| 失敗・拒否応答 | `404` / `405` / `410` / `412` / `416` / `503` | **カウントしない** | 音声は配信されていない。また、存在しないURL（404）を記録するとランダムURL攻撃でDB行を無限に作られる恐れがあるため、承認済み音源の成功応答のみを記録する |
| キャッシュヒット vs キャッシュミス | `SqliteCachedAssets` のヒット／ミス | **同じ基準で1回カウント** | キャッシュの外側（`serveSqliteGateway`）で応答確定後に記録するため、ヒット時もミス時も全く同じように1回カウントされる |

### 4.3 既知bot判定の規則と限界

- **判定方法**: リクエストの `User-Agent` ヘッダー（小文字化・先頭512文字までを検査）に、以下の既知の自動巡回・クローラ・検証ツールの識別子が含まれる場合は `bot` として分離する。
  - 検索・一般クローラ: `bot`, `crawler`, `spider`, `slurp`, `archiver`, `ia_archiver`, `mediapartners-google`, `adsbot`
  - SNS・リンクプレビュー: `facebookexternalhit`, `facebot`, `twitterbot`, `slackbot`, `discordbot`, `whatsapp`, `telegrambot`, `linkedinbot`
  - AI・データ収集クローラ: `gptbot`, `chatgpt-user`, `oai-searchbot`, `claudebot`, `anthropic-ai`, `perplexitybot`, `bytespider`, `ccbot`, `amazonbot`
  - 外形監視・Castloop自身の検証: `castloop-verify`, `uptimerobot`, `pingdom`, `statuscake`, `better stack`
- **Castloop CLI側の対応**: `castloop verify`（および `diagnose --external`）が公開URLへアクセスする際、`User-Agent: castloop-verify/<version>` を明示的に付与する。これにより、`HEAD` が使えず1バイト `GET` フォールバックが動いた場合でも、通常リスナーの `get_206_requests` に混ざらない。
- **限界の明示**:
  - `User-Agent` はクライアント側の自己申告であり、一般的なブラウザやPodcastアプリ名を名乗るクローラは除外できない。
  - 逆に、名称に `bot` 等を含む特殊なカスタムクライアントは `bot_get_requests` 側へ分類される。

---

## 5. 音源revision別とEpisode合計の関係（metadata-only更新への対応）

### 5.1 なぜmetadata-only更新で集計が分断されないのか

Castloopでは、エピソードの「改訂版ID（`episode.revision_id`）」と「音声ファイルのID（`audio_revision_id`）」が次のように管理されている（`src/sqlite-publication-content.ts`、`src/sqlite-publication-executor.ts`）。

1. **初回公開（公開ジョブ `J1`）**:
   - エピソードの `revision_id` は `J1`、公開音声URLは `/podcasts/<showId>/episodes/<episodeId>/<J1>.mp3` となり、`publication_media` 表に `(show_id, episode_id, audio_revision_id = J1, sha256, length_bytes)` が登録される。
2. **タイトルや説明文だけの更新（metadata-only更新、公開ジョブ `J2`）**:
   - エピソードの `revision_id` は `J2` に進むが、**公開音声URLは `/podcasts/<showId>/episodes/<episodeId>/<J1>.mp3` のまま維持される**（`audio_revision_id` は `J1` のまま変わらない）。
3. **音声ファイルの差し替え更新（audio更新、公開ジョブ `J3`）**:
   - 新しいMP3が `/podcasts/<showId>/episodes/<episodeId>/<J3>.mp3` として保存され、`publication_media` 表に `audio_revision_id = J3` が追加される。過去の `J1` も不変履歴として保持されるため、古いFeedキャッシュを持つアプリが `J1.mp3` を取得することも引き続き可能である。
4. **過去revisionの採用（Issue #64 `adopt-episode-revision`、公開ジョブ `J4`）**:
   - 過去のEpisode revisionを採用して新しいrevision `J4` を公開する場合も、その過去版が参照していた既存の `audio_revision_id`（`J1` または `J3`）が `publication_episode_revisions.audio_revision_id` および音声URLとしてそのまま再利用される。

### 5.2 集計キーと合算規則

統計テーブルの集計キーには、メタデータの版（`episode.revision_id`）ではなく **音源revision（`audio_revision_id`）** を使う。

- **metadata-only更新や、同じ音源を持つ過去revision採用のとき**: 音声URL（`audio_revision_id = J1`）が変わらないため、更新前後のアクセスはすべて同じ `(episode_id, date_utc, audio_revision_id = J1)` にそのまま加算され、**集計は一切分断されない。**
- **音声ファイルを差し替えたとき**:
  - 旧音源（`J1`）へのアクセスは `audio_revision_id = J1`、新音源（`J3`）へのアクセスは `audio_revision_id = J3` にそれぞれ記録される。
  - **Episode合計（既定表示）**: 同じ `episode_id` に属するすべての `audio_revision_id` のカウンタを日別・期間別で合算して表示する。`equivalent_full_downloads`（ファイルサイズ換算値）は、各音源revisionの `response_bytes ÷ その音源revisionのlength_bytes` をそれぞれ計算してから合算する（差し替え前後でファイルサイズが異なる場合にも正確に換算するため）。
  - **音源revision別の内訳（`--by-revision` またはJSON出力の `revisions`）**: `J1` と `J3` それぞれの取得数・バイト数・現在Feedで参照中かどうか（`is_current_enclosure: true/false`）を並べて確認できる。

---

## 6. 未計測期間・0件・取得失敗の区別

Issue #71の要件「不明・欠測・未導入期間は0と表示せず、計測開始時点と範囲を示す」「0・未計測・取得失敗を区別する」を満たすため、次の4つを厳密に区別する。

### 6.1 計測開始時点（`measurement_started_at`）の保存

Show DOの初期化時（または統計スキーマの初期化時）に、`publication_delivery_stats_meta` 表へサーバー現在時刻 `measurement_started_at_ms`（UTCミリ秒）とそのUTC日付 `measurement_started_date_utc`（`YYYY-MM-DD`）を1度だけ記録し、以後は書き換えない。

### 6.2 日付・期間ごとの状態区分

管理者が期間 `[from, to]` を指定して照会した際、各日付（および期間全体）をサーバー現在時刻 `observed_at`（UTC日付 `current_date_utc`）と `measurement_started_at` に照らして次のとおり分類する。

| 状態（`coverage` / 日別`status`） | 条件 | カウンタ値の扱い | 画面表示・JSONでの表現 |
| --- | --- | --- | --- |
| **`unmeasured`（未計測）** | `date_utc < measurement_started_date_utc`（計測開始日より前の過去日）、または `date_utc > current_date_utc` | **`null`（`0` にしない）** | 表では `unmeasured` と表示し、JSONでは `counters: null` とする。期間全体が計測開始前ならEpisode別合計も `null` とする |
| **`pruned`（保持期限切れ）** | `measurement_started_date_utc <= date_utc < retained_from_date_utc`（§3.8の保持上限による削除済み期間） | **`null`（`0` にしない）** | 表では `pruned` と表示し、JSONでは `counters: null` とする。案8-A採用時は、削除分を合算したEpisode別の通算累計（`lifetime`）を別項目で参照できる |
| **`partial`（一部期間のみ計測）** | ① `date_utc == measurement_started_date_utc`（時刻が `00:00:00Z` ちょうどでない初日）<br>② `date_utc == current_date_utc`（当日でまだ1日が終わっていない）<br>③ 期間指定の一部が `measurement_started_date_utc` より前を含む場合 | 計測期間中に記録された整数値（アクセスがなければ `0`） | カウンタ数値とともに `partial`（計測開始時刻や当日途中である旨）を明示する |
| **`measured`（通日計測済み・0件を含む）** | `retained_from_date_utc <= date_utc < current_date_utc` で、その日の0時〜24時を通して計測が有効だった日 | 記録された整数値。**その日にアクセスが1件もなかった場合は明確に `0` を返す** | `0` 件は「計測したがアクセスが0件だった」ことを意味する |
| **取得失敗（通信エラー・認証失敗等）** | CLIからShow DOの管理APIへのGETが失敗した場合 | 統計値を一切出さない | `0` や空一覧へフォールバックせず、終了コード `1` と構造化エラー（`AgentError`）で失敗を報告する |

`retained_from_date_utc`（日別データの保持開始日）は `publication_delivery_stats_meta` に保存し、§3.8の保持上限（保持日数Nは設定で変更可能、既定400日）による削除が進んだ分だけ前倒しで更新する（バッチ削除の途中で日付境界が部分的に見えないよう、削除を開始した時点で期限日まで進める）。保持日数Nを短縮した後は、期限を超過した残存行の追い込み削除が数日に分かれても、`retained_from_date_utc` は最初の日替わり処理で新しい期限へ前倒しして宣言する。

また、非同期（`ctx.waitUntil`）で配信を止めずに記録する設計であるため、万一DOの一時過負荷等で統計書込みが失敗した場合は欠測が生じ得る。このため、統計書込みの失敗回数を `publication_delivery_stats_meta.recording_error_count`（および最終失敗時刻 `last_recording_error_at_ms`）としてDO側で把握できるようにしつつ、応答JSONに `collection_mode: "best_effort_non_blocking"` と `recording_error_count` を含めて不確実性を隠さない。

---

## 7. プライバシー・保持期間・削除方針・責務分離

### 7.1 個人情報の最小化（PII非保持）

| 対象データ | 本機能での扱い |
| --- | --- |
| リスナーのIPアドレス（`CF-Connecting-IP`等） | **読み取らない・保存しない・ハッシュ化もしない** |
| `User-Agent` ヘッダー | Gatewayのメモリ上で「既知botパターンに一致するか（boolean）」の判定にだけ使い、**文字列もハッシュも保存・ログ出力しない** |
| Cookie / 認証ヘッダー / Referer / クエリ文字列 | 読み取らない・保存しない |
| アクセス時刻の明細 | 個々のリクエスト時刻は保存せず、**UTC日付（`YYYY-MM-DD`）単位の合計カウンタ**のみを保存する |

### 7.2 既存の操作記録・診断ログとの責務分離

- Issue #40の操作記録5テーブル（`operations`、`operation_requests`、`operation_assets`、`operation_events`、`operation_record_schema`）および公開キュー（`publication_jobs`）には、リスナーの配信アクセスを一切記録しない。
- `operation-list` や `operation-status`、`show-status` の出力に配信統計データを混ぜない。
- 統計書込み失敗時の `console.error` ログは、既存のWorker診断規約に従い、固定の `event: "sqlite_delivery_stats"`、`show_id`、`reason_code: "stats_record_failed"` のみを出力し、例外オブジェクトの本文やリクエストURL・ヘッダーを転載しない。

### 7.3 保持期間と削除方針

- **日別明細の保持期間上限**: 無期限の蓄積でデータ量が増え続けないよう、保持日数N（既定400日・変更可能）の上限と古い日別行の削除方式を§3.8の選択肢8で定める。削除は1日1回・上限付きバッチで行い、削除済み期間は§6.2のとおり `pruned`（`counters: null`）として `0` と区別する。案8-Aを採用した場合は、削除分を合算したEpisode別の通算累計を別表で保持する。保持日数Nの置き場所と変更手段は§3.8.1に従う（推奨: Show DO内設定＋`stats-retention`管理コマンドによる再配備なしの変更）。
- **非公開化（`unpublish`）時の扱い**: エピソードやShowを非公開化しても、過去に配信された分の統計行は削除しない。非公開化中は新しい配信が404/503で拒否されるためカウンタは増えず、後から復元（`restore`）した際や過去実績の確認時にそのまま参照できる。
- **容量監視**: 既存の `ctx.storage.sql.databaseSize` によるShow DO全体の容量監視（50% / 70% / 85% 警告）の対象にそのまま含まれる。

### 7.4 公開プライバシー説明（番組運営者向けの案内文）

利用ガイド（`docs/delivery_statistics.md`）に、運営者が番組サイト等でリスナーへ説明するための記載例を用意する。

> **配信統計に関するプライバシー説明（記載例）**
> 当番組の配信サーバー（Castloop）では、エピソードごとの日別配信回数および転送データ量の合計を集計しています。この集計処理において、リスナー個人のIPアドレス、Cookie、端末識別子、User-Agent文字列などの個人情報をデータベースへ保存したり、個人を追跡したりすることはありません。（なお、配信インフラであるCloudflareのネットワーク運用・セキュリティ保護のために処理される通信情報については、Cloudflareのプライバシーポリシーが適用されます。）

---

## 8. 負荷・費用（Workers Free枠）の評価と安全設計

### 8.1 通常配信・公開処理を止めない安全条件

1. **公開可否判定（`delivery()`）の無変更・読取専用維持**:
   - リスナーへの配信前に実行される `delivery()` は従来どおり読取専用トランザクションのままとし、統計テーブルへのアクセスを含めない。
2. **非同期記録と例外隔離**:
   - `serveSqliteGateway` は `cachedFetch` の応答を受け取った後、ヘッダーを整えて直ちに `Response` を返す。
   - 統計記録は `ctx.waitUntil` へ渡し、同期エラー・非同期エラーの双方を独立した `try / catch` で捕捉して握り潰す。統計記録の失敗が `503` 応答やストリーム切断を引き起こすことは構造的にない。
3. **サービス制御DO（`service/<service_id>`）への非依存**:
   - 記録も照会もすべて対象Show DO（`show/<service_id>/<show_id>`）内で完結し、制御DOへの同期・非同期照会は一切追加しない。
4. **未承認URLによるDB肥大化の防止**:
   - 存在しないエピソードIDや未承認の音源revision IDへのアクセスは、前段の `delivery()` で404として弾かれるうえ、Show DOの統計記録処理内でも `publication_media` 表に存在する `(show_id, episode_id, audio_revision_id)` であることを同じSQLトランザクション内で確認してから `UPSERT` する。

### 8.2 Workers Free枠における負荷・容量の試算

Cloudflare Workers Freeの主な共通上限と、本機能による増分は次のとおりである（実機の課金行数やCPU時間は未測定であり、ローカル設計上の試算として記載する）。

| 項目 | Workers Freeの枠 | 本機能による増分（試算） | 評価と対策 |
| --- | --- | --- | --- |
| **DO要求数** | 10万回 / 日 | ・Feed / カバー画像 / 404 / 503 / 307: **増分 0**<br>・承認済みEpisode音声の成功応答（200/206/304/HEAD）1回につき **+1回**（既存の`delivery()`と合わせて計2回） | Feed巡回では増えないため、通常の個人〜小規模番組（音声リクエスト数千〜数万回/日）では枠内に収まる見込み |
| **DO SQL書込み行数** | 10万行 / 日 | 音声応答1回につき **`publication_episode_daily_stats` 1行の `UPSERT`**（セカンダリインデックスを作らず複合主キーのみにするため、1回につき1 B-treeの更新で済む） | 1日あたり数万回の音声チャンク要求まで対応可能。ただし大規模番組で1日10万チャンクを超える場合はFree枠の上限に達し得ることを明記する |
| **DO SQL読取行数** | 500万行 / 日 | ・記録時: `publication_media` 1行確認 ＋ 統計行1行の主キー参照<br>・照会時: 1ページ最大20 Episode分または31日分の主キー範囲走査 | 照会期間を最大366日、ページサイズを20件／31日に制限するため、全件走査は発生しない |
| **DO保存容量** | 1GB / DO（アカウント合計5GB） | 1行（1日×1 Episode×1音源revision）あたり約120〜160バイト。<br>例: **100 Episodeすべてが毎日アクセスされても約 `100 × 365 = 36,500行`/年（約5〜6MB）**。<br>§3.8の保持上限（案8-A/B: 保持日数N、既定400日・設定で変更可能）により約4万行・6MB強で頭打ちとなり、案8-Aの累計表はEpisode×音源revisionごとに1行（数KB程度）で一定 | 保持上限なしでも1GB上限に対して年間1%未満の増加だが、§3.8の上限により長期運用でも容量が一定に収まる |
| **Worker / DO CPU時間** | Free枠制限あり | 音声本体（最大300MB）はストリーム素通しでJS中継を行わず、DO側は短い整数加算SQL 1文のみ | 追加CPUはごく小さい見込みだが、ローカル試験だけで実機のCPU・Free適合を保証しない |

---

## 9. 実装の詳細仕様

### 9.1 SQLiteテーブル設計（DDL）

各Show DOのSQLiteに以下のテーブルを作成する。

```sql
CREATE TABLE IF NOT EXISTS publication_delivery_stats_schema (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS publication_delivery_stats_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  measurement_started_at_ms INTEGER NOT NULL CHECK (measurement_started_at_ms >= 0),
  measurement_started_date_utc TEXT NOT NULL CHECK (length(measurement_started_date_utc) = 10),
  retained_from_date_utc TEXT NOT NULL CHECK (length(retained_from_date_utc) = 10),
  last_pruned_date_utc TEXT CHECK (length(last_pruned_date_utc) = 10),
  retention_days INTEGER NOT NULL DEFAULT 400 CHECK (retention_days BETWEEN 30 AND 3650),
  recording_error_count INTEGER NOT NULL DEFAULT 0 CHECK (recording_error_count >= 0),
  last_recording_error_at_ms INTEGER CHECK (last_recording_error_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS publication_episode_daily_stats (
  episode_id TEXT NOT NULL,
  date_utc TEXT NOT NULL CHECK (length(date_utc) = 10),
  audio_revision_id TEXT NOT NULL,
  get_200_requests INTEGER NOT NULL DEFAULT 0 CHECK (get_200_requests >= 0),
  get_206_requests INTEGER NOT NULL DEFAULT 0 CHECK (get_206_requests >= 0),
  initial_downloads INTEGER NOT NULL DEFAULT 0 CHECK (initial_downloads >= 0),
  response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
  probe_range_requests INTEGER NOT NULL DEFAULT 0 CHECK (probe_range_requests >= 0),
  head_requests INTEGER NOT NULL DEFAULT 0 CHECK (head_requests >= 0),
  not_modified_requests INTEGER NOT NULL DEFAULT 0 CHECK (not_modified_requests >= 0),
  bot_get_requests INTEGER NOT NULL DEFAULT 0 CHECK (bot_get_requests >= 0),
  bot_response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (bot_response_bytes >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (episode_id, date_utc, audio_revision_id)
) WITHOUT ROWID;

-- 案8-A（§3.8）を採用した場合のみ作成する、削除分を合算した通算累計表。
CREATE TABLE IF NOT EXISTS publication_episode_pruned_totals (
  episode_id TEXT NOT NULL,
  audio_revision_id TEXT NOT NULL,
  get_200_requests INTEGER NOT NULL DEFAULT 0 CHECK (get_200_requests >= 0),
  get_206_requests INTEGER NOT NULL DEFAULT 0 CHECK (get_206_requests >= 0),
  initial_downloads INTEGER NOT NULL DEFAULT 0 CHECK (initial_downloads >= 0),
  response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
  probe_range_requests INTEGER NOT NULL DEFAULT 0 CHECK (probe_range_requests >= 0),
  head_requests INTEGER NOT NULL DEFAULT 0 CHECK (head_requests >= 0),
  not_modified_requests INTEGER NOT NULL DEFAULT 0 CHECK (not_modified_requests >= 0),
  bot_get_requests INTEGER NOT NULL DEFAULT 0 CHECK (bot_get_requests >= 0),
  bot_response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (bot_response_bytes >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (episode_id, audio_revision_id)
) WITHOUT ROWID;

-- 案8-α-2（§3.8.1）を採用した場合のみ作成する、保持日数変更の操作記録表。
CREATE TABLE IF NOT EXISTS publication_delivery_stats_controls (
  operation_id TEXT PRIMARY KEY NOT NULL,
  request_json TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
);
```

- `retained_from_date_utc` は作成時は `measurement_started_date_utc` と同じ値で初期化し、§3.8の保持上限によるバッチ削除の開始とともに進める。
- `retention_days` は§3.8.1の案8-α-2（Show DO内設定＋管理コマンドによる変更）を採用した場合の保持日数N（初期値400日）。案8-α-1（`castloop.toml`のサービス設定）を採用した場合はこの列は持たず、Show DOがconfig bindingの値をそのまま使う。
- `publication_delivery_stats_controls` は案8-α-2採用時の保持日数変更の操作記録。`request_json` に凍結した要求（Show・操作ID・保持日数Nとそのhash）、`record_json` に適用結果（適用後のN・適用時刻）を保存する。同じ操作ID・同一内容の再送には保存済みの結果を返し、異なる内容は拒否する（`publication_availability_controls` と同じ規律）。CLI側にも送信前の操作記録をローカルjournal（`.castloop/`）へ保存し、応答不明時は同じ操作IDでの照会だけを行う。

- **主キーの並び順を `(episode_id, date_utc, audio_revision_id)` にする理由**:
  1. 記録時の `ON CONFLICT (episode_id, date_utc, audio_revision_id) DO UPDATE` が主キーを直接使える。
  2. 個別Episodeの日別推移照会（`WHERE episode_id = ? AND date_utc BETWEEN ? AND ?`）が主キーのプレフィックス範囲走査だけで完結する。
  3. Show内のEpisode一覧照会（ページ内の最大20件の `episode_id` それぞれについて `date_utc BETWEEN ? AND ?` を集計）も主キーを直接使える。
  4. **追加のセカンダリインデックスが一切不要**になるため、毎回の配信記録でインデックス更新の書込み行数（`rowsWritten`）や容量が倍増しない。

### 9.2 管理API

対象Show DOへ向かう既存の管理経路（`X-Castloop-Show-Id: <showId>` と管理者キー認証必須、workers.dev管理用URL限定、`Cache-Control: no-store`）に、読取専用のGETエンドポイントを追加する。

- `GET /admin/sqlite-stats/episodes?from=YYYY-MM-DD&to=YYYY-MM-DD&include_deleted=false&cursor=...`
  - Show内のEpisode別集計を1ページ最大20件（`SQLITE_STATS_EPISODE_PAGE_SIZE = 20`）で返す。
  - `from` / `to` 省略時は、サーバーの現在UTC日付 `current_date_utc` を基準に直近30日間（`[current_date_utc - 29日, current_date_utc]`）とする。最大指定幅は366日間。
- `GET /admin/sqlite-stats/episodes/<episodeId>?from=YYYY-MM-DD&to=YYYY-MM-DD&cursor=...`
  - 指定した `episodeId` の期間合計、音源revision別合計（`revisions` は常に併記する。CLIの `--by-revision` は人向け表示でのrevision内訳の展開有無を指定するだけの表示オプション）、および日別推移（1ページ最大31日分、`SQLITE_STATS_DAILY_PAGE_SIZE = 31`）を返す。
- いずれも既存の `readSqliteManagementGet`（最大64KiB制限、3回までの有限リトライ）で安全に読み取る。
- 案8-A（§3.8.2）を採用した場合は、Episode別・音源revision別の応答に `lifetime`（保持上限による削除分を含む通算累計）を併せて返す。照会期間の上限366日と保持日数Nの関係で、`from` が `retained_from_date_utc` より前になる日別ページは `pruned` を返す。
- 案8-α-2（§3.8.1）を採用した場合は、保持日数変更用のPOSTを1つ追加する: `POST /admin/sqlite-stats/retention`（Show、操作ID、保持日数Nを照合して `retention_days` を変更）。同じ操作ID・同一内容の再送には保存済みの結果を返し、異なる内容は拒否する（Issue #66の操作記録と同じ規律、保存先は `publication_delivery_stats_controls` 表）。変更は次の日替わり削除から適用される。通信断後の結果照会用に、同じ操作IDでのGET（`GET /admin/sqlite-stats/retention/OPERATION_ID`）を提供する（`show-control-status` と同じ用途）。
- 現在の設定値の確認手段として、上記2つのGETの応答には現在の `retention_days`（保持日数N）に加えて `measurement_started_at_ms` と `retained_from_date_utc` を含めて返す。

### 9.3 CLIコマンドと出力例（案6-Aの場合）

```sh
# 1. Show内のEpisode別集計（直近30日・UTC基準）
castloop stats daily --workspace /path/to/service

# 2. 期間を指定してEpisode別集計をJSONで取得・エクスポート
castloop stats daily --from 2026-10-01 --to 2026-10-25 --workspace /path/to/service --json

# 3. 特定Episodeの日別推移と音源revision別内訳を確認
castloop stats daily --episode ep-001 --from 2026-10-01 --to 2026-10-25 --by-revision --workspace /path/to/service

# 4. 保持日数を変更する（案8-α-2採用時。既定は400日。次の日替わり削除から適用）
castloop stats-retention daily 180 --workspace /path/to/service

# 現在の保持日数は stats --json の応答（retention_days）で確認する。
# stats-retention は送信前にローカルjournalへ操作を記録し、応答不明時は
# 同じ操作IDでの照会だけを行う（show-pause 等と同じ規律）。
```

#### 人向け表示のイメージ（Episode一覧モード）

```text
Delivery statistics for Show daily (UTC: 2026-10-01 .. 2026-10-25)
Measurement started: 2026-10-10T04:12:00Z (coverage: partial; 2026-10-01 .. 2026-10-09 unmeasured)
Collection mode: best_effort_non_blocking (recording errors: 0)

EPISODE   STATE      INITIAL_DL  FULL_EQUIV  GET_200  GET_206     RESPONSE_BYTES  HEAD  304  BOT_GET
ep-001    published          42       38.50       18      145        452,198,400    12    5        3
ep-002    published           0        0.00        0        0                  0     2    0        0
```

#### 人向け表示のイメージ（個別Episodeの日別推移モード）

```text
Daily delivery statistics for daily/ep-001 (UTC: 2026-10-09 .. 2026-10-12)
Measurement started: 2026-10-10T04:12:00Z (coverage: partial)
Audio revisions: 1 (current: 0192b5e0-..., 12,000,000 bytes)

DATE_UTC    STATUS      INITIAL_DL  FULL_EQUIV  GET_200  GET_206  RESPONSE_BYTES  PROBE  HEAD  304  BOT_GET
2026-10-09  unmeasured  unmeasured  unmeasured        -        -               -      -     -    -        -
2026-10-10  partial             15       14.20        6       48     170,400,000      4     3    1        1
2026-10-11  measured             0        0.00        0        0               0      0     0    0        0
2026-10-12  measured            27       24.30       12       97     291,600,000      5     9    4        2
```

- `2026-10-09` は計測開始前なので `0` ではなく `unmeasured`（JSONでは `counters: null`）と表示される。
- `2026-10-11` は計測期間中でアクセスがなかった日なので `measured` かつ `0` と表示される。
- `--json` 指定時は Issue #67 §4.2 のエージェント向け出力規約に従い、`agentEnvelope` の外枠1文書で構造化データを出力する。

---

## 10. 実装順序とテスト計画

### 10.1 実装段階

| 段階 | 内容 | 主な変更対象 |
| --- | --- | --- |
| 段階1: スキーマと共通型 | 統計指標・照会要求・応答・カーソル・bot判定のZodスキーマと型定義を追加する | `packages/shared/src/sqlite-stats.ts`（新規）、`packages/shared/src/sqlite-service-api.ts`、`src/sqlite-feed-generations.ts` |
| 段階2: Show DO内の記録・集計と管理API | 統計DDL初期化、承認済み音源の `UPSERT` 記録、期間・Episode・日別・revision別の読取集計、§3.8の保持日数Nによるバッチ削除（案8-A採用時は累計表への合算、案8-α-2採用時は保持日数変更APIを含む）、統計GETエンドポイントを追加する | `src/sqlite-delivery-stats.ts`（新規）、`src/sqlite-stats-http.ts`（新規）、`src/sqlite-show-service.ts`、`src/sqlite-worker.ts` |
| 段階3: Gatewayの観測接続 | `serveSqliteGateway` で `cachedFetch` 応答確定後に `ctx.waitUntil` で非同期記録を呼び出し、障害時も配信を止めない分離を実装する | `src/sqlite-gateway.ts`、`src/sqlite-worker.ts` |
| 段階4: CLI・`verify` User-Agent・文書 | `castloop stats` コマンド、`verify` の `castloop-verify` User-Agent付与、案8-α-2採用時の `stats-retention` コマンド、help / describe / 管理者Skill / 利用ガイド / 設計書を更新する | `packages/cli/src/stats.ts`（新規）、`packages/cli/src/public-http.ts`、`packages/cli/src/index.ts`、`packages/cli/src/help.ts`、`docs/delivery_statistics.md`（新規） |

### 10.2 必須の試験ケース（受け入れ条件との対応）

| 試験分野 | 確認する内容 |
| --- | --- |
| 基本応答別の分類 | `HEAD`（200/206/304）、`GET 200`、`GET 206`、`GET 304`、エラー（`404`/`405`/`410`/`412`/`416`/`503`）、旧URLからの `307` リダイレクトで、それぞれ期待どおりのカウンタだけが増え、エラーや307は一切計上されないこと |
| Range要求・プローブ・重複取得 | 先頭からの微小Range（`bytes=0-0`、`bytes=0-1`）が `probe_range_requests` に入り `initial_downloads` に入らないこと。64KiB以上の先頭Range（`offset = 0`）は `initial_downloads` に入り、続きチャンク（`offset > 0`）は `get_206_requests` と `response_bytes` のみに加算され、`equivalent_full_downloads` が正しく算出されること |
| botと `castloop verify` の分離 | 既知botの `User-Agent` や `castloop verify` からのアクセスが `bot_get_requests` / `bot_response_bytes`（または `head_requests`）に分離され、本編の `initial_downloads` や `response_bytes` を水増ししないこと |
| キャッシュヒット／ミスの一致 | `SqliteCachedAssets` がキャッシュヒットを返した場合とキャッシュミス（R2読取）を返した場合の双方で、欠落や二重計上なくちょうど1回記録されること |
| 音源更新とmetadata-only更新 | ① metadata-only更新（タイトル・説明文変更）の前後で同じ `audio_revision_id` に継続集計され分断されないこと。<br>② 音声差し替え更新（新MP3公開）後は旧音源と新音源が revision 別で区別でき、Episode合計では両方が正しく合算されること |
| 0件・未計測・pruned・取得失敗の区別 | 計測開始前の日付が `unmeasured`（`counters: null`）となり `0` と表示されないこと。計測開始後のアクセスなし日が `measured` かつ `0` となること。保持上限による削除済み期間が `pruned`（`counters: null`）として `0` と区別されること。通信失敗時は `0` へフォールバックせずエラー終了（exit code 1）すること |
| 保持上限による削除（§3.8） | 保持日数Nを超えた日別行が1日1回・上限付きバッチで削除され、`retained_from_date_utc` が進むこと。案8-A採用時は削除と同トランザクションで累計表へ合算され、削除途中の再起動・失敗で日別行と累計の合計が崩れないこと（失敗時はロールバックし、翌日以降に再開する）。削除処理の失敗が配信記録や配信gateを止めないこと |
| 保持日数の変更（§3.8.1、案8-α-2採用時） | `stats-retention` が範囲外の値（30未満・3650超）を拒否すること。同じ操作ID・同一内容の再送が保存済み結果を返し、異なる内容は拒否されること。変更が次の日替わり削除から適用され、延長時に削除済み日別が復活せず、短縮時の追い込み削除が複数日に分かれても通算累計（案8-A）と `pruned` 表示が一貫すること |
| 統計障害時の配信維持 | 統計記録コールバックやSQL書込みが例外を投げても、公開可否gate（未公開404・停止中503）と承認済み音源の `200`/`206` 配信がそのまま成功すること |
| ページ分割・期間境界・Show間分離 | 20 Episode超のページング、31日超の日別ページング、366日上限検査、およびShow Aのアクセスや障害がShow Bの統計・配信に影響しないこと |
| プライバシー・診断規律 | DB行およびエラーログにIPアドレス・User-Agent文字列・URL・例外本文が含まれず、既存の `operations` 表に配信アクセスが混入しないこと |

---

## 11. レビュー経過と確定した判断

### 決定済み（2026-10-25レビュー）

選択肢1〜7について次のとおり採用が確定した。Castloopはまだ本番稼働していないため、既存データのマイグレーションとマイグレーション機能は対象外とする。

1. **観測点と通信経路（§3.1）**: **案1-A** — Gatewayで`cachedFetch`の応答確定後に観測し、`ctx.waitUntil`で対象Show DOへ非同期記録する（キャッシュヒット／ミス両対応、公開可否gateは読取専用のまま維持）。
2. **応答バイト数と途中切断（§3.2）**: **案2-A** — 応答ヘッダーの`Content-Length`基準で計上し、音声ストリームのJS中継は行わない（CPU負荷を増やさず、途中切断を差し引かない旨を明記）。
3. **ダウンロード指標とプライバシー（§3.3）**: **案3-A** — IPアドレスやUser-Agentを一切保存・ハッシュ化せず、「先頭からの本編取得開始数（`initial_downloads`）」と「ファイルサイズ換算値（`equivalent_full_downloads`）」の2指標を併記する。
4. **保存先（§3.4）**: **案4-A** — 対象Show DO内のSQLiteに日別集計テーブルを持つ（外部サービス不要、Show単位で完結）。
5. **集計対象（§3.5）**: **案5-A** — 初版はEpisode音源（`.mp3`）の配信統計に限定する（頻繁なFeed巡回による無料枠消費を回避）。
6. **CLIコマンド体系（§3.6）**: **案6-A** — `castloop stats SHOW_ID [--episode EPISODE_ID] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--by-revision] [--cursor TOKEN] [--json]` の単一コマンドとする。
7. **保存形式の扱い（§3.7）**: **案7-A** — 内部コンテンツ形式番号を `8` から `9` へ進め、healthに `delivery_statistics="episode-daily-v1"` を追加する新規環境専用とする。採用時点の組み合わせはqueue/content `7/9`。main統合後（Issue #70のqueue `8` を含む）の新規環境は `8/9` となり、`website="static-show-v1"` も必須になる。

### 決定済み（2026-10-25レビュー、選択肢8: 保持日数の置き場所と削除方式、§3.8）

最初のレビューで「ずっと記録し続けるとデータ量が増え続ける」との指摘を受け上限付き削除方式を提案したところ、追って「保持日数は配信者によって異なるので、400日という数字の部分は変更可能（設定ファイルに書いておく）にしたい」との要件が追加された。これを受けて§3.8を再検討し、次の2点が確定した。

1. **保持日数Nの置き場所（§3.8.1）**: **案8-α-2** — Show DO内のShow別設定値とし、`castloop stats-retention SHOW DAYS` 管理コマンドで再配備なしに変更する（次の日替わり削除から適用）。
   - 注意: 「設定ファイルに書く」案8-α-1（`castloop.toml`への `delivery_stats_retention_days` 追加）も検討したが、サービス設定はconfig hash＝配備identityの一部であり、現行で設定値の事後変更を許す経路は独自ドメイン変更（`public_base_url`限定）だけのため、**値を実質init時に一度しか決められない**ことが不採用の理由である。
   - 既存の `castloop-admin.toml` に書く案8-α-3は、サーバーが読めないCLI側ファイルを正本とする同期の仕組みが必要になり2つの正本が発生するため不採用とした。
2. **削除方式（§3.8.2）**: **案8-A** — 日別明細は保持日数N日分で頭打ちにし、1日1回の自動削除で古い日別行を消す。削除分はEpisode×音源revision別の通算累計表へ合算保持するため、Nを短縮しても通算合計（`lifetime`）は失われず、**保持日数を後から変えられる前提と特に相性が良い**（Nの選択の失敗コストが小さい）。
   - 案8-B（削除のみ・累計表なし）はより単純な代替だが、Nを短縮するとその期間の実績が失われる（事前のJSONエクスポートが唯一の保全）ため不採用とした。

---

## 参照

- [現在の全体設計](initial_design.md)、[Show単位のDO分離](do_show_separation_options.md)
- [公開済み内容との差分確認とrevision履歴・過去版採用](published_diff_and_revision_restore_plan.md)
- [公開受付停止と配信停止の分離設計](show_admission_delivery_separation_plan.md)
- [リモート診断・監視の設計案](remote_diagnostics_and_monitoring_plan.md)
- [操作記録のIDとテーブル設計](sqlite_operation_records_schema.md)、[保存先の比較とコスト](sqlite_operation_record_storage_options.md)
