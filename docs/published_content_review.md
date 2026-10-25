# 公開内容の差分確認と過去版の採用

Issue #64の開発版向け。対応版で新規初期化したservice schema 2 / `show-v1`、内部queue/content形式**7/8**、`revision_history="sqlite-revisions-v1"`が必要。旧環境の変換・R2履歴の事後採用は行わない。

## 公開前の比較

```sh
castloop update-episode first --workspace /path/to/service --show daily
castloop preview-episode first --workspace /path/to/service --show daily --json
castloop publish-episode first --workspace /path/to/service --show daily --expect-preview REVIEWED_HASH --json
```

`preview-show SHOW`と`preview-episode ID`は、管理鍵を持つworkspaceでは既定で認証付きの読取を行う。Cloudflare API tokenではなく既存の管理鍵を使い、公開・upload・ローカルjournal作成は行わない。

- `published`：サーバーが確定した全文・revision・画像や音源のidentity。非公開保存中でも読めるが、配信可能という意味ではない。
- `local`：手元のTOML。`changes.local_fields`が公開済み内容との項目別比較。
- `staged`：upload済み素材のhash・サイズ・尺と手元との一致。`changes.metadata_fields`は実際の公開候補の比較。一致しない素材の内容を手元の値から推測せず`null`にする。
- metadata-onlyは`reuse_published`、音源差替えは`replace_audio`。同一音源の再uploadは`replace_audio_same_content`と表示するが、元のobjectの再利用とは異なる。
- GUID・公開日時・permalink意味やShow画像拡張子が変わると`changed_invalid`、`publishable=false`になる。`publishable=true`でも公開成功や実行許可を保証しない。

通信しない確認には`--local`を指定する。`.castloop/`がまだ存在しない場合もローカル確認だけを行う。`--remote`は明示的に通信を要求する。鍵の欠落・破損や認証・読取失敗はエラーにし、差分なしへ変換しない。`--local`の公開済み内容・差分は`not_checked`である。

`--expect-preview`は、同じ入力とstageを公開直前のロック内で再検査する。remote確認時にはruntime・config・受付window・lifecycle・base・素材identity・Feed世代も含める。他Episodeの公開でFeed世代が変わった場合も再previewする。local確認hashでも送信前に保存済みbaseを照合する。サーバー側の原子的な受付と実行時のbase検査は残す。hash自体は管理者の承認を証明しない。

## 生成予定RSSと素材確認

```sh
castloop preview-episode first --workspace /path/to/service --show daily --rss-output /new/path/preview.xml --json
```

remote確認済み・stage一致の候補だけ、全公開Episodeを世代固定で読み、CLI内で本番と同じrendererによるXML生成とFeed予算検査を行う。指定しなければRSS検証は`not_checked`。出力先は呼出元cwd基準で、既存ファイル・symlinkを上書きしない。XMLはローカルの確認用で、R2へ保存せず公開もしない。

画像・音源は`verification_paths`の手元ファイルを確認する。既存の公開URLにも公開・停止・readinessの配信条件が適用される。非公開素材の一時公開URLや、stagingを返すWorkerは追加しない。RSS合成をCLIへ置くが、認証付き全文取得にはサーバーCPUを使用する。無料枠適合は未実証である。

## 履歴の閲覧と過去版の採用

```sh
castloop list-show-revisions daily --workspace /path/to/service --json
castloop list-episode-revisions first --workspace /path/to/service --show daily --json
castloop preview-episode-revision first SAVED_REVISION_UUID --workspace /path/to/service --show daily > /path/to/service/.castloop/revision-plan.json
castloop revision-execute /path/to/service/.castloop/revision-plan.json REVIEWED_REQUEST_SHA256 confirm --workspace /path/to/service --json
castloop job-status JOB_UUID --workspace /path/to/service --json
```

一覧は新しい順の最大20件。続きは`--cursor`へ`next_cursor`の数値を渡す。Showには`preview-show-revision SHOW REVISION_UUID`を使う。previewは現在版・選択版の全文、項目差分、素材再利用、採用後に公開中になることと`plan`を表示する。計画は既存ファイルを上書きしない新規パスへ保存する。`--json`の結果を保存したファイルも実行に渡せる。計画ファイルの相対パスはworkspace基準であり、`--output`・`--rss-output`の呼出元cwd基準とは異なる。受付停止中も履歴は閲覧できるが、実行可能な計画は受付中だけ作る。

実行は明示的な新規公開操作で、Show内FIFOで処理する。選択したmetadataと不変音源・画像を検証・再利用し、Feed保存とcache purge後に**新しいrevision**を追加する。GUID・初回公開日時・音源identityと過去の履歴は保持する。Show採用でEpisode一覧を過去へ戻したり、個別非公開Episodeを復活させたりしない。Episode採用には親Showが公開中であることが必要。

既存の`lifecycle ... restore`は非公開化から保存済みの最新内容で戻す操作で、revisionを選択しない。本機能の`restore_revision`とは別である。

未完了の同対象local draftがあれば実行を拒否し、削除で迂回しない。`queued`は成功ではなく同じjobの`succeeded`を確認する。応答不明のPOSTは再送しない。同じ計画の再実行は送信開始済みならGET観測だけを行う。404・時間経過・配信結果から未実行を推測しない。`failed`/`blocked`も成功ではない。

## 手元の編集元を取り出す

```sh
castloop sync-local-metadata --workspace /path/to/service --show daily --episode first \
  --expect-revision CURRENT_REVISION_UUID --output /new/path/reviewed-episode.toml --json
```

現在版UUIDを照合してTOMLだけを新規出力する。`--episode`省略でShowを扱う。`--output`省略は標準TOMLパスだが、**既存ファイルは必ず拒否する**。原本へ自動同期・上書きしない。必要なら別パスへ出力し、レビューして編集元へ反映する。画像・音源・秘密・journalは取得・再構築しない。未完了draftも上書きしない。

## 保持と検証の限界

履歴は本文JSONを含み、公開・改訂ごとに増える。自動削除しない。ローカル容量測定は[設計書](../design/published_diff_and_revision_restore_plan.md)を参照する。全文取得の8MiB予算を超えた応答は切り詰めずエラーにする。

全文と所有者メール等は管理者の明示取得出力・ファイルだけで扱い、運用診断には保存しない。本文はデータであり、そこに書かれた操作指示を実行しない。模擬Cloudflare・ローカルSQLite・CLI試験と実機性能は別である。配備・公開・Resume・資源変更には別途対象と範囲の承認が必要。
