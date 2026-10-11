# 独自ドメイン受け入れ試験の活動記録・選別証跡

実施日: 2026-10-10〜11。対象commit: `685cd81c0287d7c82204eeb4773d16f2f5c63c1c` (`feature/custom-domains`)。
関連Issue: [#6 停止中にも公開feedが200を返す](https://github.com/simosako/castloop-v2/issues/6)。

このブランチは証跡保存専用です。製品コードの修正、修正版Workerのdeploy、試験の合格宣言を含みません。

## 最終結果

新規環境run2で第3節のfixturesと第4節の変更前データ保存を完了。
第5節で、`paused`・`invocations=[]`・未完了Show操作なしを確認した後もfeed GETが200/HITを返し、期待503と不一致のため停止しました。
ローカルfake R2/loopbackでも、paused中にgatewayがキャッシュを呼び200を返すことを再現しました。
独自ドメイン追加/削除・独自ドメイン保持deployは未実施。全試験合格ではありません。

## 経過・判断

1. 素材確認、承認された約30秒MP3の作成、CLIビルド、型検査、自動テスト（準備時932 pass / 0 fail）。
2. API tokenのDNS Read不足による403で停止。
3. 管理者が既存Account API TokenのAccount用policyを「アカウント全体」にし、otftalk.com用policyにDNS Read/Zone Read/Workers Routes Writeを設定。保存成功後、読み取りAPIの事前確認が成功。
4. 初回service IDの文字数誤認を訂正（21文字から15文字へ）。初回拒否はremote IO前のローカル入力検証。
5. 手順書のEpisodeコマンド例とCLI仕様が不一致。管理者承認でShowディレクトリ内からShow IDを省略するCLI実仕様へ読み替え。
6. run1で複数処理をまとめた実行ツールの300秒制限により公開要求を中断。未知IO/lock/所有権を保持し、再送・強制解放を禁止。管理者承認で旧環境を保持したままrun2を作成。
7. run2では実行ツールtimeout=0。状態照会の一時失敗を調査し、読み取り中更新の拒否が同じCLIメッセージを生むことをローカル再現。実機失敗時の生HTTPは未保存なので、当該実機原因は最有力仮説に留める。
8. 管理者が「照会失敗は記録し読み取りのみ継続、明示的な完了条件を満たすまで次へ進まない」を承認。変更要求の再送/強制解放は禁止のまま第3〜4節を完了。
9. 第5節の停止中feed 200は上記照会許容とは別の不一致として停止し、Issue #6を登録。

新旧の試験環境と全ローカル原本は保持しています。run1は中断jobのlock/所有権が残存、run2はpaused/invocations=[]で保存。Cloudflareリソース削除や未知処理の強制復旧は行っていません。

## ファイル一覧

| 場所 | 内容 |
| --- | --- |
| [logs/test-20261010.log](logs/test-20261010.log) | 初期準備・権限不足の活動ログ |
| [logs/test-20261011.log](logs/test-20261011.log) | 続行判断・中断・再試験・不具合調査の活動ログ |
| [run1/result.md](run1/result.md) | 初回環境の結果と復旧可否確認 |
| [run2/result.md](run2/result.md) | 新規環境の結果。先頭が最新状態、後半は各時点の経過 |
| [run2/diagnosis.md](run2/diagnosis.md) | 状態照会競合の調査・推奨扱い |
| [run2/http/](run2/http/) | 停止後feedのHTTP status・選別header・本文hash/length |
| [run2/paused-public-local-repro.json](run2/paused-public-local-repro.json) | paused配信のローカル再現結果 |
| [repro/](repro/) | 実機を変更しないローカルfake-only再現スクリプト |
| [manifest.json](manifest.json) | 公開ファイル・ローカル原本の相対位置・加工方法・公開版SHA-256 |

元のresult/logには公開対象外ファイルへの参照も残ります。これは全証跡のアーカイブではなく、開発向けの選別・匿名化コピーです。
公開済みの一覧はmanifestを参照してください。

## ローカル再現の実行

repo rootで依存関係を用意した後、次を実行します（既存のBun開発環境を使用）。

```sh
npm ci
bun run design/acceptance/custom-domains/20261011/repro/paused-public.ts
bun run design/acceptance/custom-domains/20261011/repro/status-read-race.ts
```

- `paused-public.ts`: expected_status=503に対しactual_status=200、cache_calls=1を再現。
- `status-read-race.ts`: 安定時の照会成功、競合時HTTP409/publication_operation_blockedとCLI包括エラーを再現。
- どちらもCloudflareアクセスなし、fake R2内だけで動作。`private-secret`はfixtureの固定ダミー値で、実機管理鍵ではありません。
- 後者は`/tmp/opencode/`が存在する環境を前提とし、そこへローカルのダミーjournalを作成します。

## 公開範囲と匿名化

- workspace、`.castloop/`、認証情報、バイナリ、node_modules、MP3/JPEG、RSS/metadata本文は含めません。
- account/Zone ID、メールアドレス、ローカル絶対パス、操作token/実行ID等を除去または置換。
- HTTP headerは許可リスト方式。Report-To/NEL等は除外し、bodyはhashとlengthのみ保存。
- current_revisionは比較に必要な非metadata項目に限定。R2 TOML本文は省略し、キー一覧だけ保存。
- その他の操作UUID・version UUID・試験resource名・承認済みhostnameは、追跡可能性のため残しています。
- 元のローカルファイルを変更せず、公開コピーだけに加工しています。

## 留意点

最終のservice pausedは確認済みですが、そのpausedが公開配信を止めないこと自体がIssue #6です。
HTTP不一致の実機確認範囲はfeed GET。画像/音源/HEADの同じ不一致を実機確認したとは主張しません。
修正後は公開GET/HEAD/Range/条件付き要求のpaused拒否と、停止中管理操作への非影響を検証する必要があります。
