# RSS取り込みと購読先の移行

外部RSSをローカルへ取得し、内容を確認・編集してから新しいShowへ一度だけ取り込む手順です。取得と公開は別の操作です。公開先は[現行形式のサービス](README.md#対象と用語)を使い、使用するCLIとWorkerの内部形式を一致させてください。

ローカルへの取得には、Cloudflare認証やサービスワークスペースは不要です。公開進捗のローカル記録はversion 3だけを扱い、古いサービス・進捗記録の移行や変換は行いません。

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

空のディレクトリへ素材とTOMLを保存します。親ディレクトリは事前に作成してください。

```sh
castloop import-rss my-show https://old-host.example/feed.xml --output /path/to/import
```

保存するのは`source.xml`、`show.toml`、`episode-<id>.toml`、番組カバー、`<id>.mp3`、`import.json`、私有の`.castloop/`記録。GUIDから作るEpisode IDは`ep-<SHA-256>`となる。

元RSSのGUID・公開日時・GUIDの`isPermaLink`を維持する。不足するowner email、カテゴリ、サイトURL等を架空の値で埋めない。`missing_fields`を確認し、TOMLで補う。

### 公開前に確認する内容

- 元ホストの全Episode件数と取り込み件数が一致するか。元RSSに載っていないEpisodeは取り込めない。
- タイトル・説明・公開日時・番組情報が正しいか。番組のWebサイトは旧ホスト廃止後も利用できる実在URLにする。
- [内蔵サイト](show_website.md)を使う場合は、最初の公開前に`show.toml`へ`site_mode = "builtin"`を追加し`site_url`を削除して確認する。既定では元RSSの外部サイトURLを維持する。GUID・日時は変更しない。
- カバーが開け、各MP3が再生できるか。
- `import.json`の`warnings`に、残す必要がある情報が含まれていないか。Episode画像・transcript・独自拡張等は保存しない。
- 説明内のリンクや画像に、廃止する旧ホストへの依存が残っていないか。それらの外部素材はコピーしない。

GUID・公開日時・`guid_is_permalink`は変更しない。他の不足項目や説明は編集できる。

download中に失敗したら、同じコマンド・同じ出力先で続行する。保存済みRSSを使い、hashが一致する完成素材を再利用する。編集したTOMLは上書きしない。取り込み先を移動せず、`.castloop/`と元MP3を保持する。

取得先は公開HTTP／HTTPSの標準portに限定する。認証付きURL、localhost・私有address、HTTPSからHTTPへのredirect、DTD／外部entity、UTF-8以外のXMLは非対応。

## 2. 確認した内容を公開する

[サービス作成ガイド](getting_started.md)に従って公開先を用意し、そのワークスペースで実行します。公開コマンドが新Showを登録するため、同じIDのShowを先に作成する必要はありません。他のShowは変更しません。試験環境では、素材のアップロード前に[非公開の保護条件](../design/security.md#非公開の実機試験)を満たしてください。

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
cd /path/to/service-workspace
castloop service-status
# Confirm publication_ready on the SQLite service.
castloop publish-rss-import /path/to/import
```

全TOML・素材を検証した後、Show登録・Show公開・各Episodeの公開を順番に実行します。入力上限の超過を切り詰めて公開することはありません。エラーになった入力を編集し、公開前に再確認してください。既存または削除済みShow IDは採用しません。操作中は取り込みファイルや対象Showを別の操作で変更しないでください。

インポート元Episodeに未来の`published_at`がある場合、RSS一括公開はそれを待たず即時公開する。開始前に`--allow-future-published-at`を要求し、指定がなければ`future_published_at`で失敗する。将来日時で公開したいEpisodeは、RSS一括公開ではなく`preview-episode-schedule`／`schedule-episode`を使う。

Episodeは古い公開日時から同期公開し、各応答を確認して次へ進む。**全件同時公開ではなく、完了したEpisodeから配信される。** 途中で失敗しても完了済み分を削除・rollbackしない。

公開先の `publication_ready: true` と、各公開結果の `changed`／`unchanged`・現在のリビジョンを確認します。取り込み全体の進捗はローカル記録へ保存するため、途中で `.castloop/` を削除しないでください。

完了時に新RSSの番組情報、Episode件数、GUID・公開日時・説明、音源URLを照合し、`feed_url`を返す。`subscriber_migration_completed: false`は、購読者の移行は別途必要という意味。

### 停止した場合

- 複数Episodeは逐次処理のため、import全体は数分以上かかり得る。同じworkspaceまたは取り込みディレクトリで変更するCLIは1プロセスだけ実行する。ロックファイルは使わないため、元processの終了を確認してから再実行する。
- 公開応答を失った場合も、同じ取り込み入力で`publish-rss-import`を再実行できる。完了済みの同じ内容は変更なしとなり、進捗を続ける。更新元を自動で取り直す通常公開retryは行わない。
- Show登録の応答が不明でも、元の進捗記録を保持して同じコマンドで続行します。サービス側への編集元コピーの完了前に中断した場合は、CLIが確認済み取り込み元からTOML・カバー・CSSを作り直します。取り込み元や登録済みShow、公開済みEpisodeを手動で削除しないでください。
- SQLite管理GETの一時障害は最大3試行。POST/PUTを自動再送しない。
- `.castloop/`、取り込み元のTOML/cover/audio、元workspaceを保持する。公開開始後に入力・公開URL・サービスを変えたり、進捗記録を削除したりしない。
- 状態は`show-status`、現在内容はpreview・履歴、配信は`verify`で確認する。

GUIDはUUIDに限らず元RSSの文字列を維持する。旧形式のCLI／Workerへのdowngrade・記録変換は非対応。

現在内容と配信の確認は[診断ガイド](troubleshooting.md)を参照してください。現行版のRSS一括取り込みの実機性能・全Free適合は未実証です。検証範囲は[テスト設計](../design/testing.md#実機検証と証明できる範囲)、過去の測定は[設計アーカイブ](../design/archive/README.md)に分けて記録しています。

## 3. 購読先を切り替える

新RSSと全音源を確認してから、旧ホスト側の移行機能で新RSSへの301 redirectを設定し、各Podcast directoryの手順に従って切り替える。castloopは旧ホストの設定や購読者の登録を変更しない。

[Appleの案内](https://podcasters.apple.com/support/837-change-the-rss-feed-url)ではGUID維持に加え、redirect等を少なくとも4週間維持することが求められる。移行確認と必要な維持期間を満たし、旧ホスト依存の素材が残っていないことを確認してから旧環境を廃止する。取り込み完了だけを理由に削除しない。
