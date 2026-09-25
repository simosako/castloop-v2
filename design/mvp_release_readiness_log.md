# MVP公開前の受け入れ準備

## 2026-09-25: M5 Linux x86-64受け入れ

Wrangler/Node.jsを使う旧検証の後、API tokenと配布用バイナリによる新規サービス・Show/Episode公開、更新、DLQ回復、Worker再deploy、カバー/feedキャッシュpurge、300,000,000 bytesのMP3公開・全量ハッシュ照合を専用サービスで検証した。空の`PATH`でコピーしたバイナリから`deploy`とEpisode metadataのstaging/commitを実行した。詳細は[`m5_implementation_log.md`](./m5_implementation_log.md)に記録する。

v0.1.0の配布対象をLinux x86-64に限定する。GitHub ActionsはLinuxバイナリのみchecksumと起動を検証し、tag push時は成功後にGitHub Releaseへ添付する。macOS/Windowsの旧smoke jobは管理操作の受け入れ条件を満たさないため、リリースフローから除いた。リリース公開時はtag workflowの成功・添付ファイルとSHA256SUMSの確認を行う。

`v0.1.0`タグの[GitHub Actions run 36130474117](https://github.com/simosako/castloop-v2/actions/runs/36130474117)はbuild・Linux smoke・Releaseの3 jobすべて成功。[Release](https://github.com/simosako/castloop-v2/releases/tag/v0.1.0)はdraft/prereleaseではなく、Linuxバイナリ・SHA256SUMS・LICENSE・THIRD_PARTY_NOTICES.mdの4ファイルを添付。Releaseから再ダウンロードしたバイナリの`sha256sum --check`は成功し、`--version`は`0.1.0`。SHA-256は`7a89bec2f3086bd3d552bcf47a8af930a8849e4d1a2a44b58fef4513d68303dd`。この時点でGitHub repositoryは**private**のため、Release URLはアクセス権のあるユーザーに限られる。一般公開するには別途visibilityの判断が必要。

その後、管理者の承認によりrepositoryを**public**に変更。変更前に全581件のGit履歴objectを対象に、現在のAPI token・旧サービスの管理用keyとの一致、秘密ファイルのパス、GitHub token・AWS key・秘密鍵の形式を検索し、該当なし。認証なしのHTTPでReleaseページ、`SHA256SUMS`、Linuxバイナリのいずれも200を確認した。v0.1.0は一般にダウンロード可能。

## 2026-09-24: 新規`init`後のWorker URL反映待ち

M4.5の新規サービス作成ではWranglerのdeploy自体が成功した直後、Workerのhealth URLが一時的にHTTP 404を返した。既存の`init`は一度のhealth確認で終了し、同一workspaceからの再実行で成功した。

`init`はdeploy完了後のhealthに対し最大6回、各回のリクエストを最大5秒、間隔2秒で再確認する。HTTP 404/429/5xxとネットワークエラーを一時的とみなし、HTTP 401等のそれ以外の4xxはすぐに失敗させる。上限まで到達したら最後の応答種別と同一workspaceでの再実行方法を通知する。health待機中は完了済みの`.castloop/state.json`のステップを維持し、同じ呼び出し内でWorkerなどのリソース作成を繰り返さない。

一時的404からの回復、通信エラー・503からの回復、401の即時拒否、404継続時の6回打ち切りを自動テストで確認した。ビルドした実行ファイルでも、すでに作成されたM4.5検証サービスへの`init`再実行が成功した。deploy直後の一時的404を新しいWorkerで再現する実機テストは行っていない。

## 2026-09-25: 別マシン試験の位置づけ

**判断:** ソースコードのない別マシンへのコピー・実行は、このMVPの公開ブロッカーにしない。対象は管理者が運用するLinux x86-64環境でのShow/Episode公開であり、任意のLinux環境や他OSで動くという配布保証は含めない。

M4ではリポジトリ外にコピーした実行ファイルと別置きWranglerで公開を確認した。M4.5では`ffprobe`なしで新規workspaceから`init`・Show/Episode公開まで検証した。2026-09-25のsmoke testでも同一Linux環境で新規サービスを作り、Show/Episode jobの完了、feed・MP3・画像の一致を確認した（[`docs/linux_smoke_test.md`](../docs/linux_smoke_test.md)）。一方、異なるLinuxディストリビューション・システムライブラリ・Node/Wranglerの導入差を越えた動作は未確認。

別マシン試験は、CLI実行ファイルを不特定の利用者へ配布するとき、または対応するOS/環境を広げるときの配布検証として実施する。今回の初回`init`では一時的なHTTP 500の後、同じworkspaceでの再実行により完了した。500の原因は記録から断定しない。

## リリース候補の複数OSビルド

`scripts/build-cli.ts`は従来の無指定ビルドに加え、Linux x64、macOS x64/arm64、Windows x64を明示的に選べる。WranglerによるWorker bundle生成はNode.jsからWranglerのJS entrypointを実行し、WindowsでCLIが管理操作を行う際も`CASTLOOP_WRANGLER`に同entrypointを指定してNode.jsから起動する。`.cmd`を`execFileSync`へ渡さない。

GitHub Actionsの`build-binaries.yml`は手動または`v*`タグでビルドし、workflow artifactへ保存した後、各OSのrunnerでchecksumと`--version`/`--help`を確認する。macOSではチェック後に検証用コピーをad-hoc署名して実行し、artifact自体は未署名。成功したrunのartifactだけを使用する。GitHub Releaseへの自動添付は別途整備する。CLI起動の確認はCloudflare上での`init`・公開やmacOS/Windows向けの配布保証を意味しない。

## MVP公開条件の追加: 管理CLIのWrangler依存解消（レビュー用計画）

管理者の日常的なShow/Episode配信だけでなく、初回`init`、更新後の`deploy`、失敗jobの回復まで、配布済みバイナリとCloudflareアカウントID/API tokenだけで完結させる。管理者の端末でWrangler・Node.js/npm・Bun・`ffprobe`を必要としない。ビルド工程のWorker bundle生成についてもWranglerを取り除く。詳細な作業順・検証ゲートは[`initial_design.md`のM5](./initial_design.md#m5-wrangler不要の管理cli)を参照する。

従来のM0〜M4.5の実機検証は当時の実装の結果として有効だが、Wrangler不要で動くことの証明にはならない。M5.0のAPI経路と300,000,000 bytesの実証、およびM5.4のバイナリ単体のend-to-end検証を新しいMVP公開ブロッカーとする。別マシンへのコピー試験を必須にしないという既存判断は維持し、対応を表明するOSごとの管理操作の実証とは区別する。計画承認後、実装に合わせて`AGENTS.md`、`README.md`、`docs/linux_smoke_test.md`の古いWrangler必須の説明を更新する。
