# M6: ローカル下書きからのstaging要求準備

更新日: 2026-10-02

`prepareLocalStagingUpload`を追加した。callerが事前に固定するupload operation ID/draft job ID/対象/期待generation/created_atと、Show・Episode metadata・audioの選択を受け、現在のlocal入力からstrictなupload manifestを組み立てる。IDを生成せず、既存legacy stateを変換しない。期待generationはserver受付で別途検証するため、helper単独でownerやPUT権限を成立させない。

## 入力と保存

- Showは`<root>/<showId>/show.toml`をbounded/no-follow/strict UTF-8/schemaで読み、Show IDとsite URLを検査する。`image_path`の実coverをstream hashし、JPEG/PNG署名・extension一致・5MB以下を要求する。
- Episode metadataは`episode-<episodeId>.toml`のstrict schema/IDを検査して現在bytesをhashする。metadata上限は1MBである。
- audioは同じEpisode TOMLのIDを確認し、指定MP3のregular file/no-follow/300MB以下/全量stream hashと共通MP3解析のdurationを検査する。解析後に全量hashを再照合し、metadataも再読する。audio-onlyによるbase metadataの再利用可否やGUID/date一致はpublication guardとserverで別途検査する。
- sourceの読取は64KiB単位で、全量媒体をapplication bufferへ保持しない。size/mtime/ctime不変を要求し、size超過はhash/parserより先に拒否する。workspace/Show parentのsymlinkも拒否する。
- 検査後に既存private source snapshotを作り、同じhash/sizeの`prepared` staging journalをdurable保存する。返すsource paths/durationはメモリ内の値で、journalへ本文/path/GUID/メール/secretを複製しない。

## 中断と一度限り実行

既存operationがprepared以外、foreign、不正、残存lockありなら準備を拒否する。同じprepared要求の明示的な再準備だけは可能で、入力が変わった場合は既存recordを上書きしない。snapshot作成中に別の操作がphase/lockを変更した場合も拒否する。journal準備失敗では自分の一時snapshotだけを除き、既存record/lock/sourceを消さない。

準備は管理HTTP/REST PUT/Queueを実行しない。返したsourcesの`assertCurrent`を既存runnerの`checkLocalInputs`へ接続し、claim/begin/PUT直前の最新source検査と送信前requested保存を維持する。正常/例外IO完了前にsnapshotをdisposeしない。REST単一PUT/U1の未検証仮定とserver owner/generation gateは変更しない。

## 検証と残件

3入力種別でlocal file→自動manifest→durable journal→実内部staging API→simulated REST単一PUT/全量GET検証→settlement/finishまで結合した。publication commitは送らず、source不変・保持journalの本文/secret非保持も確認した。PNG署名、asset選択/ID一致、過大/不正MP3・foreign metadata・symlink、全chunk hash、preparedの同要求再準備/変更拒否、requested/残存lock保持を回帰した。

全746テスト/11732 assertions、TypeScriptと内部helper Bun bundleに合格。Cloudflareへ書込/deployせず、公開CLI gateを変更しない。targetごとのdurable draft ID管理、公開CLIへの組込、acknowledged stagingからのpublication要求組立、unknown outcomeの外部復旧と実Cloudflare/300MB受け入れは残る。
