# Show/Episodeメタデータの項目別入力上限（Issue #31）

v0.8.0（内部queue/content形式14/13）の入力制約。Apple Podcasts RSSを規範とし、新規入力だけに項目別上限を適用する。保存済みsnapshot/revisionの読取・復元には新規入力の項目別上限を追加せず、無断切り詰め・履歴書換え・暗黙変換は行わない。読取量・描画量の全体上限とは別の制約である。

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

- 適用: CLIの`validate`・`preview-*`・`publish-*`が読む新規入力（`showMetadataInputSchema` / `episodeDraftInputSchema`）、Workerが受ける直接公開要求のmetadata、RSS取込の検証報告（`parseRssImportFeed`の`missing_fields`）。RSSのTOMLは切り詰めず保存し、編集を促す。`publish-rss-import`の事前検証でも編集後TOMLを検査し、Showは素材走査前、各Episodeはその音源走査前に拒否する。Show登録・素材配置・公開は事前検証の完了後に行う。旧`update-*`・staging・公開job台帳は使わない。
- 非適用: 保存済みsnapshot/revisionの読取・過去版採用・lifecycle復元のmetadata（`showMetadataSchema` / `episodeDraftSchema` / `episodeRevisionSchema`には新規入力の項目別上限を追加しない）。ただし、読取量と描画量の全体上限は適用する。一覧のタイトル要約はDB側`substr(...,1,200)`で最大200文字とする。
- ローカルTOMLは1,000,000 bytes以下（ShowのCSS同梱後も同じ上限）。RSS取り込みと公開前に読む保存済みXMLは8 MiB以下。直接公開要求はmetadataをJSONに含み、`MAX_SQLITE_DIRECT_PUBLICATION_BYTES`（1,000,000 bytes＋管理要求の上限）で検査する。旧draft journalの16 KiB制約を公開metadataへ適用しない。
- 全体上限は項目別上限とは独立する。公開後のEpisode revision JSON合計2,000,000 code points・最大10,000件と保守的な描画予算32,000,000 bytesを検査する。RSS事前検証は同じshared予算定義とrevision付加fieldの保守的見積りを使う。超過時は公開内容を確定せず、保存済み履歴も切り詰めない。

## 検証

- `packages/shared/src/metadata-limits.test.ts`: 境界（255/256、4000 bytesの多バイト境界1333/1334、10000/10001）、絵文字のcode point数、HTML除外、保存schemaが超過履歴を読み続けられること。
- `packages/cli/src/rss-import-feed.test.ts`: Show/Episode超過が`missing_fields`に報告されること。
- `packages/shared/src/sqlite-direct-publication.test.ts`、`src/sqlite-publication-executor.test.ts`: 新規公開要求のmetadata検証、保存済み履歴の採用と公開前の全体予算検査。
