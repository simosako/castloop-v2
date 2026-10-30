# M7: RSSによるPodcast移行（レビュー用草案）

作成日: 2026-10-12。対象: [Issue #1 — migration via RSS](https://github.com/simosako/castloop-v2/issues/1)。**新規Show限定、ローカル確認後の明示公開、GUID schema拡張を採用し、v0.4.0で導入済み。** 以下は当時のQueue方式の設計・実装記録である。現行v0.8.0は新規14/13環境向けの同期公開とRSS進捗記録version 3を使い、旧staging・job・lockは使わない。現在の操作と中断後の再実行は[RSSガイド](../docs/rss_migration.md)を優先する。

## 1. 目的と推奨範囲

管理者が所有するPodcastのRSS URLを指定し、番組情報・Episode情報・カバー画像・MP3をcastloopへ移す。元のEpisode GUIDと公開日時を維持し、新しいRSSと音源をcastloopから配信する。

推奨は、**ローカル取り込みと公開を分け、公開には既存のShow登録・staging・publication処理を使う**方式。WorkerにRSS取得機能や移行専用Queue・汎用状態機械を追加しない。

- 公開RSS 2.0の1つのchannelを、新しい1つのShowへ取り込む。
- 取得したRSSに含まれる全Episodeを対象にする。黙って一部を除外しない。
- 音源は現行と同じMP3・1件300,000,000 bytes以下。カバーはJPEG／PNG。
- 対象は新規Showのみ。既存Showへの統合、継続同期、移行元の削除・設定変更は行わない。
- RSS取得・解析・素材保存はCLIで実施する。公開先は初期化済みM6サービスとし、必要なWorker更新は先に通常の`deploy`で行う。

これはcastloopの旧形式データ変換ではなく、外部RSSから通常の公開入力を作る機能である。

## 2. 現在の実装と必要な変更

| 現状 | M7の対応 |
| --- | --- |
| Show／EpisodeのローカルTOML生成、登録、音源検証、staging、公開、状態照会がある | 既存runnerを呼ぶ薄いCLI処理を追加する |
| `episodeDraftSchema.guid`は`z.uuid()`、revisionも同じ制約 | 外部RSSのGUIDを変更せず受け入れられる文字列schemaへ拡張する |
| `renderItem`は常に`isPermaLink="false"`を出力する | 移行元の属性を保持できる任意項目を追加する |
| RSSを生成するが、外部RSSの解析・素材downloadはない | CLI側に取得・解析・TOML変換を追加する |
| Show公開とEpisode公開は別jobで、同じShowは逐次処理 | 各jobの公開・owner解放を確認してから次へ進む |

主な変更箇所は`packages/cli/src/`、`packages/shared/src/index.ts`、`src/feed.ts`。公開・lifecycle・独自ドメインの安全条件は変更しない。

## 3. CLI案と操作の流れ

以下は新コマンドの提案であり、現行バイナリでは実行できない。

```sh
# Cloudflareへの変更なし。取り込める件数、不足項目、非対応項目を確認する。
castloop import-rss my-show https://old-host.example/feed.xml --dry-run

# RSS・素材・編集用TOMLを独立したローカルディレクトリに保存する。
castloop import-rss my-show https://old-host.example/feed.xml --output /path/to/import

# 生成したTOMLと取り込み報告を確認し、不足する番組情報を編集する。
# 初期化済みサービスのworkspaceで実行する。ここで初めて登録・upload・公開する。
castloop publish-rss-import /path/to/import
```

### ローカル取り込み

- `--dry-run`はRSSだけを取得し、変換結果・Episode件数・RSS記載の音源サイズ合計・エラーを表示する。音源の実内容が適合するかはdownload後に確認する。
- `--output`はRSSのスナップショット、`show.toml`、`episode-<id>.toml`、カバー、音源、`import.json`を保存する。Cloudflare認証・サービス設定は不要。
- `import.json`はShow ID、元GUIDとEpisode IDの対応、素材の取得先・ローカルファイル・size／SHA-256、取り込み結果を記録する。素材と取得先情報はGit管理外とし、ログにURLのqueryを出さない。
- 元RSSの不足項目は報告し、架空のowner emailやサイトURLを補わない。不完全な変換は下書きとして保存できるが、公開時は全件の現行schema検証を必須にする。
- 素材は1件ずつstreamで保存し、完了したファイルだけを確定する。再実行は同じRSSスナップショットと対応表を使い、size／hashが一致する完了素材を再利用する。編集済みTOMLを上書きしない。

### 明示的な公開

- 最初に全TOMLと素材を検証し、件数・総音源サイズ・公開先を表示する。検証エラーがある間はShow登録もuploadも始めない。
- 初回は未使用のShow IDを要求する。同名のローカルShow、サーバー上の登録済み／削除済みIDを取り込み先として採用しない。
- 既存Show登録runnerで登録し、通常のShowディレクトリへTOMLと素材を配置する。Showを公開して完了を待ち、Episodeを古い公開日時から1件ずつstage・公開する。同日時はEpisode ID順とする。
- 各jobで`published`かつ`released`を確認する。失敗・応答不明・待機上限では止まり、残りを公開しない。
- 最後に全件の公開完了と新RSSのGUID集合・公開日時・音源URLを照合し、新RSS URLを表示する。途中までの公開は起こり得るため、全件を一度に可視化する仕組みや自動rollbackは設けない。

`publish-rss-import`は利用者が全Episodeのコマンドを手作業で繰り返さなくて済むための逐次実行入口であり、独立した公開方式にはしない。

## 4. RSSからの変換規則

| castloop項目 | 元RSSからの扱い |
| --- | --- |
| Show ID | 管理者が指定するslug |
| Show基本情報 | channelのtitle／description／language／link、iTunesのauthor／owner／category／explicit／type、copyrightを対応付ける |
| Showカバー | `itunes:image`を優先し、なければchannelのimage/url。実ファイルの形式を検証する |
| Episode ID | `ep-`と元GUIDのSHA-256から作る固定slug。タイトル変更・RSS順序に依存させず、対応表で衝突を確認する |
| GUID | XMLを復号した文字列をそのまま保存する。UUID化・URL置換・大文字小文字変換をしない |
| 公開日時 | itemのpubDateを厳密に解析し、同じ時刻のRFC 3339文字列へ変換する。欠落・不正値を現在日時で埋めない |
| Episode説明 | `content:encoded`があれば優先、なければdescription。CDATA／entityを復号し、HTML文字列を二重escapeせず現行RSS rendererへ渡す |
| Episode任意項目 | iTunesのexplicit／episodeType／season／episodeを現行schemaへ対応付ける |
| 音源 | itemのenclosureから1件取得する。実MP3のsize／duration／SHA-256を使い、元RSSのlength／durationを正しいものと仮定しない |

- GUIDなし・空・重複、公開日時不正、複数enclosureなど選択が曖昧なitemはエラーにする。item番号とタイトルを示し、黙って捨てない。
- namespaceはprefix名ではなくURIで判別する。iTunesのcategory階層など現行schemaへ完全に写せない情報、Episode画像・独自拡張・transcript等は取り込み報告で列挙する。全XMLの完全複製は保証しない。
- RSSのページ分割や取得時点で載っていない過去Episodeは対象外。出力に「取得したRSS内の件数」を明記し、元ホストの全件数と管理者が照合する。
- 説明内の画像・リンク先など、enclosureと番組カバー以外の外部コンテンツはコピーしない。旧ホスト依存URLは切替前に確認する。

### GUID schemaの互換性

GUIDは空でない文字列として受け入れ、XMLに使えない制御文字を拒否し、長さに上限を設ける。上限案はUTF-8で4 KiB。既存UUIDはそのまま有効とし、通常の`create-episode`は従来どおりUUIDを生成する。

任意の`guid_is_permalink`を追加する案とする。既存データで省略時は従来の`false`、取り込み時は元RSSの属性（省略時はRSS仕様の`true`）を保存する。初回公開後はGUID文字列・この属性・公開日時を固定し、既存の比較処理に属性の比較を加える。

R2 keyや内部のjob／operation／revision IDは引き続きslug／UUIDを使用し、外部GUIDをパスとして使わない。既存データの一括変換はしない。ただし古いWorkerは任意GUID・追加項目を読めないため、**取り込み前にCLIとWorkerをM7対応版へ更新する**。取り込み後の古い版へのdowngradeは非対応とする。

変更する項目は次の2つだけで、移行元専用の別Episode schemaは作らない。

| 項目 | 現在 | M7案 |
| --- | --- | --- |
| `guid` | UUID文字列のみ | UUID・URL・ホスト独自IDを含む空でない文字列。UTF-8で4 KiB以下、XML 1.0で表現できない文字や不正なUnicodeを拒否 |
| `guid_is_permalink` | 項目なし、RSS出力は常にfalse | 任意のboolean。省略した既存データはfalseとしてRSS出力 |

例えば元RSSが次の場合:

```xml
<guid isPermaLink="false">old-host:episode:12345</guid>
```

生成するEpisode TOMLには次を記録する。他の必須項目はここでは省略する。

```toml
schema_version = 1
episode_id = "ep-..."
guid = "old-host:episode:12345"
guid_is_permalink = false
published_at = "2020-04-01T03:00:00Z"
```

`guid`のtrim・Unicode正規化・ハッシュへの置換は行わない。XML entityの表記は復号・再escapeで変わり得るが、GUIDとして解釈される文字列は維持する。空白だけのGUIDはエラーとして扱い、別の値を生成しない。

`guid_is_permalink`はGUIDがWebページへの恒久リンクを意味するかを表す。元RSSでtrueならtrue、falseならfalse、属性なしならRSS仕様の既定値trueを明示保存する。音源URLや公開先ドメインが変わってもGUIDをそれらに置換しない。この属性を保存するのは元RSSの意味を保つためであり、重複防止の中心はGUID文字列の維持である。

同じ定義をローカル下書き・公開current metadata・revision履歴で共有する。任意属性の省略は保存・解析時にそのまま保ち、RSS出力と公開後の不変条件の比較時だけfalseとして扱う。既存ファイルへのdefault値の追記や既存revisionの書き換えはしない。

`schema_version = 1`を維持する案とする。新しい版は旧データをそのまま読めるが、旧版が新データを読めるという意味ではない。Show／service schemaは変えず、内部UUID・slug制約も緩めない。

公開後はGUID・公開日時に加え、この属性の実効値も変更不可にする。省略と明示falseは同じ意味として比較する。取り込み元のGUID重複はローカル変換で拒否し、公開時は既存の同一Show内GUID重複検証を再利用する。GUID維持で重複の主因を避けるが、全Podcastクライアントの重複判定を保証するものではない。

## 5. 取得と中断の扱い

- XMLはDTD・外部entityを受け付けず、文書サイズを制限する。案はRSS 8 MiB・redirect最大5回。メタデータ総量とfeed生成予算も既存の制限に照合し、大きすぎる取り込みを一部だけ成功扱いにしない。
- 取得はHTTP／HTTPSのみ、HTTPSからHTTPへのredirectを拒否する。URL内の認証情報、localhost・private／link-local等の接続先を拒否する。DNS解決先と各redirect先にも同じ条件を適用し、検査した接続先へ実際に接続する。
- 外部取得にはCloudflare tokenや管理鍵を送らない。timeout、受信byte上限、HTTP応答確認を設け、Content-Lengthがなくても上限超過を止める。
- MP3はローカル保存後、既存の解析・upload・全量読み戻し検証を利用する。変換・再エンコード・Workerでの全量再ハッシュを追加しない。
- downloadの中断はローカル未完了ファイルだけを再取得する。公開側は既存journal・receipt・owner管理を使い、未知の変更要求を新jobへ置き換えない。
- 公開進捗には取り込みID、サービスidentity、公開入力のhash、既存登録／公開job IDへの参照を`.castloop/`に保存する。保存処理とlockは既存共通実装を使い、receiptや公開状態検証を二重実装しない。
- 再実行は同じ取り込みの既知jobを照会する。既存journalと一致する完了・解放を確認したものだけを飛ばし、結果不明のjobは既存の状態照会・復旧手順へ案内して止める。

## 6. 旧ホスティングの切替と削除

**取り込み完了だけでは旧ホストを削除してよいとはいえない。** 新RSSを作ることと、既存購読者が新RSSへ移ることは別である。

1. 元ホストのEpisode件数と取り込み件数、GUID・公開日時・説明・音源・カバーを確認する。
2. 新RSSと音源が取得できることを確認する。途中公開中には旧配信を切り替えない。
3. 旧ホスト側で新RSSへの301 redirectを設定し、各Podcast directoryの移行手順を実施する。
4. 各directoryの必要な待機期間・移行確認を満たし、旧ホスト依存の素材が残っていないことを確認してから廃止を判断する。

Appleの案内ではGUIDの維持と、redirect等の少なくとも4週間の維持が求められる。M7は旧ホスト側の設定・契約解約・購読者移行を自動化しない。`itunes:new-feed-url`等の必要な設定は切替手順に整理し、対応していないホストでは購読者移行を保証しない。

## 7. 実装順と受け入れ

1. **GUID互換性:** schema・RSS出力・公開後の不変条件を拡張し、既存UUIDデータが引き続き動くことを検証する。
2. **ローカル取り込み:** RSS解析・項目変換・素材取得・報告・download再開を実装する。
3. **既存公開への接続:** 明示公開コマンドを既存runnerへ接続し、逐次完了確認と既知jobの再開を実装する。
4. **利用案内・実機確認:** 小さいMP3を含む制御可能な元RSSから専用Showへ移し、通常更新・lifecycle・独自ドメインとの互換性を確認する。

テストは責務ごとに置き、既存公開runnerの故障ケースを取り込み層で網羅し直さない。

- 解析・変換: UUID以外のGUID、isPermaLink、namespace、CDATA／HTML、日時・任意項目、不足・重複・非対応入力。
- 取得: redirect、秘密を送らないこと、不正XML、timeout・サイズ上限、非MP3、中断素材の再取得。
- CLI接続: dry-run／取り込みがCloudflareを変更しないこと、公開が既存runnerを使うこと、失敗・未知結果で次へ進まないこと、確認済み完了だけを再利用すること。
- 回帰: 通常の新規作成、UUID Episode、metadata／audio更新、GUIDと公開日時の固定、公開後の非公開化・復元が保たれること。
- 実機: 複数EpisodeのGUID・日時・説明、ローカル取得音源と公開音源のhash、RSS内の件数とURLを照合する。RSSが旧音源を参照しないことも確認する。

300 MBの既存upload受け入れとM6の安全条件を再利用し、移行専用の巨大な障害試験マトリクスや新たなCloudflare資源は作らない。実機環境・費用が必要になる場合は、利用対象を別途確認する。

## 8. レビューしていただきたい点

レビュー結果と残る確認点は次のとおり。

1. **承認済み: 新規Showへの一度きりの取り込みに限定する。** 既存Show統合・定期同期・非MP3変換・全RSS拡張の保存は対象外。
2. **承認済み: ローカル確認と一括逐次公開の2段階にする。** ファイルと必要情報のdownload結果を管理者が確認してから公開処理へ進む。
3. **承認済み: 元GUIDを維持し、schemaを拡張する。** 「GUID schemaの互換性」の項目・保存例・互換性を採用する。元GUIDを新UUIDへ置換する方式は採用しない。

## 参考

- [RSS 2.0仕様（GUID・enclosure・pubDate）](https://www.rssboard.org/rss-specification)
- [Apple: RSS feed URLの変更とGUID維持](https://podcasters.apple.com/support/837-change-the-rss-feed-url)
- [現在の全体設計](initial_design.md)
- [現行CLIと復旧制限](../README.md)

## 実装状況

M7開発ブランチ`feat/m7-rss-import`で以下を接続し、v0.4.0に含めた。以下の2026-10-12の試験・未完了記述は当時の履歴であり、現在の利用条件と待機上限は[RSS移行案内](../docs/rss_migration.md)を参照する。v0.4.0は各job最大300回・5分後に新しい照会を開始しない仕様。FreeのHTTP CPU適合とIssue #13の完全解消は保証しない。

- GUID文字列schema、任意`guid_is_permalink`、共通の公開後identity比較、RSS出力。
- namespace対応のRSS解析、dry-run、画像・MP3・TOMLのローカル保存、同じスナップショットからのdownload再開。
- 全件の公開前検証と`publish-rss-import`による既存runnerの逐次実行。確認済み待機jobの再照会と、未知変更要求の再送拒否。
- 認証付き`service-status`の`external_episode_guids: true`で対応Workerを確認し、旧WorkerにはShow登録を始めない。設定ファイルの自己申告では判定しない。
- 実行進捗は1つの小さいcursor記録に置き、既存の登録・staging・publication journalへの処理を再利用する。共通journal保存・lock実装を使用する。
- [RSS移行の利用・切替案内](../docs/rss_migration.md)。

自動テストでは2 Episodeの取り込みから正式runner・Queue consumer・新RSS照合までを通し、状態照会中断後の続行、GUIDと音源内容の維持、旧Worker拒否、未知変更要求の再送拒否を検証する。実Cloudflare環境での受け入れと、配布版としての公開判定は別途必要。

2026-10-12の検証:

- `bun test`: 960 pass、0 fail。追加の移行Episode非公開化・復元も関連テストで確認。
- `npm run check`、`npm run build:cli -- linux-x64`: 成功。
- 単一バイナリで両コマンドのhelpと非HTTP URL拒否を確認。
- Cloudflare資源・設定・配信内容の変更は行っていない。残る受け入れは、利用対象を確認した試験サービスと公開元RSSを使う単一バイナリでの実機移行。GUID・日時・説明・MP3 hash・新RSS URLを照合する。

### Issue #10: 公開中の状態照会による停止

[Issue #10](https://github.com/simosako/castloop-v2/issues/10)と証跡ブランチ`test-evidence/rss-import-20261012-run1`（固定commit `308090e4c4b48ceed2de0687114fea8bfe77ef41`）を確認した。36件のローカル取得は成功したが、Show公開後と最初のEpisode公開後に一般的な状態検証エラーで停止した。失敗時のHTTP応答は残っておらず、実機での原因は断定できない。

コードでは、publication記録またはservice snapshotの読み取り前後の変化を、他の検証失敗と同じエラーへ変換し、逐次公開を即停止していた。この経路を自動テストで再現し、次のように修正した。

- Workerは読み取り中の変化だけをHTTP 409／`publication_status_changed`として返す。schema・manifest・所有者不一致や変更操作の失敗はこのコードにしない。
- CLIはstatus要求・応答形式・service IDを確認し、ローカルjournal／lockが変わっていない場合だけこの区別を保持する。
- 一括公開はその場合だけ同じjobを再照会する。最大120回、待機開始から2分経過後は新たな照会を始めないという既存上限を保ち、検証済み`published`／`released`まで進まない。上限後もwaiting cursorを保持する。
- その他の失敗は秘密を含まないallowlistの診断コードで停止する。変更要求の再送、jobの再投入、owner／token／lockの解放は追加しない。

既存試験workspaceを新規initし直す必要はない。修正済みCLIをビルドし、通常のpause／drain／deploy／検証／resumeでWorkerも更新する。その後、元の取り込み先と保持したwaiting cursorで`publish-rss-import`を続行する。処理中・不明なownerが残る場合はdeployせず、既存の状態照会で確認する。実機の全36件完了は引き続き未検証。

修正後の検証: `bun test`は962 pass／0 fail、`npm run check`とLinux単一バイナリbuildは成功。Show／Episodeの読み取り競合からの続行、継続的競合の上限停止、通信・応答・identity異常の診断、ローカルlock変化での停止、変更要求への競合コード誤適用拒否を確認した。Cloudflare環境への変更は行っていない。

### Issue #10追試: 更新前の対象照会と未開始cursor

追試コメントと`test-evidence/rss-import-retest-dc33f75`（固定commit `275151233aa77d25e7764cef4f51c71851d4308c`）を確認した。CLI／Workerを更新後、5件まで公開できたが、6件目の最初の`update-episode`で対象照会がHTTP拒否となり、step 25／`command_requested`に停止した。具体的なHTTP応答は保存されていないため、追試時の拒否原因も未確定。

対象照会はservice・Show・Episode・revisionのsnapshot変化をすべて一般拒否にしていた。またRSS cursorは更新runnerを呼ぶ前に`command_requested`を保存するため、読み取りだけの失敗も未知mutation扱いとなっていた。修正範囲は次の通り。

- Workerの確認済みsnapshot変化だけを`target_status_changed`として区別する。CLIはservice ID・応答形式を照合し、読み取りだけ最大3回実行する。不整合や一般HTTP拒否は再照会しない。HTTP拒否の診断には数値のstatusを含める。
- 更新runnerの対象照会は下書きjournal作成・staging開始より前に実行される。その部分の例外だけを型で区別し、RSS cursorを`ready`に戻して停止する。変更処理開始後の例外は引き続き`command_requested`を保持する。
- 既存cursorも、Episode作成後の最初のメタデータ更新段階に限り未開始確認を行う。下書きjournal／lockが存在せず、保持したローカルTOMLが取り込み内容と一致し、認証付き対象照会でEpisode未登録・Show active／open・所有者なしを確認し、ローカル記録が照会前後で変わっていない場合だけ`ready`へ戻す。確認したstepをcursorへ保存する。
- この未開始判定は、更新が必ず下書きjournalを永続化してから変更要求を送る既存runnerの順序に依存する。journal／lockを削除・古いbackupへ復元したworkspaceは対象外。既存下書きがあれば、サーバーに所有者が見えなくても再送しない。登録・音源更新・公開の結果不明記録にも適用しない。

追試workspaceでは、記録・入力・URLを保持したままCLIとWorkerを更新し、同じ`publish-rss-import`でこの確認を実行できる。確認失敗時には停止した記録を保持する。Cloudflare設定の変更・実機再試験は本修正では行わず、全36件の完了確認は試験側で実施する。

修正後の検証: `bun test`は965 pass／0 fail（108 files）、`npm run check`とLinux単一バイナリbuildは成功。対象照会の競合限定再試行と上限、別service／不正応答の即時停止、更新前のHTTP拒否後の`ready`保持、旧cursorの未開始確認と続行、所有者あり／既存下書きでの再送拒否を確認した。
