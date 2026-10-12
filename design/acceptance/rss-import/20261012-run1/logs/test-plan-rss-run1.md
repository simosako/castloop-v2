# M7 RSS移行 受け入れ試験 run1 計画

作成日: 2026-10-12。対象: Issue #1 https://github.com/simosako/castloop-v2/issues/1

## 目的・安全境界

公開元のPodcastを、新規castloopサービスの新しい独自ドメインへ複製できるか検証する。旧配信は維持する。

- 元ホストへの変更、Episode削除、301 redirect、itunes:new-feed-url追加、Podcast directoryの登録変更、購読者切替、解約は行わない。
- 過去のrun1〜4のCloudflare資源・workspace・未完了tokenは操作しない。ブランチの削除記録ではrun2/run4等が既に廃棄されているため、以前の配信を試験元として再利用しない。
- 新規資源だけに初期化・domain add・公開を行う。旧環境のCLI/Worker更新も不要。
- 完了判定はコンテンツの移行可能性。`subscriber_migration_completed: false`を正常な結果とする。購読者移行や旧環境廃止の完了とは扱わない。
- Cloudflareの変更は本計画の実施段階で行う。準備段階ではまだ行っていない。試験後の新規domain/資源削除も自動実行せず、別途判断する。

## 固定対象・準備済み項目

| 項目 | 値 |
| --- | --- |
| ブランチ | feat/m7-rss-import |
| commit | 5413fba350f3ae340c94d63030eb37e41b5ca116 |
| ローカルsource | build/castloop-v2-rss-run1/（detached clean worktree） |
| CLI | bin/castloop-linux-x64-5413fba |
| CLI SHA-256 | 098565a1c5f0003920042d8b75bb642b3a80fa1bb725a9d0b01cdd8db912b073 |
| 実装案内 | docs/rss_migration.md、design/m7_rss_import_plan.md（対象commit内） |
| 移行元候補 | https://anchor.fm/s/f95e6290/podcast/rss （materialsの取得元） |
| 新Show ID | otftalk-rss |
| 新service ID予定 | rsstest-1012-r1 |
| 新bucket予定 | castloop-rss-20261012-run1 |
| 新hostname予定 | castloop-rss-r1.otftalk.com |
| 新workspace予定 | workspaces/rss-20261012-run1/ |
| 取り込み先予定 | imports/rss-20261012-run1/（以後移動しない） |
| エビデンス | evidence/rss-import-20261012-run1/ |
| 活動記録 | test-20261012.log |

名前は未使用確認前の予定値。Worker・Queue・DLQの実名はinit結果を保存して照合する。既存名との衝突があれば停止し、既存資源を採用しない。

準備結果:

- fetchして新worktreeへ固定取得。既存worktreeのbranch切替やpullによる上書きなし。
- Cloudflare認証環境変数を外し、npm ci（脆弱性0）、npm run check、bun test（960 pass / 0 fail、108 files）、Linux CLI buildに成功。
- 配置CLIとbuild元のSHA-256一致。両新コマンドのhelpを保存。
- CLIによる実URLのdry-run成功: 36件、declared_audio_bytes=1,496,055,589、audio_sizes_complete=true、missing_fields=[]、cloudflare_changed=false。
- file URL、loopback URL、独自portをバイナリで拒否することを確認。
- materials/otftalk/のカバー・Episode35/36はSHA256SUMSと一致。保存済みsource-feed.xmlも36件。ただしローカル音源は2件分のみ。過去のprepared/short.mp3は全件同一内容の移行試験に使用しない。

## 範囲・容量・比較基準

主試験は公開元RSSに載る全36件を想定する。実取り込みの取得時点で件数が変わった場合はスナップショットを保存して差を説明し、必要に応じて管理者へ確認する。

- 「全件」は取得したRSS内の全item。RSSから省かれた過去Episodeまで移行できたとは主張しない。実際の旧番組全件数は管理者の一覧とも照合する。
- 約1.50GBはRSSの宣言値であり、実取得sizeで確定する。ローカル容量、R2のpublished/staging一時容量、download/upload/全量読み戻し/公開GETの数GB規模の通信を見込む。空き容量不足や有料プラン変更が必要なら停止する。
- 36件の中から都合のよい2件だけを選んで「全移行成功」としない。小さいfixtureを使う場合は別Showで補助試験と明記する。
- 保存済みRSSと現在の公開RSSは別取得。dry-runだけでは後続downloadの厳密なスナップショットにならない。`import-rss --output`が保存するsource.xmlを主比較基準にする。
- GUID文字列・isPermaLink実効値・日時の同一時刻・title・description・対応任意項目・Show対応項目・MP3/カバーのbytesとSHA-256を照合する。XML整形やRFC 3339/RFC 2822の表記差は許容し、意味を比較する。
- 新RSSのself/カバー/全enclosureは新hostnameを指す。site_urlやGUIDが旧URLの場合は意味を保つため機械的に新domainへ置換しない。
- 元RSS全XMLの完全複製は保証範囲外。Episode画像、transcript、独自拡張、description内の外部画像等はコピーされない。warningsを列挙し、description内の旧ホスト依存も記録する。
- dry-runでduration、Episode image、summary、dc:creator、Atom link、item link等の非取り込み警告あり。durationは取得MP3の解析値になる。警告を無視して「完全に同一」とは報告しない。

## 実施手順

### 1. 事前確認（読み取りのみ）

空き容量と対象account/API token有効性を確認。otftalk.comのZone、予定hostnameのDNS/Custom Domain/Route競合、新service/bucket/Worker/Queueの未使用をAPI GETで確認し保存する。既存API tokenの権限設定は変更しない。Worker管理URLのsubdomainはsimosako。

元番組のRSS内件数と旧番組総件数を区別して記録する。実素材取得・公開に伴う容量/通信を上記想定内で実施する。

### 2. RSSのローカル取り込み

Cloudflare認証を外し、空の取り込み先へ実行:

```sh
bin/castloop-linux-x64-5413fba import-rss otftalk-rss https://anchor.fm/s/f95e6290/podcast/rss --output /absolute/path/to/imports/rss-20261012-run1
```

stdout/stderr/exit code、source.xmlとhash、import.json、私有control/素材記録を保持する。全音源・カバーの実size/hash/MP3 durationと全TOMLを検証。GUID→Episode IDがep-SHA256で安定し、全36件が対応することを確認する。

downloadの再実行は同じ出力先・同じRSSスナップショットに限定。正常完了後に同じコマンドを1回実行し、import ID/source hash/完成素材hash/編集済みTOMLが保持されることを確認する。再取得の有無を証拠なしに断定しない。

### 3. 公開前レビュー

source.xmlから独立した比較一覧を作る: GUID、isPermaLink（元属性省略ならtrue）、公開日時、説明、任意項目、素材URLと実hash。Show項目も比較する。

missing_fields/warnings、旧ホスト依存、カバー表示・MP3解析と必要な再生確認を記録する。必須項目不足を架空のemail/site URL等で補完しない。GUID・日時・permalink属性は編集しない。判断が必要な不足/非対応項目は管理者へ確認する。

入力一式のhashを固定し、公開開始後は別操作で編集/移動しない。Gitにsource素材・私有journalや認証情報を追加しない。

### 4. 新M7環境を初期化して独自ドメインを設定

新workspaceのみで固定CLIからinit。完了receipt、runtime readiness、paused、invocations/owner空を確認。CLIが埋め込んだM7 Workerを使い、`external_episode_guids: true`を認証付きservice-statusで確認する。

pausedのまま新hostnameへdomain add。DNSは事前手動登録せずCLIのCustom Domain作成に任せる。connection receipt、pending/token/url_change解消、公開URL=新hostname、管理URL=workers.dev、local_operations=[]を確認する。

DNS/TLSと対象Workerの到達を確認してから明示resume。service-statusでopenとM7 capabilityを再確認する。未完了owner/lock/tokenがあれば公開を開始しない。

### 5. 一括逐次公開

新workspaceで固定CLIの`publish-rss-import /absolute/import/path`を実行し、出力・stderr・exit code・進捗と既存runnerのjournalを保存する。

- 全TOML/素材の事前検証、未使用Show登録、Show公開、Episodeの古い日時順の逐次公開を確認する。
- 各公開jobでpublishedかつreleased、必要なcache purge完了を確認する。途中まで配信されることは仕様であり旧配信は切り替えない。
- CLI内部のjob待機は最大120秒。実行ツールの時間制限は設けないが、内部の待機上限を変更しない。
- 120秒超過/照会失敗では、そのjob ID、receipt、進捗phase、所有権を保存して確認する。waitingの既知jobだけは仕様に沿う同じimportの続行対象。command_requested/未知変更応答は再送せず停止する。
- 最終result=rss-import-published、正しいfeed_url/件数、subscriber_migration_completed=false、進捗completed、残留lock/ownerなしを確認する。

### 6. 独立した移行内容・配信の全件検証

CLIの内部検証に加え、別のXML解析でsource.xml・取り込みTOML・新RSSを全件照合する。GUID集合と件数が完全一致し、重複・欠落がないことを確認する。

新hostnameでfeed/カバー/全36 MP3を取得し、import素材とlength/SHA-256一致を確認する。RSS enclosure.lengthやdurationは実音源解析との整合も確認する。代表音源についてHEAD、Range 206/Content-Range、ETag/304を確認する。

R2 published current/revisionのGUID・日時・permalink属性を照合する。public以外のsystem/stagingパス非露出と管理API未認証拒否も確認する。

### 7. 続行・重複防止と互換性回帰（新環境だけ）

正常完了した同じimportの再実行で、完了確認だけになりShow/Episode/job/revisionの重複やGUID変更がないことをbefore/afterで確認する。

全件一致の証跡を先に固定した後、新環境の代表EpisodeとShowでunpublish→restoreを行い、404→200、復元後のGUID/日時/音源hashと全RSSが元に戻ることを確認する。deleteは実行しない。

通常UUID Episodeの新規公開、metadata-only/audio-only更新は別の小さい回帰Showで実施し、主移行Showの全36件比較を汚さない。GUID/日時/permalinkの変更拒否は既存自動テストの結果を主証拠とし、実機負例は新試験専用入力で変更前拒否を確認できる場合に限定する。

旧Worker拒否、未知変更要求の再送拒否、SSRF/redirect/XML/サイズ異常の網羅は自動テストを活用し、旧環境へ故障注入しない。実機で意図的なkill/ネットワーク切断は今回の必須試験にしない。

### 8. 終了・報告

旧RSSへ通常GETが成功することを確認する（旧配信を変えていないことは本試験の操作記録とも照合）。元RSSは運用中なので全XMLのhash不変を必須条件にしない。

新環境の全処理完了/ownerなしを確認し、公開状態での検証を保存してから新しいpause IDで停止する。paused/公開503/未完了tokenなしを確認し、新資源・domain・ローカル原本を保持する。終了状態を明記し、最終pause後に新RSSが503になることを障害と誤認しない。

項目別に合格/失敗/未実施/対象外を記録。「RSSに含まれる内容の移行」「対応外情報」「購読者移行未実施」を分けて結論を出す。Issue作成やGitHubへ証跡pushは別途依頼時に秘密除去して行う。

## DNS・停止条件

- このPCのDNS/ルーター設定変更や追加調査はしない。通常HTTP配信チェックは前回承認済みの1.1.1.1直接解決（curl --resolve等、TLS検証有効）で反映待ちを回避できる。
- M7のRSS取得/最終feed照合はnode:http/https + node:dns.lookupを使用し、検査済みIPへ接続を固定する。前回Bun fetch向けHTTPS_PROXY tunnelを適用できるとは仮定しない。1.1.1.1での独立配信確認とCLI内部検証は別物。
- 管理者が今後のDNS起因エラーについて、OSを変更せず1.1.1.1を指定する試験方法を都度確認なしで実施することを承認。domain操作のBun fetchには対象hostnameだけのCONNECT tunnelを使える。新hostnameをCLI内部のnode:dns.lookupが解決できない場合も、CLI改造/TLS無効化/SSRF検証迂回はしない。未完了記録を保持し、1.1.1.1の独立確認だけでCLI完了を宣言しない。
- 未知のinit/deploy/domain/登録/upload/publication結果、command_requested残留、lock/owner/token残留、件数/GUID/素材の不一致は停止する。時間経過やDNS/R2 object不在だけでownerを解除しない。
- 素材取得の同一snapshot再開と、公開waiting状態の既知job照会以外の変更要求を自動再送しない。
- API token/管理鍵/execution token/email/取得URL query等は公開証跡から除去する。私有原本は残す。

## 現在の進捗

ローカル準備・自動テスト・dry-run、および第1段階のAPI事前競合/容量確認は完了。

第2段階の初回import-rssはexit1: 出力先の親ディレクトリ`imports/`が未作成でENOENT。CLIは親のrealpathを確認してから出力先だけを作成するため、ローカル準備漏れで停止した。

その後、管理者がimports作成と再開を承認。第2〜3段階は完了: 全36 MP3（実合計1,496,055,589 bytes）/カバー取得とXML/TOML/receipt独立照合成功。同一importの再実行で116ファイルのhash/size/mtimeが維持された。カバー表示と代表MP3 decode確認成功。不足必須項目なし、計画既知の非対応警告のみ。旧環境の変更なし。

第4段階のinitは成功。新Worker `castloop-rsstest-1012-r1-acb1fbca`はM7 capability有効、pausedで初期化完了。

domain addはDNS/TLS未検証でexit1となり、最新指示に従って停止。operation `e1a5c445-31d6-4b6d-963a-bf90dbc3765f`、phase=feeds、connection receiptあり、pending/lockなし、completed=false。Custom Domain接続は存在するが正規URLはまだworkers.dev。paused・invocations空・url_changeを保持し、retry/resume/publishは未実施。

その後、管理者のDNS処理承認に従い1.1.1.1でDNS/TLS確認成功。同じ固定domain operationをCONNECT tunnel経由で正常完了し、url_change/未完了domain操作解消・正規URL変更を確認してresumeした。

第5段階のpublish-rss-importはShow公開の状態検証エラーでexit1となり再停止。cursor=waiting/step4、既知job=7d484a96-f681-41ad-b91d-c877fb858b7e。停止後の読み取りではpublished/ownership held、service open/invocations1件/unfinished_show_operation=true。Episode公開は未着手。再送・強制解放・pause/resumeなし。

管理者の承認後、Show jobのpublished/releasedとowner/invocations解消を確認して同一importを1回継続した。最初のEpisode publish receipt後に同じ状態検証エラーが再発し、再停止。cursor=waiting/step8、job=a497abe0-450b-407b-96bb-c52d7782547c。読み取り時はprocessing/ownership held、service open/invocations1件。残り35件は未着手。

再発後の継続/原因調査は管理者判断待ち。全件配信照合・回帰・最終pauseは未実施。試験DNS tunnelは終了済み、OS DNS変更なし。詳細は`evidence/rss-import-20261012-run1/result.md`。
