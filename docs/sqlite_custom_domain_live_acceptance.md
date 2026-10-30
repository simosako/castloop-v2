# SQLite独自ドメインの実機確認

> **旧版の履歴。** 本書は2026-10-24のIssue #68（内部形式6/7）の試験記録・手順であり、Pause/Resume廃止後のv0.8.0（14/13）には適用しない。現行操作は[独自ドメインガイド](sqlite_custom_domains.md)を参照する。以下の試験結果や過去の承認は、新しい実環境操作の許可でも現行版の実機検証結果でもない。

Issue #68向け。2026-10-24、別途承認された[第9環境の2 Show総合機能試験](../design/archive/sqlite_custom_domain_two_show_verification_20261024.md)で、以下の通常機能範囲を確認した。公開/独自origin配信/redirect/更新/復元/通常deploy/切断復帰・履歴保持が成功し、両Show paused/ready/drainedで終了。故障注入・内部cache状態・性能/全Free適合等は未実証で、詳細は同記録を参照する。

再試験は実装・ローカル試験・commitだけを実行許可にせず、対象account・新規Worker/bucket・専用hostname・許可する接続/配備/公開/Resume/切断の範囲を別途承認してから使う。保持サービス、非テストDNS、共有証明書、原本/journal/私有証跡は変更しない。

[第3試験](../design/archive/sqlite_custom_domain_environment_review.md)はPUTのenvironment固定検証で停止した。その後の別承認による[ログ付き反復試験](../design/archive/sqlite_custom_domain_iterative_verification_20261024.md)で元PUT空文字と元DELETE空本文を特定・修正し、第8環境では**Show 0件の接続・限定続行・切断・workers.dev設定復帰が完了**した。Show 0件の診断と今回の2 Show確認を区別し、旧unknown/残存lockは保持する。

第9環境の結果は先行試行のunknownを成功へ変更するものではない。以前の8環境と停止/完了記録は保持し、今回の新しい成功記録と区別する。

1. 対応commit・配布CLI hash・新規fresh環境・空きsubdomainとactive/full Zoneを固定する。既存DNS/routes/接続を上書きしない。CLIの権限確認・準備は[利用ガイド](sqlite_custom_domains.md)に従う。
2. 2 Showを作り、承認済み短尺音源を公開する。別の非公開Episodeも作り、Feed/cover/audioのGET/HEAD/Range/ETag、GUID/日時/media hash/履歴を基準として保存する。staging・内部世代URLは404を確認する。
3. 各ShowをPause/drainし、cold/warm cache・条件付き要求でも両originの配信が停止することを確認する。専用UUIDでdomain addを1回だけ実行し、接続成功receipt・TLS待ち・配備receipt/native確認・全対象Feed/purge/probe・paused完了を区別する。
4. domain list/statusのconfig・接続一致と全対象完了を確認後、Showを個別Resumeする。旧workers.devのFeed 301/cover・audio 307、Locationが同じパスの独自domainであること、正規domainのGET/HEAD/Range/ETagを確認する。管理APIはworkers.devのみ、独自domainでは認証情報なしでもありでも404とする。秘密を公開domainへ送る試験は実管理鍵を使わず無効なダミー値で行う。
5. 新configでShow/Episodeの通常更新・非公開化/復元を確認し、旧不変音源、GUID/日時/revision履歴を保持する。個別Pauseを再確認し、同configの通常deployがdomain接続を変更しないことを照合する。配備後のnative待ちは再配備で回避しない。
6. 301を保存したクライアントの購読先は自動復帰しないことを確認してから、別承認された切断を1回だけ行う。Feed/設定のworkers.dev復帰が切断より先であること、成功DELETE receipt、証明書非削除、paused完了を確認する。明示Resume後のworkers.dev本文と旧独自originの配信拒否を確認する。
7. 最終状態は全Show paused/ready/drainedを確認する。資源・証跡のcleanupはこの確認案に含めず別承認とする。生HTTP・鍵・未公開ID・本文をGitへ入れず、選別した結果と欠測・未試験範囲を記録する。

異常時は後続mutationを止める。要求を再送せず、元workspace・journal・receiptと固定診断を保存してstatusを読む。時間経過、接続/DNS不在、空queueを未知IOの終了証明にしない。TLS検証の無効化、OS DNS変更、別ツールとの並行変更による回避は行わない。

ネイティブの故障注入、purge retry、300MB、負荷/CPU、全Free適合はこの小規模確認だけで証明しない。旧Queueの実機合格実績をSQLiteの証拠に流用しない。
