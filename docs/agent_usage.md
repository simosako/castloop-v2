# エージェントによるPodcast管理

AIエージェントにcastloopの操作を依頼する場合は、管理手順をまとめたSkillを導入します。その後、対象の番組と依頼内容を伝え、プレビューを確認してから公開を指示します。

## 1. Skillを導入する

利用しているエージェントのSkill保存先に、castloopのSkillを書き出します。次はプロジェクトの `.agents/skills/` に置く例です。

```sh
castloop skill export castloop --output /path/to/project/.agents/skills/castloop
```

出力先には新しいフォルダ名を指定してください。保存先の決まりやSkillの読み込み方法は、利用しているエージェントの案内に従います。

CLIを更新したら、新しいSkillを別のフォルダに書き出し、内容を確認して入れ替えてください。

## 2. 対象と依頼内容を伝える

エージェントには、次の情報を渡します。

- ワークスペースの場所
- 対象の番組ID・エピソードID
- 作成・変更したい内容と、使う音声や画像
- 今回実行してよい範囲

例えば、公開前の準備を依頼する場合は、次のように伝えます。

> castloopのSkillを使ってください。ワークスペースは `/path/to/workspace`、番組は `my-show` です。エピソード `first` の説明を添付の文章に更新し、公開前のプレビューを見せてください。公開するタイミングは、確認後に指示します。

認証情報は[環境変数](getting_started.md#1-cloudflareの認証情報を設定する)で用意し、APIトークンや管理キーは秘密情報として扱います。

## 3. プレビューを確認し、公開を指示する

対象、変更内容、音声・カバーを確認します。修正があれば、編集後のプレビューをもう一度確認してください。

公開を依頼するときは、確認した内容と対象を明示します。エージェントは、そのプレビューのハッシュを使って[公開](publishing.md)します。予約する場合は[予約公開](scheduling.md)の手順で日時も確認します。

公開後は、実行結果と番組サイトを確認してください。

サーバー更新や独自ドメイン変更も依頼する場合は、それぞれの操作と対象を具体的に伝えます。

## エージェント向けのコマンド

構文や入力項目は、利用中のCLIから取得できます。

| 調べたいこと | コマンド例 |
| --- | --- |
| コマンドの引数・動作 | `castloop describe publish-episode --json` |
| 番組の入力項目 | `castloop schema show-input` |
| エピソードの入力項目 | `castloop schema episode-input` |
| 入力の書き方 | `castloop template show` |
| 番組情報と素材の検査 | `castloop validate show /path/to/workspace/my-show/show.toml --assets --json` |
| エピソード情報と音声の検査 | `castloop validate episode /path/to/workspace/my-show/episode-first.toml --audio /path/to/audio.mp3 --json` |

番組やエピソードを新規作成するときは、`create-show`・`create-episode` で作った編集ファイルを使います。

`--json` を付けると結果をJSONで取得できます。公開は `changed` または `unchanged` と `revision_id`、予約は `schedule-status` の結果で確認します。

中断時は、[操作別の確認方法](troubleshooting.md#操作が中断した場合)に沿って状態を調べ、続行する操作を選んでください。
