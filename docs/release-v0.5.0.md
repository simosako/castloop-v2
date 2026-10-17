# castloop v0.5.0

SQLite-backed Durable Objectによる逐次公開を追加したLinux x86-64向けCLIです。
CLIで一意のR2 keyへ素材をupload・検証した後、明示的な公開要求をDOのSQLite FIFOへ積み、Alarmが1件ずつ実行します。
SQLite方式ではR2をロック・進捗DBとして使わず、Cloudflare Queues／D1／DLQも不要です。

## 導入・互換性

- **SQLite方式は明示指定です。** `castloop init DIR --publication-protocol sqlite-sequential-v1 ...`で新規サービスを作成します。configは`schema_version = 2`、content schemaは3です。
- flag省略時の既存Queue方式（`schema_version = 1`）のdefaultと既存workspaceのroutingは維持します。installやRelease公開だけでWorker・資源・データは変更されません。
- Queue方式からSQLite方式への変換、既存資源の採用、古いSQLite schemaの変換は提供しません。TOMLのschema/protocolを書き換えて移行しないでください。
- 新CLIと対応する検証済みWorkerの両方が必要です。SQLiteは同じconfig/schema/namespaceのcode-only互換更新だけを扱い、明示pause/drain→配備・probe→paused完了→新window UUIDでresumeします。
- SQLite resumeのUUIDは新しい受付windowです。既存Queue方式の「同じpause IDでresume」と混同しないでください。

## SQLite方式の対応機能

- fresh initと実DO／Alarm／R2／cache／purgeの稼働確認。初期化はpausedで終了します。
- Show登録、ローカルShow/Episode作成、一意素材upload、明示公開、job status、pause/resume。
- metadata-only／audio-only更新、不変音源・revision履歴、purge成功後の完了記録。
- SQLiteからの20件ずつのShow/Episode一覧、GET/HEAD/Range/304配信。
- Show/Episodeの非公開化・保存済みsnapshotの復元。GUID/date/audioを維持し、Show復元で個別停止Episodeは復活させません。
- レビュー済みローカルRSS取り込みから新Showへの逐次公開。元のGUID/permalink属性/日時を維持します。
- 同一namespaceの互換Worker更新と、正確な応答確認済みjournalだけを対象とした限定的な検証続行・読み取り照合。

## 通信・診断の改善

- SQLite管理GETだけに有限retryを追加しました。通信／本文断、408/429/500/502/503/504は最大3試行、1試行10秒・試行開始予算30秒です。既存の最大300 GET／5分の新規poll開始上限も維持します。
- 不正schema/identity/header、恒久拒否、cleanup失敗はretryしません。POST/PUT、公開・登録・配備等のmutationは自動再送しません。
- 読了後の不要なbody cancelを除き、未完了IOのsettlementを待ちます。以前の`clientDisconnected`の低層原因が確定・解消したとするものではありません。
- 非秘密の凍結request UUIDでstatus GETの観測を対応付けます。試験ガードは既知status GETの取消だけを同一runtime/jobの再GET照合へ回し、未知mutationや公開失敗を成功扱いしません。
- 試験部品は独立tmux/supervisor通知、保存ログ検索、通常HTTPとDO/AlarmのCPU区分、欠測・拒否frameの検出に対応します。秘密・素材・原本ログ・private試験データはGitやReleaseに含めません。

## 実機確認・性能

既存の隔離SQLiteサービスで、互換更新と正式RSS 3 Episodeの先行確認に続き、36 Episode規模の公開とmetadata-only更新10回を完了しました。
初回14 Episodeの後にstatus GETの`clientDisconnected`で観測ガードが停止しましたが、公開15 job自体はすべて成功していました。
修正版CLIで同一runtime・既存job・素材を読み取り照合し、未開始の22 Episode＋更新10回だけを継続しました。成功済みの要求・配備・resumeは再送していません。

- 累計47成功job（Show 1＋Episode 36＋更新10）。継続分32 jobはすべて成功し、freeze／blocked／CPU timeoutは観測しませんでした。
- 残り22 Episodeのcreate/upload/publishは計139.527秒、中央値6.259秒/件。publish単独は中央値2.467秒。metadata-only 10回は中央値3.264秒、最大4.813秒でした。
- 公開probeのCPUは**60/60**を保存ログへ対応付け、数値CPU付き765 eventsを取得しました。外側HTTP最大**3ms**、内部cache HTTP最大**5ms**で、今回の通常HTTP経路・負荷ではWorkers Freeの10ms目標を満たしました。
- DO HTTP最大19ms、DO Alarm最大11ms。DOの既定CPU上限30秒は通常Workerの10ms上限とは別です。ジョブ総CPUの合算は判定条件にしません。
- 新規MP3は累計2,898,036 bytes。元の253 objectと既存36件feedを保持し、更新10回ではMP3 inventory・GUID/date/audioを維持しました。最終状態はready/paused/drained、active null、queued zero、feed 503。ローカル試験processも終了しています。

これは短尺MP3による**エピソード数・metadata量の通常規模試験**であり、大容量音源の転送試験ではありません。
中断・CLI修正を挟むため、連続36件公開の総wallベンチマークとしては扱いません。
今回通信断は再現せず、retryの実機発動は未観測です。通信断・期限・非再送分岐は自動回帰で確認しています。
詳細は[試験記録](https://github.com/simosako/castloop-v2/blob/v0.5.0/design/sqlite_size36_measurement_20261017.md)を参照してください。

## 重要な制限

- **SQLite方式の物理削除・独自ドメイン・既存移行・blocked jobのretry/releaseは未対応**です。旧Queue操作へfallbackしません。非公開化はpayloadを保持するため容量を減らしません。
- 新経路のnative 300MB公開と実機purge rate-limit retryは未検証です。Queue方式の過去の300MB受け入れを流用しません。
- 今回取得したCPUログの観測範囲を超えた全負荷・全操作のFree適合や、[Issue #13](https://github.com/simosako/castloop-v2/issues/13)の恒久解消は保証しません。課金・権限・CPU上限は自動変更しません。
- 応答不明のmutation、残留journal/lock/実行は保持します。時間経過・HEAD不在・drainedだけを根拠に解除・削除しません。初期化・配備・activationの未知要求も再送しません。
- 素材・staging・運用記録の自動cleanupは追加しません。subscriber移行、定期RSS同期、無停止更新、万能復旧も対象外です。

## 既存Queue方式への変更

schema-version-1では、直接Queue commitを経て、署名済み`queue-management-v1`のstage-start／upload-complete／publishと認証付きR2結果読取を統合しました。
新しいstaging/publicationは検証済みQueue-management WorkerとQueues Editを必要とします。旧readinessをローカルだけで昇格せず、既存job/journalは自動変換しません。
配信判定の事前生成・parse削減も含みますが、SQLiteの性能値をこの方式の保証に流用しません。既存Queue方式の物理削除・独自ドメインは既存の安全条件付きで維持します。
詳しくは[Queue方式の操作・更新](https://github.com/simosako/castloop-v2/blob/v0.5.0/docs/queue_service.md)を参照してください。

## 検証・配布

Release準備の再検証は**1,420テスト合格／0失敗（151 files、94.65秒）**、TypeScript検証とLinux単体CLI buildが成功しました。
全35コマンドのhelp、版番号0.5.0、SQLite固有help、4種類の引数不足拒否も単体バイナリで確認しました。
再検証で見つかった「ランダムversion UUID中の`d1`をD1 endpointと誤認する」テスト判定をpath segment比較に修正し、回帰を追加しました。実API処理の変更ではありません。
CIでも全テスト・型・build、版番号、SHA-256、SQLiteを含むCLI smokeを確認してから公開します。
Release準備のためのCloudflare再配備・upload・既存資源変更は行いません。

配布対象はLinux x86-64の`castloop-linux-x64`、`SHA256SUMS`、`LICENSE`、`THIRD_PARTY_NOTICES.md`です。
macOS／Windowsは配布対象外です。操作は[README](https://github.com/simosako/castloop-v2/blob/v0.5.0/README.md)、
詳細は[SQLiteガイド](https://github.com/simosako/castloop-v2/blob/v0.5.0/docs/sqlite_sequential_development.md)を参照してください。
