# M6: 公開停止・削除 実装ログ

## 2026-10-02: 新規登録から六つのlifecycle操作までのlocal全体結合

- 新規Showのdurable reserve→registered receipt→local Show/二Episode下書き→target inspection→metadata/audio staging→publication commit→M6 Queue consumer→metadata改訂→Episode/Show各停止・再開・削除を、一つのsimulated R2/REST/内部管理入口で通した。
- 未公開high-level helperを使ってgeneration/base/IDを手入力せず、source GUID/dateとimmutable media/history保持、対象外Show/Episodeの維持、複数consumer continuationによる物理削除、404/410 state-first gateway、永久reservation/tombstone/小さい記録保持、local source非削除と削除後の再更新拒否を確認した。
- lifecycle要求はstrict schemaでcanonical化してから確認hashを作る。個別record/stateの順序に依存した入力hashを確認申告へ渡さない。全799テスト/12549 assertions、TypeScript/diff checkに合格。
- この試験は実handler/client/consumerのlocal結合であり、実Cloudflare notification/Queue/cache/REST/300MB受け入れではない。公開gate/Cloudflare環境は変更しない。残タスクのCLI command dispatch・移行/外部復旧・実機受け入れは継続する。

## 2026-10-02: target snapshotからID/generation/baseを導出して更新・公開

- 未公開high-level更新/公開helperを追加し、非書込target照会→identity/local前後一致→初回durable head生成/完了後history付きrotation→target排他runnerへ接続した。metadata/audioに同draft IDを使い、current base変更やunfinished ownerでは差替えない。
- requested/残存lock/欠落recordをHTTP前に拒否し、prepared publicationの固定timestampは明示続行で維持する。target lock取得後も計画したdraft IDを照合する。欠落headの初期化でもhistory/publication ID/lock再利用を拒否した。
- 四入力経路、consumer完了前の次更新拒否/完了後rotation、unknown outcome非再送、base/identity/local途中変更とprepared timestamp保持を回帰した。全798テスト/12310 assertions、TypeScriptと283module内部helper Bun bundleに合格。Cloudflare書込/公開CLI切替はない。
- 残タスクを再確認し、公開前のCLI command dispatchと登録/local作成/lifecycleの全体統合、移行/外部復旧/実機受け入れを続ける。詳細は`m6_local_update.md`。

## 2026-10-02: generation/current/baseの非書込内部API/clientを追加

- 未公開`POST /admin/target`とstrict clientを追加した。job ID/期待generationなしでtargetを照会し、M6 read boundary/controls/metadata/historyの前後照合後にgenerationとcurrent baseを返す。unfinished ownerではbaseを読まず、orphan/partial registration/不整合/過大入力を拒否する。
- read boundaryとservice admission readerの型もget/headだけへ狭めた。媒体検証/操作/復旧許可を明示falseとし、token登録/記録保存/Queue送信はしない。metadataを含むtarget応答だけ2MB boundedとし、既存管理応答64KiBを維持する。
- Show/missing、Episode active/unpublished/draft/deleted、owner/paused、history/ETag変化、schema/auth/version/identity、70KB metadataと内部入口/default拒否を回帰した。全787テスト/12142 assertions、TypeScript/M6実証tsconfig、candidate/bridge browser bundleに合格。公開gate/Cloudflare環境は変更しない。
- 残件を再確認し、次はsnapshot取得とlocal target head初期化/rotationの統合を進める。詳細は`m6_target_inspection.md`。

## 2026-10-02: local draft排他を準備・REST upload・publication全体へ接続

- 二つの内部runnerを追加し、durable headからtarget/draft/base/upload集合を取得してlocal準備→一度限りREST PUT/GET→settlement/finish、publication準備→head freeze→claim/commit→acknowledged freezeをtarget排他下で実行する。caller headerをstrictに検査し、送信前にhead/source/receiptを前後照合する。
- 全slotの未解決/残存lockを保持し、lost claim/commit応答では再送/ID差替え/完了推定を拒否する。settled PUT失敗はexplicit aborted receiptを保持し、別の明示uploadでだけ置換する。U1の前提と公開gateは変更しない。
- Show/Episode初回/metadata-only/audio-onlyのlocal→実内部handler→simulated REST→commit、全transport中target lock、並行operation、head途中変更、unknown outcome、aborted置換を回帰した。全776テスト/12093 assertions、TypeScriptと281module内部runner Bun bundleに合格。実Cloudflare書込/deployはない。
- 残件を再確認した。次はtarget state/current/baseの取得・CLI統合に必要な内部読取契約を調査し、移行/復旧/実機受け入れも継続する。詳細は`m6_local_draft_operation.md`。

## 2026-10-02: frozen下書き履歴を残して次draftへ切替

- `rotateLocalDraft`を追加し、target排他とexact local committed journal再照合の下で旧frozen recordをprivate historyへ先にfsync保存し、新editable headをatomic renameする。既存同内容archiveからの続行を認め、異なるhistory/過去ID/publication ID/lock/未凍結recordを拒否する。
- 同next IDの再呼出でもphase/uploadを再初期化せず、旧handleから新headの編集を拒否する。commitとpublication完了を区別し、remote owner解放/current revision/consumer終了の推定はしない。
- Show/Episodeの履歴保持・archive後中断相当の再開・異なるhistory保持・不正/missing/editable/lock拒否を回帰した。9対象テスト/64 assertionsとTypeScriptに合格。公開gate/Cloudflare環境は変更しない。次はtarget journalを準備/runner全体の排他へ接続する。

## 2026-10-02: target別draft ID・upload参照・publication freezeを永続化

- private/strictなtarget別local draft journalを追加し、service identity・draft/base IDを固定した。prepared uploadを送信前にslotへ記録し、未解決/lock/foreign uploadの置換を拒否する。finished後の置換でも過去のoperation journalは保持する。
- exact prepared publicationのupload集合/base/manifest照合で編集を凍結し、acknowledged local commitだけでfrozenへ進める。非期限target排他・fsync/rename・bounded/no-follow読取とsymlink parent拒否を追加し、status観測/時間から完了を推定しない。
- Show/Episodeのstaging→publication claim/commitとlocal freezeを結合し、identity変更/並行操作/残存lock/escaped editor/本文混入を回帰した。全764テスト/11881 assertions、TypeScriptとdiff checkに合格。Cloudflare書込・公開gate変更はない。
- 残件を再確認し、次は準備helper/runnerとの一体化と履歴を残す次draft切替へ進む。詳細は`m6_local_draft_journal.md`。

## 2026-10-02: finished stagingからpublication要求・journal・送信前guardを自動準備

- `prepareLocalPublication`を追加し、同identityのfinished/staged receiptsと最新local入力からShow/Episode初回・metadata-only/audio-onlyのcommit/checksum/size/解析durationを組み立てる。stage ID集合をcanonical sortし、caller固定timestampを維持する。本文/base metadata/path/GUID/secretをpublication recordへ複製しない。
- 準備前とclaim/commit直前のstaging記録/lock存在照合を既存local source guardへ接続した。stale inputs・different target/draft/base・missing/aborted/unfinished/lock・manifest変更・requested/claimed再準備を拒否し、準備自体はHTTPを送らない。
- local TOML/実MP3→自動staging→実内部API→自動publication→明示claim/commit→owned consumerの5経路（Show、Episode初回、2改訂、audio-first）を結合し、GUID/date・既存媒体path/history保持と準備後のack lock変化拒否を回帰した。全756テスト/11843 assertions、TypeScript/M6実証tsconfig、内部helper Bun bundleに合格。
- MP3解析変更後のLinux binaryでも既存4family statusのlocal HTTPS試験を再実行し、credentialsなし・requested/古いlock/local/remote record保持を確認した。Cloudflare書込/deploy・公開gate変更は行わない。残タスクはtarget別durable draft ID/公開CLI、移行/復旧と実機受け入れである。詳細は`m6_local_publication_preparation.md`。

## 2026-10-02: local入力からstaging manifest/journal/source snapshotを自動準備

- `prepareLocalStagingUpload`を追加し、固定operation/draft ID/期待generationを検査して、Show TOML+署名一致cover、Episode metadata、MP3全量hash/解析durationからstrictな要求を組み立てる。bounded/no-follow読取・前後stat・再読/再hash照合を経てprivate snapshotとprepared journalへ接続した。
- 既存preparedの同要求だけを明示再準備でき、入力変更・foreign/requested/残存lockは拒否する。新規HTTP/ID生成/legacy state変換は行わず、source paths/body/GUID/durationを保持upload recordへ追加しない。
- 3入力種別をlocal file→内部API→simulated REST単一PUT/全量GET→settlement/finishへ結合し、PNG/ID/selection/budget/symlink/不正MP3/全chunk hashと未知状態保持を回帰した。全746テスト/11732 assertions、TypeScriptと内部helper Bun bundleが合格。
- Cloudflare環境・公開gate・U1を変更しない。残タスクを見直し、次はfinished staging journalsからpublication要求を組み立てる処理を接続する。詳細は`m6_local_staging_preparation.md`。

## 2026-10-02: CLIのMP3解析をowned descriptor/非追従streamへ変更

- ローカルM6 upload要求の組立に先立ち、共通`analyzeAudio`をno-follow/nonblocking regular-file descriptorとbounded streamへ変更した。300MB上限はstream/parser開始前に検査し、size/mtime/ctimeを解析前後で照合する。parser終了時はstreamの停止と残存read Promiseをawaitしてからdescriptorを閉じる。
- Bunのfile stream destroyがdescriptorを閉じる挙動に依存せず、明示所有したdescriptorから64KiBずつ読むbyte-mode streamを使う。既存のMP3 codec/丸め秒数検査とCBR/VBR解析を維持し、symlink/directory/FIFO・空/過大/非MP3の拒否を回帰した。
- 全737テスト/11654 assertions、TypeScriptとLinux単一バイナリbuildに合格。既存CLIの入力解析を改善しただけで、M6公開gate・REST単一PUT/U1・Cloudflare環境を変更しない。次は検査済みlocal入力からのstaging manifest/journal準備を接続する。

## 2026-10-02: 内部状態照会もlocal journalの読取前後照合へ統一

- staging/publication/lifecycleの内部`inspect*Operation`へstatus完了後のlocal journal再検査を追加した。途中phase/receipt/request変更では古いclient stateと新しいserver statusを成功snapshotとして返さない。既存Show登録inspectorと同様、phase修復・再送・local lock/token奪取はしない。
- 実内部APIのstatus受信中に、別の明示local操作がrequestedを保存する競合を3familyで追加回帰した。変更されたphaseは保持し、照会側のbegin/PUT/commit/Queue追加送信がないことを確認した。全735テスト/11648 assertions、TypeScript、3内部runner Bun bundleと`git diff --check`に合格。
- これは意味的なlocal読取前後一致であり、HTTP/local file全体の原子的snapshotや旧consumer終了の証明ではない。公開書込gate/Cloudflare環境を変更しない。公開CLI統合・移行/復旧・実機受け入れは引き続き残る。

## 2026-10-02: 4familyの非書込remote状態照会をCLI/standalone binaryへ接続

- `operation-status FAMILY ID`を追加し、local凍結journalを検査してから管理keyを読み、4内部clientのstatus actionだけを一回送る。identity/完全manifest/control hash/strict receiptを照合し、HTTP後のlocal state/lock存在観測変更を拒否する。journal/lock/legacy stateを変更せず、phase昇格/再送/復旧許可を行わない。
- local disk→未公開fetch結合入口→実管理handlerの結合、欠落/foreign/symlink/破損/引数不正、local途中変更、応答喪失/偽identity、通常candidate拒否とsource CLIの4familyを回帰した。保持record不足のremote照会は安全に拒否する。
- Linux x86-64 standalone binaryを一時CA付きlocal HTTPS/実内部handler・simulated R2へ接続し、requested/epoch日時の古いlock保持・4 status requestsだけ・credentialsなし・全local bytes/mtimeとremote records不変を確認した。TLS検証は無効化せず、Cloudflare実機検証とは区別する。
- 全732テスト/11628 assertionsとTypeScript/M6実証tsconfig、candidate/bridge browser bundle、Linux binary build/実行/command helpが合格。通常candidateのmanagement/readiness gateと公開書込commandは変更せず、Cloudflareへの書込/deployは行わない。詳細は`m6_remote_operation_status.md`。

## 2026-10-02: 登録receiptからのローカルShow/Episode下書き作成を追加

- 未公開のShow/Episode下書きhelperをM6登録journalの同一identity/registered receipt/非期限lockへ接続した。Showは指定site URL、EpisodeはローカルShow IDとstrict schemaを照合して現在時刻の引用RFC 3339/GUIDを保存する。legacy confirmedの採用・登録journal変更・remote操作は行わない。
- private directory/file・exclusive新規作成・file/directory fsyncで既存/partial dataを上書きせず、残存lock/missing/prepared/requested/foreign/不正recordとsymlink parent/metadataを拒否する。publication用bounded metadata readerを共通moduleへ抽出して再利用した。現在のremote公開状態やmutation権限をlocal receiptから推定しない。
- local disk→durable登録runner→内部APIの結合と既存Episode/GUID/date保持・同時作成・不正URL/slug・legacy workspace非変換・過大/不正UTF-8/破損Show入力を回帰した。全725テスト/11515 assertions、TypeScript/M6実証tsconfig、candidate/bridge browser bundle、内部helper Bun bundleと既存Linux binary build/version/helpに合格。binaryには新helperを公開せず、現行CLIの回帰確認である。
- 公開CLI/通常candidate gateと既存Cloudflare環境は変更しない。公開CLI・local staging/publication state連携、部分file/未知結果の復旧・既存workspace移行・実機受け入れは残る。詳細は`m6_local_drafts.md`。

## 2026-10-02: Show登録の送信前journal・一度限りrunner・offline診断を接続

- Show ID単位のprivate journalへservice/account/Worker/originと予約要求を凍結し、非期限exclusive lock下で`reserve_requested`のdurable保存後に一回だけPOSTするrunnerを追加した。strictな一致receiptの保存後だけ`registered`へ進め、未知応答・receipt保存失敗・remote観測からの自動再送/昇格を拒否する。
- private permission、file/directory fsync、atomic rename、bounded/no-follow読取、identity/request固定、phase飛ばし/後退拒否と稼働/残存lock保持を回帰した。本文・site URL・メール・secret・任意exceptionをjournalへ複製しない。
- `local-operation-status show-registration SHOW_ID`を4番目の非書込familyとしてsource CLIへ追加した。Linux x86-64 standalone binaryでもcredentialsなしでrequested状態とepoch日時の古いlockを読み、全fileのbytes/mtime不変・lock保持・変更/復旧許可falseを確認した。remote statusもlocal phaseを変更しない。
- 全716テスト/11442 assertions、TypeScript/M6実証tsconfig、candidate/bridge browser bundle、内部runner Bun bundle、Linux単一バイナリbuild、`git diff --check`に合格した。Cloudflareへの書込/deploy・既存環境変更は行わず、公開`create-show`と通常candidateの書込gateは変更しない。
- 公開CLIのlocal TOML/state連携、unknown outcomeの安全な外部復旧、移行full cutoverと実機受け入れは残る。詳細は`m6_show_registration_client.md`。

## 2026-10-02: 新規Showの永久ID予約とdraft制御を内部API/clientへ接続

- 新規Show controlの任意`reservation_id`とlegacy形式の予約recordを使い、control keyの条件付き新規作成でIDを取得した後に同IDの予約を補完するようにした。partial登録は共通受付/対象適格性/owner検査で拒否し、既存/advanced/削除済みcontrolを再初期化しない。
- strictな内部`POST /admin/shows`のreserve/非書込statusと`ShowRegistrationClient`を未公開fetch結合へ追加した。認証/service/readiness/version/cache owner/paused gate、固定診断、exact receipt照合と未知応答非再送を維持する。公開candidate/CLIの書込gateは閉じたままである。
- Show初回publication fixtureの手動control投入を登録helperへ置き換えた。Show/Episodeの新規初期化・staging/publication/Queueと停止/再開/削除まで回帰し、永久ID/予約保持・削除後再登録拒否を確認した。control/予約PUT前後応答喪失・同ID/別ID競合・late orphan/foreign record、service IO完了前のtoken保持とpauseも検証した。移行inventoryはcontrol/予約ID不一致を拒否する。
- 全708テスト/11372 assertions、TypeScript/M6実証tsconfig、candidate/bridge browser bundle、内部client Bun bundle、Linux単一バイナリbuild/version/help、`git diff --check`に合格。binaryは現行CLIの回帰確認で、新しい書込commandは含めていない。Cloudflareへの書込/deploy・既存環境変更は行わない。
- 公開CLIと登録の送信前durable journal、移行full cutover/復旧・実機受け入れは残る。詳細は`m6_show_registration.md`。

## 2026-10-02: 新規Episode draftの初期化をstaging受付へ接続

- metadata/audioの最初のstagingで、期待Episode generation=0・既存公開/staging data不在を照会し、Show共通CASのexact stage owner取得後にdraft制御を条件付き新規作成するようにした。初期化はready progress/PUT permissionより先で、本文・GUID・secretを保持recordへ追加しない。
- 既存/tombstone/停止状態、世代不一致、orphan/未知key、incomplete inventory、破損control/progressを拒否する。PUT前後応答喪失・late orphan/tombstoneではownerを保持し、上書き・時間による解放・durable clientの自動再送を行わない。
- Episode publication/staging管理fixtureの手動draft投入を除き、既存の内部管理API/client/Queue初回公開の結合testも自動初期化経路へ変更した。metadata/audio-first・同request/別request競合と初期化順序を追加回帰した。新規Showの予約/制御初期化は別の残件である。
- 全685テスト/11117 assertions、TypeScript/M6実証tsconfig、candidate/bridge browser bundle、`git diff --check`に合格。公開route/CLIの書込gateと旧IO収束条件は維持し、Cloudflareへの書込/deployは行っていない。詳細は`m6_new_episode_staging.md`。

## 2026-10-02: 非書込legacy移行preflightをCLI/単一バイナリへ接続

- `migration-preflight LEGACY_VERSION_ID`を追加した。準備helperと同じGET snapshot検査を使い、期待versionの単独100%・settings/bindings/cache/preview・default-only module・前後不変を照合する。UUID/upload metadata/lock/journalを作らず、admin secret/state/Worker管理POSTを使わない。
- strict reportからaccount ID/source/binding本文を除き、snapshotだけでdeploy/mutation/recovery/migration completionを許可しない固定falseを返す。subprocessで実形式の省略項目・GET-only 10件・変更/不正引数/foreign origin拒否・壊れたsecret/state非読取・全local file不変を回帰した。
- 同じ既存`smoke-20260930`へLinux x86-64 standalone binaryから照合し、期待version/deployment/cache/preview一致、TOMLだけのprivate workspace不変・journalなしを確認した。Cloudflare書込/deploy/配信停止・実移行・破壊的試験は行っていない。
- 全670テスト/11019 assertions、`npm run check`、M6実証tsconfig、candidate/bridge browser bundle、Linux binary buildに合格した。未公開書込commandとM6 readiness gateは維持する。詳細は`m6_migration_bridge_preparation.md`。

## 2026-10-02: legacy version RESTの省略項目をコード解析で裏付ける

- legacy初回bridge準備だけにexports/named_handlers/空flags省略の対応を追加した。4MiB以下の単一module GETを前後で解析し、default-only/importなし、UTF-8/size/同hashを検査する。filenameなしの`index.js` text partも、実REST形式として確認した。remote codeは実行せず、source本文はjournalへ残さない。
- flags省略は明示settings空配列、exports省略はper-entrypoint設定なし・version/settings global cache一致を要求する。M6/bridge schema、旧IO・cache・移行完了・公開CLI gateは変更しない。
- 既存`smoke-20260930`環境で実adapterのGET-only検査が合格した。service GET 1件+準備GET 10件だけで、journal保存・Cloudflare POST/PUT・deploy/R2書込はない。限定準備経路の実応答確認であり、full cutover合格ではない。

## 2026-10-02: 外部公開originのbounded HTTP inspectorを追加

- 公開path parserをsharedへ移し、Worker互換exportを維持した。未公開CLI helperでstrictな凍結plan/service/versionと公開originを検査し、1〜20 assetsのHEAD/GET/1-byte Range/304を順次確認する。管理credentialsを添付せず、redirect/自動retry/本文の全量バッファを使わない。
- 状態別HTTP、version/migration ID、凍結ETag/size/Range、再検証/no-storeを照合し、response cancel・1-byte stream終了をawaitする。固定診断、page/hashだけの非書込reportと、完了/変更/全量payload/全routing scopeの許可falseを維持する。
- mock transportと実候補gatewayへの結合で、bootstrap settlement前503/後3 assets配信、R2記録不変・migrating/readiness未成立、各header/Range/redirect/取消障害、live取消のawaitを回帰した。CLI/finalizer・実Cloudflare・全hostname/colo受け入れは含まない。詳細は`m6_external_delivery_inspection.md`。
- 全652テスト/10821 assertions、TypeScript/M6実証tsconfig、candidate/bridge browser bundle、新inspectorのBun bundle、既存Linux単一バイナリbuildとversion/help、`git diff --check`に合格。新inspectorは公開binary commandには含めず、binary検査は現行CLIの回帰確認である。

## 2026-10-02: staging送信前の入力検査とdurable phase保存順序を改善

- staging effectsへpublicationと同じ任意の`checkLocalInputs`契約を追加し、claim/beginのrequested保存前に最新sourceを照合する。beginはread-only owner照会後に検査する。REST/source adapterへ接続し、未送信の検査失敗でprepared/claimedを保持する。
- 元の凍結入力へ復元した後の明示操作で同journalを進められることを、未公開fetch結合入口→client/journal→単一REST PUT/GET→settlement/finishまで回帰した。status中の入力変更、requested保存後の検査失敗、begin応答喪失非再送、PUT終了後のローカル編集でも既受付settlement/finishを妨げないことを確認した。
- 全631テスト/10514 assertionsとTypeScript検査に合格。HTTP送信後の結果不明、owner/token保持、U1仮定、公開CLIと通常candidateの書込gateは変更しない。実Cloudflareへの操作は行っていない。

## 2026-10-02: 内部管理APIの未公開fetch結合入口を追加

- 未公開の`fetchM6ManagementIntegration`へ`POST /admin/staging|publication|lifecycle`を接続した。認証後、`requireCandidateReadiness`（M6 mode・完了readiness・実行version一致）を検査してから各handlerへ渡る。legacy/migrating/未初期化・version不一致は固定診断409、method不正は405・認証失敗は401で拒否する。
- handler直結からfetch経由の結合testへ拡張した。staging受付→一度限り開始→明示settlement→検証、publication manifest固定claim/commit→M6 Queue consumerでのpublished化、lifecycle確認付きclaim/commit→同job retry→unpublished化、移行前stateでの書込拒否・foreign service入力の事前400を回帰した。
- `src/m6-worker.ts`はこの結合入口を使わず、通常`fetchM6Candidate`はmock readinessがあってもmanagement書込を拒否する。既存の認証GET診断は維持する。中断時の変更にあった通常candidateの条件付き書込有効化は公開gate未完了のため採用せず、元のread-only回帰も保持した。実機deploy・`m6_ready`・CLI公開は含まない。詳細は`m6_management_api.md`。
- `bun test`（628件、10472 assertions）、`npm run check`、M6実証tsconfig、bridge/candidate browser bundle、Linux x86-64 binary build、`git diff --check`に合格。

## 2026-10-02: 試験環境・停止を許容する移行・M6一式の正式リリース方針を承認

- 管理者の3件のannotationに従い、同一Cloudflareアカウント内の専用試験環境、予定メンテナンス中の配信/更新停止を許容する移行、M6機能一式の完成と次バージョンとしての正式リリースを決定事項へ記録した。限定先行リリースや無停止移行を前提にしない。
- 無停止移行の検討と費用・停止時間の測定計画はMVP構築後へ回す。これらの数値・承認待ちで通常の実装や機能完成を止めず、機能/安全性の受け入れ、runtime制約内の300MB処理、旧IO収束、cache・owner/tokenの安全条件は維持する。
- `m6_review_queue.md`、M6設計、移行runtime契約、README、英語のAgent Guideへ反映した。予算上限/有料plan変更/無制限支出、具体的なversion番号/移行日/停止時間保証は決定していない。今回の更新は文書だけで、runtime・Cloudflareリソース・既存環境・Releaseは変更していない。
- `bun test`（621件、10396 assertions）、`npm run check`、英語AGENTS.md/文書リンク/コードフェンス、`git diff --check`に合格。既存コードの回帰確認であり、専用環境の新しい実測ではない。

## 2026-10-02: 非書込local operation診断をsource CLI/binaryへ接続

- `local-operation-status FAMILY ID`をsource CLI/helpへ追加した。staging/publication/lifecycleのprivate journalと残存lockをcredentials/HTTP/書込なしで読み、remote未確認と変更/復旧許可falseを返す。欠落recordをremote不在/完了とは扱わず、legacy state/secretを読み込まない。
- 3familyのjournal readをno-follow/nonblocking regular file/実16KiB上限/前後stat/strict UTF-8へ共通化した。不正/過大/foreign/symlink recordを上書きせず、CLI診断では任意本文を表示しない。local lockは作成・削除・奪取しない。
- `bun test`（621件、10396 assertions）、`npm run check`、M6実証tsconfig、Linux x86-64 binary buildに合格。standalone binaryでもcredentialsなしでjournal/残存lock読取・全file不変・help/versionを確認した。
- Cloudflare書込/deploy/Release更新、既存環境への適用、書込/破壊的M6 commandの公開は行っていない。unknown outcomeの外部復旧、移行full cutover、本番受け入れgateは残る。詳細は`m6_local_operation_status.md`。

## 2026-10-02: 最新local入力・完了stage証拠をpublication直前へ照合

- `createLocalPublicationEffects`を追加し、finished/staged local journalのexact集合・service/target/draft/generation/checksum/sizeと最新TOML/cover/audioをclaim/commit直前に照合した。metadataは1MB bounded/no-follow/strict読取、媒体は全量stream hash、照合後metadata再読を行う。
- audio-onlyのmetadataはbase revision射影との意味的一致を要求し、未stageのlocal編集を無視しない。GUID/date、Showのimage_path/cover source、base snapshot/変更asset集合も検査する。本文/path/secretは保持journalへ追加しない。
- local preflight失敗はPOST前prepared/claimedを保持する。commit済みjobのretry/statusは元ファイルを要求せず、後の編集を凍結jobへ混ぜない。実local staging journal/REST/source adapter/内部API→guarded publication→M6 Queueのローカル結合を追加した。
- `bun test`（616件、10254 assertions）、`npm run check`、内部source guardのBun bundleに合格。公開CLI/legacy state変換は未接続で、Cloudflare書込/deployは行っていない。binary/専用環境受け入れと安全な外部復旧は残る。詳細は`m6_local_publication_inputs.md`。

## 2026-10-02: Publication同job retryを内部API/client/durable journalへ接続

- exact operation/完全manifest hash/保持marker/request/未完了owner/generationとexecution・verification token不在を照合し、pause中も同jobだけを一回Queue送信する独立再キューを追加した。marker/status/progressや媒体を上書きせず、完了/foreign/未知tokenを拒否する。
- client/runnerへ明示retryを接続し、commit応答保存済みからだけdurable通番/requested保存→一回POST→一致receipt保存へ進める。Queue応答喪失/receipt保存失敗/偽keyではrequestedを保持し、観測から再送・成功認定しない。
- Show/Episode/metadata-only/audio-onlyのpurge失敗から同job完了、媒体/history保持、paused収束、live token、Queue応答喪失、disk失敗、変更manifest/marker、偽Episode key、通番飛ばし/巻戻し拒否を回帰した。`bun test`（601件、10145 assertions）、`npm run check`、候補Worker/内部handler browser bundleに合格。
- 公開route/CLIは未接続で`m6_ready=false`を維持し、Cloudflare書込/deployは行っていない。unknown outcomeの外部復旧と公開gateは残る。詳細は`m6_publication_client.md`。

## 2026-10-02: 単一REST PUTとprivateな固定source snapshotを内部runnerへ接続

- no-follow regular file/asset上限/size/全量SHA/stat照合、private/fsync済み一時snapshot、claim/begin/PUT前の最新source照合を追加した。本文/path/secretは保持journalへコピーせず、元ファイルは変更・削除しない。
- account一致credentials、exact staging key/size/hash、一回限りPUT、bounded success/size receipt、全量GET検証、redirect拒否、source/response IO終了awaitを追加した。live IO中dispose/再送/REST CAS fenceは拒否し、承認済みU1を未検証仮定のまま維持する。
- mock API/管理handler/durable runnerの3種stagingと実Bun loopbackの8MiB stream、転送中source変更、早期応答/応答喪失/取消待ち/過大receipt/Range/foreign/symlink/再送拒否を回帰した。`bun test`（593件、9895 assertions）、`npm run check`、内部adapterのBun bundleに合格。
- 公開CLI/候補Worker入口は変更せず、Cloudflare書込/deployは行っていない。実Cloudflare REST/300MB測定、最新draftのpublication照合と安全な外部復旧は残る。詳細は`m6_staging_rest.md`。

## 2026-10-02: Publication内部client・状態照会・durable job journalを接続

- commitの未公開wire入力へ完全manifest hashを必須追加し、保持manifest照合後だけmarkerを作る。同job/対象/generationでもpayload hash/base/stage ID/timestampが変われば拒否する。claim/commit responseもmanifest hashを返し、sharedのexact marker key/hash helperとWorker互換re-exportを追加した。
- 未公開publication statusを共通read-only runtime/snapshot boundaryへ接続した。保持manifest/request/marker/status/progress/receiptと前後ETagを照合し、payload/staging内容を読まず、paused/active execution/履歴も観測だけを行う。staging検証/復旧許可はfalseで、tokenを登録/返却しない。
- `PublicationAdminClient`と`.castloop/publication-jobs/<serviceId>/<jobId>.json`のprivate/fsync/rename付きjournal/非期限lockを追加し、claimとcommitを別の明示操作へ接続した。POST前requested保存、完全manifest/operation/exact Episode key照合、未知応答/receipt保存失敗非再送、非書込offline/remote照会を実装した。
- ローカルdisk/client/API/M6 Queue結合で初回Show/Episodeと2種改訂、媒体/history/GUID/date保持、purge後published化、stale入力拒否、応答喪失/保存失敗/live・残存lock/active execution/過去status/不正record/secret非保持を回帰した。`bun test`（576件、9776 assertions）、`npm run check`、browser/Bun bundle、M6実証tsconfig、Linux x86-64 binary build、`git diff --check`に合格。
- 公開CLI/Worker入口は変更せず、`m6_ready=false`を維持する。Cloudflare書込/deployや既存v0.1.1環境への適用は行っていない。REST/source/local draft adapter、同job retry、安全な外部復旧と公開gateは残る。詳細は`m6_publication_client.md`。

## 2026-10-02: Staging内部client・状態照会・durable upload journalを接続

- 未公開staging statusを共通read-only runtime/snapshot boundaryへ接続した。保持manifest/control request/progress/status/完了receiptと読取前後ETagを照合し、payloadを読まず、paused/検証token保持中や履歴jobも観測できる。PUT/復旧許可は常にfalseで、観測から終了や再許可を推測しない。
- `StagingAdminClient`のservice/operationとexact key/size/hash/order照合を追加し、lifecycleと固定HTTPS/redirect拒否/bounded UTF-8/no-store/固定診断transportを共通化した。既存lifecycle契約の回帰を維持し、legacy/移行clientは変更していない。
- `.castloop/staging-uploads/<serviceId>/<operationId>.json`にprivate/fsync/rename付きjournalと非期限lockを追加し、claim→一度限りbegin/PUT→明示settlement→検証/取消を別段階として接続した。各POST/最初のPUT前にdurable phaseを保存し、未知応答/保存失敗では再送せず保持する。PUT例外は全Promise終了後に固定診断と予定abortedだけを残し、後続PUTやpayload削除をしない。
- ローカルdisk/client/API/binding mockで3種payload、状態照会非書込、paused drain、live PUT/未知検証token、各応答喪失/保存失敗、偽permission、offline/残存lock/foreign/不正record/secret非保持を回帰した。`bun test`（557件、9437 assertions）、`npm run check`、browser/Bun bundle、M6実証tsconfig、Linux x86-64 binary build、`git diff --check`に合格。
- 公開Worker入口/CLI書込commandには接続せず、Cloudflare書込/deployや既存v0.1.1環境への適用は行っていない。REST単一PUT/U1の承認済み方針を維持し、実REST source adapter/publication client/安全な外部復旧と公開gateは残る。詳細は`m6_staging_client.md`。

## 2026-10-02: Lifecycleのdurable job journalと明示的なclaim/commit/retryを追加

- `.castloop/lifecycle-jobs/<serviceId>/<jobId>.json`へidentity/確認済みrequest/最小receiptだけを凍結するprivate/fsync/rename付きjournalとexclusive非期限lockを追加した。本文/secret/任意exceptionを保持せず、strict/16KB/hash/phase照合で入力変更・foreign identity・飛ばし/後退を拒否する。
- 未公開`runLifecycleClaim`/`runLifecycleCommit`/`runLifecycleRetry`を内部clientへ接続した。claimとcommitは別の明示操作で、各POST前にrequestedを保存する。retryも同jobのowner/marker/execution検査後に一つの通番を凍結し、一回だけ送信する。unknown response/receipt保存失敗はrequestedを保持し、後の観測から成功認定/再送しない。
- offline record/lock照会とremote job照会は非書込で、live/残存lockを削除せず、token終了を推測しない。disk/client/API/Queueのローカル結合で3操作・応答喪失・保存失敗・live排他・残存lock・foreign/不正record・偽receipt・secret非保持を回帰した。詳細は`m6_lifecycle_client.md`。
- `bun test`（528件、9050 assertions）、`npm run check`、内部client/runner Bun bundle、M6実証tsconfig、Linux x86-64 binary build、`git diff --check`に合格。公開CLI/現行Worker入口へは接続せず、Cloudflare書込/deployや既存v0.1.1環境への適用は行っていない。unknown outcomeの外部復旧とM6公開gateは残る。

## 2026-10-02: Lifecycle内部clientのstrict応答照合と一回限り送信を追加

- 未公開`LifecycleAdminClient`を追加した。固定HTTPS origin/redirect拒否/管理key/送信前service・action・request hash・削除確認、応答no-store/JSON/64KB/strict UTF-8/取消awaitを実装し、凍結requestとservice/result/全operation identity/preview pageを照合する。
- clientはID/generation/timestamp/confirmationを生成せず、失敗/応答喪失で自動再送しない。任意のserver本文やtransport exceptionを診断へコピーしない。client→内部管理API→M6 Queue adapterの6操作、foreign/偽response、body上限/取消待ち、commit成功応答喪失後のowner/marker保持と読み取り専用照会を回帰した。
- `bun test`（514件、8901 assertions）、`npm run check`、Linux x86-64 binary build、`git diff --check`に合格。公開CLI/現行Worker入口へは接続せず、Cloudflare書込/deployや既存v0.1.1環境への適用は行っていない。durable journal/unknown outcome復旧と公開gateは残る。詳細は`m6_management_api.md`。

## 2026-10-02: Lifecycle内部API・dry-run・状態照会・同job retryを接続

- 未公開`handleM6LifecycleAdmin`を追加し、Show/Episodeの停止・再開・削除を共通service registry/runtime gate、Show CAS受付、凍結request/commitへ接続した。変更操作にはrequest全体のhash確認、deleteには不可逆削除と運用記録保持の明示承認を要求する。HTTP handlerはpayloadを直接削除しない。
- 読み取り専用runtime/snapshot boundary、非予約dry-run、最大100 objectsの削除page集計、保持jobのstatus/progress/owner照会を追加した。previewはpayload検証/実行許可ではなく、statusはretry許可ではない。本文/未知key名/任意exceptionを返さず、古いjobは後の状態変更後も履歴として照会できる。
- 同jobの明示retryはpause中にも可能だが、live/未知execution token・foreign/完了/変更requestを拒否する。既存marker/status/progressを変更せずQueue送信を一回awaitし、送信応答喪失ではownerを保持して自動再送しない。
- 内部API→M6 Queue adapterのローカル結合で6操作の404/200/410、immutable媒体/履歴保持、bounded削除/兄弟分離/運用記録保持、preview非書込、確認入力、paused drain、live consumer拒否、purge失敗同job復旧、未知応答、不正/過大/途中変更recordを回帰した。
- `bun test`（504件、8550 assertions）、`npm run check`、内部handler/Worker browser bundle、M6実証tsconfig、Linux x86-64 binary build、`git diff --check`に合格。現行Worker/bridge/candidate fetchや書込CLIには公開せず、`m6_ready=false`を維持する。Cloudflare書込/deployや既存v0.1.1環境への適用は行っていない。詳細は`m6_management_api.md`。

## 2026-10-02: Publication内部APIと共通管理invocation boundaryを接続

- 未公開`handleM6PublicationAdmin`をstrictな共有wire契約と凍結manifest/Show CAS受付/staging検証/commit作成へ接続した。service設定・identity・registry登録・副作用前後のreadiness/実行version/cache owner確認を`withM6ManagementInvocation`でstagingと共通化した。新claimはopenだけ、既受付commitはpause中にも収束可能とする。
- PublicationRequest、Show/Episode commit、既存RFC3339 timestamp検査をsharedの独立moduleへ移し、従来exportと検査条件を維持した。commitはretained staging証拠/current ETag/base revision/history/unchanged audioを照合し、公開payloadへ直接書かずmarkerを最後に作る。HTTP側で追加Queue送信しない。同markerの明示照合は再PUTせずcreated=falseを返す。
- 新staging内部API→publication内部API→M6 Queue adapterのローカル結合で、Show/Episode初回公開・metadata-only/audio-only改訂・媒体/history保持・purge後published化を回帰した。pause/live commit registry保持、payload/base/proof変更、foreign owner、commit応答喪失/最後のgate失敗、未知token、candidate書込拒否も確認した。
- `bun test`（477件、8319 assertions）、`npm run check`、browser bundle、M6実証tsconfig、Linux x86-64 binary build、`git diff --check`に合格。内部handlerは現行Worker/bridge/candidate fetchや書込CLIへ公開せず、`m6_ready=false`を維持する。Cloudflare書込/deployや既存v0.1.1環境への適用は行っていない。詳細は`m6_management_api.md`。

## 2026-10-02: Staging管理の内部APIを共通service受付・配信gateへ接続

- strictな共有wire契約と未公開`handleM6StagingAdmin`を追加した。認証/16KB bounded JSON/service identity検査後、claim/beginはm6_admin、settle/finishはm6_recoveryとして登録し、実行version/readiness/cache owner gateの前後で既存Show CAS・一度限りPUT開始・明示settlement・stream検証/取消をawaitする。
- pauseは新規受付/PUT開始を止めるが、既受付uploadの明示settlement/検証/取消は収束可能とした。begin HTTP終了後もShow uploading ownerは保持し、token取得/一度限り開始の応答喪失では再許可・自動奪取しない。abortはpayloadを削除せず、任意exception/本文/secretを管理記録やresponseへコピーしない。
- ローカルhandler結合でShow/metadata/audio、pause/live stream排他、未知token/begin応答喪失、checksum/owner/generation/schema/size検査と固定診断を回帰した。現行Worker/bridge/candidate fetchとCLI書込には接続せず、candidateはmock readinessがあってもread-only、`m6_ready=false`を維持する。詳細は`m6_management_api.md`。
- `bun test`（462件、8158 assertions）、`npm run check`、独立handler/browser bundle、M6実証tsconfig、Linux x86-64 binary build、`git diff --check`に合格。Cloudflare書込/deployや既存v0.1.1環境への適用は行っていない。

## 2026-10-02: Bounded初期化の各stepをdurable setup journalへ接続

- 未公開`runMigrationSetupInitializationStep`を追加した。quiesced/前step確認済みpendingだけから、同bridge/tag/owner/凍結quiescence/空registry/token不在/bootstrap不在と前回確認済みprogressの完全一致をGET確認し、step番号/上限/beforeをdurable保存した後だけ一回のapply POSTを送る。POST応答と終了後GETのplan/hash/phase/target上限・単調性を照合してから次phaseを保存する。
- 応答喪失、終了後GET失敗、保存失敗、未知token、偽completion/phase/foreign version/進捗矛盾は`initialization_requested`で保持する。成功recordのGET観測でも再送/次stepへ進めず、外部clientが進めたprogressを黙って採用しない。最新stepの最小入力/応答/前後progressだけを保存し、凍結入力変更/step飛ばし/POST省略を拒否する。
- 正常なEpisode→Show初期化後も、明示的verificationで`runtime`へ達したら`controls_initialized`で停止する。payloadを変更せず、serviceはlegacy/migratingのまま、候補deploy/full cutover/readiness/受付再開は行わない。空inventoryもverificationを省略しない。既存offline照会は追加phaseを読み取れるが書込CLIは未公開。
- `bun test`（443件、7981 assertions）、`npm run check`、M6実証tsconfig、bridge/candidate browser bundle、Linux x86-64 binary build、`git diff --check`に合格。生成binaryの`migration-status --local`でも、key/tokenなしのworkspaceで`controls_initialized`を状態変更せず読み取れることを確認した。ローカルhandler/mock検証であり、Cloudflare書込/deployや既存v0.1.1環境への適用は行っていない。unknown復旧/full cutover/管理routes/実機受け入れが成立するまで`m6_ready=false`を維持する。詳細は`m6_migration_setup_client.md`。

## 2026-10-02: Pause・claim・旧IO申告のdurable setup journalとoffline照会を追加

- `.castloop/migration-setups/<serviceId>.json`にbridge receiptとcaller指定のpause/migration ID/timestamp/明示的書込停止申告を凍結した。private/exclusive/fsync/rename/非期限lockを用い、各POST前にrequested phaseを保存し、成功応答と保存後だけ進める。claim generationは同pause owner/空registryのGET後に一回だけ固定し、live処理中はpauseを保持する。
- 各POSTの応答喪失・保存失敗・unknown tokenはrequested phaseを保持し、GETに成功recordが見えても再送/新ID/phase解放へ進めない。初期化成功を保存済みでpause POST未開始の`admission_ready`だけに限定した明示再開を追加した。quiescence input/hash/bridge/ownerとforeign effectsを照合し、phase飛ばし/変更を拒否する。apply/deploy/移行完了/受付再開は自動実行しない。
- server statusへbounded/strictなquiescenceを追加し、owner/request/bootstrap bridge不一致や過大recordをfail closedで拒否する。`migration-status --local`はrecord/lockの読み取り専用表示だけで、key/token/HTTPなし、`remote_state_checked=false`を明示する。live/残存lockも削除せず、空workspaceにrecordを作らない。
- `bun test`（430件、7850 assertions）、`npm run check`、M6実証tsconfig、bridge/candidate browser bundle、Linux x86-64 binary build、`git diff --check`に合格。ローカルhandler/mockとfetch禁止のCLI child-process検証であり、Cloudflare実機や既存v0.1.1環境への書込/deployは行っていない。unknown復旧/full cutover/実機受け入れ/CLI書込公開を完了するまで`m6_ready=false`を維持する。詳細は`m6_migration_setup_client.md`。

## 2026-10-02: Bridge管理操作とbounded初期化をclientへ接続

- `MigrationAdminClient`に明示的なinitialize/pause/claim/quiescence/1-step初期化、開始前限定abort/legacy resumeを追加した。各操作は初回bridge検査receiptを受け取り、service/account/Worker一致とPOST前の同実行version/UUID tag/legacy modeを要求し、active migration execution tokenは奪わず拒否する。入力ID/generation/timestamp/旧IO確認はcallerの凍結値を使い、自動生成・retry・工程loopをしない。
- pause/operation/apply inputとstrict responseをshared schemaへ移し、server/clientで同じ上限/結果契約を利用する。初期化responseは`pending`と`applying/verifying/runtime`だけに制限し、`completed/finished`や付加readinessを成功扱いしない。quiescenceの別bridge version、foreign request/receipt、無効ID/上限はPOST前に拒否する。
- 実管理handlerとのローカル結合でpause→drained claim→明示quiescence→Episode/Show初期化→runtime停止を回帰した。plan以後のabort/resume拒否、実行version/tag/token不一致、pause/claim応答喪失でのPOST非再送、偽completion応答の拒否も確認した。durable claim/申告journalと移行書込CLI、full cutover/受付再開は未接続である。
- `bun test`（416件、7718 assertions）、`npm run check`、M6実証tsconfig、bridge/candidate browser bundle、Linux x86-64 binary build、`git diff --check`に合格。mock/ローカル統合であり、Cloudflare実機や既存v0.1.1環境への書込・deployは行っていない。`m6_ready=false`とCLI公開gateを維持する。詳細は`m6_migration_client.md`。

## 2026-10-02: 初回bridgeのdurable一度限りdeployとGET限定復旧を接続

- 未公開の`runMigrationBridgeDeployment`/`createMigrationBridgeRestEffects`を追加した。明示的な旧管理端末新規書込停止/他deploy停止申告をstrict requestへ固定し、service単位のprivate/fsync/rename付き`.castloop/bridge-deployments/<serviceId>.json`とexclusive非期限lockで別UUIDからの再開始・phase後退/飛ばしを拒否する。候補のserver開始許可は初回bridgeへ流用しない。
- 開始前とPUT直前に同legacy snapshotを照合し、durable `uploading`保存後だけ一回のstrict-inherit PUTをawaitする。実bridgeの認証no-store status/version/UUID tagとREST100%配信を照合してpreview無効化POSTをawaitし、全REST終了後だけ`rest_settled`を保存する。default cache無効/version隔離/所有binding/logs・traces/previewをGET再検査したreceiptから`verified`へ進む。
- PUT/preview応答喪失・不正tag/部分配信・保存失敗は`uploading`で保持し、自動再送・時間/GETでの終了認定をしない。開始消費後のpreflight失敗も未送信と推測して再許可しない。`rest_settled`からの明示再開はGETのみ。残存lock/unknown outcomeの安全な外部復旧は未成立で、release gateを維持する。
- statusにpublished service/account/Worker identityとbridge UUIDを追加し、admission未初期化でもclientがforeign targetを拒否する。mock RESTと実bridge管理handlerのローカル結合、live PUT排他、未知応答、secret非保持、private file、破損/過大record、GET限定復旧を回帰した。詳細は`m6_initial_bridge_client.md`。
- `bun test`（410件、7627 assertions）、`npm run check`、M6実証tsconfig、bridge/candidate browser bundle、Linux x86-64 binary build、`git diff --check`に合格。Cloudflare書込・実機deployは行わず、既存v0.1.1環境と現行deploy/init/embedded Workerは未変更。初回bridge/移行書込CLI・full cutover・管理routes・強制終了復旧・実機受け入れを完了するまで`m6_ready=false`を維持する。

## 2026-10-01: 初回bridge用のread-only REST準備を分離

- `prepareMigrationBridgeDeployment`/`CloudflareApi.prepareMigrationBridge`とstrict bridge metadata/準備requestを追加した。既存legacy Workerの期待単一version 100%、default-only fetch/queue、service binding/旧date/flags/全binding snapshot、workers.dev有効/domainなしをGET照合し、settings/preview/deploymentを再GETする。追加KV等の未知binding parameter変更もhash/照合から落とさない。
- bridge UUIDをversion tagへ固定し、default cache無効/cross-version無効/version metadata binding/ctx.exports/logs/tracesを明示する。secret/追加bindingは指定legacy versionからinheritし、sampling/tag/tail/placement/logpushを保持する。旧cross-version設定の省略は`unspecified`として保持し、cache scope/purge/旧IO終了へ昇格しない。準備requestはID/観測値/hashだけを返し、durable local保存や初回deploy許可を実行しない。
- pure/GET-only mock RESTテストでlegacy profile・secret非コピー・runtime/追加binding不一致・途中変化・共通schema gateを確認した。詳細と初回一度限りdriver/preview無効化/unknown outcome保持の残件は`m6_migration_bridge_preparation.md`へ記録した。CLI書込commandと現行deploy/initへは未接続で、既存v0.1.1環境/Cloudflare実機へ書込していない。
- `bun test`（398件、6998 assertions）、`npm run check`、M6実証tsconfig、bridge/candidate browser bundle、Linux x86-64 binary build、`git diff --check`に合格。mock/ローカル確認であり、実response shape/全hostname・colo/旧cache撤去/300MB・CPU・料金/移行完了の合格ではない。

## 2026-10-01: 候補REST deploy adapterとdurable journalを結合

- 凍結bootstrapへ実Cloudflare REST候補PUT/preview無効化/GET inspectionを組み合わせる未公開`createMigrationRestEffects`を追加した。bridgeの認証status・初期化済みruntime owner・空registry・未知execution不在・単一期待version 100%・default cache無効・旧preview無効・domainなし・settings再照合を要求し、旧Workerへ直接candidateをPUTしない。対象は同accountの既存workers.devに限定する。
- upload source/metadata hashと`workers/tag`のbootstrap UUIDを固定し、secret/追加bindingは指定bridge versionから`bindings_inherit=strict`で継承する。PUT成功のscript IDをversion IDと扱わず、候補の認証no-store status/実行version/tag/凍結requestを照合後、期待100% deploymentでpreview設定POSTをawaitする。全REST終了後だけ`rest_settled`へ進み、PUT/preview応答喪失/候補不一致から自動再PUTしない。
- candidate settlement/HTTP windowにもbootstrap tag照合を追加し、管理clientとREST認証requestはredirect拒否、管理応答は明示的no-store必須にした。結合テストで一回限りPUT・secret非保持・preview応答喪失・設定変化・GET失敗後のinspection/同settlement限定再開を確認した。全suiteで発見した既存CAS競合testの非決定的scheduleは、双方の初回readをbarrierで揃えるtest-only修正で安定化した。
- `bun test`（391件、6911 assertions）、`npm run check`、M6実証tsconfig、bridge/candidate browser bundle（`cloudflare:workers` external）、Linux x86-64 binary build/version/migration-status help、`git diff --check`に合格。実REST形状はmock確認であり、Cloudflare書込/deploy/実機合格ではない。現行binary embedded Worker/deploy/initと既存v0.1.1環境は未変更。初回bridge deploy・移行書込CLI・full cutover・safe unknown-token復旧・管理routes/実機受け入れを完了するまで`m6_ready=false`を維持する。

## 2026-10-01: 移行client・durable deploy journal・読み取り専用CLI照会を追加

- 固定HTTPS origin/redirect拒否/自動retryなしの`MigrationAdminClient`を追加した。status/prepare/begin/settlementのschemaとservice/request/plan一致を検査し、応答streamをboundedにした。server statusにも同じstrict照合を接続した。
- 未公開client helperにsource/metadata hash固定、private/fsync/rename付き`.castloop/migrations/<bootstrapId>.json`、exclusive非期限lock、開始申告前とPUT前のdurable phase、inspection/settlementだけの明示再開を追加した。開始/PUT/保存の不明応答では自動再PUTせず、稼働中/残存lockも奪わない。実Cloudflare deploy adapterと移行書込CLI commandはまだ接続しない。
- `castloop migration-status`だけを認証GETの読み取り専用照会として公開した。旧Workerはroute未提供で、コマンドが自動deploy/移行/受付再開することはない。従来deploy/binary Worker入口と既存環境は変更していない。詳細は`m6_migration_client.md`参照。
- `bun test`（382件、5873 assertions）、`npm run check`、M6実証tsconfig、bridge/candidate browser bundle、Linux x86-64 binary build/version/migration-status help、`git diff --check`に合格。新11件はmock/ローカル統合で、Cloudflare実deployは行っていない。

## 2026-10-01: 移行bridge・凍結bootstrap・候補HTTP検査を接続

- 独立bridge/candidate入口へ認証必須の移行APIを追加した。service pause/drain/空registry移行受付、旧IO外部確認のstrict凍結申告、bounded applyを接続し、初期化はruntimeで停止する。現行binary/deploy/既存環境は変更していない。
- bridge default purge成功後の一度限りdeploy開始と、source/metadata/plan hash・candidate versionに固定したsettlement/配信windowを追加した。開始応答喪失では二重PUT許可を返さず、候補は初期化完了plan/progress/quiescence照合後だけstate-first配信する。通常管理書込/consumer/M6完了・受付再開はまだ閉じている。
- default loopbackでHEAD/GET/Range/304とstatus/version/再検証header/size/ETagをbounded検査し、chain hash/cursorをCAS保存する。失敗・CAS/応答喪失・live HTTP中のtoken保持を回帰した。bodyはcancelし、本文・任意exceptionを記録しない。HTTP合格やclient REST snapshotだけからfull cutover/readinessを生成しない。
- 詳細・暫定停止区間・purge/loopback/client申告の証明範囲とCLI/finalizer/外部検証/復旧残件を`m6_migration_bootstrap.md`へ記録した。Cloudflare deployや実機合格ではなく、旧v0.1.1環境の移行案内も未提供。
- `bun test`（371件、5763 assertions）、`npm run check`、M6実証tsconfig、bridge/candidate browser bundle、Linux x86-64 binary build、`git diff --check`に合格。追加22件はmock/ローカル統合である。

## 2026-10-01: 別entry moduleのM6候補Workerへgateway/new consumerを接続

- `src/m6-worker.ts`にdefault fetch/queueと`CachedPublicAssets`のnamed exportをまとめ、型付き`ctx.exports` loopbackを`m6-routes.ts`へ渡した。現行Worker/binaryのentrypointやdeploy/initは変更せず、実deployも行っていない。
- 候補public fetchはservice設定/readiness/実行versionを毎要求照合してからlifecycle状態照会→generation付き内部cacheへ進む。未移行/別versionは503/no-store、停止404、削除410、cache/破損record障害503とし、legacy配信へfallbackしない。
- 候補Queueはservice/DLQ/batch/readinessを検査後、service invocation登録→共通Show execution token→配信gate/effect factory→新Show/Episode publicationまたはlifecycle consumerへdispatchする。Show削除の同job続行、internal purge待ち、正常終了時の2種token返却、DLQでstatus/owner非変更、旧marker非昇格を統合した。
- 候補管理APIは認証GETだけで、旧/新管理書込は409。capabilityはcompiled gateway接続を`m6_candidate`/delivery=trueで区別するが、未提供command/staging/publication管理操作と`m6_ready`はfalse。移行bootstrap/HTTP検証順序・旧IO/cache purge・本番API/CLI・安全な強制終了回復・rollbackが残る。契約を`m6_candidate_worker.md`へ記録した。
- `bun test`（349件、5589 assertions）、`npm run check`、M6実証tsconfig、候補Worker browser bundle、Linux x86-64単一binary build、`git diff --check`に合格。新17件はmock/ローカル統合であり、Cloudflare実機・300MB/CPU/Free制限・複数colo/hostnameの合格ではない。既存v0.1.1/運用環境は未変更。

## 2026-10-01: M6向けREST metadata生成と読み取り専用のdeployment検査を追加

- 純粋なmetadata builderにdefault cache無効/named cache有効/cross-version cache無効、version metadata binding、ctx.exports flagとlogs/tracesを明示した。既存secretと無関係なbindingはinheritし、sampling/tag/tail/placement/logpushは保持する。既存deploy/initへはまだ接続しない。
- Cloudflare REST GETのdeployment/version/settings/subdomain照合と再GETを追加した。単一の期待versionの100%配信、cache入口、所有binding、telemetry、旧version preview無効化を要求する。設定変化/部分配信/別version/不明fieldをfail closedで拒否し、返却証拠はIDとallowlistedな成立条件だけにする。旧IO/cache purge等の完了証拠には変換しない。
- 現行legacy deployはM6 cache export/version metadataを見つけたらPUT前に拒否する。通常のlegacy cache/binding政策は回帰で維持した。このpreflightは原子的な移行/deploy fenceや旧バイナリの停止に置き換わらない。
- `bun test`（332件、5374 assertions）、`npm run check`、M6実証tsconfig、Linux x86-64単一binary buildに合格。docs形状のmock RESTであり、実upload/実機合格ではない。契約と残件は`m6_worker_deployment_inspection.md`参照。既存v0.1.1/運用環境は変更していない。

## 2026-10-01: 実行version・cache owner・service tokenを照合する配信gate adapterを追加

- `createM6DeliveryGate`はservice registryのM6 invocation token、移行完了readiness、実行Worker version metadata、uncached gateway protocolとcache owner RPCのstrict識別結果を照合する。RPC待ち後もtoken/readinessを再確認し、旧/返却済みtoken、foreign version/entrypoint、破損record、不明protocol、purge API欠落を拒否する。
- `CachedPublicAssets.describeRuntime`にversion metadata bindingとpurge API存在からの内部識別結果を追加した。本文/secretやHTTP公開診断は含めず、実cache設定/100%切替をRPCだけで証明したとはしない。配信gateはR2書込/purgeを行わず、既存effect factoryの必須callbackとして利用する。
- Show停止consumerと実gate adapterをmockで統合し、不一致時に公開状態/payload/purgeを進めず、通常終了後のShow実行token返却とjob owner保持を確認した。paused drain、RPC待ち中のtoken/readiness変更、未知runtime/target、missing bindingも確認した。
- main module export/default cache無効deploy/loopback・実version binding・M6 routingにはまだ接続していない。本番設定の検証、旧IO終了、100%切替、旧cache purge、out-of-band deployの制限と安全なtoken回復は残る。範囲/限界を`m6_delivery_runtime_gate.md`へ記録した。既存v0.1.1/運用環境へのdeployは行っていない。
- `bun test`（318件、5257 assertions）、`npm run check`、M6実証tsconfig、cached entrypoint/gateのbrowser bundle、Linux x86-64単一binary build/version/help、`git diff --check`に合格。binaryはv0.1.2と従来コマンドのみを維持し、実機合格やlifecycleコマンド公開を主張しない。

## 2026-10-01: 凍結移行planのCAS初期化・途中再開とcapability照会を追加

- strictな凍結planに許可された既存object key/ETag/sizeと制御record値を保存し、Episode→Showの順に条件付きPUTで初期化する。既存lifecycleの停止/generation/tombstoneとpayloadは保持する。service identity、inventory/sourceの追加/消失/変更、未知key、不完全owner等をfail closedで拒否する。
- 移行execution tokenを取得し、bounded apply→全inventory照合→runtime callback→durable finished証拠→service CASへ進む。PUT/progress/完了応答喪失は凍結値から再開し、初期化済みcontrolを上書きしない。正常/例外終了後だけ既知tokenを返し、取得応答喪失/強制終了の未知token回復は追加しない。完了後もpausedを維持する。finished証拠からの完了再試行は同じruntime証拠の再確認を必須にした。
- 現行Workerに認証必須・no-store・読み取り専用の`GET /admin/capabilities`を接続した。registry未初期化でも書込まず、mode/state/generation/稼働件数だけを返し、token/本文/secretは返さない。このWorkerの未接続M6 routeはfalse、`m6_ready=false`を維持し、mock readinessから本番安全性を推測しない。
- 本番quiescence/cutover callbackの契約と未完成rollbackを`m6_migration_runtime_contract.md`へ記録した。移行apply自体のAPI/CLI接続、100%対応Worker切替、旧IO終了確認、cache purge/本番配信gateは未完成であり、実deployも既存環境の更新も行っていない。
- `bun test`（311件、5211 assertions）、`npm run check`、M6実証tsconfig、Worker/移行moduleのbrowser bundle、Linux x86-64単一binary build/version、`git diff --check`に合格。apply/preserve、各PUT応答喪失、live実行token、source変化、無効runtime証拠、切替中の旧書込、finished後のdeployment変化、private値非保持、capability認証/read-only/fail-closedを確認した。これらはmock/ローカル確認であり、新しい実機合格ではない。

## 2026-10-01: サービス単位の原子的な書込停止・移行受付を追加

- `system/lifecycle-service.json`のstrict CAS recordにlegacy/M6 mode、open/paused/migrating、最大32件のmutating invocation tokenを保持する。pauseは新しい管理書込を止めるが、取得済みtokenの処理と、既存jobのconsumer/限定retryはpaused中も収束できる。移行は同じCASでregistryが空の場合だけmigrating ownerを取得し、以後consumerも登録できない。事前のreadだけによる受付停止ではない。
- 現行WorkerのShow予約/publication claim/cleanup/retry、Queue/DLQの書込をregistryへ接続した。認証/入力検証後、service設定をstrict/boundedに読み、未初期化ならlegacy recordをCAS作成してから登録する。正常/例外で処理をawaitした後だけtokenを返す。停止中管理書込は409、破損record/不明な失敗は固定診断503でfail closedする。legacy公開HTTPは今回変更していない。
- 移行requestはpause IDと期待service generationを凍結し、同IDの変更再送を拒否する。移行execution tokenもCAS排他し、未知tokenを時間で奪わない。plan/progressが未作成でexecutionがない移行だけ取消しでき、generationにより旧凍結requestの再claimを拒否する。M6 readiness evidenceはschemaのみで、今回M6 modeへ切り替える経路やlifecycleコマンドは追加していない。
- `bun test`（292件、5051 assertions）、`npm run check`、M6実証tsconfigに合格。registry同時更新/返却、pause中のdrain、consumerとmigrationのCAS競合、live callback/Queue待ち、pause/resume/取得の応答喪失、移行token、旧request取消後拒否、現行管理APIの停止/破損拒否を確認した。
- 実deployは未実施。旧Workerを100%置換し、登録前の旧invocationと旧CLI REST直PUTを終わらせる外部確認が別途必要で、このregistryだけで以前のWorker/CLIを停止できるとはしない。強制終了/取得応答喪失の未知invocationは残り、移行をブロックする。新移行apply/capability、公開gateway切替と旧cache purgeも次の実装で接続する。

## 2026-10-01: Episode publication runner・stream媒体保存・改訂回復を追加

- `runOwnedEpisodePublication`と共通publication consumerを初回Episode/metadata-only/audio-onlyへ拡張した。凍結commitとstaging証拠を再照合し、保存済みbase revisionからGUID/公開日時と未変更metadata/audioを再利用する。active子だけのfeed入力を使い、停止中の親/子を通常publishで復帰させない。GUID重複は停止Episodeのcurrent metadataも含めたbounded inventoryで拒否する。
- 新音源はR2 bindingのReadableStream PUTでimmutable job/revision keyへ保存し、If-None-MatchとSHA-256 integrity optionを指定する。その後、保存先のETag条件付きGETをDigestStream/byte計数で全量検証する。既存keyは上書きせず、再試行では保存済み媒体をstream検証して再利用する。音源をアプリケーション側ArrayBufferへ読み込まず、旧revision媒体/履歴とstaging音源は保持する。metadata-onlyでは音源PUTを行わない。
- immutable revision metadataはCAS新規作成し、既存なら同じ候補との一致を確認する。current metadata→feed→冪等feed generation→内部purge→durable purge証拠→Episode active/generation→finished/v2 published/照合済み解放へ進める。current書込応答喪失は元のbaseと同一候補の履歴から回復し、active CAS応答喪失は同job/次generationとdurable purged progressが一致する場合だけ認める。一般の受付/commit作成はこの再開例外を使わない。
- publicationのbounded読取/checksum/保守的feed render予算を共通helperへ移し、既存Show runnerを回帰した。Worker effectはShow/Episode双方の正確な対象と実行tokenを照合して内部cache ownerへpurgeを依頼する。
- `bun test`（281件、4991 assertions）、`npm run check`、M6実証tsconfig、共通consumer browser bundleに合格。追加11件で初回/2種改訂、purge失敗、媒体/履歴/current/feed/generation/active/status/解放応答喪失、live stream、媒体/履歴競合、内容checksum不一致、停止子GUID衝突、旧receipt、新しい状態への不正再開、digest失敗診断と再試行を確認した。
- PUT checksum/stream sink・cacheはmockと型確認であり、Cloudflare実機・300MB・CPU/Free制限の合格ではない。本番Queue/API/CLIへの接続、migration/capabilityと配信gate、旧書込/consumerの収束、強制終了tokenの安全な回復は残る。運用サービス・既存v0.1.1環境へのdeploy/書込は行っていない。

## 2026-10-01: Show publication runnerと実行token付きconsumerを追加

- `runOwnedShowPublication`は凍結manifest/commit、共通Show owner/実行token、staging検証証拠を再照合し、bounded/ETag条件付きGETでmetadata/cover/serviceを読み、checksum/schema/画像signature/cover extensionを再確認する。lifecycle対応Episode集合でfeedを生成し、停止/削除/draft子を復帰させない。音源とimmutable履歴は変更しない。
- metadata→cover→feedをR2 bindingのETag CASで書き、feed generationを冪等に進め、cache所有entrypointのpurge成功をdurable progressへ記録する。初回Showはpurge後だけactiveへ進め、v2 published statusと照合済みreceiptを保存してownerを解放する。Show更新は承認済みcover keyを上書きする。stage成功だけでは公開しない。
- `consumeOwnedPublication`は実行token取得後にeffect factory/runnerをawaitする。通常例外終了では共通のsettled token返却を使い、取得応答喪失/強制終了の未知tokenは保持する。現段階はShowだけに対応し、Episode markerは副作用なしでunsupported扱いとする。本番routingへは未接続。
- `createShowPublicationWorkerEffects`で必須配信gate callbackと内部entrypointのinvalidateをつないだ。gate/factory/purge失敗、metadata/cover/feed/generation/進捗/公開状態/status/解放の応答喪失、live purge、token取得応答喪失、staging差替/状態欠落/CAS競合、旧receiptによる新owner解放拒否を確認した。purge段階からの再開ではpayloadを書き直さず、初回purge失敗中はShowを非公開に保つ。
- `bun test`（270件、4530 assertions）、`npm run check`、M6実証tsconfig、consumer browser bundleに合格。R2/内部cache bindingはmock確認であり、実機deploy/受け入れではない。Episode publication runner、migration/capability、旧処理収束、本番gate/routing/API/CLIは残る。既存v0.1.1環境と運用環境は未変更。

## 2026-10-01: 検証済みstagingからのpublication受付・commit準備を追加

- `publication-admission.ts`にstrictな凍結publication manifest、固定marker key、共通Show CASでのpublish受付、凍結control requestとmarkerの照合を追加した。`system/jobs/<draftJobId>/publication.json`には既存Show/Episode commitのhash/size/revision情報とstage操作IDだけを保存し、本文/secretは複製しない。publication job IDは凍結するdraft job IDと一致し、upload操作IDとは別にする。
- commit作成前に、参照するupload manifest/finished progress/v2 completed statusの対象・draft・要求hash・generationと、全changed assetのsize/hash/現行HEAD ETagを照合する。Showは1 uploadのmetadata+cover、Episodeはmetadata/audioの各upload証拠を使い、古いローカルhash、差替payload、不完全/取消済み/別対象の証拠を拒否する。metadata-only/audio-onlyはcurrent/base revisionとimmutable履歴を照合し、音源再利用では許可path/HEAD size/保存済みchecksumも確認する。
- marker本文は既存strict v1 publication commit形式を維持し、CASで最後に作る。新経路ではside manifestとcontrol requestとの完全一致が必須で、旧markerを暗黙に新経路へ昇格しない。新consumerはこの照合に加えて同generation/owner/実行tokenを取得し、publication入力を再確認してから副作用を行う必要がある。既存本番consumerは改修していない。
- `bun test`（261件、4176 assertions）、`npm run check`、M6実証tsconfig、新アダプター2種のbrowser bundleに合格。13件の追加テストでShow/初回Episode/metadata-only/audio-only、live stage/停止/削除拒否、検証証拠/ETag/base不一致、同job改変、10同時commitの1作成、manifest/受付/commit応答喪失、旧marker拒否、abandon/stale/processing、履歴/再利用音源の欠落を確認した。
- Linux x86-64単一binaryのbuild/version/helpも確認し、v0.1.2と従来コマンドのみを維持した。新受付は管理API/既存CLIへ未接続で、実公開runnerとproduction routing、移行/capabilityは残る。運用環境と既存v0.1.1環境は変更していない。

## 2026-10-01: lifecycle consumerのWorker binding用effect factoryを追加

- consumerは実行token取得後にeffect factoryをawaitできるようにし、factory準備の失敗も全処理終了後に実行tokenだけを返す。live factoryには別invocationが割り込まない。
- `createLifecycleWorkerEffects`は同じtokenから固定対象を生成し、feed書込/内部purge/削除配信確認の前後に所有権と必須の配信gate callbackを照合する。保存済みShow/service/coverとlifecycle対応Episode集合からfeedを作り、入力差替え、snapshot変更、feed CAS競合を拒否する。空feedを保持し、公開日時/GUID/immutable音源pathを変えず現在のpublic URLを使う。
- purgeはcache所有entrypointの`invalidate`をawaitする。削除gateは対象の`gone`を必須にする。続行はtoken返却後、同generation/ownerと凍結markerを照合してQueue bindingへ`{ object: { key } }`を送る。send失敗でも削除progressとjob ownerを保持する。
- `bun test`（248件、4056 assertions）、`npm run check`、M6実証tsconfigに合格。Show/Episode双方の停止/再開/削除、空feed、停止子除外、factory/purge/Queue失敗、live factory、偽metadata/別対象/旧token、snapshot欠落/変更、feed CAS競合を確認した。
- これは本番接続用アダプターとbinding mockでの統合確認である。main module/公開Queue routingには未接続、deployも未実施。`checkDeliveryGate`の本番実装、移行/capability、旧書込収束、強制終了token回復と実機受け入れは残る。

## 2026-10-01: stagingのstream検証・完了/取消・照合済み解放を追加

- uploading ownerへstage専用`verification_id`をCASで付与し、durable client settlement後だけ内容検証を開始する。同operationのlive検証・取得応答喪失・未終了clientでは検証/取消を開始せず、時間でtokenを奪わない。consumer実行tokenとは別に扱う。
- R2 HEADのsizeとETag条件付きGETを照合する。audioはWorkers DigestStreamとbyte計数Transformで全量SHA-256/実bytesをstream検証し、pipe/digest両Promiseのsettleを待つ。metadata/coverはそれぞれ1MB/5MBに制限してchecksumとstrict schema/画像signatureを確認し、Show ID/cover extension、Episode ID/GUID/公開日時を保護する。本文をauditへ複製しない。
- 完了にはmanifestに対応した全assetの検証証拠、完了progress/v2 status、最後のHEADによる同ETag/size確認が必要であり、owner解放と`last_finished_upload` receiptを同じShow CASへ保存する。取消は明示的settlement後だけ行い、payloadを保持してstage受付だけを解放する。公開状態/feed/媒体履歴を変更せず、stage成功はpublishではない。
- 通常の検証失敗では固定codeのretrying記録を残し、全処理終了後に検証tokenだけを返す。finished進捗の応答喪失、status応答喪失、解放応答喪失は保持recordから回復し、新ownerを旧operationから解放しない。検証済みpayloadが完了解放前に変わった場合はownerを保持してfail closedとする。
- `bun test`（238件、3530 assertions）、`npm run check`、M6実証tsconfigに合格。Show/metadata/audio、明示的abort、size/hash/schema/image/identity拒否、live検証排他、stream長不足/超過、token応答喪失・返却失敗、完了応答喪失、新ownerを確認した。DigestStream自体のテストはBun上のstream sink mockであり、300MB/CPU/Free制限の実機合格ではない。
- 管理API/既存CLIのREST PUT経路への接続と、既存publicationの新制御record対応は残る。client終了の申告とU1仮定を別のREST取消保証へ読み替えず、既存テスト環境・運用環境は変更していない。

## 2026-10-01: REST単一PUTのstaging受付と開始/終了確認を追加

- strict staging manifestにupload操作IDと継続draft job ID、対象/期待generation、asset種別・size/SHA-256を分離して保存する。Showはmetadata+cover、Episodeはmetadataまたはaudioの1操作とし、任意key/本文/secretを受け付けない。asset別上限と300,000,000 bytes上限をupload開始前に検証する。
- `claimStageUpload`はmanifestを凍結して既存Show CASのuploading ownerを取得する。commit済みdraftや停止対象を拒否する。`beginStageUpload`はdurable ready→uploadingのCASで1 callerだけに固定payload keyを返し、開始済みの再送にPUT許可を再発行しない。開始応答喪失もブロックを保持する。
- client helperは取得した固定key/size/hashを照合し、単一PUTを順にawaitする。PUTが成功/例外でsettleし、今後のPUTも行わない場合だけ終了確認を送る。begin結果不明では自動確認/取消しない。終了確認は認証された管理経路からの明示的申告であり、サーバーがREST接続終了を直接観測した証拠ではない。別端末で回復する際も旧client/PUTが終わり、今後書かないことの確認が必要で、時間/HEAD不在を使わない。
- settlement後もjob ownerはuploadingのまま保持する。内容検証・verification invocation排他・完了/取消receipt・owner解放は次の実装で接続する。client helperも既存公開CLIへはまだ接続せず、単一PUT/U1の既存仮定を変更しない。
- `bun test`（223件、3379 assertions）、`npm run check`に合格。12同時beginの1許可、manifest変更/commit/停止拒否、開始/終了確認の応答喪失、live PUT待ち、phase退行拒否を確認した。既存テスト環境・運用環境は未変更。

## 2026-10-01: 内部cached entrypointの配信・purge実装を追加

- `CachedPublicAssets`をWorkerEntrypointとして実装し、`this.ctx.props`の正確なgeneration組と許可pathだけを受け付ける。gateway用transportはloopback bindingを使い、host/queryを内部の固定URLへ正規化し、Range/条件付きheaderだけを転送する。Cookie/Authorization/管理キー等は転送しない。
- 内部handlerはHEADでmetadataを取得し、GETは同ETag条件付きR2 binding readのstreamを返す。HEADと304/412/416は音源bodyを読まない。cold MISSの単一byte/open-ended/suffix/clamped Range、If-Range、ETag/date条件・秒精度・優先順位を実装し、HEAD/GET間のobject変更は503/no-storeとする。複数/不正Rangeは無視して全量200、満たせない単一Rangeは416とする。
- feed/cover/Show/Episode tagと内部TTLを付け、purgeはcache所有entrypointのRPCからtagと末尾slash付きpath prefixを順にawaitする。どちらかが失敗したら完了扱いにしない。gatewayは外向け再検証headerを維持し、状態確認前にRange/304で配信させない。
- helperとgatewayのmock接続、header除去、条件/Range/競合、tag/prefix scopeとpurge失敗を確認した。`bun test`（210件、3322 assertions）、`npm run check`、M6実証tsconfig、内部entrypointのBun browser bundle、Linux binary buildに合格した。
- GET MISSは内部でHEAD+GETの2回のR2 operationを追加し、HEAD/304等はHEADだけになる。gatewayの状態readとloopback request課金は別途残る。料金/CPU/Free制限/300MB/複数colo・cache HIT時のHTTP処理はこのmock結果では実証しない。
- クラスはまだ本番main moduleへexport/接続せず、CLIのcache deploy設定も未変更。default入口のcache無効化・移行capability・実機回帰が必要であり、既存テスト環境・運用環境は変更していない。

## 2026-10-01: consumerの通常終了回復・削除続行とDLQ境界を実装

- `consumeLifecycleCommit`は凍結marker/owner/generation/hashを照合して実行tokenを取得し、停止/再開/削除runnerを呼ぶ。削除の1 stepが終わったら全副作用終了後に実行tokenだけを返し、job ownerをprocessingのまま保持して同じmarkerの続行送信をawaitする。FIFOや重複なしを前提にしない。
- 通常の例外終了ではrunnerのPromiseがsettleしてからtokenを返却する。token返却の成功応答喪失はremote recordで照合し、完了解放の応答喪失は同token receiptで収束する。取得応答喪失/強制終了ではtokenを取り上げず、保持中tokenへのconsume/requeueは拒否する。強制終了後の安全な回復ゲートは引き続き未成立。
- `requeueLifecycleOperation`は保持markerと凍結request・未完了ownerを照合して同じjobだけを送信する。通知/続行送信の失敗・成功応答喪失・重複、遅延purge中のtoken保持、多invocation削除、取消/古い配送・新ownerを自動テストした。管理API/本番Queueへのlifecycle実行接続はまだ行わない。
- 既存本番Queueの通知境界を固定publication/lifecycle pathのparserへ統一した。DLQ handlerは任意のmessage body/keyを保存せず、未一致配送には固定codeだけを残す。一致配送の既存`{ key }`形式を維持し、初回CASと一致照合で保持markerの衝突を拒否する。DLQ到達でstatus/ownerを変えない。
- `bun test`（200件、3217 assertions）、型検査、M6実証tsconfig、Linux binary buildで確認した。公開CLI/配信/publicationは既存経路のままでlifecycleを公開せず、既存v0.1.1テスト環境・運用環境へのdeploy/変更はしていない。

## 2026-10-01: 凍結lifecycle commitとQueue接続用の照合を追加

- Show/Episodeのlifecycle markerをstrict schemaと固定`staging/lifecycle/.../commit.json` keyで定義した。actionはunpublish/restore/deleteのみとし、対象・job・受付後generation・凍結request hash以外の本文/secretを保存しない。旧publication markerと混同しない。
- `commitOwnedLifecycleOperation`は凍結requestを照合したreserved ownerだけが初回markerをIf-None-Match CASで作る。既存markerは上書きせず、processing開始後も一致する既存markerの照会のみ許す。`readLifecycleCommit`はpath/schema/requestの対象/action/generation/hashを検証し、不正markerと読取通信障害を区別する。
- 同時作成の1勝者、成功応答喪失、取消/stale owner、publication/stage拒否、破損/過大/不一致marker・request、body読取障害を自動テストした。作成自体は配信状態を変更せず、consumer開始時のowner CASが引き続き必要である。
- `bun test`（181件、3041 assertions）、`npm run check`に合格。管理API/CLI/本番Queueには未公開で、既存テスト環境へのdeploy/変更はしていない。

## 2026-10-01: 管理者のv0.1.1テスト環境を読み取り専用で確認

- 管理者が既存環境はテスト用で削除可能、CLI/Workerはv0.1.1、1 Show/2公開Episode、処理中/失敗中jobなしと申告した。[移行前基準](./m6_legacy_test_baseline.md)へ記録した。管理API/R2/Queueの状態を取得したわけではない。
- 公開feed GETは200/item 2件、音源2本のHEADは200でfeed記載サイズと一致、先頭16 bytesのRange GETは206、cover HEADは200だった。NRTの音源cache HITと既存immutable応答を確認した。GUID/date/path/サイズだけを記録し、本文/メールを複製せず、音源全体のchecksum/再生確認は行っていない。
- 公開URLの読み取り以外のCloudflare操作、deploy、R2書込/削除、環境撤去は実施していない。v0.1.1からの安全な移行手順と本番統合は未完成で、既存環境は基準として保持する。

## 2026-10-01: 保存済みShow/Episodeの公開再開を追加

- `runLifecycleRestore`はR2のpublished Show/service snapshotと現在のpublic_base_urlだけを読み、coverとactive/復帰候補Episode音源のHEAD照合→feed再生成→冪等feed generation→purge→durable purge証拠→active化→完了status/owner解放へ進む。stagingやローカルの未公開編集を使わず、GUID/公開日時/revision/音源pathとbytesを変更しない。
- Show再開は子制御recordを変更せず、個別停止/削除/draftをfeedへ復帰させない。空Showも対応する。Episode再開はactive親を必須とし、期待generationと最終jobを照合してCASで1度だけ進める。配信gate callbackは必須で、purge後にgateが失敗してもactive化せず、保存した準備証拠から再試行できる。
- restore progressのvisibility/finishedにはpurge確認を必須にし、準備phaseでのpurge完了や削除phase混入をstrict schemaで拒否する。snapshot欠落/過大/対象不一致、親/対象/generation変化、feed/gate/purge失敗、状態/進捗/status/解放応答喪失を自動テストした。通常終了が確認された実行からのtoken返却/再取得もmockで確認したが、runtime強制終了や取得応答喪失の安全な回復が成立したとは扱わない。
- `bun test`（171件、2924 assertions）、`npm run check`、M6実証tsconfig、Linux x86-64 binary buildとversion/helpに合格。公開binaryは0.1.2のままでlifecycleコマンドを表示しない。本番effect/Queue/API/CLI/移行/配信は未接続、Cloudflare実機の新規操作・運用変更・Releaseは行っていない。

## 2026-10-01: 削除開始と最終確定を接続

- `stepLifecycleDelete`を追加し、配信状態をdeletingへ変更→配信gate確認→active親のEpisode feed更新→generation→初回purge→durable削除進捗へ接続した。Show削除と停止中の親ではfeedを書かない。削除batch後は最終purge→tombstone→finished progress→completed status→同一CASのowner解放/receiptまで進める。
- payload削除と子tombstoneは1回最大100 objectのstepに分けた。Show削除では子Episodeの制御recordだけをページ単位でdeletedにする。既存deleted recordは変更せず、子generationは維持する。親Showの受付generationと不可逆deletedゲートで旧job/ID再利用を拒否し、最大generationの子も削除できる。件数は応答喪失で過少になり得る診断値である。
- strict progressに最終purge証拠とShow子tombstoneのcursor/完了証拠を追加した。削除finishedには全scopeのverification完了、cursorなし、初回/最終purge、必要な子tombstone完了を要求する。不正な子recordは上書きせずownerを保持して停止する。
- Episode/Show、draft/停止対象、最後のEpisodeの空feed、部分DELETE、初回/最終purge失敗、feed/gate失敗、各状態/進捗/完了/解放応答喪失、新owner取得後の旧実行再送を自動テストした。媒体bodyは読まず、必要marker/予約/service/別Showを保持し、診断へ例外本文を保存しない。
- `bun test`（160件、2457 assertions）、`npm run check`、M6実証tsconfigに合格。本番gate callback、Queueの続行とinvocation引継ぎ、API/CLI、移行、実機受け入れは未接続であり、運用環境は変更していない。

## 2026-10-01: lifecycle共通遷移とCAS job journalを追加

- 停止/削除の配信閉鎖と冪等feed generation更新を共通moduleへ分離した。Episodeは凍結requestの期待generationと最終jobを照合してCASで1度だけ進め、Showもowner/tokenを保持したまま状態を変える。
- v2 status/progressの共通journalはowner/要求hash/対象/generationを検証し、初回はIf-None-Match、更新はETag CASで保存する。finished progressとterminal statusの改変・退行を拒否する。terminal statusにはdurable finished/purge証拠と対象の結果状態が必要。
- 既存の公開停止runnerもこの共通処理へ移行した。旧v1記録や破損記録を暗黙に上書きせず、CAS競合・応答喪失・stale tokenを確認した。
- `bun test`（149件、1395 assertions）、`npm run check`、M6実証tsconfigに合格。本番ルートと運用環境は未変更。

## 2026-10-01: 保持policyに従うpayload削除batchと最終再列挙を追加

- `stepLifecyclePayloadDeletion`にdelete owner/実行token、対象deleting、期待generation/最終job、durable progressの対象・action・要求hash・purge成功、呼出側の配信ゲート確認を必須とした。最大100 keyの許可payloadだけをbinding array DELETEで処理し、progressをETag CASで保存する。本番経路からはまだ呼ばない。
- publication markerをstrict schema/対象/ETag/sizeで確認して保持し、予約・制御record・tombstone・request/job記録・service設定・別Show/似たEpisode IDを消さない。markerの本文をprogressへコピーせず、媒体bodyも読み込まない。未知key・不正/個人情報を追加したmarker・payload変更・gate未成立では削除を拒否する。
- 削除pageのcursorをそのまま維持し、全scope走査後は各prefixの先頭からverification passを行う。取りこぼしたpayloadがあれば削除へ戻し、一覧から空を確認した後だけfinalizingへ進む。件数は応答喪失で過少になる可能性がある診断値で、終了条件は一覧の再確認である。
- DELETEの部分成功/応答喪失、progress応答喪失/CAS競合、token喪失、markerだけの複数page、先頭prefixの残存payload、上限/破損progressを自動テストで確認した。failureでもowner/tokenを解放せず、同じ終了確認済み実行のremote progressから収束する。
- このmoduleは最後のpurge、deleted tombstone、terminal status、owner解放を行わない。開始時state/feed/purgeと本番gate callback、Queue継続・invocation引継ぎ、API/CLI、実機受け入れは残件。mockでのgate確認を本番cache配信停止の実証と扱わない。
- `bun test`（142件、1369 assertions）、`npm run check`、M6実証tsconfig、`git diff --check`に合格。運用リソース・Releaseは変更していない。
- Linux x86-64 binaryのbuild、既存version/help、文書リンク/コードフェンス/空白/英語AGENTS.mdも確認した。公開CLIはv0.1.2のままでlifecycle操作を表示しない。

## 2026-10-01: 削除後の最小記録保持policyを承認

- 管理者が説明へのannotationで、小さい必要な管理/操作記録は自動期限削除せず保持し、本文/個人情報/secretを複製せず、音源等のpayloadを物理削除するM6方針を承認した。期限付きの記録整理は後続とする。
- レビュー待ち一覧・M6設計・英語Agent Guideへ承認を反映した。tombstone/凍結request/commit/status/progressの保持とpayload削除を分離し、未完了/回復中jobを時間だけで消さない。
- この承認は運用bucketの削除実行やM6公開ゲートの通過ではない。実装・自動テストを順次進め、運用リソースは変更しない。

## 2026-10-01: 保持するM6診断をallowlist化

- M6 v2 statusのreasonをphase別の定型文・`reason_code`へ限定し、不一致pairや自由な例外messageをstrict schemaで拒否する。公開停止runnerはretrying記録へ例外本文をコピーせず、phaseと安全な定型診断を保存する。
- gatewayの永続ログも任意の例外messageを出力せず、対象IDと固定codeで障害を記録する。例外へタイトル/説明文/メール/secretを注入したテストで、R2 job記録とgatewayログに含まれないことを確認する。
- 旧v1 status parserは互換性のため維持する。既存R2記録を一括書換/削除したわけではなく、旧publication経路のv2統合は引き続き残件である。
- `bun test`（131件、956 assertions）、`npm run check`、M6実証tsconfig、`git diff --check`に合格。運用リソースは変更していない。

## 2026-10-01: レビューannotationを反映

- 管理者が公開時の利用条件を承認した。停止404/削除410/空feed 200、外部cache再検証、削除ID再利用禁止、進行中jobへ割り込まない仕様と、状態照会/内部cache構成に伴う性能・料金増の許容を承認済みとして設計・レビュー待ち一覧へ反映した。具体的な測定値や実機合格は承認に含めず、技術検証を継続する。
- tombstoneを「削除済みIDの小さい管理記録」と説明し、payloadのバックアップではないこと、ID再利用防止/410/旧job拒否の役割と、操作履歴の保持期間とは別の判断であることを明記した。
- M6では小さい必要記録を自動期限削除せず保持し、本文/個人情報/secretを複製しないという簡潔な保持方針をレビュー用の未承認提案として整理した。既存recordの書換・削除・保持期限の適用はしていない。
- 今回は文書のみを更新し、runtime・Cloudflareリソース・Releaseは変更していない。

## 2026-10-01: 公開gateway処理とレビュー待ち一覧を追加

- `serveLifecyclePublicRequest`を追加し、許可pathについて毎要求のstate読取、検証済みgeneration props、停止404/削除410/障害503、HEAD bodyなし、内部TTLと外部再検証headerの分離を実装した。Range/条件付きheaderは公開可否の確認後だけ内部transportへ渡す。
- warm cache相当のmock、別host/query、全revision、GET/HEAD/206/304、状態破損/R2障害/内部transport障害の自動テストを追加した。停止時はcached transportを呼ばず、障害時にもfallbackしない。内部HTTP/CDN cache用headerは外部応答から除去する。
- gatewayはまだ本番default入口へ接続しておらず、deploy metadataによるcache無効化や内部entrypointの実装をこの関数だけで保証しない。専用実機の既存実証と今回のmock結果を区別する。
- 確認が必要な監査記録policy/公開利用条件と、判断待ちではないupload統合・実行回復・配信/移行・restore/delete・CLI/実機の残件を[レビュー待ち一覧](./m6_review_queue.md)へまとめた。運用への配備、物理削除、サポート問い合わせ、Releaseは行っていない。
- 最終回帰は`bun test`（128件、911 assertions）、`npm run check`、M6実証tsconfig、Linux x86-64 buildと既存`--version`/`--help`、文書リンク/コードフェンス/空白/英語AGENTS.md、`git diff --check`に合格。既存CLIはv0.1.2のままでlifecycleコマンドをまだ表示しない。今回の新moduleの検証はローカル自動テストであり、Cloudflare実機の新しい合格記録は追加していない。

## 2026-10-01: Show/Episode公開停止の状態機械を追加

- `runLifecycleUnpublish`は既に取得済みの実行tokenを照合し、状態停止→親がactiveならfeed入力更新→feed generation→purge→durable完了→owner解放を実行する。Show停止では子状態と保存済みcontentを変更せず、停止中の親の子操作ではfeedを書かない。
- Episodeは期待generation/最終jobの照合とETag CASで停止する。同jobの状態書込再送を冪等にし、feed generationも`last_feed_job_id`で二重加算を防ぐ。purge phaseまで完了したfeedはpurge retryで書き直さない。
- feed/purge失敗で停止を戻さず、retrying statusとowner/tokenを保持する。状態、feed generation、完了progress/status、解放の各応答喪失から収束する自動テストを追加した。完了後の同token再送で副作用を繰り返さない。
- feed書込とcache所有entrypointのpurgeは必ずawaitする注入effectであり、現在のテストはその契約をmockで確認している。本番feed/内部Cache/Queue/API/CLIへの接続・実機確認は未完了。failed invocationから次のinvocationへ安全に引き継ぐ実行終了確認も未実装で、tokenの時間切れ解放はない。
- `npm run check`、M6実証tsconfig、`bun test`（121件、818 assertions）、`git diff --check`に合格。公開停止コマンドはまだ提供せず、運用サービスは変更していない。

## 2026-10-01: lifecycleを反映したfeed入力の読取を追加

- 実行tokenを照合してcurrent metadataとEpisode lifecycleをページ列挙し、activeだけをfeed入力へ採用する共通処理を追加した。Episode停止/削除の対象はstate書込前でも除外し、明示的restoreの対象自身だけを復帰候補とする。Show再開でも他の停止/削除/draft Episodeは戻さない。
- Show停止中の子操作およびShow全体の停止/削除はfeedを書かない。初回Show公開・空feed・metadata-only Episode revisionの旧音源再利用も扱う。候補revisionはpublication ownerと照合する。
- 既知Episodeのstate欠落、active/restore対象metadataの欠落、媒体の欠落/size変化、不正音源path、inventory変化、実行token喪失、件数/metadata予算超過はfail closed。媒体はHEADだけで存在・sizeを確認し、300MB bodyを読み込まない。これは内容checksum再検証ではない。
- `npm run check`、`bun test`（113件、750 assertions）に合格。本番publication/feed書込はまだこの入力処理へ接続しておらず、運用bucketは変更していない。

## 2026-10-01: 読み取り専用の削除対象ページを追加

- Episodeの3 prefix、Showの4 prefix＋Show snapshot単一keyを固定した削除inventoryを追加した。payloadとpublication commit markerを区別し、未知keyをblockerとして返す。対象ID・revision/job UUID・一覧metadata・cursorの進行を検証する。
- list/headだけを使い、300MB媒体のbody読取・削除・状態変更は行わない。Show予約・制御record・Episode tombstone・lifecycle marker・job監査は対象外。末尾`/`を維持し、似たShow/Episode IDの混入を拒否する。
- inventoryは`authorizesDeletion=false`を返す。1ページ完了は削除完了でも受付取得でもない。実削除にはowner/実行token・配信停止・purge・耐久progress・先頭からの最終再列挙が必要で、削除consumerはまだ未接続。
- 残すpublication markerの内容・保持期間の最終確認は未完了であり、今回は保存・削除のpolicyを新たに確定していない。
- `npm run check`、`bun test`（105件、708 assertions）、`git diff --check`に合格。Cloudflareリソースは変更していない。

## 2026-10-01: version別status・耐久progress・完了解放を追加

- 旧v1 publication statusを保持し、strictなv2 statusとv1 progressを追加した。action・phase・owner generation・要求hash・対象・結果状態を検証し、`published`とlifecycleの`completed`を分離する。既存publicationの書込はv1型へ限定し、挙動を変更していない。
- 実行tokenを保持した`finishShowOperation`は、耐久terminal status/progress、purge成功、owner/request/generation、対象の結果状態を照合して同じShow keyのCASで解放する。完了receiptを同時保存し、解放応答喪失の再送でも次のownerを変更しない。
- 欠落/破損/旧status、retrying、hash不一致、未完phase、purge未確認、対象状態の不一致ではowner/tokenを保持する。generationの上限でShow/feed/Episodeを受付拒否する。
- `npm run check`、M6実証tsconfig、`bun test`（100件、642 assertions）に合格。status/progressを書き進めるconsumer、upload終了処理、API/CLIへの接続は後続。実機・運用リソースは変更していない。

## 2026-10-01: 同job内のconsumer実行排他を追加

- Show ownerへprocessing専用の`execution_id`を追加し、取得・照合・解放をShow制御keyのETag CASで実装した。reserved→processingとtoken取得を一度に行い、同jobの重複配送16件でも1 invocationだけを実行可能にする。
- 終了したinvocationはtokenだけを解放し、Showのprocessing ownerを保持する。誤ったjob/generation/token、前invocationからの遅延解放、凍結requestの改変、uploadingでの実行を拒否する。
- 取得応答喪失はtokenを保持してfail closedとし、解放応答喪失は再照会で冪等に回復する。時間切れでtokenを奪う仕組みは追加していない。すべての副作用が終了した後だけ解放することが呼出側の契約である。
- 本番consumerは未接続。runtime強制終了時の安全なtoken回復は未実装であり、M6の残ゲートとして保持する。これはREST単一PUTの未解決懸念U1とは別の問題である。
- 自動テストは91件・561 assertionsに合格。Cloudflareリソース・運用サービスは変更していない。

**現在のupload方針（2026-10-01）**: 管理者判断により現行REST単一PUTを維持し、クライアント切断後に遅れてobjectが作成・更新されないと仮定する。確認済み仕様ではなく[未解決懸念U1](./m6_upload_recovery_options.md)として保持し、M6公開をブロックしない。以下の過去ログにある条件付きPUT/分割uploadの公開ゲート判断は、末尾の決定で更新された。既存実測はそのまま保持する。

## 2026-09-30: 次マイルストーンの設定と設計案

管理者の依頼により、Episode/Showの公開停止・削除を次のマイルストーンM6とした。[設計案](./m6_content_lifecycle_plan.md)を作成し、全体設計・README・Agent Guideと独自ドメイン計画に開発順を反映した。

### 設計案作成時の状態

- 基準版は公開済みv0.1.2。公開停止・削除・再開は未実装。
- 今回は文書更新だけで、CLI/Worker/schemaは変更していない。Cloudflareリソース・公開コンテンツも変更していない。
- 物理削除と公開停止の分離、明示的restore、HTTP status、IDの再利用禁止、保持記録、client cache変更、進行中jobへ割り込まない方針は設計案であり、詳細承認はこれから行う。
- 独自ドメインの承認済み方針・基礎コードは保持するが、完成・CLI公開はM6の後続に回す。

### 調査で確認した設計ゲート

1. Workers CacheはWorker実行前にHITを返す。停止判定を必ず実行するgatewayとcached inner entrypointを同じWorkerに設ける案。REST deploy、内部purgeのscope、Rangeと料金は専用環境での実証が必要。
2. Showの状態と受付を同じR2 keyのCASで管理し、publicationだけでなくREST staging uploadとの競合も防ぐ必要がある。別keyの停止markerを読むだけでは不十分。
3. 削除は複数objectにまたがるため、状態機械・耐久progress・分割consumer・最終再列挙を要する。停止/削除開始後の失敗で自動再公開しない。
4. 旧CLIによる直接uploadや旧Workerへのdowngradeは公開ゲートを迂回し得る。移行時の停止・更新・収束と保証範囲を明記する必要がある。

### 次の作業

設計レビュー・承認後、M6.0のcache/API・排他・回復の技術実証を行う。コマンドを先行公開せず、各実測と判断をこのログへ追記する。

## 2026-09-30: 入力TOMLフラグとR2制御recordの比較を追加

レビューで、公開状態を入力metadataから分離する方針への賛同と、`publish = false`などのフラグ方式とのメリット・デメリット整理を依頼された。設計案の第5節に比較を追記した。

- 保存形式ではなく、希望状態と実状態、metadataと制御情報の責務の違いとして整理した。
- TOMLフラグ方式の編集・Gitレビュー・一括管理の利点と、適用契機・古い下書き・物理削除後の記録への対策を明記した。
- R2制御record方式の明示操作・排他・途中状態・tombstoneの利点と、状態照会・schema・復旧・readコストの増加を明記した。どちらの方式でも配信ゲートとcache対策は必要とした。
- 将来の宣言的applyとの併用は別途検討とし、M6の実装範囲は増やしていない。この賛同はM6の削除仕様・その他の承認事項全体の承認とは扱わない。

## 2026-09-30: R2制御record方式の決定と基礎実装の開始

管理者が比較を確認し、もとのR2制御record方式を決定、資料更新と実装開始を指示した。公開状態を入力metadataから分離する方式を決定事項として反映した。cache/API・移行・回復の実機ゲートを通過したとは扱わない。

### 実装した基礎

- `packages/shared/src/lifecycle.ts`: strictなShow制御record、Episode状態、凍結requestと状態ごとの操作許可。入力metadata schemaは変更せず、公開フラグは追加していない。
- `src/lifecycle-control.ts`: R2 bindingからのサイズ制限付きread、keyとrecordのID一致確認、requestの不変保存、Show keyのETag CASでの原子的受付、owner/request/generationを照合したprocessing開始。stagingにはuploading ownerを割り当て、consumer処理へ移さない。
- R2を毎要求で読む公開可否判定。Showの親ゲートを先に確認し、Episodeの個別状態は書き換えない。未知の対象は非公開、既知の対象のrecord欠落・破損・読取失敗は例外としてfail closedする。
- 同一requestの再送とCAS応答喪失を回復できるようにし、別要求・古いgeneration・既存job IDによるclaimを拒否する。legacy admissionを自動上書きせず、processingの強制解放も実装していない。

### 確認結果・未接続の範囲

- `npm run check`と`bun test`に合格（56件）。新規24件でschema、同時claim、再送/各段階の応答喪失、staging排他、request不一致、停止対象の暗黙再公開拒否、親子の公開判定、R2読取失敗を確認した。
- Linux x86-64バイナリのビルドと`git diff --check`にも合格。新schemaの追加で既存CLI/Worker bundleのビルドを壊していないことを確認した。
- 新しいモジュールは既存CLI/管理API/Queue consumer/公開入口には未接続。公開可否判定関数のテストはwarm Workers Cacheを遮断できたという実測ではない。
- 公開停止・削除・再開のコマンド、job status v2、停止/削除consumer、終了時の受付解放、移行はまだない。v0.1.2 Releaseの内容とCloudflareリソースは変更していない。
- processing開始の同job再実行は許すが、この関数だけで同jobの複数consumer invocationを排他できるとは扱わない。既存concurrency 1と旧invocationが書けないことを確認した回復経路を維持し、受付解放・次操作との安全性は後続consumer実装で検証する。

### 次の作業

1. M6.0の同一Worker内uncached gateway/cached entrypoint、REST deploy、purge scope、Rangeの技術実証。
2. 既存Showの明示的移行とcapability、publication/stagingの受付・終了処理を新recordへ接続する設計・実装。
3. 配信ゲートと回復の条件を揃えた後、Episode/Showのlifecycle consumer・CLIへ進む。

## 2026-09-30: M6.0 キャッシュ構成の実機実証

管理者の指示で、運用サービスとは別のWorker/private R2をREST APIから作成し、同じWorker内のuncached gateway＋cached named entrypointを実証した。認証情報は環境変数のみ、Wrangler・Node.js CLI・R2 S3 credentials・独自ドメインは使っていない。開発時の実行/bundleはBun。Queue/DNS/既存サービス/Releaseは変更していない。

### 専用実装と証拠

- [`experiments/m6/cache-worker.ts`](../experiments/m6/cache-worker.ts): `readPublicVisibility`で実際のR2制御recordを確認し、`CachedMedia`をloopback fetchで呼ぶ試験Worker。gateway/inner別UUID、generation props、内側purge RPC、遅延response fixtureを持つ。入力metadataや公開consumerは試験対象にしていない。
- [`experiments/m6/verify-cache.ts`](../experiments/m6/verify-cache.ts): 毎回新規resourceを作成し、試験・証拠保存・cleanupを実行。型は[専用tsconfig](../experiments/m6/tsconfig.json)で既存platform typesに対して確認する。
- 最終実行は`castloop-m6-cache-7b5a047d`、compatibility date `2026-09-30`、usage model `standard`、完了時刻 `2026-09-30T14:15:32.022Z`。10チェック合格。公開/隔離path等の50応答はNRTで観測した。
- [保存したJSON結果](../experiments/m6/cache-results-20260930.json)にuploadのexports、settings、個々のHTTP status/bytes/ID/cache状態/colo/経過時間、cleanup結果を保持する。raw記録は`/tmp/opencode/castloop-m6-cache-7b5a047d/`。secret入りmanifestはGitに入れない。

### 実測結果

| 項目 | 結果 |
| --- | --- |
| REST module deploy | `cache_options.enabled=true`、`cross_version_cache=false`、`exports.default.cache.enabled=false`、`exports.CachedMedia.cache.enabled=true`を受理。upload応答にもentrypoint別設定が返る |
| gatewayの毎要求実行 | feed MISS→HITでinner UUIDは固定、gateway UUIDは毎回異なる。外側はno-store、内側は300秒cache |
| GET/HEAD/Range | cold Rangeは206/MISS、後続は206/HIT。`bytes=0-9`、`250-259`、suffix、416のContent-Range/bytesが一致。cold/warm HEADはbodyなし/正しいlength、cold HEAD後のGETも全量一致 |
| warm cacheでの停止 | Episodeの404/410、Showのfeed/cover/MP3 404/410。GET/HEAD/Range、query/If-None-Matchの停止回避なし。停止試験ではpurgeしない |
| purge scope | gatewayからのtag purgeはsuccessでもinnerの旧bodyが残る。inner RPCからのtag purge後は新body/新inner UUID。tagなし音源のpath-prefix purgeも有効、cover cacheは変わらない |
| fail closed | warm cacheのままShow recordを壊すと503。cached bodyを返さない |
| 遅延旧response | 判定・開始済みresponseは停止後に200完了し得る（保証対象外）。その後の要求は404のまま。再開generation 2では別inner UUIDでMISS→HITとなり旧cacheを再利用しない |
| 非公開path | system/staging、内部class名の外部pathは404。未認証fixture管理は401 |

65,536 bytesの人工payloadで配信/cachingを検証した。拡張子とContent-Typeだけfeed/cover/MP3に合わせたfixtureで、RSS構文・画像decode・MP3解析/再生は確認していない。停止fixtureはID再利用やdeleted→activeも許す検証専用操作であり、本番lifecycle APIには流用しない。prototypeのShow再readも本番の状態/generation snapshot API設計を代替しない。

### 後片付け

初回`castloop-m6-cache-a21e0c3b`も主要8チェック合格したが、Worker DELETEが500/code10013を返した。再試行でWorker/bucketを削除済み。runnerに有限retryと不在確認を追加し、最終実行はテストpayload・Worker・bucketを自動削除、不在確認まで成功した。作成した2組の検証resourceは残していない。

### 料金・保証範囲・残るゲート

- 公式[Workers Cache料金](https://developers.cloudflare.com/workers/cache/#pricing)と[Workers料金](https://developers.cloudflare.com/workers/platform/pricing/)を確認。cached loopbackもrequest課金対象なので、active配信はgateway＋innerの2 request相当を基本に試算する。inner HITでもgateway CPUとR2状態readは必要。castloop本番の実請求やCPUを測ったわけではない。
- 今回はStandardであり、Freeの100,000 request/日・10ms CPU制限内で動作することは未実証。[purge rate limit](https://developers.cloudflare.com/workers/cache/purge/#rate-limits)はWorkers Cacheではプランに関係なくFree-tier。rate-limit時のconsumer retryを後続実装に含める。
- 同一NRTの少量試験。複数colo・hostname・負荷・300MB音源・旧default cacheからの本番移行は未検証。tagなしinner cacheのprefix purge確認は旧default entrypointの移行/purge合格ではない。
- 外向けheaderは試験ではno-store。設計の`max-age=0, must-revalidate`、activeのconditional 304、Episode generationやfeed generationの本番cache keyは接続時に回帰確認する。
- **cache/REST/Range構成ゲートは実証済み、M6.0全体とM6公開ゲートは未完了。** 次はR2 CASの実機競合、staging uploadの中断/収束と安全な解放、限定reserved abandon、既存サービス移行/capabilityを進める。CLI/consumer/公開入口へ新構成を接続してから、本番相当の回帰試験を行う。

### ローカル回帰

`npm run check`、専用tsconfigの型チェック、`bun test`（56件）、文書リンク/コードフェンス/空白確認、`git diff --check`に合格。Cloudflare REST GETでも今回作成した2組のWorker/bucketが404であることを再確認した。

## 2026-09-30: CAS競合・限定reserved abandon・REST条件付きuploadの実測

キャッシュ実証を`16b900f`でcommit/pushした後、管理者の継続開発指示に従って次の安全性ゲートを進めた。

### 実装

- Show v2 schemaへstrictな`last_abandoned_operation` receiptを追加。取消対象job・受付後generation・request hashを保存し、現ownerや現generationと同一のreceiptは拒否する。
- `abandonReservedShowOperation`: frozen request・owner・generationを確認し、**reservedに限り**同じShow keyのCASでowner除去/generation更新/receipt保存。processingとuploading、legacy/missing/mismatched recordは解放しない。CAS後の応答喪失はreceiptで回復できる。
- 取消前にprocessingへ進んだconsumerと競合した場合はabandonが失敗する。逆に取消CASが勝った場合、古いbegin CASは失敗する。各jobの凍結requestも保持し、同じjob IDを新しいgenerationへ書き換えて再claimできない。
- これは新v2経路の未接続基礎関数。既存v1 admissionや旧consumerには適用せず、HTTP管理からのprocessing解放やCLIのabandonコマンドは追加していない。

### 実機結果

最終環境`castloop-m6-admission-89e9794f-07f`、Standard、完了`2026-09-30T14:43:23.015Z`。[専用runner](../experiments/m6/verify-admission.ts)の5チェック合格。[JSON証拠](../experiments/m6/admission-results-20260930.json)を保存する。

1. publish/stage/unpublish/deleteの16同時claimは1件だけ成功、15件拒否。
2. 同一requestの6同時claimは冪等、generationは1だけ進む。processingはabandon不可。
3. abandon成功後の503を注入し、同じ要求の再実行で取消を確認。旧begin、旧claim、同jobのgeneration書換claimは拒否。別jobの次受付は成功。
4. beginとabandonの実R2競合を8回実行し、各回で1つだけ成功。
5. uploading ownerはdeleteを拒否し、abandonでも解放されない。

### uploadゲートの不成立

R2 REST object PUTへ既存ETagと一致しない`If-Match`を付けたが、**HTTP 200で既存bodyが上書きされた**。`barrier`（7 bytes）→`wrong`（5 bytes）、ETagも変わった。bindingのonlyIf/CASが成立しても、CLIが使うREST object PUTのfenceにはできない。試験fixtureだけの上書きで、運用コンテンツには触れていない。

この結果を受け、条件付きREST PUTのsafe cancellationは不採用。uploadingを時間切れ/HEAD不在だけで解放しない。未解決のままdeleteを先行公開しない。現行直PUTの明確な収束証拠、またはサーバー管理の分割upload sessionなど、別の安全なプロトコルを検討する必要がある。管理端末の追加依存・別productを無断で増やさない。

### 試験環境と回帰

- 初回配備直後に一部要求が500/HTMLの`Script not found`となるケースを観測。runnerは非JSON応答もstatus/titleで記録し、同一要求の有限retry、全同時要求のsettle後cleanupを追加した。これはCASの二重成功とは別のfront-end反映問題。
- 最終実行はpayload/Worker/bucketのcleanupと不在確認に成功。途中失敗の3組も専用resourceだけを清掃済み。Queue・DNS・既存サービス・Releaseは変更していない。
- `npm run check`、専用tsconfig、`bun test`に合格（62件、428 assertions）。単体テストでも応答喪失、取消/開始競合、staging拒否、receipt更新後の旧job拒否を追加した。
- 次は破壊的操作と独立した、既存サービス移行の読み取り専用inventory/planを実装する。upload収束ゲートと本番consumer/CLI接続は引き続き未完了。

## 2026-10-01: 読み取り専用の既存サービス移行plan

CAS実証と限定abandonを`0523af1`でcommit/pushした後、upload protocolの未解決事項と独立した移行準備を進めた。

- `src/lifecycle-migration.ts`に`planLifecycleMigration`を追加。受け取れるbucket操作はlist/getだけで、R2の更新/削除・owner解放・legacy record変換は実行しない。CLI/管理APIにもまだ接続しない。
- 予約・公開snapshot・current Episode・revision history・draft keyをページ終端まで列挙し、source ETag/sizeと初期状態案を返す。既存公開をactive、未公開の予約/draftをdraftへ分類し、metadata-only改訂で古い音源revisionを再利用するpathも検証する。
- legacy reserved/processing、未完了commit、失われたfree-ownerのpublished status、予約/metadata/controlのID不一致、feed/cover/media/history欠落、破損record、orphan media、未完了deletion、deleted stateの残存payloadをblockerにする。すでにv2のrecordは状態/generationをそのまま保持し、部分初期化やlifecycle stagingは自動補完せず要調査とする。
- メタデータread時にlistのETag/sizeとの一致を確認し、変化・R2障害・不正なpaginationはplan生成自体を中止する。読取recordは1MB、inventoryは既定10,000 objectsの上限を設け、超過はbatch設計を要求する。上限を理由に一部だけを合格扱いしない。
- `inventory_compatible=true`でも、旧CLI停止・継続HTTP PUTの収束・atomic migration受付・移行完了を意味しない。常に`requires_quiescence=true`を返す。一覧全体のtransaction snapshotやpayload SHA-256実測ではない。適用時の再照合・耐久progress・旧cache purge・capability切替は未実装。
- Cloudflareの運用サービスでは実行していない。単体テストで不変性、1,000件超/短いページ、既存停止状態の保持、部分初期化拒否、source変化/障害、上限/不正cursorを確認する。
- `npm run check`、専用実証tsconfig、`bun test`（77件、485 assertions）、`git diff --check`に合格。

## 2026-10-01: 公開snapshot・path/cache identityの共通処理

読み取り専用migration planを`76447f2`でcommit/pushし、未接続の公開ゲート基礎を続けた。

- `readPublicVisibilitySnapshot`は公開可否とShow/feed/Episode generation、対象IDを同じ状態readから返す。Show assetはShow 1 read、音源はShow/Episode 2 reads。公開判定後に別のShow readでcache generationを拾い直す必要をなくした。従来の`readPublicVisibility`はsnapshotのvisibilityだけを返す互換wrapperとして維持する。
- 親子の2 keyをtransaction snapshotで読むわけではない。停止前に開始済み要求の転送保証も変えていない。非公開snapshotからはpublic cache tokenを返さず、空Episode IDをShow lookup扱いしない。
- `src/public-assets.ts`: v0.1.2と同じ公開path/ID/UUID/媒体keyを解析するpure helperを追加。Show/Episode対象が一致するpublic snapshotだけからcache propsを作り、feed/cover tagを維持しつつshow/episode階層tagを追加。Episodeタグはslug結合が曖昧にならない区切りにする。
- migration planのenclosure path検証も同じparserを使用。既存`src/index.ts`やconsumer/CLIへはまだ接続せず、v0.1.2の公開応答/headerは変更していない。cache実証fixtureや既存JSON証拠を新snapshotの本番回帰結果と扱わない。
- 新たな8テストでread回数、snapshot世代/対象照合、非公開/不正generationのcache key拒否、private/encoded/不正ID path拒否、tag衝突防止を確認。`npm run check`、専用実証tsconfig、`bun test`（85件、532 assertions）に合格。
- [upload方式の選択肢](./m6_upload_recovery_options.md)を追加。既存REST直PUTを条件付きwriteで取消できないことが現在の主要ゲート。同じWorkerを介する分割sessionを推奨候補として整理したが、方式変更は未承認・未実装。CLI/公開入口の接続とdelete公開は引き続き保留する。
- Linux x86-64 build、既存version/init help、文書リンク/コードフェンス/空白、英語AGENTS.md、`git diff --check`にも合格。今回のCAS試験で作成した4組のWorker/bucketすべてがREST GETで404であることを最終確認した。

## 2026-10-01: 単一PUTの維持と未解決懸念U1の扱いを決定

管理者のレビューで、abort済みのREST単一PUTが保存を続けるという説明の根拠を再調査した。公開資料・公開事例・binding側の公開実装から、対象REST経路でクライアント切断後にmetadata commitが完了することや、その取消保証を確認できなかった。R2のデータ保存→metadata commit→object可視化→200送信という説明、PUT/DELETEのlast-writer規則、Workers/S3のIncompleteBody/ClientDisconnectは、その挙動の証明ではない。部分ファイルをDELETEする前提ではなく、未確認の遅延確定リスクとして説明すべきだった。

管理者はCloudflareサポートへの問い合わせを行わないと指示し、続けて以下のM6方針を決定した。

- **現行Cloudflare REST APIの単一object PUTを維持**する。Worker経由の分割upload sessionやS3 credentialsは導入しない。
- **クライアント切断後にそのPUTが遅れてobjectを作成・更新することはない**と仮定する。これはCloudflareの確認済み仕様でも新たな実機合格でもない。
- 仮定が誤っているなら削除完了後にstaging payloadが残る可能性があるという点を、[未解決懸念U1](./m6_upload_recovery_options.md)として記録する。この懸念の解消・困難なローカル再現・分割uploadへの変更をM6公開条件にはしない。反例や明確な公開仕様が得られた場合は再検討する。
- REST PUTが不一致`If-Match`でも上書きしたという既存実測は変更しない。条件付きREST PUT fenceは使わず、この試験を切断後の保存継続の証拠とも扱わない。
- 同じShowの原子的受付、通常PUTの完了/size/内容照合、明示的publish、300,000,000 bytes上限、移行時の旧CLI停止は維持する。単なる経過時間やHEAD不在を理由に、まだ継続中のPUT/Worker/consumerを解放する方針ではない。切断後のowner/generationを照合した回復・解放は上記仮定の下で後続実装へ接続する。
- 変更は設計・実装ログ・README・Agent Guide・試験の解釈に限定する。CLI/Worker/テストコード、保存済み実測JSON、Cloudflareリソース、Releaseは変更していない。M6全体の公開ゲートを通過したとは扱わない。
- `npm run check`、`bun test`（85件、532 assertions）、文書リンク/コードフェンス/空白・英語AGENTS.md確認、`git diff --check`に合格。これらは文書更新の回帰確認であり、U1の仮定を実証したものではない。
