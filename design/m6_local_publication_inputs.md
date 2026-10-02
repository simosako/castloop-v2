# M6: 公開直前のローカル入力照合

更新日: 2026-10-02

未公開`createLocalPublicationEffects`をdurable publication runnerへ接続した。公開CLIやlegacy stateを自動変換せず、Cloudflareの既存環境へ適用しない。

## 照合条件

- 凍結publication manifestが指定するexact staging操作集合だけを受け取る。local journalはstrict schema、同service/account/Worker/origin、finished/staged receipt、draft job/Show/Episode、期待generation、全asset hash/sizeを照合する。重複、未知応答、aborted、別対象/新しいgeneration/変更checksumは拒否する。
- 最新local TOMLはregular file/no-followで1MBまで読み、前後stat/実byte数とstrict UTF-8/TOML/schemaを確認する。staged metadataは同じ読取bytesのsize/SHA-256をmanifestへ照合する。コメントだけの後編集もstaged checksumが違えば拒否し、古いstaged copyを黙って公開しない。
- Show coverはTOMLの`image_path`が示す隣接fileと一致し、cover hash/sizeを再検査する。Episodeの変更audioも全量hash/sizeをbounded streamで検査する。不要なcover/audio pathを指定して暗黙に公開入力へ足すことはできない。
- 更新Episodeはstrictなbase revision snapshotを要求し、manifestのbase revision/対象へ照合する。staged metadataでもGUID/dateは既存runnerと同じ不変条件を守る。audio-onlyではlocal Episode draftがbaseからのmetadata射影と意味的に一致することを要求し、unstagedなtitle/description等の変更を無視しない。変更のないmetadataはコメント/書式差を許す。
- 媒体の照合後にmetadataをもう一度読み、照合中の変更も拒否する。ただしlocal file群/HTTPを原子的snapshotにするものではない。管理者は処理中の並行編集を避ける。base snapshotはremote currentの認証証拠ではなく、serverはcommit時にcurrent/base/history/staging ETagを再検査する。

## Durable操作との接続

`checkLocalInputs`をclaim/commitのPOST前requested保存より前にawaitする。純粋なlocal照合失敗ではprepared/claimedを保持し、remote POSTを送らない。送信開始後の未知応答は既存どおりrequestedで凍結し、再送しない。

commit後のretry/statusは編集可能な元ファイルを読み直さない。同jobはcommit済みの凍結requestだけを継続し、後のlocal編集を混ぜない。新編集には新draft/staging操作が必要である。照合用path/base本文はin-memory入力だけで、保持journal/status/service TOMLへ複製しない。

## 検証と残件

Show/Episode/2種改訂の最新入力、claim/commit前の未stage編集、同size媒体差替え、audio-onlyのunstaged metadata、コメント差、source欠落/symlink/過大metadata、foreign/未完了/aborted stage、base/path不一致、commit後編集と同job retryを回帰した。実local staging journal→REST/source effects→内部管理API→guarded publication→M6 Queueのローカル結合も確認した。

public update/publishのlegacy local stateからM6 draft/staging journalへの切替、base snapshotの安全な取得、MP3 duration evidence、unknown outcomeの外部復旧、専用Cloudflare/binary受け入れとCLI公開は残る。local guard単体をM6全体の公開gate合格として扱わない。
