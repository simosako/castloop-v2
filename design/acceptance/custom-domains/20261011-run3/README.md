# 独自ドメイン受け入れ試験 run3：削除操作の応答処理で停止

- 実施日: 2026-10-11
- 試験対象commit: `20a92f49ec283f5edc3ec5af3e8d27725928bfe0` (`feature/custom-domains`)
- 関連Issue: [#7 domain remove応答処理と残留connection記録](https://github.com/simosako/castloop-v2/issues/7)
- 先行Issue: [#6 停止中公開配信](https://github.com/simosako/castloop-v2/issues/6)は修正版実機で503を確認済み
- このブランチは証跡保存専用。製品コードの修正やPRは含みません。

## 結果概要

| 節 | 結果 |
| --- | --- |
| 第1〜4節 | API事前確認、初期化、fixtures、変更前RSS/media/R2保存が完了 |
| 第5節 | domain add、接続/URL/version確認、停止中両host503、resumeが合格 |
| 第6節 | 両host GET/HEAD/Range/ETag、RSS・GUID・pubDate、非公開/削除・復元、revision/R2不変が合格 |
| 第7節 | domain保持deploy、version更新、readiness、resume後配信とデータ維持が合格 |
| 第8節 | remove前の共通確認は合格。domain removeが応答処理例外で失敗し停止 |

残る未完了範囲はdomain removeの完了、resume後のworkers.dev復帰配信、最終停止の共通確認です。
全試験合格・操作復旧完了とは判定していません。

## DNS経路の判断と回避策

このPCの通常DNSでは対象hostnameがnot foundだった一方、別VPSとCloudflareの公開DNSでは解決できました。
本PCから`1.1.1.1:53`へのUDP/TCP A/AAAA照会はすべて成功し、TLSも有効な証明書で確認できました。

管理者の判断で通常DNSの調査/設定変更を止め、試験プロセスだけが使う127.0.0.1限定CONNECT tunnelを使用しました。
このtunnelは対象hostnameを1.1.1.1で明示解決してTCP接続し、TLSを終端せずバイト転送します。
CLI/curlのhostname・証明書検証を維持し、OS/ルーターのDNS設定やCLIバイナリは変更していません。
Cloudflare API/Workers管理hostはNO_PROXYで通常経路を使用しました。

**これにより、今回のPC側DNS経路の反映待ち・キャッシュ等による差を回避して、domain addと第5〜7節を完了できました。**
公開DNSでの解決/TLS準備を先に確認したうえでの結果であり、権威DNS反映やTLS準備の待機を常に省略できる保証ではありません。
通常DNSで解決したという合格扱いにもしていません。tunnelは試験停止後に終了済みです。

## ドメイン削除の失敗

```text
null is not an object (evaluating 'data.success')
```

削除後のAPI読み取りでCustom Domain接続0件、DNS record0件を観測しましたが、connection execution/pendingとurl_changeが残っています。
serviceはpaused、invocations=[]、local phase=configured、lock_present=false。
不在観測だけで未知IO終了と判断せず、再送/強制解放/resumeは禁止のまま保持しています。
Worker versionはdeploy後から不変で、停止中workers feedは503、R2 metadata/revisionsは変更前と一致しています。

`cloudflare-api.ts`のjson()がnull検査なしでdata.successへアクセスする経路と整合しますが、実機DELETEの生HTTP status/bodyは未保存です。
APIの実際の応答形式・仕様をこのエラーメッセージだけで断定していません。

## 公開ファイル

| 場所 | 内容 |
| --- | --- |
| [logs/test-20261011.log](logs/test-20261011.log) | 累積活動ログの匿名化コピー。判断とDNS回避策を含む |
| [run3/result.md](run3/result.md) | 全確認項目・操作ID・Worker version・最新停止状態。先頭が最新、後半は経過 |
| [run3/issue-domain-remove.md](run3/issue-domain-remove.md) | Issue #7本文控え |
| [run3/run-state-summary.json](run3/run-state-summary.json) | 操作/停止ID・version・HTTP検証結果の概要 |
| [run3/remove.stderr](run3/remove.stderr) | 実機CLIの削除失敗メッセージ |
| [run3/remove-final-service.json](run3/remove-final-service.json) / [domains](run3/remove-final-domains.json) | 残留状態の匿名化snapshot |
| [run3/remove-observed-custom-domains.json](run3/remove-observed-custom-domains.json) / [DNS](run3/remove-observed-dns-records.json) | 不在を観測した読み取りAPI応答 |
| [run3/http/](run3/http/) | 選別HTTP status/header、本文hash/length |
| [run3/dns-direct-1111.json](run3/dns-direct-1111.json) | 1.1.1.1直接照会の結果 |
| [run3/](run3/) | lifecycle完了、public checks、R2キー一覧、ビルド/自動テスト集計など |
| [repro/paused-public.ts](repro/paused-public.ts) | Issue #6のfake-only回帰確認スクリプト（修正版では503/cache_calls=0） |
| [manifest.json](manifest.json) | 選別した原本の相対位置・加工方法・公開版SHA-256 |

これは全原本アーカイブではありません。元result/logの公開対象外ファイルへの参照は残しています。
原本・workspace・新旧全試験環境はローカル/Cloudflareに保持し、公開対象の一覧はmanifestを参照してください。
報告のDashboard目視/downloadはAPI GETによる代替で、Dashboardを操作したとは主張しません。

## ローカル再現

repo rootで実行します。Bunと既存repo依存関係を使用し、Cloudflareを変更しません。

```sh
npm ci
bun run design/acceptance/custom-domains/20261011-run3/repro/paused-public.ts
```

`private-secret`はfixtureの固定ダミー値で、実機管理鍵ではありません。
この修正版での期待出力はactual_status=503、cache_calls=0、cloudflare_requests=0です。

## 匿名化と保持方針

- workspace、`.castloop/`、API token/管理鍵、バイナリ、依存関係、音源/JPEG、RSS・R2 TOML本文は公開しません。
- account/Zone/接続ID、操作execution token、メールアドレス、ローカル絶対パス等を公開コピーだけで除去/置換。
- current_revisionは比較に必要な非metadata項目に限定。HTTP headerは許可リスト方式、bodyはhash/lengthのみ。
- 操作UUID・version UUID・試験resource名・承認済みhostnameは追跡可能性のため残しています。
- 元のローカル証跡は変更せず保持。公開版は復旧journalとして使用しないでください。
- Issueからは固定commitで参照し、この証跡ブランチは削除しない運用を推奨します。
