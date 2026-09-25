# MVP公開前の受け入れ準備

## マイルストーン監査サマリー（2026-09-25）

| Milestone | 判定 | 現状と残件 |
| --- | --- | --- |
| M0 | 製品に必要な主要経路は後続M2/M5で受け入れ。計画上の全停止点は未実施 | 実公開jobのretry→DLQ→同job回復、公開feed/media/cache、300,000,000 bytes転送を後続で確認。Queue pause中の配送やfeed/metadata/cover部分書き込みからの手動修復は未検証。 |
| M1 | 完了 | strict metadata、init、Show予約、下書き生成を実測。Cloudflare resource create成功後の応答喪失を自動reconcileする処理は未実装。 |
| M2 | 完了 | ShowとEpisode公開、RSS、GET/HEAD/Range、purge、status、retry/DLQ回復を専用環境で確認。 |
| M3 | 完了 | 複数Episode、metadata/audio片側更新、immutable revision、GUID、cleanupを検証。Apple Podcasts Connectでの実番組登録・審査は未実施。 |
| M4 | 完了（M5で方式更新） | 当初の配布・利用文書は提供済み。Wrangler/`ffprobe`依存はM5で除去。v0.1.0の配布対象はLinux x86-64。 |
| M5 | Linux x86-64公開ゲート完了、例外回復に残件 | v0.1.0を公開し、token-onlyでの新規作成・運用・移行を受け入れ。initの曖昧なresource作成結果のreconcile、恒久failed/reserved jobの安全なabandonは未実装。v0.1.1ではMIT表記のsource treeとRelease assetを同一tag/commitから配布する。 |

M0の「全条件合格」とMVPに必要な後続のend-to-end受け入れは区別する。製品公開フローは確認済みだが、例外的な停止・手動修復まで完全自動化されたという判定ではない。各実測は下記および各 milestone implementation log を参照。

## 2026-09-25: M5 Linux x86-64受け入れ

Wrangler/Node.jsを使う旧検証の後、API tokenと配布用バイナリによる新規サービス・Show/Episode公開、更新、DLQ回復、Worker再deploy、カバー/feedキャッシュpurge、300,000,000 bytesのMP3公開・全量ハッシュ照合を専用サービスで検証した。空の`PATH`でコピーしたバイナリから`deploy`とEpisode metadataのstaging/commitを実行した。詳細は[`m5_implementation_log.md`](./m5_implementation_log.md)に記録する。

v0.1.0の配布対象をLinux x86-64に限定する。GitHub ActionsはLinuxバイナリのみchecksumと起動を検証し、tag push時は成功後にGitHub Releaseへ添付する。macOS/Windowsの旧smoke jobは管理操作の受け入れ条件を満たさないため、リリースフローから除いた。リリース公開時はtag workflowの成功・添付ファイルとSHA256SUMSの確認を行う。

`v0.1.0`タグの[GitHub Actions run 36130474117](https://github.com/simosako/castloop-v2/actions/runs/36130474117)はbuild・Linux smoke・Releaseの3 jobすべて成功。[Release](https://github.com/simosako/castloop-v2/releases/tag/v0.1.0)はdraft/prereleaseではなく、Linuxバイナリ・SHA256SUMS・LICENSE・THIRD_PARTY_NOTICES.mdの4ファイルを添付。Releaseから再ダウンロードしたバイナリの`sha256sum --check`は成功し、`--version`は`0.1.0`。SHA-256は`7a89bec2f3086bd3d552bcf47a8af930a8849e4d1a2a44b58fef4513d68303dd`。この時点でGitHub repositoryは**private**のため、Release URLはアクセス権のあるユーザーに限られる。一般公開するには別途visibilityの判断が必要。

その後、管理者の承認によりrepositoryを**public**に変更。変更前に全581件のGit履歴objectを対象に、現在のAPI token・旧サービスの管理用keyとの一致、秘密ファイルのパス、GitHub token・AWS key・秘密鍵の形式を検索し、該当なし。認証なしのHTTPでReleaseページ、`SHA256SUMS`、Linuxバイナリのいずれも200を確認した。v0.1.0は一般にダウンロード可能。

公開後、管理者の選択によりプロジェクトライセンスをISCからMITに変更し、著作権表示を`Copyright (c) 2026 Akira Shimosako`に統一。`package.json`/lockfileもMITに更新した。v0.1.0のReleaseに添付したLICENSEも差し替え、公開assetを再取得して内容が一致することを確認した。配布バイナリ本体とchecksumは変更なし。

## 2026-09-24: 新規`init`後のWorker URL反映待ち

M4.5の新規サービス作成ではWranglerのdeploy自体が成功した直後、Workerのhealth URLが一時的にHTTP 404を返した。既存の`init`は一度のhealth確認で終了し、同一workspaceからの再実行で成功した。

`init`はdeploy完了後のhealthに対し最大6回、各回のリクエストを最大5秒、間隔2秒で再確認する。HTTP 404/429/5xxとネットワークエラーを一時的とみなし、HTTP 401等のそれ以外の4xxはすぐに失敗させる。上限まで到達したら最後の応答種別と同一workspaceでの再実行方法を通知する。health待機中は完了済みの`.castloop/state.json`のステップを維持し、同じ呼び出し内でWorkerなどのリソース作成を繰り返さない。

一時的404からの回復、通信エラー・503からの回復、401の即時拒否、404継続時の6回打ち切りを自動テストで確認した。ビルドした実行ファイルでも、すでに作成されたM4.5検証サービスへの`init`再実行が成功した。deploy直後の一時的404を新しいWorkerで再現する実機テストは行っていない。

## 2026-09-25: 別マシン試験の位置づけ

**判断:** ソースコードのない別マシンへのコピー・実行は、このMVPの公開ブロッカーにしない。対象は管理者が運用するLinux x86-64環境でのShow/Episode公開であり、任意のLinux環境や他OSで動くという配布保証は含めない。

M4ではリポジトリ外にコピーした実行ファイルと別置きWranglerで公開を確認した。M4.5では`ffprobe`なしで新規workspaceから`init`・Show/Episode公開まで検証した。2026-09-25のsmoke testでも同一Linux環境で新規サービスを作り、Show/Episode jobの完了、feed・MP3・画像の一致を確認した（[`docs/linux_smoke_test.md`](../docs/linux_smoke_test.md)）。一方、異なるLinuxディストリビューション・システムライブラリ・Node/Wranglerの導入差を越えた動作は未確認。

別マシン試験は、CLI実行ファイルを不特定の利用者へ配布するとき、または対応するOS/環境を広げるときの配布検証として実施する。今回の初回`init`では一時的なHTTP 500の後、同じworkspaceでの再実行により完了した。500の原因は記録から断定しない。

## リリース候補の複数OSビルド

以下はM5前の候補ビルド計画を記した履歴であり、**現在の配布状況ではない**。v0.1.0ではWranglerを使わないLinux x86-64バイナリだけをGitHub Releaseに添付した。macOS/Windowsはビルドスクリプトに実験用targetがあるが、配布していない。

## MVP公開条件の追加: 管理CLIのWrangler依存解消（完了・監査事項あり）

M5のLinux x86-64公開ゲートは達成し、v0.1.0を公開した。Cloudflare API tokenと配布バイナリでの新規初期化、Show/Episodeの初回公開・更新、上限MP3、回復、旧サービス移行、Releaseの検証は[`m5_implementation_log.md`](./m5_implementation_log.md)に記録する。

リリース後の監査で、resource createの応答喪失時に`init`を自動照合する処理、および恒久`failed` jobの安全な`reserved`受付解除CLIが未実装と分かった。再現/影響とMVPでの制約は同実装ログ末尾に記録。別マシンのコピー試験は従来判断どおり公開ブロッカーにしない。Apple Podcasts Connectでの実登録審査も未実施で、RSS validatorとfeed要件の検証範囲を超える確認はフォローアップとする。
