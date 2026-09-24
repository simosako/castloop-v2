# M3 実装・検証記録

## 複数Episodeと片側更新

- `update-episode` / `update-episode-audio` のどちらかのみを実行し、`publish-episode` で明示的に公開できる。初回公開のみ両入力を必須とする。CLIは最初のstaging時に既存の公開revisionを`base_revision_id`として固定し、公開直前にも照合する。consumerはそのimmutable revisionを読み、現行revisionがbaseまたは同じjob自身であることを検証する。別jobに先を越された場合はstatus=`failed`として予約を残し、古いcommitが現行metadataやfeedを上書きしない。
- メタデータのみの場合は既存の公開音源URL・長さ・duration・SHA-256を再利用し、音源のみの場合は公開revisionからmetadataを再利用する。新音源はrevision固有の公開キーへstream copyし、古い音源は保持する。GUIDと初回`published_at`は公開済みrevisionから固定する。異なるEpisode間のGUID重複も拒否する。jobの`committed_at`に基づくrevision TOMLをimmutable履歴と現行metadataに書き、feed tag purge後にstatus=`published`、受付=`free`へ進む。旧jobの重複通知は受付IDの照合で無視する。
- 管理者用`cleanup-job`は、`published` status、commit、immutable revision、媒体サイズ・SHA-256 metadataを照合し、同jobの受付が未完了でないときだけ**staging音源**を削除する。公開MP3、revision履歴、commit、staging TOML、失敗中・未公開の下書きは保持する。自動TTLは設けない。

## 検証

専用サービス`/tmp/opencode/castloop-m1-smoke/`で2話目`second-episode`を追加し、既存の`first-episode`をメタデータのみ、続いて音源のみで更新した。いずれのjobもR2 status=`published`、Show受付=`free`。公開feedは2 itemで、GUIDが以前のTOMLと一致すること、旧・新MP3双方が元ファイルとSHA-256一致することを確認した。音源のみ更新jobのstaging MP3を`cleanup-job`で削除後も公開MP3はHTTP `200`で配信された。

ローカルテストでは、新規2話、metadataのみ→audioのみの連続更新、旧revision・音源の保持、重複GUID、GUID変更、古いbaseでの公開拒否、旧commit再配送時の巻き戻り防止、purge失敗からの再実行、同一Showへの10件同時受付で1件のみ成功、cleanupの未完了拒否を確認した。`npm run check`と`bun test`を使用する。

公開feedをRSS Feed Validatorで確認したところ、有効なRSSと判定された。唯一の推奨事項は`atom:link rel="self"`であり、レンダラーへ追加してShowを再公開した。validatorのキャッシュを回避して再検証し、有効判定・該当推奨事項なしを確認した。Apple Podcastsの公開要件（GUID不変・重複なし、各item固有のenclosure、HEADとbyte-range対応、公開画像）のうち、RSS出力、GUID、音源・画像の配信を検証した。画像の`HEAD 200`、冷たいキャッシュへのbyte-range要求で画像・MP3ともに`206`を確認した。Apple Podcasts Connectに実際の番組を登録しての審査・アートワーク検証は行っていない。参照: [Apple RSS要件](https://podcasters.apple.com/support/823-podcast-requirements)、[RSS validator](https://validator.w3.org/feed/)。

MVP公開前の残課題だった実公開jobのretry上限→DLQ→同job回復も専用Showで確認済み。手順と実測は`design/m2_implementation_log.md`の「MVP公開前の実公開job回復検証」を参照。
