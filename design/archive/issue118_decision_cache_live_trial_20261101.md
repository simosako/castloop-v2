# 判定キャッシュ（Issue #118 案1）の実機検証（2026-11-01）

2026-11-01。管理者の指示により、配信ゲート判定キャッシュ（`SqliteCachedDecisions`、Issue #118 案1）を導入したリビジョン `cf839a5` の新規隔離環境での非公開実機試験と、DOリクエスト消費の測定を実施した。目的は案1の効果（音声1応答＝DO 1リクエスト［統計のみ］、フィード・カバー・HTML＝DO 0リクエスト）の実機実証。試験環境は試験完了後の管理者の別指示で削除した。

## 環境

| 項目 | 値 |
| --- | --- |
| service ID | `rev-cf839a5-7f9b` |
| Worker | `castloop-rev-cf839a5-7f9b-244468a2` |
| R2バケット | `castloop-rev-cf839a5-7f9b`（非公開） |
| Accessアプリ | `Castloop cf839a5 Private Trial`（ドメイン `<worker>.workers.dev/podcasts`） |
| Show / Episode | `rev9a5-normal`（`site_mode = "builtin"`）、素材はサイズ降順3件（既定の選定規約どおり） |
| 実施リビジョン | `cf839a5`（v0.8.6 + 案1実装） |
| 証跡 | `.local-test-data/results/20261101/rev-cf839a5-7f9b/` |

Accessポリシーは確認者のメール完全一致をInclude、アカウントメンバーとログイン方法をRequireとする1つのAllowポリシー（前回承認済み設定の継承）。手順は[実機試験手順書](../live-trial.md)どおり。

## 正常系の結果

| 検証 | 結果 |
| --- | --- |
| `pre-upload` | 合格。subdomain有効・プレビュー無効、匿名302は6/6 |
| 公開 | `create-show --site-mode builtin`、`publish-show`、`preview-episode`→`publish-episode --expect-preview`×3、すべて成功 |
| `post-publication` | 合格 11/11。R2音声3件がSHA-256キーで原本と全量一致、cover一致、匿名拒否302×33/33、`/admin/*` 401、`/system`・`/staging` 404 |
| 確認者のブラウザ確認 | トップページ表示・3 Episodeを数秒ずつ再生×2回 |
| 原本の不変性 | `original-sha256-before.txt` と `original-sha256-after.txt` が一致（37ファイル） |

## DOリクエスト消費の測定

GraphQL Analytics（`workersInvocationsAdaptive`／`durableObjectsInvocationsAdaptiveGroups`、10秒バケット。DO側は10〜20分の反映遅延あり）とShow DOのSQLite統計で測定した。確認者の操作は次の3区間。全区間でブラウザキャッシュを無効化したのは2区間目以降（1区間目終了後、ブラウザバッファからの再再生でエッジ到達しない挙動を観測したため）。

| 区間 | 操作 | Workers req | DO req | DO内訳 |
| --- | --- | --- | --- | --- |
| 1回目（コールド） | トップページ＋3音声再生 | 17 | 9 | HTML判定1＋HTML本文1＋cover判定1＋音声判定3＋統計3（期待値と完全一致） |
| 2回目・手順1（ウォームアップ） | 同じ操作の再実行 | 11 | 8 | 判定TTL切れ後の再ミス。前区間の末尾で載った音声判定はヒット |
| 2回目・手順2（判定・本文キャッシュTTL内） | 同じ操作の再々実行 | 7 | **3** | **音声統計3のみ。HTML・cover・音声の判定と本文はすべてキャッシュヒットでDO 0** |

### 効果の読み取り

- 手順2（キャッシュウォーム時）のDO消費は**音声1応答＝DO 1（統計記録のみ）**で、判定は全経路で0リクエスト。HTML・coverもDO 0。**案1導入前の同じ操作ならHTML判定1＋cover判定1＋音声ゲート3＋統計3＝DO 8消費するところを3に削減（-62.5%）**
- 1回目（コールド）は判定キャッシュも本文キャッシュもミスするため、DO消費は導入前と同じ9（想定どおり）。削減効果は同一パスへの再アクセス（TTL 300秒以内、またはパージまで）で発現する
- 音声応答はShow DO統計に欠落なく記録された（累計11応答＝206×10＋304×1。手順2の304は本文キャッシュの条件付き再検証ヒットで、Range・条件付き要求対応も正常）
- Workersリクエストは削減されない（案1の設計どおり。Workers Free 10万req/日が次の天井）

## 未確認の範囲

- 長期間の稼働・高い並行でのDO duration（GB秒）の実測値。今回は回数のみ測定した
- フィード（`feed.xml`）経由のDO削減は、Podcastアプリでの連続ポーリングを再現していないため直接測定していない（判定キャッシュの仕組みはHTML・coverと同一）
- 環境は測定完了後、管理者の明示指示で削除した（下記）

## 試験環境の削除

管理者の明示指示（測定完了報告に対する承認）により、対象を完全一致で特定して削除した。順序は Worker削除（forceなし、namespace消滅を確認）→ 列挙済み5 objectの完全一致key削除 → bucket削除 → Access application削除。最終確認で対象のWorker・bucket・Accessアプリは404、`castloop-issue65sc11-f93cd6-e5e0231f` とそのAccessアプリケーションは存続を確認した。応答は証跡の `cleanup-*.json` 参照。R2 objectの別backupとDO SQLiteのexportは行っていない（ローカル原本・workspace・証跡は不変・残存）。

## 関連

- 検討: [配信の無料枠スケーリング検討](delivery-free-tier-scaling.md)
- 設計: [公開配信とキャッシュの設計](../components/delivery.md)
- 手順書: [実機試験手順書](../live-trial.md)
- Issue: [#118](https://github.com/simosako/castloop-v2/issues/118)（継続検討のため未解決のまま）
