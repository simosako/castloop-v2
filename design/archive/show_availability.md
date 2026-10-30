# ShowとEpisodeの公開状態制御（非公開化・復元）

フェーズ3開発版の新規**14/13**環境向け。旧版の独立したruntime停止コマンド（`show-pause`、`show-resume`、`show-admission-pause`、`show-delivery-resume`、`show-control-status`）は廃止し、配信の停止・再開はすべて既存のlifecycle操作（`unpublish`／`restore`）に統合した。

## 基本方針

- 登録したShow（`create-show`）は即座に公開操作を受け付ける状態（`publication_ready: true`）になる。初回の`show-resume`は不要。
- 公開は管理者の明示操作（`publish-show`、`publish-episode`）でのみ行われる。R2への素材配置やローカル編集だけでは公開されない。
- リスナーへの配信を止めたい場合は、対象ShowまたはEpisodeを `unpublish`（非公開化）する。再開したい場合は `restore`（復元）する。
- 通常のWorkerコード更新（`castloop deploy`）では、事前のShow停止や手動再開は不要であり、配信と予約公開を維持したまま更新できる。
- 独自ドメインの変更中（`domain add`／`remove`の準備から確定までの間）は、対象のDOが自動的にHTTP 503を返して配信を保護し、確定完了とともに通常配信へ復帰する。

## 非公開化と復元

```sh
# Episodeの非公開化と復元
castloop preview-episode-lifecycle daily first unpublish --workspace /path/to/service > plan.json
castloop lifecycle-execute plan.json REQUEST_SHA256 confirm --workspace /path/to/service

castloop preview-episode-lifecycle daily first restore --workspace /path/to/service > restore-plan.json
castloop lifecycle-execute restore-plan.json REQUEST_SHA256 confirm --workspace /path/to/service

# Show全体の非公開化と復元
castloop preview-show-lifecycle daily unpublish --workspace /path/to/service > show-plan.json
castloop lifecycle-execute show-plan.json REQUEST_SHA256 confirm --workspace /path/to/service
```

- `unpublish`は必要なキャッシュパージ後にSQLiteトランザクションで公開状態を切り替え、Feed・HTML・画像・音源の配信を停止する。保存済みの音源・画像・revision履歴は削除しない。
- `restore`は保存済みの確定内容を使って配信を復元し、GUID・公開日時・音源identityを保持する。手元の未公開編集を暗黙に採用しない。また、Show全体の`restore`で個別に非公開化したEpisodeが勝手に復活することはない。
- 既に同じ状態になっている対象への再実行は、`unchanged`として安全に完了する。物理削除は未実装。

詳細は[フェーズ3設計](../phase3_deploy_and_runtime_control_simplification_plan.md)および[SQLiteガイド](../../docs/sqlite_sequential_development.md)を参照する。
