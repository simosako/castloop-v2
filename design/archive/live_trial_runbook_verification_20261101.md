# 実機試験手順書の実機検証(2026-11-01)

2026-11-01。管理者の指示により、新設した[実機試験手順書](../live-trial.md)と検証スクリプト `scripts/live-trial-verify.py` を検証するため、手順書どおりの小規模な非公開実機試験を実施した。対象は新規の隔離環境のみで、既存の保持環境(`rev-ebaf516-d09bb9`、Issue65環境)には触れていない。試験環境の削除は別承認とし、本記録時点では保持している。

## 環境

| 項目 | 値 |
| --- | --- |
| service ID | `rev-ea502a6-8a63` |
| Worker | `castloop-rev-ea502a6-8a63-b779c0e4` |
| R2バケット | `castloop-rev-ea502a6-8a63`(非公開) |
| Accessアプリ | `Castloop ea502a6 Private Trial`(ドメイン `<worker>.workers.dev/podcasts`) |
| Show / Episode | `rev2a6-normal`、素材はサイズ降順3件(前回試験と同一のMP3とcover.jpg) |
| 実施リビジョン | `ea502a6`(v0.8.5 + 手順書・スクリプト) |
| 証跡 | `.local-test-data/results/20261101/rev-ea502a6-8a63/` |

Accessポリシーは、確認者のメール完全一致をInclude、アカウントメンバーとログイン方法をRequireとする1つのAllowポリシーで、構造と値は前回承認済み設定の継承(確認者メールは前回証跡から抽出)。

## 結果

| 検証 | 結果 |
| --- | --- |
| `pre-upload`(スクリプト初回実機実行) | 合格。subdomain有効・プレビュー無効、匿名302は6/6 |
| 公開 | `publish-show`、`preview-episode`→`publish-episode --expect-preview`×3、すべて成功 |
| `post-publication`(初回) | 合格 11/11。R2音声3件がSHA-256キーで原本と全量一致、cover一致、`system/service.toml`存在、匿名拒否33/33(GET・HEAD・条件付き・Range)、否定パスは `/admin/*` 401・`/system`・`/staging` 404・`/podcasts` 302(Accessスコープ) |
| 確認者のブラウザ確認 | 管理者がトップページ表示・Episodeページ移動・再生・シークを確認 |
| `post-publication`(確認者アクセス後の再実行) | 合格 11/11。キャッシュが温まった後も匿名拒否は維持 |
| 原本の不変性 | 証跡 `original-sha256-before.txt` と `original-sha256-after.txt` が一致(37ファイル) |

手順書の目的(手順書とスクリプトだけで試験を再現できる状態にすること)は達成した。コマンドの試行錯誤は発生せず、必要な修正は以下の手順書側3件だけだった。

## 発見した手順書の誤り(同一コミットで修正済み)

1. **initのoperation-id**: 位置引数にoperation-idを渡す形式だったが、initの位置引数は対象ワークスペースディレクトリとして解説され、`--workspace` と不一致の場合は `target_mismatch`(`not_started`)で拒否される。operation-idは `--operation-id` フラグで渡す。誤実行は入力検証で停止し、ローカル・リモートとも無変化だった。
2. **create-showの `--site-url`**: 非対話実行では必須。生成される雛形の初期値にのみ使われ、`show.toml` を転記で置き換えるため公開内容には影響しない。
3. **workers-subdomainの継承元**: 前回証跡の `castloop.toml` に設定項目としては存在しない。`workers_dev_base_url` のホスト部(2番目のラベル)から読み取る。

## 未確認の範囲

- 性能、CPU使用量、Free枠への適合は測していない。正常系の公開・配信・保護確認のみ。
- 別メール・別アカウントによるAccess拒否、別ホスト名・preview URLからの迂回不可は、今回は実施していない(前回試験で確認済みの項目)。
- 試験環境(Worker・バケット・Accessアプリ)は保持中。削除には別承認が必要。

## 関連

- 手順書: [実機試験手順書](../live-trial.md)
- 要件: [セキュリティ設計](../security.md#非公開の実機試験)
- 前回(2026-11-01実施のv0.8.5リリース試験、`rev-ebaf516-d09bb9`)の記録は本記録作成時点で未作成
