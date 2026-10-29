# Episode追加中のFeed継続配信設計（Issue #50）

2026-10-21。対象: [Issue #50](https://github.com/simosako/castloop-v2/issues/50)。**承認済み・第1段階を実装し、新規隔離環境で小規模正常系試験に成功。** 世代別Feed、新規Episode追加からの段階開発、世代の蓄積、必要な内部形式変更と移行不要、および§8.1の案Bが承認済み。Show更新・既存Episode更新の無停止化は後続開発とする。[実機記録](archive/episode_add_feed_live_verification_20261021.md)とローカル故障試験の範囲を区別する。

## 1. 目的と提案の要約

後続の[Episode更新](episode_update_feed_availability_plan.md)と[Show更新](show_update_feed_availability_plan.md)も実装した。本書の追加専用の範囲・schema 3/4・固定coverは第1段階の記録として残す。現行リリースv0.7.0はFeed/Show/cover世代・対象種別・Episode revision/lifecycle guardと不変coverを持つschema 5/6・必須health識別を使う新規環境専用。旧方式の変換・移行は行わない。

**最終目標は、Showの明示停止・非公開化等を除き、追加・更新処理そのものを理由に確定済みFeedの読取を止めないこと。** 新しい内容は別のR2 objectへ準備し、公開条件が成立した後に配信先を切り替える。キャッシュが空でも同じ動作にする。

最初の開発では新規Episode追加を対象とし、Show更新・既存Episode更新の継続配信は後続段階で実装する。この限定は最初の実装範囲であり、恒久的な製品仕様ではない。

提案は次の組み合わせとする。

1. Feedを固定R2 keyへ上書きせず、公開jobのsequenceごとの不変snapshotとして保存する。
2. SQLiteの既存`feed_generation`を「配信する確定済みsnapshotの世代」とし、保存・必要なpurgeが成功した後の完了transactionでだけ切り替える。
3. **最初の段階では**`running`の新規Episode追加jobについて旧Feedの継続配信を許す。旧Feedが参照する公開済みcover/audioも、既存の承認判定を通ったものに限り配信する。後続段階で同じ仕組みを更新処理へ広げる。
4. Pause、readiness不一致、保守拘束は従来どおり503。`blocked`時も旧内容の隔離を確認できる新規追加では継続配信する。更新と後続FIFOは停止したままとし、未知IOの解放やjobの再実行は追加しない。

「新規Episode追加」は既存の`publish-episode`で、`action = publish`、`kind = episode`、`base_revision_id`なしの要求を指す。ローカルの`create-episode`やuploadだけでは公開しない。

## 2. 対象範囲と非対象

### 今回変更する動作

- 公開済みShowへの新規Episode追加中は、その直前の確定済みFeedをGET/HEAD/条件付き要求で読める。
- 既存Episodeが0件でも、Showの初回公開が完了してFeedがあれば継続配信対象になる。
- 追加するEpisodeの音源をR2へ保存済みでも、SQL完了前にはFeedにも直リンクにも公開しない。
- 完了後の配信判定は新世代を返し、新Episodeを含むFeedと承認済み音源を配信できる。
- RSS取り込みの各Episode追加も同じ経路を使う。取り込み全体の一括原子公開にはしない。

### 今回は変更しない動作

- Show初回公開には旧Feedがない。公開前は404、公開job実行中は503、成功後は200という区別を維持する。
- Show metadata/cover更新、既存Episodeのmetadata-only/audio-only更新は最初の段階では実行中503を維持するが、継続配信は後続段階の必須要件とする。非公開化・復元は通常更新と分け、最初の段階では従来のgateを維持する。
- 物理削除、独自domain、旧形式移行、blockedのretry/release、自動rollbackは追加しない。
- 公開URL、CLIの公開操作、要求identity、Show単位FIFO/Pause/Resumeは変更しない。

Feedだけを読めても既存音源を取得できない状態を避けるため、追加中の既存cover/audioの配信も対象とする。ただし、過去に非公開化・削除されたものや未承認の音源まで許可する意味ではない。

### 段階開発と後続の拡張条件

| 段階 | 継続配信の対象 | 必要な準備 |
| --- | --- | --- |
| 最初の開発 | 新規Episode追加 | 世代別Feedと確定世代の切替、旧公開アセットの継続配信 |
| 後続開発 | 既存Episodeのmetadata/audio更新 | 同じFeed切替を使い、旧音源と新音源の承認境界・旧Feedの音源参照を検証 |
| 後続開発 | Show metadata/cover更新 | 同じFeed切替に加え、coverも別objectへ準備し、確定した画像世代を読む方式を設計 |

Feed writerと読取先の世代解決は最初から全公開操作で共用する。継続配信の許可条件だけを段階的に広げ、Episode追加専用のFeed保存・配信経路は作らない。公開前の候補内容と公開済みの確定内容を区別する責務も共通にする。

現在のShow更新は固定keyのcoverを上書きするため、Feedの世代切替だけでは旧Feedと画像の整合性を維持できない。後続段階ではcoverの保存先・読取世代も分離する必要がある。今回はこの要件を記録し、coverの世代別保存自体は実装しない。

### 現行実装での旧Episode音源の保持

**MP3更新時も旧音源は残る。** `src/sqlite-publication-executor.ts`は音源を`/podcasts/<showId>/episodes/<episodeId>/<jobId>.mp3`に対応する別keyへ条件付き保存し、旧keyを上書き・削除しない。revision履歴も新規保存する。metadata-only更新では元の音源URLを再利用する。

`src/sqlite-publication-content.ts`の`commitEpisode()`は新音源の承認indexを追加し、旧音源の承認行を削除しない。したがって通常更新の完了後も、Show/Episodeが公開中で他の停止条件がなければ、以前の音源URLから旧版を取得できる。非公開化・削除・Pause等では旧版にもgateを適用する。保存されていることと、常に公開できることは別である。

この保持方式は、将来Episode更新中に旧Feedとその音源を配信するための基盤として維持する。旧版へ自動rollbackする機能があるという意味ではない。

## 3. 現状と修正が必要な理由

| 実装 | 現在の責務・制約 |
| --- | --- |
| `src/sqlite-publication-executor.ts` | 音源/revision/current metadataを保存し、固定keyの`public/podcasts/<showId>/feed.xml`を上書きしてからpurgeする |
| `src/sqlite-publication-alarm.ts`、`src/sqlite-publication-queue.ts` | purge後にcontent更新・job成功・操作記録・次回Alarm予約を同じstorage transactionで確定する |
| `src/sqlite-publication-content.ts` | 対象Showに`running`または`blocked`があれば、全公開アセットを503にする |
| `src/sqlite-gateway.ts` | キャッシュ参照より先にShow DOへ最新の配信可否を照会する |
| `src/lifecycle-cache.ts` | URLから決まる固定R2 keyをHEAD/GETし、propsの世代でキャッシュを分離する |

`running`の拒否だけを外すと、SQL上は旧世代なのにR2では新Feedへ上書き済み、という時間帯に未完了のFeedを返してしまう。また、旧世代で許可された遅い読取が、切替後に固定keyから新Feedを読む競合も残る。

したがって、**キャッシュ世代だけでなく、R2の読取先も同じ世代に固定する**必要がある。

## 4. 方式の比較

| 方式 | 評価 |
| --- | --- |
| `running`の503だけを削除 | 未完了Feedが漏れるため不採用 |
| warm cacheからだけ旧Feedを返す | cache miss・eviction・purge後に継続配信できないため不採用 |
| 旧Feedを一つの退避key／交互の2 keyへコピーする | 次の公開や遅い読取と再上書きが競合する。コピー途中の失敗状態も増やすため不採用 |
| SQLiteのcontentから読取時にFeedを生成 | 各配信で本文を読みRSS生成する構成になり、scalar判定＋R2 streamingという現行の責務を崩すため不採用 |
| **世代別の不変Feed＋SQLiteで切替** | cold cacheでも旧Feedを保持でき、既存の完了transactionと世代propsを利用できるため提案する |

Feedの保存方式は全writerで統一するが、最初の段階の実行中配信許可は新規Episode追加に限定する。coverまで世代別にする方式は後続のShow更新対応で扱い、今回は導入しない。

## 5. データと保存先

### 5.1 Feed snapshot

```text
公開URL（変更なし）:
  /podcasts/<showId>/feed.xml

private R2内の保存先（新規）:
  public/podcasts/<showId>/feeds/<generation>.xml

generation:
  Feedを生成したpublication_jobs.sequence（正のsafe integer）
```

- `generation`は対象Show DOで採番済みのsequenceを使う。時刻やクライアント入力から生成せず、別カウンターやR2のpointer objectは設けない。failed job等による欠番を許す。
- Show IDと世代からkeyを作る共通helperを設け、executorとcache ownerで使う。任意のR2 keyは受け渡さない。
- 新Feedは一意keyへR2 bindingの条件付きPUT（既存の不変音源と同様の`If-None-Match: *`）で保存する。UTF-8 bytesの長さ・SHA-256と保存応答を検証し、失敗・結果不明を成功へ変換しない。
- snapshotの上書き、未知PUTの再送、既存objectの採用をしない。固定keyの`feed.xml`への二重書込やfallbackも設けない。
- Feed生成の既存件数・本文量の予算を維持する。配信のために全文をDOへ通さない。

`feeds/<generation>.xml`は内部保存keyであり、新しい公開URLではない。public path parserは拡張せず、世代指定の直アクセス、`system/`、`staging/`、metadataへのアクセスは404とする。bucketのprivate設定も維持する。

つまり、Workerが公開URLへの要求に対して読み取るprivate R2 objectを、SQLの確定世代で選ぶ方式である。例えば現在が`feeds/10.xml`なら、`feeds/11.xml`の作成中も10を読む。11の保存・検証・purgeが成功してSQLが完了した後から11を読む。公開URLを変更したり、11を固定keyへコピーし直したりはしない。

### 5.2 確定世代

`publication_shows.feed_generation`を配信先の正本にする。初期値0は「確定Feedなし」。公開中のShowでは、正の世代に対応する検証済みsnapshotが存在することを不変条件とする。

| 操作 | Feed snapshot保存 | 成功transactionでの世代更新 |
| --- | --- | --- |
| Show初回公開／更新 | 新世代を保存 | 新世代へ切替 |
| Episode初回公開／更新 | 新世代を保存 | 新世代へ切替 |
| Show復元 | 新世代を保存 | 新世代へ切替 |
| 公開中ShowのEpisode非公開化／復元 | 新世代を保存 | 新世代へ切替 |
| Show非公開化、非公開Show内のEpisode非公開化 | Feedを書かない | 旧世代を保持し、lifecycleによって配信を拒否 |

現行の`advanceFeed()`はFeedを書かないlifecycle操作でも世代を進めるが、新設計では実際に保存したFeedがあるときだけ進める。Show/Episodeのlifecycleやその期待世代の更新規則は維持する。復元では保存済みmetadata/revisionを使って新snapshotを作り、GUID・日時・音源identityを変えない。

### 5.3 実行中の配信方針

`publication_jobs`へ小さいscalar列を追加する。

```sql
delivery_policy TEXT NOT NULL
  CHECK (delivery_policy IN ('exclusive', 'preserve_committed'))
```

- `enqueue()`がstrict parse済みの凍結要求から算出し、job・要求hash・操作記録と同じ受付transactionへ保存する。管理APIからpolicyを指定させない。
- 最初の段階では新規Episode追加の要求だけ`preserve_committed`、それ以外は`exclusive`。`claim()`で凍結要求から再算出して一致を確認し、不一致・破損は`stored_request_invalid`としてblockedにする。
- policyは操作名ではなく「確定済み内容を保持して読めるか」を表す。後続段階では旧公開アセットを変更しない条件を検証して、Episode更新・Show更新にも同じpolicyを適用できるようにする。将来対象であることだけを理由に、最初からそれらを許可しない。
- この列は配信時にjob本文をparseしないための派生値であり、公開成功や入力検証済みを示すものではない。実行前の要求hash、runtime/config/window、対象base/lifecycleの照合は省略しない。
- 対象Episodeが実際には既存、Show世代がstale等の場合は、従来の`target()`検証で副作用前にfailedとなる。旧Feedを読む許可は、その要求を公開してよいという許可ではない。
- `queued → running`と同時にpolicyを利用できるため、素材検証中だけ503になるような段階的な許可方式にはしない。

さらに、`claim()`の同じtransactionで、公開済みShowの期待世代が一致し、追加対象Episodeが未登録の場合に限り、次の保護根拠をjobへ保存する。旧内容の読取はpolicyだけでは許可しない。

| scalar列 | 保存する根拠 |
| --- | --- |
| `read_feed_generation` | 開始直前の確定Feed世代。正の世代がある公開済みShowのみ |
| `read_show_version` | 凍結要求が期待するShow状態世代 |
| `read_episode_id` | 未登録であることを確認した新規Episode ID |
| `read_request_sha256` | この根拠を束縛する受付時の要求hash |
| `read_verified` | 初期値0。Alarmの要求hash照合とexecutorの確定済みShow/content/公開Episode検証後にだけ1へ更新 |

配信時は現在の確定Feed/Show世代と要求hashが保存根拠に一致し、対象Episodeが依然として未登録であることをscalar SQLで確認する。完了後の変更や根拠の欠落・不一致は許可しない。blockedではさらに`read_verified=1`を必須とし、確定済みcontentの破損で検証を通らなかった場合や検証前の中断では503にする。検証前のrunningは未実行の候補が旧内容を変更しないため旧世代を読める。要求hashの失敗による`stored_request_invalid`は保存根拠があっても503とする。

## 6. 公開と読取の流れ

### 6.1 新規Episode追加

```text
確定済み: feed_generation = G、Episode集合 = E

受付: 新規Episode追加のjobをqueued、policy = preserve_committedとして保存
Alarm: runningを耐久保存 → 凍結要求hash・対象・素材を検証
       → 新規の不変音源/revision/current metadataを保存
       → E + 新EpisodeのFeedを世代Nの一意keyへ保存・検証
       → 必要なFeed/Episodeのcache purge成功をawait
       → 完了transaction:
           Episode/content/media indexを更新
           feed_generation = N
           job = succeeded、操作記録更新、次回Alarm予約

完了前の配信判定: GとEに基づく
完了後の配信判定: NとE + 新Episodeに基づく
```

`PreparedSqlitePublication`には保存するFeedの世代を持たせ、commit時に正確なrunning jobのsequenceと再照合する。外部R2 IO／purgeはtransactionに入れず、開始したIOはすべてawaitする。Feed世代・承認音源・job結果の一部だけを先行確定しない。

### 6.2 配信判定

gatewayの「毎回Show DOへ照会→許可された要求だけcache ownerへ転送」という順序を維持する。Show DO内の短いtransactionで次を判断する。

§8.1の案Bを適用し、実行中とblockedの双方で§5.3の保護根拠を照合する。

1. 現行どおりruntime/readiness、Show binding、保守拘束、Pauseを確認する。異常・停止中は503。
2. 対象Showのactive jobをscalarで確認する。`exclusive`、未知policy、保護根拠の不一致は503。blockedの理由は`execution_failed`、`execution_interrupted`、`validation_unavailable`だけを継続配信候補とし、要求破損等は拒否する。
3. `preserve_committed`と保護根拠が成立するrunning/blockedだけ通常の確定済みShow/Episode/media判定へ進む。公開済みShowと正の確定Feed世代が必要で、条件を満たさない場合は503。
4. Show非公開404／削除410、cover拡張子、Episode非公開404／削除410、承認済み音源revisionの判定を維持する。新規Episodeはcommit前にはindexにないため直リンクも404となる。
5. Feedには確定世代Gのprops、cover/audioには既存のShow/Episode世代propsを返す。job本文やmetadataを配信ごとにparseしない。

| 状態 | Feedへの応答 |
| --- | --- |
| 追加素材のupload中／追加jobがqueuedのみ | 旧Feed（200、条件一致時304等） |
| 新規Episode追加がrunning（検証・音源保存・Feed保存・purge待機中） | 旧Feed |
| 追加jobがsucceeded | 新Feed |
| 副作用前の確定失敗でfailed | 旧Feed |
| 追加jobがblocked | 保護根拠と許可した失敗理由が成立すれば旧Feed。それ以外は503 |
| Pause／readiness不一致／共有更新の保守拘束 | 503。warm cacheでも配信しない |
| その他の公開・lifecycle jobがrunning | 503 |
| 初回公開前でactive jobなし | 404 |

### 6.3 cache ownerとR2読取

- gatewayへ返す`decision.key`は既存の論理public keyのままとし、URLとの一致検証を維持する。任意の保存keyを許すためにその検証を外さない。
- cache ownerはFeedのときだけ、検証済み`feedGeneration`とURLのShow IDから内部snapshot keyを算出する。HEAD、条件付き応答、GET/Rangeはすべて同じkeyを使う。cover/audioの保存先は変えない。
- Feedのpropsは既存の`showGeneration`と`feedGeneration`を使い、`feedGeneration`は正のsafe integerに限定する。クライアントのquery/headerから世代やkeyを取り込まない。
- 許可されたFeed snapshotの欠落・読取不整合は503/no-storeとする。404へ隠したり、固定key・別世代・SQL本文へfallbackしたりしない。
- 認証header/cookie/queryの非転送、GET/HEAD/Range/ETag/日付条件、cache tagの外向け除去、成功応答の`max-age=0, must-revalidate`を維持する。

## 7. キャッシュ整合性と競合

R2 snapshotの世代とcache propsの世代を一致させる。Workers Cachingのnamed entrypoint・Worker version・propsによる分離は維持し、cache owner名・binding・compatibility dateは変更しない。

- **purge中のcache miss**: Gのsnapshotは変更していないため、旧Feedを再取得できる。
- **purge後、SQL完了前の旧cache fill**: Gだけに入る。完了後はNを指定するため新Feedへ混入しない。
- **Gで許可されてから完了後にR2へ到達した読取**: Gのsnapshotを読み、Gとして応答する。固定keyからNを読んでしまう競合をなくす。
- **Nで許可された読取**: Nのsnapshotとcommit済みmedia indexを使う。新Episodeの音源を公開できる状態とFeed切替を揃える。
- **連続追加**: 次のjob実行中は直前に確定したNを配信する。未完了の次世代は選ばない。

公開の切替点は完了transactionのcommitであり、各要求がどちらの世代を見るかは配信判定のSQL transactionで決まる。切替前に許可された応答が切替後に完了することは許すが、その内容は旧世代に固定する。切替後に新たに判定した要求へ旧世代を返さない。別HTTP要求間の完全な同時切替や、既に送信済みのFeed／音源の取り消しを保証するものではない。後続のPause・非公開化も新しい配信判定から適用する。

必要なFeed/cover/Episodeのpurgeは現行の対象・成功条件を維持する。世代分離を理由にpurgeを省略せず、purge失敗時に再書込やpointer先行更新で成功を装わない。

## 8. 障害、保持、容量

- Feed保存・音源保存・purge失敗／結果不明ではblockedとし、同Showの後続FIFOを止める。旧内容の読取は§8.1の採用条件に従う。新snapshotが存在していてもSQLで選ばれていなければ公開しない。
- 完了transactionの失敗ではcontent/media/Feed世代/job/操作記録/次回予約をrollbackする。残存runningは再生成・Alarm再配送時にblockedとして保全し、副作用を再実行しない。
- 復帰時の残存runningも、既存の中断検出でblockedにする。immutableな旧Feedが残っていることを復旧・Resume・更新許可の根拠にしない。
- 旧snapshotと未参照の候補snapshotに自動TTLやcleanupを設けない。遅い旧読取が残るため、単にjob完了やpurge成功を根拠に旧snapshotを削除しない。
- 非公開化後もsnapshotはprivate R2内に保持する。公開URLから過去世代を指定する経路はなく、現在のlifecycle gateを回避できない。
- 診断は既存allowlistを使い、Feed本文・metadata・任意例外文・秘密を運用記録へ保存しない。

公開ごとにFeed全体を一つ保存するため、保存量は各世代のFeedサイズの総和になる。初回取り込みのように1件ずつ増やすと、単純モデルでは累積量はEpisode数の二乗に比例する。通常時のFeed PUT回数は現行と同じ1回で、旧Feedのコピーも不要だが、R2の保存量・object数は増える。世代の蓄積は承認済みだが、無制限に無料という主張はしない。過去snapshot整理は、読取と記録保持の安全条件を別途設計するまで追加しない。

### 8.1 blocked時に旧Feedを止める利点・欠点

`blocked`は、更新途中の失敗・結果不明等で、そのjobを成功とも再実行可能とも扱えない状態を表す。ただし、新しい候補の状態が不明であることと、前回確定した内容が不正になったことは同じではない。

| 案 | 利点 | 欠点 |
| --- | --- | --- |
| A: 全blockedで配信503 | 現行の安全側の扱いを維持できる。jobの種類や旧payloadへの影響を区別せず停止でき、条件・テストが少ない | 新候補だけの失敗やpurge障害でも、正常な旧Feed・音源まで止まる。自動復旧しないため停止が長期化し得る。継続配信という最終目標には制限が残る |
| B: 旧内容の隔離を確認できるblockedだけ確定世代を配信 | 更新失敗と公開済み内容の可用性を分離できる。未完了の候補を出さずに、旧Feed・既存音源を継続配信できる | 旧世代が変更されないことを示す永続的な根拠と、破損・非公開化等を除外する条件が必要。読めていても更新は停止しているため、管理statusで障害を把握する必要がある |

**案Bを新規Episode追加に限定して採用する。** 次のすべてを満たせる場合に限る。

- 対象が確認済みの純粋な追加jobで、公開済みFeed/cover/audioを変更しない実行経路であることを、凍結要求と永続状態から判断できる。
- 直前の確定Feed世代と承認indexが変更されず、旧snapshotも保持されている。候補の遅いPUTが完了しても旧公開内容に影響しない。
- Pause、非公開化、削除、readiness不一致、保守拘束等の明示停止・安全条件は読取側にも適用する。
- 要求/policy/確定状態の破損や不一致、確定snapshot欠落、影響範囲を判定できないblockedは503とする。`preserve_committed`の列だけを根拠に全blockedを許可しない。

案Bでも、更新jobと後続FIFOは停止したままにする。未知IOの再送・取消・完了推定、token解放、成功への昇格、Resumeや共有Worker更新を許可しない。単に「旧Feedの読取を許す」だけであり、失敗したjobを回復したことにはしない。

旧内容を保護する根拠は§5.3の永続scalarとして実装し、再生成後も同じ照合を行う。残存runningからblockedへの遷移、purge結果不明・候補保存応答不明・要求破損を回帰テストする。Show更新等への将来の拡張も、旧payloadの隔離を成立させてから扱う。旧objectの存在や時間経過だけで安全と推測しない。

## 9. 永続形式と導入境界

本変更は**既存環境へそのまま配備できるcode-only互換更新ではない**。新規環境専用とし、旧固定keyからのsnapshot作成・DB変換・旧資源の採用は実装しない。世代別Feedのために必要な内部形式の変更、および旧方式のマイグレーション機能を提供しない方針は承認済みである。

| 識別 | 提案 |
| --- | --- |
| service config／protocol／layout | `schema_version=2`、`sqlite-sequential-v1`、必須`storage_layout="show-v1"`を維持 |
| 内部queue schema | 2→3。`delivery_policy`追加を識別 |
| 内部content schema | 3→4。同じ列名でも`feed_generation`の保存先・更新意味が変わるため更新 |
| healthの必須形式識別 | `feed_storage = "immutable-generation-v1"`を追加し、対応CLIとWorkerの組み合わせを検証 |

対応CLIは共有Worker更新の事前healthで形式識別を必須とし、欠落／未知値ならprepare・配備へ進まない。形式が違う既存サービスを「同じshow-v1だから互換」と判断しない。DOも対応しない内部schemaを初期化・変更せず拒否する。新形式でfresh initした後の通常code-only更新・全DOのruntime照合・Pause/drain/probe・部分成功保全は維持する。

これは新旧互換層ではなく、非互換な更新を始めないための拒否条件である。保持サービス`sq16r-6ec01dc6`、既存の原本・journal・私有証跡には手を加えない。新規環境の作成・配備・公開・実機試験は対象と範囲の別承認後とする。

## 10. 実装対象と順序

| 対象 | 変更内容 |
| --- | --- |
| `src/sqlite-publication-queue.ts` | schema、policyの受付保存・claim照合。FIFO、破損検出、完了transactionを維持 |
| `src/sqlite-publication-content.ts` | schema、確定Feed世代、追加jobだけの配信許可。Feed出力のないlifecycle操作の世代更新を修正 |
| `src/sqlite-publication-executor.ts` | 全Feed writerの一意snapshot保存、prepared世代、保存検証とcommit照合 |
| 新規のFeed key helper | Show ID・正の世代から保存keyを一意に算出。public pathは拡張しない |
| `src/lifecycle-cache.ts`、関連するprops検証 | FeedのHEAD/GET先を世代に固定。欠落時503、その他アセットと条件付き応答を維持 |
| `packages/shared/src/sqlite-service-api.ts`、runtime、CLI更新前検証 | 必須の保存形式識別と非互換更新の事前拒否 |
| Worker接続・テストfixture | 実executor、独立SQLite/Alarm、模擬R2/cache、CLI入口を新形式へ接続 |

1. key/形式/schemaとその拒否条件を先に実装・試験する。
2. 全Feed writerとcommitをsnapshot方式へ揃える。新旧方式の併存は作らない。
3. cache ownerの世代別読取を接続してから、新規Episode追加のrunning例外を有効にする。
4. 故障・競合回帰と正式CLI経路を検証する。
5. [全体設計](initial_design.md)、[SQLite契約](sqlite_sequential_publication_implementation_plan.md)、[Show分離契約](do_show_separation_options.md)、[SQLiteガイド](../docs/sqlite_sequential_development.md)、[利用README](../README.md)を実装済みの範囲に更新する。

## 11. 検証と受け入れ条件

既存のexecutor/integration/gateway/lifecycle-cache/queue/Alarm/runtime-updateとCLIのテストへ追加する。単にSQLのrunning条件を変更した単体テストだけで完了としない。

| 試験 | 必須の確認 |
| --- | --- |
| 新規追加を途中待機 | 素材検証、音源保存、snapshot保存後、purge待機、完了直前の各段階で旧Feedを取得でき、hash/ETagが旧Feedと一致し、本文に新Episodeがない |
| cold/warm cache | cacheなし、cache hit、purge後のcache missすべてで旧Feedを返す |
| 新音源の先行保存 | R2に新音源があってもcommit前の直リンクは404。既存の承認音源・coverは取得可能 |
| 成功切替・連続追加 | 新Feedと音源indexが同時に有効になり、次の追加中は直前の確定Feedを返す |
| 遅い読取・cache fill | G判定後に読取を止め、N完了後に再開してもGを返す。purge後のGのfillをNの要求へ使わない |
| 条件付き要求 | 旧ETagによる追加中の304、切替後の新本文200、HEAD/Range/日付条件、外向け再検証headerを維持 |
| 入力/base失敗 | failedで旧世代を保持し、公開副作用なし。policyが入力検証を迂回しない |
| 障害・SQL rollback | snapshot PUT失敗／応答不明、purge失敗、完了保存／次回Alarm予約失敗で新Feedを公開せず、後続停止。保護根拠が成立するblockedでは旧Feedを返す |
| 再生成・再配送 | 旧runningを再実行しない。blockedへ遷移し、候補snapshotを採用・削除しない |
| 停止gate | warm cacheがあってもPause/readiness不一致/保守拘束は503。blockedも保護根拠を照合する。別Showの配信に影響しない |
| 非対象操作 | Show公開・更新、Episode更新、非公開化・復元は実行中503を維持し、完了後は正しい世代とlifecycleへ進む |
| 初回・復元 | 旧Feedのない初回を継続配信扱いしない。Feedを書かない操作は世代を進めず、復元は保存identityを維持して新snapshotを作る |
| 経路と破損 | 世代URL/system/staging拒否、任意props拒否、確定snapshot欠落503、policy不一致blocked |
| 形式境界 | 旧queue/content schemaの拒否、形式識別のない旧Workerへの更新をprepare/配備前に拒否、新形式内のcode-only更新成功 |
| 正式CLI | Show公開→Episode追加→更新→非公開化/復元→Pause/Resumeの既存経路を維持し、accepted/queuedを公開成功としない |

実装後に`bun test`、`npm run check`、`npm run build:cli -- linux-x64`、`git diff --check`を実行する。新しいlint等は追加しない。

Cloudflare実機でのDO output gate・Alarm再配送・実Workers Caching/purge・CPU/遅延はローカルfixtureと区別する。必要な実機試験は新規隔離環境で別承認後に計画する。ローカル成功だけで無停止の実機実証、Free適合、Issue #13恒久解消を主張しない。

## 12. レビュー結果

### 承認済みの方針

1. Feedは世代別の不変objectへ保存し、公開条件成立後に読み取るobjectを切り替える。
2. 最初の開発は新規Episode追加。最終的にはShow更新・既存Episode更新でも、確定済みFeedを止めずに読めるようにする。初回実装もその拡張を前提に共通化する。
3. 世代別Feedを蓄積してよい。必要な内部形式変更を認め、旧方式からのマイグレーション機能は作らない。
4. `blocked`時は案Bを採用し、旧内容の隔離を確認できる追加jobだけ旧Feedを配信する。job・後続FIFOの停止、明示停止gate、未知IO保全は維持する。

## 13. ローカル検証の範囲

実executor、Bun SQLite、模擬R2、gateway/cache handlerを接続し、素材検証・音源保存・snapshot保存後・purge待機で旧Feedが読めること、成功後の新Feed切替、旧世代の遅い読取、304/HEAD/Range、未公開音源の404を回帰試験した。validation/音源/snapshot/purge/SQL完了の失敗、再生成後のblocked、保護根拠・要求破損、確定snapshot欠落、既存候補の採用拒否、旧形式への配備前拒否も対象とした。

検証結果: `bun test`は**479 pass / 0 fail（62 files、54.56秒）**。`npm run check`、`npm run build:cli -- linux-x64`、`git diff --check`も成功した。nativeのDO output gate、実Workers Cachingのwarm hit・purge・再配送・性能は模擬試験と区別し、実環境への配備・公開は行っていない。

その後の別承認による[小規模実機確認](archive/episode_add_feed_live_verification_20261021.md)では、commit `62cd198`の単体CLIから新規隔離環境を配備し、1 Show・2 Episodeの正常追加と最終Pauseを確認した。前後ともrunningだった16取得組で旧Feedの200/304と新音源404を確認したが、blocked故障注入・native再配送・性能の実証ではない。保持サービスへの配備・移行はしていない。

## 参照

- [Issue #50](https://github.com/simosako/castloop-v2/issues/50)
- [現行全体設計](initial_design.md)、[Show分離契約 §6](do_show_separation_options.md#6-採用した案cの実装契約)、[SQLite公開契約](sqlite_sequential_publication_implementation_plan.md)
- [Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/): 成功したbinding書込のread-after-writeと、結果不明のin-flight IOの区別。REST PUTをCASとして扱う根拠にはしない。
- [DO SQLite storage / transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/): 同期SQLのtransactionと外部IOの分離。
- [Workers Caching cache keys](https://developers.cloudflare.com/workers/cache/cache-keys/): named entrypoint・Worker version・propsによる世代分離。今回の実機動作を検証済みとする根拠にはしない。
