# RSSからのPodcast移行（M7開発版）

この機能はM7ブランチの開発版向け。公開済みv0.3.0バイナリには含まれない。CLIとWorkerの両方にM7対応が必要。

## 対象

- 管理者が移行する権利を持つ、公開RSS 2.0の番組。
- 取得したRSSに含まれる全Episodeを、新規Showへ一度取り込む。
- 音源はMP3、1件300,000,000 bytes以下。番組カバーはJPEG／PNG、5,000,000 bytes以下。
- 既存Showへの追加、定期同期、ページ分割の自動追跡、音源変換、旧ホストの削除は行わない。

## 1. ローカルへ取り込む

まず件数、不足項目、対応しないRSS項目を確認する。この操作はRSSだけを取得する。

```sh
castloop import-rss my-show https://old-host.example/feed.xml --dry-run
```

空のディレクトリへ素材とTOMLを保存する。Cloudflare認証やサービスworkspaceは不要。

```sh
castloop import-rss my-show https://old-host.example/feed.xml --output /path/to/import
```

保存するのは`source.xml`、`show.toml`、`episode-<id>.toml`、番組カバー、`<id>.mp3`、`import.json`、私有の`.castloop/`記録。GUIDから作るEpisode IDは`ep-<SHA-256>`となる。

元RSSのGUID・公開日時・GUIDの`isPermaLink`を維持する。不足するowner email、カテゴリ、サイトURL等を架空の値で埋めない。`missing_fields`を確認し、TOMLで補う。

### 公開前に確認する内容

- 元ホストの全Episode件数と取り込み件数が一致するか。元RSSに載っていないEpisodeは取り込めない。
- タイトル・説明・公開日時・番組情報が正しいか。番組のWebサイトは旧ホスト廃止後も利用できる実在URLにする。
- カバーが開け、各MP3が再生できるか。
- `import.json`の`warnings`に、残す必要がある情報が含まれていないか。Episode画像・transcript・独自拡張等は保存しない。
- 説明内のリンクや画像に、廃止する旧ホストへの依存が残っていないか。それらの外部素材はコピーしない。

GUID・公開日時・`guid_is_permalink`は変更しない。他の不足項目や説明は編集できる。

download中に失敗したら、同じコマンド・同じ出力先で続行する。保存済みRSSを使い、hashが一致する完成素材を再利用する。編集したTOMLは上書きしない。取り込み先を移動せず、`.castloop/`と元MP3を保持する。

取得先は公開HTTP／HTTPSの標準portに限定する。認証付きURL、localhost・私有address、HTTPSからHTTPへのredirect、DTD／外部entity、UTF-8以外のXMLは非対応。

## 2. 確認した内容を公開する

サービスworkspaceで、対応する開発版CLIを使用する。既存Workerの更新は[通常更新手順](../README.md#compatible-worker-updates)に従い、最後に明示resumeする。

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
cd /path/to/service-workspace
castloop service-status
# external_episode_guids: true、admission.state: "open"を確認する。
castloop publish-rss-import /path/to/import
```

全TOML・素材を検証した後、Show登録・Show公開・各Episodeの公開を既存runnerで順番に実行する。既存または削除済みShow IDは採用しない。操作中は取り込みファイルや対象Showを別の操作で変更しない。

Episodeは古い公開日時から公開し、各jobの`published`／`released`を確認して次へ進む。**全件同時公開ではなく、完了したEpisodeから配信される。** 途中で失敗しても完了済み分を削除・rollbackしない。

完了時に新RSSの番組情報、Episode件数、GUID・公開日時・説明、音源URLを照合し、`feed_url`を返す。`subscriber_migration_completed: false`は、購読者の移行は別途必要という意味。

### 停止した場合

- 公開receiptを保存済みのjobで状態照会に失敗した、または公開待機が終わらない場合は、同じコマンドでそのjobの確認から続けられる。完了済みの公開を再送しない。
- 変更コマンドの応答が不明な場合は再送を拒否する。サービスの`.castloop/`にある登録・staging・publicationの既存journalを保持し、`local-operation-status`／`operation-status`で調べる。lockやownerを削除しない。
- 公開進捗は`.castloop/rss-imports/<serviceId>/<importId>.json`に保存する。開始後に取り込み入力や公開URL・サービスを変更したら続行しない。
- `.castloop/`の記録削除、新しいjobによる置換、`init`の再実行は復旧方法ではない。未知の変更要求からの万能な自動復旧は提供しない。

新しい版は既存UUID Episodeも読めるが、任意GUIDを取り込んだ後の旧版へのdowngradeは非対応。

## 3. 購読先を切り替える

新RSSと全音源を確認してから、旧ホスト側の移行機能で新RSSへの301 redirectを設定し、各Podcast directoryの手順に従って切り替える。castloopは旧ホストの設定や購読者の登録を変更しない。

[Appleの案内](https://podcasters.apple.com/support/837-change-the-rss-feed-url)ではGUID維持に加え、redirect等を少なくとも4週間維持することが求められる。移行確認と必要な維持期間を満たし、旧ホスト依存の素材が残っていないことを確認してから旧環境を廃止する。取り込み完了だけを理由に削除しない。
