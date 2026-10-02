# M6: generation/base取得とlocal更新・公開の一体化

未公開`updateLocalM6Draft`/`publishLocalM6Draft`はtarget inspection clientとdurable target runnerを結合する。CLIへは未接続。callerがgeneration/draft job ID/base revision本文を手入力する必要をなくし、既存local TOMLだけをeditable sourceとして扱う。legacy operation stateを読み込んで変換・昇格しない。

## 明示更新

1. local lock、publication-prepared、未解決uploadを検査して拒否する。requested/残存lockの回復をstatus観測から許可しない。
2. 認証済みtarget snapshotを一回取得し、exact identityとlocal headの前後一致を確認する。paused/unfinished owner/不適格lifecycleは拒否する。
3. 初回ならUUIDを一度生成してprivate headへ保存する。editable headのID/baseは維持し、current base変更では拒否する。frozen headならexact commit/historyを照合して新UUIDへrotationする。
4. 個別upload UUID/固定秒精度timestampを生成し、target runnerへ現在generationとhead IDを渡す。metadata/audioの順序に依存せず同draftを使う。

明示更新でrotationしてもremote ownerを解放しない。consumer未完了ならsnapshotのownerで拒否する。serverのCAS/current/base検査は常に残る。headが欠落しても、local history/publication journal/lockのIDは新headとして再利用しない。

## 明示公開

local head/upload/publication recordを検査してからtargetを照会し、baseと現在generationを再確認する。必要なcurrent revisionは認証responseからその呼出のmemoryだけに渡し、head/journalへ本文を複製しない。公開runnerがlocal入力とstage receiptsを再照合する。

prepared publicationが既にある場合、その固定timestampを維持して明示続行する。generation変化/manifest変更を拒否し、requested/claimed/commit_requestedを自動再送しない。publication-prepared headにjournalが欠ける場合も拒否する。head IDをrunner内のtarget lock取得後にも照合し、別draftへ処理を乗り換えない。

自動testは四つの入力経路、metadata/audioの同ID維持、consumer完了前の次更新拒否、完了後のarchive付きrotation、unknown outcomeの非再送、base/identity/local途中変更、prepared timestamp保持を結合する。Cloudflare実機受け入れや公開command提供ではない。

公開CLIのcommand/引数/管理key接続、Show登録/local作成との全体統合、移行と外部復旧、実機受け入れ・release案内は残る。
