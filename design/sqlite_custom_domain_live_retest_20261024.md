# SQLite独自ドメイン再試験・停止記録（2026-10-24）

## 結論

**再試験も接続receipt検証で停止し、受け入れは未完了。原因は未確定。** [初回停止](sqlite_custom_domain_live_verification_20261024.md)で判明した空一覧表現・opaque domain IDを修正した版で、別hostname・別のfresh環境を使った。新規2 Showの通常公開とPause/drainまでは成功したが、domain addは再び`connection_requested`に留まった。

停止後のGET一覧は修正版の接続schemaに適合した。したがって、**32桁固定の修正だけで元の問題を解消できたとは扱わない**。元PUTの生応答は保持しておらず、PUT応答と後のGETの差異や不一致fieldはこの試験の証拠から特定できない。現在値を成功receiptへ採用せず、接続再送・後続配備・activation・切断・Resume・保守解除を行っていない。

## 承認・実行物

管理者は初回環境を保持したまま、`castloop-domain68-r2.otftalk.com`と別の新規環境で、元と同じ操作範囲の再試験を明示承認した。新規作成・配備・素材公開・各ShowのPause/Resume・domain接続と切断・通常更新/lifecycle/deployが対象であり、既存資源・初回停止環境の変更やcleanup、証明書削除、権限・課金・上限変更は含まない。異常時は後続mutationを停止する。

- mutation実行時commit: `05d20bcadd585250da6f902c4ce7a46b003953d4`。
- Linux CLI SHA-256: `77097f3a69c4865ab8bcb3a3a70bca9264e8bbe694595f9c264d97677e80af5b`。
- 同じaccount、active/fullな`otftalk.com` Zone、未使用hostnameを読取確認してからfresh initした。
- 初回のworkspace・journal・接続・Worker・bucket・DOは再利用せず、元の未知結果を昇格しなかった。

## 確認できたこと

1. 新規Worker/R2/SQLite namespaceでnative setupが成功した。Feed世代予約・domain能力識別をhealthで確認した。
2. 2 Showと各1 Episodeの**計4公開jobがsucceeded**。承認されたminimal素材の80,501 bytes MP3・JPEGをコピーし、原本は変更していない。各Showに別のローカル未公開Episodeを作成し、upload/publishしていない。
3. workers.devのFeed/cover/audioでGET 200、Feed/coverのHEAD 200・ETag条件304、audioのHEAD 200・Range 206・ETag条件304を確認した。audio全量hash/size、先頭128 bytes、cover hashを素材と照合した。Feedにローカル未公開Episodeが含まれないことも確認した。
4. `system/`・`staging/`・内部Feed世代URLは404だった。各ShowをPauseし、Feed/cover/audioの条件付きheader・Range付きGET/HEADが503/no-storeとなった。
5. domain addを専用UUIDで1回だけ実行した。remote prepareは対象2件とも完了したが、CLIは`invalid_input / outcome=unknown`、local phaseは`connection_requested`で停止した。成功receiptはなく、設定同期やWorker再配備は行われていない。
6. 読取一覧には対象Workerへの接続1件、40文字ID・UUID形式cert_id・enabled true・previews falseが見え、修正版schemaで検証できた。これは元PUTの成功証明ではない。
7. 停止後もworkers.devは503/no-store、未設定の独自originは通常TLS検証を有効にしたBun GETでFeed/cover/audioを404/no-storeとした。正規独自originの配信試験とは区別する。
8. 基準として保存したFeed 4世代・cover 2世代・Episode revision 2件の**8 private objects / 4,353,272 bytes**を再GETし、hash/sizeが不変だった。
9. 新規対象を除いたDNS・domain接続・Worker metadata・bucket一覧・routesは試験前と一致した。初回環境のhealthも読取確認し、同じversion・paused/drained・prepared保守拘束のままだった。既存bucket全objectやDB全体の完全照合ではない。

## 最終状態

| 項目 | 対象・状態 |
| --- | --- |
| service | `i68r2-f53c5d53` |
| Worker | `castloop-i68r2-f53c5d53-e9064dfa` |
| private R2 bucket | `castloop-i68r2-f53c5d53` |
| SQLite namespace | `fb9ce4468b474181b1f9c9d38f9c16e9` |
| Worker version | `7a070900-0a4a-4554-b85e-5a85b78d42df`（initから不変） |
| hostname | `castloop-domain68-r2.otftalk.com`。接続・管理DNSを保持、切断なし |
| 正規origin | workers.devのまま |
| Show | alpha/betaともpaused/drained、active null、queued 0、setup ready、保守拘束あり、publication_ready false |
| domain操作 | local connection_requested、remote prepared、prepared 2 / completed 0 / released 0 |
| list | configuration_matches true / connections_match false、未完了操作を表示 |
| 最終読取照合 | 2026-10-24 04:27:26 UTC |

これは正常終了のready/paused/drainedではない。初回・再試験とも保守拘束付きで保持し、自動復旧・強制解除・削除をしない。

## 診断の改善と残る確認

この再試験では既存CLIが応答schemaの例外を一律`invalid_input`へ変換し、元応答や不一致fieldを記録していなかった。値を推測してschemaを緩めるのではなく、停止後に`774c818`で外部接続receiptの固定診断を追加した。

- `domain_connection_unverified`と固定message、既知field名と検証codeだけをJSON errorへ出す。
- response値・未知field名・任意例外文・本文を出さない。最大20件で制限する。
- HTTP success envelope、接続identity、strict schema、mutation前checkpoint、未知結果の再送/採用拒否は変更しない。
- 不正なcert_idと秘密を模した未知keyを注入し、値/keyが出ず、phaseと再送拒否を保つ回帰を追加した。

**637 pass / 0 fail、76 files、77.07秒**。型検査、Linux CLI build、diff検査成功。診断版CLI SHA-256は`5d778fef758a8fcc4e8983628f4ea79d91444e9486a972a13bc7e8ddcb9e9adc`。この診断版で新しい実機mutationは行っておらず、原因解消の証明ではない。

正規domainの設定/配備/Feed切替、301/307、独自originでの管理API拒否・通常更新/lifecycle、接続維持deploy、切断復帰は未実施。RSS、購読app、native故障注入、全cache/purge、tail/保存ログ、CPU/負荷・300MB・全Free適合も未確認である。

私有証跡はgit-ignoredな`.local-test-data/results/20261024/i68r2-f53c5d53/`に保持する。全26 CLI操作の要求前記録・応答、原本runner、基準Feed/identity、素材/配信hash、private履歴のhash、前後一覧、native status、停止理由と診断版の試験ログを含む。197ファイルのSHA-256 manifestを保存後に再照合した。鍵・未公開ID・本文・raw応答はGitへ追加しない。manifestは完全なSQLite backupではない。

既存の2接続へ要求を再送したり、現在値から未知journalを埋めたりしない。新たなhostname/環境で診断する場合も、対象と範囲の追加承認を得る。停止環境の廃棄やcleanupは別承認であり、この記録を実行許可にしない。
