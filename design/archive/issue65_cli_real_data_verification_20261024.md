# Issue #65: CLI基盤の実データ検証（2026-10-24）

## 対象と境界

管理者から実環境テストの指示と、次のサンプル利用許可を受けた。

- `.local-test-data/minimal/`
- `.local-test-data/normal/`

現在のIssue #65実装は、任意の管理設定と日時変換のCLI基盤だけである。**サーバー側の予約登録・Alarm／FIFO連携は未実装のため、今回はLinux単体CLIを実サンプルに対して実行する検証であり、Cloudflare nativeの予約公開試験ではない。** この区別を実行前に明示した。

対象はこのworktreeの`9c8c23f`を基準とする未commitの開発内容。`npm run build:cli -- linux-x64`で構築し、別の試験用ディレクトリへコピーしたバイナリを実行する。ソースや依存packageの実行ではない。

- サンプル原本は読取専用。既存の設定・鍵・journalへ追記・移動・削除しない。
- 書込は、このworktreeのgit-ignoredな`.local-test-data/results/20261024/issue65-cli-real-data-*/`以下の新しい証跡・試験設定だけ。
- CLI子processには`PATH=""`、試験用`HOME`、指定した`TZ`だけを渡す。Cloudflare資格情報や管理鍵を渡さない。
- 実行コマンドを`validate`、`preview-schedule-time`、`schema`、`template`、`doctor`に限定する。
- Cloudflare操作コマンド、配備、公開、Resume、資源／domain／権限／課金変更・削除は実行しない。

## データの規模

| サンプル | Episode／MP3 | 音源合計bytes | 音源最大bytes | 注意 |
| --- | --- | --- | --- | --- |
| minimal | 3件 | 801,568 | 480,488 | manifestの`fixture_transport_only=true`。音質・番組内容の受け入れではない |
| normal | 36件 | 1,496,055,589 | 62,853,537 | 実ファイルを読み、MP3解析と入力検証を行う |

両ディレクトリとも`castloop.toml`と`castloop-admin.toml`はない。これらを既存Cloudflareサービスのworkspaceとして採用しない。管理設定の試験は別の新規ディレクトリで行う。

## 試験内容

1. manifestのEpisode件数・音源サイズ／SHA-256・cover SHA-256を実ファイルと照合する。
2. 2 Showのmetadata／coverと39 Episodeのmetadata／MP3を単体CLIで検証する。
3. 39 Episodeの保存済み`published_at`を日時previewへ渡し、元のoffsetが決めるUTCと独立した変換結果を照合する。原本日時・GUIDは変更しない。
4. UTC既定、設定、CLI上書き、明示offset、年境界、15分単位offset、DSTのgap／fold、不正日付・略称・未知zone等の22ケースを、PCの`TZ=UTC`／`Asia/Tokyo`／`America/Los_Angeles`で実行する。
5. 未知key／version／zone、略称zone、不正UTF-8、空／過大ファイル、symlink／dangling symlink／directory／FIFOの11ケースを拒否することを確認する。
6. 管理設定のtemplate／schema／validate／doctorを実行し、doctorの前後で試験workspaceが不変であることを確認する。
7. サンプル全体の前後snapshotを照合する。通常ファイルはmode・size・mtimeとSHA-256、`.castloop/`以下は内容を読まずファイル属性のみを記録する。公開されていない本文・鍵・journal内容を検証文書へ転載しない。

preview／validateが`publication_ready=false`を返し、previewは`server_time_checked=false`を維持することも検査する。

## 通信トレースの取得制限

最初は`strace -f -e trace=network`付きで実行したが、最初のCLIコマンドのJSONを取得できず停止した。対象バイナリの存在と実行属性、空のtraceを確認し、同じ起動条件を固定分類付きで再現した。

- 診断: `ptrace_permission_denied`。実行環境の`ptrace`が`Operation not permitted`で拒否された。
- 再現時のexit 1、stdout 0 bytes、stderr 283 bytes、trace 0 bytes。stderr原文・任意例外文は診断へ保存しない。
- これはCLI入力検証の失敗ではなく、tracerによるCLI起動前の停止。初回のサンプルsnapshotは前後同一だった。
- 初回の証跡と元runnerを保持し、権限変更・sudo・保護解除は行わない。
- 原因を確認した後、別の新しい証跡ディレクトリで、tracerだけを明示的に外して同じCLI試験を実行する。

**通信トレースは取得不可であり、外部通信ゼロを実測したとは扱わない。** 資格情報を渡さず、オフラインコマンドだけを使ったという実行範囲と、syscall観測の欠測を区別する。

## 結果

**CLI実データ試験は162件すべて期待どおり。** 正常終了121件、意図した入力拒否41件、想定外exit 0件、stderr出力0件。先行したtracer起動失敗とは区別する。

| 検証 | 件数 | 結果 |
| --- | --- | --- |
| Show metadata／cover、Episode metadata／MP3 | 2＋39 | 全件成功。manifestのサイズ・SHA-256照合も一致 |
| サンプルに保存済みの日時の変換 | 39 | 元offsetを保ち、Pythonの独立したUTC変換と一致 |
| 日時・zone・DSTの行列 | 22ケース×3 TZ＝66 | 正常36・意図した拒否30。PCのTZによる結果差なし |
| 不正管理設定 | 11 | 全件拒否。CLIでUTCを指定しても不正ファイルを黙って無視しない |
| template／schema／validate／doctor | 5 | 成功。doctor前後の試験workspace不変 |
| サンプル原本の前後照合 | 2データセット | 一致。通常ファイルのhashと、`.castloop/`以下のファイル属性が不変 |

実行区間は2026-10-24 **14:13:47〜14:14:19 UTC**。前後の原本照合を含むrunnerのwall timeは32.322秒。性能benchmark、公開所要時間やCloudflareのCPU測定ではない。

実行バイナリのSHA-256:

```text
ece9302ae9ec429e85dd7056f7cd84e72b761aa51506a78885bbc9c4b274f3b6
```

private証跡はこのworktree内の次の新規ディレクトリに保全した。原本・秘密・本文をGitへ追加しない。

- `.local-test-data/results/20261024/issue65-cli-real-data-sn78p6b1/`: 初回のtracer起動停止、固定分類による同条件再現、元runnerと前後snapshot。
- `.local-test-data/results/20261024/issue65-cli-real-data-k0v3rh_0/`: 成功した試験の`summary.json`、162コマンドの固定項目の結果、前後snapshot、runner、バイナリ、provenance。

全39 Episodeの音源合計は**1,496,857,157 bytes**。素材のuploadは0件であり、音源検証成功をR2保存・公開成功と解釈しない。CLIへのCloudflare資格情報提供はなく、remote readinessやサーバー時刻も未確認のままである。syscallによる通信観測は前節の理由で欠測。

この試験では製品ソースを変更していない。CLIを再buildして実サンプルで確認し、文書を更新した。先行する674単体テストの結果を今回のCloudflare native試験へ読み替えない。

## 未確認範囲

- Cloudflare nativeの予約受付・Alarm配送／再起動・二重起動防止・取消競合・Pause／保守・公開成功。
- R2 upload、Feed／直リンクの時刻gate、実Cache purge、runtime／config／windowのサーバー検証。
- 300,000,000 bytes上限付近の音源、性能・CPU・Free適合、障害下での最大遅延。
- 通信syscallの観測。PCの`TZ`非依存を確認しても、Cloudflare runtime自体のtimezoneを実測したことにはならない。

予約公開の実機試験は、[採用計画](episode_scheduled_publication_plan.md)のサーバー実装とローカル回帰後に、対象と変更範囲を明確にした別の試験として行う。
