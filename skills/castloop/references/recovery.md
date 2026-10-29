# 中断・エラー・結果不明

## コンテンツ公開

`preview-*`と履歴で現在内容を確認する。同じ承認済み入力で`publish-*`や同じlifecycle／revision計画を再実行でき、既に反映済みなら`unchanged`になる。異なる内容と古い更新元は409。自動再送や勝手な更新元の取り直しはしない。

素材配置だけでは公開しない。PUT失敗時は公開へ進まず、原本や未参照素材を推測で削除しない。公開用job・operation追跡・progress/watchは廃止した。配信確認は`verify`、状態診断は`diagnose`を使う。

予約作成の応答不明は`schedule-list`で確認し、新規予約を無条件に再作成しない。RSSは同じ入力と一括進捗記録から続けるが、登録・Resume・ローカル配置の結果が不明なら停止する。

## インフラ・制御操作

公開の冪等性をinit・登録・Resume・deploy・domainへ一般化しない。これらは同じworkspaceの保存済みjournalと操作IDを使う。未知PUT/POST/DELETEや未確認配備を新IDで再送しない。lock・journal・証跡の削除、owner token奪取、prefix削除は禁止。

停止・再開の応答不明は`show-control-status SHOW UUID --workspace PATH --json`を読む。適用時の結果と現在状態を区別し、見つからなくても未実行と推測しない。deploy/domainは対応helpの限定続行だけを、別途許可された範囲で行う。

Resume、deploy、domain、取消、非公開化、復元を通常編集の許可から推測しない。他Showの障害を理由に健全なShowを停止せず、診断へ秘密や未公開本文を載せない。
