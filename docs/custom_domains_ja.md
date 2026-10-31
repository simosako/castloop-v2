# 独自ドメインの設定と変更

`podcasts.example.com` のような専用サブドメインを、一つのサービスの配信先に設定できます。そのサービスのすべての番組が同じドメインを使います。

## 1. ドメインを準備する

次を用意してください。

- Workerと同じCloudflareアカウントでDNSを管理しているドメイン
- 配信に使う未使用のサブドメイン
- 対象ドメインのZone ID
- 通常の管理権限に加えて、対象Zoneの読み取り、DNSの読み取り、Workers Routesの操作権限を持つAPIトークン

Cloudflareのダッシュボードで、対象ドメインの設定（Zone）が有効になっていることを確認します。アカウントIDとAPIトークンを環境変数に設定し、サービスのワークスペースを用意してください。

ドメインの切り替え中は配信が一時停止します。予約公開は再承認が必要になるため、作業する時間を決めてから始めます。切り替え中のDNSとWorkerのドメイン設定は、castloopに任せます。

## 2. 独自ドメインを追加する

サービスの状態を確認します。

```sh
castloop service-status --workspace /path/to/workspace --json
```

ホスト名とZone IDを実際の値に置き換えて実行します。

```sh
castloop domain add podcasts.example.com --zone-id ZONE_ID --workspace /path/to/workspace --json
```

接続、DNS・TLSの確認、配信先の切り替えが順に行われます。実行結果に表示された操作IDを控えてください。中断した場合は、下の「照会と中断後の継続」に進みます。

## 3. 配信を確認する

```sh
castloop domain list --workspace /path/to/workspace --json
castloop service-status --workspace /path/to/workspace --json
```

新しいドメインと `publication_ready: true` を確認し、ブラウザでRSS、番組サイト、音声を開きます。手元の `castloop.toml` も新しい公開URLに更新されます。

切り替え後、以前の `workers.dev` のRSS URLは独自ドメインへ転送されます。以後の編集は、新しい設定でプレビューして公開してください。

予約がある場合は、[再承認](scheduling_ja.md#再確認が必要な予約を承認する)を行います。

## 照会と中断後の継続

中断した操作のIDを `OPERATION_UUID` に入れ、状態を確認します。

```sh
castloop domain status OPERATION_UUID --workspace /path/to/workspace --json
```

対象ドメインと変更内容を確認し、同じ操作を続行します。

```sh
castloop domain continue OPERATION_UUID --workspace /path/to/workspace --json
```

`domain_tls_pending` はDNS・TLSの準備待ち、`domain_rollout_pending` はWorkerの反映待ちです。時間を置いて状態を確認し、続行してください。ワークスペースと `.castloop/` の操作記録は保管したまま使います。

## 独自ドメインの利用をやめる

独自ドメインを外すと、配信先は `workers.dev` に戻ります。購読アプリが独自ドメインのURLを記憶していることがあるため、先に購読先の変更方法を確認し、リスナーへの案内と配信先の登録変更を行ってください。

```sh
castloop domain remove --workspace /path/to/workspace --json
```

完了後に `domain list` と `service-status` を確認し、`workers.dev` のRSSと音声を開きます。この変更後も、予約がある場合は再承認を行います。
