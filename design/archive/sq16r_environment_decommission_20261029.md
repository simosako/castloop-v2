# 保持環境`sq16r-6ec01dc6`の廃棄（2026-10-29）

## 承認と経緯

管理者が2026-10-29に、保持環境`sq16r-6ec01dc6`の削除と、AGENTS.mdから当該保持の安全境界を削除することを明示的に指示した。

同環境は2026-10-17の旧試験環境一括廃棄（[削除記録](cloudflare_test_environment_cleanup_20261017.md)）において、最新の受け入れ・36件再試験を完了した環境として「直後の比較・再現用の第一候補」として唯一の保持を指定されたものである。その後のフェーズ1〜4の簡素化で現行コードは新規環境（内部形式`14/13`）専用となり、当環境（旧世代Worker・旧schema）の更新も採用もできなくなったため、管理者の判断で廃棄した。実データの原本とworkspaceコピーは`.local-test-data/`に残存する。

## 廃棄前の状態（読取専用棚卸し）

| 資源 | 身元 | 確認 |
| --- | --- | --- |
| Worker | `castloop-sq16r-6ec01dc6-f65ca2ec` | bindingsは自bucket・自namespaceのみ。Custom Domain 0件（account全体で0）、cron 0件 |
| R2 bucket | `castloop-sq16r-6ec01dc6` | 458 objects / 35,481,838 bytes。2026-10-17最終確認とbyte単位で同一。通知設定0件（404） |
| DO namespace | `ea16615b38a94698805758bf18bb0458` | `castloop-sq16r-6ec01dc6-f65ca2ec_SqlitePublicationService`。当該Workerのみが参照 |
| Queue/DLQ | 0件 | 2026-10-17以降のまま |

## 完全バックアップ（削除に先行）

v4 REST APIで全458オブジェクトを取得した。各オブジェクトについて、バイト長が一覧の`size`と、MD5が一覧の`etag`と一致することを検証し、SHA-256を付したmanifestを作成した。保存後は全458件をdiskから再読込してサイズ・SHA-256を再照合した（不一致0件）。内容アドレス保存のため実体は178内容 / 5,810,598 bytesで、残りは重複である。2026-10-17の退避（管理記録のみ）と異なり、音源・カバー画像・`system/`を含む完全な取得である。非公開原本は`.local-test-data/results/20261029/sq16r-decommission/`に保持し、Gitへは追加しない。

## 削除の手順

完全一致allowlist（上記3 DELETEのみ。query・`force`なし）、object鍵リストはbackup manifestとの厳密一致、要求前journal（`delete-journal.jsonl`）を採用した。順序は objects 458鍵の一括DELETE → bucket → Worker。応答は3件すべてacknowledged、結果不明・再送なし。

## 最終確認（読取専用）

| 項目 | 結果 |
| --- | --- |
| Worker settings GET | 404（不在） |
| Bucket GET | 404（不在） |
| DO namespace一覧 | 対象ID不在（Worker削除に伴い消滅） |
| 公開feed (`/podcasts/rss-8bdcc47f/feed.xml`) | 配信終了（失敗） |
| 保護環境 | `castloop-issue65sc11-f93cd6-*`（11/11予約公開の非公開検証環境）と`castloop-main-smoke-20261029-*`のWorker・bucket・namespaceが全数一致で存続 |

## 対象外・残る範囲

非テスト`otftalk.com` DNS、共有証明書、ローカル原本・workspace（`.local-test-data/workspaces/sqlite-retest-6ec01dc6`を含む）・私有証跡は変更・削除していない。DO SQLiteの内容はexportせず廃棄した。削除済み資源名の再利用は行わない。本廃棄の完了は他資源・他環境への追加変更の許可を与えない。
