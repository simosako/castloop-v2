# castloop v0.3.0

独自ドメインの追加・照会・削除に対応した、Linux x86-64向けCLIのリリースです。v0.2.1のShow／Episode一覧とM6の公開・非公開化・復元・削除機能を引き続き利用できます。

## 変更

- `castloop domain add HOSTNAME`: 1サービスにつき1つの独自hostnameを接続し、RSSの正規URLを切り替えます。
- `castloop domain list`: 接続、正規URL、管理URL、設定不一致、未完了操作を読み取り専用で表示します。
- `castloop domain remove`: 正規URLとRSSをworkers.devへ戻し、対象Workerのドメイン接続を削除します。コンテンツは削除しません。
- CLIの管理API接続先をworkers.devへ固定しました。独自ドメインへ管理鍵・API tokenを送らず、workers.devでも同じ公開コンテンツを配信します。
- 正規URLの変更時にactive Showのfeedを再生成し、cache purgeとR2／ローカル設定の同期を行います。音源、revision、GUID、公開日時、ShowのサイトURLは維持します。
- 通常の`deploy`は一致する独自ドメイン接続を保持します。domain操作自体ではWorkerを再配備しません。

## 不具合修正

- [#6](https://github.com/simosako/castloop-v2/issues/6): service-pause後もキャッシュされたfeedを配信する不具合を修正しました。停止中の公開feed・画像・音源は、キャッシュに進む前にHTTP 503で拒否します。
- [#7](https://github.com/simosako/castloop-v2/issues/7): Custom Domain削除のnull応答を共通JSON処理で参照して失敗する不具合を修正しました。削除API専用の完了応答検証を行い、未完了・不正・未知の応答は成功扱いしません。

## 利用・更新時の注意

- 独自ドメイン機能には**v0.3.0のCLIと、そのバイナリで配備したWorkerの両方**が必要です。バイナリの置換やRelease公開だけではCloudflareサービスは更新されません。
- 初期化済みv0.2.x M6サービスは、workspaceと`.castloop/`を保管し、pause・既存処理終了確認 → v0.3.0で`deploy` → 稼働確認 → 明示resumeの手順で更新します。v0.1.xの変換・採用は行いません。
- 対象hostnameを含むZoneは、同じCloudflare accountのactive/full構成が必要です。既存DNSや他Workerの接続は上書きしません。追加のWorkers Scripts Write、Zone Read、DNS Read権限を確認してください。
- add/removeは明示pauseと処理終了確認が必要で、完了後もpausedのままです。DNS/TLS準備待ちや確認済みの進捗は同じ操作で続行します。
- 変更結果が不明な要求・残存lock・実行tokenは保持します。時間経過やドメイン不在だけで解放せず、自動再送・自動再開・万能な復旧は提供しません。
- 複数ドメイン、Show別ドメイン、無停止切替、購読先の自動変更やredirectは対象外です。Podcast directoryの登録URLは管理者が変更してください。

## 検証・配布範囲

937の自動テスト、TypeScript検証、Linux単一バイナリのbuildを確認しました。[run4実機受け入れ](https://github.com/simosako/castloop-v2/blob/7e57cac5b22435c54d68d0a6edc9a28e2285ff71/design/acceptance/custom-domains/20261011-run4/run4/result.md)で、追加、両hostのGET／HEAD／Range／ETag、非公開化／復元、ドメイン保持deploy、削除、workers.dev配信復帰、データ不変、最終停止まで合格しました。試験は対象hostnameのみ1.1.1.1で解決するprocess限定経路を使用し、TLS検証を維持しています。

Linux x86-64バイナリ、SHA256SUMS、MIT License、第三者ライセンス通知を配布します。macOS／Windows版は今回の配布対象ではありません。

操作と更新手順は[README](https://github.com/simosako/castloop-v2/blob/v0.3.0/README.md)、ドメインの前提・操作・復旧制限は[利用案内](https://github.com/simosako/castloop-v2/blob/v0.3.0/docs/custom_domains.md)を参照してください。
