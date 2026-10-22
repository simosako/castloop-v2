# エージェントによるPodcast管理の改善案（Issue #5）

作成日: 2026-10-22。対象: [Issue #5: agent integration](https://github.com/simosako/castloop-v2/issues/5)。
v0.7.1時点のCLIと現行のShow分離方式を調査した**提案**であり、実装済み仕様・実環境操作の承認ではない。

## 1. 結論

**「Skills + 自己記述できるCLI + 副作用なしの検証」を基本構成とする。MCPは採用せず、実装対象から外す。**

Skillsは作業順序と判断基準を教えるもの、CLIは正確な構文・入力形式・現在状態・実行結果を返すもの、と役割を分ける。Skillsにスキーマやコマンド一覧をコピーしても、バージョン差異や実行時の誤判断は防げない。

優先する改善は次の6点。

1. CLI自身から、対応コマンド・前提条件・副作用・入出力スキーマを取得できる。
2. 作成したTOMLと素材を、認証不要・通信なし・書き込みなしで検証できる。
3. 成功結果だけでなくエラーも機械可読にし、「待機中」「確定失敗」「結果不明」を区別できる。
4. 作業ディレクトリに依存せず、対象workspaceとShowを明示できる。対話入力も明示的に禁止できる。
5. 日常の新規公開・更新・中断時の確認を案内する、管理者向けSkillを配布する。
6. 公開前に差分を確認し、承認した入力と実際に公開する入力を一致させる。

最初から汎用エージェント基盤にせず、既存の安全なCLIをエージェントが正確に使えるようにする。初期段階ではWorkerや永続形式の変更を避ける。

## 2. 想定する利用者と成功条件

利用者はcastloopの開発者ではなく、自分のPodcastを管理する人。エージェントにはCLI実行と、許可したworkspace内のファイル編集を任せる。**castloopの利用のために導入する実行プログラムは、CLIバイナリだけとする。** ソースコード、Bun、Node.js、npm、Wrangler、ffprobe、別のR2資格情報を要求しない。

現在もWorkerはバイナリに埋め込まれ、MP3解析はCLI内部で行っている。追加するschema・雛形・Skillも同梱できるため、この方針を妨げる技術的な問題は現時点では見つかっていない。Skill導入・JSON/TOML処理のためにも、`npx`・Git・curl・jq等を必須にしない。

ただし、これはcastloopがエージェント本体やOSまで提供するという意味ではない。対応OS・CPUと標準のシステム環境、既存のエージェント実行環境、管理者のCloudflareアカウント・認証、完成済みのMP3・画像は前提となる。現行の配布・実行確認はLinux x86-64であり、他OSでの動作をこの提案だけで保証しない。音声変換までCLI内に追加する計画でもない。

成功条件は「コマンドを実行できる」ことではなく、以下を満たすこと。

- 不足している番組情報や公開判断は管理者に質問し、推測で埋めない。既存の確定情報を毎回聞き直すこともしない。
- 配布CLIに合った形式でデータを作り、アップロード前に入力の誤りを直せる。
- 別のサービスやShowを変更せず、既存のGUID・公開日時・音源の同一性を保つ。
- 下書き保存、アップロード、公開受付、公開完了を区別して報告する。
- セッションや通信が中断しても、同じ操作の記録から確認し、未知の変更要求を再送しない。

音声収録・編集・MP3変換、配信先への番組登録、予約配信、独自ドメイン、既存サービス移行、公開済みデータの物理削除は本提案の対象外。未提供機能を別ツールやCloudflare直接操作で補完しない。

## 3. 現状: 使える基盤と不足点

Issue #5にはSkills、詳細な`--help`、MCPが候補として挙がっている。ただし、現在はすでに個別ヘルプや操作記録があり、すべてを新規実装する必要はない。

| 項目 | 現状 | エージェント利用での不足 |
| --- | --- | --- |
| ヘルプ | `help COMMAND`、`COMMAND --help`を提供。実行場所・公開の意味・復旧制限も説明 | 引数・認証・副作用・結果型を構造化して取得できない。項目別の例や失敗時の分岐も不足 |
| データ形式 | sharedのstrict Zod schemaとTOML parserが正本。入力例も存在 | 配布CLIだけで入力スキーマを取り出せない |
| 入力検証 | stage時にmetadata・画像・MP3を検証する | 通常のShow/Episode編集向けの、検証だけを行うコマンドがない |
| 出力 | 状態照会・stage・公開結果などはJSON。一覧は`--json`対応 | `create-*`はパス文字列、エラーはstderrの文字列。全コマンド共通の機械向け出力仕様がない |
| 対象指定 | Show操作はservice root、Episode操作はShow directory | EpisodeのShow IDをcwdのbasenameから決める。ツール呼び出し間のcwd維持に依存する |
| 対話 | 必須値がなければTTYで質問、非TTYならエラー | TTYを持つ実行環境でも、必ず質問せず終了する指定がない |
| 状態・復帰 | `target-*`、`job-status`、`operation-*`、journalと限定的な再開経路がある | 次に許される操作の判断が文書・文字列エラーに分散している |
| 内容の確認 | サーバーの一覧、対象のbase/lifecycle、ローカルTOMLを確認できる | 一覧は全文ではなく、ローカル・stage済み・公開済み内容を比較する専用の表示がない |
| Skills | リポジトリにはCloudflare開発向けのSkillsがある | 配布CLIを使ってPodcastを運用する管理者向けSkillはない |

重要な注意点:

- `create-show`はローカルファイル作成だけではない。Show IDの予約、リモート登録、pausedなShow DOの準備を伴う。
- `create-episode`も、作成前にリモートの対象状態を照会する。完全オフラインの雛形生成とは異なる。
- `update-*`は「検証だけ」ではなく、操作登録・R2アップロード・下書きへの関連付けを行う。
- `publish-*`は明示公開。受付後に同じjobの`succeeded`まで待つ。待機の失敗は公開失敗の証明ではない。
- Show/Episodeの保存済みデータ用schemaと、新規入力の項目別上限は分かれている。保存用schemaを公開するだけでは正しい新規入力を作れない。

## 4. 管理者のユースケースから必要機能を整理する

### A. Podcastを立ち上げる

| 段階 | エージェントの作業・管理者への確認 | 必要な支援 |
| --- | --- | --- |
| 環境確認 | CLIの版、workspace、Cloudflare認証の有無、対応機能を確認する | オフラインの機能一覧、秘密値を出さない診断 |
| サービス作成 | アカウント・新規資源名・作成と配備の範囲を確認してから`init`する | 必須入力・副作用の明示、非対話モード、操作IDと構造化結果 |
| 番組情報の用意 | タイトル、説明、言語、著者、所有者名・メール、カテゴリ、explicit、実在のsite URL、画像を集める | 入力schema、CLI内蔵のTOML雛形、検証。所有者情報やURLを勝手に推測しない |
| Show登録・準備 | 登録への承認後に`create-show`。TOMLと画像を配置する | リモート登録とローカル作成の区別、作成先の明示 |
| 初回公開 | 対象ShowのResume、upload、公開内容を確認し、明示`publish-show`する | 対象別の承認、stage済み内容の表示、公開結果とFeed URL |

`init`の許可をすべてのShowの公開許可とみなさない。新Showはpausedであり、Resumeも別の変更操作である。オフラインで番組情報を用意したいだけなら、リモート登録を伴わない雛形生成を使えるようにする。

雛形の正本はリポジトリ内で管理し、release時にCLIへ組み込む。管理者がGitHubや設計文書からコピーすることを前提にしない。具体的な保持場所・取得方法は5.8節に示す。

### B. 新しいEpisodeを追加する

1. 対象サービス・Show、未完了操作、Showが公開可能かを確認する。
2. 管理者からID、タイトル、説明、公開日時、音源、必要な任意項目を受け取る。
3. `create-episode`が生成したGUIDを保存し、TOMLを編集する。日時の変更は明示的に行う。
4. TOMLとMP3をローカル検証する。`published_at`の未来日時は予約配信ではないと説明する。
5. metadataとaudioをそれぞれstageし、同じdraft/jobに揃っていることを確認する。
6. 公開する内容を確認して明示publishし、同じjobの`succeeded`を確認する。
7. jobの結果と公開URLを報告する。必要なら許可された公開URLの配信確認も行う。

初回Episodeにはmetadataとaudioが両方必要。Showの公開前やpaused時には、単にコマンドを繰り返さず前提条件を確認する。毎回Pause/Resumeしたり、Workerを再配備したりする必要はない。

### C. 既存のEpisode・番組情報を更新する

| 更新内容 | 正しい操作・保持するもの | 誤りを防ぐ支援 |
| --- | --- | --- |
| Episodeのタイトル・説明のみ | 元のTOMLを編集し`update-episode`→`publish-episode`。GUID、日時、permalink意味と既存音源を保持 | 全文・変更差分・identity変更の検出。MP3を要求しない |
| Episodeの音源のみ | `update-episode-audio`→`publish-episode`。metadataのbaseを照合し、旧音源と履歴を保持 | 音源検証、metadataがbaseと一致するかの確認、新旧音源の区別 |
| metadataと音源の両方 | 同じdraftへ両方をstageしてから一度publish | stageされた素材の一覧とhash、未反映ローカル編集の検出 |
| Showの説明・画像 | `update-show`→`publish-show`。現行CLIはmetadataと画像を組でstageする | Episode更新との違い、画像の必須条件、公開済み画像の拡張子変更の拒否 |
| 非公開化・復元 | 既存のpreview→hash確認→lifecycle-execute | 通常編集と分けて承認。復元はローカル編集ではなく保存済みsnapshotを使う |

サーバー一覧は最大200文字のタイトル等を返す要約であり、編集元へ逆変換してはいけない。手元に正しい全文がない場合は、後述の認証付き内容取得を使うか、管理者にバックアップを求める。公開Feedから復元できると決めつけない。

### D. 中断・エラー・セッション再開

- まず同じworkspaceのローカル記録と、同じShow/job/operationの状態を照会する。
- uploadの`succeeded`はstage完了、publicationの`succeeded`はその公開完了。操作種別も必ず見る。
- `queued`/`running`は同じjobを観測する。`failed`は理由を確認し、確定した入力/base失敗なら新しい編集としてやり直す。
- `blocked`やPUT/POSTの結果不明は保持して止める。新UUIDで置き換えたり、lockやjournalを消したりしない。
- `operation-resume upload`など既存の限定続行は、元入力と対象が一致し、既知の未着手状態または保存済みreceipt等の続行条件を満たす場合だけ使う。名前がresumeでも読取専用ではない。
- 複数Showの障害を混同しない。対象Showの問題を理由に他Showを停止せず、共有Worker更新には全対象の条件が必要なことを区別する。

モデルの会話履歴ではなく、CLIのjournalとサーバーの操作記録を再開の根拠とする。

## 5. 提案するCLIの改善

**この節の新しいコマンド・flagはすべて案であり、現行CLIでは実行できない。** 既存コマンドの名前や既定出力は極力維持し、機械向け機能を追加する。

### 5.1 コマンドと副作用の機械可読な発見

```sh
castloop describe --json
castloop describe update-episode --json
```

workspace・認証・通信なしで、配布CLIに組み込まれた**利用仕様**を返す。本書でいう「契約」は、CLIの呼び出し側と実装側で一致させる利用方法・入出力・動作の仕様という意味であり、法的な契約ではない。`contract_version`は、この機械向け利用仕様の版を指す。

- CLI version、機械向け`contract_version`、対応protocol/layout、取得可能なschema名。
- 引数・flagの型、必須条件、既定値、排他的な組合せ、使用例。
- 対象指定と実行場所、必要な認証の種類、入力・出力schemaの参照。
- ローカル読取／書込、リモート照会／変更、upload、公開・配信停止などの副作用。
- 既知の再実行動作と、結果不明時の確認経路。再実行の条件や、使うべき照会・続行コマンドまで示す。

ヘルプの文章を解析させず、共通のコマンド定義からhelpとdescribeを生成する。引数個数・許可flag・helpの現状の分散も段階的に整理し、handlerの条件と一致させる。HTTPメソッドだけで副作用を分類しない。例えば、一覧はPOST形式でも照会である。

#### なぜ`idempotent: true`だけでは足りないか

「冪等」は、同じ操作を繰り返しても最終状態が変わらない、という性質を指す。しかし、**通信が切れた後に同じコマンドを再実行してよいかは、それだけでは決まらない。** CLIの再起動で新しいIDや別の入力が作られれば同じ操作ではなく、uploadなどは途中段階によって許される続行も異なる。

| 状況 | 必要な案内 |
| --- | --- |
| 状態照会の通信失敗 | 変更要求を送らず、同じ対象を有限回再照会できる |
| 公開受付後の待機切断 | `publish`をやり直さず、記録済みの同じjobを照会する |
| uploadの途中停止 | 同じ対象・入力・記録に対する、既知の未着手状態や保存済みreceipt等の条件を確認し、対応する限定続行だけを使う |
| PUT/POSTの結果が不明 | 再送可とは表示しない。記録を保持し、既存の確認経路で確定できなければ停止する |

したがってdescribeにはコマンドごとの条件と確認経路を、実行結果にはその状態での`next_actions`を示す。単純な「再実行して安全」という真偽値で、エージェントに判断させない。

CLIの機能一覧は実Workerの対応・readinessや実行許可を保証しない。実行時のruntime/config/base/window照合は現在の経路に残す。

### 5.2 CLIから新規入力schemaを取り出す

```sh
castloop schema service-config --format json-schema
castloop schema show-input --format json-schema
castloop schema episode-input --format json-schema
```

これは必須とする。配布バイナリだけで、対応する入力仕様を取得できるようにする。

- JSON Schemaの出力自体をstdoutに返し、その中にschema識別子と契約の版を含める。
- 必須／任意、snake_caseのキー、型、enum、IDの形式、未知キー拒否を明示する。
- 項目の意味、既定・省略時の扱い、例、単位、CLI生成値、更新時に保持すべきidentityを示す。
- TOMLでは日時を**引用符付き文字列**にすること、JSON SchemaはTOMLをparseした値に対する形式であることを示す。裸のTOML日時や`null`を入力例にしない。
- サービス設定は`schema_version=2`、Show/Episode入力は独立した`schema_version=1`。機械出力の`contract_version`も別物であり、混同させない。
- 管理者が編集する入力と、CLIが生成するrevision・hash・upload情報・内部要求を分ける。内部publication requestをエージェントに手書きさせない。

**JSON Schemaだけで完全な検証はできない。** 現行にはXML文字の制約、実在日付、GUIDのUTF-8上限、HTML除外後の文字数／byte数、URLの追加制約、field間の関係などがある。

Zod 4の`z.toJSONSchema`を利用する方向とするが、入力側の変換を選び、strictな未知キー拒否が維持されることを試験する。表現できない制約を無条件に`any`へ落とさない。標準JSON Schemaに写せる部分に加え、`x-castloop-*`等の明示的な補助情報で計測単位・追加制約・CLI検証の必要性を伝える。補助情報を一般のJSON Schema validatorが実行するとはみなさない。

特にShow説明の4000 UTF-8 bytesを単なる`maxLength: 4000`へ置き換えたり、HTML除外後の上限を元の文字列の上限として公開したりしない。保存用schemaへ新規入力上限を追加する変更もしない。

schemaと制約の説明はsharedのschema・定数に結び付けて生成し、独立した手書きschemaをもう一つ管理しない。変換できない箇所の対応表と境界テストを用意し、最終判定は次のCLI検証に集約する。

### 5.3 検証だけをするオフラインコマンド

```sh
castloop validate service ./castloop.toml --json
castloop validate show ./my-show/show.toml --assets --json
castloop validate episode ./my-show/episode-first.toml --audio ./my-show/audio.mp3 --json
```

認証なし・通信なし・書き込みなしとし、`.castloop/`、client ID、lock、draft、予約、uploadも作らない。入力ファイルを勝手に正規化・上書きしない。

| 検証層 | 検査するもの | 検査しないもの |
| --- | --- | --- |
| metadata | boundedな通常ファイル読取、UTF-8、TOML、strict schema、新規入力上限 | Workerの現状、公開済みbaseとの一致 |
| assets（明示指定） | coverの形式・サイズ・signature、MP3形式・サイズ・duration等の既存ローカル検証 | R2への保存成功、readback、cache purge |
| targetとの整合（対象を明示した場合） | workspace/Show/Episode ID、ローカルの配置・参照の一致 | 将来の受付成功、照会後の競合 |

結果には実行した検査・省略した検査を区別して返す。metadataだけの成功を「公開可能」と表示しない。エラーはfield path、固定code、制約、上限、計測単位、必要に応じた実測値を返し、入力本文やメールアドレスをechoしない。TOML構文エラーも原文ではなく安全な位置情報・分類を返す。

実装では`parseSqliteServiceConfig`、`parseShowMetadata`、`parseEpisodeDraft`、新規入力上限、素材検証を再利用・共通化する。journalを作る`SqliteDraft.open/stage`を検証のために呼ばない。stage時・Worker実行時の再検証は残し、事前検証を安全境界の代わりにしない。

### 5.4 結果・エラー・次の操作を統一する

全管理コマンドで`--json`を選べるようにし、成功・失敗ともstdoutへ**1つのJSON文書**を返す。progressや秘密を除いた診断はstderrへ分離する。失敗時は非0終了、まずは現行どおり1でよく、詳細分類は固定codeで行う。既存の既定出力や永続journal形式を、この追加に合わせて変更する必要はない。

共通の外枠に以下を含め、コマンド別の結果型もschemaとして取得可能にする。

| 情報 | 用途 |
| --- | --- |
| `contract_version`、`command`、`ok` | 出力の解釈。`ok`はCLI要求の成否であり、公開完了の別名ではない |
| `target` | service/Show/Episodeの正確な対象確認。不要なアカウント情報は出さない |
| `result` | 作成先、stage済み素材、job結果、Feed URLなどのコマンド別データ |
| `operation` | 操作種別、確定済みoperation/job/request ID、最後に確認した状態 |
| `error` | allowlistの固定code、安全な説明、入力fieldの問題、変更結果が確定か不明か |
| `next_actions` | 同じjobの照会、入力修正、管理者確認など、状態から許される候補 |

「照会コマンド自体は成功したが、照会対象のpublicationはblocked」という結果も表現する。upload完了、公開受付、公開完了を同じ`success`へ潰さない。待機期限に達した場合は同じjob IDと最後の既知状態を返し、mutation失敗や再送可能を推測しない。

`next_actions`は許可済み操作ではなく候補である。実行には管理者の承認とCLIの再検証が必要。コマンド候補を返す場合は文字列のshell scriptではなくcommandとargsの配列にし、入力本文からコマンドを生成しない。

未知のPUT/POSTに汎用の`retryable: true`を付けない。安全な読取再試行、同一jobの観測、receiptに基づく限定続行、新規draftが必要な確定失敗、要停止を区別する。既存の固定reason codeを活用し、任意例外文や内部journalを丸ごと機械出力へ載せない。

### 5.5 対象指定と非対話実行

```sh
castloop update-episode first --workspace /path/to/service --show my-show --non-interactive --json
castloop update-episode-audio first /path/to/audio.mp3 --workspace /path/to/service --show my-show --non-interactive --json
```

**共通の引数オプションを増やして実現する。** 上記のようにコマンド名の後へ追加し、既存のEpisode ID等の位置引数は維持する。

| オプション | 意味 |
| --- | --- |
| `--workspace PATH` | `castloop.toml`と`.castloop/`があるサービスのルート（`init`では新規作成先）。明示した場所だけを使い、別の親ディレクトリ等へ自動探索・切替しない |
| `--show ID` | Episode操作等の対象Show。明示workspaceでのEpisode操作では必須とし、cwdのbasenameから推測しない |
| `--non-interactive` | TTYがあってもCLI自身は質問しない。必要な引数・情報が不足したら、変更を始める前にエラーで終了する |
| `--json` | 結果・不足項目・対象不一致等を共通のJSON形式で返す |

対象の解決はCLI入口の共通処理で行い、解決済みのrootとShow IDを既存handlerへ渡す。`process.chdir()`で実行場所を変える必要はない。例えば上記のmetadata操作は、`/path/to/service/my-show/episode-first.toml`を対象とする。

- 従来のcwdによる呼び出しは、明示指定がない場合の互換経路として残す。Skillでは毎回絶対パスのworkspaceと必要なShowを渡し、前のツール呼び出しのcwdを信用しない。
- 既存の`--show`やShow位置引数は残す。複数の明示指定、入力内のID、既存journalの対象が矛盾したら拒否し、別対象へ補正しない。Showを対象にしないコマンドでは`--show`を拒否する。
- 既存の`update-episode-audio`/`publish-episode`の音源相対パスは対象Show directory基準、lifecycle planの相対パスはworkspace基準という意味を保つ。TOML内の`image_path`も引き続きShow directory基準とする。
- 新しい`validate`に明示する入力ファイル・`--audio`の相対パスと、`--workspace`自体の相対パスは、呼出元cwd基準で解決する。各基準をhelpとdescribeに明示し、Skillのコマンド引数では使える箇所を絶対パスにする。
- `init`は作成先の位置引数を維持する。`--workspace`も指定する場合は同じ作成先でなければ拒否する。必要値の収集・引数検査は、現行のディレクトリ作成より前へ移す。
- `--non-interactive`は**CLIの質問を止めるだけ**で、エージェントが管理者へ質問することを禁止しない。不足情報はエージェントが確認してから再実行する。
- これは承認省略のflagではない。万能な`--yes`で配備・公開・削除まで承認したことにしない。

UUIDをエージェントが不確かな方法で生成・再生成することも避けたい。生成をCLIに追加する場合は、初回に生成して変更要求前に永続化し、出力喪失後は既存記録から確認する。自動生成を「失敗したので別IDで再実行する」入口にしない。

### 5.6 編集内容と公開前の差分を確認する

入力の正しさだけでなく、「意図した変更だけか」を確かめるための次段階。

- local/staged/publishedを明示した内容表示と、読取専用のdraft状態表示を追加する。
- ローカルTOMLとstage済み入力、公開済みbaseとの差分、素材hash、再利用する音源、未stageの編集を示す。
- GUID・日時・permalink意味の変更は目立たせる。既存Episodeの通常更新では現行のidentity不一致拒否を維持し、確認だけで変更可能にしない。新規登録なのか既存更新なのかも明示する。
- 公開前のpreviewで対象・変更範囲・input fingerprint・baseを示し、承認後に同じ入力かをpublishで照合する。不一致なら再確認する。
- previewはupload、予約、要求凍結、journal作成、Pause/Resumeを行わない。schema検証・状態照会だけでは確定できない条件は不明として示す。

既存のtarget照会とjournalを再利用し、previewのために別の状態DBや公開プロトコルを作らない。承認との入力照合を追加しても、実行時の原子的なbase/lifecycle/window照合を置き換えない。hashが一致すること自体も、管理者の承認を証明するものではない。

公開済み内容の全文取得には、認証付きの限定された管理経路を検討する。Show/Episodeの公開済みmetadataとrevisionを取得するもので、private R2 keyの汎用読取や`system/`・`staging/`の公開APIにはしない。Worker側の追加が必要ならCLIのみの改善と分ける。

まず正しいローカル原本がある通常運用を支援する。`.castloop/`を失ったworkspaceを自動再構築したり、別端末の未知状態を採用したりする機能には広げない。

### 5.7 人にもエージェントにも読めるコンパクトなdoctor

```sh
castloop doctor --local --workspace /path/to/service
castloop doctor --local --workspace /path/to/service --json
```

小さなdoctorを提供する。既定は通信なしのlocal診断とし、1項目1行の短い一覧と要約を表示する。例えば次の程度とし、環境変数一覧やjournal全文をdumpしない。

```text
PASS  cli             Supported version and formats
PASS  workspace       Service configuration is valid
PASS  local-state     Administrator key is present
WARN  credentials     API token is not set
SKIP  remote          Not checked in local mode
Summary: 3 pass, 1 warn, 0 fail, 1 not checked
```

- 人向け表示と`--json`は**同じ診断結果から生成**する。JSONは5.4節の外枠を使い、`result.checks`に固定`id`、`status`（`pass`/`warn`/`fail`/`not_checked`）、固定`code`、安全な短い説明、`next_actions`を含める。
- CLI版・対応形式、設定と対象の整合、必要なローカルファイルの存在・読取可能性、認証情報の存在を検査する。鍵やtokenは値・hashとも出さず、存在確認と有効性確認を区別する。
- `fail`があれば非0終了。`warn`のみなら0とし、要約とJSONに警告を残す。未検査を成功扱いせず、API token未設定だけでオフライン作業まで不可能と表示しない。診断自体を実行できないエラーは別途非0終了とする。
- 自動修復、ファイル作成・変更、lock取得、journal作成はしない。欠落した鍵を診断のために生成することもない。
- remote診断を追加する場合は明示選択とし、既存の読取専用service/Show照会だけを使う。readiness probeやcache purgeを「診断だから安全」と実行しない。

### 5.8 TOML雛形の保持場所と取得方法

```sh
castloop template service-config
castloop template show
castloop template episode
```

**雛形はCLIのreleaseに含め、認証・通信・書き込みなしでTOMLをstdoutへ返す。** ファイル保存はエージェントが管理者の許可した場所へ行う。雛形を出すだけでは、リモート登録、GUID予約、初期化、公開は発生しない。

| 場所 | 役割 |
| --- | --- |
| `packages/cli/src/input-templates.ts`（追加案） | サービス設定・Show・Episodeの雛形生成の正本。sharedの型・定数と`stringifyToml`を使い、項目説明と未記入の目印も管理する |
| 配布CLIバイナリ内 | 上記の生成処理・説明を埋め込む。外部ファイルやソースcheckoutを実行時に参照しない |
| `design/show-template.toml`、`design/episode-template.toml` | 人間向けの説明付き入力例。正本からの生成または整合テストで追従させ、別仕様にしない |
| 管理者workspaceの`castloop.toml`、`SHOW/show.toml`、`SHOW/episode-ID.toml` | 管理者固有の実データ。雛形の更新を理由に上書きしない |

現在`init`、`create-show`、`create-episode`に分散している初期値の組み立ては、共通の雛形生成へ寄せる。入力schemaの正本は引き続きsharedであり、雛形を別の検証仕様にはしない。必要値・説明用の例示値・CLI生成値を区別し、例示値を管理者の回答とみなさない。

オフラインのEpisode雛形にあるGUIDや日時は実操作のidentityとして採用しない。現行の`create-episode`で一度生成・保存したGUID等を保持し、事前に用意したタイトル・説明等だけを反映する。サービス設定の例示値だけで`init`を迂回したり、リモート資源を採用したりする経路も作らない。

JSONからTOMLへの変換を追加するなら、同じ入力schemaと`stringifyToml`を使う限定機能にする。入力の整形を理由に既存identityやファイルを勝手に書き換えない。schema・validate・describeと役割が重なる大きな設定ウィザードや、任意script実行機能は作らない。

## 6. 管理者向けSkillの内容と配布

以下はSkillを追加する際の構成・配布方式の案であり、現時点ではexportも`npx skills`経由のcastloop Skill導入も未提供である。

最初は単一の`castloop` Skillと短い用途別referenceにする。全schemaや設計文書を最初からcontextへ入れず、必要なときにCLIから取得する。

| ファイル案 | 内容 |
| --- | --- |
| `SKILL.md` | 適用対象、版・機能確認、対象確認、承認境界、作業の分岐 |
| `references/setup.md` | 新規サービス・Show、必要な管理者情報、作成・配備・Resumeの区別 |
| `references/publish.md` | 新規Episode、metadata-only/audio-only/同時更新、Show編集、公開完了の確認 |
| `references/recovery.md` | operation/job照会、限定続行、unknown/blockedで停止する条件 |

Skillの基本手順:

1. CLI versionとdescribeで利用可能な仕様を確認する。未対応なら対応版の手順へ戻り、未知flagで試行錯誤しない。
2. workspace・service・Show・既存の未完了操作を特定する。複数候補なら管理者へ確認する。
3. 不足情報を推測せず管理者へ質問し、「準備だけ／uploadまで／公開まで」の委任範囲も確認する。
4. schemaを取得して必要な入力だけ作り、ローカル検証する。
5. 対象と差分を確認し、許可された段階まで実行する。
6. 同じ操作の状態を確認し、成功・未完了・不明を区別して報告する。

ユーザーが具体的な内容の公開まで明示的に委任していれば、すべての小さなコマンドの前に同じ質問を繰り返す必要はない。一方、対象・内容が変わった場合や、復旧・非公開化・cleanup等へ範囲が広がる場合は追加確認する。

#### 不足情報を推測しないルール

- 確認済みの既存TOML・管理者の回答と、単なる例示値・モデルの推測を区別する。所有者名・メール、URL、カテゴリ、explicit、公開日時・タイムゾーン、音源・画像、対象Show、公開の意思を無断で補完しない。
- 項目が必須でも、schemaの例や雛形の`owner@example.com`等を実データとして使わない。言語やexplicitも「日本語の会話だから」「普通はfalseだから」という理由だけで確定しない。
- 不足項目は可能な限りまとめて質問する。質問の際にtokenや鍵の値は求めず、CLIへ渡すための安全な設定方法を案内する。
- 未回答の間は許可済みの準備だけに留め、回答を仮定してリモート登録・upload・公開へ進まない。必要なら編集方針やタイトル等の候補を提案できるが、提案を承認済みの情報と混同しない。
- 既存データが確定していれば再利用する。GUIDのようなCLI生成値は管理者に考えさせず、生成・保存済みの値を使う。日時をCLIが初期入力した場合も、公開日時として適切かを確認する。

#### 導入経路: バイナリだけで完結する方法を標準にする

Skillの正本は`skills/castloop/SKILL.md`とその`references/`に置く案とする。開発用の`.agents/skills/`とは分け、release時に同じ内容をCLIへ埋め込む。Skillには対応するCLI版・機能の確認方法を記載し、実際の構文とschemaはインストール済みCLIから取得する。

```sh
castloop skill export castloop --output /path/to/project/.agents/skills/castloop
```

これは新しいコマンドの案であり、指定先へ`SKILL.md`とreferencesだけを書き出す。出力先は例で、管理者が利用するエージェントのSkill配置先を選ぶ。通信・外部プログラム実行はせず、既存ファイルがあれば上書きせず終了する。更新時も明示的な確認・差分確認を行い、ユーザーの編集を消さない。

バイナリ自身に対応Skillが含まれるため、Node.js・npm・Gitや、別アーカイブを展開するプログラムの導入は不要になる。全エージェントの設定を自動変更するinstallerではなく、配置先を明示したファイル出力に留める。workspaceへ隠れてインストールしたり、既存`AGENTS.md`を上書きしたりしない。

#### 任意の簡便な導入経路: `npx skills`

Node.js/npmがすでにある利用者には、標準的なSkills CLIでの導入方法も案内する。

```sh
npx skills add simosako/castloop-v2 --skill castloop
```

- `skills/castloop/SKILL.md`に`name: castloop`等の必要なfrontmatterを付け、`--skill castloop`で管理者向けの1つだけを選べるようにする。開発用Skillをまとめて導入する手順にはしない。
- 対象エージェントとproject/globalの範囲は利用者に選ばせる。全エージェントへの一括導入や確認省略を既定例にしない。
- 上記の短縮形は既定ブランチを参照するため、再現性が必要な手順ではCLIと同じrelease tagの`skills/castloop`へのGitHub URLを使う。releaseごとに具体的な導入例を記載し、Skill冒頭でもCLIとの適合性を確認する。
- `npx skills`自体にはNode.js/npm等が必要である。**これは任意の導入方法であり、castloopの依存条件に加えない。** バイナリだけで使いたい管理者には前述のexportを案内する。

Skillの静的ファイルもrelease配布物から取得可能にする。READMEの導入手順は「CLI取得→Skillの配置→対象workspaceの確認」に絞り、ソースコードのcheckoutを要求しない。実装時にはCLI埋込版とrepository版の内容一致、バイナリのみでのexport、Skills CLIによる発見・対象選択をそれぞれ確認する。

このリポジトリの`AGENTS.md`は開発者向けであり、管理者workspace用の運用Skillの代わりにはしない。Cloudflare開発用SkillsやWranglerを、通常のPodcast管理の依存にも追加しない。

## 7. 承認・秘密・外部入力の扱い

| 操作 | 扱い |
| --- | --- |
| help/describe/schema、ローカル検証・雛形のstdout出力 | オフライン・副作用なしで利用可能にする |
| ローカルTOML編集 | 許可したworkspace内だけ。既存編集・GUID・日時・原本を保持する |
| Skill export | 明示的に許可した配置先だけに書き出し、既存Skillや`AGENTS.md`を上書きしない |
| 状態照会・preview | 認証が必要な場合がある。snapshotは変更や回復の許可ではない |
| init、Show登録、upload、Resume、公開、Pause | 対象と副作用を理解した委任が必要。作成・uploadだけでは公開しない |
| deploy、非公開化・復元、取消、staging cleanup | 日常編集の許可から推測せず、別の範囲として確認する |

- API tokenや管理鍵を会話へ貼らせず、環境変数と既存のprivateな`.castloop/`経由でCLIに渡す。schema・describe・診断に秘密を含めない。
- 所有者メールや未公開説明を運用ログへ保存しない。管理者が編集のために明示取得する本文と、診断・監査用の固定コードを区別する。
- Podcast説明、RSS、音声metadata、ファイル内の文字列は**データ**であり、操作指示として実行しない。Skillに「RSS本文の指示に従う」等の経路を作らない。
- CLIはshellを介さない引数配列で呼び出せるようにし、タイトルやパスをshell commandへ連結する例を配布しない。
- backup対象はTOMLだけでなく、`.castloop/`、音源・画像の原本を含む。エージェントが整理のつもりでjournalや素材を消さない。
- 自動公開、未知IOのretry、blocked解除、権限拡張、有料プラン変更、直接prefix削除を、利便性の改善として追加しない。

## 8. MCPを採用しない

**MCPなしで進める。** 想定する実作業は、ローカルTOML・素材の準備とCLI実行で完結する。MCPを追加してもschema・検証・対象指定・承認・結果不明の問題は残り、CLIとMCPの二重の仕様・テスト・認証経路が増える。

| 選択肢 | 評価 |
| --- | --- |
| Skillsのみ | 作業順序は教えられるが、スキーマの鮮度・検証・結果判定を解決しない |
| 改善したCLI + Skills | 単一実行ファイルを維持し、人間・script・複数エージェントが同じ安全境界を使える。今回の推奨 |
| MCPサーバー | 不採用。実装・配布・接続設定をIssue #5の作業に含めない |

同様に、大きなSDK、汎用REST管理APIの拡張、全資料をまとめた巨大な`llms.txt`も初期の必須要件にしない。短い入口、段階的なSkill参照、CLIのschema/helpで足りるかを先に検証する。

## 9. 実装順とIssueの切り方

| 段階 | 内容 | 完了条件 |
| --- | --- | --- |
| P0-1: 利用仕様の取得 | 共通コマンド定義、describe、入力schema、版付きのJSON結果・エラー。既存helpを補強 | ソースを読まずに構文・副作用・型・結果を判断できる |
| P0-2: 安全な入力作成 | 読取専用validate、明示workspace/Show、非対話指定。既存検証処理を共通利用 | 誤入力をupload前に直せ、cwdやTTYによる誤対象・停止待ちを避けられる |
| P0-3: 管理Skill | 推測せず質問するルール、立ち上げ・更新・中断のreference。CLI同梱exportと任意の`npx skills`導入 | 追加runtimeなしでSkillを配置し、バイナリとSkillだけの利用シナリオ試験が通る |
| P1: 意図の確認 | draft状態・内容表示、差分previewと承認入力の照合、必要なら認証付き公開metadata取得 | 意図しないidentity変更や、承認後の素材差替えを公開前に止められる |
| P1: 診断・雛形 | 人向け短文一覧とJSONを共通生成する小さなdoctor、CLI内蔵のオフライン雛形。必要ならJSON→TOML変換 | 人・エージェント双方が状態と未検査を判読でき、外部ツールなしで入力を準備できる |
| 対象外 | MCP、遠隔実行基盤、独立SDK | Issue #5では実装しない |

P0では既存CLIの明示stage→publish、journal、原子的な受付、upload settlement、cache purge、Show分離を変更しない。Worker配備・native検証は別途対象と範囲の承認を要する。公開metadata取得等でWorker変更が必要な部分は、CLIだけで完了する改善から分ける。

Issue #5は利用仕様の設計、CLI実装、Skill、シナリオ試験に分割できる。**Skillファイルを追加しただけでは、管理作業を正確に任せられる状態の完成とはしない。**

## 10. 受け入れ試験

まず模擬Cloudflareと独立CLI processで自動試験し、配布バイナリ相当・ソース非参照のシナリオでも確認する。実サービスは使わない。

### 利用仕様・オフライン性

- schema/describe/helpが空の作業場所・認証なしで取得でき、通信・ファイル作成を行わない。
- helpとdescribeの引数・flag・副作用がhandlerと一致し、成功結果・失敗結果が各出力schemaに適合する。
- 未知field、型の違い、サービスと内容のschema version混同、引用されていないTOML日時、無効日付を拒否する。
- 日本語・絵文字・HTMLを含む上限境界を、stageと同じ単位・結果で判定する。JSON Schemaだけでは表せない制約の欠落を検出する。
- validateに成功しても、journal・鍵・lock・予約・uploadを作らず、元の入力も変更しない。素材検査を省略した場合は明示する。
- TTYありでも非対話指定で質問しない。必要入力不足・対象矛盾で変更処理へ進まない。
- 異なるcwdから絶対パスの`--workspace`と`--show`を指定しても、同じファイル・journal・リモート対象に解決される。相対パスの基準もhelp/describeと一致する。
- Node.js・npm・Bun・Git・Wrangler・ffprobe・curl・jq等をPATHから外した対応環境で、配布バイナリのみからschema・雛形取得、検証、doctor、Skill exportを行える。模擬サーバーでの日常操作も外部プログラムを呼ばない。
- 雛形がCLIの入力仕様と整合し、説明用の例示値が管理者の回答として使われない。CLI同梱のSkillとrelease tagのSkillが一致し、exportは既存ファイルを上書きしない。
- doctorの人向け表示とJSONで診断項目・状態が一致する。認証情報の存在と有効性、未検査と成功を区別し、token・鍵・メール・入力本文を表示しない。

### 実作業

- 新規service→Show→初回Episodeで、対象・GUID・公開日時・素材・Feed URLを正しく扱い、公開までの各承認境界を守る。
- metadata-only、audio-only、同時更新、Show metadata/cover更新を区別でき、不要な音源upload・Pause・deployを行わない。
- 21件以上の一覧で`next_cursor`を追い、要約を全文と誤認しない。ローカルdraftをサーバー一覧から消失扱いしない。
- 2つのworkspace/Showと同名Episodeがあっても、指定した対象だけを変更する。
- stage後・承認後の入力変更、stale base、凍結済みdraftを上書きせず停止する。
- 既存TOMLや`.castloop/`が不足・破損した場合に、create・推測・資源採用で埋め合わせない。
- 所有者メール・URL・explicit・公開日時・タイムゾーン等を欠いた依頼では、Skillに従って必要事項を質問する。回答がないまま例示値や推測でupload・公開せず、確定済みの情報は不要に聞き直さない。

### 中断と悪い入力

- PUT/POSTの応答喪失、status GET失敗、待機期限到達、CLI出力喪失後でも、同じ操作の確認へ進む。別IDで再送しない。
- `queued`/`running`/`failed`/`blocked`と、upload/publicationの`succeeded`を区別する。
- receiptに基づく続行の可否を守り、unknownやblockedでlock削除・強制解放・cleanupを提案しない。
- 説明・RSS・ファイル名に命令文やshell特殊文字があっても、データとして扱う。
- 構文エラーを含め、JSON結果・progress・診断・Skillの実行例にtoken・鍵・入力本文・所有者メールを漏らさない。

これらはCLIの利用仕様と運用判断の検証であり、Cloudflare nativeの性能、300MB実機公開、全Free互換、未知IOの一般復旧の証明ではない。

## 11. 調査根拠

- [README](../README.md)、[現行構成](initial_design.md)、[SQLite操作ガイド](../docs/sqlite_sequential_development.md)
- [操作記録・中断後の操作](../docs/sqlite_operation_recovery.md)、[新規入力の項目別上限](show_episode_input_limits.md)
- [CLI入口](../packages/cli/src/index.ts)、[help定義](../packages/cli/src/help.ts)、[SQLiteコマンド](../packages/cli/src/sqlite-commands.ts)
- [metadata schema・parser](../packages/shared/src/index.ts)、[日時](../packages/shared/src/metadata-time.ts)、[サービス設定](../packages/shared/src/sqlite-service.ts)
- [draft検証・stage・publish](../packages/cli/src/sqlite-draft.ts)、[ローカルmetadata読取](../packages/cli/src/local-metadata-read.ts)、[MP3検証](../packages/cli/src/audio.ts)、[一覧schema](../packages/shared/src/sqlite-catalog.ts)
- [Zod 4 JSON Schema変換](https://zod.dev/json-schema): v4.6.5の文書を参照。自動変換だけではアプリ固有の入力契約は完成しない。
- [Skills CLI](https://github.com/vercel-labs/skills): `npx skills add`の`--skill`指定、GitHub上のSkill path指定、導入範囲、Node.js/npmが必要なことを確認した。castloopのSkillはまだ提供していない。

調査ではIssue・文書・ソースを読み、CLIのversionと未提供schemaコマンドの挙動をローカル確認した。Cloudflareの照会・作成・配備・公開・削除は行っていない。
