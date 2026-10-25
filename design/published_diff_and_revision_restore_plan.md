# Issue #64: 公開済み内容との差分確認とrevision履歴・過去版採用の設計案

作成日: 2026-10-25。

**ステータス: 管理者レビューにより推奨案（1A・2A・3A・4A・5A）をすべて採用済み。** 本書は [Issue #64](https://github.com/simosako/castloop-v2/issues/64) の設計と採用仕様をまとめた文書である。コード実装およびローカル試験の承認は、実Cloudflare環境での配備・公開・再開や資源変更を許可するものではない。

- 対象: [Issue #64: 公開済み内容との差分確認とrevision履歴・復元対象の選択を提供する](https://github.com/simosako/castloop-v2/issues/64)
- 調査基準コミット: `116d8b5`（パッケージ版数 `0.7.3`、公開待ち行列の表の形式番号 `7`・公開コンテンツの表の形式番号 `7`）

---

## 1. 結論：このIssueを実装する価値があるか

**結論：実装する価値が高い。** 理由は大きく次の2点にある。

### 1.1 公開前の「意図しない変更」を防ぐため（公開済み内容との差分確認）

調査基準コミットの `preview-show` と `preview-episode` は、手元の設定ファイル（TOML）とアップロード済み素材（staged）の整合をオフラインで検査するだけであり、サーバー上で現在公開されている内容は取得しない（`published.status = "not_checked"`）。以下の現状・課題は、この実装前の状態を指す。

そのため、実際の運用では次の問題が残っている。

1. **どの項目が変わるのかを公開前に確認できない**: 説明文の誤字だけを直したつもりでも、タイトルや `explicit`（露骨な表現の有無）など別の項目まで変わっていないかを CLI のプレビュー結果から判断できない。
2. **素材の再利用と差し替えを公開済み状態と比較できない**: Episode の音源（MP3）や Show のカバー画像について、現在公開中の素材と同じものが維持されるのか、新しいファイルに差し替わるのかをサーバー側の正本と照合していない。
3. **手元の原本を失ったときに正確な編集元を取り出せない**: `list-shows` や `list-episodes` が返す一覧はタイトルを最大200文字に切り詰めた要約であり、公開 RSS フィードも管理用メタデータの全項目を保持していない（また、配信停止中や非公開時は取得できない）。認証された管理 API から公開済みの全文を取得できる仕組みが必要である。

### 1.2 既に保存している「不変の履歴・音源」を実際の復旧手段として使えるようにするため

castloop は設計当初から「一度公開した音源やカバー画像、Episode の改訂履歴（revision）は通常の更新で上書き・削除しない」という原則を守り、R2（ファイル保存先）と Durable Object（DO：Show ごとの状態と SQLite データベースを管理するサーバー部品）に過去のデータを保持している。

しかし現状では、**保持している過去版の一覧を見る手段も、過去版を選んで元の内容へ戻す手段も提供されていない**。

- 既存の `preview-episode-lifecycle ... restore` は、「非公開（`unpublished`）にした Episode を、直前の保存状態で再び公開（`published`）に戻す」機能であり、**誤った内容で上書き公開してしまった Episode や Show を「1つ前の版」へ戻すことはできない**。
- この状態で過去の音源へ戻すには、管理者が手元のバックアップから過去の TOML と MP3（最大300MB）を探し出し、改めてアップロード・公開し直す必要がある。同じ音声を別名で重複保存する容量と手間が生じる。手作業で `guid` や `published_at` を変えた場合は既存の識別子検査でも拒否されるが、専用操作なら最初から正確な保存済み内容を選択できる。

したがって、**「公開済み内容との項目別差分表示」**と**「revision 履歴の閲覧・過去版の安全な再採用（ロールバック）」**を実装することで、公開前の確認から誤更新時の復旧までが一貫して安全に行えるようになる。

### 1.3 今回作るもの・作らないもの

| 今回作るもの | 今回作らないもの |
| --- | --- |
| 認証された管理 API による、Show / Episode の現在の公開済み全文・素材識別情報の取得 | アップロードしただけの未公開素材（staged）や非公開 Episode を、認証なしの公開 URL でプレビュー配信する機能 |
| `preview-show` / `preview-episode` における、公開中・手元（local）・アップロード済み（staged）の項目別差分と素材再利用の表示 | 一覧 API（`catalog`）の短縮タイトルや公開 RSS から編集用 TOML を推測生成する機能 |
| `--expect-preview` における、確認した公開ベース状態（バージョン・revision）の束縛と競合拒否 | 既存の識別子維持ルール（Episode の `guid`・`published_at` 変更禁止）を緩和して別物に書き換える機能 |
| Show / Episode の revision 履歴一覧・詳細の取得（読取専用） | 過去の履歴や不変音源・カバー画像を物理削除する機能 |
| 指定した過去 revision の復元プレビューと、明示承認による過去版の採用（既存の不変音源・カバー画像を再アップロードなしで再利用） | 異常停止（`blocked`）した公開処理の強制解除や、既存環境のデータベース自動移行 |

---

## 2. 本書で使う言葉

| 言葉 | この設計での意味 |
| --- | --- |
| メタデータ（metadata） | Show（番組）または Episode（各回）のタイトル、説明文、カテゴリ、公開日時などの文字情報。手元では TOML ファイルで編集する |
| 素材（asset） | Show のカバー画像（JPEG/PNG）と、Episode の音声ファイル（MP3） |
| 公開識別情報（Episode identity） | Podcast アプリが同じエピソードだと判定するために使う4項目（`episode_id`、`guid`、`guid_is_permalink`、`published_at`）。通常の更新や過去版の採用で変えてはならない |
| 改訂版（revision） | Show または Episode の公開処理が1回完了するたびに確定する、その時点のメタデータと素材の組み合わせ |
| 更新元の版（base） | 新しい編集やアップロードを始めた時点で、サーバー上で最新だった公開版の識別番号（Show の状態番号 `state_version`、Episode の改訂版 ID `revision_id` と公開・非公開の切り替え番号 `lifecycle_version`） |
| 手元の入力（local） | 管理者の作業ディレクトリにある `show.toml`、`episode-<id>.toml`、画像、MP3 ファイル |
| アップロード済み（staged） | `update-show`、`update-episode`、`update-episode-audio` によって R2 の一時領域（`staging/`）へアップロードし、ハッシュ値やサイズの検証を済ませて下書きに登録した状態。まだ公開はされていない |
| 確認ハッシュ（`input_fingerprint`） | `preview-show` / `preview-episode` が計算する SHA-256 ハッシュ値。確認した手元の内容・アップロード済み素材・サーバーの更新元の版を束ねた値であり、`publish-* --expect-preview HASH` に渡すことで「確認した後に内容やサーバー状態が変わっていないこと」を保証する |
| 公開待ち行列（Show FIFO） | 各 Show の Durable Object 内で、受け付けた公開依頼を1件ずつ順番（先入れ先出し：FIFO）に実行する仕組み |
| 非公開化からの復帰（既存の `restore`） | `unpublish` で非公開にした Show / Episode を、直前に保存されていた最新スナップショットのまま公開状態へ戻す既存のライフサイクル操作 |
| 過去版の採用（今回の revision 採用 / ロールバック） | 過去に公開された任意の revision を選び、その時点のメタデータとサーバー上の保存済み素材（不変音源・不変カバー画像）を使って、新しい公開版として現在の公開内容を戻す操作。過去の履歴自体は消さずに残す |

---

## 3. 現状の実装と課題の整理

調査基準コミットの関連ファイルを調査した結果は以下のとおりである。

| 箇所 | 現在の実装 | Issue #64 に対する不足点 |
| --- | --- | --- |
| `packages/cli/src/draft-preview.ts` | 手元の TOML と下書き記録（`.castloop/sqlite-drafts/`）だけを読み、`published: { status: "not_checked", metadata: null }` を返す | サーバーの公開済み全文を取得しないため、どの項目が変わったか、音源・画像が公開中と同じかを表示できない |
| `packages/cli/src/sqlite-draft.ts`、`sqlite-draft-journal.ts` | Episode 下書きには `base_revision_id` と `base_metadata_sha256` を保存するが、Show 下書きには `expected_show_state_version` しか保存していない | Show 下書きでは更新元のメタデータ・カバー画像のハッシュを保持していない。また、`--expect-preview` がリモートで確認した公開ベースの状態まで束縛していない |
| `src/sqlite-service-runtime.ts`（`inspect`） | `GET /admin/sqlite-service/targets/<showId>[/<episodeId>]` で状態・バージョン番号・Episode の `base_metadata_sha256` だけを返す | Show / Episode の公開済みメタデータ全文、カバー画像のハッシュ・世代、Episode 音源のハッシュ・尺・サイズを返さない |
| `src/sqlite-publication-content.ts`、`src/sqlite-publication-executor.ts` | Episode 公開時は R2 の `public/episodes/<showId>/<episodeId>/revisions/<revisionId>.toml` と `publication_media` 表に履歴を残すが、SQLite の `publication_episode_content` は最新1件のみを上書きする。Show はカバー画像を世代別保存するが、`publication_show_content` と R2 の `show.toml` は最新1件のみを上書きする | SQLite 側に確定順の revision 履歴表がないため、R2 を列挙せずに過去版の一覧や詳細を取得することができない。また Show には過去版のメタデータ履歴自体が残っていない |
| `packages/cli/src/sqlite-lifecycle.ts` | `unpublish` と `restore`（非公開からの再公開）の計画作成・実行のみを行う | 任意の過去 revision を指定して内容・素材を戻すプレビューや実行経路がない |

---

## 4. 実装案の比較と推奨案

実装にあたり、設計上の選択肢がある5つの論点についてメリット・デメリットを比較し、推奨案を示す。

### 4.1 論点1：revision履歴と過去版採用の対象範囲・保存先

公開済み内容との差分表示は Show と Episode の両方を対象とする。そのうえで、**「過去の revision 履歴の保存・閲覧・過去版の採用（ロールバック）」をどこに保存し、Show も対象に含めるか**を比較する。

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **案1A（採用）：Show・Episode 両方の履歴をShow DOのSQLiteで管理する** | 履歴2表とR2の不変metadata snapshotを追加し、保存済みの画像・音源を参照する | 両方の誤更新を、素材の再アップロードなしで戻せる。SQLite内で現在版と履歴を同時に確定できる | 履歴ごとに全文JSONと索引が増える。容量は本文次第で、下記の測定例では約0.9〜41KB/件。内部content形式更新と新規環境が必要 |
| **案1B：差分表示は Show / Episode 両方に行い、revision 履歴と過去版採用は Episode のみとする** | Episode だけ SQLite に `publication_episode_revisions` 表を追加し、Show は現在版の保存のみとする | Show 側の履歴テーブルや Show 用の過去版採用コマンドを作らずに済む | 番組説明文やカバー画像を誤って更新した際に過去版へ戻す手段がなく、Issue #64 の「番組画像変更の前に確認し、必要に応じて過去版を確認・選択できるようにする」という目的に対して片手落ちになる |
| **案1C：SQLite には履歴表を持たず、R2 の `revisions/` プレフィックス列挙（`list`）と個別読取で履歴を扱う** | 既存の R2 オブジェクトを列挙して履歴一覧を作る | SQLite のテーブル追加が最小限で済む | R2 のキー（UUID）順は公開順ではないため、順序付けや一覧表示のたびに多数の R2 GET が発生する。また「R2 をインデックス DB として使わず、SQLite を正本とする」という本リポジトリの基本設計に反する |

**採用：案1A。**
既存の設計（Issue #50 第3段階）でShowのカバー画像は既に世代別の不変オブジェクトとしてR2に保持されている。Showのメタデータ履歴もSQLiteとR2に残し、Episodeと同様に保存済み素材を再利用する。

#### SQLite の revision 履歴行のサイズ試算（レビュー確認事項）

**履歴には ID・ハッシュだけでなく、メタデータ全文の JSON を保存する。** そのため、固定長の数百バイトではなく、説明文の長さ・UTF-8 のバイト数・JSON のエスケープ量によって大きさが変わる。音源・画像の本体は含めない。

`bun scripts/measure-revision-storage.ts` で、実装の履歴2表と索引をローカル Bun SQLite のメモリーDBに作り、種類ごとに1,000行を追加した。タイトルは30文字、その他の項目は同スクリプトの合成データを使う。実利用の「通常値」を測ったものではない。

| 合成入力 | Show の文字列値の合計 / 行 | Show のDB増分 / 行 | Episode の文字列値の合計 / 行 | Episode のDB増分 / 行 |
| --- | --- | --- | --- | --- |
| ASCII タイトル30文字・説明200文字 | 688 bytes | 約938 bytes | 871 bytes | 約1,163 bytes |
| 日本語タイトル30文字・説明200文字 | 1,148 bytes | 約1,487 bytes | 1,331 bytes | 約1,507 bytes |
| 日本語タイトル30文字・説明400文字 | 1,748 bytes | 約2,171 bytes | 1,931 bytes | 約2,183 bytes |
| 日本語タイトル30文字・絵文字の説明10,000文字 | 対象外 | 対象外 | 40,731 bytes | 約41,103 bytes |

文字列値の合計は JSON、UUID、ハッシュ、時刻などのUTF-8 bytesの合計であり、整数列・SQLiteの行ヘッダー・索引・ページ余白は含まない。DB増分は、空テーブル作成後から1,000行追加後までの `page_count × page_size` の差を1,000で割った値で、索引とページ余白を含む。UUIDの値やSQLite版によって小さな変動がある。Cloudflareの実ストレージ計量・課金量ではない。

**結論：ASCII説明200文字の例は約0.9〜1.2KB、日本語400文字の例は約2.2KBとなる。** 初稿の「数KB以下」は固定値・上限として不正確だった。10,000文字の絵文字だけでも約40KBになり、HTMLタグ除外後の項目別上限は保存JSONの上限ではないため、さらに大きくなる場合もある。保存済み履歴には新規入力上限を追加しない。

日本語400文字の例で1,000改訂なら履歴表の増分は約2.2MB。ただし、これとは別に最新内容・job・操作記録などが既存DBに保存され、R2の不変snapshotも増える。既存のDB全体の容量表示と50/70/85%警告を使い、自動削除や無料枠適合の保証は追加しない。

---

### 4.2 論点2：公開済み全文と revision 履歴を取得する管理 API の構成

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **案2A（採用）：既存の軽量な `targets/` API は維持し、Show DO に公開内容・履歴取得用の専用管理エンドポイントを追加する** | 状態・バージョン確認用の `targets/` とは別に、全文・素材情報取得用の `content/` と履歴取得用の `revisions/` を Show DO の管理 API に追加する | 通常の `create-episode` や `update-*` が使う軽量な `targets/`（上限16KiB）を肥大化させない。必要なときだけ認証付き経路で全文（最大10,000文字の説明文など）を安全に取得できる。Show が `paused` や `unpublished` でも管理者が内容を確認できる | 管理 API のルートと共有スキーマが増える |
| **案2B：既存の `GET /admin/sqlite-service/targets/<showId>[/<episodeId>]` に常に公開済み全文を含める** | `SqliteInspection` スキーマに公開済みメタデータ全文と素材情報を常時載せる | API ルートを増やさずに済む | 全文が不要な箇所（単なるバージョン確認や登録確認）でも毎回大きな JSON を送受信することになり、既存の16KiB応答制限の引き上げが全箇所に波及する |
| **案2C：公開 RSS フィードや `list-shows` / `list-episodes` の結果から公開済み内容を取得する** | Worker の管理 API を増やさず、公開 URL の RSS 等を読む | サーバー側の実装変更が少ない | Issue #64 の安全条件「catalog の短縮タイトルや公開 RSS を、完全な metadata／編集元として推測採用しない」に違反する。停止中・非公開の対象も読めない |

**採用：案2A。**

---

### 4.3 論点3：`preview-show` / `preview-episode` の通信動作と `--expect-preview` の束縛範囲

`preview-show` / `preview-episode` を実行したときに、いつサーバーへ公開済み内容を取りに行くか、また確認ハッシュ（`input_fingerprint`）にどこまで含めるかを比較する。

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **案3A（採用）：管理鍵がある workspace では既定でリモート照会を行い、`--local` 指定時（または未初期化のローカル環境）は `not_checked` とする。リモート確認時は公開ベースの状態も `input_fingerprint` に束縛する** | 通常の運用では引数追加なしで公開済み内容との差分が表示される。オフライン確認は `--local` で明示でき、未初期化ディレクトリの単体スモーク試験とも両立する。リモート取得失敗時は勝手に `not_checked` へ落とさずエラー終了する | 管理者が特別なフラグを意識しなくても「現在の公開内容との差分」を確認できる。オフライン試験は `--local`、または `.castloop/` 未作成時の自動ローカル確認で維持できる | モードごとの動作とエラー条件を明確に定義する必要がある |
| **案3B：既定は従来どおりオフライン（`not_checked`）とし、`--remote` を付けたときだけ公開済み内容を取得する** | 既存のオフライン動作を既定のまま変えない | 既存テストの前提が全く変わらない | `--remote` を付け忘れると公開済み内容との差分が表示されず、Issue #64 の目的（公開前に何が変わるか確認する）が標準手順で機能しない |
| **案3C：`preview-show` / `preview-episode` を常にリモート通信必須とし、オフラインでの実行を廃止する** | 常に管理鍵とサーバー通信を要求する | モード分岐がない | サーバー初期化前のローカル確認や、空 PATH・通信なし環境での CLI 単体スモーク試験（`scripts/smoke-agent-cli.mjs`）が実行できなくなる |

**採用：案3A。**
具体的には次の規則とする。

1. **`--local` を指定した場合**: 通信を一切行わず、`published.status` と `changes.status` は `"not_checked"`、項目別差分は `null` とする（「差分なし」とは表示しない）。
2. **`--remote` を指定した場合**: 必ずサーバーへ公開済み内容を照会する。管理鍵がない場合や通信・認証に失敗した場合はエラー（終了コード1）とし、黙って `not_checked` にフォールバックしない。
3. **どちらも指定しない既定動作**:
   - `.castloop/` が存在する workspace では、`--remote` と同じく管理鍵とサーバー照会を要求する。鍵の欠落・破損や通信失敗はエラーとし、自動的にオフラインへ切り替えない。通信不要の確認は `--local` で明示する。
   - まだ `.castloop/` が存在しないローカルのみのディレクトリでは、ファイルを書き込まずオフラインで検査し、`published.status = "not_checked"` を返す。
4. **`--expect-preview` の照合**:
   - リモート確認を行った `preview-*` の `input_fingerprint` には、手元の入力・アップロード済み素材に加えて、**確認時点のサーバー側の公開ベース識別情報（`state_version`、`revision_id`、`lifecycle_version`、公開済みメタデータと素材の SHA-256）**を含める。
   - `publish-show` / `publish-episode` で `--expect-preview HASH` が指定された場合、公開要求を凍結する直前にサーバーの現在状態とも照合し、preview 後に別クライアントが公開を進めていた場合や素材・メタデータが変わっていた場合は `preview_changed` エラーで拒否する。

---

### 4.4 論点4：過去の revision を採用（ロールバック）する操作方式

誤って公開した内容を過去の revision へ戻したい場合の操作方式を比較する。

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **案4A（採用）：サーバー上の保持済み revision と不変素材（MP3・カバー画像）を直接参照する「過去版採用」を、`preview` → 明示承認（`execute`）の専用公開操作として Show FIFO で実行する** | 過去 revision のメタデータと、R2 上に残っている検証済みの不変音源（`audio_revision_id`）・不変カバー画像（`cover_generation`）をサーバー側でそのまま使って新しい公開版を作る。成功時は手元の TOML も安全に同期できるようにする | **最大300MBの MP3 やカバー画像を再アップロードする必要がない**。手元に過去の MP3 が残っていなくてもサーバー上の不変資産だけで確実にロールバックできる。GUID や公開日時を誤って書き換える余地がなく、既存の履歴も消えずに新しい改訂版として追加される | `SqlitePublicationRequest` と公開 executor に「保存済み revision の採用（`restore_revision`）」の検証・コミット処理を追加する必要がある |
| **案4B：過去 revision のメタデータを手元の TOML に書き出すだけとし、公開は通常の `update-*` → `publish-*` をやり直させる** | サーバーから過去版の TOML を取得してローカルファイルを上書きするコマンドだけを提供する | Worker の公開ジョブ処理（executor）を変更せずに済む | **音源やカバー画像を過去版に戻したい場合、手元に過去のファイルがなければ戻せない**。手元にあったとしても、最大300MBの MP3 を再度アップロードして R2 に重複保存することになる。書き出し後に手元で誤編集して公開してしまうリスクも残る |

**採用：案4A。**
castloop が R2 と SQLite に過去の不変音源・世代別カバー画像・revision を消さずに保持している最大の理由は、こうしたロールバック時に再アップロードなしで安全・確実に過去の状態を復元できるようにするためである。

---

### 4.5 論点5：生成予定 RSS・画像確認・音源試聴の提供方法

Issue #64 の「生成予定RSS、画像確認・音源試聴はlocalまたは認証された経路で提供する」「非公開Episode、staging、管理metadataをpreviewのためにpublic公開しない」に対する方式を比較する。

| 案 | 内容 | メリット | デメリット |
| --- | --- | --- | --- |
| **案5A（採用）：RSS生成・差分計算はCLI内、素材確認は手元のファイルで行う** | 任意の`--rss-output FILE`で、認証付きの全公開Episode取得と同じrendererによるXML生成・容量検査を行う。一時公開URLは作らない | Worker側に仮RSS生成・素材試聴配信を追加せず、CPU負荷を増やす処理をCLI側に置ける | 全文取得や認証・SQLにはサーバーCPUを使う。無料枠適合は未実証。非公開の過去素材の取得・試聴は提供しない |
| **案5B：ステージング中の素材やプレビュー用 RSS に対して、Worker 上で署名付き一時公開 URL を発行する** | ブラウザや外部プレーヤーから一時 URL でステージング音源や仮 RSS を開けるようにする | サーバー上のデータを直接ストリーミング試聴できる | 「非公開 Episode、staging、管理 metadata を preview のために public 公開しない」という安全条件に抵触しやすいほか、**Worker 側での仮 RSS 生成や署名検証・配信処理が加わることで Cloudflare 無料枠の Worker CPU 利用時間上限を超えるリスクがある** |

**採用：案5A。**

---

## 5. 推奨案における具体的な機能仕様

### 5.1 公開済み内容との項目別差分表示（`preview-show` / `preview-episode`）

`preview-show ID` および `preview-episode ID` の出力（人間向け表示および `--json` の `result`）を次のように拡張する。

1. **公開済み状態（`published`）の表示**:
   - `status`:
      - `"not_checked"`: オフライン確認（`--local` または `.castloop/` 未作成時）。`changes.status` も `"not_checked"`、項目別差分は `null` とし、**決して「差分なし（`unchanged`）」とは表示しない**。
     - `"unpublished_initial"`: サーバー照会の結果、まだ一度も公開されていない新規 Show（`draft`）または新規 Episode（`missing`）。
     - `"checked"`: サーバー照会の結果、公開中（`published`）または非公開保存中（`unpublished`）のスナップショットを取得済み。
   - 取得済みの場合に含まれる情報:
     - Show: `lifecycle`、`state_version`、`feed_generation`、`revision_id`（直近の公開 job ID）、`updated_at`、`metadata`（全文）、`metadata_sha256`、`cover`（`extension`、`generation`、`sha256`、`length_bytes`、`public_url`）。
     - Episode: `lifecycle`、`lifecycle_version`、`revision_id`、`revision_sequence`、`updated_at`、`metadata`（`EpisodeDraft` 相当の全文）、`metadata_sha256`、`audio`（`audio_revision_id`、`sha256`、`length_bytes`、`duration_seconds`、`enclosure_url`）。
2. **3つの層（`published` / `local` / `staged`）の区別**:
   - `local`: 手元の TOML 全文・ハッシュ値と、手元の画像・音声ファイルのハッシュ値・サイズ。
   - `staged`: 現在下書き（`sqlite-drafts`）にアップロード・検証済みとして登録されている素材のハッシュ値・サイズ・尺（`duration_seconds`）と、手元のファイルと一致しているか（`inputs_match_staged`）。未アップロードの編集がある場合は `uncommitted_local_edits: true` を明示する。
   - `published`: サーバー上の現在の正本。
3. **項目別差分（`changes`）の表示**:
   - **メタデータ項目別差分（`metadata_fields`）**:
      - Show: `title`, `description`, `language`, `author`, `owner_name`, `owner_email`, `categories`, `explicit`, `site_url`, `image_path`, `copyright`, `show_type` の各項目について、`changed: boolean`、`published`（変更前）、`candidate`（変更後）を表示する。
      - Episode: `episode_id`, `title`, `description`, `published_at`, `guid`, `guid_is_permalink`, `explicit`, `episode_type`, `season_number`, `episode_number` の各項目について同様に表示する。
      - `metadata_fields` は実際の公開候補を比較する。stage 済みメタデータが手元とハッシュ一致する場合はその全文を使い、音源だけの更新は現在の保存済み全文を使う。stage 済み本文を確認できない場合は `null` とし、手元から推測しない。手元の編集内容との差分は別の `local_fields` に表示する。
   - **公開識別情報（`identity`）の検査**:
     - Episode 更新時、`episode_id`・`guid`・`guid_is_permalink`・`published_at` が公開済み版と一致しているかを `identity_status: "preserved" | "changed_invalid" | "initial" | "not_checked"` として明示する。不一致（`"changed_invalid"`）の場合は `publishable: false` とし、公開前に拒否されることを警告する。
     - Show 更新時、カバー画像の拡張子（`.jpg` / `.png`）が公開済み版と一致しているかも同様に検査し、拡張子変更があれば拒否理由として表示する。
   - **素材の再利用・差し替え（`cover` / `audio`）**:
     - Episode 音源:
       - 音源を stage していない更新（metadata-only 更新）の場合：`mode: "reuse_published"` とし、再利用される公開済み音源の `audio_revision_id`、`sha256`、`length_bytes`、`duration_seconds`、`enclosure_url` を明示する。
       - 音源を stage している場合：公開済み音源と `sha256`・`length_bytes` を比較し、`mode: "replace_audio"`（同じ音源ファイルを再アップロードしている場合は `"replace_audio_same_content"` の注意付き）および新旧のハッシュ・サイズ・尺（秒）の差分を表示する。
       - 初回公開で音源が未 stage の場合：`mode: "missing_required"`（公開不可）。
     - Show カバー画像:
       - `update-show` はメタデータとカバー画像を組で stage する仕様を維持しつつ、公開済みカバー画像と `sha256`・`length_bytes` が同じか変わったか（`content_changed: boolean`）を明示する。
4. **生成予定 RSS と素材確認の案内（`rss_preview` / `verification_paths`）**:
   - `--rss-output`を指定しない場合、RSS全体の検証は`not_checked`とする。素材の再利用予定と手元の確認パスは通常のpreviewにも表示する。
   - 任意の `--rss-output FILE` オプションを指定した場合は、公開済み Episode 一覧に今回の変更候補を適用した生成予定 RSS 2.0 XML を、指定したローカルファイルへ書き出す（サーバーや R2 へは書き込まない）。
    - 画像確認・音源試聴には `verification_paths` の手元ファイルを使う。保存済み版の URL は `published.snapshot` 内に含めるが、非公開・停止中の配信を許可するものではない。

### 5.2 `--expect-preview` による確認内容の束縛と競合拒否

1. **Show 下書きへの更新元ハッシュの追加保存**:
   - `update-*` で新規下書きを作る際に、公開済み Show の `base_show_metadata_sha256` と `base_cover_sha256` を `SqliteDraftTarget` に記録する。Episode 自体の本文ハッシュには従来どおり `base_metadata_sha256` を使う。これらのローカル検査用ハッシュは公開リクエストに混入させない。
2. **`input_fingerprint` の計算**:
   - `input_fingerprint` は、以下の正規化 JSON の SHA-256 ハッシュとする。
     - `workspace`（絶対パス）、`config`（サービス設定）、`target`（下書きの target 情報）
     - `metadata_sha256`（手元の TOML のハッシュ）、`local_assets`（手元の素材のハッシュ・サイズ）、`assets`（stage 済み素材の receipt 情報）
      - `remote_base`: オフライン時は`null`、リモート時はruntime・config・受付window・受付状態、Show/Episodeのlifecycleと世代、revision、metadataハッシュ、画像・音源identityを含む。Feed世代も束縛するため、他Episodeの更新後も再previewが必要になる。観測時刻など毎回変わる値は含めない。
3. **公開時（`publish-show` / `publish-episode`）の拒否条件**:
   - `--expect-preview HASH` が指定された場合、ロック取得後・公開要求凍結前に次を検査する。
     - 手元の TOML や素材ファイルが preview 時または stage 時から1バイトでも変わっていれば拒否（`preview_changed`）。
     - リモート確認済みの HASH であれば、サーバーの現在の公開状態を再取得して `input_fingerprint` を再計算し、確認後に別クライアントが Show や Episode を更新していた場合、ライフサイクルが変わっていた場合、または Worker バージョン・設定が変わっていた場合は拒否（`preview_changed`）。
     - オフライン確認（`--local`）の HASH であった場合も、下書きの `target` に記録された更新元バージョン・revision・ハッシュが現在のサーバー状態と一致するかを公開要求送信前に検査し、不一致なら拒否する。

### 5.3 非公開化・復帰（`unpublish` / `restore`）と「過去版の採用（ロールバック）」の区別

利用者とエージェントが混同しないよう、既存のライフサイクル操作と今回の過去版採用を次のように明確に分ける。

| 項目 | 既存の非公開化・復帰（`preview-*-lifecycle` → `lifecycle-execute`） | 今回の過去版採用（`preview-*-revision` → `revision-execute`） |
| --- | --- | --- |
| 目的 | Show や Episode の**公開・非公開（表示 / 非表示）を切り替える** | 誤って編集・公開した Show や Episode の**内容を、過去の特定の版（revision）へ戻す** |
| 使える対象状態 | `unpublish`は公開中、`restore`は非公開中に使う | 対象は公開中または非公開中。実行後は公開中になる。Episodeの採用には親Showが公開中であることが必要 |
| 参照するデータ | 直前に保存されていた最新のスナップショット1件のみ | revision 履歴の中から管理者が指定した特定の過去版（`revision_id`） |
| 履歴への影響 | Episode の `revision_id` は変わらない（`lifecycle_version` や `state_version` が進む） | 過去の履歴は削除・上書きせず、指定した過去版の内容と不変素材を引き継いだ**新しい公開版**として履歴の末尾に追加される |

### 5.4 revision 履歴の閲覧と過去版採用のコマンド・操作手順

既存の CLI 体系（`preview-*-lifecycle` → `lifecycle-execute`、`list-*`）と一貫したコマンド構成とする。

```sh
# 1. revision履歴の一覧を確認する（読取専用、最新順20件ずつ）
castloop list-show-revisions daily --workspace /path/to/service --json
castloop list-episode-revisions first --workspace /path/to/service --show daily --json

# 2. 特定の過去revisionと現在公開中の内容の差分・復元計画をプレビューする（読取専用）
castloop preview-show-revision daily TARGET_REVISION_UUID --workspace /path/to/service > /path/to/service/.castloop/revision-plan.json
castloop preview-episode-revision first TARGET_REVISION_UUID --workspace /path/to/service --show daily > /path/to/service/.castloop/revision-plan.json

# 3. 内容とrequest_sha256を確認し、明示承認して過去版を採用する（Show FIFOで実行し完了まで待機）
castloop revision-execute /path/to/service/.castloop/revision-plan.json REQUEST_SHA256 confirm --workspace /path/to/service --json

# 4. （任意）手元のTOMLファイルを、現在サーバーで公開されているメタデータに同期する
castloop sync-local-metadata --workspace /path/to/service --show daily --episode first --expect-revision REVISION_UUID --output reviewed-episode.toml --json
```

上の2種類のpreviewは対象に応じてどちらかを選び、既存ファイルを上書きしない新規パスへ保存する。計画ファイルの相対パスはworkspace基準、`--output`と`--rss-output`の相対パスは呼出元cwd基準となる。各コマンドの動作と安全条件は次のとおり。

1. **`list-show-revisions SHOW_ID` / `list-episode-revisions EPISODE_ID`（読取専用）**:
   - Show DO の SQLite から、確定順（新しい順、`--cursor` による20件ページング対応）で revision 履歴の一覧を返す。
   - 各行には `revision_id`（公開 job ID）、`revision_sequence`、`updated_at`、`title`（最大200文字）、素材のハッシュ・サイズ等、および現在採用中の版かどうか（`is_current: boolean`）を含める。Show は確定時の `state_version` も持つが、ページングには内容改訂の連番 `revision_sequence` を使う。
2. **`preview-show-revision SHOW_ID REVISION_ID` / `preview-episode-revision EPISODE_ID REVISION_ID`（読取専用）**:
   - サーバーから「現在の公開版」と「指定された過去 `REVISION_ID` の版」の両方の全文・素材情報を取得する。
   - 通信・認証は必要だが、サーバー側の状態変更やローカルの下書き・ロック作成は一切行わない。
   - 出力には以下を含める:
     - `current`: 現在サーバーに保存されている版（`lifecycle`、バージョン、`revision_id`、全文、素材情報）。
     - `target_revision`: 採用しようとしている過去版の全文・素材情報。
     - `changes`: 現在版から過去版へ戻すことで**どの項目がどう変わるか**（項目別の変更前後、カバー画像や音源が現在と同じか過去の不変オブジェクトへ切り替わるか、GUID・`published_at` が維持されているか）。
     - `plan`: `{ request, request_sha256 }`。`request` には `action: "restore_revision"`、現在の `expected_show_state_version`（Episode はさらに `expected_episode_lifecycle_version` と現在の `base_revision_id`）、および採用対象の `target_revision_id` を凍結する。
3. **`revision-execute PLAN_JSON REQUEST_SHA256 confirm`（明示承認による実行）**:
   - `lifecycle-execute` と同じく、保存した計画ファイル、その SHA-256 ハッシュ、および明示的な `confirm` 引数を検証する。
   - 未完了（未送信または実行中）のローカル下書き（`sqlite-drafts`）が同じ対象に残っている場合は、誤って手元の作業と競合させないよう実行前に拒否する。
   - 計画をローカルジャーナル（`.castloop/sqlite-revisions/<service_id>/<job_id>.json`）に保存したうえで Show DO の公開 FIFO キューへ送信し、同じ `job_id` が `succeeded` になるまで待機する（待機中に切断された場合は既存の `job-status JOB_UUID` で結果を確認でき、再送信はしない）。
   - **Worker 側（公開処理の実行部：executor）での実行内容**:
      1. 現在の状態と `expected_show_state_version`、Episodeの `expected_episode_lifecycle_version`・`base_revision_id` が一致すること、および対象Show/Episodeの履歴表に `target_revision_id` が存在することを検証する。
     2. Episode の場合、過去版の `guid`・`guid_is_permalink`・`published_at` が現在版と一致すること、および過去版が参照する不変音源（`audio_revision_id`）が `publication_media` 表と R2（ファイル実在・サイズ・SHA-256 の照合）の両方に存在することを検証する。**音源の再コピーや再アップロードは行わず、既存の不変音源オブジェクトをそのまま参照する。**
     3. Show の場合、過去版のカバー画像世代（`cover_generation`）のオブジェクトが R2 上に存在し、サイズ・SHA-256・拡張子が一致することを検証する。**カバー画像の再アップロードは行わず、検証済みの過去世代のカバー画像オブジェクトをそのまま参照する。**
     4. 新しい公開 `job_id` を新しい `revision_id` として採番し（どの `restored_from_revision_id` から採用したかも記録）、新しい世代の Feed XML を生成・保存し、必要なキャッシュパージ（Feed・カバー画像・エピソード）が成功してから SQLite の現在版と履歴表を1トランザクションで更新する。
     5. 対象が公開中（`published`）であった場合、実行中（`running`）および保護条件を満たす異常停止（`blocked`）の間は、通常の更新（Issue #50）と同様に**更新前の公開済み Feed・画像・音源の配信を継続する**。対象が非公開中（`unpublished`）であった場合は、既存の `restore` と同じく完了するまで対象を配信しない。
4. **`sync-local-metadata`（手元の TOML ファイルの明示同期）**:
   - 確認した現在のrevision UUIDを`--expect-revision`へ指定し、正確なmetadataを新しいファイルへ書き出す。`state_version`はこの引数には使わない。
   - 原本保全のため既存ファイルは必ず拒否する。標準TOMLが残る場合は`--output`で新規パスへ出力して比較し、原本への反映は別途管理者が判断する。出力先親のsymlinkや未完了draftも拒否し、画像・音源やjournalは復元しない。

---

## 6. データベース・R2・形式番号と安全条件

### 6.1 Show DO SQLite に追加する履歴テーブル

Show DO の `SqlitePublicationContent`（`src/sqlite-publication-content.ts`）に次の2表を追加する。

```sql
CREATE TABLE IF NOT EXISTS publication_show_revisions (
  show_id TEXT NOT NULL,
  revision_sequence INTEGER NOT NULL CHECK(revision_sequence > 0),
  state_version INTEGER NOT NULL CHECK(state_version > 0),
  revision_id TEXT NOT NULL UNIQUE,
  metadata_json TEXT NOT NULL,
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256) = 64),
  cover_extension TEXT NOT NULL CHECK(cover_extension IN ('jpg', 'png')),
  cover_generation INTEGER NOT NULL CHECK(cover_generation > 0),
  cover_sha256 TEXT NOT NULL CHECK(length(cover_sha256) = 64),
  cover_length_bytes INTEGER NOT NULL CHECK(cover_length_bytes > 0 AND cover_length_bytes <= 5000000),
  restored_from_revision_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(show_id, revision_sequence),
  UNIQUE(show_id, revision_id)
);

CREATE TABLE IF NOT EXISTS publication_episode_revisions (
  show_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  revision_sequence INTEGER NOT NULL CHECK(revision_sequence > 0),
  revision_id TEXT NOT NULL UNIQUE,
  audio_revision_id TEXT NOT NULL,
  metadata_sha256 TEXT NOT NULL CHECK(length(metadata_sha256) = 64),
  revision_json TEXT NOT NULL,
  restored_from_revision_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(show_id, episode_id, revision_sequence),
  UNIQUE(show_id, episode_id, revision_id)
);
```

- Show確定時に履歴表へ新しい連番と確定後の状態番号を追加する。R2の`system/shows/<showId>/revisions/<revision_id>.toml`へ不変metadataも保存する。現在の`show.toml`と世代別カバー画像は従来の責務を維持する。
- Episode確定時に新しい連番の履歴行を追加する。R2のrevision TOMLと`public/podcasts/<showId>/episodes/<episodeId>/<audio_revision_id>.mp3`は保持する。過去版採用では新しい音源・画像objectを作らない。
- Show の過去版採用では、過去の検証済み `cover_generation` をそのまま `publication_show_content.cover_generation` に再設定できるため、`commitShow` の「新規アップロード時は `cover.generation === publicationSequence`」と「過去版採用時は指定された過去 revision の検証済み `cover.generation` を維持する」を明確に分けて検証する。

### 6.2 管理 API の追加ルート

すべて Show DO スコープ（`X-Castloop-Show-Id` ヘッダー必須、workers.dev 管理オリジン限定、管理キー認証必須、`Cache-Control: no-store`）の読み取り専用 GET とする。

| メソッドとパス | 用途 | CLI読取予算 |
| --- | --- | --- |
| `GET /admin/sqlite-service/content/<showId>` | Show の現在の公開状態、メタデータ全文、カバー画像情報、最新 `revision_id` を返す | 8 MiB |
| `GET /admin/sqlite-service/content/<showId>/<episodeId>` | 上記の Show 情報に加え、対象 Episode の現在の状態、最新 `EpisodeRevision` 全文、音源情報を返す | 8 MiB |
| `GET /admin/sqlite-service/revisions/<showId>[/after/<revisionSequence>]` | Show の revision 履歴を新しい順に最大20件返す | 8 MiB |
| `GET /admin/sqlite-service/revisions/<showId>/item/<revisionId>` | Show の指定した過去 revision の全文とカバー画像情報を返す | 8 MiB |
| `GET /admin/sqlite-service/revisions/<showId>/episodes/<episodeId>[/after/<revisionSequence>]` | Episode の revision 履歴を新しい順に最大20件返す | 8 MiB |
| `GET /admin/sqlite-service/revisions/<showId>/episodes/<episodeId>/item/<revisionId>` | Episode の指定した過去 revision の全文と音源情報を返す | 8 MiB |

※ 既存の `src/sqlite-service-http.ts` の「クエリ文字列（`?`）やハッシュ（`#`）を含まない厳密なパスルーティング」の規約に合わせ、ページングの位置指定や個別 revision 指定もパス要素で表現する。

初稿の64/128KiBでは保存済み全文を扱い切れないため、新規の全文・履歴・RSS一覧取得GETだけCLIの読取予算を8MiBとする。既存のhealth/targets等の上限は増やさない。保存用schemaに新規入力上限は適用せず、応答予算超過は切り詰めずエラーにする。履歴一覧は本文全文ではなくSQLで抽出した短い要約を返す。Workerによる保存済みrevision TOMLの読取にも、入力upload上限とは別に8MiBの読取予算を設ける。

RSS用に`GET /admin/sqlite-service/content-inventory/<showId>/<feedGeneration>[/after/<episodeId>]`を追加する。公開中EpisodeだけをID順に20件ずつ取得し、全ページのruntimeとFeed世代を固定する。収集・XML生成後にCLIがpreviewを再照合してからローカルファイルへ書き出す。追加・更新が割り込んだら再確認を求める。

### 6.3 保存形式の番号と新規環境専用の扱い

| 識別対象 | 変更内容 |
| --- | --- |
| サービス設定 | `schema_version = 2`、`publication_protocol = "sqlite-sequential-v1"`、`storage_layout = "show-v1"` を維持する |
| 公開待ち行列（queue）の形式番号 | `7` のまま維持する（`publication_jobs` のテーブル構造は変更しない） |
| 公開コンテンツ（content）の形式番号 | 調査基準の `7` から `8` へ進める（`publication_show_revisions`・`publication_episode_revisions` 等を識別する） |
| サーバーの対応機能表示（`health` / `targets`） | `revision_history = "sqlite-revisions-v1"` を必須項目として追加し、対応 CLI が実行前にサーバーの対応を確認できるようにする |

本リポジトリの既存方針に従い、旧形式のデータベースを自動変換するマイグレーション処理や、過去の履歴を R2 から推測して事後生成する処理は作らない。既存環境や手元の原本・検証記録は変更・削除しない。

### 6.4 プライバシーと運用ログの境界

- 管理者が CLI で明示的に実行した `preview-*`、`list-*-revisions`、`sync-local-metadata` の標準出力（および `--json` 出力）には、編集・確認に必要なメタデータ全文と差分を表示する。
- 一方、Worker が出力するログ（`console.error` 等）や DO SQLite の操作診断記録（`operation_requests`、`operation_events`、`publication_jobs.reason_code`）には、**タイトル、説明文、所有者メールアドレス、秘密鍵、任意の例外メッセージ文字列を一切保存・出力しない**。診断コードは既存の固定 allowlist のみを使用する。

---

## 7. 実装順序と受け入れ試験計画

### 7.1 実装順序

1. **共有スキーマの追加（`packages/shared/`）**:
   - `sqlitePublicationRequestSchema` に `action: "restore_revision"` と `target_revision_id` を追加する。
   - 公開済み全文照会（`content`）、revision 一覧・詳細（`revisions`）、および過去版採用計画（`sqliteRevisionPlanSchema`）の厳密な Zod スキーマを追加する。
   - `sqliteHealthSchema` に `revision_history: z.literal("sqlite-revisions-v1")` を追加する。
2. **Worker 側の履歴保存・管理 API・過去版採用の実装（`src/`）**:
   - `src/sqlite-publication-content.ts` に `publication_show_revisions` と `publication_episode_revisions` を追加し、Show / Episode の公開確定時と過去版採用確定時に履歴を記録する。
   - `src/sqlite-publication-executor.ts` に Show の不変 revision TOML 保存と、`action === "restore_revision"` の検証（R2 上の不変音源・不変カバー画像・revision TOML の HEAD/GET 照合、GUID・公開日時の維持確認、Feed 再生成、キャッシュパージ）を実装する。
   - `src/sqlite-service-runtime.ts` と `src/sqlite-service-http.ts` に `content/` と `revisions/` の読み取り専用エンドポイントを追加する。
3. **CLI 側の差分プレビュー・履歴閲覧・過去版採用の実装（`packages/cli/src/`）**:
   - `draft-preview.ts` を拡張し、リモート公開済み内容の取得、項目別差分（`metadata_fields`）、素材再利用・差し替え表示、identity 検査、`input_fingerprint` への公開ベース束縛、任意の生成予定 RSS 出力（`--rss-output`）を実装する。
   - `sqlite-draft.ts` と `sqlite-draft-journal.ts` で Show 下書きの更新元ハッシュ保持と、`publish-* --expect-preview` 時のサーバー現在状態との再照合を実装する。
   - `list-show-revisions`、`list-episode-revisions`、`preview-show-revision`、`preview-episode-revision`、`revision-execute`、`sync-local-metadata` を実装する。
4. **ヘルプ・スキーマ・Skill・ドキュメントと回帰試験の更新**:
   - `help.ts`、`describe`、管理者向け Skill（`skills/castloop/`）、`README.md`、`design/initial_design.md`、`docs/sqlite_sequential_development.md`、`docs/agent_usage.md` を更新する。

### 7.2 受け入れ試験の項目

| 試験分類 | 確認する内容 |
| --- | --- |
| 項目別差分の表示 | Episode の metadata-only 更新、audio-only 更新、両方同時更新、および Show の説明文・カバー画像更新で、変更された項目・変更前後の値・音源や画像の再利用/差し替えが正確に表示されること |
| 未取得・オフライン時の区別 | `--local` 指定時や未初期化ディレクトリでは通信・書き込みを行わず、`published.status = "not_checked"` となり、差分なし（`unchanged`）と誤認させない表示になること。`--remote` 指定時の通信失敗はエラー終了すること |
| 競合・改ざんの拒否 | preview 後に手元の TOML や素材ファイルを書き換えた場合、別クライアントが先に公開してサーバーの `state_version` や `revision_id` が進んだ場合、またはライフサイクルが変わった場合に、`publish-* --expect-preview` が公開要求凍結前に拒否すること |
| 識別子・拡張子変更の検出 | 公開済み Episode の `guid`・`guid_is_permalink`・`published_at` を変えた場合や、公開済み Show のカバー画像拡張子を変えた場合に、preview 時点で警告・公開不可と表示し、実行も拒否すること |
| revision 履歴の一覧・詳細 | Show と Episode の複数回更新後に、確定順（新しい順）で履歴一覧（20件ページング含む）と各 revision の全文・素材ハッシュが取得でき、`is_current` が正しく付くこと |
| 過去版の採用（ロールバック） | Episode と Show で過去の `revision_id` を指定して preview → `revision-execute` を行うと、MP3 やカバー画像を再アップロードせずに過去版の内容・素材へ戻り、GUID・初回公開日時が維持され、過去の履歴が消えずに新しい版が追加されること |
| 既存の `unpublish` / `restore` との分離 | 非公開化と直前スナップショット復帰（`lifecycle-execute`）が従来どおり動作し、過去版採用（`revision-execute`）と混同・干渉しないこと |
| 配信継続とキャッシュ | 過去版採用の実行中も公開中の旧 Feed・旧音源・旧カバー画像の配信が維持され、キャッシュパージ完了後に新しい Feed へ切り替わること。ステージング素材や非公開 Episode が公開 URL から漏れないこと |
| プライバシーと単体バイナリ | エラー時や運用ログにタイトル・説明文・メールアドレス・秘密鍵が出力されないこと。`bun test`、`npm run check`、Linux 単体バイナリビルドと `scripts/smoke-agent-cli.mjs` がすべて成功すること |

### 7.3 実装・ローカル検証結果（2026-10-25）

採用した5案を実装した。利用手順は[公開内容の差分確認と過去版の採用](../docs/published_content_review.md)を参照する。

| 検証 | 結果 |
| --- | --- |
| `bun test` | 82ファイル、730件成功・失敗0件 |
| `npm run check` | TypeScript型検査成功 |
| `npm run build:cli -- linux-x64` | Linux x64単体バイナリの生成成功 |
| `CASTLOOP_TEST_TMP=/tmp/opencode node scripts/smoke-agent-cli.mjs dist/castloop-linux-x64` | 空のPATH、ソース・外部runtimeなしのオフライン確認成功 |
| `bun scripts/measure-revision-storage.ts` | §4.1の合成データによるローカルSQLite容量を測定 |
| `git diff --check` | 差分の空白検査成功 |

追加試験では、差分と素材identity、別workspaceの更新・非公開化と復帰による競合、認証とShow分離、20件ページング、RSSのローカル出力、原本上書き拒否、Show/Episodeの過去素材再利用を確認した。公開結果の書込・Feed保存・cache purge・SQLite確定時の失敗について、旧配信と履歴が保たれ、不確かな書込を再実行しないことも確認した。POST応答消失時はjob IDと不明状態を保持し、同じ計画の再実行ではGET観測だけを行う。

これらは模擬CloudflareとローカルSQLiteの機能試験であり、Cloudflare実機のCPU時間・無料枠適合やWindows/macOS動作の実証ではない。実Cloudflareへの配備・公開・資源変更は実施していない。内部形式7/8の新規環境が必要で、既存環境の変換は追加していない。
