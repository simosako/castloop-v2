# Issue #70: 番組サイトのカスタマイズ方式の比較・採用方針

作成日: 2026-10-25。採用方針・実装状況の更新日: 2026-10-26。**管理者のレビューにより案Bを採用し、ローカル実装・検証を行った（§12）**。調査基準はmain `48488a4`。本書は方式の選択と実装範囲を定めるものであり、Cloudflare実環境の配備・公開・設定変更の承認ではない。

## 1. 採用方針

**案B「固定HTML＋標準デザイン1種類＋Showごとの任意のカスタムCSS 1ファイル」を採用する。Cloudflareの無料利用枠内での運用と、本体の単純さ・外部依存の少なさを優先し、Jekyll等をcastloop本体には組み込まない。**

- castloopは表示内容、ページ構造、新しい順の20件一覧、各回の標準音声プレイヤー、公開・停止制御を担当する。
- 管理者はCSSで色・文字・余白・幅・背景・カード表示・レスポンシブ配置等を変更できる。
- 簡単な配色変更にはCSSカスタムプロパティ（`--cl-accent`等の変数）を用意し、細かい変更には公開したclass名を使えるようにする。
- CSSはCLIで読み取り・検証・入力固定し、公開時にShow DOがHTMLへ埋め込む。閲覧時に生成・変換しない。
- 既存のprivate R2・サイトGateway・Show DOを使い、生成用Worker／DO、外部buildサービス、新たなライブラリ依存を追加しない。
- HTML構造、独自機能、任意の画像やJavaScriptまで自由にしたい管理者は、既存の外部サイト方式を選ぶ。そのサイトではJekyll・Eleventy・Astro等を自由に使える。

**「すべての好みを内蔵サイトで満たす」のではなく、「外観は小さく拡張でき、構造・機能まで変えたい場合は外へ出せる」という境界にする。** CSSだけでは足りない具体例が集まるまでは、テンプレートエンジンや汎用サイトupload機能を先回りして作らない。

## 2. 判断基準と現状

### 2.1 優先する条件

1. castloop本体と保守対象をコンパクトに保つ。公式テーマを何種類も維持しない。
2. 既定の利用者にはcastloopの単体CLI以外の実行環境を要求しない。
3. Cloudflare FreeとR2 Standardの無料利用枠を前提にし、有料化やCPU上限変更で解決しない。
4. 最新順の一覧と、その場で押せる再生ボタンを維持する。
5. 公開、更新、非公開化、復元、過去revision採用、domain変更でページと公開内容を一致させる。
6. デザイン変更のたびに共有Workerを再配備しなくてよい。

ここでいう「管理者」はcastloopを自分のCloudflareアカウントへ配備・運用する人である。匿名の閲覧者へCSSやコードのuploadを許す機能ではない。

### 2.2 第1段の実装で確認したこと

| 箇所 | 現状と検討への影響 |
| --- | --- |
| [`src/site-renderer.ts`](../../src/site-renderer.ts) | HTMLと固定CSSを依存ライブラリなしで生成する。説明はテキストとしてescapeし、JavaScriptは使わない |
| [`src/sqlite-site-content.ts`](https://github.com/simosako/castloop-v2/blob/0a96d1c7da2febf7d174591e6f4448b21bec3109/src/sqlite-site-content.ts) | Show DOが凍結した入力から生成する。最大20 HTML・合計4,000,000 bytes／batch、1 HTMLは1,000,000 bytes以下 |
| [`src/site-cache.ts`](../../src/site-cache.ts) | ページ参照にCSSのhashを保持し、対応するCSPを返す。閲覧時はR2の完成済みHTMLを配信する |
| [第1段の設計](show_website_plan.md) | Show更新は全ページ、通常のEpisode更新は全一覧と対象Episodeページを生成する。FeedとHTMLの公開参照を原子的に切り替える |
| [サイト利用ガイド](../../docs/show_website.md) | `site_mode = "builtin"`と`"external"`を提供済み。外部方式では内蔵HTMLを生成しない |
| [`packages/shared/src/index.ts`](../../packages/shared/src/index.ts) | 現在のstrictなShow schemaにCSS・テンプレート設定はない。ファイルを置くだけでは反映されない |

現在のCSS hash保存は利用できるが、**任意CSSの受付・履歴保存・安全な埋込みは新たに必要**である。「CSSを連結するだけ」の修正ではない。一方、HTML生成エンジンと公開プロトコルを全面的に交換する必要はない。

### 2.3 用語

| 用語 | 本書での意味 |
| --- | --- |
| Show DO／Gateway | 番組ごとの公開状態を管理するDurable Object／公開要求を判定・配信するアプリ内の処理 |
| snapshot／revision | ある時点の内容を保存した不変のデータ／保存済みの版 |
| lifecycle | 公開・非公開・復元等の状態と操作 |
| batch／purge | 1回の起動で生成する有限個のページ／CDNキャッシュの無効化 |
| CSP | ブラウザが適用・取得できるstyle・script・素材等を制限する応答header |
| runtime／SSR | コードを動かす実行環境／閲覧要求の時点でサーバーがHTMLを生成する方式 |

## 3. まず分けて考える3つの軸

| 軸 | 選択肢 | 注意点 |
| --- | --- | --- |
| 何を変えるか | 色等の値だけ／CSS全体／HTMLテンプレート／独自コード・機能 | 自由度が高いほど、入力・互換性・不具合対応の範囲も広がる |
| どこで生成するか | Show DO／管理者のCLI・外部build環境／閲覧ブラウザ | 静的生成ツールの採用は、閲覧時のSSRやブラウザJSの採用を意味しない |
| どこへ配信するか | 既存private R2＋サイトGateway／管理者の独立サイト | 外部ツールで作ったファイルを、現在のR2へそのまま置いても公開できない |

例えば「Eleventyを管理者がローカルで使う」と「Eleventyをcastloopの依存にする」は別案である。また、同じR2で配信したい場合は、生成ツールにかかわらずcastloopの公開・停止契約へ接続する必要がある。

## 4. カスタマイズ範囲の比較

| 案 | メリット | デメリット・保守負担 | 判断 |
| --- | --- | --- | --- |
| A. 配色・幅等の設定値だけ | 入力が小さく、構造や必須機能を壊しにくい。CSSを知らない人にも説明しやすい | 設定項目にない表現はできない。要望に応じてTOML項目やプリセットが増えやすい | 単独では自由度不足。値はBのCSS変数として提供し、専用設定項目は増やさない |
| **B. 固定HTML＋カスタムCSS** | 依存追加なし。既存の事前生成を維持できる。標準デザインは1種類でよい。管理者のruntime追加も不要 | HTML構造・表示内容・機能は変えられない。公開class名の維持が必要。CSSで表示や操作を壊すこともできる | **採用済み** |
| C. HTMLテンプレートを差し替え、Show DOで生成 | 構造や表示順を変更できる。公開受付後はサーバーだけで完了でき、lifecycleにも同じテンプレートを使える | テンプレート処理系、変数仕様、escape規則、出力制限、必須要素の扱いが増える。任意コードや無制限処理は許せない | CSSで解決できない構造変更が実際に必要になった場合の再検討候補 |
| D. 管理者のJS/TS rendererで生成し、内蔵サイトとしてupload | 任意のレイアウトを作れ、生成CPUを端末側へ移せる。Ruby等は不要 | 別のJS実行環境、または単体CLIでユーザーコードを実行する仕様が必要。生成物承認、古い入力の拒否、lifecycle時の再生成手順まで増える | 現時点では非推奨。JS/TSなので本体が小さくなるとは限らない |
| E. Jekyll等の静的サイト生成ツールを標準採用し、内蔵サイトとしてupload | 既存のテンプレート・テーマ・開発用previewを利用できる。HTMLの自由度が高い | build環境、依存更新、データ変換、生成物承認が必要。一般テーマがPodcastの要件を満たすとは限らない | 本体への標準組込みは非推奨。ツール別比較は§5 |
| **F. 外部サイト方式で、生成ツールもhostingも管理者が選ぶ** | castloopに生成エンジンを追加しない。HTML・機能・追加ページまで自由。既存方式を使える | 別サイトのbuild・配備・更新は管理者の責任。castloopの停止では外部HTMLのコピーを消せない | **Bで足りない人向けの推奨経路**。自動連携やexportは今回追加しない |

FでもcastloopによるRSS・カバー・音声の配信は続けられる。ただし、現在の外部サイト方式は番組紹介先のURLを指定する機能であり、Episodeデータのexport・サイトの自動生成／同期／配備は提供しない。外部サイトの費用・無料利用枠も、そのhosting先で別途確認する必要がある。

### 4.1 Bで変えられるもの・変えられないもの

| 内容 | CSSのみでの対応 |
| --- | --- |
| 色、書体の指定、余白、幅、枠、影、角丸、背景色 | 対応できる。フォントは端末のsystem fontを使う範囲を基本にする |
| 既存要素のカード化、Grid／Flexによる配置、画面幅・配色設定への対応 | 対応できる。ただし読み上げ・キーボードの順序は元のHTML順が基準になる |
| 一覧だけ／Episodeページだけの見た目変更 | ページ種別を表すclassを用意すれば対応できる |
| ブラウザ標準音声プレイヤー | 周囲の配置や幅は変更できる。内部ボタンまで全ブラウザ共通のデザインにはできない |
| 日付の表示形式、抜粋する長さ、表示するmetadata、一覧順、20件という件数 | CSSの責務ではない。必要ならcastloopの表示仕様として別途改善する |
| 新しい記事・ページ・メニュー項目、検索、独自プレイヤー、連続再生 | 対応しない。テンプレート変更だけで済むとは限らず、別機能の設計が必要 |
| 外部font、任意の背景画像、広告、外部埋込み、任意JS | 推奨する初期範囲には含めない |

CSSで必須要素を非表示にすること自体は防げない。**castloopは必須要素をHTMLへ出力し、標準デザインでは利用可能にするが、管理者のCSS適用後も必ず操作できるとは保証しない。** カスタムCSSの確認は管理者の責任とし、その制限をCSSの独自解析で完全に防ごうとしない。

### 4.2 Cを選ぶ場合の境界

Show DOで扱うなら、データの差込み・条件分岐・有限件数の繰り返しに限定した既存のテンプレート処理系を検討する。JS評価、外部通信、ファイル読取、任意プラグインは許可しない。独自のテンプレート言語も作らない。

ただし、処理系を1つ選んでも、公開データの変数名、URL helper、escape規則、一覧とEpisodeのテンプレート、CSSとの組合せ、必須playerを誰が出力するか、出力上限はcastloop側の契約として残る。テンプレート内にplayerの場所を自由に指定できるなら、欠落時の扱いも決める必要がある。

固定のplayer等をcastloopが挿入し、外枠だけ変更可能にする中間案もある。必須機能を保ちやすい反面、差込み箇所という独自仕様と自由度の制限が増える。**現在は、その中間方式まで設計・実装しない方が小さい。**

## 5. 静的サイト生成ツールを使う場合の比較

静的サイト生成ツール（SSG）は、テンプレートとデータから配備前にHTML等を作るツールを指す。以下は、管理者端末または管理者が用意するCIでbuildする場合の比較である。**どのツールもWorkers／DO上でbuildする案にはしない。**

| ツール | 管理者側の追加環境 | 長所 | 本件での短所 | 判断 |
| --- | --- | --- | --- | --- |
| **Jekyll** | Ruby、RubyGems／Bundler。公式installationは開発header・GCC・Makeも要件に記載 | 著名で資料とテーマが多い。Liquidのlayout／include、CSSやSassの変更で設計できる | TS/JS以外の依存・更新管理が増える。既存テーマのposts・URL・pagination等をcastloopのデータへ合わせる必要がある | 既存Jekyll利用者の外部サイトには有力。本体標準には選ばない |
| **Eleventy** | JavaScript runtime（通常Node.js）とnpm等による依存管理 | HTML中心で、Liquid／Nunjucks／JS等のテンプレートとデータを利用できる。静的HTML中心の本件に合う | データ変換、固定URL、一覧とplayerのテンプレートは必要。単体CLIだけの運用ではなくなる | **将来SSG用の任意サンプルを1つ作るなら第一候補**。今は同梱しない |
| **Astro** | Node.jsとnpm等による依存管理 | TS/JSとの親和性、component単位の開発、静的出力、テーマや開発環境がある | component・build設定・依存更新の面積が増える。今回の単純な一覧には採用機能が多い | componentで構造を作り込みたい外部サイト向け |
| **Hugo** | 基本は配布済みHugo実行ファイル。選ぶテーマ・機能によって追加ツール | 本体を使うためにGo compilerを常に用意する必要はない。静的サイト向けの機能が揃う | Go templateの学習と別binaryの管理が必要。テーマ依存やデータ変換の問題は残る | 「非TS/JS＝必ず重いbuild環境」ではない例。ただし本件の標準採用を正当化するほどではない |

SSGの利用だけでブラウザJSやSSRが必須になるわけではない。Eleventy・Astro等でも静的HTMLと標準`audio`を出力できる。逆に、選んだテーマが外部font・script・inline style属性を要求すれば、現在のCSPとはそのまま互換にならない。

また、**多数の既存テーマがあることと、castloopへそのまま適用できることは別**である。Podcast一覧の各回にplayerを付ける、承認済み音源を参照する、固定Episode URLと公開日時順を守る等の調整は必要になる。castloopが公式に特定SSGを採用すると、その接続部分と対応versionの保守も引き受ける。

「SSGのCSSだけ取り出して内蔵サイトへ適用する」場合も、そのCSSが想定するHTML構造やclass名と一致するとは限らない。既存テーマを無調整で使えるとは案内しない。

## 6. 生成場所と配信方式の判断

### 6.1 生成場所

| 方式 | 利点 | 費用・制約 | 推奨 |
| --- | --- | --- | --- |
| **小さいCSSを使い、従来どおりShow DOで事前生成** | 既存の公開・lifecycle・domain再生成を維持できる。受付後はCLIの常駐不要 | CSSの検証・hash・埋込み分だけCPUと保存bytesが増える。全体のbatch予算は維持する | **採用方針** |
| テンプレートをShow DOで評価 | サーバーが確定内容だけで再生成できる | 評価量・出力上限の管理と処理系の導入が必要。DOのCPU上限があることを任意buildの許可と解釈しない | Cを後日選ぶ場合だけ検討 |
| JS/TSやSSGを管理者端末・CIでbuild | 重い処理はCloudflareを消費しない。既存の開発用previewを使える | 追加runtime、結果のupload・検証、CLI終了後やサーバー起点の変更との整合が必要 | 独立した外部サイトなら適切。内蔵サイトへの取込みは別の大きな機能 |
| 閲覧時SSR／ブラウザJSでデータ取得・描画 | 事前のファイル生成を減らせる | 閲覧量に生成負荷が連動するか、ブラウザJSと追加API要求が必要になる | 今回は採用しない |

**採用案でCLIへ任せるのはCSSファイルの読取・基本検証・入力固定まで**であり、画像・音声の解析場所は従来のCLIのまま、HTML生成は従来のShow DOのままである。Sass、Tailwind等を使いたい管理者は、自分の環境で最終的な通常CSSへ変換して渡す。castloopはそれらを自動実行しない。

### 6.2 外部buildの結果を同じR2へ取り込む場合に増えること

CLI生成はCPUの移動にはなるが、次の仕事はなくならない。

- 生成入力を「公開済みsnapshot＋今回の明示変更」に固定する。ローカルdraft全件や、非公開Episodeを含む管理API応答をそのままexportしない。
- 対象Show、runtime/config、旧公開世代、変更内容、生成物のhash・size・URL集合を結び付け、公開直前に古い入力でないと確認する。
- HTML・CSS・画像等の候補を一意keyへ保存・照合し、必要なpurge後だけ公開参照を切り替える。任意prefixへのuploadを公開と同義にしない。
- 非公開化・復元・過去版採用・domain変更でも、生成物を更新する手順を定義する。CLIを必要とする新しい承認段階を作るか、サーバーに生成能力を残す必要がある。
- 未知のuploadやpurgeを再送せず、途中候補や古いmanifestを公開しない。
- 任意のHTML・assetを受けるなら、許可パス、MIME、CSP、script、追加ページの公開条件も設計する。

JekyllをEleventyに変えても、ここは解消しない。**本件ではツールの依存数以上に、この公開手順の拡張が大きい。** 外部build用の汎用upload機能を、CSS対応のおまけとして追加しない。

外部のテーマやJSをbuildする場合、それらは管理者端末／CIの権限で動く。castloop本体に入れなければ安全になるわけではない。秘密を持つ環境で未確認のテーマ・プラグインを自動実行する設計にはしない。

## 7. 採用案Bの具体化

方式Bは採用済みである。以下の設定名・上限・保存方法を今回の開発版で具体化した。実装範囲は§12、正確なclass一覧と操作は[利用ガイド](../../docs/show_website.md)を参照する。公開版v0.7.5の機能や、Cloudflare実機での検証完了とは区別する。

### 7.1 管理者が置くもの

```text
my-show/
  show.toml
  cover.jpg
  site.css
  episodes/
```

```toml
site_mode = "builtin"
site_css_path = "site.css"
```

- カスタムCSSはShow単位で1ファイル。service共通設定、Episode別CSS、複数テーマ選択は追加しない。
- `site_css_path`はShowディレクトリ内の単純なCSSファイル名とする。URL・親directory指定・自動downloadは受け付けない。
- 項目省略なら標準デザイン。指定したファイルがなければエラーとし、黙って標準へ戻さない。空ファイルなら追加CSSなし。
- 外部サイト方式との同時指定は拒否する。外部サイトのCSSはそのサイト側で管理する。
- ファイル編集／`update-show`だけでは公開しない。既存の`update-show`→`publish-show`でShow全ページへ反映する。
- 標準へ戻す場合は項目を削除して明示公開する。公開後にローカルファイルを消しても、サーバー上の現在のデザインは変わらない。

ファイル名を固定して存在すれば自動採用する案は設定が1行減るが、ファイル追加が意図せず次の公開内容へ影響する。**明示的なpath指定を推奨する。** デザイン設定専用TOMLは作らず、サイト方式と同じShow設定で扱う。

### 7.2 標準デザインとCSS向けの接点

標準デザイン自体を、読みやすい文字・余白・モバイル配置・focus表示を備えた1種類へ改善する。その上で次の小さい接点を文書化する。

| 接点の例 | 用途 |
| --- | --- |
| `--cl-accent`, `--cl-background`, `--cl-text`, `--cl-muted`, `--cl-content-width`, `--cl-radius` | よく変える色・幅・角丸。CSS変数の上書きで対応する |
| `.cl-site`, `.cl-page-list`, `.cl-page-episode` | サイト全体とページ種別 |
| `.cl-header`, `.cl-show`, `.cl-cover`, `.cl-episode-list`, `.cl-episode` | 主要な配置対象 |
| `.cl-episode-title`, `.cl-episode-date`, `.cl-description`, `.cl-player`, `.cl-pagination`, `.cl-footer` | 個別の表示対象 |

これらのclassと変数を追加した。HTMLは見出し・`article`・`nav`等の意味を保ち、CSSの指定先を安定させるために必要な構造だけを整える。

```css
:root {
  --cl-accent: #8b2942;
  --cl-background: #fffaf5;
  --cl-text: #242024;
  --cl-content-width: 64rem;
  --cl-radius: 0.75rem;
}

.cl-page-list .cl-episode-list {
  display: grid;
  gap: 1.5rem;
}

.cl-page-list .cl-episode {
  border: 1px solid currentColor;
  border-radius: var(--cl-radius);
  padding: 1.5rem;
}
```

標準CSSの後にカスタムCSSを適用する。標準側は過度に詳細なselectorや`!important`を避ける。「標準CSSを完全に外すモード」は初期版に設けず、必要な箇所を上書きできるようにする。

CSS変数と公開classは互換性の維持対象とする。特定の子要素の深さや`nth-child`等まで保証しない。破壊的な変更はreleaseの変更点として明記し、旧HTMLを書き換える自動移行や複数rendererの恒久併存はしない。

### 7.3 CSSの配信方法

| 案 | メリット | デメリット | 推奨 |
| --- | --- | --- | --- |
| **HTML内の1つの`style`へ標準CSSと連結して埋め込む** | 新しい公開パス・CSS取得要求が不要。HTMLとCSSが同じsnapshotで一致する。既存のページ別CSP hashを使える | 各HTMLと履歴にCSSが重複する。CSS変更時は全ページ生成が必要 | **小さいCSSに限り推奨** |
| 不変CSSファイルをR2へ置き、HTMLから参照 | CSSをページ間で共有でき、HTMLと履歴の容量を抑えられる | CSS用の公開パス、現在承認された参照、停止判定、cache／header／purgeの接続が増える。HTMLとCSSは別HTTP要求 | 大きいCSSの実需が出た場合に比較し直す |
| 外部CSS URLを指定 | castloopへCSSをuploadしなくてよい | 外部依存・第三者通信が増える。公開後にCSSだけ変更でき、保存revisionからの再現性が崩れる。CSP緩和も必要 | 初期版では不採用 |

上限案は**カスタムCSS 65,536 UTF-8 bytes（64 KiB）**。通常は数KiB程度を想定する。無制限のCSSは受け付けない。画像のdata URL埋込みやCSSの分割importはサポートせず、CSPでも取得を許可しない。上限は無料運用の保証ではなく、現在のHTML／batch予算へ追加量を収めるための提案値である。

CSSを埋め込んだ後にも既存のHTML・batch予算を適用し、超過時は拒否する。上限を増やす、説明文を切り捨てる、CSSを自動minifyする等で黙って収めない。

### 7.4 入力固定・保存・更新

CLIは読み取ったCSS bytesを検証・正規化し、metadataと同じ公開入力へ結び付ける。公開要求の作成時には、現在のファイルと検証済み入力が一致することを確認する。

保存方法も2案ある。

| 案 | 利点 | 負担 | 推奨 |
| --- | --- | --- | --- |
| **既存のShow公開snapshotの保存形式を拡張し、小さいCSS本文を同梱** | 独立したCSS用upload・素材参照・回収の仕組みを作らずに済む。履歴と凍結入力から再生成できる | metadataの保存・要求・取得・差分の形式と容量予算を見直す必要がある | **第一候補**。編集元TOMLへCSS本文を詰め込む意味ではない |
| 別の不変R2 objectとして保存し、Show revisionにhash／size／参照を持つ | 本文とmetadataを分離でき、再利用できる | CSS素材のupload検証・参照検証・保存・取得という経路が増える | 今回の小容量1ファイルには選ばない |

保存fieldはShow metadata内の任意`site_css_path`と`site_css`、内部queue/content形式は9/10とした。ローカルTOMLにはpathだけを記述し、CLIがCSS本文を同梱する。サーバーはpathと本文の片方だけの公開入力を拒否する。既存のstrict schemaを拡張して本文を検証し、運用記録へは保存しない。fresh環境専用とし、旧DB移行・資源採用・互換fallbackは追加しない。

公開後の扱いは次のようにする。

- ShowのCSS変更はShow更新として全一覧・全公開Episodeページを再生成し、必要なpurge後に一緒に切り替える。
- Episode更新・非公開化・復元は**現在公開されているShowのCSS**を使う。手元の未公開CSSを紛れ込ませない。
- Showの過去revision採用・Show復元は、その保存内容に対応するCSSも入力として採用する。現在のEpisode公開状態と正規originは巻き戻さず、HTMLを再生成する。
- domain変更も保存済みCSSを使う。管理者端末のファイルや外部build環境を必要としない。
- code-only Worker更新だけでは既存HTMLを再生成しない。古いページは保存済みCSS hashで配信できる状態を保つ。
- 新しいCSSが不正、保存内容が欠落、hashが不一致の場合に、別CSSへ自動fallbackして成功としない。失敗の分類・旧内容配信可否は既存公開契約に従う。

### 7.5 HTMLへの埋込みとブラウザ側の制限

CSSの書き手は管理者だが、コピーした第三者CSSにHTMLの終了タグ等が含まれる可能性はある。タイトル等の通常テキストとは別の埋込み規則が必要である。

- 不正UTF-8やNULを拒否し、改行はLFへそろえてから保存・hash計算する。CSPのhashとHTML中の実際のCSS本文を一致させる。
- 大文字小文字を区別せず`</style`を含む入力は拒否する。文字列・コメント内でも同じ制限とし、黙って削除・変換しない。`style`を閉じてHTMLを挿入する経路を作らない。
- CSSを普通のHTML本文としてescapeすると意味が変わるため、その方法を使わない。一方、Show／Episodeの説明をCSSへ展開する機能も作らない。
- 標準CSS＋カスタムCSSの実際の埋込み本文のSHA-256をページ参照に保持し、現在と同じhash方式の`style-src`で許可する。`unsafe-inline`へ緩和しない。
- `script-src 'none'`、同一originの画像・音声、`default-src 'none'`等の現在の制限を維持する。外部CSSの`@import`、外部画像、Web font等を使うためにCSPを広げない。
- CSSの全構文を独自に解析・安全化する機能は作らない。`@import`等の取得制限はCSP、同一originの素材取得は既存の許可パスと公開gateで制御する。利用できない指定は文書とpreviewで説明する。

hashはそのCSSの適用を許可する根拠であり、デザインの品質保証やCSSの無害化ではない。管理画面・管理用秘密を公開HTMLへ出さない既存境界も維持する。

### 7.6 確認方法とサポート範囲

最初はCSSの説明、公開class／変数の一覧、1つの小さい変更例を用意する。公式テーマ配布、テーマcatalog、package解決、自動更新、GUIのデザイン編集機能は作らない。

標準デザインと変更例では、スマートフォン幅、長いタイトル・説明、一覧とEpisodeページ、focus表示と音声操作を確認する。必要なローカルpreviewは同じrendererを使う小さい仕組みとして別途具体化し、previewのためにSSGを導入しない。ローカルでの見た目確認と、本番のCSP・配信・Free性能の検証は区別する。

## 8. Cloudflare Freeと容量・負荷

2026-10-25に確認した公式資料では、通常WorkerのFreeは100,000要求／日・HTTP CPU 10ms。SQLite-backed DOはFreeで利用でき、要求100,000／日、duration 13,000 GB-s／日、SQL読取500万行／日・書込10万行／日・保存5GB。DOの既定CPU上限は通常Workerの10msとは異なるが、SSG buildの実行根拠にはしない。

R2 Standardの無料枠は10 GB-month／月、Class A 100万回／月、Class B 1,000万回／月であり、音源・既存履歴・新しいHTML等をアカウント全体で合算する。R2の超過分は従量料金になり得る。Workers／DOのFree上限超過は処理失敗になり得る。

採用案の追加負荷は主に公開側のCSS検証・hashとHTML bytesである。閲覧時のCSS解析はブラウザが行う。WorkerでCSSを毎回連結・parse・hashし直さず、既存のページ参照と完成済みHTMLを使う。

容量の例として36 Episode・一覧2ページでは、全ページ再生成が38 HTMLになる。

- 10 KiBのCSSを埋め込むと、1回の全生成につきCSS部分だけで389,120 bytes増える。
- 上限案64 KiBなら、同じ条件で2,490,368 bytes増える。標準CSS・HTML・生成履歴は別途加算する。
- 最大20 HTMLのbatchならカスタムCSS分は最大1,310,720 bytesとなるが、HTML全体には引き続き4,000,000 bytesの予算を適用する。

CSS更新の頻度が高い大規模Showでは重複が効いてくる。その実需があれば、§7.3の独立CSS object案を再検討する。今回は小さいファイルと単純な配信を優先し、履歴の自動削除で無料枠へ押し込まない。

CSSを埋め込む案ではCSS用の公開要求を追加しない。ただし、既存の外側Worker・内部cache entrypoint・Show DOの判定は残り、CDN HITでも無料・無制限のページ配信になるわけではない。CSSだけの対応でFree適合を証明したとも説明しない。

## 9. 採用案の最小開発範囲と確認項目

採用したBの開発・検証範囲を以下に示す。今回の確認結果と未確認範囲は§12で区別する。

1. 標準デザイン1種類を改善し、必要最小限のHTML classとCSS変数を文書化する。
2. Show単位の任意CSS入力、サイズ・文字・埋込み検証、入力固定、Show snapshot・履歴への保存を接続する。
3. Show／Episode公開、非公開化・復元、過去revision採用、RSS import、domain再生成に、正しい保存済みCSSを渡す。CSS変更は明示Show公開に限定する。
4. 実際のCSS本文に対応するCSP hash、旧HTMLの配信、生成予算と失敗時の非公開条件を検証する。
5. 利用ガイドと1つのCSS例を更新し、`bun test`・`npm run check`と単体CLIの検証を行う。実機更新・公開・性能測定は対象と範囲の別承認後に行う。

特に確認する回帰は、指定ファイル欠落・上限超過・不正UTF-8・大小文字を変えた`</style`、CSP hashと改行、staleなローカルCSS、CSS変更後の全ページ一致、過去版採用・復元・domain再生成、HEAD／304と停止判定、生成途中／purge失敗での未公開維持である。第三者CSSで可能なあらゆる見た目を保証する試験には広げない。

## 10. 採用方針と具体化の候補

方式Bと、Free枠・単純さ・外部依存を増やさない方針は採用済み。設定名・64 KiB上限・保存fieldも今回の開発版で§7のとおり具体化した。

| 論点 | 方針・具体案 |
| --- | --- |
| 本体に用意する自由度 | **B: 固定HTML＋標準デザイン1種類＋任意CSS 1ファイルを採用済み**。CSS変数とclass名を小さい拡張接点にする |
| 公式デザイン | 読みやすい標準1種類のみ。テーマの大量提供・維持はしない |
| HTML生成場所 | **Show DOの事前生成を維持**。CLIはCSSの読取・検証・入力固定を担当 |
| CSSの反映 | Showの明示公開で全ページを更新。Worker再配備は不要 |
| CSSの保存・配信 | 小容量本文をShow snapshotへ同梱し、HTMLへ埋込み。上限案64 KiB。別CSS公開経路は作らない |
| テンプレート・JS・追加asset | 初期範囲には含めない。CSS不足の具体例が出た時点で再検討 |
| Jekyll等の標準依存 | 追加しない。任意の外部サイトで利用できる。将来SSG用サンプルを作るならEleventyを第一候補とする |
| 高度な変更 | **F: 既存の外部サイト方式**。独立したbuild／配備とその責任を明記する |

これにより「標準のまま使う人」「CSSだけ書く人」「独立サイトを作る人」を分けられる。最初の2者のために一般的なサイトフレームワークを内蔵せず、最後の利用者の選択肢も閉じない。

## 11. 参照資料

2026-10-25に公式資料を確認。仕様・料金の調査であり、各ツールのcastloop組込み試験やCloudflare実機性能測定は行っていない。

- [第1段のサイト設計](show_website_plan.md)、[利用ガイド](../../docs/show_website.md)、[非公開試験の結果と未確認範囲](show_website_private_trial_verification_20261025.md)。
- Jekyll: [Installation](https://jekyllrb.com/docs/installation/)、[Themes](https://jekyllrb.com/docs/themes/)、[Layouts](https://jekyllrb.com/docs/layouts/)。Ruby等の要件、themeの上書きと依存、Liquid layoutの根拠。
- Eleventy: [Get Started](https://www.11ty.dev/docs/)、[Template Languages](https://www.11ty.dev/docs/languages/)。JavaScript runtime、静的出力と複数のテンプレート形式。
- Astro: [Installation](https://docs.astro.build/en/install-and-setup/)、[Deployment](https://docs.astro.build/en/guides/deploy/)。Node.js環境とローカルbuild・静的出力。
- Hugo: [Installation](https://gohugo.io/installation/)、[Linux installation](https://gohugo.io/installation/linux/)。配布binaryを使う選択肢。テーマ固有の追加依存まで不要とは扱わない。
- Cloudflare: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)、[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[R2 pricing](https://developers.cloudflare.com/r2/pricing/)。
- MDN: [CSP style-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src)。inline CSSのhash許可、本文の空白等とhashの一致、外部stylesheetの制限。

## 12. ローカル実装・検証と未確認範囲

今回の開発では、標準デザイン1種類、公開class／CSS変数、任意CSS入力、保存・公開・履歴参照・項目差分、CSP hashを接続した。新たな依存ライブラリ、公開CSSパス、別Worker／DO、buildサービスは追加していない。閲覧時のHTML生成も行わない。

- `readShowPublicationInput`が元TOMLを編集せず、CSSを読取・検証・LF正規化してupload用TOMLへ同梱する。既存の不変staging snapshot、readback照合、再開・公開前の入力照合にも同じ内容を使う。
- CSSの参照・本文はShow revisionのmetadata hashに含む。通常公開・Episode lifecycle・Show過去版採用・domain再生成・RSS importへ接続した。
- 保存済みCSSからShow DOがHTMLを生成する。HTML本文と同じCSSのhashをページ参照に保存し、既存CSPの制限を維持する。
- 内部queue/content形式は**9/10**。第1段8/9を含む旧環境への互換配備・変換は行わない。サービス設定version、DO／cache class名・binding・compatibility dateは変更しない。

ローカル確認:

- `bun test`: **806成功・0失敗、92 files、12,350 expects**。
- `npm run check`: 成功。
- `npm run build:cli -- linux-x64`: 成功。
- `node scripts/smoke-agent-cli.mjs dist/castloop-linux-x64`: 空PATH・source/runtime依存なしの試験に成功。
- `git diff --check`: 成功。

新たな回帰試験では、危険なCSS・不正UTF-8・NUL・symlink・欠落・サイズ超過の拒否、空CSS、LF正規化、CSS単独編集後の公開拒否、実際のCSSとCSP hashの一致、Show全ページ切替、Episode非公開化・復元、Show過去版採用、domain再生成のbatch引継ぎ、RSS importへの保存を確認した。既存の停止・purge失敗・未知IOの非再送試験も実行した。

本節のローカル開発時点ではCloudflare実環境を変更しなかった。その後、別途明示承認を受けて第1段試験環境を削除し、[通常サイズ3件の新規試験](show_website_css_large_trial_verification_20261026.md)で標準デザインの公開と全量R2音源照合・未認証拒否を確認した。実ブラウザでの新しい標準／カスタムデザインの画面・操作性、nativeのCPU・要求数・DO duration・SQL・アカウント全体のFree枠への適合は未確認。無料枠内運用の前提と機能試験の成功を、実測による適合証明と混同しない。専用のローカル画面previewコマンドも追加していない。
