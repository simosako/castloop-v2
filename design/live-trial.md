# 非公開実機試験の手順書

本書は、承認済みの非公開実機試験を次回から手順書だけで再現できるようにする具体的手順です。要件と原則は[セキュリティ設計](security.md)の「非公開の実機試験」が担い、本書が再現可能な手順、[過去の実施記録](archive/README.md)が各回の結果証跡を担います。対象は現行のSQLite構成(`schema_version=2`、`storage_layout="show-v1"`、`sqlite-sequential-v1`)で、v0.8.5時点のコマンド形式です。

## 前提

- 対象アカウント、リソース名、確認者、操作範囲の明示承認を先に得ます([security.md](security.md#非公開の実機試験))。本書は承認の代替にはなりません。
- 実施マシンには `bash`、`curl`、`jq`、`uuidgen`、Python 3.11以上(検証スクリプト用)が必要です。Cloudflare操作は `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` を使う直接REST呼び出しです。
- 保護を確認できなければアップロード・公開の前に停止します(手順Step 4〜5)。

## 変数と秘密の取り扱い

絶対パス、確認者メール、APIトークンをGit管理ファイル、公開リポジトリ、会話の記録に書きません。手順はすべて変数を参照し、値は次のとおり供給します。

| 変数 | 値 |
| --- | --- |
| `CASTLOOP_TRIAL_ASSETS` | 素材と証跡のルート(メインチェックアウトの `.local-test-data` の絶対パス)。メインチェックアウトで実施する場合はStep 0の既定値で設定され、worktreeから実施する場合のみ事前に設定する |
| `CASTLOOP_TRIAL_REVIEWER_EMAIL` | 確認者のメールアドレス。前回証跡から抽出して継承する |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | 既存のCloudflare管理用環境変数 |

前回証跡からの継承は、次のコマンドで行えます(`PREV` は直近の証跡ディレクトリ)。

```bash
PREV=.local-test-data/results/<前回日付>/<前回service-id>
export CASTLOOP_TRIAL_REVIEWER_EMAIL="$(jq -r '.body.include[0].email.email' "$PREV/access-policy-create-request.json")"
```

## 素材と選定規約

- 音声は `${CASTLOOP_TRIAL_ASSETS}/normal/` に保存されているMP3のうち**サイズ降順3件**、画像は同ディレクトリの `cover.jpg` を使います。
- 原本は読み取り専用です。試験の前後でSHA-256を記録し、不変であることを確認します(Step 0とStep 11)。
- Episode のTOMLは `episode_id` がMP3ファイル名と対応しているため素材とセットで不変であり、前回証跡の `workspace/<show>/episode-*.toml` をそのまま使います。`show.toml` は `show_id` を今回のShow IDに書き換えて使います。

## 命名規約

| 対象 | 規約 | 例 |
| --- | --- | --- |
| 証跡ディレクトリ | `.local-test-data/results/<YYYYMMDD>/<service-id>/` | `results/20261101/rev-ebaf516-d09bb9/` |
| service ID | `rev-<リビジョン短縮sha7>-<乱数hex4>`。**20文字以内**(入力検証の上限) | `rev-ebaf516-d09bb9` |
| R2バケット | `castloop-<service-id>`(initが作成) | `castloop-rev-ebaf516-d09bb9` |
| Worker名 | initが自動生成 | `castloop-rev-ebaf516-d09bb9-c5ee344c` |
| Show ID | `rev<リビジョン短縮shaの末尾3桁>-normal` | `rev516-normal` |
| 証跡ファイル | 各コマンドごとに `<step>-request.json`(実行引数)、`<step>-stdout.json`、`<step>-stderr.txt`、`<step>-exit.txt` | `show-publish-stdout.json` |

## 手順

以下で `EVID` は証跡ディレクトリ、`CLI` は証跡ディレクトリに保存した実行バイナリ、`API` は `https://api.cloudflare.com/client/v4` を指します。

### Step 0: 承認と準備

承認を得てから、変数と証跡ディレクトリを用意します。

```bash
export CASTLOOP_TRIAL_ASSETS="${CASTLOOP_TRIAL_ASSETS:-$(pwd)/.local-test-data}"
SID="rev-$(git rev-parse --short=7 HEAD)-$(openssl rand -hex 2)"
EVID=".local-test-data/results/$(date +%Y%m%d)/$SID"
mkdir -p "$EVID/workspace"
sha256sum "$CASTLOOP_TRIAL_ASSETS/normal/cover.jpg" "$CASTLOOP_TRIAL_ASSETS"/normal/*.mp3 > "$EVID/original-sha256-before.txt"
# 前回証跡から確認者メールを継承(「変数と秘密の取り扱い」参照)
```

### Step 1: ビルドとバイナリの保存

実施するリビジョンでCLIをビルドし、証跡ディレクトリへ保存します。残っていた旧ビルドの `dist/` はSkill埋め込みなどが旧版のままなので必ず再ビルドします。

```bash
npm run build:cli                 # ホスト向け。dist/castloop が生成される
cp dist/castloop "$EVID/castloop"
```

### Step 2: サービスの初期化

`init` がWorker、Durable Object、専用の非公開R2バケットを作成します。`account-id` と `workers-subdomain` は前回証跡と同じ値を使います(`workers-subdomain` は `castloop.toml` に設定項目として現れないため、前回の `workers_dev_base_url` のホスト部の2番目のラベルから読み取ります)。operation-idは `--operation-id` フラグで渡します。initの位置引数は対象ワークスペースディレクトリとして解釈され、`--workspace` と不一致なら `target_mismatch` で拒否されるため、UUIDを位置引数にしないでください。

```bash
CLI="$EVID/castloop"; WS="$EVID/workspace"
"$CLI" init --service-id "$SID" --account-id "$CLOUDFLARE_ACCOUNT_ID" \
  --bucket-name "castloop-$SID" --workers-subdomain "<アカウントのsubdomain>" \
  --operation-id "$(uuidgen | tr 'A-Z' 'a-z')" \
  --non-interactive --json --workspace "$WS" \
  > "$EVID/init-stdout.json" 2> "$EVID/init-stderr.txt"; echo $? > "$EVID/init-exit.txt"
```

### Step 3: Cloudflare Accessの設定

対象ホストの `/podcasts` 以下全体を保護するAccessアプリと、確認者限定のポリシーを作成します。構造は前回承認済み設定の継承です(`session_duration`、IdP、`require` の組み合わせ)。値は変数と前回証跡から供給し、手順書やGit管理ファイルに値を直接書きません。

```bash
HOST=$(python3 -c "import tomllib;print(tomllib.load(open('$WS/castloop.toml','rb'))['workers_dev_base_url'])" | sed -E 's#^https?://##;s#/$##')
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/access/identity_providers" > "$EVID/access-idp-current.json"
IDP=$(jq -r '.result[0].id' "$EVID/access-idp-current.json")
jq -n --arg domain "$HOST/podcasts" --arg idp "$IDP" --arg name "Castloop $(git rev-parse --short HEAD) Private Trial" \
  '{type:"self_hosted",name:$name,domain:$domain,session_duration:"24h",allowed_idps:[$idp],auto_redirect_to_identity:true,app_launcher_visible:false}' \
  > "$EVID/access-app-create-request.json"
curl -sS -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data-binary "@$EVID/access-app-create-request.json" "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps" > "$EVID/access-app-create.json"
APP=$(jq -r '.result.id' "$EVID/access-app-create.json")
jq -n --arg email "$CASTLOOP_TRIAL_REVIEWER_EMAIL" --arg account "$CLOUDFLARE_ACCOUNT_ID" --arg idp "$IDP" \
  '{name:"Private trial approved reviewer only",decision:"allow",precedence:1,
    include:[{email:{email:$email}}],
    require:[{cloudflare_account_member:{account_id:$account}},{login_method:{id:$idp}}]}' \
  > "$EVID/access-policy-create-request.json"
curl -sS -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data-binary "@$EVID/access-policy-create-request.json" \
  "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/access/apps/$APP/policies" > "$EVID/access-policy-create.json"
```

ポリシーは1つのAllowポリシー内でInclude(メールの完全一致)とRequire(アカウントメンバー、ログイン方法)を組み合わせ、迂回を許す別ポリシーやBypassを作りません(security.md)。

### Step 4〜5: 保護確認(アップロード前)

検証スクリプトの `pre-upload` モードで、Workerのworkers.dev設定(有効・プレビューURL無効)と、公開予定ルート全体への匿名リダイレクト(302 to Access)を確認します。

```bash
python3 scripts/live-trial-verify.py pre-upload "$EVID" "<show-id>"
```

`<show-id>` は公開を予定するShow IDです(この時点では未作成でよく、Accessが `/podcasts` 接頭辞全体を保護するため妥当です)。`anonymous-before-upload.json` の全パスが302になっていなければ、**アップロード前に停止**します。

### Step 6: Showの作成と素材配置

```bash
SHOW="rev<リビジョン短縮shaの末尾3桁>-normal"
ORIGIN=$(python3 -c "import tomllib;print(tomllib.load(open('$WS/castloop.toml','rb'))['workers_dev_base_url'])")
"$CLI" create-show "$SHOW" --site-url "$ORIGIN/podcasts/$SHOW/" --non-interactive --json --workspace "$WS" \
  > "$EVID/create-show-stdout.json" 2> "$EVID/create-show-stderr.txt"; echo $? > "$EVID/create-show-exit.txt"
```

`--site-url` は非対話実行では必須です。値は生成される雛形の初期値にのみ使われ、次の段落で `show.toml` を転記して置き換えるため、公開内容には影響しません(`ORIGIN` は `castloop.toml` の `workers_dev_base_url`)。

`create-show` が生成した雛形を、前回証跡の `show.toml`(`show_id` を今回の値へ変更)、`episode-*.toml`、そして素材の `cover.jpg` と選定した3件のMP3で置き換えます。MP3のファイル名が `episode_id` と一致するように配置します。

### Step 7: Showの公開

```bash
"$CLI" publish-show "$SHOW" --non-interactive --json --workspace "$WS" \
  > "$EVID/show-publish-stdout.json" 2> "$EVID/show-publish-stderr.txt"; echo $? > "$EVID/show-publish-exit.txt"
```

### Step 8: Episodeの確認と公開

各Episodeについて、previewで得た `input_fingerprint` を `--expect-preview` に指定して公開します。audioパスはShowディレクトリからの相対パスです。

```bash
N=0
for EP in <episode-id-1> <episode-id-2> <episode-id-3>; do
  N=$((N+1))
  "$CLI" preview-episode "$EP" "$EP.mp3" --show "$SHOW" --non-interactive --json --workspace "$WS" \
    > "$EVID/episode-$N-preview.json" 2> "$EVID/episode-$N-preview-stderr.txt"
  FP=$(jq -r '.result.input_fingerprint' "$EVID/episode-$N-preview.json")
  "$CLI" publish-episode "$EP" "$EP.mp3" --show "$SHOW" --expect-preview "$FP" \
    --non-interactive --json --workspace "$WS" \
    > "$EVID/episode-$N-publish.json" 2> "$EVID/episode-$N-publish-stderr.txt"; echo $? > "$EVID/episode-$N-publish-exit.txt"
done
```

### Step 9: 状態確認

```bash
"$CLI" list-episodes "$SHOW" --non-interactive --json --workspace "$WS" > "$EVID/list-episodes.json"
"$CLI" show-status "$SHOW" --non-interactive --json --workspace "$WS" > "$EVID/final-show-status.json"
"$CLI" service-status --non-interactive --json --workspace "$WS" > "$EVID/final-service-status.json"
```

### Step 10: 公開後の検証

検証スクリプトの `post-publication` モードで、R2の全オブジェクトと原本の全量照合(SHA-256キー・バイト一致)、全公開ルートでの匿名拒否(GET・HEAD・条件付き・Range)、管理認証と隠しパスの拒否を確認します。

```bash
python3 scripts/live-trial-verify.py post-publication "$EVID"
```

### Step 11: 確認者による確認と再検証

- 確認者にサイトURLを連絡します(表示・再生・シークの確認依頼)。URLはGit管理ファイルや公開場所に書きません。
- 確認者がアクセスした後(キャッシュが温まった後)に、`post-publication` を再実行して匿名拒否が維持されていることを確認します。
- 原本の不変確認: `sha256sum` を `original-sha256-after.txt` として記録し、Step 0の記録と一致することを確認します。

### Step 12: 記録と後片付け

- 実施記録(結果と未確認事項)は `design/archive/` に別途作成し、[アーカイブ索引](archive/README.md)へ登録します。
- 試験環境(Worker、バケット、Accessアプリ)の削除には、作成とは別の明示承認が必要です(security.md)。

## 既知の落とし穴

| 落とし穴 | 内容 |
| --- | --- |
| service IDの長さ | 入力検証で20文字上限。`rev-ebaf516-d09bb9` 形式(19文字)に収める(過去に20文字超で拒否された実績) |
| initの位置引数 | 位置引数は対象ワークスペースディレクトリとして解釈される。operation-idを位置引数にすると `target_mismatch` で拒否される |
| 検証のUser-Agent | Pythonの既定UAはBrowser Integrity Checkで403になる。検証スクリプトは識別UA(`castloop-private-trial/1.0`)を使う |
| プレビューURLの設定箇所 | `previews_enabled` はスクリプト単位のsubdomain API(`/accounts/<a>/workers/scripts/<name>/subdomain`)でのみ確認できる。アカウントの `/workers/subdomain` 応答には含まれない |
| 匿名 `/podcasts` | Accessが `/podcasts` 接頭辞をカバーするため匿名では302(認証後404)。404だけを期待する検証は誤ってFAILする |
| audioパスの解決 | `preview-episode` のaudioパスはShowディレクトリ相対で解決される。ワークスペースからのパスではない |
| `--json` のエラー表現 | `--json` では入力検証エラーもenvelopeで一般化される。exitコードとstderrを併せて保存する |
| ビルドの新旧 | `dist/` に残った旧バイナリはSkill埋め込みが旧版のまま。実施リビジョンで必ず再ビルドする |

## 実装とスクリプト

- 検証スクリプト: [scripts/live-trial-verify.py](../scripts/live-trial-verify.py)(pre-upload / post-publication の2モード。要件はsecurity.md、期待する証跡ファイルは本書の手順どおり)
- 要件と原則: [セキュリティ設計](security.md#非公開の実機試験)
- 検証の位置づけ: [テスト設計](testing.md)
- 過去の実施記録: [アーカイブ索引](archive/README.md)
