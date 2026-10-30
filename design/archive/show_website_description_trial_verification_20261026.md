# Issue #70: 説明文表示改善の非公開実機確認

2026-10-26。利用者の「実環境にテストデプロイし、前回同様に本人だけがアクセスできるようにする」という明示承認を受け、[通常サイズ3件の既存試験環境](show_website_css_large_trial_verification_20261026.md)を更新した。新規サービスの作成・既存環境の削除は行っていない。

追補: 上記は説明表示版の更新時点の記録。後続の別承認で、この環境を退避・削除し、[自動短縮URL・リンク表示版の新しい本人限定環境](show_website_short_url_trial_verification_20261026.md)を作成した。旧URLはレビュー先ではなく、私有証跡は保持している。

## 1. 対象と配備

| 項目 | 内容 |
| --- | --- |
| サービス | `site70-css-b1eec9cd` |
| Worker | `castloop-site70-css-b1eec9cd-f56b258a` |
| 更新前version | `2524d357-b372-438d-aba5-203d6acd13f1` |
| 更新後version | `7fa92ceb-65f8-42f2-8ab3-45870af2c78a` |
| Show | `site70-normal`、`[TEST] OTF Talk`、通常サイズのEpisode 3件 |
| ソース | `48488a4`を基点とする未commit開発版。配備したLinux単体CLI・tracked差分・untracked sourceのhashを私有証跡へ保存 |
| 保存形式 | 内部queue/content 9/10を維持。既存の専用R2 bucket・DO namespaceを変更せず、変換も行わない |
| 最終状態 | Showと制御DOとも`admission_paused / ready / drained`、待機0・実行中なし・保守拘束なし。本人向け配信は有効 |

本人用URL（前回と同じ）:

<https://castloop-site70-css-b1eec9cd-f56b258a.simosako.workers.dev/podcasts/site70-normal/>

まずAccess保護と未完了操作なしを確認し、Showの受付・配信を両方Pauseした。正式CLIのcode-only `deploy`はPUT成功と配備receiptを保存したが、DOの実行versionが旧版だったため120回の有限観測で停止した。後続GETで制御DO・対象Showの新versionと正確なprepared状態を確認し、同じ配備を`update-service-verify`で検証・初回activationした。再配備や未知操作の再送はしていない。

全体ready・保守拘束解除後、Access保護を再確認して対象ShowだけをResumeし、`update-show`／`publish-show`を1回実行した。公開jobの`succeeded`を確認して、受付だけを停止した。Worker更新だけでは保存済みHTMLが変わらないため、この明示的なShow公開で一覧1ページ・個別3ページを再生成した。音源の再uploadは不要だった。

## 2. 非公開性

更新前・更新後の再公開前・最終確認の3段階で、次を確認した。

- 既存の専用Accessアプリは対象Workerの`/podcasts/*`を保護している。Allow policyは1件だけで、本人の正確なメール1件をInclude、対象Cloudflareアカウント所属とCloudflareログインをRequireとして維持している。Everyone／Bypassは追加していない。
- アプリ・policy・共有Cloudflareログイン元をGETで照合した。ログイン元のアカウントメンバー制限は有効で、共有設定は変更していない。
- R2 managed public domainは無効、R2 custom domainは0件。Workerのcustom domainはなく、preview URLも無効。
- 一覧・個別3ページ・Feed・cover・MP3 3件へのGET／HEAD／条件付き要求、MP3へのRange要求は、各段階**30件すべてAccessログインへの302**であり、未認証者へコンテンツを返さなかった。
- 鍵なし管理healthは401、`/`・`/podcasts`・`/system/test`・`/staging/test`は404。管理者鍵認証を無効にしていない。

本人以外の認証済みアカウントを使った実ログイン試験はしていない。本人限定の設定照合と未認証拒否の確認を、その試験の代わりに成功と記録しない。後続の本人レビューで、表示は問題なく、「全文を読む」とタイトルクリックの両方でEpisode全文を読めたとの報告を得た。

今後の試験でも同じ境界を守るため、[`AGENTS.md`のSafety boundaries](../../AGENTS.md#safety-boundaries)へ「全テストデプロイは承認されたレビュアー限定とし、保護確認前にサンプルをupload／publishしない」という共通指示を追加した。具体的な手順は[非公開試験案](show_website_private_trial_plan.md)を参照する。推測しにくいURLやnoindexだけでは非公開扱いにしない。

## 3. 生成内容とデータ保全

管理者認証付き読取・private R2 RESTで、確定済み世代の内容を確認した。Accessを迂回する閲覧用tokenや公開コピーは作成していない。

- Feed／サイト世代は4から5へ進み、新しい一覧は3 Episodeを新しい順に表示する。3件とも説明はタグなし先頭160文字＋省略記号で、説明文と「全文を読む」が対応する個別ページへのリンクになっている。
- 個別ページは元の説明から生成した全文と一致し、固定の`p`／`br`だけで本文を再構成している。3件の段落数は21／38／28、改行数は7／15／10。元の属性やリンクタグ・scriptは本文へコピーしていない。
- 一覧は標準audio player 3個・`preload="none"`を維持する。個別ページも既存の同じ音源URLを参照している。追加JavaScriptはない。
- Episode 3件の公開metadata・audio参照は更新前後で一致する。元サンプル8ファイルのSHA-256も不変である。
- 更新前のR2全32 objectのkey・size・ETagは更新後も一致する。MP3のkey集合に増減はなく、音源は再uploadしていない。新しいHTML・Show公開snapshot・Feed・cover・stage素材の9 objectが増え、全41 objectとなった。既存履歴は削除していない。
- 確定参照のFeed世代4／5とcover世代1／5をそれぞれGETし、更新前後のbytesのSHA-256一致を確認した。試験補助コードが最初にcoverもFeedと同じ旧世代4と仮定して404になったが、保存snapshotのcover世代1を照合して期待値を訂正した。アプリ変更・再公開はしていない。

エージェントによる確認は保存済みHTML・参照・アクセス制御の確認であり、本人のブラウザ確認とは区別する。後続の本人レビューでは新画面と全文への導線も正常との報告を得た。更新前の画面については、本人から再生に問題がないとの報告を受けている。レビュー後に追加したHTTP(S)リンク復元・フッター削除は、この配備版には含まれない。

## 4. 検証範囲と証跡

- 配備前にTypeScript検査、Linux単体CLI再build、empty PATHでの単体CLI smokeを実行し、成功した。実装時の全814テスト成功は[実装記録](show_website_description_display_plan.md#112-確認結果と制約)に記載した。この作業ではアプリコードを変更せず、全テストの再実行はしていない。
- 有料upgrade・CPU上限変更・追加の生成サービス・DNS／証明書の変更はしていない。保持サービス`sq16r-6ec01dc6`は変更対象外とした。
- 本人は今回の表示と全文への移動を確認した。Cloudflare上のCPU・duration・Free日次消費、今回更新後の再生／seekの再確認・スマートフォン・キーボード操作は未確認。3 Episodeの成功を大量EpisodeのFree適合保証にはしない。
- 私有証跡はメインcheckoutのGit対象外 `.local-test-data/results/20261026/site70-css-b1eec9cd/description-update-8f0bf0bf/`。更新journal・配備receipt・CLI結果・Access設定照合・生成HTML・R2一覧を保持する。鍵・本人メール・未公開操作IDを本書へ転載しない。

試験環境とローカル証跡は次の明示的な指示まで保持する。
