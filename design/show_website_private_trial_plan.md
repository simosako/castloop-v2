# Issue #70: 非公開の画面確認・Cloudflare実機試験案

作成日: 2026-10-25。対象実装はローカルcommit `5c61901`。**計画作成時点では、配備・資源作成・Access設定・公開操作は未実施だった。** 既存サービスやアカウント全体の設定は変更しない。

追補: 本書作成後、利用者の明示承認を受けて専用環境を配備した。[実施結果と本人確認待ちの範囲](archive/show_website_private_trial_verification_20261025.md)を参照する。以下の「未実施」は計画作成時点を示す。

## 1. 推奨する構成

**試験専用の新規castloopサービスを通常のworkers.devに配備し、`/podcasts/*`全体をCloudflare Accessで保護する。Cloudflareログインと本人のメールアドレスを条件に、本人だけが閲覧できるようにする。**

```text
Browser
  → Cloudflare Access: Cloudflare login + account membership + exact allowed email
  → trial Worker: existing HTML Gateway / approved-media Gateway
  → trial Show DO / separate HTML and media caches
  → trial private R2 bucket

castloop CLI
  → /admin/*: existing administrator-key authentication
  → trial Show DO / control DO
```

一般のインターネットから接続できるURLではあるが、未認証の利用者には番組コンテンツを返さない。ネットワーク自体を非公開にするVPN方式とは異なる。

独自domain・DNS変更・追加のpreview用Workerは不要。実装したHTML生成、R2保存、CDN、Show判定、MP3 Range配信をそのまま試せる。Accessの認証はWorker実行前に行われるので、試験用の認証処理を通常Workerへ追加しない。

## 2. 方式の比較

| 方式 | メリット | デメリット・今回の判断 |
| --- | --- | --- |
| **A: 新規サービス＋コンテンツパスだけAccess保護** | 実装済みの全経路を試せる。Cloudflareログインを利用可能。CLIの管理通信は既存の認証方式のまま。DNS変更不要 | Zero Trustと対象パスのAccess設定が必要。管理URLはAccess対象外だが、従来の管理者鍵認証を維持する。**第一推奨** |
| B: 新規サービスのWorker全体をAccess保護 | すべての入口をまとめて保護でき、保護漏れを把握しやすい | CLIの管理HTTPもAccessで止まる。現在のCLIはAccessのservice tokenヘッダーを送らないため、追加対応が必要。初回の画面確認には採用しない |
| C: HTML・音源の確認用コピーを別Workerに置き、全体をAccess保護 | 本体CLIの認証を変えず、見た目・音声だけを共有できる | 別の配信処理やURL調整が必要。Show判定・公開切替・実際のcache経路の検証にならない。見た目だけを切り離して確認するときの第二案 |
| D: localhostで表示、必要ならSSH転送 | Cloudflare資源も外部公開URLも不要。最も閉じた状態で確認できる | Cloudflare上のR2・DO・CDN・Accessを試せない。ローカル画面の補助確認向け |

URLを知らせないだけ、`noindex`だけ、推測しにくいShow IDだけの方式はアクセス制限にならないため採用しない。

### Version URL／新しいPreviewsについて

Cloudflareの**Version URL（旧称preview URL）**はDOを実装するWorkerでは生成されず、通常のWorkerと資源も分離しない。今回のサービスの代替にはしない。

2026年の新しい**Previews**は別機能で、専用DO namespaceを作る仕組みがある。ただしR2は別資源へのbindingが必要で、現在のcastloopのREST配備・実version/namespace照合・fresh initはこの管理方式へ接続していない。初回確認のために導入・既存資源採用を追加せず、独立した通常の試験サービスを使う。

## 3. 「Cloudflareにログインしている本人だけ」の設定

Cloudflare Accessは、Cloudflare自身をログイン元（identity provider、本人確認を行うサービス）にできる。Google等の別ログインサービスは必須ではない。

推奨する許可条件は**同じ1つのAllow policy**で次のように組み合わせる。

| ルール | 条件 |
| --- | --- |
| Include | 本人の正確なメールアドレス1件 |
| Require | 対象Cloudflareアカウントのメンバーであること |
| Require | ログイン方法がCloudflareであること |

新しくCloudflareのログイン元を設定する場合は`Restrict to account members`を有効にする。既存の共有ログイン元は、この試験のために変更しない。その場合も対象policyのRequireでアカウント所属を必須にする。他の許可policyから条件を迂回できないことも確認する。「アカウントメンバー全員」を許可するだけでは、他のメンバーがいる場合に本人限定にならない。

Includeの複数条件はOR、RequireはANDである。本人メールとメンバー条件を別々のIncludeや別々のAllow policyにすると許可範囲を広げるため、そのようには設定しない。コンテンツパスにEveryoneのAllow／Bypassを置かない。

Cloudflare Dashboardにログイン済みでも、最初にAccess側の認証・セッション確立が必要な場合がある。「Dashboardログインだけで、未設定のURLが自動的に本人限定になる」という意味ではない。

メールのワンタイムPINに本人アドレスだけを許可する代案もある。ただしこれは「そのメールを受信できる本人」の認証であり、Cloudflareログインの確認とは異なるため、今回はCloudflareログイン方式を推奨する。

### 保護する範囲と迂回防止

- 対象は**新規試験Workerのworkers.devホストにある`/podcasts/*`全体**。HTMLだけでなく、Episodeページ・cover・MP3・Feedも同じ保護範囲に含める。
- 現行の公開パスはすべてその配下である。`/podcasts`そのものは公開コンテンツを返さない。ワイルドカードは親パス自体を含まないため、実際の一致範囲を確認する。
- `/admin/*`は既存の管理者鍵認証を維持し、鍵なしの管理要求が拒否されることを確認する。AccessのBypassで管理認証を無効にする変更はしない。
- R2はprivateのまま。`r2.dev`、R2公開domain、別の公開hostnameを設けない。Version/Preview URLを無効にした現行配備設定も維持する。
- アカウント全体の「Protect all Workers」は変更しない。既存のAccess設定がある場合、より具体的なhostname/path policyの優先順位を確認し、既存サービスへ影響を与えない範囲だけで設計する。

## 4. サンプルデータ

指定ディレクトリを読取専用で調査した結果:

| データ | Episode数 | MP3合計 | 用途 |
| --- | --- | --- | --- |
| `~/project/castloop-v2/.local-test-data/minimal/` | 3 | 801,568 bytes（約0.80 MB） | **初回推奨**。3回入りShowを最小のupload量で確認できる |
| `~/project/castloop-v2/.local-test-data/normal/` | 36 | 1,496,055,589 bytes（約1.50 GB） | 後続確認で2〜3回だけ選ぶ。1回約29.5〜62.9 MBで、長い番組・実データの表示やseek確認に使う |

初回はminimalの3 Episodeとcover・番組情報を、**別の新規試験workspaceへコピー**する。元ファイル・元`.castloop/`・`import.json`は変更しない。既存のjournal、管理鍵、資源identityはコピー・採用しない。

新しい試験Show IDを割り当て、コピー側のShow metadataだけを対応させ、`site_mode="builtin"`とする。Episode ID・GUID・公開日時はサンプルの値を維持する。通常のCLIで新規ShowとEpisodeを登録・stage・明示publishし、今回のサーバー生成経路を通す。取り込み記録を書き換えて部分RSS importを装う方法は使わない。

## 5. 一般閲覧できる時間を作らない順序

1. 対象アカウント、未使用の試験サービス名・workspace、許可メールとAccess構成を確認し、変更範囲の承認を得る。
2. 空の新規サービスをfresh initする。この時点ではサンプルをupload／publishせず、未認証者へ番組内容を返さない。
3. 対象コンテンツパスにAccessを設定する。未認証要求がWorkerの番組応答ではなくAccessのログイン要求／拒否になることを先に確認する。
4. 保護が確認できてから、試験Showだけを明示Resumeし、サンプル3 Episodeを公開する。通常の`published`状態は使うが、インターネットからの閲覧には常にAccess認証を要求する。
5. 各jobの`succeeded`、ready・drained、未認証拒否、本人ブラウザの表示・再生を確認し、本人用URLを渡す。
6. レビュー待ちでは試験Showを`admission_paused`にする。新しいupload／公開依頼は止め、本人はAccess経由で既存ページを見られる状態を保つ。

保護確認に失敗した場合はサンプルを公開せず停止する。未知の資源作成・PUT／POST・公開結果を再送せず、journalと試験対象を保持する。レビュー後の完全Pauseや削除は別の明示指示で行い、自動cleanupはしない。

## 6. 確認内容

### 非公開性を先に確認

- ログアウト状態・プライベートウィンドウ・認証cookieなしのHTTPで、一覧、Episodeページ、cover、Feed、MP3を取得できない。
- 本人が一度表示してCDNが温まった後も、未認証者に本文・音源を返さない。HEAD、If-None-Match、MP3 Rangeでも確認する。
- 本人だけログイン成功。他のメール／別アカウントは拒否される。必要な別ユーザーによる試験は本人に協力してもらい、他人の認証を代行しない。
- URLの直指定、別hostname、private R2への直結で保護を迂回できない。秘密のcookie・tokenを共有URLやGitへ入れない。

### 本人による画面確認

- 番組名・説明・カバー、3 Episodeの新しい順の表示、固定Episodeページへのリンク。
- 一覧とEpisodeページでPlay／pause／seek。音源は同じホストなので、ブラウザのAccessセッションcookieを使い、独自playerへtokenを渡す必要はない。
- 可能ならデスクトップとスマートフォンの両方で表示・操作する。Accessセッション切れ時は再認証する。
- metadataの変更、公開切替、Pause／再開は必要な試験項目として承認した範囲でだけ実行する。

FeedやOGP用画像も本人限定になるため、一般のPodcastアプリやSNS botから読めないことは意図どおりである。今回は一般公開の購読・SNS展開の受け入れ試験にはしない。

3 Episodeでは20件ページ分割や大規模batchの実機評価はできない。FreeのCPU・cache HIT/MISS・DO・R2の観測も、収集できた範囲を記録し、欠測を成功や0msとして扱わない。

## 7. Free契約と実施前の確認

- Cloudflare Zero Trust Freeの50ユーザー枠を前提とする。本人1名の許可で足りるが、既存組織の利用席・契約・有効機能は実施前に確認する。Worker FreeとZero Trust Freeは別の枠である。
- Worker／DO／R2の消費はアカウント共通。Accessを設けても生成・配信の無料枠が増えるわけではない。初回のMP3は約0.80 MBだけにし、normalの36回を一括uploadしない。
- Paidへのupgrade、CPU上限変更、不要な権限付与は行わない。必要なAccess設定権限がない場合はDashboardで本人に設定してもらうか、対象を限定した権限について別途確認する。
- 実施には対象アカウント、本人の許可メール、Zero Trustの現状、試験用資源・Access設定・試験ShowのResume／公開への明示承認が必要。本書の作成やローカルcommitはその承認の代わりではない。

## 8. 確認した一次資料

2026-10-25の計画作成時に公開資料を確認した。その時点では対象アカウントへの認証付き照会・変更はしていなかった。

- [WorkersとCloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/): Worker全体／hostname／path保護、評価順序、Worker前の認証。
- [Cloudflareをログイン元にする](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/): Cloudflareログインとアカウント所属の確認。
- [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/): メール・ログイン方法・Cloudflare Account Member、Include／Requireの意味。
- [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/): ワイルドカードと親パス、具体的なパスの優先。
- [Zero Trust Freeの50ユーザー枠](https://developers.cloudflare.com/reference-architecture/architectures/sase/)、[席の管理](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/)。
- [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/): DOの制約と、資源が分離されない点。
- [Previews](https://developers.cloudflare.com/workers/previews/): 新しい別機能であること、設定・資源分離の範囲。
