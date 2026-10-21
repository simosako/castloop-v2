# Issue #48: Show分離のCloudflare実機確認（2026-10-20）

これは初回の停止記録。[承認後の診断改善・新規環境再試験](do_show_separation_live_retest_20261021.md)では2 Show・6 Episodeの機能確認に成功したが、初回環境のblockedを解放したものではない。

## 承認と対象

ユーザーの実機テスト依頼に基づき、保持環境ではなく、新規の`storage_layout="show-v1"`サービスを1つ作成する。開発ブランチ`feat/show-do-separation`のcommit `4b58bb4`からLinux単体CLIを再構築し、そのCLIに埋め込まれたWorkerを配備する。

- 新規Worker、private R2 bucket、SQLite DO namespace、workers.devでの検証に限定する。
- Showを2つ作成し、各Showに10秒・30秒・60秒のEpisodeを1件ずつ、合計6件公開する。素材は`.local-test-data/`内の既存coverと短尺MP3を複製し、原本を変更しない。
- 各Showの初期paused/ready/drained、公開、feedと一覧、音源の全量SHA-256・HEAD・Range・304、cover配信を確認する。
- AをPauseしてBの3件目を公開し、次にBをPauseしてAだけResume・3件目公開する。停止したShowの配信は503、他Showの配信と通常操作は継続することを確認する。
- 全Showの個別Pauseによる集約状態と、独立したResume後も既存feed/音源が保持されることを確認する。最後は両Showを個別にPauseし、資源・journal・証跡を保持する。
- 既存サービス`sq16r-6ec01dc6`、DNS、独自ドメイン、共有証明書、権限、課金、CPU上限、既存ローカル証跡は変更しない。削除、旧環境移行、未知要求の再送、故障注入は行わない。

非公開の実行script・要求前記録・CLI出力・配信検証・journalはgit-ignoredな`.local-test-data/`に保存する。結果不明なら停止し、別の要求や環境へ置き換えて成功とみなさない。

## 結果

**初期化probeで停止したため、2 Show・6 Episodeの機能確認には到達していない。** 成功済み試験として扱わない。

- 実行開始: 2026-10-20 14:04:38 UTC。Linux単体CLIで`init`を1回実行し、14:04:54 UTCにexit 1で停止した。
- CLI artifact SHA-256: `a4f4d8981d3b1f7419887e5da9370193dc8fb89ee7e0c851afaa28085a6e6ec7`。
- private R2 bucket作成、設定upload、Worker作成・配備、workers.dev有効化の成功応答をjournalに保存し、RESTの配備・namespace・ETag照合まで進んだ。
- 実DOの初期化は`setup.state=blocked`となり、CLIは`SQLite runtime probe is blocked; preserve initialization evidence`で停止した。
- 対象Workerだけに絞った保存ログの一時照会（`dry: true`）で、cache ownerの`invalidate`に`sqlite_cache_purge / purge_unconfirmed / attempt=1 / will_retry=false`、続いて`sqlite_runtime_setup / runtime_probe_failed`を確認した。
- したがって、**cache purgeの成功応答を確認できなかった段階**までは特定できる。保存済み診断は固定コードのみであり、例外の詳細や未確認応答の内容はない。Cloudflare側の一時障害・API実装・アプリ側の扱いのどれが原因かは未確定。rate-limitによる明確な拒否だったとは判断しない。
- Show登録、Resume、素材upload、Episode公開は一度も開始していない。再初期化、probe再送、強制解除、同じWorkerへの再配備や、新環境への置換試験は行っていない。

### 保持した環境と最終状態

| 項目 | 値 |
| --- | --- |
| Service | `i48-dc48db43` |
| Worker | `castloop-i48-dc48db43-d91763ff` |
| Private R2 bucket | `castloop-i48-dc48db43` |
| 管理・配信origin | `https://castloop-i48-dc48db43-d91763ff.simosako.workers.dev` |
| Layout | `show-v1` |
| 初期化journal | `setup_requested`。配備receipt・namespaceを保持 |
| Native runtime | `publication_ready=false / paused / drained=true / setup=blocked` |
| 業務状態 | Show 0、queued 0、active null、共有maintenance null |

14:06:18 UTCの読み取り専用再照合でも、配備version・deployment・namespace・ETagが初期化receiptと一致し、上記の停止状態だった。全資源を保持し、既存保持サービスやDNS等は変更していない。

非公開の原本は`.local-test-data/results/20261020/i48-dc48db43/`に保持する。`001-requested.json` / `001-init.json`、`probe-logs.json`、`final-readonly-inspection.json`、workspace内の初期化journalが対応する。秘密鍵・生ログ・未公開操作IDはGitへ追加しない。

### 次に必要な切り分け

本環境のblockedを解除せず保全したまま、別途範囲を確認してcache purgeの未確認応答を診断する必要がある。必要なら診断をallowlist方式で改善し、ローカル回帰を通した後、明示的に承認された新規環境で試験をやり直す。今回の失敗や旧環境の測定をShow分離の実機成功へ読み替えない。

## 検証範囲の限界

少数・短尺の機能確認であり、300MB upload、並列負荷性能、全Free適合、全invocationのCPU、blockedからの復旧、共有Worker更新の受け入れを示すものではない。ローカル故障注入試験とは[ローカル検証記録](do_show_separation_verification.md)で区別する。
