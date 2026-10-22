# Show/Episodeメタデータの項目別入力上限（Issue #31）

Apple Podcasts RSSを規範とし、新規入力だけに適用する。保存済みsnapshot/revisionの読取・復元は無制限のまま維持し、無断切り詰め・履歴書換え・暗黙変換は行わない。

## 規範

- Apple A Podcaster's Guide to RSS: Show `description`最大4000 bytes、Episode `description`最大10000 characters、他tag値は別記なき限り255 characters。
- Apple Podcasts Connect: Episode名最大150 characters（RSS経路では255の大きい方を取る）。
- Spotify Delivery Specification v1.10: ハード上限なし。descriptions以外のconsumer facing要素は20文字推奨・超過は表示truncate（拒否根拠にしない）。

## 値と単位

| 項目 | 上限 | 単位 |
| --- | --- | --- |
| Show `title`/`author`/`owner_name`/`owner_email`/`categories[]各要素`/`copyright` | 255 | Unicode code point、trim後、HTML tag除外 |
| Show `description` | 4000 | 除外後テキストのUTF-8 bytes |
| Show `site_url` | 2048 | 文字。Apple 255と実用URLの大きい方を取る |
| Episode `title` | 255 | 同上 |
| Episode `description` | 10000 | 同上（Apple RSS値。ホスト互換4000の小さい方は取らない） |

解釈に迷うところは大きめに取る。HTML tagは`<[^<>]*>`除去後に測る。文字は`Array.from`のcode point数で、UTF-16サロゲートや結合文字を不利に数えない。`site_url`前後空白はtrimして測る。`language`/`explicit`/`show_type`/`episode_type`/番号・日時は既存形式のままで上限を追加しない。`image_path`はローカルパスのため対象外。`categories`の件数上限は設けず要素単位のみ制限する。

## 適用範囲

- 適用: `update-show`/`update-episode`のstage時（`SqliteDraft.metadata`）、Worker公開実行のstaging読取（`sqlite-publication-executor`、超過は`validation_failed`）、RSS取込の検証報告（`parseRssImportFeed`の`missing_fields`、TOMLは無加工で保存し編集を促す）。
- 非適用: 保存済みsnapshot/revision/snapshot復元・lifecycle復元の読取（`showMetadataSchema`/`episodeDraftSchema`/`episodeRevisionSchema`は無制限のまま）。一覧表示は従来通りDB側`substr(...,1,200)`で200文字表示に切る。
- 既存の全体上限（ローカルTOML 1M、RSS XML 8M、取込準備8M/rendering換算32M、公開要求/draft journal 16K）は変えない。
- 全体上限は項目別上限とは独立する。公開後のrevision JSON合計2,000,000 code points・最大10,000件と保守的rendering予算を、外部書込前に検査する。RSS事前検証は同じshared予算定義とrevision付加fieldの保守的見積りを使う。保存済み履歴を切り詰めたり、未知IOのblockedをfailedに変更するものではない。

## 検証

- `packages/shared/src/metadata-limits.test.ts`: 境界（255/256、4000 bytesの多バイト境界1333/1334、10000/10001）、絵文字のcode point数、HTML除外、保存schemaが超過履歴を読み続けられること。
- `packages/cli/src/rss-import-feed.test.ts`: Show/Episode超過が`missing_fields`に報告されること。
- `src/sqlite-publication-executor.test.ts`: Show/Episode超過payloadが書込前に`validation_failed`で止まること。
