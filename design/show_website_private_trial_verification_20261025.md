# Issue #70: Access保護付き番組サイトの実機試験

2026-10-25。[試験計画](show_website_private_trial_plan.md)に沿って、利用者の明示承認後に専用サービスを新規配備した。**サーバー側の公開処理・未認証アクセスの拒否に加え、本人からアクセス成功とブラウザでの3 Episode再生成功の報告を得た。**

## 1. 対象と保持状態

| 項目 | 内容 |
| --- | --- |
| 実装commit | `5c61901`（Issue #70開発版） |
| サービス | `site70-1cd434d0` |
| Worker | `castloop-site70-1cd434d0-55d8a35b` |
| Worker version | `e5135bac-89e7-4745-871f-d74c7136615c` |
| private R2 bucket | `castloop-site70-1cd434d0` |
| Show | `site70-demo` |
| 最終状態 | `admission_paused`、`publication_ready=true`、`drained=true`、配信有効 |
| 内容 | minimalのShowと短尺Episode 3件。MP3合計801,568 bytes |

本人用URL:

<https://castloop-site70-1cd434d0-55d8a35b.simosako.workers.dev/podcasts/site70-demo/>

URLを知っているだけでは閲覧できない。新規受付を止めた状態で、Access認証後の閲覧を維持している。試験資源・原本・journal・証跡は保持し、自動削除しない。

## 2. Accessと非公開性

- 既存のCloudflareログイン元を再利用した。APIの参照権限追加後、設定済みであることと`restrict_to_account_members=true`を確認した。既存ログイン元の変更・再作成はしていない。
- 試験Workerの`/podcasts/*`専用にAccessアプリを作成した。許可するログイン元はCloudflareのみ。
- Allow policyは1つだけ。Includeは本人メール1件、Requireは対象Cloudflareアカウント所属とCloudflareログイン。Everyone許可・Bypass・service tokenによる別経路は設けていない。作成後のGETで保存内容を照合した。
- `/admin/*`の既存管理者鍵認証を維持した。鍵なしの`/admin/health`は401、`/`と`/podcasts`は404だった。
- R2のmanaged public domainは無効、custom domainは0件。Workerの`previews_enabled=false`も照合した。DNS・独自domainは追加していない。

サンプルのupload前に、一覧・Episodeページ・画像・Feed・音声の5パスが認証cookieなしでAccessへの302になることを確認してから登録・公開した。

公開完了・受付停止後は、生成HTMLから実際の画像・音声URLを取得し、次の**30要求すべてがAccessへの302**になることを確認した。コンテンツ本文・音源・304応答は返っていない。

- 一覧、Episodeページ3件、Feed、cover、MP3 3件のGET／HEAD／`If-None-Match: *`。
- MP3 3件の`Range: bytes=0-31`。

最初のPython標準User-Agentによる要求はCloudflareのBrowser Integrity Checkで403／error 1010になった。この結果をAccess成功とは数えず、[公式案内](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)に沿うアプリ識別User-Agentで再確認した。アカウント側の保護設定は変更していない。

## 3. 公開処理と生成物

1. 単体CLIのfresh initで専用Worker・DO・private R2を作成し、実機のSQL／Alarm／R2／cache purge動作確認を完了した。
2. Showを新規登録し、明示Resume後にShowとEpisode 3件を通常CLIでstage・publishした。**4公開jobすべてが`succeeded`**。RSS取り込み記録の改変やR2へのHTML手動配置は使っていない。
3. minimalのcover・Episode TOML・MP3だけを専用workspaceへコピーした。元の`.castloop/`・`import.json`はコピーせず、元ファイルのSHA-256が変わらないことを確認した。Episode ID・GUID・公開日時を維持し、Show IDと内蔵サイト方式だけを変更した。
4. 最新一覧のR2保存HTMLを管理APIで読み取り、5,004 bytes、Episode 3件の新しい順、Episodeページへのリンク、`audio controls preload="none"` 3つ、同一originの音源URL、script要素なしを確認した。これは生成物の検査であり、Access認証後のブラウザ配信の確認とは区別する。
5. `show-admission-pause`後、Showとサービスのready／drained・受付停止と、Episode 3件のpublishedを照合した。

## 4. 本人による画面確認と未確認範囲

本人から上記URLへのアクセス成功と、3 Episodeすべてのブラウザ再生成功の報告を得た。添付されたデスクトップ画面では、番組名・cover・著者・説明、最初のEpisodeの標準音声プレイヤー（30秒中14秒の位置）、次のEpisode見出しを確認できた。中央寄せ・幅制限・全幅の音声プレイヤーは実装した最小CSSと一致している。青いリンクやISO形式の日時も現行実装どおりであり、CSSが適用されていない表示ではない。

本人の閲覧・再生報告後、§2と同じ30要求を認証cookieなしで再実行し、すべてAccessへの302になることを確認した。これは実際の閲覧後にも保護されることの確認であり、内部cache HIT/MISSを測定した証拠ではない。

残る画面確認項目は、Episode個別ページ、pause／seekの操作、スマートフォン表示である。3件すべての表示順「#25 → #10 → #02」は生成HTMLでは確認済みだが、添付画面には3件目が写っていない。音源は順に30秒・60秒・10秒の試験抜粋である。

別メール・別アカウントによる拒否、実機のCPU数値・cache HIT/MISS・完全なFree枠適合は未確認。今回の正常公開・再生だけで性能の合格とは扱わない。

Free契約を前提に、有料upgrade・CPU上限変更・追加の生成Workerは使っていない。ただし現在の契約のAPI照会権限はなく、料金プラン自体をAPIで検証できたとは主張しない。normalの36件や保持サービス、既存DNSは変更していない。

## 5. 証跡

非公開の元要求・API応答・CLI結果・生成HTML・検査結果は、メインcheckoutのGit対象外である`.local-test-data/results/20261025/issue70-private-1cd434d0/`に保存した。秘密鍵・本人メール・未公開job IDをこの文書へ転記しない。

Accessアプリ作成はHTTP 201で成功した。最初のローカル結果分類が200だけを成功扱いしていたため、保存済み201応答を根拠に別receiptへ訂正した。作成要求は再送していない。HTML検査も、音源URLが絶対URLという試験側の誤った仮定を、正しい相対URL解決へ修正した。アプリ実装の変更は不要だった。
