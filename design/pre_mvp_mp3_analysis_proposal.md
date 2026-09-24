# MVP公開前のMP3解析内蔵化：比較とM4.5採用結果

2026-09-24。M4の配布手順に残った`ffprobe`依存を解消するための比較と、実測後の採用結果。下の「現状」はM4完了時点の説明。

## 現状と対象範囲

- M4時点のCLIの`analyzeAudio`（当時は`packages/cli/src/index.ts`、M4.5で`packages/cli/src/audio.ts`へ移動）はMP3拡張子、0超〜300,000,000 bytesを検査し、`ffprobe`で音声codec=`mp3`とdurationを取得していた。秒数は`Math.max(1, Math.round(seconds))`で整数化する。`update-episode-audio`でupload前に実行し、新音源の`publish-episode`でも、ローカルファイルのサイズ・duration・SHA-256を再検査する。音源変更のないEpisode更新、Show操作、公開Workerでは`ffprobe`は使わない。
- durationは`episodeCommit`を経てRSSの`itunes:duration`に入る。WorkerはR2のサイズとSHA-256を検査するが、音声フレームの再解析はしない。既存のジョブ・revision schema、凍結済みjob、公開済みmetadataと音源の意味を変えない。
- ここでいう「外部コマンドへの依存をなくす」は**MP3解析時の`ffprobe` subprocessをなくす**という範囲。Cloudflare管理・R2 upload・Worker deployには引き続きWrangler CLI（およびNode.js/npm）が必要。Wranglerも含む完全な外部コマンド不要化は別規模の計画とする。
- 対象音源はMP3（MPEG Layer III）のみ。MP4/AAC、音声変換、波形解析、全フレームの復号・音質判定、壊れたデータの自動修復はMVP対象外。入力の拡張子・実際の形式・サイズ・有限かつ正のdurationを検証し、判定不能な音源は**upload前に拒否**する。手入力のdurationで検証を迂回させない。

## 比較案

| 案 | MVPで実装する範囲 | メリット | デメリット・残る制約 |
| --- | --- | --- | --- |
| **A. 純JS/TSの既存ライブラリをCLIに同梱（推奨候補）** | 例: `music-metadata`の`parseFile(path, { duration: true, skipCovers: true })`を評価。形式・codec・秒数を明示検査し、既存の長さ上限と丸め、SHA-256再照合を維持。Bun実行ファイルにbundle。 | `ffprobe`の配布・PATH設定が不要。CBR/VBRやID3を自作せず扱える。MP3以外はcastloop側で拒否できる。Worker FreeのCPUに負担を増やさない。 | 新規npm依存とバイナリサイズ・解析時間が増える可能性。ライブラリの`duration: true`も全ファイルで値が得られる保証はなく、破損・特殊ファイルで`ffprobe`と差があり得る。**Bun単一実行ファイルでの実動作は未確認**。依存のバージョンとライセンス、300 MB時のメモリ・時間を評価する。 |
| **B. 対応範囲を限定した自前MP3フレーム解析** | ID3v2等を読み飛ばし、MPEG Layer IIIのフレームheaderを検証。Xing/Info/VBRIのフレーム数またはフレーム走査からdurationを算出。対応できないファイルや不整合は拒否。 | 追加依存がなく、単一実行ファイルに閉じやすい。受理する音源の範囲を明文化できる。 | 同期探索、VBR（ヘッダーなしも含む）、タグ・末尾ゴミ、切断フレームの扱いが複雑。軽いヘッダー読みだけでは全体の妥当性を確認できない。走査しても復号可能性は保証しない。独自parserの保守と検証工数がMVPには大きい。 |
| **C. WASM等の音声解析器を同梱** | FFmpeg系などの解析機能をWASM/組込ライブラリとしてCLIに載せ、外部プロセスを使わずMP3 codec・durationを取得。 | 既存の成熟した解析器に近い対応範囲を目指せる。`ffprobe`を配布先に入れなくてよい。 | ビルド、複数OS/CPU、メモリ、300 MB入力の扱い、実行ファイルサイズ、ライセンス確認が重い。`ffprobe`と同一の結果になる保証もない。MVPでは過大。 |
| **D. durationを管理者が手入力** | CLIでMP3らしさのみを確認して秒数をTOML等に記入させる。 | 実装量が少なく解析器を同梱しない。 | 誤入力がRSSへ伝播し、現行の「CLIでdurationを取得して検証する」要件を満たさない。音源を変更した後も古い値が残り得る。**MVP案として推奨しない**。 |

**検証の優先順位:** まず案Aを試験実装。無理なら次に**CLIではなくQueue consumer Worker側での解析**を検討・実測し、それも無理なら利用者にFFmpeg（`ffprobe`）を導入してもらう従来案に戻す。案B〜Dの表は方式の比較履歴であり、この順序で実装するという意味ではない。Worker案ではR2上の音源をストリーム・範囲読み込みで解析し、300 MBをメモリへ展開しない。durationの確定点、凍結commitとの整合、再試行の冪等性、Queue consumerのCPU・メモリを検証する。CLI解析を採用できた場合は公開Workerの処理を変えない。

## 推奨する進め方と判定条件

M4後、**MVP公開前の追加マイルストーンM4.5**として案Aを短期検証し、合格なら採用する。M1〜M4の完了記録を遡って書き換えない。

1. 小さな試験実装でライブラリのバージョン・ライセンス・Bun build同梱可否を確認する。`ffprobe`がPATHにない環境で、ビルド済み実行ファイルの`update-episode-audio`と`publish-episode`を通す。Wranglerを別途使用する点は変わらない。
2. CBR（ID3あり/なし）、Xing/Info等を持つVBR、VBRヘッダーなし、短い音源、M0で使用した300,000,000 bytesの音源を候補に、durationを基準用`ffprobe`と比較。**RSSに使う整数秒で一致**を目標とし、境界・例外時の許容差と受理可否を実測して明文化する。長大ファイルの解析時間・ピークメモリ・実行ファイル増分を測る。`ffprobe`は検証用の基準であり配布先の必須依存にはしない。
3. 拡張子だけ`.mp3`の別形式、0 byte、上限超過、不正ヘッダー・duration不明、ファイル変更後の公開を拒否することを確認。切断音源は基準の`ffprobe`を含む解析器がどこまで検知できるか確認し、保証範囲を明示する。`update-episode-audio`は検証に失敗した場合にuploadしない。前後でSHA-256・サイズの照合、凍結済みjobの復旧、metadata-only更新が変わらないことを確認する。
4. 採用時はCLI、配布ビルド、READMEを更新し、M4時点の依存説明は履歴として残してM4.5の変更を別記する。新規workspaceで`init`→Show/Episode公開→feed/MP3検証を行う。macOS/WindowsのCLI利用は各OS向け実行ファイルのビルド・検証が別途必要。

参照: [`music-metadata`のAPIと`duration`オプション](https://github.com/Borewit/music-metadata#ioptions-interface)、[`packages/cli/src/audio.ts`](../packages/cli/src/audio.ts)、[`m0_verification_log.md`](./m0_verification_log.md)。

## M4.5 検証結果と採用判断（2026-09-24）

**案Aを採用。** `music-metadata` 11.16.0（MIT、直接依存も確認した範囲ではMIT）をCLIへ固定し、`parseFile`でMPEG Layer 3 codecと有限・正のdurationを確認する。元のサイズ上限、整数秒の丸め、ローカル音源のSHA-256再照合、WorkerのR2照合は維持。依存はBunの単一実行ファイルへbundleされ、`ffprobe`のsubprocessは削除した。配布先ではWrangler/Node.js/npmは引き続き必要。Worker側案への移行は不要と判断した。

| 入力 | byte数 | 内蔵CLIの整数秒 | 基準`ffprobe`の秒数→整数秒 |
| --- | ---: | ---: | ---: |
| CBR、ID3あり | 177,258 | 11 | 11.049796 → 11 |
| VBR、Xingあり | 54,596 | 13 | 13.453061 → 13 |
| VBR、Xingなし | 37,513 | 9 | 8.533880 → 9 |
| 0.24秒の短い音源、ID3なし | 4,178 | 1 | 0.235102 → 1 |
| 320 kb/s・ID3 padding付き上限ファイル | 300,000,000 | 7,499 | 7499.049796 → 7,499 |

上限ファイルはM0で使ったものが残っていなかったため、同じ条件のMP3を**再生成**し、ID3 paddingでちょうど300,000,000 bytesに調整した。Bunソース実行で解析約0.08秒・ピークRSS約49 MB、Bun実行ファイルの`update-episode-audio`で解析＋SHA-256処理約0.59秒・ピークRSS約73 MB。後者のWrangler uploadはstubにしており、この試験では300 MBをR2へ再uploadしていない（M0で上限サイズの実転送は検証済み）。コンパイル済みCLIは約82,597,344 bytesで、M4時の約82,142,688 bytesから約455 KB増加した。

不正ヘッダー、MP3ではないデータの`.mp3`、0 byte、300,000,001 byteは拒否。追加したCLI解析の自動テストはMP3フレームの正例とこれらの拒否条件を確認する。**限界:** Xingのdurationを持ったVBRを途中で切断すると、`music-metadata`と`ffprobe`のどちらも元のdurationを返して受理した。codec・durationの検査は音源全体の復号可能性を保証せず、既存の`ffprobe`より強い完全性検査を約束しない。VBRヘッダーのない例でも小数秒は異なるが、今回のRSS整数秒は一致した。別の入力で丸め境界が変わる可能性は残る。

`ffprobe`のない`PATH`（Wrangler用のNode.jsだけを含む）でビルド済み実行ファイルと別置きWranglerを使い、既存ShowにEpisodeを初回公開。status=`published`、受付=`free`、feedのdurationとMP3 SHA-256を確認した。さらにmetadata-only更新とaudio-only更新を公開し、音源のstaging後にローカルファイルを変更した場合は`publish-episode`がcommit前に拒否し、元のファイルに戻すと同じ下書きで公開できることを確認した。Worker変更はないため、過去に検証した凍結jobのretry/DLQロジックはそのまま。

別の新規workspace `/tmp/opencode/castloop-m45-fresh-40a9bf/`では、同じ実行ファイルから新規サービス`m45-40a9bf`を`init`し、Show `mp3-test`とEpisode `first`（XingなしVBR）を公開。feed duration=`00:00:09`、公開MP3のSHA-256一致、両jobが`published`・受付`free`となった。完了済みjobへの`retry-job`はHTTP 409で拒否。初回`init`直後のhealthはWorker URLの反映前にHTTP 404だったが、同じworkspaceで再実行して完了した。検証サービスとローカルworkspaceは片付けの判断まで保持する。これは**同じVPSの新規workspace**であり、別OS・別ホストのクリーン導入の実証ではない。

最終確認: `bun test` 14件、`npm run check`、`git diff --check`通過。配布物に含まれる第三者ライセンス表記と別OS向けビルドの扱いは、配布物の確定時に確認する。
