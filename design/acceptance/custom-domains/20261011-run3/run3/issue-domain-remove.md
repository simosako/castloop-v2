## 概要

`feature/custom-domains`修正版で独自ドメイン実機受け入れを再実施し、第5〜7節（domain add、両host配信/lifecycle、domain保持deploy）まで合格しました。
第8節の`domain remove`が、`null is not an object (evaluating 'data.success')`で失敗しました。
後続の読み取りではCustom Domain/DNSは不在ですが、connection execution/pendingが残り、安全にresumeできません。

## 対象

- 日付: 2026-10-11
- ブランチ: `feature/custom-domains`
- commit: `20a92f49ec283f5edc3ec5af3e8d27725928bfe0`
- Linux x86-64の同commitからビルドしたCLI（version表示0.2.1）
- binary SHA-256: `c381f8adf09b7348ddd1e178e01b6d9967168b0e32f767c2d758d6b2af25fa5b`
- 型検査/build成功、`bun test`: 933 pass / 0 fail
- 手順: https://github.com/simosako/castloop-v2/blob/20a92f49ec283f5edc3ec5af3e8d27725928bfe0/docs/custom_domain_live_acceptance.md
- 関連: #6 のpaused公開配信問題は修正版実機で503を確認済み。このIssueは別の削除応答処理の問題です。

## 再現手順

1. 新規サービスと専用hostnameで、手順第1〜4節のfixturesを準備し、完了条件を確認する。
2. 第5節に従いpauseしてdomain addを実施。接続/URL/Worker version/停止中503を確認しresumeする。
3. 第6節の両host配信、Episode/Show非公開化・復元を確認する。
4. 第7節に従いpause/deployを実施し、domain保持・version更新・readinessを確認しresumeする。
5. 第8節で新しいpause/operation IDを作り、pause後の共通確認を行う。
6. `castloop domain remove --operation-id REMOVE_UUID`を実行する。

## 期待値

- `result = domain-changed-paused`、operation ID一致。
- domains=[]、canonical/管理URLがworkers.dev、Worker version不変。
- 接続操作のpending/execution tokenとurl_changeを安全に完了できる。
- 共通確認後に明示resumeし、workers.devの配信復帰を検証できる。

## 実際の結果

```text
Domain operation ...: null is not an object (evaluating 'data.success')
```

- CLI exit code=1、stdoutは空。CLI stderrにreason_codeフィールドなし。
- remove前はpaused、invocations=[]、3 Show unfinished=false、設定/接続一致、local操作/url_changeなし。
- remove後の読み取りではpaused、invocations=[]、domains=[]、canonical workers.dev、設定/接続一致。
- url_changeにはconnection executionが残存。
- local操作は`phase=configured`、`pending.action=connection`、`lock_present=false`。
- API GETで対象Custom Domain接続0件、対象hostnameのDNS record0件を観測。ただし不在だけで未知IO終了とは判断していません。
- Worker versionはdeploy後から不変、停止中workers feedは503、keepのR2 metadata/revisionsは変更前と一致。

## 応答処理の原因箇所

[`packages/cli/src/cloudflare-api.ts:77-82`](https://github.com/simosako/castloop-v2/blob/20a92f49ec283f5edc3ec5af3e8d27725928bfe0/packages/cli/src/cloudflare-api.ts#L77-L82)は`response.json()`の値をnull検査せず`data.success`へアクセスします。
[`removeWorkerDomain:301-309`](https://github.com/simosako/castloop-v2/blob/20a92f49ec283f5edc3ec5af3e8d27725928bfe0/packages/cli/src/cloudflare-api.ts#L301-L309)もこの共通json処理を利用しています。

このエラーはtop-level null応答の解析経路と整合します。ただし実機DELETE時の生HTTP status/bodyは保存していないため、実際の応答形式やCloudflare仕様との関係は断定しません。
参考API仕様: https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/delete/

## 残留状態と復旧判断

要求の再送、lock削除、execution token強制解放、resumeは行っていません。
新旧全環境のWorker/bucket/Queue/DLQ/workspaceとjournalを保持しています。
修正は応答形式の扱いだけでなく、この保持環境を安全に復旧可能かの判断も必要です。
domain不在や時間経過だけで残留executionを解放する修正は避けてください。

## 試験のDNS経路

PC通常DNSではhostnameがnot foundのまま、Cloudflare公開DNSでは解決/TLS確認ができました。
管理者承認で、試験プロセス限定のlocal HTTPS CONNECT tunnelを使い、対象hostnameを`1.1.1.1:53`で明示解決しました。
TLSは終端せず、CLI/curlのhostname/証明書検証を維持し、OS/ルーターのDNS設定は変更していません。
これにより今回の環境ごとのDNS反映待ちを回避し、第5〜7節を完了できました。DNS/TLS準備を常に省略できる保証ではありません。
Cloudflare APIはNO_PROXYで通常経路を使用しており、このDELETEはlocal tunnel経由ではありません。

## 修正後の確認案

- DELETE応答形式をstatus/body/型の根拠に沿って検証し、nullを誤ってdereferenceしない。
- 想定外の成功応答を無条件成功扱いせず、未知IO時の停止と記録を維持する。
- 既存の切断操作のpending/executionを、安全な根拠なしに再送/解放しない。
- 第8節のdomain remove完了、workers.dev復帰配信、独自ドメイン時公開Episodeの維持、最終pause共通確認を完了する。

選別・匿名化した証跡を専用ブランチへ保存し、固定commitのリンクをこのIssueへ追記します。
API token、管理鍵、操作execution token値、メールアドレス、metadata本文は掲載しません。
