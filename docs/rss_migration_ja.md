# RSS取り込みと購読先の移行

別の配信サービスで管理しているPodcastを、新しいcastloopの番組へ移す手順です。

1. RSSと素材を手元にダウンロードする
2. 番組情報とエピソードを確認する
3. castloopに公開する
4. 旧サービスから購読先を切り替える

取り込みには、自分が管理する公開RSS 2.0のURLを使います。音声は300,000,000バイト以下のMP3、カバーは5,000,000バイト以下のJPEG・PNGが対象です。

## 1. RSSと素材をダウンロードする

まず、取り込む件数や不足している項目を確認します。

```sh
castloop import-rss my-show https://old-host.example/feed.xml --dry-run
```

続いて、保存先を指定してダウンロードします。保存先は新規または空のフォルダにし、親フォルダは先に作成してください。

```sh
castloop import-rss my-show https://old-host.example/feed.xml --output /path/to/import
```

保存先には、元のRSS、`show.toml`、エピソードごとのTOMLとMP3、カバー、`import.json`、進捗を保存する `.castloop/` が作られます。

## 2. 内容を確認・編集する

ダウンロードが完了したら、次の順に確認します。

1. 旧サービスのエピソード件数と、取り込んだ件数を比べます。取り込み対象は、指定したRSSに掲載されている回です。
2. `import.json` の `missing_fields` と `warnings` を確認します。
3. `show.toml` とエピソードのTOMLを開き、番組情報、所有者の連絡先、タイトル、説明を整えます。
4. カバーを開き、MP3を再生して確認します。
5. 説明文にある旧サービスへのリンクを確認し、移行後も使うリンク先に更新します。

エピソードのGUID、公開日時、`guid_is_permalink` は、元のRSSから取り込んだ値を使ってください。

### castloopの番組サイトを使う場合

`show.toml` の `site_mode` を次のように設定し、`site_url` の行を削除します。

```toml
site_mode = "builtin"
```

見た目や日付表示も設定したい場合は、[番組サイト](show_website_ja.md)を参照してください。外部サイトを紹介先として使う場合は、`site_url` を移行後も使えるURLにします。

## 3. castloopに公開する

[サービス作成](getting_started_ja.md#2-サービスを作る)の手順で公開先を用意し、Cloudflareの環境変数を設定します。番組の登録は次の公開コマンドで行います。

```sh
castloop service-status --workspace /path/to/workspace --json
```

`publication_ready` が `true` であることを確認し、公開を始めます。

試験用の番組を限られた人だけに公開する場合は、先に[アクセス保護](../design/security.md#非公開の実機試験)を設定してください。

```sh
castloop publish-rss-import /path/to/import --workspace /path/to/workspace
```

番組情報、古いエピソード、新しいエピソードの順に公開されます。完了した回から配信が始まるため、実行中は取り込みファイルをそのまま保管し、コマンドの終了を待ってください。

未来の公開日時が付いた回を今すぐ公開する場合は、内容を確認して `--allow-future-published-at` を付けます。指定日時まで待って公開する回には、[予約公開](scheduling_ja.md)を使ってください。

完了したら、出力された `feed_url` を開きます。番組情報、件数、各回のGUID・公開日時・説明を確認し、番組サイトやPodcastアプリで音声を再生してください。

## 停止した場合

実行していたコマンドが終了していることを確認し、停止した段階に応じて同じコマンドを再実行します。

| 停止した段階 | 再実行する操作 |
| --- | --- |
| ダウンロード中 | 同じRSS URL、番組ID、`--output` で `import-rss` を実行 |
| 公開中 | 同じ取り込みフォルダとワークスペースで `publish-rss-import` を実行 |

保存済みの素材や公開済みの内容を確認しながら続行します。取り込みフォルダ、素材、`.castloop/` の進捗記録をそろえて保管してください。公開開始後の入力は、続行時にも同じものを使います。

## 4. 購読先を切り替える

新しいRSSと音声を確認してから、旧サービス側で新RSSへのリダイレクトを設定します。登録しているPodcast配信先でも、それぞれの手順に沿ってRSS URLを更新してください。

[Appleの案内](https://podcasters.apple.com/support/837-change-the-rss-feed-url)では、リダイレクトなどを少なくとも4週間維持するよう求めています。各配信先での移行と必要な維持期間を確認してから、旧サービスの契約を終了します。
