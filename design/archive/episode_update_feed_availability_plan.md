# Episode更新中のFeed継続配信設計

2026-10-21。**§12の全項目を承認済み・ローカル実装済み。** [Issue #50の第1段階](episode_add_feed_availability_plan.md)に続き、既存Episode更新の継続配信を実装した。検証結果と実機確認の範囲は別途記録する。保持環境の更新・移行は行わない。

後続の[Show更新の第3段階](show_update_feed_availability_plan.md)も実装した。本書の「Show更新は未対応」・schema 4/5・health `episode-revision-v1`は第2段階の記録。現行は不変cover・Show/Episode共通guard・schema 5/6・必須`cover_storage`と`show-episode-v1`を持つ新規環境専用であり、旧環境の変換・互換配備は提供しない。

## 1. 目的と提案の要約

**公開済みEpisodeの更新中も、更新前の確定済みFeedと、それが参照する旧MP3を読み取れるようにする。** 新しい内容は別objectへ準備し、保存検証・必要なcache purgeが成功してから、SQLの完了transactionで新Feedと公開承認を切り替える。

1. 第1段階の世代別・不変Feedと不変MP3を引き続き使う。公開URLは変更しない。
2. 新規追加だけでなく、既存Episodeのmetadata-only、audio-only、metadata/audio同時更新へ`preserve_committed`を広げる。
3. 更新元のEpisode revisionとlifecycle世代を開始時に保存し、旧公開状態が変わっていないことを配信時にも確認する。
4. 未完了の新MP3は、R2に保存されていても直リンクで公開しない。旧MP3は更新中も完了後も保持し、既存の公開承認・停止判定を適用する。
5. `blocked`でも旧内容の隔離を確認できれば旧Feedを配信する。jobと同Showの後続FIFOは停止したままにする。

最終目標は、Showの明示停止・非公開化等を除き、通常の追加・更新自体を理由にFeedを止めないこと。本段階ではEpisode更新までを実装し、Show更新は次の段階に残す。

## 2. 対象範囲

| 操作 | 本段階での扱い |
| --- | --- |
| 新規Episode追加 | 第1段階の継続配信を維持し、共通の保護条件へ整理する |
| 既存Episodeのmetadata-only更新 | 旧Feedを配信し、新Feedへの切替後も同じ音源URLを利用する |
| 既存Episodeのaudio-only更新 | 旧Feed・旧MP3を配信し、完了後の新Feedから新MP3を参照する |
| 既存Episodeのmetadata/audio同時更新 | 両方を準備し、一度の完了transactionで切り替える |
| Show metadata/cover更新 | 継続配信は未対応のまま。実行中503を維持する |
| Show/Episodeの非公開化・復元 | 通常更新へ含めず、従来の実行中の停止・lifecycle判定を維持する |
| Pause、readiness不一致、共有Worker更新の保守拘束 | 従来どおり503。旧Feedの保持を停止回避の根拠にしない |

ここでいうEpisode更新は、`action=publish`、`kind=episode`、`base_revision_id`ありの公開jobを指す。CLIの`update-episode`／`update-episode-audio`はstagingへのuploadであり、それだけでは公開せず、`publish-episode`で明示公開する契約は変えない。

物理削除、旧形式移行、snapshot整理、自動rollback、blockedのretry/release、Show別Worker配備は追加しない。RSS取り込み全体の一括原子公開も対象外。

## 3. 現行実装と変更理由

| 実装 | 現状 |
| --- | --- |
| `src/sqlite-feed.ts` | `base_revision_id`のないEpisode追加だけを`preserve_committed`に分類する |
| `src/sqlite-publication-queue.ts` | claim時に旧Feed/Show世代・要求hash・対象Episode IDを保存するが、対象未登録を必須とする |
| `src/sqlite-publication-content.ts` | running/blockedで上記の根拠と対象未登録を再確認する。Episode更新は503となる |
| `src/sqlite-publication-executor.ts` | 全Feedを世代別snapshotへ保存。新MP3・revisionは別keyへ不変保存し、旧MP3は変更しない |
| `src/lifecycle-cache.ts` | FeedのHEAD/GETを、配信判定が指定した確定世代のsnapshotから読む |
| `SqlitePublicationQueue.finish()`／`commitEpisode()` | purge後、Episode/content/media/Feed世代・job結果・操作記録・次回Alarm予約を原子的に確定する |

したがって、新しいFeed保存方式を追加する必要はない。一方、policyの対象を広げるだけでは既存の「対象Episodeが存在しない」確認で拒否される。これを削除するだけでも、更新元の差し替えや停止・復元を検出できない。**追加時の未登録確認と、更新時のrevision/lifecycle一致確認を明示的に分ける。**

既存の`target()`によるruntime/config、Show状態世代、Episode base revisionとlifecycle世代の検証、音源receipt・identity検証、凍結後のローカル編集拒否は維持する。継続配信policyは、更新を公開してよいという許可ではない。

## 4. 保存先と切替モデル

保存先は第1段階から変更しない。

```text
公開Feed URL:
  /podcasts/<showId>/feed.xml
private R2のFeed:
  public/podcasts/<showId>/feeds/<jobSequence>.xml

公開MP3 URL:
  /podcasts/<showId>/episodes/<episodeId>/<audioRevisionId>.mp3
private R2のMP3:
  public/podcasts/<showId>/episodes/<episodeId>/<audioRevisionId>.mp3

private R2のrevision履歴:
  public/episodes/<showId>/<episodeId>/revisions/<revisionId>.toml
```

例として、確定FeedをG、対象Episodeの現在revisionをR0、その音源revisionをA0、新job IDをJ、sequenceをNとする。

| 項目 | 更新中 | 成功後 |
| --- | --- | --- |
| 読み取るFeed | G | N |
| SQLiteの対象Episode revision | R0 | J |
| metadata-onlyのFeed内音源URL | A0 | A0 |
| 音源を含む更新のFeed内音源URL | A0 | J |
| A0の直リンク | 公開承認・lifecycle条件を満たせば配信 | 同じ条件で引き続き配信 |
| 新音源Jの直リンク | 未承認のため404 | 音源を含む更新が完了した場合だけ配信 |

**Episodeの現在revision IDと音源revision IDは同じとは限らない。** metadata-only更新を経たR0が音源A0を参照する場合もある。保護するbaseにはR0を保存し、音源の承認確認にはR0の`enclosure_url`から得るA0を使う。新revision IDをそのまま旧音源keyへ当てはめない。

Feedは既存の条件付きPUT・UTF-8 bytes長・SHA-256検証を、音源は既存のstreaming・300,000,000 bytes上限・checksum/size/object identity検証を維持する。旧snapshot・旧MP3・revision履歴は上書き・削除せず、TTLも設けない。内部世代URL、metadata、`system/`、`staging/`は公開しない。

## 5. 継続配信の永続的な保護条件

### 5.1 policyと追加列

`delivery_policy`の値は増やさず、`action=publish && kind=episode`を`preserve_committed`候補とする。Show更新・lifecycleは`exclusive`のままとする。分類はサーバーがstrict parse済みの凍結要求から算出し、受付時に保存、claim時に再照合する。

`publication_jobs`へ以下のnullableなscalar列を追加する。保護根拠が成立しないjobでは未設定のままとし、欠落を許可として解釈しない。

| 列 | 意味 |
| --- | --- |
| `read_episode_state` | `absent`または`published`。保護する開始時の状態を明示する |
| `read_episode_revision_id` | `published`の場合の現在revision R0。追加の`absent`ではNULL |
| `read_episode_lifecycle_version` | `published`の場合のlifecycle世代L0。追加の`absent`ではNULL |

既存の`read_feed_generation`、`read_show_version`、`read_episode_id`、`read_request_sha256`、`read_verified`は再利用する。`read_episode_state`の値とrevision/lifecycle列の組み合わせをDB制約および読取側の照合で検証する。Feed世代は正、状態世代は非負のsafe integer、revisionは正規のIDであることが必要。NULL同士の一致を、未検証と`absent`の両方の意味で使わない。

### 5.2 claim時の取得

`queued → running`と**同じ同期transaction**で、次の根拠を保存する。外部IOや本文parseを配信ごとの処理へ増やさない。

共通条件:

- 凍結要求と保存policy、runtime/config/window、要求・job・Show identityが一致する。
- 対象Showが公開中で、`state_version`が要求の期待値に一致する。
- 現在の`feed_generation`が正のsafe integerである。その時点の確定世代Gを取得する。

操作別条件:

| 種類 | claim時に必要な条件 | 保存する状態 |
| --- | --- | --- |
| 新規追加 | 要求にbaseなし、対象Episodeが未登録、期待lifecycle世代が初期値0 | `absent`、revision/lifecycle列はNULL |
| 既存更新 | 要求にbaseあり、対象が公開中、現在revisionと要求baseが一致、lifecycle世代も要求の期待値と一致 | `published`、R0、L0 |

claimではguardとrunningを別々に保存しない。正常な更新で「検証完了まで503」となる窓を作らない。不一致なら保護根拠を成立させず、従来の入力/base検証へ進む。この場合は安全のためrunning中503となり得るが、副作用前に確定失敗した後は確定済み内容を通常配信する。staleな要求を現行baseへ自動で読み替えない。

Feed世代Gはクライアント入力ではなく、claim時のSQLから取得する。待機中に別Episodeの正常公開が完了した場合、その最新Feedを保護できる。無関係なEpisode更新だけで対象draftを一律staleにする変更は加えない。

### 5.3 旧公開contentの検証

Alarmは従来どおりrunningの耐久化と凍結要求hash照合を行う。その後、executorは次の同期検証を済ませてから`read_verified=1`とする。

1. `target()`でShow/contentと対象Episode/base/lifecycleの整合を確認する。
2. `episodes()`で公開Episode集合を検証し、既存のFeed生成予算を維持する。
3. 既存更新の場合、旧baseの音源URLを同一Show/Episodeの承認済みpublic pathとして検証し、A0に対応するmedia indexのhash/sizeが旧baseと一致することを確認する。新音源を含む更新でも、この旧音源の確認を省略しない。
4. 保存guardと現在のSQL状態を再照合し、同じrunning jobだけを検証済みにする。

`read_verified`は候補metadata/audioの検証完了や公開成功を意味しない。旧公開contentの検証前の例外でblockedとなった場合は0のままで、旧内容を継続配信する根拠に使わない。検証とguardの確認を、候補の公開書込より前に置く。

runningではclaim時のscalar根拠が成立すれば旧内容を配信できるが、blockedではさらに`read_verified=1`を必須とする。この区別は第1段階を維持する。配信ごとに全revisionをparseしたり、全旧音源のR2 HEADを行ったりする方式にはしない。

### 5.4 配信時の照合

毎回gatewayからShow DOへ照会し、短い同期transactionで次を確認する。

1. runtime/readiness・Show binding・Pause・保守拘束のgateを優先する。
2. active jobがあれば、許可policy、要求hash、確定Feed/Show世代と保存guardの一致を確認する。
3. `absent`なら対象が依然として未登録、`published`なら対象が依然として公開中でrevision=R0かつlifecycle世代=L0であることを確認する。未知値、列の欠落・不正な組み合わせ、不一致は503。
4. blockedでは検証済みflagと、許可したreason codeも確認する。
5. 従来のShow/Episode lifecycle、cover拡張子、音源のmedia index承認判定へ進む。

対象が存在するという理由だけで更新中の音源を許可しない。新MP3はcommit前にmedia indexがないため404。旧MP3や他Episodeの音源は、それぞれ既存の承認を通ったものだけ配信する。停止・非公開化された過去revisionを再び承認する変更ではない。

追加と更新のguard照合はclaim・検証済み化・deliveryで同じ定義に揃える。共通条件と`absent`／`published`の分岐を明示し、配信処理にjob本文parseや候補R2 keyの採用を持ち込まない。

## 6. 更新の実行順序と公開切替

```text
確定済み: Feed G、Episode R0 / lifecycle L0、承認音源A0

受付: 凍結要求をqueuedで保存、policyはpreserve_committed
claim: 旧公開状態のguardを保存し、runningへ遷移
Alarm: running耐久化 → 要求hash照合
       → 旧Show/Episode/content/media整合を検証 → read_verified=1
       → 候補metadata/audio・identity・入力上限を検証
       → 新音源があれば不変keyへ保存・検証
       → 新revision履歴とprivate current metadataを保存
       → 新Feed Nを不変keyへ保存・検証
       → 必要なFeed/対象Episode cache purge成功をawait
       → 完了transaction:
           exact running request、base R0 / lifecycle L0を再照合
           新音源があればmedia indexへ承認を追加
           Episode/current contentを新revision Jへ更新
           feed_generation=N
           job=succeeded、操作記録更新、次回Alarm予約

完了前の配信判定: G、旧公開承認
完了後の配信判定: N、更新後の公開承認
```

既存の完了transactionを利用し、Feed pointer・音源承認・Episode revision・job結果を別々に先行確定しない。preparedのFeed世代とexact running sequenceの照合も維持する。通常更新ではEpisodeの`lifecycle_version`を進めず、非公開化・復元のABA検出に使う意味を変えない。

外部R2 IOとpurgeはtransactionの外で、開始した処理をすべてawaitする。外部IO待ち全体を`blockConcurrencyWhile()`等で囲んで配信要求を待たせる方式にはしない。同期SQLの短い区間を除き、公開処理と旧内容の配信を進められる構造を維持する。応答時間や完全な無遅延を保証するものではない。

### private current metadataの扱い

現行の`public/episodes/<show>/<episode>/metadata.toml`は更新途中で上書きされ得るが、public pathではなく、配信の正本にも使っていない。公開FeedはGの不変snapshot、対象inspection・base検証・次回Feed生成はSQLの確定済みcontent indexを使う。

本段階ではこのprivate objectの形式を変更しない。途中で新metadataが保存されてからblockedとなっても、それを公開済みrevisionとして採用・rollbackしない。管理inspectionも旧SQL revisionのままであることをテストする。将来このobjectを読取正本に変える場合は、候補と確定を分離する別設計が必要。

## 7. キャッシュと遅い読取

第1段階のFeed保存・cache ownerの世代解決をそのまま使う。

- cold cacheでもGの不変snapshotを取得できる。warm cacheだけの継続配信にはしない。
- purge後・commit前の再取得はGへ入り、Nの要求はNのcache propsを使う。必要なpurgeは省略しない。
- Gで許可された読取をNのcommit後に再開しても、Gを読む。固定keyから新Feedを読む競合を作らない。
- 旧音源は不変URLのまま、新音源は別URLとなる。metadata-onlyでは同じ音源URL・承認を再利用する。
- GET/HEAD/Range、ETag・日付の条件付き要求、外向け再検証header、認証情報の非転送を維持する。更新中に旧ETagが一致すれば304、切替後に内容・ETagが変われば新本文200となる。
- 確定snapshotの読取で欠落・不整合を検出したら503/no-store。候補世代・固定Feed key・SQL本文へfallbackしない。

切替点はSQL完了transactionであり、各要求が見る世代は配信判定時に決まる。切替前の旧Feed応答が切替後に届くことは許す。旧Feedから後でA0へアクセスしても、通常更新だけでは旧音源の承認を失わない。別HTTP要求間の完全な同時切替や、後続のPause・非公開化を超えるアクセス継続は保証しない。

## 8. 失敗・中断時の扱い

| 状態 | Feed配信と公開結果 |
| --- | --- |
| 正常な更新の検証・保存・purge待機中 | guardが一致するGを配信。新音源は未承認 |
| 副作用前の確定入力/base失敗 | `failed`。旧SQL状態を維持し、通常の配信判定へ戻る |
| 候補保存／purge失敗・結果不明 | `blocked`。検証済みguardと許可reasonが成立すればGを配信 |
| 完了transaction失敗 | content/media/Feed世代/job/操作記録/次回予約をrollback。残存runningを再実行しない |
| 再生成・Alarm再配送で残存runningを検出 | `execution_interrupted`としてblockedへ。検証済みguardが残る場合だけGを配信 |
| 要求破損・policy不一致、検証前の中断、guard不一致 | 503。旧objectの存在だけで許可しない |
| Pause・readiness不一致・保守拘束 | guardが成立していても503 |

blockedで許可するreasonは既存の`execution_failed`、`execution_interrupted`、`validation_unavailable`に限定する。`stored_request_invalid`と未知reasonは拒否する。`validation_unavailable`も旧content検証後の候補読取等で失敗し、`read_verified=1`である場合だけ許可する。

候補MP3や新Feedの遅いPUTが後から完了しても、旧Feed/MP3を上書きせず、SQL承認も追加しないため公開先は変わらない。候補objectを既存だからと採用したり、同じPUTや公開jobを再送したりしない。新音源が保存されたことを理由にFeedだけ先行切替することも禁止する。

旧Feedを読めても、job成功・復旧・drainedを意味しない。後続FIFO、Resume、共有Worker更新の拒否条件を緩めず、別Showの通常操作・配信の独立性も維持する。診断は既存allowlistを使い、任意例外文・本文・秘密を保存しない。

## 9. 永続形式と導入境界

新しいguard列と読取契約を曖昧なcode-only互換更新として扱わず、**本段階も新規環境専用・移行なし**とする。内部形式変更・移行不要という既承認の方針に沿い、次を提案する。

| 識別 | 提案 |
| --- | --- |
| サービス設定／protocol／layout | `schema_version=2`、`sqlite-sequential-v1`、必須`storage_layout="show-v1"`を維持 |
| queue schema | 3→4。Episodeの開始時状態・revision・lifecycle guardを追加 |
| content schema | 4→5。対応queueとの組み合わせと、更新時の継続配信契約を識別。content表の列構成は維持 |
| `feed_storage` | `immutable-generation-v1`のまま。Feed objectの形式は変えない |
| healthの必須識別 | `publication_read_boundary="episode-revision-v1"`を追加。追加専用の旧guard形式と区別する |

新しい必須health識別を共有schema・service/Show health・制御DOのpeer照合・CLI事前検証へ通す。新CLIは識別の欠落・未知値をprepare/配備前に拒否する。DOの起動とruntime選択でも旧queue/content schemaを変更せず拒否する。旧列へのNULL補完、DB変換、旧jobのguard生成、旧resource採用は実装しない。

第1段階の実機環境も、そのまま新Workerへ更新する対象ではない。保持環境・原本・journal・私有証跡に手を加えず、将来の実機試験は新規隔離環境を対象に別承認を得る。新形式内の通常code-only更新、全DOのPause/drain/probeと部分成功の保全は維持する。

公開要求・共有contentの`schema_version=1`、公開URL、CLI操作名は変更しない。production entrypointは`src/sqlite-worker.ts`のままとし、既存DO/cache class名・binding・compatibility dateも変更しない。

## 10. 実装対象と順序

| 対象 | 変更内容 |
| --- | --- |
| `src/sqlite-feed.ts` | Episode publish全体のpolicy分類。新規追加と既存更新を候補として扱う |
| `src/sqlite-publication-queue.ts` | schema、claim時のguard取得、要求との照合。既存FIFO・finishの原子性を維持 |
| `src/sqlite-publication-content.ts` | 追加／更新guardの照合、検証済み化、running/blocked配信、対応schema |
| `src/sqlite-publication-executor.ts` | 旧baseの音源参照・media整合確認と検証済み化の順序。immutable writerとcommitの責務は維持 |
| shared health／runtime／control／CLI更新前検証 | 形式識別、旧形式への配備前拒否、同形式内のcode-only更新回帰 |
| executor/integration/queue/Alarm/gateway/cache/CLIの既存テスト | 更新中の段階停止、失敗・競合、追加回帰、正式操作経路を確認 |

1. guardの不変条件・形式識別・旧形式拒否のテストを先に追加する。
2. 新規追加と既存更新のclaim／検証済み化／配信条件を揃える。旧MP3検証を公開書込前へ接続する。
3. metadata-only／audio-only／両方の段階待機・切替・blocked・再生成を実executor経由で試験する。
4. CLI・lifecycle・Show分離・共有Worker更新の回帰を実行する。
5. 実装後に[全体設計](initial_design.md)、[SQLite契約](sqlite_sequential_publication_implementation_plan.md)、[Show分離契約](do_show_separation_options.md)、[SQLiteガイド](../docs/sqlite_sequential_development.md)、[利用README](../README.md)、第1段階の範囲記述を更新する。レビュー段階で現行仕様を実装済みへ書き換えない。

## 11. 検証と受け入れ条件

既存のBun SQLite・模擬R2/cacheと実executor/gateway、正式CLI fixtureを用いる。配信判定の単体テストだけで完了としない。

| 試験 | 必須の確認 |
| --- | --- |
| 3種類の更新を途中待機 | 素材検証中、音源保存中／後、revision/current metadata保存後、Feed保存後、purge待機・完了直前で旧Feedのbytes/hash/ETagと旧項目を維持 |
| 旧アセットと候補の隔離 | 旧MP3・cover・他Episodeを配信。新MP3は保存後もcommit前404。未承認の過去音源も許可しない |
| metadata-only更新 | 音源PUTなし、音源URL/hash不変、新metadataのFeedへ切替。private current metadata保存後もinspectionはcommitまで旧base |
| 音源を含む更新 | 別URLへ保存、新Feedと新音源承認を同時確定。完了後も旧MP3のhash/size/承認を維持 |
| revisionと音源IDの違い | metadata-only後にaudio-only／同時更新を行い、R0≠A0でも旧MP3確認・配信・新Feed生成が正しい |
| cold/warm cache・遅い読取 | cacheなし、hit、purge後のmiss、G判定後にNがcommitする競合でも正しい世代を読む。Gの遅いfillをNへ使わない |
| HTTP互換 | Feed/audioのGET/HEAD/Range/ETag/日付条件、更新中304、変更後200、外向け再検証headerを維持 |
| stale/base・ABA | 古いrevision、古いShow世代、停止→復元を挟んだ同revision、凍結後素材変更を拒否。公開副作用なし。無関係なEpisodeの正常更新は一律拒否しない |
| guard破損 | 各列のNULL・未知state・revision/lifecycle/feed/hash不一致、policy不一致を拒否。baseなしで既存対象、baseありで未登録対象を取り違えない |
| 検証済み化 | 旧base/content/media破損ではflagを立てない。候補R2読取失敗はflagの有無でblocked配信を区別 |
| 保存・purgeの故障 | 音源/revision/current metadata/Feed保存の失敗・応答不明、purge失敗で未完了内容を出さない。正しいguardのblockedは旧内容を配信、後続停止 |
| SQL rollback・再生成 | 完了／次回Alarm予約失敗で原子rollback。再生成・再配送で副作用非再実行。遅い候補PUT完了でも新音源・Feedを採用しない |
| 連続更新・追加回帰 | metadata→audio→metadata、同時更新、別Episode更新・新規追加の後は、その直前の確定Feed/baseを保護する |
| 明示停止・非対象操作 | warm cacheでもPause/readiness/保守拘束は503。Show更新と非公開化・復元の停止gate、全revisionへのlifecycle適用を維持 |
| Show分離・形式境界 | AのblockedでもBは通常配信。共有更新はdrain不成立で拒否。旧形式のprepare/配備前拒否、新形式内の更新・probe成功 |
| 正式CLI | 新規公開→metadata-only→audio-only→両方→停止/復元/Pauseの経路。uploadだけで公開せず、accepted/queuedを成功にしない |

実装後は`bun test`、`npm run check`、`npm run build:cli -- linux-x64`、`git diff --check`を実行する。新しいテストツール・lintは追加しない。

実機確認は別承認後、新規隔離環境・1 Show・少数の短尺Episodeから始める。更新前後でactive状態を読み、両方runningだった取得組を更新中の証拠として数える。旧Feed bytes/ETag、旧MP3のRange/hash、候補MP3の404、完了後の新Feed・音源hash、最終Pauseを記録する。blocked故障注入・native再配送・実cacheのhit/miss・purge・CPU/負荷は、実際に確認した範囲を分けて報告する。

第1段階の[追加中の実機確認](archive/episode_add_feed_live_verification_20261021.md)は、本段階の更新中動作の実証には使わない。ローカル成功だけでnative output gate、完全な無停止、全Free適合、Issue #13恒久解消を主張しない。

## 12. 承認済みのレビュー結果

以下の4項目すべてについてユーザーの承認を得た。実装・ローカル検証の成功後、新規隔離環境での小規模実機確認も承認済み。旧環境への配備・移行・削除を含む承認ではない。

1. 本段階を既存Episodeのmetadata-only／audio-only／同時更新とし、Show更新・非公開化・復元は別段階とする。
2. 開始時のFeed/Show世代に加え、対象の公開状態・base revision・lifecycle世代を保護し、通常更新後も旧MP3の承認を維持する。
3. 隔離を確認できるblockedでは旧内容を配信するが、更新と後続FIFOは停止し、未知IO再送・retry/releaseは追加しない。
4. 新guard形式を内部schemaと必須health識別で区別し、新規環境専用・移行なしとする。

## 13. ローカル検証結果

`bun test`は**511 pass / 0 fail（62 files、59.57秒）**。`npm run check`、`npm run build:cli -- linux-x64`、`git diff --check`も成功した。

実executor・Bun SQLite・模擬R2とgateway/cache handlerで、3種類の更新の素材検証・音源保存・revision/current metadata保存後・Feed保存後・purge待機中の旧Feed/304と旧音源配信、新音源の未承認404、完了後の切替、遅い旧世代読取を確認した。保存応答不明・purge失敗・SQL rollback・再生成時のblockedと後続停止、guard/base/lifecycle破損、旧media破損・検証前中断の拒否も確認した。metadata revisionと音源revisionが異なる連続更新、旧schema拒否、必須health識別の欠落・未知値をprepare/配備前に拒否する経路を含む。

模擬cacheの試験はnativeの完全なhit/missやpurgeの実証ではない。実機結果は別記録に分ける。

その後、承認された[小規模実機確認](archive/episode_update_feed_live_verification_20261021.md)にも成功した。1 Show・2 Episodeで3種類の更新を行い、前後ともrunningの16取得組で旧Feed200/304・新候補音源404を確認した。更新後のFeed切替・旧新音源のhash一致・最終ready/paused/drainedを確認し、資源と証跡を保持した。nativeのblocked故障注入やCPU/負荷試験は行っていない。

## 参照

- [第1段階のFeed継続配信設計](episode_add_feed_availability_plan.md)、[小規模実機確認](archive/episode_add_feed_live_verification_20261021.md)
- [全体設計](initial_design.md)、[SQLite公開契約](sqlite_sequential_publication_implementation_plan.md)、[Show分離契約](do_show_separation_options.md)
- [SQLite操作ガイド](../docs/sqlite_sequential_development.md)、[Worker更新の復旧契約](sqlite_worker_update_recovery.md)
- [Cloudflare DO SQLite storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): 同期SQL transactionと外部IOの分離。旧内容配信のために長い外部IO待ちを全要求の排他にしない。
