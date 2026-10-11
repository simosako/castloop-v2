# M4 配布・利用文書の検証

## 2026-09-24: Bun単一実行ファイル

- `npm run build:cli`はローカルWranglerの`deploy --dry-run --minify`でWorkerをbundleし、ビルド時プラグインを使ってその成果物をCLIへ埋め込み、Bunの`--compile`相当で`dist/castloop`を生成する。`dist/`はGit管理外。実行ファイルにはBun runtime、CLI、metadata schema、Worker bundleが含まれる。管理操作とR2 uploadには独立したWrangler 4.x subprocess、Episode MP3解析には`ffprobe`が必要。
- 実行ファイルは`init`でWorker bundleを`.castloop/worker.mjs`へ展開し、`wrangler.jsonc`の`main`へ設定する。`deploy`はこのファイルを新しいbinaryの内容に更新し、既存のWrangler設定の他の項目を保持する。リポジトリの`src/`や`node_modules/`を実行時に参照しない。ソースCLIは従来どおりTypeScriptのWorkerを参照する。
- READMEにビルド・インストール・更新、workspace初期化、Show/Episode公開、復旧とトラブルシュートを記載。`examples/`にstrict schema対応のShow/Episode TOMLサンプルを追加した。

### 実機検証

`dist/castloop`を`/tmp/opencode/castloop-m4-tools/castloop`へコピーし、Wrangler 4.131.2を**別の**`/tmp/opencode/castloop-m4-tools/node_modules/`へインストールした。リポジトリ外の作業ディレクトリから`--version`と`--help`を確認。M1から保持中の専用サービスで既存`init`の再実行と、埋め込みWorkerの`deploy --dry-run`・本deploy・認証付きhealthを確認した。

さらに単一実行ファイルだけで新しいShow `binary-check-8db24778`のID予約、TOML/画像staging、明示的publishを実行し、job `80c80021-9684-4d57-81a7-b6e0df60332f`が`published`・受付`free`になることを確認した。公開feed XMLのtitleと画像SHA-256が入力と一致。続いて同ShowにEpisode `first`を作成・metadata/audioを個別にstaging・公開し、job `f317ddcf-d653-4f05-a51d-244b3e593173`も`published`・`free`になった。feed itemと公開immutable MP3のSHA-256を確認。Wranglerはリポジトリ外のインストールを`CASTLOOP_WRANGLER`で指定した。

追加でビルドし直した実行ファイルの`deploy`について、既存のWrangler設定に加えた任意の`vars`が保持されること、展開したWorkerに開発環境へのパスが含まれないことをローカルfixtureで確認。実際の専用サービスにも最新版を再deployし、認証付きhealthが`200`であることを確認した。`bun test`、`npm run check`、`git diff --check`を実行した。

検証用のCloudflareリソースとworkspaceは既存の専用サービスに残している。使用終了時に片付ける。Apple Podcasts Connectでの実番組登録審査は実施していない。
