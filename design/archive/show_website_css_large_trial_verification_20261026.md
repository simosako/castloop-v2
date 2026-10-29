# Issue #70: 標準デザインと通常サイズ音源の非公開実機試験

2026-10-26。利用者から「前回の試験環境を削除し、最新版でnormalの大きめの音源3件を登録する」と明示承認を受けて実施した。既存の保持サービス・DNS・共有ログイン元・料金プランは変更しない。

追補: 本書は初回配備時点の記録。その後、本人から再生に問題がないとの報告を受けた。さらに別承認で、同じ環境を[説明文表示改善版へ更新・再公開](show_website_description_trial_verification_20261026.md)した。現在のversion・生成HTML・確認待ち範囲は後続記録を参照する。

追加追補: 自動短縮URL版は新規保存形式を使うため、別承認で本環境を退避・削除し、[新しい本人限定試験環境](show_website_short_url_trial_verification_20261026.md)を作成した。本書のURLは現在のレビュー先ではない。元workspace・journal・証跡は保持する。

## 1. 前回環境の削除

[前回の短尺3件の試験](show_website_private_trial_verification_20261025.md)で作成した資源だけを、完全一致の対象として削除した。

- Worker: `castloop-site70-1cd434d0-55d8a35b`
- private R2 bucket: `castloop-site70-1cd434d0`
- SQLite DO namespace: `a254fecfd8eb443782ce91e70a1088bd`
- 専用Accessアプリと、そのアプリだけの非再利用policy

削除前に、元のWorker version、Show 1件の`admission_paused / ready / drained`、実行中・待機中jobなし、11操作すべての`succeeded`と未完了操作なしを照合した。他Workerから対象bucket・namespace・serviceへの参照はなく、Workerのcustom domainもなかった。

R2の全32 object、5,990,016 bytesを非公開で退避し、size・ETagに対するMD5・保存後SHA-256と前後の一覧一致を確認した。11操作の詳細も取得した。これはDO SQLite全体のexportではない。

`force`なしでWorkerを削除し、namespaceの消失を確認してから、退避済み一覧に一致する32 keyを個別削除し、空bucketを削除した。AccessはWorker削除後に専用アプリを削除した。アプリDELETEはHTTP 202・`success=true`で受理され、後続GETの404で消失を確認した。200だけを期待した試験側の分類は訂正し、DELETEは再送していない。

別GETでもWorker・bucket・Accessアプリの404を確認した。保持Worker `castloop-sq16r-6ec01dc6-f65ca2ec`の設定は取得済みの削除前設定と一致する。保持bucketの全内容やDNS・証明書の前後比較は今回行っておらず、それらの変更APIも呼んでいない。原本・旧workspace・秘密鍵・journal・元の証跡・今回の退避は残している。

## 2. 新規環境

| 項目 | 内容 |
| --- | --- |
| ソース | `48488a4`を基点とするCSS対応の未commit開発版。配備binaryのSHA-256とtracked差分・untracked sourceのhashを私有証跡に保存 |
| 内部queue/content形式 | 9/10。旧環境の変換・採用なし |
| サービス | `site70-css-b1eec9cd` |
| Worker | `castloop-site70-css-b1eec9cd-f56b258a` |
| Worker version | `2524d357-b372-438d-aba5-203d6acd13f1` |
| private R2 bucket | `castloop-site70-css-b1eec9cd` |
| SQLite DO namespace | `252404bdef734407833b845506637a47` |
| Show | `site70-normal`、`[TEST] OTF Talk`、`site_mode="builtin"` |
| デザイン | 新しい標準デザイン。追加CSSは未指定 |
| 公開処理後の状態 | `admission_paused / publication_ready=true / drained=true`、待機0・実行中なし、配信有効 |

本人用URL:

<https://castloop-site70-css-b1eec9cd-f56b258a.simosako.workers.dev/podcasts/site70-normal/>

コンテンツパス`/podcasts/*`全体を専用Accessアプリで保護し、以前と同じ本人メール1件・対象アカウント所属・Cloudflareログインを、1つのAllow policyのInclude／Requireで組み合わせた。既存Cloudflareログイン元のアカウントメンバー制限もGETで確認し、設定は変更していない。

空の新規サービスをfresh initし、サンプルupload前に、一覧・Episodeページ・画像・Feed・音声の5パスで未認証Access 302を確認した。R2 managed public domainは無効、custom domainは0件、Workerのpreview URLは無効である。管理パスは既存の管理者鍵認証を維持する。

## 3. サンプルと公開

原本は`.local-test-data/normal/`。36件からMP3サイズの大きい順に3件だけを選び、専用workspaceへコピーした。音源を短縮・再encodeしていない。元の`.castloop/`・`import.json`はコピー・変更せず、RSS取り込み履歴の改変もしていない。

| Episode | MP3 bytes | 約MB（10進） | CLI解析による長さ |
| --- | ---: | ---: | --- |
| #35 ハイトラフィックな更新処理が必要な環境でのApache Iceberg検証 | 62,853,537 | 62.9 | 32分44秒 |
| #28 マイクロアドでのOTF活用とIcebergテーブルの最適化 | 59,560,018 | 59.6 | 31分01秒 |
| #20 Apache Hudiを巨大トラフィックのシステムに導入しようと検証して得た知見（後編） | 53,727,816 | 53.7 | 27分59秒 |
| 合計 | **176,141,371** | **176.1** | — |

Show ID・試験用の番組名・サイト方式だけをコピー先で変更した。ShowとEpisodeの説明、Episode ID・GUID・公開日時を元データから引き継いだ。既存schemaの文字列前後の空白除去は通常どおり適用される。

Linux単体CLIの新規登録・明示Resume・stage・publishを通し、Show 1件とEpisode 3件の**4公開jobすべてが`succeeded`**になった。3件ともuploadのサイズ・全量readback hash・object identity検証を省略していない。最後に受付だけを停止し、本人の閲覧・再生は維持した。使用した原本8ファイルのSHA-256は処理前後で一致する。

## 4. 確認範囲

公開完了後、認証済みの管理読取・R2 RESTと未認証HTTPを分けて、次を確認した。

- 公開済みR2のMP3 3本を**それぞれ全量GET**し、原本・公開snapshotのSHA-256、size、一覧ETagに対するMD5が一致した。短尺抜粋ではなく元の大きな音源を保存・取得できている。R2内の直接照合であり、Access認証済みブラウザからのGateway配信試験とは区別する。
- 確定済み一覧のHTMLは#35→#28→#20の新しい順、標準CSS、標準player 3個、`preload="none"`、scriptなし。Show説明はschema正規化後の全文、Episode説明は先頭160文字＋省略記号で一致した。
- 個別Episode HTML 3件はそれぞれ説明全文が一致し、`<p>`等はescape済み。公開snapshotの正しい音源URLを参照している。最初の説明比較で、試験側が元TOML末尾の改行も残ると仮定していたため不一致になったが、既存schemaのtrimと保存内容を照合して期待値を訂正した。アプリ変更・再公開はしていない。
- 一覧・個別ページ3件・Feed・cover・MP3 3件のGET／HEAD／`If-None-Match: *`と、MP3 3件のRange、**合計30要求がすべてAccessの302**になり、未認証者へ番組内容を返さなかった。
- 鍵なし管理healthは401、`/`・`/podcasts`・`/system/test`・`/staging/test`は404だった。旧namespaceの消失と新しい専用namespaceの存在も最終GETで照合した。
- R2の一覧は32 object・356,726,433 bytes（staging・公開音源・画像・metadata・HTML履歴等の合計）。これは当該bucketのsize合計であり、月間課金量やアカウント全体の使用量ではない。

本人のAccessログイン後の表示・Play／pause／seek、スマートフォン表示はレビュー待ちである。Episode見出しを押すと個別ページへ移り、一覧の短い説明と全文を比較できる。原本Episodeの説明にある`<p>`等は現仕様ではHTMLとして解釈せず文字として表示する。これは説明文の見栄えを確認する材料であり、今回の配備で暗黙にHTML描画やsanitizerを追加していない。カスタムCSSを指定した実機公開も今回は行っていない。

有料upgrade・CPU上限変更・追加の生成サービスは使っていない。料金プラン自体のAPI検証、Worker/DOのCPU・duration・request数・cache HIT/MISSや、全アカウントのFree枠消費の測定は未実施。3件の公開成功だけを300MB上限や全Free適合、ブラウザ配信の性能保証として扱わない。

## 5. 私有証跡

- 旧環境の退避・削除: `.local-test-data/results/20261025/issue70-private-1cd434d0/cleanup-20261026/`
- 新環境のworkspace・CLI応答・API応答・検査結果: `.local-test-data/results/20261026/site70-css-b1eec9cd/`

いずれもメインcheckoutのGit対象外。ローカル原本を削除する承認は受けておらず、cleanupしない。秘密鍵・本人メール・未公開job IDを本書へ転載しない。試験環境は次の明示的な削除指示まで保持する。
