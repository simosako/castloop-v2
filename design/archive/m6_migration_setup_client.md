# M6: pause・移行受付・旧IO終了申告のdurable client

更新日: 2026-10-02

## 実装範囲

未公開helperに、bridge切替後のadmission初期化/pause、drain確認と移行claim、明示的quiescence申告、1-stepだけのShow/Episode初期化を接続した。初回bridge deployと候補deployのjournalは流用せず、サービス単位の別recordへ入力を凍結する。初期化の工程loop、候補deploy、移行完了、M6受付再開を自動実行しない。既存環境へ適用せず、CLI書込commandも公開していない。

読み取り専用の`castloop migration-status --local`だけを追加した。ネットワーク/管理key/Cloudflare tokenなしでローカルsetup recordとlockの存在を表示し、`remote_state_checked=false`を返す。通常の`migration-status`は認証GETでserver状態を照会し、旧Workerは対応routeを提供しない。Release済みv0.1.2 binaryにはこの追加機能は含まれない。

## 凍結recordと排他

`.castloop/migration-setups/<serviceId>.json`にstrictなbridge検査receipt、管理者が指定したpause/migration IDとRFC3339 timestamp、新規管理書込/他deploy停止の明示申告を保存する。サービス単位のfilenameなので、別UUIDを作ってunknown claimを回避することを同workspace内で拒否する。別端末/workspaceには及ばない。

directory 0700/file 0600、exclusive初期作成、private temp file→file fsync→rename→directory fsyncで更新する。同fileの`.lock`をexclusive create/fsyncし、全HTTP/保存Promise終了まで保持する。残存lockの自動奪取/削除を提供しない。live lock中でもoffline照会は観測だけできるが、存在/不在をremote処理の終了証明として扱わない。

claimのgenerationは、pause後に同owner/空registryをGET確認してから一回だけ固定する。claim ID/pause ID/created_at/bridge version、後続のquiescence全文とclaim hashを照合し、凍結値変更・phase後退/飛ばし・foreign effectsを拒否する。本文/メール/secret/任意exceptionは保存しない。

## 明示的な工程

1. `runMigrationSetupPause`は同bridge version/tag/legacy modeを照会し、`admission_requested`をdurable保存→初期化POST→`admission_ready`保存へ進む。その後、同service ownerを再照会し、`pause_requested`保存→pause POST→`paused`保存とする。claimへは進まない。
2. `runMigrationSetupClaim`は`paused`だけを受け付ける。live invocationがあればpauseを保持し、まだgeneration/requestを固定しない。registryが空なら同CAS受付用のclaimをdurable保存して`claim_requested`へ進み、一回のclaim POST成功後だけ`claimed`を保存する。
3. `runMigrationSetupQuiescence`は`claimed`と同request hash/bridge/ownerだけを受け付ける。管理者が入力した旧端末/Worker invocation/REST PUT終了と今後の旧書込禁止の明示申告を`quiescence_requested`へ保存し、一回のPOST成功後だけ`quiesced`にする。true/timestampを自動生成せず、初期化/apply/deploy/受付再開へ進まない。
4. `runMigrationSetupInitializationStep`は`quiesced`または前step確認済みの`initialization_pending`だけを受け付ける。同bridge/tag/owner/凍結quiescence/空registry/実行token不在/bootstrap不在を確認し、server progressが前回確認済みprogressと完全一致することを要求する。step番号、1〜100の`maximum_targets`、開始前progressを`initialization_requested`へdurable保存してから、`apply`を一回だけ呼ぶ。
5. 初期化POSTのstrictな`pending`応答と、その後の認証GETを照合し、plan/request hash、phase、target進捗の単調性と上限を検査する。確認と保存が成功した場合だけ`initialization_pending`へ進む。`verifying`から`runtime`への確認が済めば`controls_initialized`で止まり、serviceはlegacy/migratingのままでreadinessを生成しない。空inventoryも明示的な次stepのverificationを省略しない。

初期化recordには最新stepの入力/応答/前後progressだけを保持し、対象本文やinventory全体、任意errorは複製しない。次stepは番号を1だけ増やし、前回確認済みafterをbeforeへ固定する。pendingからruntimeへPOSTを省略して進めること、同phaseのrecord変更、凍結済みstep上限/beforeの変更を拒否する。最新stepが確認済みの場合に限り次stepの上限を明示的に変更できる。最大10,000対象とverification用stepに合わせ、番号は10,001までに制限する。

各POST前に入力をdurable保存する。callbackの成功後も、次phaseの保存が失敗すれば先へ進まない。GET preflightはleaseではなく、実排他はserverのservice CAS/実行tokenで行う。登録前の旧Worker/旧CLI PUTの終了は別の外部確認であり、空registryや時刻/HEADから推測しない。

## 応答喪失と照会

`admission_requested` / `pause_requested` / `claim_requested` / `quiescence_requested` / `initialization_requested`は結果不明として保持する。HTTP409や保存失敗も、部分的なR2書込を無かったものとして再送しない。新ID/新generation/新timestampへ作り直すことも拒否する。初期化POST成功後のGET失敗、不正応答、progressの矛盾、成功phaseの保存失敗もrequestedのまま保持する。GETで対象初期化成功とtoken不在が見えてもunknown stepを確定しない。

`inspectMigrationSetup`はローカルstateと認証GETのserver statusを返すだけで、journalを変更しない。GETに同claim ownerやquiescence成功recordが見えても、元のrequest/invocation終了を認定してunknown phaseを進めない。statusはquiescenceをbounded/strictに読み、owner/request/bridgeとの矛盾をfail closedで拒否する。未知execution tokenが残る場合も、時刻やGETから奪わない。

明示的な`resumeMigrationSetupPause`は`admission_ready`だけを受け付ける。このphaseは初期化応答成功とdurable保存が済み、pause POSTはまだ消費していないことを示す。requested phaseや`paused`以降からPOSTをやり直す経路ではない。

`migration-status --local`はlockを取得/作成/削除せず、recordを作らず、HTTPを呼ばず、phase/tokenも変更しない。remote状態やsafe retry/readinessの証拠を返さない。破損/過大record、不明field、foreign service/account/Worker、claim hash不一致は拒否する。

## 検証と残件

ローカルhandler結合で正常なpause→claim→明示申告、live registry drain、各POST応答喪失、GETで成功を観測してもunknown保持、live client排他、残存lock、保存失敗、unknown token取得応答喪失、入力/hash/phase変更拒否を確認した。初期化はEpisode→Show順序、payload保持、空inventory、1-step上限、runtime停止、外部step進捗の非採用、終了後GET失敗、偽completion/phase、hash/上限/owner/token/申告変化、phase飛ばしを回帰した。offline CLIはfetchを禁止した子processと、key/tokenのないworkspaceで検査した。

Cloudflare実機/実response形状/旧IO実終了/全cache scope/外部hostname・colo/300MB/CPU・料金の合格ではない。unknown request/残存lock/tokenの安全な外部復旧、full cutover/paused完了/明示受付再開とCLI書込公開は残件であり、`m6_ready=false`を維持する。
