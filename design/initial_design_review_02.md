# `initial_design.md` レビュー（第2サイクル）

- 作成日: 2026-09-23
- 対象: [`initial_design.md`](./initial_design.md)、[`initial_design_review_01.md`](./initial_design_review_01.md)、[`show-template.toml`](./show-template.toml)、[`episode-template.toml`](./episode-template.toml)、[`AGENTS.md`](../AGENTS.md)
- 目的: 第1サイクルで採用した構成を前提に、M0〜M2を実装するための残る判断と失敗時の振る舞いを明確にする
- 状態: 一部確定、一部保留。以下の決定記録と各節の追記を優先して読む。初回の選択肢表は比較履歴として残す

## コメントを受けた決定記録（2026-09-23）

| 項目 | 状態と決定 |
| --- | --- |
| R2-01 | **A採用**: `published_at`は引用符付きRFC 3339文字列。`create-episode`が実行時の現在日時を初期値としてTOMLへ記入する。未来日時・公開後の手動変更は引き続き保留 |
| R2-02 | **A採用**: `site_url`は必須。`create-show`が入力値を取得してローカル`show.toml`へ記入する。具体的な自動取得元は未確定 |
| R2-03 | **B採用**: `create-show` → ローカル情報・画像を編集 → `update-show`でTOML/画像をstaging → `publish-show`で公開。画像更新時は既定の`cover.<ext>`キーを上書きしcache tagをpurge |
| R2-04 | **A採用**: git管理外のローカル状態に未公開jobIdを保持。R2に下書き・完了jobをどの程度残すかはR2-06で決める |
| R2-05 | **A採用**: managed Cloudflare Queueを継続し、Show/Episodeを通じて同一Showの未完了公開は1件まで。QueueのFIFOは仮定せず、原子的な受付予約と障害回復の実現方法をM0で検証 |
| R2-06 | **A採用**: 一時的失敗はmanaged Cloudflare Queueの有限回数の自動retry、尽きたメッセージはDLQに隔離。job statusはR2で確認し、管理者が明示的に回復する。状態遷移・保持期間・予約解放の詳細は保留 |
| キー名 | **`staging/`採用**: 第1サイクルの`temp/`を置換し、Show/Episodeの下書きとcommit markerをこのprefixに置く。公開Workerは配信しない |
| R2-07 | **A採用**: Wrangler subprocessと標準認証を使う。MVPのMP3入力上限は**300 MB（300,000,000 bytes）**。超過時はupload前に拒否する |
| R2-08 | **設定ファイルA採用**: ルート`castloop.toml`。Show IDの自動生成と一意性確保は検討中 |
| R2-09 | **A採用**: purgeが成功するまで公開完了にしない。失敗時は冪等に再試行する |
| R2-10 | **採用**: 記載の整合・検証作業をM0/M1の着手・完了条件に含める |

### R2-03: AとBの操作性・実装負担

**Bの方がEpisode操作と似る。** Aでも「`publish-show`まで外部に出ない」は満たせるが、Episodeだけが`update`を経由することになり、管理者には違いを覚えてもらう必要がある。Bなら`create-show`→ファイル・画像の編集→`update-show`→`publish-show`で一致する。音源はShowにないので、`update-show`がTOMLとカバー画像を同時にstagingするか、画像専用コマンドを加えるかは別途選ぶ。

Bの主な費用は、Show用のstagingキーとjobId/状態、Showのcommit marker、再送・stale local TOML/画像のチェック、Episodeとのfeed更新競合の実装である。`update-show`で画像までstagingした後に管理者が画像を差し替えた場合、古い版を`publish-show`してはならない。Showの公開もWorkerからfeedとカバー画像のcacheをpurgeする必要がある。Episodeと同じQueue/consumerにShow commitを届ければ個別のqueueサービスは不要だが、**Show用のイベント対象キーをD-06に追加**し、公開処理を冪等にする。AでもShow公開のWorker呼び出しとpurge経路は要るため、Bだけの費用ではない。

**採用したB:** `update-show`はローカル`show.toml`と画像を同じ未公開Show jobIdの`staging/shows/<showId>/<jobId>/`に置く。`publish-show`前にローカルTOMLと画像の変更を再検査し、古いstagingの公開は拒否する。`commit.json`作成後はjobを凍結する。ShowのcommitもEpisodeと同じR2 Event Notification・Queue・consumerで処理する。更新時のカバー画像は既定の`public/podcasts/<showId>/cover.<ext>`に上書きし、feedと画像のcache tagをpurgeする。画像の**拡張子を変更する場合**に同一キーを保つ方法は別途検討する。tag purgeはCloudflare側のcacheだけを対象とし、利用者のブラウザー等のcache期間も設計する。

### R2-04・R2-06: 完了jobの保持と音源の世代

**保持すべきものは3種類ある。** (1) 編集中の`staging/`、(2) 完了/失敗jobのsnapshotとstatus、(3) `public/`の公開済みrevision metadataとMP3。(2)のTOML・commit・statusは小さいので長期保存が有用。(1)と(2)のMP3は公開後も一定期間置けば障害解析・再試行がしやすいが、(3)へコピーした後は重複占有になる。Cloudflare R2の現行Standard料金は**10 GB-month/月の無料枠後 $0.015/GB-month**。300 MBの音源を10個追加保持すると約3 GB-monthで、他の保存量も含め無料枠内なら保管料はかからない。料金と対象期間は変わり得るのでM0で再確認する。

推奨候補は「編集中・失敗後で回復可能なjobは自動削除しない」「完了jobのTOML/commit/statusは長期保持」「完了jobの**staging MP3だけ**診断・再試行に十分な期間後に削除」。`staging/`全体へ年齢だけの一律lifecycle ruleを掛けると未公開の編集中jobも消すので避ける。`public/`の旧MP3はFeedやrevision履歴から参照される可能性があり、現行MVPの『immutable mediaと履歴を維持』という規約のまま期限で削除してはいけない。旧公開音源の削除や履歴からの参照変更は別途方針変更が必要。正確な保持日数と回復不能jobの扱いは次のR2-06で決める。

### R2-05: R2をFIFO queueとして使えるか

**結論: `R2.list()`をtimestamp順に読むだけでは、FIFOを保証するqueueにはならない。** R2のlistはキーの辞書順であり、objectのupload時刻で自動整列されない。結果を時刻でソートしても、別端末の時計ずれ・同時刻・遅れて完了したuploadで受付順を確定できない。例えばjob AのPUTが遅れている間にjob Bが先に完了しpollerがBを処理すると、後で見えたAを時刻順に遡って先行処理することはできない。R2の強い整合性は『完了した書き込みが見える』ことを保証するが、『まだ書かれていない先行jobがない』ことは保証しない。

R2 polling方式にするなら、Cron等での定期起動、重複pollerの排他、各メッセージのclaimと完了記録、途中停止からの回復、retry、放置jobの隔離、監視が必要。時刻順キーだけでは原子的な連番の受付にならない。**managed QueueをR2で置き換える方が、少量のPodcast更新でも実装・運用はむしろ重い。** Cloudflare Queuesは順序保証こそないが、通知・再配送とDLQを提供するので維持を推奨する。Free planは現行で10,000 operations/日を含み、1配送は通常write/read/deleteの約3 operations（再試行は追加）なので、想定の少量更新に性能・費用面で過剰とは考えにくい。Free planのメッセージ保持は24時間で、長期のjob履歴はR2 statusに残す。

**採用したAではFIFOをQueueに求めない。** 同一Showの未完了publishを1件に制限し、先のjobが完了・回復した後にだけ次のcommitを受け付ける。違うShowの配送順はfeedが別なので公開順をそろえる必要がない。ただし『空き確認→予約PUT』では並行CLIのraceが残り、**条件付き予約（R2 bindingなどで原子的に作る）、処理完了・purge後の解放、障害後の回復、古い処理の再入防止**が不可欠。Wranglerの通常の`r2 object put`だけで安全な条件付き予約ができるとは確認できていない。Queueの並列度1だけでFIFOや排他を宣言しない。

**受付契約:** 同一Showで`publish-show`と`publish-episode`は同じ受付枠を使う。publish開始時に原子的にjobIdを予約し、既に未完了jobがあればcommit markerを書かず受付を拒否する。予約成功後にのみ入力snapshotを固定し、`staging/shows/.../commit.json`または`staging/episodes/.../commit.json`を最後に書く。consumerの処理と必要なcache purgeが成功してからjobを完了し、対応する予約だけを解放する。**予約後・marker前にCLIが停止した場合、処理途中で停止した場合、失敗/再試行/長期滞留した場合の回復、古い配送による新予約の誤解放を防ぐfencing**はR2-06とM0の詳細設計事項である。Wrangler OAuth/API tokenで原子的な予約操作を安全に呼ぶ経路も未決定。

### R2-08: Show IDを生成する場合

D-13で決めたShow IDは人間可読slug、最大32文字、作成後不変。例えば`show-20260923-a1b2c3d4e5f6d7e8`は30文字で形式上は適合するが、番組名を表す余地がほとんどない。後半を`crypto.getRandomValues()`由来の64-bit乱数とすると、同時刻でも衝突確率は非常に低い。ただし**timestamp＋hash/乱数は『常に一意』の証明ではない**。同じ入力のhashは同じ値、乱数にも衝突の可能性があり、命名の意味も`my-podcast`より弱くなる。したがってID予約を省略する根拠にはできない。

| 案 | 操作 | トレードオフ |
| --- | --- | --- |
| A（推奨候補） | `create-show <showId>`を基本にし、ID省略時だけ短いランダムslugをCLI生成。サーバーで原子的に予約し、衝突時は生成し直す | 人間可読IDを維持でき、管理者が選べる。予約のAPI/Worker経路が要る |
| B | 全Show IDをtimestamp＋乱数slugでCLI生成し、衝突時に予約で再試行 | 入力が減るが、URLに意味のある名前を付けられない。予約はなお必要 |
| C | 予約せずtimestamp＋乱数のみで作成 | 実装は小さいが、『Show IDは同一サービス内で一意』を厳密には保証できない。衝突時に後から発見してもIDは不変 |

ユーザー提案を採るなら**ランダム値＋原子的予約/衝突時再生成**を推奨する。R2-07のWrangler主体のCLIでは予約だけをどう原子的に行うか（認証付き同一Workerの管理操作、条件付き操作に対応した別経路など）をM0で確かめる。代わりに管理者が`showId`を指定する方式を維持するなら、生成機能はMVPの必須ではない。

### `temp/`から`staging/`への改名（採用）

下書きは`publish-*`前の正式な入力であり、完了jobも診断や回復のため一定期間残す。`temp/`は『すぐ消すファイル』という誤解を招くので`staging/`へ改名した。`staging/episodes/<showId>/<episodeId>/<jobId>/...`と`staging/shows/<showId>/<jobId>/...`を使う。R2 Event Notificationは`staging/` prefixと`commit.json` suffixのobject-createのみを同じQueueへ届け、consumerは認めたShow/Episode pathを検証する。第1レビュー中の`temp/`は当時の検討履歴であり、実装には使わない。まだ実装と公開済みデータはないので移行作業は生じない。

## 前提と今回の読み方

第1サイクルのD-01〜D-14は採否が決定済み。1サービス1 private R2バケットと公開用Worker、ローカルTOMLを編集元、`update-episode`と`update-episode-audio`は下書きへの個別uploadのみ、`publish-episode`で初めて`commit.json`を作る。R2 Event Notification → Queue → 1並列のconsumer、R2 job status、Workers Cachingを使い、Episode削除はMVP対象外。これらの方針を再選択する文書ではない。

第1レビューの案A〜Cは当時の比較履歴なので、**本書の案A〜Cは新しい詳細仕様の選択肢**である。上の決定記録はコメント反映後の最新版で、以下の案の比較表は選択経緯として残す。後段の「回答用一覧」に未決定事項をまとめる。

## 第2レビュー作成時点で見つかった矛盾・実装上の穴

1. `initial_design.md`のShow作成節には「showIdに使って良い文字や最大長は未決定」とあったが、D-13でslugと最大32文字が確定済み。今回、設計本文を修正した。
2. `initial_design.md`は`castloop-init.toml`を保存すると書いていたが、R2-08で`castloop.toml`を選択したので修正した。`service_id`の入力方法、サービス名とバケット名の対応は引き続き未確定。
3. ShowのID予約先`system/shows/<showId>/show.toml`は、未編集のローカルテンプレートと公開済みShow情報の両方を表すには曖昧。`update-show`が下書きを置く`staging/`とは別に、予約と公開snapshotの区別が必要（R2-08）。
4. `site_url`の省略が許される一方でRSS channelの`link`は必須だった。R2-02で必須入力に決定し設計本文を修正した。CLIに値をどう与えるかは確認待ち。
5. `commit.json`を最後に書きQueueを1並列にしても、**commit順に配送されるわけではない**。`jobId`だけでは順序比較できず、別々のR2 objectである`metadata.toml`と`feed.xml`も一括更新できない（R2-04〜R2-06）。
6. Workers Cachingのtag purgeは**キャッシュを持つWorkerのentrypoint単位**。Queue handlerから同じWorker内で呼ぶ場合も、対象のfeedがどのentrypointでキャッシュされたかをM0で確認する必要がある（R2-09）。

## R2-01: `published_at`の入力、公開日時、未来日時

**問い:** TOMLの構文と初回公開後の日付の意味をどう固定するか。RSSの`pubDate`はRFC 2822で出力するというD-07は維持する。

| 案 | 入力例 | 利点 / 注意点 |
| --- | --- | --- |
| A（推奨） | `published_at = "2026-01-02T10:00:00+09:00"` | RFC 3339の引用符付き文字列に限定。offset・秒を要求し、パーサー差を抑えやすい。RSS出力時に変換する |
| B | `published_at = "Fri, 2 Jan 2026 10:00:00 +0900"` | RSSに近いが、曜日の整合性やパーサーの許容表記の制限が必要 |
| C | `published_at = 2026-01-02T10:00:00+09:00` | TOML日時型。ただし`@iarna/toml`で元のoffsetがどう扱われるか検証が必要 |

日時の表記に加え、**初回の`published_at`は管理者の入力、メタデータ/音源更新後も同じ値を維持し、`updated_at`はシステムが生成**する案を推奨。未来日時は予約公開機能を持たないMVPでは拒否する案を推奨する。例えば公開が10月1日でも`published_at`が9月1日ならRSSには9月1日が入り、新着の並びはその値で決まる。過去日時の許容範囲、公開後の`published_at`の手動修正を許すかも決めたい。

**決定:** 案A。`create-episode`が現在日時を初期値として記入する。**保留:** 未来日時を拒否するか、公開後の日時変更を許すか。

## R2-02: `site_url`省略時のRSS channel `link`と公開URL

**問い:** `site_url`を省略できるか。RSS channelの`link`はサイトURL、`atom:link rel="self"`はfeed自体のURLとして区別する。

| 案 | 動作 | 利点 / 注意点 |
| --- | --- | --- |
| A（推奨） | `site_url`を必須にし、省略・空文字は公開時エラー | Webサイトを持たない番組には不便。MVPのWorkerに新たなページは不要 |
| B | 省略時に`<public_base_url>/podcasts/<showId>/`で簡易Showページを返し、そのURLをchannel `link`にする | サイトのない番組も始めやすいが、ページの公開・cache・更新が必要 |
| C | 省略時はfeed URLをchannel `link`にも使う | 実装は小さいが、channelが対応するサイトのURLとしては意味が弱い。RSS validatorとディレクトリ側で要検証 |

独自ドメインを後から導入した場合、生成済みfeed内の`atom:link`、画像URL、enclosure URLの更新と旧URLの扱いも別途設計する。MVPでは`public_base_url`を正規URLとし、各公開URL pathをShow公開時に確定する必要がある。

**決定:** 案A。CLIが`site_url`を`show.toml`へ初期記入する。サイトを持たないShow向けの代替ページはMVPでは設けない。**要確認:** URLを管理者へ対話/flagで尋ねる方式でよいか。`public_base_url`だけからShowの実在するWebサイトURLは導出できない。

## R2-03: Show情報・カバー画像をいつ公開するか

**問い（決定済み）:** `create-show`後に編集された`show.toml`と`image_path`の画像を、どのコマンドが検証・R2へ反映し、いつfeedへ反映するか。第1レビュー時点では未決定だった。

| 案 | 操作例 | 利点 / 注意点 |
| --- | --- | --- |
| A（当初の推奨） | `create-show` → TOML/画像を編集 → `publish-show <showId>` | Show情報と画像を検証後、一緒に公開。Show変更時も同コマンドを使い、Episode公開とは独立できる |
| B（操作性重視なら推奨） | `update-show`でTOML/画像をR2へstaging、`publish-show`で確定 | Episodeと操作感が揃うが、Show用の下書きキー・jobと通知経路も増える |
| C | 最初の`publish-episode`でShow情報・画像も自動公開 | コマンドは少ないが、Showだけの修正方法と初回公開時のエラー処理が曖昧になる |

採用した案Bでも、`create-show`は既定の`system/shows/<showId>/show.toml`を**予約記録**として利用してよいか、予約用に別キーが必要かを明記する（R2-08）。`publish-show`前に検証する事項: Show schemaと`show_id`、画像ファイルの存在・形式・サイズ、必須の`site_url`、stagingとローカルの一致。公開後は画像URLのGET/HEADを確認する。Show情報の公開snapshot、画像の書き込み、feed再生成・purgeの順序と失敗時の再試行を詳細化する。初回Episode公開はShowが公開済みであることを必須とする案を推奨する。

**経路上の注意:** Workers CachingのpurgeはWorkerの対象entrypointから行う。CLIがR2へShow情報を直接uploadするだけでは、既にcacheされたfeedをpurgeできない。Show用commit markerを`staging/shows/`へ追加し、Episodeと同じconsumerから必要なcache purgeを行う（entrypoint scopeはM0で検証）。

**決定:** 案B。`create-show` → 管理者がTOMLと画像を編集 → `update-show`で両方をstaging → `publish-show`の明示的操作で公開。画像更新では`public/podcasts/<showId>/cover.<ext>`を上書きし、画像とfeedのcache tagをpurgeする。**保留:** 画像拡張子の変更、クライアント側cache期間、予約と公開snapshotの分離方法。

## R2-04: Episode下書きの識別、凍結、入力の再利用

**問い:** どのjobIdにuploadするかをCLIがどう覚え、`publish-episode`が「検証したのと同じ版」をどう固定するか。

| 案 | 下書きの管理 | 利点 / 注意点 |
| --- | --- | --- |
| A（推奨） | Show作業ディレクトリ内にgit管理外の小さなローカル状態ファイルを置き、Episodeごとの未公開jobIdを保持。`publish`後は新jobIdを採番 | 管理者の編集元がローカルというD-03に沿う。別端末の競合検出が必要 |
| B | `system/`のR2側にEpisodeのactive draft pointerを置く | 端末をまたげるが、active pointerの同時更新・回復が必要。ローカルTOMLとの不整合を検出する |
| C | 毎回`--job-id`を渡す | 隠れた状態がないが、手作業が増え、音源のみ更新時もID管理が必要 |

共通条件: 新規はTOML/MP3両方、既存Episodeは変更した片側だけをstagingし、もう片側は**公開済みrevisionへの明示的な参照**とする。`commit.json`には下書きキー、検証済みのdigestまたはobject version確認値、再利用元revision、`jobId`/Show/Episode IDを記録する。ETagは検証用のobject version確認値として使えても、音源内容のSHA-256と同義にはしない。CLIはローカルTOMLとステージ済みTOMLを比較し、staleなら公開を拒否する。consumerも同じobjectを読み直して一致を検査する。

例: `update-episode` → TOMLを再編集 → `publish-episode` は**失敗**し、`update-episode`の再実行を求める。既存Episodeで音源だけをstagingした場合、ローカルTOMLが公開済みmetadataと異なれば暗黙に旧metadataを再利用しない。`commit.json`後は同じjobIdのstagingを上書きしない。CLIの停止・再実行・別端末からの操作もエラー/再開規則を要する。

**決定:** 案A。**保留:** ローカル状態ファイルの場所と、紛失時の回復。完了jobと音源の保持期間は次のR2-06で選ぶ。

## R2-05: 公開順、競合、feedの可視性【最重要】

**問い（方針決定済み）:** 「古いjobで新しい公開版を巻き戻さない」を具体的に何の順序で保証するか。D-05の`max_concurrency: 1`、`max_batch_size: 1`は**consumer実行の並列度**を下げるが、commit順、複数端末のpublish順、Showの更新とEpisode更新の直列化までは保証しない。

```text
端末1: job Aのcommit.jsonを作成 ───────→ Queueではまだ未配送
端末2: job Bのcommit.jsonを作成 ──→ Bが先にconsumerへ届く
後でAが届く → 「後着jobをそのままcurrentへ書く」とBからAへ巻き戻る
```

| 案 | 公開の意味 | 利点 / 注意点 |
| --- | --- | --- |
| A（推奨候補） | 同一Showには公開未完了のjobを同時に1件だけ認め、完了・競合解消後に次を受け付ける | 管理者が見た受付順と公開順を揃えやすい。ただし**原子的な予約/解放、期限切れ、障害中の再入防止（fencing）**を設計・検証しないと成立しない |
| B | commitに現在の公開revisionを`expected_revision`として固定。consumerがcurrentを条件付き更新し、基点が変わったjobを`conflict`として止め、管理者に再stagingを要求 | 追加の長期予約を避けやすい。後から受付したjobでも先着配送のjobが先に成功し得るため、「後からpublishしたものを必ず勝たせる」保証ではない |
| C | 全Showに単調増加の受付番号を与え、番号の欠番を待って順に公開 | 厳密な受付順を表現しやすいが、番号割当・欠番回復のための原子的な状態管理が増える |

いずれも、**順序をjobIdやR2のupload時刻から推測しない**。受付順を保証するのか、成功した公開の順に確定して競合を拒否するのかをまず選ぶ。案Bで初回公開する場合は「currentがまだない」条件も必要。R2の条件付きputは単一objectの事前条件であり、`public/episodes/.../metadata.toml`と`public/podcasts/.../feed.xml`を同時にcommitするトランザクションではない。

例えばmetadata更新後・feed更新前にWorkerが停止すると、古いfeedが残る。逆順に書けば新feedがまだ存在しない/不完全な音源を指す危険がある。**音源とimmutable revisionを書いて確認 → currentとfeedをどの順で可視化するか → 再配送時に同じ目的状態へ収束させる**手順が必要。案A/B/Cのどれでも、別Episodeのジョブがfeedを再生成する間の更新取りこぼし、Show情報の同時更新、purge失敗を検証する。Queueの1並列は「CLIによる並行受付」と「ロック期限切れ後の古い実行」を防がない。

**決定:** 案Aの受付制限＋managed Cloudflare Queueを維持する。ShowとEpisodeを区別せず同一Showに未完了publishは1件まで。**保留:** 予約・解放の原子的な操作方法、認証経路、失敗時の回復とfencing。重複配送と異なるShowの順不同処理は想定内とする。

## R2-06: job status、再試行、保持期間

**問い（基本方式は決定済み）:** `system/jobs/<jobId>/status.toml`を利用者がどう読み、障害後にどうやり直すか。R2へ保存すること自体はD-12で確定済み。

| 案 | 再試行方法 | 利点 / 注意点 |
| --- | --- | --- |
| A（推奨） | 一時的失敗はQueueのretry、規定回数超過はDLQに隔離しstatusを確認。管理者が状態を確認して明示的に回復 | 重複配送に耐える処理・DLQ監視・status未更新時の調査が必要 |
| B | CLIの`retry <jobId>`を主に使い、同じ凍結snapshotから再投入 | 操作は明確だが、再通知経路、既に公開済みの場合の冪等応答、古いjobの再実行拒否が必要 |
| C | 失敗のたび新jobIdを作成して再staging | 素朴だが大きいMP3の再upload、放置されたjobの追跡が増える |

状態例: `staging`（CLI側の下書き、未通知）→ `queued` → `processing` → `published`、失敗時は`retrying` / `failed` / `conflict`。`staging`をR2に記録するかは任意だが、**commit作成直後にCLIが停止**するとstatusとイベント通知のどちらが先に到着するか決め打ちできない。statusがないjobを即「存在しない」とみなさず、commitの有無で確認する規則が必要。永久エラー（不正TOML、変更されたsnapshot、revision競合等）は無限retryしない。`castloop status <jobId>`では少なくとも受付済み/公開済み/失敗・理由を区別する。

feedと対象画像のpurge確認までを公開成功の条件にすることはR2-03/R2-09で確定した。DLQからの再投入権限、R2 status書き込み自体が失敗した時の回復と受付予約の扱いを決める。`staging/`を一律期限切れにすると未公開・失敗中の下書きが消えるため、公開済み/放棄済みjobだけを対象にするか、長めの保持期間と事前警告を設ける。古い公開音源とrevision履歴はMVPで消さない。

**決定:** 案A。R2 Event Notification → **単一のmanaged Queue** → `max_concurrency: 1`・`max_batch_size: 1`のconsumerを維持する。一時的な失敗はCloudflare Queuesの有限回数の自動retryに任せ、超過したメッセージは**1つのDLQ**に送る。管理者はR2のjob statusと失敗理由を確認してから明示的に回復する。独自のR2 queue・pollerや通常運用のための追加の状態DBは導入しない。

**運用上の境界:** 不正な入力など再試行で直らない恒久的な失敗は理由をstatusに記録し、無駄にretryしない。処理の一部が成功した後の一時的失敗（feed/画像のpurge失敗を含む）は同じjobIdの凍結snapshotから冪等に再試行する。**DLQへ移るだけでR2 statusが自動的に更新されるわけではない**ため、滞留したjobの検出方法とstatusの照合は必要。Free planのQueue/DLQメッセージ保持は現行24時間なので、長期の診断情報はR2のstatus・commit・snapshotへ残す。失敗後にShowの次の公開を受け付けるには、元jobの再試行/断念と予約の安全な解放を定義しなければならない。古いjobの再配送やDLQ再投入で新しい公開を巻き戻さないことも確認する。

**保留:** `max_retries`・retry delayの値、Queue期限切れ/未配送の検知、状態遷移、DLQからの再投入手順、恒久的失敗や長期滞留jobの予約解放、staging音源・statusの保持期間。これらは簡素な一系統のQueue運用として、M0/M2で失敗ケースを試してから具体化する。`published`にはfeedと対象画像のpurge成功が必要（R2-03/R2-09で決定済み）。

## R2-07: CLIがCloudflareにアクセスする方法とMP3 upload

**問い:** D-10の「対話利用はWrangler OAuth、自動化は環境変数のAPI token」を、どの呼び出し経路で使うか。認証と音源uploadの選択は別。

| 案 | CLIからのCloudflare操作 | 利点 / 注意点 |
| --- | --- | --- |
| A（推奨、M0条件付き） | 初期化・R2 object put/get等をWrangler subprocessで実行。音源も315 MB以内ならWranglerでupload | OAuthとtokenをWranglerに任せられる。Wranglerの出力のparse、エラー、単一objectのサイズ上限を検証する |
| B | Cloudflare APIをCLIが直接呼び出す | 制御しやすいがOAuth credential取得方法を別途設計しないと、対話時の`wrangler login`方針と結び付かない |
| C | 管理操作はWrangler、音源だけS3互換ツール/SDKのmultipart upload | 大容量対応が可能。ただしS3 credentialの発行・環境変数・権限管理という認証上の追加が必要 |

Wranglerの`r2 object put`は現行ドキュメントで**315 MBまで、同時に1 object**。採用した300 MBのMP3について実際のupload速度・再試行性をM0で測定する。管理者のAPI tokenもcastloop設定TOMLには保存せず、必要な最小権限を確認する。CLIの機械実行を考え、全質問のflag、非対話時の不足値エラー、JSON出力と終了コードを具体化する。M0は実際のCloudflareアカウントを使う技術検証であり、ここでは実際のログインやresource作成は行わない。

**決定:** 案A。最大300 MB（300,000,000 bytes）をMVPの入力制限とし、Wrangler subprocessでuploadする。上限までのuploadと失敗時の再試行をM0で検証する。S3 credentialの追加はMVPでは不要。

## R2-08: init設定、名前付け、Show IDの予約

**問い:** M1時点のローカル設定とR2の予約記録をどこに置き、再度`init`/`create-show`した時どう扱うか。

| 案 | 設定ファイル | 利点 / 注意点 |
| --- | --- | --- |
| A（推奨） | 作業ディレクトリ直下`castloop.toml` | 見つけやすい。公開設定だけを保存し、secretとjobIdは書かない |
| B | `.castloop/config.toml` | 補助状態を同じディレクトリにまとめやすい。編集元設定とgit管理外状態の区別が必要 |
| C | 現在の記述どおり`castloop-init.toml` | 設計本文との差分は小さいが、初期化後も継続して使う設定と名前がずれる |

最低限`schema_version`、`service_id`、`account_id`、`bucket_name`、Worker/Queue名、`public_base_url`を永続化する。IDはD-13のslugだが、**R2バケット名・Worker名・Queue名の衝突範囲と採番方法は別問題**。管理者がバケット名を入力する既存のinit仕様を維持するか、`service_id`から候補を生成して編集できるようにするか選ぶ。途中失敗時に作成済みresourceを消さず、同じ設定から安全に再実行できるようにする案を推奨する。

Show IDの予約は「listで空き確認→通常のput」では同時実行に弱い。**予約記録の条件付き作成**が可能な経路を採用し、`system/shows/<showId>/show.toml`を予約兼Show metadata snapshotとする案、別の予約キーを追加して公開snapshotを分ける案を比較する。R2 bindingには単一objectの条件付きputがあるが、R2-07案AのWrangler subprocessだけで同じ原子的な予約を表現できるとは限らない。M0で利用可能な経路を確認し、必要なら予約操作だけWorker/APIへ任せる。ローカルフォルダ作成に失敗した場合の予約解除/回復、予約済みだが未公開のShowがRSSで露出しないことも必要。

**決定:** 設定ファイルは案Aの`castloop.toml`。**要確認:** Show IDをCLIで自動生成するか（上記の検討を参照）、バケット名入力/自動候補、Show予約キーを既存キーと兼用するか分離するか。

## R2-09: Workers Cachingでの公開完了とpurgeの検証

**問い:** Workers Cachingの採用はD-11で確定済み。feedの`Cache-Tag: feed-<showId>`をどのentrypointでキャッシュ・purgeするかと、purge失敗時にいつjobを完了とするかを決める。

| 案 | purge失敗時 | 利点 / 注意点 |
| --- | --- | --- |
| A（推奨） | jobを完了扱いにせずretry対象とし、feedを新内容に収束させてからpurgeを再試行 | 利用者に「公開完了なのに古いfeed」を見せにくい。再試行はメディアを重複コピーしない設計が必要 |
| B | 公開は成功とし、cache TTL（設計上は最大1時間）まで古いfeedを許容 | シンプルだが配信の即時性とCLIの「完了」の意味が変わる |

M0で実際の`workers.dev` hostnameと本番相当のWorker構成を使い、cold/warm GET、HEAD、有効な`Range: bytes=0-9`の206と無効なRangeの416、enclosureのlength一致、feedと更新画像のpurge結果を確認する。**Queue handlerからの`ctx.cache.purge()`がfeed/画像のcacheを無効化することを確認する**。別entrypointに配信を分ける場合はcacheを所有するentrypointからpurgeする構成が必要。音源はimmutable URLなので基本的にpurgeしない。

**決定:** 案A。purgeに失敗したjobは公開完了とせず再試行する。M0でqueue handlerとfetch handlerのentrypointのcache scopeを実証する。

## R2-10: 実装前にそろえる記述と検証範囲

次は新しいサービス構成の選択というより、採用済み決定と設計本文の整合を取るための作業である。

- `initial_design.md`のShow ID「未決定」はD-13の決定に置き換えた。`create-show`の重複検出と予約の手順はR2-08の残りの決定に従う
- `packages/cli`・`packages/shared`を前提とする`AGENTS.md`に対し、現状は`packages/`がない。`wrangler.jsonc`は未作成の`src/index.ts`を指し、ルート`package.json`はCommonJS。M1の最初にディレクトリ構成、Worker entrypoint、ES module設定を揃える
- `@iarna/toml`とZodのstrict schema（既存規約）で`show.toml`/Episode TOMLを実際にparseして検証する。`schema_version`の配置、公開snapshotの生成項目との区別、日時・duration・lengthの型を確定する
- `public/`の許可されたrouteだけをGET/HEADで配信し、`system/`と`staging/`は配信しない。R2 listのpagination、RSSのXML escape、itemの安定した並び、GUID維持、Apple Podcastsの配信要件をM2/M3のチェック項目にする
- M0の実験記録には使用したWrangler/Cloudflare設定、実測サイズ、期待したHTTP status/header、cache purgeの確認結果と未解決事項を残す。M0の成果が想定と違った場合は本書の条件付き推奨を再評価する

**決定:** 上記の整合作業を各M0/M1の着手・完了条件に含める。実装配置の詳細は既存の`AGENTS.md`に合わせてM1時に決める。

## 回答用一覧・次の手順

| 状態 | 項目 | 残る判断・検証 |
| --- | --- | --- |
| 一部確定 | R2-01 | 入力形式Aと現在日時の初期記入は確定。未来日時と公開後の手動変更は保留 |
| 一部確定 | R2-02 | `site_url`必須は確定。CLIが初期値を得る方法（管理者に尋ねる案）を確認 |
| 確定・詳細保留 | R2-03 | BのShow操作、固定キー画像のtag purge。拡張子変更とclient cache期間は保留 |
| 一部確定 | R2-04 | ローカル状態ファイルAは確定。回復方法とR2保持期間は保留 |
| 確定・M0検証 | R2-05 | managed Queue＋同一Show未完了1件。原子的予約・失敗回復の実装経路をM0で検証 |
| 確定・詳細保留 | R2-06 | managed Queue自動retry＋DLQを採用。retry回数、status照合、未完了予約の回復、保持期間は保留 |
| 確定・M0検証 | R2-07 | Wrangler subprocess、MP3 300 MB上限で実測 |
| 一部確定 | R2-08 | `castloop.toml`は確定。Show ID生成、バケット名、予約方法を確認 |
| 確定・M0検証 | R2-09 | purge失敗時再試行、同一entrypointを検証 |
| 確定 | R2-10 | M0/M1の着手・完了条件に反映 |
| 確定 | キー名 | `temp/`を`staging/`へ変更。Show用の下書きキーも追加 |

確定した選択は本書冒頭と`initial_design.md`、テンプレート、`AGENTS.md`に反映した。残る選択が確定したら同様に反映する。**R2-05に必要な原子的操作とR2-09のpurge経路をM0で検証し、M2で公開順・途中失敗からの収束まで確認して初めて「公開できた」とする。**

## 参照資料

- [R2 Event Notifications（prefix/suffix filter）](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- [R2 Workers APIのlist（キーの辞書順）](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2bucketlist)
- [R2 object lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 Workers API（条件付きput）](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)
- [R2 upload objects（Wranglerの315 MB上限とmultipart）](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [Cloudflare Queuesの配送順](https://developers.cloudflare.com/queues/reference/how-queues-works/)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare Queues consumer設定とDLQ](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [Cloudflare Queues batching/retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Workers Caching purgeとentrypoint scope](https://developers.cloudflare.com/workers/cache/purge/)
- [Workers Caching limitations（GET/HEAD、Range）](https://developers.cloudflare.com/workers/cache/limitations/)
- [Apple PodcastsのRSS要件](https://podcasters.apple.com/support/823-podcast-requirements)
