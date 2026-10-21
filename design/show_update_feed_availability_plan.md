# Show更新中のFeed継続配信設計（第3段階）

2026-10-21。**§12の全項目を承認済み・実装とローカル／小規模実機検証が成功。** [Episode追加](episode_add_feed_availability_plan.md)、[Episode更新](episode_update_feed_availability_plan.md)に続く第3段階。基点はcommit `c4f2b9d`。管理者から開発・ローカルテスト・小規模実機テストの実施指示を受けた。[実機結果と未確認範囲](show_update_feed_live_verification_20261021.md)を区別する。実機対象は新規隔離環境のみで、既存の保持環境・原本・journal・私有証跡は変更しない。

## 1. 目的と提案の要約

**公開済みShowの更新中も、更新前の確定済みFeed・カバー画像・承認済み音源を読み取れるようにする。** 候補の保存・検証・必要なcache purgeが完了してから、SQLの同一transactionでShow metadata・カバー画像の世代・Feedの世代を切り替える。

1. Feedは既存の世代別・不変snapshotを使う。
2. coverも固定R2 keyへ上書きせず、公開jobのsequence別の不変objectへ保存する。
3. **公開Feed URLと公開cover URLは維持する。** Workerが読み取るprivate R2 objectを、確定世代に応じて切り替える。
4. `preserve_committed`をShow publishにも広げ、開始時のFeed/Show/cover世代をguardとして保存・照合する。初回公開には旧内容がないため継続配信を許さない。
5. 隔離を確認できる`blocked`では旧内容を配信するが、job・後続FIFOの停止、未知IO保全、明示停止gateは維持する。

公開URLを維持する案では、**切替後に旧Feedのcover URLへ新しくアクセスすると新画像を返す**。各要求で許可した世代は固定するが、別HTTP要求間のsnapshot一貫性までは保証しない。この選択と代案を§4で比較し、レビュー対象とする。

## 2. 対象範囲と非対象

| 操作 | 本段階の扱い |
| --- | --- |
| Show metadataだけを編集した更新 | 旧Feed/cover/audioを継続配信し、成功後に新metadataのFeedへ切替 |
| 同じ拡張子のcoverだけを差し替えた更新 | 同じ公開URLから旧画像を配信し、成功後に新画像へ切替 |
| metadataとcoverの同時更新 | 候補を両方準備し、同一transactionで切替 |
| 公開済みShow内のEpisodeが0件 | 確定Feedとcoverがあれば同じ継続配信対象 |
| Show初回公開 | 旧Feedなし。activeなしでは404、実行中は503、成功後に公開する従来の区別を維持 |
| Episode追加・更新 | 第1・第2段階の継続配信と不変音源・revision履歴を維持 |
| Show/Episodeの非公開化・復元 | 通常更新へ含めず、従来の実行中の停止・lifecycle判定を維持 |
| Pause/readiness不一致/共有Worker更新の保守拘束 | warm cacheでも503を優先 |

「metadataだけ」「coverだけ」は**ローカルで編集した内容の区別**であり、新しい部分upload APIを追加する意味ではない。現行の`update-show`はmetadataとcoverを組でstageし、`publish-show`が明示公開する。このCLI/要求契約を維持する。画像が同じでもShow publishごとに新しいcover snapshotを作り、重複排除・旧cover再利用の最適化は導入しない。

JPEG/PNG、5,000,000 bytes以下、署名・拡張子の一致、metadataの既存入力上限を維持する。公開済みShowの画像拡張子変更を新たに対応範囲へ加えず、更新では確定済み拡張子と同じことを候補検証で確認する。拡張子変更は公開書込前に拒否する。

物理削除、世代整理、旧形式移行、自動rollback、blockedのretry/release、独自domain、Show別Worker配備は追加しない。

## 3. 現行実装と必要な修正

| 実装 | 現状と変更点 |
| --- | --- |
| `src/sqlite-feed.ts` | Episode publishだけが`preserve_committed`。Show publishも候補へ広げる |
| `src/sqlite-publication-queue.ts` | guardはEpisodeの未登録/公開済みrevisionが前提。Show用の明示分岐と旧cover世代を追加する |
| `src/sqlite-publication-content.ts` | Show metadata・cover拡張子とFeed世代を保持するが、coverの保存世代・検証済みidentityは持たない |
| `src/sqlite-publication-executor.ts` | Show metadataと固定keyのcoverを書いた後、世代別Feedを保存・purgeする。cover上書きを不変保存へ変更する |
| `src/lifecycle-cache.ts` | Feedは世代別keyを読むが、coverは公開URLに対応する固定keyをHEAD/GETする。coverも確定世代へ束縛する |
| `src/public-assets.ts`、`src/sqlite-gateway.ts` | cover propsは`showGeneration`のみ。新しい`coverGeneration`を信頼済み配信判定から渡し、厳密に検証する |
| Show復元 | 固定cover keyをHEADしているため、新しい確定cover参照とidentity検証へ変更する |

Showのrunning拒否だけを外すと、SQL上は旧metadata/Feedなのに固定keyの画像だけ新しくなる。遅い画像読取も、旧世代で許可された後に固定keyから新画像を読んでしまう。**Feedと同様、画像も保存先・読取先を同じ世代に固定する。**

## 4. 公開URLと画像の整合性の選択

| 案 | 評価 |
| --- | --- |
| 固定coverを上書きし、更新中の503だけを削除 | 未完了画像が漏れるため不採用 |
| warm cacheからだけ旧coverを返す | miss・eviction・purge後に旧画像を取得できず不採用 |
| **不変cover＋SQL世代切替、公開cover URLは固定** | **本案。** 公開経路・Feed内画像URLを維持でき、更新中と遅い単一読取の旧画像を保護できる |
| 不変cover＋世代入りの公開画像URLをFeedへ記載 | 旧Feedが切替後も旧画像を参照できる。ただし新public path・過去画像の公開承認/lifecycle・Feed生成の変更が増えるため、本段階では提案しない |

本案の保証は次のとおり。

- commit前に配信判定したFeedは旧Feed G、coverは旧画像Cを読む。後でR2へ到達しても同じobjectを読む。
- commit後に新しく判定した要求は新Feed N、新画像Nを読む。未完了候補は読まない。
- Gを取得したクライアントがcommit後に固定cover URLへ別要求を送る場合は新画像を読む。既に配信済みのFeedと画像を永続的に組として固定する方式ではない。
- coverだけの変更ではFeed内URLもmetadataも同じなので、**新Feed snapshotのbytes/ETagが旧Feedと同じになる場合がある**。新世代へ切り替わってもFeedの条件付き要求が304なのは正常。coverのbytesが変われば、その条件付き要求は新本文200となる。

公開画像URL自体を変更して外部クライアントの画像cache更新を促すことや、再検証に従わない外部cacheを制御することは保証しない。旧Feedと画像の永続的な組の固定が必要なら、実装前に世代入り公開URL案へ変更する。

## 5. 保存先と永続データ

### 5.1 不変cover snapshot

```text
公開URL（維持）:
  /podcasts/<showId>/feed.xml
  /podcasts/<showId>/cover.jpg または cover.png

private R2内:
  public/podcasts/<showId>/feeds/<feedGeneration>.xml
  public/podcasts/<showId>/covers/<coverGeneration>.jpg または .png

coverGeneration:
  その画像を保存したShow publish jobのsequence（正のsafe integer）
```

Show ID・世代・拡張子を検証する共通key helperを設ける。任意のR2 keyを配信propsに入れない。Feedのhelperと同様に、writer・cache owner・復元の読取で同じ組立規則を使う。

coverはR2 bindingの`If-None-Match: *`付きPUTで保存し、入力bytesのSHA-256を指定する。保存応答のkey・size・checksumを照合してから公開準備完了とする。条件不成立・不正応答・結果不明では成功にしない。REST staging PUTをbindingの条件付き保存と同一視せず、U1の扱いも変更しない。

固定keyの`public/podcasts/<showId>/cover.<ext>`へ二重書込・コピー・fallbackを設けない。`covers/<generation>.<ext>`は内部keyであり、新たな公開URLではない。path parserは拡張せず、世代URL、metadata、`system/`、`staging/`の直接取得は404とする。

旧画像・未参照候補に自動TTL/cleanupは付けない。遅い旧世代読取があるため、job完了やpurge成功を理由に削除しない。画像の変更がなくてもsnapshotを保存するため、Show公開回数に応じてobject数と保存量が増える。

### 5.2 確定済みcoverの正本

`publication_show_content`へ次を追加する。

| 列 | 意味 |
| --- | --- |
| `cover_generation` | 検証済みcover snapshotの世代 |
| `cover_sha256` | 保存を検証した画像bytesのSHA-256 |
| `cover_length_bytes` | 保存を検証した画像bytes長 |

既存の`cover_extension`と合わせて確定画像を識別する。Show content行は初回公開の成功transactionで作る。draftに架空の画像世代0やfallback画像を作らない。公開済み/非公開の保存済みShowには、正の世代・正しいhash・正の上限内size・対応拡張子が必要。

| 操作 | cover世代 | Feed世代 | Show状態世代 |
| --- | --- | --- | --- |
| Show初回公開・通常更新 | 新Show jobのsequenceへ | 同じsequenceへ | 従来どおり進める |
| Episode追加・更新 | 維持 | 新Episode jobのsequenceへ | 維持 |
| Show非公開化・復元 | 維持 | 従来のFeed出力規則に従う | 従来どおり進める |
| Episode非公開化・復元 | 維持 | 従来のFeed出力規則に従う | 維持 |

**cover世代はFeed世代やShow状態世代から推測しない。** Episode追加後やShow復元後には異なる値になる。復元時にも存在しない「復元job世代の画像」を読まない。

### 5.3 private Show metadata

`system/shows/<showId>/show.toml`の保存契約は変更しない。これは公開経路ではなく、配信・inspection・Feed再生成・復元の正本はSQLの確定済みcontentである。更新途中にこのprivate objectが上書きされても公開内容へ採用しない。新しいShow metadata履歴機能や、失敗後にこのobjectからSQLを復元する処理は追加しない。

## 6. 継続配信guardの拡張

### 6.1 policyと種類

policyの値は引き続き`exclusive`／`preserve_committed`とする。サーバーが凍結要求から、`action=publish`を継続配信の**候補**へ分類する。非公開化・復元は`exclusive`。Show初回も分類上は候補になるが、公開済みShowのguardが成立しないため実行中の配信は503となる。

`publication_jobs`へ次のscalar列を追加する。

| 列 | 意味 |
| --- | --- |
| `read_target_kind` | `show`／`episode`。guardが未成立ならNULL。NULLのEpisode IDをShow許可と読み替えない |
| `read_cover_generation` | 開始時の確定cover世代。Show/Episode双方のguardで使う |

既存のFeed/Show世代・要求hash・`read_verified`を共用し、Episodeの未登録/更新元revision/lifecycle列は維持する。

- Show guardではEpisode関連の4列（ID・state・revision・lifecycle）をすべてNULLとする。
- Episode guardでは既存の`absent`／`published`の組み合わせを必須とする。
- 未成立guard、Show guard、Episode guardをDB制約と読取側の厳密な照合で区別する。未知種別・部分欠落・不正な混在は許可しない。

### 6.2 claimと配信時の照合

`queued → running`と同じ同期transactionで、正確なruntime/config/window/要求/policyを確認し、公開済みShowの期待状態世代が一致する場合に現在のFeed世代Gとcover世代Cを保存する。ShowのguardにEpisode未登録条件を課さず、Episode jobでは従来の対象base/lifecycle条件も確認する。

配信時は毎回Show DOで次を照合する。

1. readiness・Pause・保守拘束等の停止gateを優先する。
2. active jobのpolicy・許可状態/reason、要求hash、公開中のShow状態、Feed世代G・Show状態世代S・cover世代Cの一致を確認する。
3. `read_target_kind=show`ならEpisode guardが空であること、`episode`なら既存の未登録または更新元revision/lifecycle条件を確認する。
4. coverのscalar identityを検証し、従来のcover拡張子・Episode lifecycle・承認済み音源判定へ進む。

guardはサーバー側で導出し、要求bodyから自由指定させない。配信ごとにjob本文・Show TOML・全Episode本文をparseせず、全音源HEADもしない。claimでは外部IOを待たず、正常更新で検証完了まで503になる窓を作らない。

Show要求がstale、旧contentが欠落、guardが不成立の場合は安全側に拒否し、候補を現行状態へ自動rebaseしない。副作用前の確定失敗後は、確定済み内容の通常配信へ戻る。Show更新は`state_version`を進めるため、旧Show世代で準備した後続draftがconflictになる既存仕様は維持する。

### 6.3 検証済みflagとblocked

Alarmはrunningを耐久化し、凍結要求hashを照合する。executorは旧Show/contentと公開Episode集合の同期検証に加え、**Show更新では旧cover CのR2 HEADをawaitし、key・size・SHA-256が確定indexと一致することを確認してから**guardを再照合して`read_verified=1`とする。その後に候補の素材検証・公開書込へ進む。旧coverの欠落・identity不一致・照合不能を検証済みにしない。

この旧cover HEAD待機中も、runningのscalar guardで旧内容を配信できる。blockedではさらに`read_verified=1`を必須とする。flagは候補の正当性・公開成功を意味しない。

Episode jobは画像を書き換えないため、旧coverのscalar参照を新guardへ追加しつつ、第2段階の旧content/media検証を維持する。Episodeの各公開で全画像・全音源をHEADする処理は追加しない。復元時の既存HEADは§9の参照先へ変更する。

## 7. 保存・公開の流れ

```text
確定済み: Show状態世代S、metadata M、Feed G、cover C、承認音源集合A

claim: G/S/Cと要求hash・種類をguardに保存しrunningへ
Alarm: running耐久化 → 要求hash照合
       → 旧content/公開Episode検証 → 旧cover Cのidentity照合
       → guard再照合、read_verified=1
       → 候補metadata/coverの検証（入力上限・署名・拡張子・凍結identity）
       → private Show metadataを保存
       → 新cover Nを一意keyへ保存・検証
       → 新metadataでFeed Nを一意keyへ保存・検証
       → 必要なFeed/cover cache purge成功をawait
       → 完了transaction:
           exact running request・期待Show世代・prepared sequenceを再照合
           metadata/cover identityを確定、cover_generation=N
           state_version=S+1、feed_generation=N
           job=succeeded、操作記録更新、次回Alarm予約

完了前の配信判定: G、C、A
完了後の配信判定: N、N、A
```

EpisodeのGUID・公開日時・revision・音源URL・承認indexをShow更新で変更しない。新FeedのEpisode集合は同ShowのFIFO開始時の確定状態から生成する。

R2 IOとpurgeはSQL transactionの外で、開始した処理はすべてawaitする。長いIO待ちを`blockConcurrencyWhile()`等で囲んで読取要求を止めない。preparedにはFeed/cover世代と検証済みcover identityを持たせ、commitで正確なjob sequenceと一致させる。pointerやmetadataだけの先行commitは禁止する。

## 8. cache ownerとHTTPの扱い

coverのcache propsを`{ showGeneration, coverGeneration }`へ変更する。Feedは既存の`{ showGeneration, feedGeneration }`、audioは既存の`{ showGeneration, episodeGeneration }`を維持する。資産種別ごとの許可fieldを厳密に検証し、cover世代は正のsafe integerに限定する。

gatewayの`decision.key`は従来の論理public keyを維持し、URLとの一致確認を外さない。cache owner内部でのみ、URLのShow ID・拡張子と信頼済みpropsのcover世代から保存keyを解決する。世代をquery/headerから採用しない。

- coverのHEAD、条件付き応答、GET/Rangeはすべて同じ世代のobjectへ固定する。
- 必要なpurge対象・成功条件は維持する。purge後・commit前の旧cover再取得は旧propsだけに入り、新世代要求へ混入しない。
- Cで許可された読取がNのcommit後に進んでもCを返す。旧coverをそのために保持する。
- 承認済みcover snapshotの欠落・読取不整合を検出したら503/no-store。未承認URLや拡張子不一致の404と区別し、固定keyや別世代へfallbackしない。
- GET/HEAD/Range、ETag/日付条件、外向け再検証header、認証header/cookie/queryの非転送を維持する。画像bytesが同じなら世代が違ってもETag一致・304を許す。

named cache owner・Worker version・propsによる分離と、毎回Show DOの最新gateを見る構造を維持する。旧判定済み応答が後続のPause等の後に完了することはあり得るが、新しい配信判定では停止を優先する。既に送信したbytesの取り消しや、完全な無遅延は保証しない。

## 9. lifecycle・障害・保持

Show復元では、保存済みSQLのmetadataとcover Cを使い、Cのkey・size・checksumをHEAD照合して新Feedを生成する。coverをコピー・再PUTせず、cover世代はCのまま保持する。Episode復元等のFeed生成も確定済みcover拡張子を使う。非公開化・復元の実行中の継続配信は有効にしない。

| 事象 | 扱い |
| --- | --- |
| 候補入力不正・base競合 | 公開書込前なら`failed`。旧SQL状態を維持 |
| 旧content/cover照合前の例外・中断 | 検証済みflagなし。blockedの配信は503 |
| 候補保存応答不明・purge失敗 | `blocked`。検証済みguardと許可reasonが一致すれば旧Feed/cover/audioを配信 |
| 完了transaction/次回Alarm予約失敗 | metadata/cover/Feed世代/job/操作記録を原子rollback。残存runningを再実行しない |
| 再生成・Alarm再配送 | 残存runningを`execution_interrupted`のblockedへ。永続guardとflagから同じ配信判断を行う |
| 要求破損・未知policy/reason・guard不一致 | 旧objectがあっても503 |

許可するblocked reasonは`execution_failed`、`execution_interrupted`、`validation_unavailable`のままとし、`stored_request_invalid`を拒否する。`validation_unavailable`も旧内容の照合を終えた後の候補読取等で失敗し、flagがある場合だけ許す。

遅い候補PUTが完了しても旧cover/Feedのkeyを上書きせず、SQL pointerも変えない。候補の採用・再送・取消推定・自動rollback・token解放を行わない。私有Show TOMLが候補内容になっていても成功扱いしない。

読取が続いてもjob・後続FIFOは停止したままで、Resume・共有Worker更新のdrain条件を緩めない。別Showの通常操作・配信の独立性を維持する。診断は既存allowlistを使い、本文・email・秘密・任意例外文は保存しない。

## 10. 形式と導入境界

本段階も**新規環境専用・移行なし**とする。既承認の内部形式変更・移行不要の方針に沿い、次を提案する。

| 識別 | 提案 |
| --- | --- |
| service config/protocol/layout | `schema_version=2`、`sqlite-sequential-v1`、必須`storage_layout="show-v1"`を維持 |
| queue schema | 4→5。guardの対象種別と旧cover世代を追加 |
| content schema | 5→6。確定cover世代・hash・sizeを追加 |
| `feed_storage` | `immutable-generation-v1`を維持 |
| healthの`cover_storage` | 必須`immutable-generation-v1`を追加 |
| healthの`publication_read_boundary` | `episode-revision-v1`→`show-episode-v1`。共通guardの新契約を識別 |

共有health schema、service/Showのhealth、制御DOのpeer照合、CLIの更新前検証を揃える。新CLIは欠落・未知値・旧値をprepare/配備前に拒否する。DOの起動/runtime選択も対応しないschemaを変更せず拒否する。固定coverをsnapshotへコピーする変換、旧列補完、旧job guardの生成、旧resource採用やfallbackは実装しない。

新形式内のcode-only更新・Pause/drain・全DOのnative probe・部分成功/未知応答保全は維持する。production entrypointは`src/sqlite-worker.ts`のまま、既存DO/cache class名・binding・compatibility date、要求/共有content schema version 1を維持する。

保持サービス、Episode追加/更新の実機環境、原本・journal・私有証跡は変更しない。今回の小規模実機指示は新規隔離環境の作成・配備・公開・最終Pauseだけに限定し、既存環境への互換配備・移行・cleanupへ流用しない。

## 11. 実装順序と検証

1. cover key helper、確定cover identity、schema/health識別と旧形式拒否を実装・試験する。
2. 初回公開を含む全Show writerを不変coverへ統一し、復元の読取参照も変更する。固定keyとの併存は作らない。
3. 配信props・cache ownerのcover世代解決を接続し、guardのShow/Episode分岐を揃えてからShow更新の継続配信を有効にする。
4. 以下の回帰と正式CLI経路を検証し、実装後に現行設計・SQLite/Show分離契約・利用ガイド・第1/第2段階の範囲記述を更新する。レビュー段階では現行仕様を書き換えない。

主な変更箇所は`src/sqlite-publication-{queue,content,executor}.ts`、cover key helper、`src/sqlite-feed.ts`、`src/public-assets.ts`、`src/lifecycle-cache.ts`、gateway/Workerのprops接続、shared health/runtime/control/CLI更新前検証と既存fixtureになる。Feed rendererの公開画像URLは変更しない。

| 試験 | 必須の確認 |
| --- | --- |
| metadata/cover/同時編集 | 検証、private Show TOML保存後、cover保存中/後、Feed保存後、purge待機・完了直前の各段階で旧Feed/画像hash・ETagと承認済み音源配信を維持 |
| cold/warm cache・遅い読取 | cacheなし、hit、purge後miss、C/Gの判定後にNがcommitする競合でも旧objectを読む。旧fillを新propsへ使わない |
| 候補隔離 | 候補coverがR2にあっても固定公開URLはCを返す。世代指定URLは404。固定keyを一度もPUTしない |
| 原子切替 | Show metadata・cover identity・Feed/Show世代・job/操作記録・次回予約を同時確定。Episode identity/media indexは不変 |
| 同じbytesの更新 | metadataだけの編集で画像が同じ、画像だけの編集でFeedが同じ場合を正しく扱い、ETag変更・常時200を誤って必須にしない |
| HTTP条件 | Feed/cover/audioのGET/HEAD/Range・ETag/日付条件、外向け再検証header、停止後no-storeを維持 |
| 初回・0 Episode | 初回の旧内容なし、公開済みでEpisode 0件の更新を区別する |
| 入力/guardの不一致 | stale Show世代、凍結素材差し替え、拡張子変更、target種別/各guard列のNULL・混在・未知値・世代破損を拒否 |
| 旧cover/contentの破損 | key/hash/size不一致・欠落・HEAD不能では検証済みにしない。確定画像読取欠落は503でfallbackなし |
| 故障と再生成 | 各保存・purgeの失敗/応答不明、SQL/Alarm予約rollback、再生成・再配送で候補非公開・後続停止・副作用非再実行。条件が成立するblockedだけ旧配信 |
| 非公開化・復元 | 世代を指定してgateを迂回できない。復元は既存cover Cを再検証・再利用し、新しいFeed世代の画像を誤参照しない |
| Episode回帰・連続操作 | Episode公開後のG≠C、Show更新後のEpisode更新、Show停止/復元、連続Show更新で正確な世代を使う |
| 明示停止・Show分離・共有更新 | Pause/readiness/保守拘束優先、別Showの独立性、blockedの共有更新拒否、同形式内code-only更新/probeを維持 |
| 形式/CLI | 旧schema/healthをprepare・配備前に拒否。新規init→Show公開/3種類の編集→Episode更新→停止/復元を単体CLIで確認。uploadだけで公開しない |

実装後は`bun test`、`npm run check`、`npm run build:cli -- linux-x64`、`git diff --check`を実行する。新しいlint・テストツールは追加しない。

ローカル検証: **549 tests / 0 fail（63 files、59.63秒）**、型検査・Linux x64単体CLI build・差分チェック成功。3種類のShow編集×旧cover HEAD/候補検証/private TOML/cover保存中/保存後/Feed保存後/purgeの21待機点、6故障段階と再生成、cover identity破損・guard不整合・初回/0 Episode・同bytesの304・遅い旧世代読取・形式拒否・CLI素材登録と明示公開を回帰へ追加した。cache hit/miss/旧fillの試験はローカルモデルであり、native cacheの実証とは区別する。

実機確認は小規模実機指示を受け、新規隔離環境・1 Show・短尺Episode 1件で完了した。同形式の異なる2画像を使い、3種類の編集と別のmetadata更新1回を観測した。前後ともrunningの計8取得組で旧Feed200/304、画像本文の旧hashまたはHEAD/ETag・304を確認。画像のみの更新ではFeed hash不変・304が正常に成立した。Episode更新・Show非公開化/復元と13 snapshot保持も確認し、最終ready/paused/drainedで保持した。詳細・観測方法の差と未実証事項は[実機記録](show_update_feed_live_verification_20261021.md)を参照する。

過去のEpisode試験をShow更新の実証には使わない。native故障注入・再配送・実cache hit/miss・全拠点purge・CPU/負荷は確認した範囲を分け、ローカル成功だけで完全な無停止、Free適合、Issue #13恒久解消を主張しない。

## 12. レビューで確認したい点

1. **公開cover URLは維持**し、private保存先のみ世代別にする。切替をまたぐ別HTTP要求で、旧Feedのcover URLが新画像を返すことを許容する。
2. Show publishごとにmetadataとcoverを組で扱い、画像bytesが同じでも新snapshotを保存する。部分upload/重複排除/画像拡張子変更は追加しない。
3. Feed/Show/cover世代をguardで保護し、隔離を確認できるblockedでは旧内容を配信する。停止gate・FIFO停止・未知IO保全は緩めない。
4. 旧cover snapshotと候補を保持し、schema 5/6・必須health識別を持つ新規環境専用とする。旧方式の移行・互換配備・cleanupは追加しない。

## 参照

- [Episode追加の設計](episode_add_feed_availability_plan.md)、[Episode更新の設計](episode_update_feed_availability_plan.md)
- [現行全体設計](initial_design.md)、[SQLite公開契約](sqlite_sequential_publication_implementation_plan.md)、[Show分離契約](do_show_separation_options.md)、[SQLite操作ガイド](../docs/sqlite_sequential_development.md)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/): bindingの条件付き保存・checksum・object metadata。REST staging PUTのCASや未知IOの取消保証へ拡張しない。
- [Workers Cachingのcache keys](https://developers.cloudflare.com/workers/cache/cache-keys/): propsによる分離。今回のnativeのcache/purge動作を実証済みとする根拠ではない。
