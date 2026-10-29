# 番組サイトの公開日タイムゾーン（Issue #70）

## 採用方針

管理者がShowごとに選んだタイムゾーンで、一覧とEpisode個別ページの公開日を表示する。**案A：Show metadataに任意の`site_timezone`を保存し、既存の事前HTML生成で変換する方式**を採用する。

| 案 | 利点 | 欠点・判断 |
| --- | --- | --- |
| A：Show設定 | 番組ごとに指定でき、操作するPCや管理者によらず表示が一定。保存revisionから復元・再生成できる | 任意fieldが1つ増える。採用 |
| B：サービス共通設定 | 複数番組を一括指定できる | 番組別に変えられず、表示変更がサービスidentity・配備保守に結び付く。不採用 |
| C：CLIの管理用timezoneを流用 | 設定場所を増やさずに見える | サーバー生成へそのまま渡せず、結局公開入力への保存が必要。PCや操作担当者で公開表示が変わるため不採用 |
| D：閲覧ブラウザの地域で変換 | 閲覧者には自然な日付 | 管理者指定の表示にならず、JavaScriptが必要。不採用 |

## 設定・表示契約

```toml
site_mode = "builtin"
site_timezone = "Asia/Tokyo"
```

- 内蔵サイトだけの任意設定。省略はUTC。外部方式へ切り替える際には削除する。
- `UTC`またはruntimeが対応するIANA地域名（`Asia/Tokyo`など、タイムゾーンを指定する標準的な名前）を指定する。略称`JST`・`EST`、offsetだけの`+09:00`、不正値は入力エラー。OSや閲覧者の設定を推測せず、失敗時にUTCへ戻さない。
- 表示は`YYYY-MM-DD (UTC+09:00)`。UTCは`UTC+00:00`とする。時刻を増やさず既存のコンパクトさを保つ。
- `2025-12-16T22:00:00Z`は東京では`2025-12-17 (UTC+09:00)`。現在の日付ではなく**各Episodeの公開時点**に対する夏時間・offsetを使う。
- 元の`published_at`とHTMLの`datetime`属性は保持する。RSS `pubDate`、絶対時刻による新しい順の並び、GUID、URL、音源identityは変更しない。
- `castloop-admin.toml timezone`とは責務を分離する。管理用設定は日時入力の解釈・確認、`site_timezone`は公開サイトの表示用である。

## 生成と更新

1. CLIは厳密なShow schemaで検証し、通常の公開入力に設定を固定する。ステージ後に変更したローカル入力は、再ステージしなければ公開できない。
2. 明示的なShow公開でShow DOが設定を生成入力へ固定し、全一覧・全公開Episodeページを再生成する。uploadだけでは公開しない。
3. Worker標準`Intl.DateTimeFormat`を1 batchにつき1つ作り、各HTMLで再利用する。ページを単体で生成する場合もページ内で共有する。グローバルcache・外部日時ライブラリは追加しない。
4. private R2への不変保存・検証、必要なpurge、既存の原子的な参照切替を維持する。変換失敗も既存の失敗／blocked契約へ従う。
5. Episodeの追加・更新では従来どおり全一覧と対象個別ページのみ。現在のShow設定を使い、他の個別ページを毎回生成し直さない。
6. Showの過去版採用はその版の設定（未設定ならUTC）を復元する。Episodeの復元・過去版採用は現在のShow設定、domain保守は保存済みShow設定を使う。

設定を削除してShowを明示公開すれば全ページがUTCへ戻る。Workerのcode-only更新だけでは既存HTMLは変わらない。通常のWorker更新保守と対象Showの明示公開が必要である。

## 単純さ・Free枠

ネイティブ`Intl`の使用は[Cloudflare公式のWeb standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/#intl)で確認した。新しい依存、Worker、DO、R2 bucket、有料機能、閲覧時の日時計算・JavaScriptは追加しない。設定検証は既存の管理用IANA名validatorを共通moduleへ切り出して再利用し、管理用設定の読み込みはWorkerへ持ち込まない。

HTML数と20 HTML／4,000,000 bytesのbatch予算は変更しない。生成時の日時整形分のCPUは増える。元から残る全件入力SQL・RSS一括生成・履歴の累積も含め、**ローカル試験はnative CPUやFree枠全体の適合証拠ではない**。

Show metadata version 1へ任意fieldを追加し、既存JSON保存経路に載せる。SQLの列・形式や内部queue/content **10/11**、`static-show-v2`識別は変えず、DB変換・移行も作らない。旧形式の環境を受け付けるものではない。

## 検証範囲

ローカル試験で、設定の省略・正しいIANA名・不正値、UTC／東京の日付境界、年跨ぎ、夏時間の開始・終了、45分offset、一覧と個別ページの一致を確認した。Show更新の全ページ原子切替、Episode更新・復元、Showの過去版採用、domain再生成、RSS取り込み、ステージ後の設定変更拒否も既存経路を通して確認した。

- `bun test`：**828 pass / 0 fail**、94 files、12,958 assertions。
- `npm run check`：成功。
- `npm run build:cli -- linux-x64`と単体CLIのempty-PATH smoke試験：成功。
- 同バイナリのオフラインShow検証：東京・New Yorkを受理し、`JST`・未知の地域を`site_timezone`の入力エラーとして拒否。`.castloop/`は作成しない。
- `git diff --check`と変更Markdownの相対リンク検査：成功。

その後の別承認により、[既存の本人限定環境をタイムゾーン版へ更新](show_website_timezone_trial_verification_20261027.md)し、東京設定の一覧・個別ページと未認証拒否を確認した。本人からブラウザで`2025-12-17 (UTC+09:00)`と表示されたとの報告を受けた。native Free性能は未測定である。mainの予約公開を統合した版は内部11/11の新規環境専用であり、この10/11環境への上書き更新・移行はしない。
