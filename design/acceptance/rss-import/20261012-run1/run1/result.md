# RSS移行 run1 中間結果（2026-10-12）

**独自ドメインとShow公開は完了。承認後の継続で最初のEpisodeの状態検証エラーが再発し停止。全件移行完了ではない。**

対象commit: `5413fba350f3ae340c94d63030eb37e41b5ca116`。
CLI SHA-256: `098565a1c5f0003920042d8b75bb642b3a80fa1bb725a9d0b01cdd8db912b073`。

| 段階 | 結果 |
| --- | --- |
| build/check/自動テスト | 成功、960 pass / 0 fail |
| 名前競合・認証付きAPI・容量確認 | 成功 |
| 初回local import | 親imports未作成で停止、管理者が作成/再開を承認 |
| 全36 Episode/カバー取得 | 成功、実音源合計1,496,055,589 bytes |
| source XML→TOML・素材receipt独立照合 | GUID/permalink/日時/title/description/対応任意項目/全素材hash一致 |
| 同一local import再実行 | 成功、import IDと116ファイルhash/size/mtime不変、lockなし |
| カバー/音源確認 | カバー表示成功、全36 MP3のCLI解析成功、代表2件の先頭30秒decode成功（人の聴取ではない） |
| 新M7サービスinit | 成功、external_episode_guids=true、paused |
| 独自ドメイン追加 | DNS/TLS待ちで一度停止。承認後1.1.1.1経路で同じoperationを正常完了、正規URL変更・resume成功 |
| Show公開 | 一度状態検証エラーで停止した後、再照会でpublished/released・owner解消を確認 |
| Episode公開 | 最初のEpisode publish receipt後に状態検証エラー再発。cursor waiting/step8、停止時processing/held。残り35件未着手 |
| 全件配信照合 | 未実施 |
| 公開再実行重複防止・lifecycle/通常更新回帰 | 未実施 |
| 購読者切替・旧環境廃止 | 対象外、実施なし |

## 停止状態

- 新service `rsstest-1012-r1`、bucket `castloop-rss-20261012-run1`。
- 新Worker/main Queue `castloop-rsstest-1012-r1-acb1fbca`。関連DLQも初期化資源として保持。
- 管理URL: `https://castloop-rsstest-1012-r1-acb1fbca.simosako.workers.dev`。
- 現正規URL: `https://castloop-rss-r1.otftalk.com`。
- 初期pause ID `fa44efef-405b-4d4d-8b9a-01030f7e18a5`でresume済み。停止後の読み取りではopen、invocations1件、url_changeなし。
- domain operation `e1a5c445-31d6-4b6d-963a-bf90dbc3765f`はcompleted=true/phase=complete、pending/lockなし。configuration_matches=true、connections_match=true、local_operations=[]。
- 公開import ID `908efe60-3585-4a6a-af01-f1c5d8afb206`、cursor waiting/step8、waiting job `a497abe0-450b-407b-96bb-c52d7782547c`、cursor lockなし。
- 先行Show job `7d484a96-f681-41ad-b91d-c877fb858b7e`は承認後の再照会でpublished/released・owner解消を確認し、同一importを継続した。
- 最初のEpisode jobの保存した読み取り状態はprocessing/ownership held、target-showはunfinished_show_operation=true。解放/終了の証明がないため次のEpisodeへ進めない。consumerが進行中の可能性がある。
- エラー: `Operation status could not be verified; preserve records, locks and ownership without automatic retry or recovery`。内部原因は未確定。DNS起因と判断しての自動継続はしていない。
- エラー後は公開再実行・job再送・pause/resume・強制復旧を実施していない。新サービスはopenのまま保持。
- 試験限定CONNECT tunnelは終了済み、OS/ルーターDNS設定は変更なし。

## 内容の限界

36件は取得したRSSに載る全件であり、RSSに載らない旧番組Episodeの存在までは確認していない。全GUIDはUUID形状のため、非UUIDの実機移行は本素材では証明しない（自動テストで検証）。

対応外RSS項目はwarningsに保存。description内でanchor.fm/spotify.com/cloudfront.netへの依存は検出されなかったが、全外部リンクの生存確認ではない。旧ホストの設定・コンテンツ・購読先は変更していない。

## 保存・続行

`imports/rss-20261012-run1/`のsource.xml/TOML/素材/私有journal、`workspaces/rss-20261012-run1/`、新Cloudflare資源と未完了domain記録を保持する。これらの秘密を含む原本はGitHubへ公開しない。

管理者がDNS起因エラーでの1.1.1.1利用を都度確認なしで承認。DNS/TLSをcurl --resolveで検証し、Bun fetch用CONNECT tunnelを使って固定domain operationを継続できた。ただしCLIの最終RSS取得はnode:http/httpsの別経路であり、その到達性はまだ検証していない。

公開側は管理者承認後に1回継続したが、別jobで同じエラーが再発。再発後は中止指示に従い停止し、無断で自動継続ループへ拡大しない。次は原因調査、またはこのエラーに限定した既知waiting job完了解放確認後の継続方針を判断する。新init/jobへの置換やtoken強制解除はしない。

活動記録: `test-20261012.log`。主証跡: `local-import-validation.json`、`local-import-repeat-validation.json`、`initialized-validation.json`、`domain-added-validation.json`、`publication-before-continue-validation.json`、`publish-import-continued.stderr`、`publication-stop2-summary.json`、`publication-stop2-service/target/job.json`。前回停止時の証跡も保持。
