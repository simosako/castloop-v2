# フェーズ2：直接アップロードと冪等な公開

- 更新日: 2026-10-28
- 状態: 実装済み・未配備。新規環境専用の内部queue/content形式13/13。旧形式は変換しない
- 基準commit: `794341f`（フェーズ1実装）
- 親文書: [全体設計の見直し](architecture_simplification_review_20261028.md)の改善案C
- 前提: [フェーズ1設計](phase1_atomic_publication_and_ondemand_delivery_plan.md)

## 1. 目的と責務

ローカルのTOMLと素材を編集したら、1コマンドで公開する。途中状態を記録して復旧するのではなく、同じ内容でやり直せる処理にする。

| 担当 | 責務 |
| --- | --- |
| 管理者CLI | ローカル入力の検証、素材の配置とPUT結果の確認、公開要求の送信 |
| Show DO | 認証、要求と公開条件の検証、公開内容・履歴の一括更新 |
| 配信処理 | 確定済みの公開内容と素材の配信 |

```text
CLI: TOML・素材を検証 → 素材をR2へ直接配置 → metadata・素材参照を送信
DO: 公開条件を検証 → 必要なcache purge → SQLiteで一括確定
```

deploy・Pause/Resumeの簡素化はフェーズ3で扱う。本フェーズでは既存の稼働制御を変更しない。

## 2. CLI

```sh
castloop preview-show daily --remote --json
castloop publish-show daily --expect-preview REVIEWED_HASH

castloop preview-episode first audio.mp3 --workspace . --show daily --remote --json
castloop publish-episode first audio.mp3 --workspace . --show daily --expect-preview REVIEWED_HASH

# Reuse the published audio for a metadata-only update.
castloop publish-episode first --workspace . --show daily
```

- `publish-show`はローカルShow TOML・CSS・カバーを使う。
- `publish-episode ID [MP3]`はローカルEpisode TOMLを使う。MP3指定時は音声も更新し、省略時は公開済み音声を使う。初回公開ではMP3を必須とする。
- TOMLを変えずにMP3だけ指定すれば、音声だけの更新になる。
- 素材に変更がない場合（説明だけの変更、公開済みと同じ画像・音声の指定）は、公開済み素材参照を再利用し、R2への通信を行わない。
- `preview-*`はローカル入力と公開済み内容の差分を表示する。承認hashは入力内容と確認した更新元に結び付ける。ローカル専用previewではremote未確認を明示する。
- `create-*`、`preview-*`、素材配置だけでは公開しない。未来の公開日時に対する既存の警告・即時公開確認は維持する。

`update-show`、`update-episode`、`update-episode-audio`は`publish-*`へ統合し、事前ステージングをなくす。

## 3. 素材の直接配置

物理R2キーはShowと素材のSHA-256から導出する。

```text
public/podcasts/<showId>/audio/<sha256>.mp3
public/podcasts/<showId>/covers/<sha256>.jpg|png
```

1. CLIで素材を検証し、サイズとSHA-256を得る。既存の送信元固定処理、MP3解析、音声300,000,000 bytes・画像5,000,000 bytesの上限を使う。
2. 検証した素材のSHA-256・サイズ（カバーは拡張子も）を、previewで確認した公開済み素材参照と比較する。一致すれば既存参照をそのまま公開要求に使い、R2への通信を行わない。説明だけの変更や同じ素材の再指定がこれに当たる。
3. 素材が変わる・初回公開のときだけPUTする。送信元を最後まで読み出したこと、HTTP `200`、JSONの`success: true`、応答のkey・sizeの一致を確認する。事前のLIST・HEADによる存在照合と、PUT後の本文再取得は行わない。
4. 確認できた素材の参照を公開要求に含める。エラーなら公開へ進まない。

素材配置の確認は管理者CLIで完了する。DOは公開時に素材のHEAD・本文読取を行わない。PUT後の全量ダウンロードとDOでのR2間コピーも廃止する。

PUT成功後に公開の確定前に失敗した場合は、同じキーへ同じ素材を再PUTしてやり直す。専用の追跡は行わない。PUT結果は[REST Upload Object](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/upload/)の成功応答で確認する。ETagをSHA-256として扱わず、保存内容の再ハッシュは行わない。

2026-10-28に保持中の`castloop-sq16r-6ec01dc6`で、管理REST APIのHEADを読取専用で実測した。同じBearer認証による一覧取得は200で成功し、存在を確認したキー1件と不存在を確認したキー1件への`HEAD /client/v4/accounts/{account_id}/r2/buckets/{bucket_name}/objects/{key}`は、どちらも405だった。PUTの成功確認はHTTPステータス・`success`・応答のkey・sizeで足り、事前の存在照合は公開の正しさに必要ない。このためLIST・HEADいずれの事前照合も行わない（PUT・削除・設定変更は行っていない。この結果はS3 APIやWorker bindingの`head()`には適用しない）。

## 4. 公開要求と確定

TOMLは既存schemaで読み、metadataをJSONとして直接送る。metadata自体はR2へ置かない。要求に含めるのは次の情報である。

- 対象Show／Episodeとmetadata
- 素材のハッシュ・サイズ、カバー拡張子または音声duration
- 確認した更新元のrevision・世代と、既存のservice/runtime/config/window情報

MP3省略時や素材に変更がない場合も、CLIが確認した公開済み素材の具体的な参照を送る。送信内容には既存の入力固定処理を使う。JSON本文の読取サイズ制限は、直接渡すmetadataを収容できるよう調整する。

### 同じ内容は変更しない

サーバーはmetadata・素材参照・公開状態を現在値と比較する。生成日時やrevision IDは内容の比較に含めない。

| 条件 | 結果 |
| --- | --- |
| 現在値が要求と同じ | `unchanged`と現在のrevision IDを返す。履歴・世代を増やさず、パージもしない |
| 内容が異なり、更新元が一致 | 公開を進める |
| 内容が異なり、更新元が不一致 | 409。最新内容を確認してやり直す |

応答を受け取れなかった場合も、利用者は同じ内容で再実行できる。`--expect-preview`指定時も、入力がすでに公開内容と一致していれば変更なしで返せる。CLIが自動的に更新元を取り直して再送することはしない。

### DOの処理

1. 既存の認証・schema・対象・実行環境の確認を行い、同じ公開内容なら変更なしを返す。
2. 更新が必要なら、既存の受付・保守状態、更新元、metadata・GUID・描画容量を検証する。
3. フェーズ1と同じ必要なcache purgeを完了する。
4. 単一の`transactionSync()`で公開内容・履歴・素材参照・短縮ID・Feed世代を一括更新する。
5. `200`と`changed`または`unchanged`、現在のrevision IDを返す。

パージ待機中に別の公開やPauseが進み得るため、transaction内で更新元・稼働状態・描画対象の世代を再確認する。revision IDは実際に変更するときだけサーバーで発行する。

確定前に失敗した場合は公開内容を変えない。未参照の素材が残っても、公開済み内容には影響しない。

## 5. 既存機能との接続

### 配信・履歴

外向けのFeed、固定cover URL、Episode音源URL、サイト短縮URLは変えない。公開済みrevisionと素材表のハッシュから物理R2キーを導出し、既存の配信処理へ渡す。キャッシュの世代管理、認証、非公開化・停止、HEAD/Range/条件付き応答は維持する。

旧音源・履歴、GUID・公開日時を保持する。過去版採用・非公開化・復元も、指定した内容と公開状態が現在値と同じなら変更しない。

### 予約公開

予約もステージングを経由せず、CLIで素材を配置し、metadata・素材参照・更新元・予定日時を既存の予約表へ保存する。予約ID、対象ごとに未実行予約は1件という制約、日時変更・取消・再承認は既存方式を使う。作成応答が不明なら既存の予約一覧で確認する。

到来時には保存した内容で通常の公開処理を行い、公開内容と予約の実行済み状態を同じtransactionで確定する。job台帳への依存を外し、Alarm再配送による重複更新を防ぐ。

### RSS一括公開・診断・バックアップ

RSS runnerはShow→各Episodeの順に新しい公開処理を呼ぶ。完了済みの同じ内容は変更なしになる。取得・変換・新Show登録と一括作業の進捗記録は既存処理を使い、個別のupload・job追跡を外す。

診断は公開内容・稼働状態・配信を確認する形へ接続する。バックアップは既存の素材・記録を引き続き保全する。

## 6. 削除対象と実装順序

| 削除対象 | 変更後 |
| --- | --- |
| `operations`系5テーブルと操作RPC | 素材配置と同期公開を直接行う |
| `publication_jobs`、公開要求のjob/request ID、状態照会・待機 | 公開内容と同期応答を使う |
| draft・upload・publication・content操作のローカルjournalと専用lock | ローカル入力と公開済み内容を使う |
| `update-*`、`operation-*`、`job-status`、`progress`、`watch` | preview・公開済み内容・履歴・予約の取得へ整理する |
| 素材PUT前のList Objects存在照合 | 公開済み素材参照との内容比較とPUT応答確認に置き換える |
| CLIの全量readback、DOの素材コピー、metadata PUT | 素材の直接配置とmetadata送信に置き換える |

init・Show登録・deploy・domainなど、今回の公開処理以外の記録は変更しない。既存のローカル記録は削除しない。旧形式の変換は本フェーズの対象外である。

実装は次の順に行う。

1. 共有要求型・素材キー解決・現在値との比較を変更する。
2. CLIの直接配置とDOの同期公開を接続し、コピー・操作表・job台帳を削除する。
3. preview・予約・RSS・診断・バックアップから旧処理への依存を外す。
4. 利用ガイド・help・埋込Skillを更新する。

初回公開、metadata／音声の更新、素材を変えない更新のPUT省略、同じ内容の再実行、確定前失敗後の同じキーへの再PUT、更新競合、purge・DB失敗、予約の実行・Alarm再配送、旧音源・履歴の配信を確認する。`bun test`、`npm run check`、既存CLI buildで検証する。

## 7. 実装状況

- 通常公開・配信・履歴・lifecycle・予約・RSS・診断を新経路へ切り替えた。CLIはローカル素材の直接配置とmetadata送信、DOは公開条件・パージ・SQLite確定だけを担当する。
- 素材配置を「変わったときだけ」に改めた。CLIは検証した素材参照を公開済み参照と比較し、一致すればR2へ通信せず既存参照を使う。変わったとき・初回だけPUTし、PUT前のList Objects存在照合は削除した。PUT成功後に確定前に失敗した再実行は、同じキーへ同じ素材を再PUTする。
- 操作追跡5表・job台帳・個別公開journal/lockと旧コマンドを削除した。旧ローカル記録は削除せず、バックアップ対象に保持する。過去の実機ログ読取用schemaは開発用`scripts/test-support/legacy-sqlite-*.ts`へ隔離し、製品の要求schema・RPCから外した。
- help・利用ガイド・管理者Skillを更新した。init・Show登録・deploy・domain・制御操作のjournalと復帰契約は維持する。
- ローカル試験で初回／metadata／音声更新、同一内容の再実行、競合・Pause中断、purge/DB失敗、予約の原子的確定と再配送、RSS再開、旧音源・履歴・配信条件を確認した。実Cloudflareの性能・配備・実素材での受け入れは未確認。
- 検証結果: `bun test` 625件成功・失敗0、`npm run check`、Linux x64 CLI build、空PATH・ソース不在での単体CLI smoke試験が成功。素材を変えない更新のPUT省略と確定前失敗後の同じキーへの再PUTも試験で確認した。DOへの素材確認・コピーの再追加、個別公開journal/lock、互換経路、新規依存がないことも差分で確認した。
