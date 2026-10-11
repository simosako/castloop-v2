# 独自ドメイン受け入れ試験 run4 計画

## 修正確認

- Issue #7修正コメント: https://github.com/simosako/castloop-v2/issues/7#issuecomment-6107383521
- 試験対象予定commit: `da6b6ea8309a87508dc7e7d0b4b70d84bba040d8`（feature/custom-domains、計画時の最新）
- removeWorkerDomainが削除専用の完了応答検証へ変更。
- 所有確認後、HTTP204、またはHTTP200の本文全量取得/解析済みJSON null・success===trueのみ許容。errors不正/非空、202、空/不正/切断本文などは拒否。
- 通常JSON APIにはnull許可を拡張しない。receipt保存→exact token返却→所有権解放→paused完了のrunnerは維持。
- Workerコードは変更なし。開発側報告は937 pass / 0 fail。こちらではまだ再検証していない。
- 最新手順第9節も、run3の再実行/token強制解放/resume禁止を明記。

## 環境分離

run3はpaused・未完了connection記録・原本workspaceと全リソースをそのまま保持する。run1/run2も変更しない。
修正版CLIへ交換しただけでrun3の完了証明は得られないため、run3での削除再試行はしない。

新規のrun4で手順全体を実施する。予定値（使用前に未使用確認）:

| 項目 | 値 |
| --- | --- |
| hostname | castloop-test-r4.otftalk.com |
| service ID | domtest-1011-r4 |
| bucket | castloop-domain-20261011-run4 |
| workspace | workspaces/domain-20261011-run4/ |
| evidence | evidence/domain-acceptance-20261011-run4/ |
| binary | bin/castloop-linux-x64-da6b6ea |

Cloudflare DNS/Custom Domainは事前に手動作成せず、castloop domain addに作成させる。
hostnameは終了時のdomain removeで削除し、Worker/bucket/Queue/DLQ/操作記録は保持する。

## 実施順序

1. 別のclean worktreeで対象commitを固定し、最新手順/ソースstatusをsnapshot保存。npm ci、npm run check、bun test、Linux CLI build、SHA-256/配置一致、domain helpを確認。以前のbinaryを上書きしない。
2. 新hostname/Zone/account、DNS/Custom Domain/Worker Route競合なし、service/bucket未使用をAPI GETで確認。Dashboard代替であることを明記。必要な権限・承認素材・site URLはこれまでの条件を維持。
3. 補助scriptのrun3固定値をrun4パラメータへ変更し、run3 workspaceやDNSを誤操作しないことを確認。
4. 最新手順第2〜4節を実施。2 Showのkeep、hidden/gone/draft、idleを新規作成し、明示的な公開/lifecycle完了を確認。RSS/media/current_revision/R2 keys/TOMLのbeforeを保存。
5. 第5節: pause、共通確認、温めた公開cacheに対する503（Issue #6回帰）、domain add、指定接続/URL/version/paused503確認後resume。
6. 第6節: 両hostのGET/HEAD/Range/ETag、RSS URLだけの変更、media/revision/R2一致、非公開パス保護、after-domain公開、Episode/Show unpublish/restoreを確認。
7. 第7節: domain保持deploy、version/readiness更新、接続/URL維持、resume後配信・保存data一致を確認。
8. 第8節（Issue #7重点）: 新pause/operation IDでremoveを1回実行。domain-changed-pausedと同operation ID、receipt、pending/token/url_change解消、local_operations=[]、domains=[]、workers URL、Worker version不変、paused503を確認する。
9. 共通確認後にresume。workers.devでRSS/media200、URL復帰、after-domainを含む公開コンテンツ維持、GUID/revision/R2不変、hidden404/gone410/draft非露出を確認。
10. APIで接続/DNS不在、認証なし旧hostname runtime probeが対象Workerを返さないことを確認。新pause IDで停止して最後の共通確認、項目別結果と保持リソースを記録。

## DNSと失敗時の扱い

- 通常PC DNSの追加調査/設定変更はしない。管理者承認済みの1.1.1.1直接解決を用いる試験プロセス限定CONNECT tunnelを、新hostnameだけに適用。
- OS/ルーターのDNS、CLIコード/binary、hostname/証明書検証は変更しない。TLSの終端/復号なし。Cloudflare APIと管理workers.devは通常経路。
- DNS/TLSが準備できた証拠を取るまでaddを完了扱いしない。待機例外での続行は同じ固定operation IDのみ。
- 状態照会の失敗はstderr/JSONを保存し、読み取りのみ継続する既存承認を維持。明示的な完了条件なしに次の変更へ進めない。
- 実行ツールの時間制限なし、変更結果を個別保存。変更要求の自動再送は禁止。
- 未知のDELETE/PUT/init/deploy結果、残留execution/lock、HTTP/データ不一致は停止して保存。domain/DNS不在や時間経過だけでtoken解放しない。
- 削除が再度失敗してもrun3/run4の強制復旧は別判断。失敗stderr、存在するreason_code、receipt/pending、service/domain状態を保持する。

## 実施状況

第1段階完了（2026-10-11）。固定commitのclean worktree `build/castloop-v2-run4`でnpm ci、npm run check、bun test（937 pass / 0 fail、101 files）、Linux CLI buildが成功。
`bin/castloop-linux-x64-da6b6ea`を新規配置し、build元とのcmp/SHA-256一致、version/help domainを確認。
SHA-256: `d65ebe33be503fa25a93ac7d07dfd4f2561e21e6430ab4f4688ba33eb5ac5b8c`。
証跡は`evidence/domain-acceptance-20261011-run4/`、詳細記録は`test-20261011.log`。

第2〜10段階も完了。新規run4で第5〜8節を合格し、Issue #7修正の実機確認、hostname削除、workers.dev復帰配信、最終pause/共通確認まで終了。
結果詳細は`evidence/domain-acceptance-20261011-run4/result.md`。run1〜3は変更せず、run4 Worker/bucket/Queue/DLQと操作記録を保持。
試験限定1.1.1.1 proxyは終了済み。OS DNS設定は変更していない。
