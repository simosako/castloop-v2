# Issue #62: 公開jobのblocked診断と証拠に基づく復旧の設計・開発計画

作成日: 2026-10-27。**初回は設計案のみ。管理者レビュー後に開発へ進む。**
2026-10-27の管理者レビューで継続方式に**§4.1案A(continuation_ready再利用)を採用**した。復旧不能jobの削除要求は§5.6に検討を記録した。`abandoned`終端状態(§4.2案A)の採用可否は判断継続中である。

- 対象Issue: [#62](https://github.com/simosako/castloop-v2/issues/62)
- 調査基準: このworktreeの`23c25a5`(origin/main)。Issue本文の調査基準`72bc9f0`(v0.7.2)から、#63〜#71の機能統合と内部queue/content形式11/11を含む。
- 実装承認と、Cloudflareへの配備・公開・Resume・資源変更の承認は別である。

## 1. 要件

blockedになった公開jobを、journalの手作業編集や未知IOの再送に頼らず、証拠に基づいて安全に診断・復旧できるようにする。Issue本文の要件を次に置き換える。

1. 読み取り専用の診断で、対象のjob・要求identity・最後の確定段階・local/remoteの確認事実・不足する証拠をまとめる。
2. 「同じjobの観測のみ可能」「証拠に基づく明示続行が可能」「現行では保全・調査が必要」を理由付きで区別する。
3. 結果が確定している処理を繰り返さず、未開始と証明できる部分だけを明示的に続行する。
4. 復旧できない状態では、保存すべき証跡と次の判断を提示する。万能な復旧や無条件の強制再試行は約束しない。

維持する安全条件はIssue本文とAGENTS.mdのとおり。特に、時間経過・HEAD不在・process終了・空queue・単一jobの終端だけを以前のIO収束の根拠にしない、未知PUT/POSTを再送しない、owner/execution tokenを奪取しない、journalを推測で昇格しない、blockedの単なる削除をしない、cache purge成功前に公開完了としない。

## 2. 現行実装から分かったこと

| 実装 | 現状と本件への影響 |
| --- | --- |
| `src/sqlite-publication-alarm.ts` | blockedは(a)中断後の再claimで検出する`execution_interrupted`(runningかつ`continuation_ready=0`の意図しない中断)、(b)`stored_request_invalid`(保存要求の破損・identity不一致・要求hash不一致)、(c)validate中の入力エラー以外の例外`validation_unavailable`、(d)publish中の例外`execution_failed`の4経路だけで発生する |
| `src/sqlite-publication-queue.ts`の`claim`/`yield`/`block` | `yield`はsite HTML生成の分割実行のためだけに`continuation_ready=1`を保存し、Alarmで同じjobを**validateからやり直す**再実行経路が既にある。blocked→runningへの戻しとAlarm再設定だけで、この経路を再利用できる |
| `sqlite-publication-http.ts` | 管理APIは`GET jobs/{request_id}`(状態)と`POST jobs`(受付)のみ。blockedに対する操作入口はない |
| `src/sqlite-publication-executor.ts`のvalidate | 新規公開・restoreとも`requireAbsent(revisions/{job_id}.toml)`等で**自分の書込先の既存オブジェクトを拒否する**。このため書込開始後のblocked(job)を現在のまま再実行すると必ず`validation_failed`(failed)になり、継続できない |
| 同上のpublish | immutable書込(revision・feed snapshot・cover・audio・site snapshot)は全て`If-None-Match: *`と書込後のsize/checksum検証で行う。**既存オブジェクトの存在+checksum一致で「このjobの書込が完了した」と証明できる**。上書き系(`show.toml`/`metadata.toml`)は同一内容の再書込で冪等 |
| 同上の`timestamp()` | revisionの`updated_at`とShowの`updatedAt`が実行時刻依存。再構築では値が変わり、既存オブジェクトとのhash一致判定を壊す。継続時の決定的再現には前回値の保存が必要 |
| `src/sqlite-site-content.ts`の`batch` | site HTML生成の進捗(cursor)をDO SQLiteに保存し、分割再開できる。blocked後の再実行でもbuildが残っていれば続きから生成する |
| `sqlite-publication-content.ts`のread boundary | `delivery_policy=preserve_committed`のjobは開始時に読取境界(旧feed世代・対象状態)を保存し、blocked後も旧内容の配信を続けられるかを`read_verified`で管理する。blockedの終了処理はこの配信可否を変えない |
| `packages/cli/src/sqlite-operation-commands.ts` | `operation-resume`はupload familyのみ。publication jobの継続・終了コマンドはない。ローカルjournal(sqlite-drafts等)に要求全文と`request_sha256`が残り、identity照合の材料になる |
| `packages/shared/src/sqlite-publication.ts` | 状態は`queued/running/succeeded/failed/blocked`。`failed`のreasonは入力系`SqlitePublicationFailure`、`blocked`のreasonは上記4種に型で固定されている |

現行の代替は同一jobの状態確認と証跡保全のみで、対応不能なblockedを安全に解除する正式手順はない。

## 3. blocked理由別の分析と3分類

blocked理由ごとに、書込状態と継続の可否を整理する。書込の進行度は証拠(オブジェクトの存在とchecksum)から判定し、理由だけで機械的に決めない。

| 分類 | 対象 | 根拠 | 提供する操作 |
| --- | --- | --- | --- |
| **観測のみ** | `stored_request_invalid` | サーバー側の要求が破損・不一致しており、DO内の情報だけでは要求を再構築できない。同一jobの継続も安全な終了の確認も、要求identityの裏付けなしには成立しない | 診断(ローカルjournalとの照合を含む)。identityが裏付けられ、書込状態が確認できた場合のみ終了を案内 |
| **明示継続が可能** | `execution_interrupted` / `validation_unavailable` / `execution_failed` | validateは読取中心で冪等。publishの書込はimmutable要件とchecksum検証により「未開始」か「完了」かをオブジェクト単位で証明できる。`yield`と同じ再実行経路を利用できる | 診断＋明示継続。各書込の存在・hash検証を継続前に実行し、不一致があれば継続を拒否 |
| **保全・調査が必要** | 上記の検証でidentity不一致・書込内容不一致・保守拘束中などが判明した場合 | 証拠が揃わない状態での継続・終了は未知IOの再送や二重公開に等しい | 診断のみ。保存すべき証跡と確認先を表示 |

3分類の判定は診断コマンドが理由と証拠の両方から行う。理由コードだけで分類を固定しないのは、例えば`execution_failed`でも対象のbaseが既に変わっていれば継続できないためである。

### 状態遷移の拡張

```
queued ──claim──> running ──finish──> succeeded
                     │ └─入力系失敗─> failed
                     │ └─yield──────> running(continuation_ready=1, 分割再開: 既存)
                     └─block────────> blocked ──job-abandon──> abandoned(新設)
                                        │
                                        └─job-continue──> running(continuation_ready=1, 明示継続: 新設)
```

- `job-continue`はblockedを`continuation_ready=1`のrunningへ戻し、Alarmで既存の`claim`経路から再実行する。新規の実行経路を作らない。
- `job-abandon`はblockedを新設の終端状態`abandoned`へ移す。**blocked行の削除ではない**。FIFO・Resume・共有Worker更新の拘束を解放し、read boundaryが保証する旧配信は変えない。
- `abandoned`のreason_codeは継続不能の原因(blocked理由)を引き継ぎ、操作記録に診断結果の要約(allowlist内)を残す。

## 4. 方式の比較

### 4.1 継続の実現方式

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **A: continuation_readyの再利用(推奨)** | blocked→running(continuation_ready=1)へ戻し、既存のclaim/validate/publish経路を再実行する。書込は「既存+checksum一致ならskip、不一致ならblock」に拡張する | yieldで実績のある経路を使い、新規の状態・実行系を増やさない。検証・凍結・read boundaryを毎回全てやり直す | validateの`requireAbsent`と`timestamp()`の決定性を冪等に直す必要がある |
| B: 専用の再開executor | blocked用に「どこまで進んだか」を記録し、その次の段階だけを実行する専用処理を書く | 再実行するIOを最小化できる | 段階記録の保存・改竄検証・二重実行防止が新規に必要となり、状態が複雑化する。現行の書込は各段階で検証済みを保証しないため、記録だけを信じる設計になる |
| C: blockedのまま同じjobをAlarmで再実行 | 状態を変えずに再実行だけ許可する | 状態追加がない | 「blockedは保全状態」という現行契約(guide・配信gate・共有更新)を全て見直す必要がある。成功した場合の状態も定義し直しになる |

案Aを採用する。案Bの「段階の最小再実行」は、案Aでもimmutable書込のskip検証で同等に得られる(書込済みはPUTしない)。案Cは契約変更が大きい。

### 4.2 blockedの終了方式

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **A: `abandoned`終端状態の追加(推奨)** | blockedを`abandoned`へ移し、行・証跡・read boundaryを全て残す | Showが恒久に停止しない。何を止めたかが残る。物理削除・journal書換えなし | 状態enumの追加(schema更新)が必要 |
| B: blockedのままFIFOだけ解放 | active扱いをやめ、blocked行は残す | 状態追加なし | 「blocked=後続停止・Resume拒否」の契約と矛盾し、配信gate・共有更新・監視の全判定を見直す必要がある |
| C: 終了を提供しない | 継続不能なblockedは保全だけ | 実装が最小 | `stored_request_invalid`等でShowが永久に更新・Resume不能になる。「次の判断を提示する」Issue要件を満たせない |

案Aを採用する。

## 5. 採用する設計

### 5.1 診断: `castloop job-diagnose JOB_UUID --show SHOW_ID`(読み取り専用)

ローカルjournal(sqlite-drafts / sqlite-publications / sqlite-lifecycle / RSS子操作)から対象jobの凍結要求と`request_sha256`を特定し、次を突き合わせる。

1. **サーバー側job行**: state・reason_code・sequence・`continuation_ready`・read boundary各列・`read_verified`。新設するDOの診断エンドポイントから返す。
2. **要求identity**: ローカルjournalの要求全文と`request_sha256`、サーバー側`request_json`・`request_sha256`の一致。
3. **書込状態**: DOがbucket bindingで対象key群(revision・feed snapshot・cover・audio・site snapshot・`show.toml`/`metadata.toml`)を`head`し、存在・size・checksumを返す。内容の期待値は要求から決まるため、CLIが期待hashを計算して一致を判定できる。
4. **操作記録**: 対象jobの操作履歴(最後の確定段階・invocation)。

出力は3分類(観測のみ/明示継続が可能/保全・調査が必要)と根拠・不足する証拠のJSON。**診断はlocal/remoteの一切を書き換えない**。読取の一時失敗は「不明」と表示し、成功・失敗へ変換しない。

DO診断エンドポイントはbucketへのread(HEAD)を伴うため、管理キー認証の下で既存の状態照会(`GET jobs/{request_id}`)と同じ管理API内に`GET jobs/{request_id}/diagnose`を新設する。書込先key群はDOが保持するjob行と要求から計算でき、CLIが期待hashを送る必要はない。実行は同Show DO内で直列化され、状態を変更しない。

### 5.2 明示継続: `castloop job-continue JOB_UUID --show SHOW_ID`

前提: 診断と同じ照合を送信前に実行し、**分類が「明示継続が可能」のときだけ送る**。CLIは要求identity(service/config/runtime・`request_sha256`・job_id・reason_code)を凍結してDOへ送る。応答喪失時は同じ要求の再送ではなく、状態照会からやり直す(既存の操作記録と結果GETの仕組みに乗せる)。

DO側`job-continue`の受付条件(全て同transactionで検証):

- jobがblockedであり、reasonが`execution_interrupted`/`validation_unavailable`/`execution_failed`のいずれか
- 要求identityが完全一致(凍結値と`request_json`/`request_sha256`)
- Showが保守拘束中・Pause操作の途中でない(既存の`scope.ready()`等を利用)
- 後続のFIFO位置が変わっていない(自分が先頭activeのまま)

許可した場合、`state=running, continuation_ready=1`へ更新し、Alarmを設定する。既存の`claim`が`running && continuation_ready=1`を再実行するため、以降は現行経路に合流する。二重のcontinue要求・実行中のAlarmとの競合は、DOの単一実行とtransaction内のstate検査で排他される(`block`/`yield`と同じ条件で守る)。

continue要求自体も操作種別ごとの操作記録へ保存し、既存の操作照会(`operation-status`)で結果を読めるようにする。応答喪失時の再送判定はこの記録で行い、不明なまま同じcontinue要求を重ねて送らない。

再実行時の各段階:

| 段階 | 再実行時の動作 |
| --- | --- |
| claim/受付検証 | 変更なし。runtime/config/target/base/generation/window・要求hashの全照合を毎回やり直す(既存) |
| site build | 変更なし。保存済みbuildがあればidentityを照合し、cursorの続きから生成(既存)。buildがなければprepareから |
| validate | **自分のjobの書込先に限り**、既存オブジェクトのsize/checksumが期待値と一致すれば「書込済み」として許可する。`requireAbsent`は他対象のままとし、第三者の書込・内容不一致は従来どおり拒否する。draft Show初回公開・新規Episodeの`requireEmpty`(対象prefixの完全空検査)も同様に、存在するobjectが**自分の期待key群のみで全てsize/checksum検証済み**の場合だけ許容し、他のobjectが1つでもあれば従来どおり拒否する |
| publish | immutable書込を「既存+checksum一致ならPUTせずskip、不一致ならblock」に拡張。上書き系は同一内容を検証付きで書く。site candidatesの重複挿入は既存の一意制約で無視 |
| cache purge | 変更なし。purge成功の確認前に完了しない。purge再実行はcache無効化の冪等性に依存せず、毎回結果を確認する(既存) |
| commit | 変更なし。SQLite transactionで状態とカタログを原子的に確定(既存) |

### 5.3 決定的再現(`timestamp()`の凍結)

継続再実行でrevisionの`updated_at`・Showの`updatedAt`が変わると、既存オブジェクトとのhash一致判定とfeed内容が変わる。そこで**最初のvalidate成功時にjob行へ実行時刻を保存し、同一jobの再実行では保存値を`timestamp()`として使う**。

- 保存するのはISO 8601時刻1つ(新列`prepared_at`)。feed・revision・metadataはこの時刻から決定的に再構築できる。
- cover/audioの本体は要求のupload identityが指すR2オブジェクトから読み直すため不変。
- この列の追加に伴い、内部queue/content形式を11/11から**12/12**へ上げる。fresh環境専用で、11/11環境の変換・互換配備は行わない(AGENTS.mdの規定どおり)。

### 5.4 明示終了: `castloop job-abandon JOB_UUID --show SHOW_ID PLAN_SHA256 confirm`

- 前提: 診断で「観測のみ」または継続不能と判定されたjob。`stored_request_invalid`で要求identityがローカルjournalから裏付けられ、書込状態の確認(存在・hash一致または不在)が取れた場合に限る。
- 操作は`operation-cleanup`と同じ二段階confirmとする。診断が返す計画hashを確認してから実行する。
- DO側でblocked→`abandoned`へ移し、操作記録に終了理由と診断要約(allowlist内の固定code)を保存する。read boundary・行・局所的な書込残(immutable追加や上書きkey)はそのまま残す。残った書込は次の公開で上書きされるか、将来の明示的な削除機能の対象とする。**物理削除・prefix掃除は行わない**。
- 終了後もread boundaryの判定は変わらない。旧配信が継続できるjobなら配信は続く。配信できない(503の)Showは、新規jobでの再公開が「次の判断」であり、案内として表示する。ただしdraft Showの初回公開・新規Episodeのように書込開始前の空を要求する対象では、残った書込との衝突で新規jobが失敗し得る(§5.6の実害1)。
- `abandoned`への遷移でFIFO・Resume・共有Worker更新の拘束を解放する。

### 5.5 API・スキーマ変更のまとめ

| 変更 | 内容 |
| --- | --- |
| `sqlitePublicationStatusSchema` | stateへ`abandoned`を追加。reasonはblocked理由を引き継ぐ |
| `publication_jobs` | `prepared_at`列(ISO 8601)を追加。CHECK制約・`abandoned`をstateへ追加。queue/content形式12/12 |
| 管理HTTP | `GET jobs/{request_id}/diagnose`(読取)、`POST jobs/{request_id}/continue`(identity凍結付き)、`POST jobs/{request_id}/abandon`(二段階confirm)を追加。既存`jobs`(受付)・`jobs/{request_id}`(状態)は変更なし |
| 操作記録 | continue・abandonを操作種別として記録し、`operation-status`で結果を照会できるようにする。診断は記録しない |
| CLI | `job-diagnose`・`job-continue`・`job-abandon`を追加。`job-status`は`abandoned`表示だけ追加 |
| executor | validateの自己書込先許可(`requireAbsent`・`requireEmpty`両方)、publishのimmutable skip検証、`timestamp()`の凍結値利用 |

### 5.6 復旧不能jobの削除について(2026-10-27管理者質問への検討)

管理者から「復旧不可能なjobと関連ファイルを管理者判断で削除できると良いのでは」との指摘を受け、次のように検討した。

**job行の削除は導入しない。**`publication_jobs`行はread boundary(`read_*`列と`read_verified`)の保存場所であり、`committedReadBoundary`がblocked中の旧配信可否の判定に直接使う。`publication_feed_generations`の予約行はjobを`owner_id`で参照し、世代番号はR2 snapshot keyに使われるため再利用できない。したがって行を消すことは「ごみの除去」ではなく、配信gateと世代一意性の根拠そのものの除去であり、AGENTS.mdの「blocked行の単なる削除禁止」にも反する。

**R2残置書込の限定cleanupは将来機能とする。**abandon後の残置には実害が2つある。

1. draft Showの初回公開と新規Episode公開は、validateが対象prefixの**完全な空**を要求する(`requireEmpty`)。§5.2の自己許可は同一jobの継続にしか効かないため、abandon前の書込が残る限り、**同じ対象への新しいjobはvalidation_failedで失敗する**。
2. Episode音源(`public/.../{job_id}.mp3`、最大300MB)などjob固有のimmutable書込は、新しいjobのkeyと衝突しないため**永遠に上書きされず孤児として残る**(staging uploadには既存の未公開素材cleanupがあるが、このpublic keyは対象外)。

このため、次の条件を満たす限定cleanupなら将来導入できる。

- 対象は`abandoned`遷移済みのjobのみ。blocked・実行中のjobには適用しない。
- 削除keyは当該jobの凍結要求から決定的に列挙できる**job固有のimmutable keyに限る**(revision toml・世代snapshot・`{job_id}`音源・site snapshot)。`show.toml`・`metadata.toml`のような対象をまたぐ共有keyと、他jobや現行commitが参照するkeyは削除しない。
- keyごとにheadとchecksum一致を確認してから削除する。prefix一括削除はしない。
- job行・世代予約・操作記録は残す。`operation-cleanup`と同じ二段階confirmとする。

**ただし本Issueでは導入しない。**理由は次のとおり。実害1は「abandoned前身jobの検証済み残置を`requireEmpty`が例外許容する」方式でも解消でき、削除と許容のどちらで解くかは個別に判断すべきである。実害2の孤児は配信・受付に影響せず、abandon自体が証拠が揃わない稀なケースに限られる。また物理削除は取り消せず、AGENTS.mdがpayload削除を明示承認済みのlifecycle削除に限定しているため、削除経路の新規導入は専用の設計・レビューを経るべきである。本Issueは§5.4のとおり`abandoned`への遷移のみを提供し、残置は次の公開での上書き(共有key)か本項の将来cleanup(job固有immutable key)に委ねる。

## 6. 安全条件(実装・運用で守ること)

- 継続・終了とも**明示コマンドのみ**で行う。Alarmの再配送・watch・通知がblockedを自動で継続・終了しない。
- 継続前の全照合(identity・runtime/config/base・書込状態・保守拘束)を拒否条件として維持する。1つでも不一致・不明なら継続しない。**不明を成功・失敗確定へ変換しない**。
- checksum一致判定には必ず書込後検証と同じ基準(size・sha256・key)を使う。headの欠測・読取失敗は「不明」でありskipの根拠にしない。
- `stored_request_invalid`のjobは、ローカルjournalとのidentity一致なしには一切の変更を行わない。「journalの推測による昇格」に該当するため、要求全文とhashの双方一致を必須にする。
- abandonはblocked行を残す。行削除・journal書換え・R2掃除・lock削除をしない。
- 診断・継続・終了のログと操作記録は固定code・identity・時刻のみで、例外文・本文・秘密を出さない(allowlist規定)。
- 他Show・制御DOには作用しない。共有Worker更新の可否は既存のdrain判定(`abandoned`はactiveではない)がそのまま使えることを確認する。

## 7. 受け入れ条件とテスト計画

ローカル回帰(Bun SQLite・模擬R2/Cache・実CLI entrypoint)で次を確認する。

1. 4つのblocked理由をそれぞれ発生させ、診断が3分類と根拠・不足証拠を正しく返すこと。
2. 継続の故障注入: (a)応答喪失(再送しない・状態照会からやり直す)、(b)実行中断=execution_interrupted、(c)purge失敗=execution_failed、(d)入力変更・古いbase・並行操作での拒否。
3. 継続再実行で、**書込済みimmutableオブジェクトを再PUTしないこと**(模擬bucketの操作記録で検証)、内容不一致オブジェクトの存在時に継続が拒否されること。draft初回公開・新規Episodeの`requireEmpty`検査でも、自分の検証済み書込だけが許容され、第三者のobjectは拒否されること。
4. 継続成功jobの`updated_at`・feed が初回validate時刻で再現されること(hash一致)。
5. abandonがblockedのみに作用し、行・read boundary・旧配信を維持すること。abandon後のFIFO・Resume・共有更新の解放と、`stored_request_invalid`でのidentity不一致拒否。
6. Alarm再配送・watch・統計・catalog・サイト配信がblocked/abandonedを崩さないこと(既存回帰の維持)。
7. CLI: 診断のJSON出力・confirm二段階・`--local`(journal読取)の動作、help・docs整合。

実Cloudflareでの配備・故障注入は別承認とし、この計画には含めない。

## 8. 対象外

- blockedの自動retry・自動release・期限解放。
- 11/11以前の内部形式からの変換・互換配備(新規fresh環境専用)。
- `failed`(入力系)の再実行。凍結要求の再提出として既存の公開手続きを使う。
- Worker更新(#11経路)・upload操作(#40経路)・domain保守の各継続手順の変更。それらとの区別はdocsに明記する。
- 物理削除・R2掃除・site candidates/buildsの整理。復旧不能jobの残置書込の限定cleanupは、§5.6の条件により将来の個別Issueで設計する。
- 単一PUT U1の検証。U1は未検証の仮定のままである。

## 9. 関連文書の更新

実装時に次を更新する。

- `docs/sqlite_operation_recovery.md`: blocked診断・継続・終了の手順と「止まるべき条件」。
- `docs/sqlite_sequential_development.md`: 「異常時」節のblocked記述(現行「retry/releaseは提供していない」からの差し替え)、内部形式12/12。
- `docs/agent_usage.md`・`README.md`: 新コマンドの案内。
- `design/README.md`: 本書のリンクと形式番号の更新。
