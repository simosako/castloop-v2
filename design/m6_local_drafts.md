# M6: 登録receiptに基づくローカル下書き作成

更新日: 2026-10-02

## 範囲

未公開helperの`createM6LocalShowDraft`と`createM6LocalEpisodeDraft`を追加した。M6 Show登録journalの同一service/account/Worker/origin/Showに対する`registered`と一致receiptを要求し、既存の非期限client lock下でローカルTOMLを新規作成する。公開CLIの`create-show`/`create-episode`はまだ切り替えない。

- Showは管理者が指定するHTTP(S) site URLをstrict metadata schemaで検査する。Show slugをdirectory名として`show.toml`を作り、coverは作成・アップロードしない。将来の公開CLIではsite URLの入力検査をreserve送信前にも行う。
- Episodeは同じ登録receiptとローカルShow TOMLのShow ID一致を要求する。GUIDをUUIDとして生成し、現在時刻を秒・UTC offset `Z`を含む引用されたRFC 3339文字列として`published_at`へ保存する。
- ローカル作成はCloudflare HTTP・R2・Queue・purgeを呼ばず、Show/Episode controlや公開状態を変更しない。保存済みの登録receiptは過去の登録証拠であり、現在の公開状態・remote mutation権限・M6 readinessを証明しない。remote staging/publicationでは既存のlifecycle/owner/generation gateを別途通す。

## 保存と中断

Show directoryは非recursiveなexclusive mkdir/0700、TOMLはexclusive create/0600/file fsync/directory fsyncで保存する。Show directory作成後は親directoryもfsyncする。既存directory・TOML・symlinkを上書き・採用せず、既存EpisodeのGUID/dateを再生成しない。ローカルmetadata編集は登録journalへ反映しない。

登録journalがmissing/prepared/requested、foreign、不正な場合や残存lockがある場合は作成を拒否する。旧`.castloop/state.json`の`confirmed`を登録receiptへ変換せず、UUIDを再生成して別の予約へ逃がさない。新規draft helperはlegacy stateを読み書きしない。

Show TOMLはpublication入力と共通の1MB bounded/no-follow/nonblocking regular-file readerを使い、実read上限・前後stat・strict UTF-8・strict TOML schemaを照合する。workspace/Show parentのsymlinkも拒否する。

disk/fsync失敗時には部分directory/fileを保持してエラーにする。繰り返し作成でこれを上書き・削除して回復したことにしない。登録済みでもShow TOMLが作成できない場合があるため、登録とローカルdraft作成は原子的transactionではない。部分file/残存lockの明示復旧と既存legacy workspaceへの移行は別の残件である。

## 検証と残件

実local disk→durable登録runner→内部登録APIから、Show/Episode TOML作成・private permission・現在時刻/GUID・journal不変・remote呼出増加なしを結合testで確認した。missing/prepared/requested/legacy confirmed・foreign identity・残存lock・既存/partial directory・既存Episode・同時作成・不正URL/slug・symlink parent/metadata/Episode・過大/不正UTF-8/破損/foreign Show TOMLを回帰した。

全725テスト/11515 assertions、TypeScript/M6実証tsconfig、candidate/bridge browser bundle、内部helper Bun bundleと既存Linux binary build/version/helpに合格。binaryには新helperを公開せず、現行CLIの回帰確認である。Cloudflareへの書込/deployは行っていない。公開CLI切替、staging/publicationのlocal draft state統合、既存workspaceの移行、安全な外部復旧・専用環境受け入れは未完了である。
