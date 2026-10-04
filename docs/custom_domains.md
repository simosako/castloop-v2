# 独自ドメイン（開発ブランチ・未リリース）

この機能は`feature/custom-domains`のCLIと同じbuildのWorkerが必要です。公開済みv0.2.1バイナリにはありません。ローカル実装・自動テストは完了していますが、Cloudflare上のDNS/TLS・配信受け入れは未実施です。

実機検証は[専用hostnameでの受け入れ手順](custom_domain_live_acceptance.md)を参照してください。

## 前提

- 初期化済みM6サービスに、1つの専用hostnameを接続します。複数domain・Show別domain・他サービスの接続の採用はしません。
- 対象hostnameを含むZoneが同じCloudflare accountのactive/full構成であり、Cloudflareが権威DNSを提供している必要があります。登録事業者の移管は不要です。
- 既存のA/AAAA/CNAME/NSや別Workerへの接続は上書きしません。hostname変更はremove後にaddします。
- `CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_API_TOKEN`、workspaceの管理鍵が必要です。追加でWorkers Scripts Write、Zone Read、DNS Readの権限が必要になるAPIを使います。tokenをTOMLやGitへ保存しないでください。
- workers.devを有効なまま維持します。CLIの管理APIは常にworkers.devへ送信し、独自domainへ管理鍵・API tokenを送りません。

## 追加

最初に対応buildで既存の通常deployを行ってください。domain操作自体はWorkerを再配備しません。その後、service workspaceで実行します。

```sh
castloop service-pause NEW_PAUSE_UUID
castloop service-status
# Existing invocations and Show owners must settle before proceeding.
castloop domain add podcasts.example.com
castloop domain list
castloop service-resume NEW_PAUSE_UUID
```

`domain add`は接続、実際のHTTPS/TLS到達、active Showのfeed再生成・cache purge、R2/ローカル設定同期を順に行います。完了してもpausedのままです。再開後にfeed・画像・音源の配信を確認してください。

RSSの正規URLは独自domainになります。workers.devも同じ内容をredirectなしで配信します。音源・revision・GUID・公開日時・ShowのサイトURLは変えません。非公開/削除/draftのコンテンツは復活させません。Podcast directoryの登録URL変更は管理者が行い、購読先の自動変更・redirectは提供しません。

## 照会と削除

```sh
castloop domain list
castloop service-pause NEW_PAUSE_UUID
castloop service-status
castloop domain remove
castloop domain list
castloop service-resume NEW_PAUSE_UUID
```

listは読み取り専用です。接続の全件、正規URL、管理URL、設定不一致、service owner/token、unfinishedなlocal操作とlockをJSONで返します。想定外の複数接続を隠しませんが、変更操作は拒否します。

removeは先に正規URLとactive feedをworkers.devへ戻し、cache purge・設定同期・workers.dev到達を確認してから、対象Workerの一致するdomain IDだけを切断します。コンテンツ自体は削除しません。Cloudflare側に残る証明書の整理は別操作であり、自動削除はしません。

## エラー時

workspace、`castloop.toml`、`.castloop/`を保持してください。操作記録は`.castloop/domain-changes/SERVICE_ID/OPERATION_UUID.json`です。remoteではservice admissionと`system/service-url-changes/OPERATION_UUID/progress.json`を保持します。

- **TLS準備待ち / 確認済みのpurge失敗:** 原因を解消後、同じadd/removeを再実行してください。unfinishedな固定要求を再利用し、成功済みの接続を繰り返しません。必要なら`--operation-id OPERATION_UUID`を付けます。
- **管理APIの応答喪失:** 同じ要求のreceiptと進捗が確認でき、対応tokenがsettledの場合だけ続行します。完了markerだけでownerを解放済みとは扱いません。
- **ローカル設定の未同期:** remoteが同じ固定要求のtarget hashへ到達している場合だけ同期します。無関係なローカル編集は上書きせずエラーにします。元/目標以外の設定へ手動変更して操作をやり直さないでください。
- **Cloudflare接続/切断要求そのものの結果が不明:** listで照会はできますが、想定結果が見えることだけでIO終了とは判定しません。pending記録・connection tokenを保ち、再送や強制解放は行いません。
- **残存lock / Worker execution token:** 古い実行が生存不明ならblockedのままです。時間経過、HEAD不在、接続照会だけで削除・解放しないでください。

通常の公開feed/画像/音源はpaused中に503です。TLS確認用の公開probeはnonceとservice/Worker/versionだけを返し、秘密やコンテンツを公開しません。自動再開・自動rollback・未知IOからの万能な復旧はこのMVPには含めません。
