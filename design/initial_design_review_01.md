# `initial_design.md` レビュー（第1サイクル）

- レビュー日: 2026-09-19
- 対象: [`initial_design.md`](./initial_design.md)、[`show-template.toml`](./show-template.toml)、[`episode-template.toml`](./episode-template.toml)、リポジトリ設定・規約
- 目的: 実装開始前に、矛盾、未決定事項、依存関係、選択可能な解決案を整理する

## 決定記録（2026-09-23）

以下はユーザーの選択を受けて確定した。第1サイクル時点の比較・指摘は後段に履歴として残す。正式なMVP方針は[`initial_design.md`](./initial_design.md)にも反映した。

| 項目 | 決定 |
| --- | --- |
| D-01 | A: 1サービスにつきprivate R2バケット1つと公開用Worker1つ。Showをキーで分離 |
| D-02 | A: Worker URLを標準、独自ドメインは任意。公開URLの基点`public_base_url`はサービス設定に置く |
| D-03 | A: ローカルTOMLが編集元。R2は公開済みsnapshotとjob statusの置き場 |
| D-04 | A: commit marker → R2 Event Notification → managed Cloudflare Queue → Worker consumer。簡素で運用しやすい構成にする |
| D-05 | B: サービス全体で1並列、逐次処理。Durable Objectによる並列化は行わない |
| D-06 | 提示した`system/`、`temp/episodes/<showId>/<episodeId>/<jobId>/`、`public/podcasts/<showId>/`、`public/episodes/<showId>/<episodeId>/`の全キー配置を採用。revision履歴を保持し、current metadataのみ上書き |
| D-07 | A: RSS 2.0 + Apple Podcasts互換をMVP基準とし、最小schema候補を採用。ただし`published_at`のTOML入力形式のみ保留 |
| D-08 | A: CLIでMP3妥当性・durationを解析し、WorkerでR2 size等を再確認 |
| D-09 | 2026-09-23確定: `create-episode` → ローカルTOML編集 → `update-episode`（下書きメタデータをR2へ）→ `update-episode-audio`（下書き音源をR2へ）→ `publish-episode`（公開ジョブを起動）。更新2コマンドでは公開せず、初回も更新時も明示的にpublishする |
| D-10 | A: 対話利用は`wrangler login`、自動化は環境変数のCloudflare API tokenを第一候補とする。実装量や大容量アップロード上の制約が大きい場合は代案を再検討 |
| D-11 | A: Workers Cachingを採用。feedのtag purgeとMP3のRange配信をM0で検証 |
| D-12 | A: MVPではR2の`system/jobs/<jobId>/status.toml`へjob statusを保存。必要になった場合にD1等を検討 |
| D-13 | A: 人間可読slugを使用。`serviceId`最大20文字、`showId`最大32文字、`episodeId`最大80文字、基本形`[a-z0-9]+(?:-[a-z0-9]+)*`。Showはサービス内、EpisodeはShow内で一意。IDは作成後不変 |
| D-14 | A: vertical slice型のM0〜M4を採用。D-09の下書き/公開分離をM1〜M3の完了条件にも反映 |
| 命名・削除 | `show.toml` / `episode-<episodeId>.toml` に統一。Episode削除はMVP非対応。誤記を修正 |

### D-10〜D-14採用時の補足（2026-09-23）

- D-10: 認証はWrangler標準のOAuth/API tokenを優先するが、「CLIがWranglerをsubprocessとして利用するか、Cloudflare APIを利用するか」「MP3をどの経路でR2へ直接アップロードするか」はまだ決めていない。tokenやOAuth認証情報をcastloopのTOMLへ書かない
- D-10: 現行Wranglerの`r2 object put`は単一オブジェクトのアップロード上限が315 MB。M0で想定音源サイズと実装負荷を検証し、満たせない場合はS3互換APIのmultipart upload等を再検討する。認証方針の採用だけでアップロード手段まで確定したわけではない
- D-11: `wrangler.jsonc`で`cache.enabled`を使用する。feed更新後のtag purgeと、完全な`200` responseをもとにWorkers CachingがRangeに応じる方式を検証する。cache失効時の再試行と料金・サイズ上限は実装前に確認する
- D-12: R2をjob statusの正とし、CLIから状態・失敗理由を確認できるようにする。statusの状態遷移、DLQからの回復、再試行の詳細は未決定。MVPでD1は導入しない
- D-13: IDの基本形式と上限を採用する。単一R2バケットを採用したため、Show IDの長さはバケット名との結合を理由にしていない。バケット自体の命名規則は別途決める
- D-14: 後段のM0〜M4案を採用するが、M2の公開フローはD-09の`update-episode`、`update-episode-audio`、`publish-episode`と一致させる。初回公開の動作確認をM2、音源のみ・メタデータのみの更新をM3に置く

### D-09の整合性確認（2026-09-23）

ユーザー確認済み: 「音源だけをアップロードしたときも自動公開しない」。採用するCLI操作は以下の通り。

| 操作 | ローカル/R2への効果 | RSS・公開済みEpisodeへの効果 |
| --- | --- | --- |
| `create-episode <episodeId>` | ローカルTOML生成、GUID発行 | なし |
| `update-episode <episodeId>` | ローカルTOMLを検証し、現在の未公開jobIdの`episode.toml`へupload | なし |
| `update-episode-audio <episodeId> <音源.mp3>` | CLIでMP3検証・duration算出後、同じ未公開jobIdの`audio.mp3`へupload。検証結果を音源に紐付ける | なし |
| `publish-episode <episodeId>` | 入力一式を検証し、固定したsnapshotを指す`commit.json`を最後に作成 | Queue経由で非同期公開。結果はjobIdで確認 |

既存のD-06キーをそのまま使える。初回の`update-episode`または`update-episode-audio`で未公開のjobIdを確保し、後続の更新は同じ`temp/episodes/<showId>/<episodeId>/<jobId>/`へ書く。`commit.json`がない間はQueue通知の対象外。commit後はこのjobを変更せず、次の編集には新しいjobIdを割り当てる。`commit.json`にはステージ済みTOML・MP3のobject version確認情報（ETagや検証済みdigest等）と、既存公開データを使う場合の参照先を記録し、consumer側でも検証する。こうしないと、確認後に入力が書き換わるraceを防げない。

| 公開パターン | 公開時に必要な入力 | 公開結果 |
| --- | --- | --- |
| 新規Episode | 下書きTOML + 下書きMP3 | 両方の新revisionを公開 |
| 既存Episode: メタデータのみ変更 | 下書きTOML + 現在の公開済みMP3 | enclosure URL/byte length/durationを維持し、GUIDも維持 |
| 既存Episode: 音源のみ変更 | 下書きMP3 + 現在の公開済みメタデータ | 新しいenclosure URL。GUIDは維持 |
| 既存Episode: 両方変更 | 下書きTOML + 下書きMP3 | 新しいenclosure URL。GUIDは維持 |

- ローカルTOMLは編集元なので、メタデータをステージした後にローカルTOMLを変更したら`publish-episode`は止めて`update-episode`を要求する。音源のみ更新の場合も、ローカルTOMLが前回公開版と異なるなら暗黙に古いメタデータを再利用しない
- 音源のみの更新は`update-episode-audio` → `publish-episode`で足りる。メタデータのみの更新は`update-episode` → `publish-episode`で足りる。新規公開だけは両方を必須とする
- 「updateした順序」ではなく「publishを確定した順序」で同一Episodeの新旧を比較する。QueueはFIFOではないので、単一並列でも古いcommitの後着で公開版を巻き戻してはならない。全順序の実装方法はD-05/D-12の詳細で決める
- 公開開始は`commit.json`配置のみ。アップロード操作の再実行や失敗では公開を発火させない。CLIの成功はjob受付であって公開完了ではない
- 別端末・並行CLIで同じ下書きを触る場合の競合防止、jobIdのローカル保持、再試行、staleな下書きの掃除は次の詳細設計で定める

**結果:** 採用済みD-01〜D-08と両立するため、D-09はこの操作体系で決定する。下書きの保持方法と同一Episodeのcommit順序の実装は引き続き未決定であり、FIFOを仮定して実装してよいという意味ではない。

### D-04・D-05の最小実装指針

- Queueのデータ構造やpollerは自作しない。R2 Event Notificationをproducerとし、Workerの`queue()` handlerをconsumerとする
- R2の`temp/episodes/.../commit.json`のobject-createイベントだけをQueueに送る。MP3・TOMLの個別uploadでは発火させない
- consumerは`max_concurrency: 1`、`max_batch_size: 1`とする。これは同時実行を1つにする設定であり、FIFO保証ではない
- Cloudflare Queuesは順序保証なし・at-least-once配送。同じjobの再配送と、同じEpisodeに対する新旧jobの順序逆転を扱う。`jobId`の冪等性と、既に公開済みの新しいrevisionを古いjobで戻さない規則が必要
- 当面はサービス全体の1consumerで十分。job状態の永続化と再試行・恒久的失敗時の扱いはD-12で詳細化する

### `published_at` の入力形式は保留

RSSの`pubDate`はRFC 2822形式で出力する。一方、TOML内は次のどちらも選択できる。

| 入力案 | TOMLの例 | 長所 | 注意点 |
| --- | --- | --- | --- |
| A: RFC 3339文字列（従来の推奨） | `published_at = "2026-01-02T10:00:00+09:00"` | 曜日を書かずに済む、機械的に検証しやすい。TOMLのoffset date-time形式にも近い | RSS出力でRFC 2822への変換が必要 |
| B: RFC 2822文字列 | `published_at = "Fri, 2 Jan 2026 10:00:00 +0900"` | RSSに近い表記を入力できる | 曜日と日付の不一致を検証する必要がある。TOMLの日時型ではないため引用符が必須。タイムゾーン表記やパーサー許容範囲を制限する必要がある |

上記2案のどちらでも日時の妥当性確認とRSS用の出力処理は必要であり、「RFC 2822で入力すれば変換処理が全く不要」とはならない。日時そのものはISO風の表記の方が入力しやすい場合が多いが、RSSに馴染んだ管理者には案Bも自然である。現時点の`episode-template.toml`は既存例のRFC 3339文字列を暫定的に残しており、選択後に確定させる。

なお、TOMLの日時型を使う別案 `published_at = 2026-01-02T10:00:00+09:00` もあるが、TOMLパーサーが日時として返す値と元のoffsetの保持方法を確認してから採用すべきである。

残る優先課題は、`published_at`形式、ShowのRSS channel link (`site_url`省略時の扱い)、Show情報と画像の公開操作、同一Episodeの新旧job判定、job statusの状態遷移・失敗回復、CLIのCloudflare認証への接続と大容量アップロード方法、サービス/バケットの命名と初期化（D-09〜D-13の実装詳細）である。

## 1. 第1サイクル時点の結論（検討履歴）

「private R2 に音源を保存し、Worker 経由で配信する」「音源更新時は URL を変え、Episode GUID は維持する」「CLI を主な管理インターフェースにする」という基本方針は妥当である。

レビュー時点では、次の5点が実装全体を左右する未決定事項だった。現在は冒頭の決定記録で確定済み。

1. 1サービス1バケットか、Showごとのバケットか
2. 公開URLを Worker URL、独自ドメイン、R2公開URLのどれにするか
3. ローカルTOMLとR2上の情報のどちらを正とするか
4. Episode更新を何が開始し、どのように完了・失敗を管理するか
5. 同時更新、再試行、重複イベントに対してどう整合性を守るか

レビュー時点では、初期設計の「単一R2バケット」と、旧リポジトリ規約の「systemバケット + Showごとのバケット」は両立していなかった。単一バケットを採用し、`AGENTS.md`を更新済み。

### レビュー時点で提案したMVPの全体像

本レビュー時点では、次の構成を推奨する。

- 1つのcastloopサービスにつき、1つのprivate R2バケットと1つの配信用Workerを使用する
- ShowはR2のprefixで分離する
- ローカルTOMLを編集元、R2を公開済みスナップショットと実行状態の保存先にする
- CLIは音源とメタデータを一意なjob領域へアップロードし、最後にcommit markerを置く
- R2 Event Notificationでcommit markerだけをQueueへ送り、consumerが冪等に公開処理を行う
- 全Showのジョブを単一並列のQueue consumerで逐次処理する
- 音源はimmutable、`feed.xml` とcurrent metadataだけを更新可能なオブジェクトとする
- 配信にはWorkers Cachingを使い、GET/HEAD・Range・条件付き取得をM0で実機検証する

上記のうち採用された項目は冒頭の決定記録と`initial_design.md`に反映済み。以下の比較はレビュー当時の検討履歴である。

## 2. 現在のプロジェクト状態

現時点では設計中心の初期状態であり、CLIやWorkerの実装はまだない。

- `design/` には初期設計と2つのTOMLテンプレートがある
- `packages/` はまだ存在しないが、`AGENTS.md` は `packages/cli` と `packages/shared` を前提としている
- `wrangler.jsonc` は `src/index.ts` を参照するが、`src/index.ts` はまだ存在しない
- ルート`package.json`はCommonJS指定だが、リポジトリ規約はES moduleを前提としている
- `@iarna/toml`、Zod、CLIライブラリはまだ依存関係にない
- テスト、lint、formatterは未設定である
- Wranglerは `4.131.2`、Bunは `1.4.2`、Node.jsは `24` が指定されている

実装が未着手であること自体は問題ではない。ただし、モノレポ構成を採用するか、単一packageから始めるかは実装開始時に設定と規約を一致させる必要がある。

## 3. レビュー時点の矛盾・不足（採用済み項目は冒頭参照）

### 3.1 ストレージ構成が一致していない

| 場所 | 記載内容 |
| --- | --- |
| `initial_design.md` | 初期化時に1つのR2バケット名を質問し、その中に全Show/Episodeを保存 |
| `AGENTS.md` | `castloop-<serviceId>-system` と `castloop-<serviceId>-<showId>` を使用 |

Showごとのバケットを1つの配信用Workerから読む場合、R2 bindingは基本的にデプロイ設定へ列挙する必要がある。そのため、新しいShowのたびにWorkerを再デプロイするか、ShowごとにWorkerを作る必要が生じる。単一バケットならこの問題はない。

### 3.2 オブジェクトキー規約が一致していない

| 場所 | 記載内容 |
| --- | --- |
| `initial_design.md` | `<showId>/publish/` と重複しない一時ディレクトリ |
| `AGENTS.md` | `temp/episodes/<episodeId>/`、`public/podcasts/<showId>/`、`public/episodes/<episodeId>/metadata.toml` |

どちらを採用するか決め、設計とリポジトリ規約を同時に更新する必要がある。

### 3.3 private R2方針とテンプレートが矛盾している

`show-template.toml` は `media_base_url = "https://<YOUR_R2_PUBLIC_BASE>"` とR2公開URLを要求する。一方、初期設計はprivate R2をWorker経由で配信するとしている。

この値はストレージURLではなく、利用者から見える `public_base_url` または `feed_base_url` として扱うべきである。`r2.dev` は開発用途であり、本番配信先にはしない。

### 3.4 Show作成だけではCloudflare側に存在が記録されない

`create-show` はCloudflare側で重複を確認した後、ローカルフォルダだけを作成する記述になっている。そのため、別ディレクトリや別端末から同じ `showId` を作成でき、次回もCloudflare側では重複を検出できない。

Showを作成した時点でremote registryへ予約するか、重複確認を公開時まで遅らせる必要がある。

### 3.5 Show metadataとカバー画像をサーバーへ反映する操作がない

`show.toml` を編集する説明はあるが、アップロードまたは更新コマンドがない。`image_path` のファイルをアップロードする手順もない。このままではサーバー側でRSS channel metadataと画像URLを生成できない。

### 3.6 ファイル名に不一致と誤記がある

- `shows.toml` と `show.toml` が混在している
- `<episodeId>.toml` と `episode-<episodeId>.toml` が混在している
- `episode-templat.toml` は `episode-template.toml` の誤記である
- `Podacst`、`Podccst` は `Podcast` の誤記である

ファイル名は `show.toml` と `episode-<episodeId>.toml` に統一する案が自然である。

### 3.7 用語上は削除可能だが、削除機能はMVP後になっている

用語では管理者がEpisodeを「追加・削除」できるとしているが、削除機能はMVP後の構想に置かれている。用語を能力の定義ではなく概念の説明に直すか、「MVPでは削除非対応」と明記すべきである。

### 3.8 `site_url` の空文字許可はRSS 2.0の必須要素と合わない

RSS 2.0のchannelには `title`、`link`、`description` が必要である。`site_url` を空にできるなら、`link` の代替値を定義する必要がある。

解決案は次のいずれかである。

- `site_url` を必須にする
- Showの公開トップURLを自動生成して `link` にする
- MVPで簡易ShowページをWorkerから返し、そのURLを使う

### 3.9 Episode更新の開始条件が未決定である

「R2更新を検知」または「CLIがWorkerをkick」とされているが、これは実装詳細ではなく信頼性モデルを決める主要設計である。音源とTOMLを個別に監視すると、片方だけが存在する途中状態で処理が開始される。

### 3.10 更新中チェックだけでは競合を防止できない

「更新中か確認してから開始」は、確認直後に別処理が開始するTOCTOU raceを防げない。また、QueueやR2 Event Notificationは重複処理を前提に設計する必要がある。ロックまたはcompare-and-set、job単位の冪等性が必要である。

### 3.11 CLI成功と公開成功が一致していない

現在の記述では、ファイルの一時領域へのアップロードが終わるとCLIは成功する。しかし、その後のWorker処理が失敗しても利用者には分からない。

最低限、`jobId`、状態、`castloop status <jobId>`、失敗理由、再試行方法が必要である。コマンドの出力も「アップロード受付完了」と「公開完了」を区別すべきである。

### 3.12 Metadata-only更新ができない

現在の `update-episode` は常にMP3を要求する。タイトルや説明の誤記だけを修正する場合にも新しい音源URLが作られる。音源を省略したmetadata-only更新、または公開と更新を分離したコマンドが必要である。

### 3.13 RSS生成に必要なmetadataが不足している

現在のテンプレートだけでは、一般的なPodcastディレクトリへ提出できるRSSを生成できない。

特に不足しているものは次のとおりである。

- Show: category、explicit、owner情報、copyright、RSS channel linkの確定方法
- Episode: description、永続GUID、explicit、episode type
- 生成値: enclosure URL、content type、byte length、duration、revision ID
- Feed: `atom:link rel="self"`、iTunes namespace、XML escaping、RFC 2822形式への日時変換

Apple Podcastsは、公開アクセス可能なRSS、artwork、GET/HEAD、byte-range、正しいenclosure、変更されないGUIDを要求している。

### 3.14 MP3チェックとduration算出方法が未定義である

拡張子やMIME typeだけではMP3であることを確認できない。VBRを含むMP3のduration算出方法、破損ファイルの扱い、最大サイズ、ID3のみで音声frameがないファイルの扱いを決める必要がある。

Workers FreeのCPU時間とメモリを考えると、音源全体をWorkerのメモリへ読み込んで解析する設計は避けるべきである。

### 3.15 公開WorkerのHTTP動作が不足している

Podcast配信では少なくとも次を定義する必要がある。

- `GET` と `HEAD`
- byte-rangeと `206` / `416`
- `Content-Length`、`Content-Range`、`Accept-Ranges`
- `ETag`、`Last-Modified`、条件付きリクエスト
- 存在しないオブジェクトの `404`
- private領域や任意R2 keyを公開しないroute allowlist

Workers Cachingを使う場合、Range requestはCloudflareがcache済みの完全な `200` responseから切り出せる。Worker自身が `206` を返すとそのresponseはWorkers Cachingへ保存されないため、採用するcache方式に応じて実装を統一する必要がある。

### 3.16 キャッシュ設定は概ね妥当だが、失敗時の扱いがない

現在のWranglerでは `[cache] enabled = true` は有効であり、設計の方向性は正しい。リポジトリは `wrangler.jsonc` を使用しているため、実装時は次の形式になる。

```jsonc
{
  "cache": {
    "enabled": true
  }
}
```

ただし、以下を追加で決める必要がある。

- purge結果がrate limit等で失敗した場合の再試行
- feed purge失敗時に最大1時間古いfeedが残ることを許容するか
- 404を含む意図しないheuristic cacheを避けるための明示的な `Cache-Control`
- Worker version更新時にcacheを共有するか

### 3.17 マイルストーンの完了条件が曖昧である

M1の「episode登録」と、M2の「外部アクセス・RSS更新」の境界が明確でない。テスト、CLI配布、失敗回復、認証、Show metadata更新もマイルストーンに含まれていない。

## 4. 意思決定の依存関係

次の順で決めると手戻りが少ない。

```text
D-01 ストレージ/デプロイ単位
  ├─> D-02 公開URL
  ├─> D-06 オブジェクトキー
  └─> D-13 ID制約

D-03 正とする状態
  ├─> D-04 更新トリガー
  ├─> D-05 排他・冪等性
  └─> D-12 status/回復

D-02 + D-06 + D-07 RSS schema
  └─> D-09 CLI操作体系

D-04 + D-05 + D-08 MP3処理
  └─> D-14 マイルストーン
```

D-01〜D-08の選択結果は冒頭の決定記録を参照。残る依存事項は次回レビューで詳細化する。

## 5. 検討した項目と選択肢（採用結果は冒頭参照）

### D-01: ストレージとデプロイの単位【最優先】

#### 案A: 1サービス = 1private R2バケット + 1Worker（推奨）

- Showはprefixで分離する
- 新しいShowを追加してもWorker bindingの追加・再デプロイが不要
- リソース数と初期化処理が少なく、MVP向き
- Show単位の削除、権限、移行はアプリ側で管理する
- 採用時は `AGENTS.md` のバケット規約を変更する必要がある

#### 案B: systemバケット + Showごとのバケット/Worker

- 現在の `AGENTS.md` に最も近い
- Showごとの分離、削除、移行、利用量把握が分かりやすい
- Show作成のたびにWorkerも作るため、デプロイ数と設定が増える
- Showごとに異なるドメインを持たせる設計とは相性がよい

#### 案C: systemバケット + Showごとのバケット + 共有Worker

- 共有WorkerへShowごとのR2 bindingを追加し、Show追加時に再デプロイする
- Worker数は少ないが、binding数とデプロイ更新の管理が必要
- 動的追加の利点が薄いため、MVPには推奨しない

### D-02: 公開URLと独自ドメインの扱い【D-01に依存】

#### 案A: Worker URLを標準にし、独自ドメインを任意にする（MVP推奨）

- 開発時は `workers.dev` URLですぐ開始できる
- 配信は常にWorker経由とし、R2はprivateのままにする
- 現行Workers CachingはWorkerに紐づくため、`workers.dev` と独自ドメインの両方で利用できる
- Podcastディレクトリ登録前に最終URLを決める運用ルールが必要

#### 案B: 初回公開までに独自ドメインを必須にする

- 長期的に安定したfeed/enclosure URLを持てる
- ホスト移行時の301 redirectを管理しやすい
- Cloudflare管理下のdomain/zoneが初期要件になり、導入障壁が上がる

#### 案C: mediaだけR2 custom domainから直接配信する

- media配信Workerを通さずに済む
- feedは別のWorker URLとなり、公開先が分かれる
- private R2という当初方針を変更する必要がある
- route制御や将来のaccess loggingが分散するため、現時点では推奨しない

いずれの場合も、公開URLは `media_base_url` ではなく、service設定の `public_base_url` として管理する案を推奨する。

### D-03: ローカルとCloudflareのどちらを正とするか【最優先】

#### 案A: ローカルTOMLを編集元、R2を公開済みsnapshotとする（推奨）

- Gitで変更履歴を管理しやすい
- AIエージェントや自動化から編集しやすい
- `create-show` 時にremote markerを条件付きで作成し、IDを予約する
- 複数端末利用時にはGit同期が必要

#### 案B: R2を正とし、CLIにpull/edit/pushを実装する

- 複数端末から同じ状態を扱いやすい
- pull、競合検出、merge、offline時の振る舞いが必要
- MVPのCLI実装量が増える

#### 案C: ローカルとR2を同格にして自動mergeする

- 柔軟だが、競合解決規則が複雑になる
- 単一管理者向けMVPには過剰であり推奨しない

案Aでも、runtimeが参照するのはR2上の検証済みsnapshotとする。ローカルの未公開変更を配信Workerが直接参照することはない。

### D-04: Episode更新処理の開始方法【最優先】

#### 案A: commit marker + R2 Event Notification + Queue（推奨）

1. CLIがjob固有prefixへTOMLとMP3をアップロードする
2. 全upload成功後、最後に `commit.json` を置く
3. `temp/.../commit.json` だけをprefix/suffix filterでQueueへ通知する
4. consumerがjobを冪等に処理する

利点は、大きい音源をWorkerのHTTP request bodyとして通さず、途中uploadを処理しないことである。Queueは重複配送を前提に実装する。

#### 案B: 認証付きAdmin Worker APIをCLIが呼ぶ

- APIがjobを作成し、upload完了後に明示的にcommitする
- server側で受付順や権限を管理しやすい
- 認証API、upload方法、token管理が増える
- 将来複数管理者へ拡張する場合に適する

#### 案C: CLIが全公開処理を同期実行する

- Queueや非同期statusが不要で、MVP実装が最小になる
- feed生成やpurgeをCLI側で行うため、処理途中の端末停止に弱い
- serverless backendの役割が配信だけになる
- 単一管理者・単一端末に限定した最初のprototypeとしては有効

MP3とTOMLそれぞれのobject-createを直接トリガーにする方式は採用しないことを推奨する。

### D-05: 同時更新、原子性、冪等性【最優先】

#### 案A: ShowごとのDurable Objectで公開処理を直列化（堅牢性を優先する場合の推奨）

- Show IDをDurable Object IDへ対応させる
- jobの受付順、active job、current revisionを一か所で管理する
- Queue再配送時も同じjob IDなら同じ結果を返す
- Cloudflare固有コンポーネントと実装量が増える

#### 案B: Queue consumerを全体で1並列にする（最小MVP案）

- 一人の管理者・少数Showでは十分な可能性が高い
- 全Showが直列になるが、処理量は小さい
- Queueの配送順を最終更新順として無条件に信用せず、job状態とrevision比較が必要
- 将来は案Aへ移行しやすい

#### 案C: R2の条件付き更新でcurrent manifestをcompare-and-setする

- 追加サービスを減らせる
- 競合時のfeed再生成とretry設計が複雑になる
- lock objectの期限切れや異常終了回復を設計する必要がある

どの案でも次を共通ルールとする。

- `jobId` と `revisionId` は一意かつimmutable
- 同じjobを複数回処理しても公開結果は同じ
- mediaとrevision metadataを先に書き、`current` と `feed.xml` を最後に更新する
- 失敗時は以前の `feed.xml` を維持する
- Episode GUIDはrevisionとは独立し、変更しない

### D-06: R2 object keyとrevision model【D-01に依存】

案A（単一バケット）を採用する場合の候補は次のとおりである。

```text
system/service.toml
system/shows/<showId>/show.toml
system/jobs/<jobId>/status.toml

temp/episodes/<showId>/<episodeId>/<jobId>/episode.toml
temp/episodes/<showId>/<episodeId>/<jobId>/audio.mp3
temp/episodes/<showId>/<episodeId>/<jobId>/commit.json

public/podcasts/<showId>/feed.xml
public/podcasts/<showId>/cover.<ext>
public/podcasts/<showId>/episodes/<episodeId>/<revisionId>.mp3
public/episodes/<showId>/<episodeId>/metadata.toml
public/episodes/<showId>/<episodeId>/revisions/<revisionId>.toml
```

#### 案A: revision履歴を保持し、current metadataだけ上書き（推奨）

- rollbackと監査が容易
- 古い音源はlifecycle policyまたは明示cleanupで後日削除する

#### 案B: 最新metadataだけ保持し、音源だけimmutableにする

- オブジェクト数と実装が少ない
- 過去状態を復元しにくい

#### 案C: job snapshotをそのまま公開状態として参照する

- copyを減らせる
- temp/publicの責務が曖昧になるため推奨しない

配信Workerは `public/` に対応する既知のrouteだけを公開し、`system/` と `temp/` へ外部からアクセスできないようにする。

### D-07: TOML schemaとRSS互換範囲

#### 案A: RSS 2.0 + Apple Podcasts互換をMVP基準にする（推奨）

最小schema候補:

**Show入力値**

- `schema_version`
- `show_id`
- `title`
- `description`
- `language`
- `author`
- `owner_name`
- `owner_email`
- `categories`
- `explicit`
- `site_url`、または自動生成するShow URL
- `image_path`
- `copyright`（任意）
- `show_type`（`episodic` / `serial`、任意）

**Episode入力値**

- `schema_version`
- `episode_id`
- `guid`（`create-episode` 時に生成し、その後不変）
- `title`
- `description`
- `published_at`（TOMLではRFC 3339、RSS生成時にRFC 2822へ変換）
- `explicit`（省略時はShow設定を継承）
- `episode_type`（既定値 `full`）
- `season_number`、`episode_number`（任意）

**公開時の生成値**

- `revision_id`
- `enclosure_url`
- `content_type = "audio/mpeg"`
- `length_bytes`
- `duration_seconds`
- `sha256`
- `published_at` と `updated_at`

`summary` と `description` は意味が重なるため、MVPでは `description` に統一する案を推奨する。

#### 案B: RSS 2.0の最低限だけを実装する

- schemaは小さくなる
- Apple Podcasts等への登録要件を後で追加する必要があり、migrationが早期に発生する

#### 案C: Podcasting 2.0 namespaceもMVPから広く実装する

- transcriptやchapter等へ拡張しやすい
- MVPの検証範囲が広がる

案Aを基準にし、Podcasting 2.0は `podcast:guid` など将来互換性に有効な少数項目だけ検討するのが現実的である。

### D-08: MP3検証とduration算出場所

#### 案A: CLIで解析し、serverでR2 size等を再確認する（MVP推奨）

- Bun実行環境でMP3 parserを使える
- Workers FreeのCPU制限を避けられる
- `length_bytes` はR2 object sizeを正とする
- durationはCLIのparser名・versionとともに記録し、異常値をserverでも拒否する

#### 案B: Queue consumer Workerで解析する

- server側だけで結果を確定できる
- MP3全体をbufferせず、必要部分をrange/streamで解析できるlibraryが必要
- Free tierのCPU内に収まるかM0で実測が必要

#### 案C: ffprobeを使う外部処理環境を用意する

- 判定精度と対応形式を高めやすい
- single binary、Cloudflare中心、低コストというMVP方針には重い

共通して、拡張子だけでなくMP3 frame、対応MIME、0 byte、最大サイズ、duration上限を検証する。音源全体をWorkerメモリへ展開しない。

### D-09: CLI commandと公開状態

**採用結果（2026-09-23）:** 上記「D-09の整合性確認」の操作体系を採用。以下の案A〜Cは当初レビューの比較履歴。

#### 案A: draft作成、初回公開、更新を分ける（推奨）

```text
castloop create-show <showId>
castloop publish-show [<showId>]
castloop create-episode <episodeId>
castloop publish-episode <episodeId> <audio.mp3>
castloop update-episode <episodeId> [--audio <audio.mp3>]
castloop status <jobId>
```

- 初回公開と既存更新の誤操作を検出しやすい
- metadata-only更新を表現できる

#### 案B: `update-*` に作成と更新を集約する

- command数が少ない
- 初回公開か更新かが暗黙的になる

#### 案C: `castloop sync` でローカル全体を宣言的に同期する

- 自動化とGitOpsに適する
- 差分計算、削除、競合、dry-runの設計が必要
- 将来機能として有力

MVPで予約公開を実装しない場合、未来の `published_at` は拒否する案を推奨する。未来日時のitemをfeedへ入れるだけでは、Podcast clientごとに挙動が異なり、確実な予約公開にはならない。

### D-10: Cloudflare認証と秘密情報

**採用結果（2026-09-23）:** 案Aを第一候補として採用。上記の補足に記したアップロード経路の制約はM0で検証する。

#### 案A: 対話利用は `wrangler login`、自動化は環境変数のAPI token（推奨）

- Cloudflare標準の認証方法へ寄せられる
- CLIがWranglerをsubprocessとして使うか、Cloudflare APIを直接使うかは別途決定する
- `CLOUDFLARE_API_TOKEN` はTOMLへ保存しない

#### 案B: R2 S3 access keyをCLIへ設定する

- multipart/direct uploadを実装しやすい
- access key IDとsecretの安全な保存方法、rotation、権限範囲が必要

#### 案C: Admin Workerだけに認証し、短時間のupload URLを発行する

- 管理者端末へR2 credentialを置かずに済む
- API認証とpresigned upload発行の実装が増える

永続設定ファイルは `castloop-init.toml` より `castloop.toml` または `.castloop/config.toml` が分かりやすい。次を保存し、secretは保存しない。

- `schema_version`
- `service_id`
- `account_id`
- resource名
- `public_base_url`
- cache設定

AIエージェントからの利用を重視するなら、すべての質問に対応するflag、`--non-interactive`、機械可読なJSON出力も必要である。

### D-11: 配信とcache方式

**採用結果（2026-09-23）:** 案Aを採用。

#### 案A: Workers Cachingを使用する（推奨）

- 現在のWrangler versionで `cache.enabled` を利用できる
- feedはclient 5分、Cloudflare 1時間という現在案を維持できる
- immutable mediaは1年cacheとする
- Range requestはcache層に完全な `200` responseを保存させ、Cloudflareにsliceさせる
- feed公開後に `ctx.cache.purge({ tags: [...] })` の結果を確認する

#### 案B: Cache API (`caches.default`) を明示操作する

- cache keyとput/matchを細かく制御できる
- request collapsingやtiered cache等を自前で考慮する必要がある
- 新規Workerでは案Aの方が適する

#### 案C: R2 custom domainのcacheへ任せる

- media配信Workerを省略できる
- D-02案Cと同じく、private R2方針と将来の配信制御を変更する

M0では、実際の公開hostnameに対して以下を自動確認する。

- cold/warm cacheの `Cf-Cache-Status`
- `HEAD` が成功すること
- `Range: bytes=0-9` が正しい `206` と10 byteを返すこと
- enclosureの `length` と完全取得時の `Content-Length` が一致すること
- feed purge後に新しい内容が取得できること

### D-12: job status、失敗回復、cleanup

**採用結果（2026-09-23）:** 案AをMVPで採用。状態遷移と障害回復の詳細は継続検討。

#### 案A: R2にjob statusを保存する（MVP推奨）

- `uploaded`、`queued`、`processing`、`published`、`failed` を記録する
- CLIはCloudflare credentialでstatusを読む
- 更新頻度が低い前提なら十分

#### 案B: D1にjobとrevisionを保存する

- 検索、一覧、transactionを実装しやすい
- 「DBを置かない」という現在方針を変更する

#### 案C: Durable Object storageへ状態を集約する

- D-05案Aとの整合がよい
- CLIが読むための管理APIが必要

共通方針として次を追加する。

- `temp/` にはlifecycle expirationを設定する
- 失敗jobは診断に必要な期間だけ保持する
- 公開済み旧音源はfeed更新直後に消さず、十分な猶予期間後に削除する
- structured log、Workers Logs、Tracesを有効にする
- `castloop retry <jobId>` または新jobとしての再投入規則を定める

### D-13: ID形式と一意性scope【D-01に依存】

**採用結果（2026-09-23）:** 案Aを採用。単一バケットへの変更後も、ここに示したIDの文字種・上限・一意性scope・不変性を採用する。

#### 案A: 人間可読slug（推奨）

- 基本形: `[a-z0-9]+(?:-[a-z0-9]+)*`
- `serviceId`: 最大20文字
- `showId`: 最大32文字
- `episodeId`: 最大80文字
- `showId` はservice内、`episodeId` はShow内で一意
- IDは作成後に変更不可

レビュー時点ではShow別バケット案も検討していたため、この短い上限を候補とした。現在は単一バケットに決定したが、ユーザーが案Aの上限を採用した。R2バケット名自体は3〜63文字、小文字英数字とhyphenのみ、先頭末尾hyphen不可である。

#### 案B: UUIDを内部ID、slugを変更可能な表示IDにする

- renameや衝突に強い
- URL、ローカルフォルダ、metadataに2種類のIDが必要

#### 案C: 自由度の高いURL-safe文字列を許可する

- 表現力は上がる
- ASCII URL、object key、shell引数、bucket名の制約処理が複雑になる

MVPでは案Aが適する。`serviceId` を設計へ追加し、同一Cloudflare account全体ではなく同一castloop service内を一意性scopeとする。

### D-14: マイルストーン再構成

**採用結果（2026-09-23）:** 案Aを採用。以下の案Aは当初レビュー時の提案であり、正式版は`initial_design.md`にD-09を織り込んで記載する。

#### 案A: vertical sliceで区切る（推奨）

**M0: アーキテクチャ検証**

- D-01〜D-05を決定
- Cloudflare認証とresource作成
- private R2からWorker経由のGET/HEAD/Range
- Workers Cachingとtag purge
- 最大想定サイズのupload
- MP3 duration parserの実測
- R2 Event Notification、Queue重複時の冪等性検証

**M1: ローカルmodelと初期化**

- workspace初期化
- Show/Episode作成
- strict TOML schema validation
- Show登録とID予約
- secretを含まない設定管理

**M2: 1 Episodeのend-to-end公開**

- metadata/audioの個別upload、`publish-episode`、job、非同期処理、status
- feed生成
- media配信
- cache purge
- 失敗回復

**M3: 複数Episode/更新運用**

- metadata-only更新
- 音源revision更新とGUID維持
- 同時更新
- cleanup/lifecycle
- RSS validatorとApple要件の検証

**M4: 配布と利用文書**

- Bun single executable
- install/upgrade手順
- README、sample、troubleshooting

#### 案B: 現在のM0〜M3を維持し、各完了条件だけ追加する

- 文書変更は小さい
- M1時点の成果物が利用者視点で動かず、統合問題の発見が遅れやすい

## 6. 決定不要で修正できる項目

以下は選択を待たずに次回の初期設計更新で修正できる。

- Podcast、Cloudflare、directory等の誤記と表記揺れを修正する
- `show.toml`、`episode-<episodeId>.toml` に名前を統一する
- durationの保存単位を定義する。内部値は整数秒、RSS出力は `HH:MM:SS` を推奨する
- lengthをbyte単位の非負整数と明記する
- `Response: Cache-Control` をHTTP response headerの記述へ直す
- XML文字列を必ずescapeし、TOML内の文字列をそのままXMLへ連結しない
- R2 listは最大件数で終了せず、`truncated` とcursorでpaginationする
- `feed.xml` のitem順を `published_at` 降順、同時刻は安定したtie-breaker順と定義する
- `schema_version` をすべての永続TOMLへ追加する
- 公開Workerが `temp/` と `system/` を配信しないことを明記する
- CLIの終了コード、標準出力、標準エラー、JSON出力の契約を定義する

## 7. 次のレビューサイクルで先に回答してほしい項目

以下のD-01〜D-05は2026-09-23に選択済み。

```text
D-01: A
D-02: A
D-03: A
D-04: A
D-05: B
```

採用済みの追加項目は次のとおりである。

```text
D-06: 記載のオブジェクトキー構成 + 案A（revision履歴）
D-07: A（published_atの入力形式のみ保留）
D-08: A
```

次回は上記の保留事項とD-09〜D-13の実装詳細を検討する。D-01〜D-14の採否はすべて決定済み。`initial_design.md`、TOMLテンプレート、`AGENTS.md`の採用済み規約は更新済み。

## 8. 参照資料

Cloudflareの仕様は変更されるため、以下は2026-09-19時点で確認した内容である。

- [Cloudflare Workers Caching configuration](https://developers.cloudflare.com/workers/cache/configuration/)
- [Cloudflare Workers Caching limitations](https://developers.cloudflare.com/workers/cache/limitations/)
- [Cloudflare R2 Event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- [Cloudflare R2 Workers API usage](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)
- [Cloudflare R2 Upload objects（Wranglerの単一ファイル上限）](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [Cloudflare Wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/general/#login)
- [Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- [Cloudflare R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Apple Podcasts RSS feed requirements](https://podcasters.apple.com/support/823-podcast-requirements)
- [RSS 2.0 Specification](https://www.rssboard.org/rss-specification)
