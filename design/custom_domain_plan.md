# 独自ドメイン対応計画

作成日: 2026-09-25
方針確定: 2026-09-26
改訂日: 2026-10-04（v0.2.1 / M6完成後）
状態: 基礎実装済み、公開CLI未提供。以下は既存の共通処理を再利用する改訂計画であり、追加実装の完了報告ではない。

## 目的とスコープ

管理者自身のCloudflareアカウントのWorkerを、**1サービスにつき1つの独自ホスト名**からも配信する。サービス内の全Showに共通で適用し、private R2 / 1 Workerという構成は変えない。

- `add`は独自ドメインを正規URLにし、`remove`はworkers.devへ戻す。両方を同じリリースで提供する。
- workers.devは維持し、通常稼働中は同じfeed・画像・音源をredirectなしで配信する。
- 対象はM6初期化済みサービス。旧形式データ変換、v0.1.1への直接導入は対象外。
- Show別ドメイン、複数ドメイン、無停止切替、外部権威DNSのpartial setup、R2公開ドメイン、Cloudflare for SaaSは対象外。
- Workers Paidや新しいストレージ・Queue・汎用移行フレームワークを前提にしない。

## 現在の実装と今回必要な差分

- `CloudflareApi.ensureWorkerDomain`は、Workerに別のCustom Domainがある場合やhostnameが他Workerに属する場合に拒否する。**1サービス1ドメインの制限は基礎APIで実装済み**。同じhostnameの再実行、zone/DNS競合確認、所有Workerを確認した切断もある。
- `src/media-url.ts`の`canonicalEnclosureUrl`と`src/feed.ts`は、既存音源pathを現在の正規URLへ組み直す。履歴の絶対URLをそのままRSSへ出す問題は解消済み。
- M6にはサービス停止、invocationとShow所有者の確認、CAS、lifecycle判定、feed生成、cache purge、ローカルjournal保存がある。新しい独自ドメイン専用の同等実装は作らない。
- 未実装なのはCLIへの接続、TLS/到達確認、正規URLと既存feedの変更・復旧、および通常deployの制限解除と確認。

## 一つの責務を一か所へ置く

ドメイン名の有無は通常の配信・公開・削除・restoreの内部処理から切り離す。Cloudflareへのホスト名接続自体はWorkerコードやR2データの移行ではなく、domain操作では対応済みWorkerを再配備しない。

| 責務 | 実装方針 |
| --- | --- |
| ドメイン固有 | 既存Cloudflare APIによる接続・照会・切断と、DNS/TLS・対象Workerへの到達確認だけ。 |
| 正規URLの変更 | add/removeで共通の旧URL→新URL処理を使い、設定同期・active Showのfeed再生成・purgeを行う。 |
| 安全な停止と排他 | M6のservice admissionとCASを使う。必要な操作所有者・実行tokenの拡張も同じ層へ置く。 |
| feedの内容と公開状態 | 既存のlifecycle選別と`renderFeed`を使う。既存helperがShow execution前提なら、必要な選別処理だけ共有し、公開jobを偽装しない。 |
| journalのファイル保存とlock | `createLocalJournalStorage`を再利用し、操作固有の状態・receipt検証だけを残す。 |

単なる別名の接続だけならfeed変更は不要だが、承認済みの仕様は「追加時に正規URLも変える」である。この**設定変更の間だけ**、公開処理との排他と途中失敗の記録が必要になる。別のconsumer、Show別のドメイン状態、巨大な汎用状態機械は追加しない。

## CLIと設定

```text
castloop domain add <hostname>
castloop domain list
castloop domain remove
```

- add/removeは既存の`service-pause <pause_uuid>`と処理終了確認後に実行し、完了後もpausedのままにする。再開は既存の`service-resume <pause_uuid>`へ一本化する。listは停止不要・読み取り専用。
- listは想定される0件または1件の接続、正規URL、処理中/要再試行を示す。「list」は複数ドメイン対応を意味しない。外部操作で複数接続や設定不一致が生じた場合も隠さず報告し、変更操作は拒否する。
- hostnameはscheme・path・port・wildcardなし。別hostnameへ変更する場合はremove後にaddする。
- `public_base_url`は正規URLのまま維持する。管理・復帰先は保存したworkers.dev URLへ固定し、CLIの共通管理クライアントで解決する。DNS障害時に公開URLへ管理鍵を送るfallbackはしない。
- workers.dev URLの保存項目は`workers_dev_base_url`を追加する方針。未設定のM6サービスは、既存workers.dev URLの対象Worker/accountを確認してから保持する。strict schemaを維持し、対応Workerへ通常deployしてから新項目・domain操作を使う。
- 設定はローカル`castloop.toml`とR2 `system/service.toml`へ保存する。操作進捗・実行tokenはservice TOMLではなく運用recordへ置き、管理鍵・API tokenは保存しない。

## 切替・復旧の最小手順

1. 対象サービス、旧/新URL、hostname、pause IDを固定する。M6のpaused状態、invocation終了、全Showの登録完了・所有者解放を確認する。停止中も既存consumerは収束できるため、invocationが0というだけで完了と扱わない。
2. 同じservice admission上でCASにより操作所有者を確保する。変更中のconsumer/recovery、別deploy/domain操作、早すぎる`service-resume`を共通層で拒否する。別markerの非原子的チェックやShowごとの新しいdomain lockは使わない。
3. addでは既存APIで接続し、DNS/TLSと同じWorker・serviceへの到達を確認する。管理鍵を送る前にCloudflare側の所有・接続先を確認し、redirectは追わない。未準備なら完了を報告せず再試行待ちにする。
4. active Showのfeedだけを新URLで再生成し、共通cache処理でpurgeする。active Episodeだけを載せ、draft/unpublished/deleting/deletedを復活させない。音源・revision/current Episode metadata・GUID・公開日時・Showの`site_url`は変更しない。
5. 全対象feedとpurgeの完了を確認してからR2の正規URLを変更し、ローカル設定を揃える。設定hashを持つ稼働証跡も整合させるが、同じWorkerのversion・bindingsを架空の再配備で更新しない。
6. removeではworkers.devへの到達、保存済みfeed/媒体、cache・設定の収束を確認してから、対象WorkerのCustom Domainだけを切断する。
7. 完了を記録し、操作所有者を解放する。サービスはpausedのままとし、明示再開後に両ホストの実配信を確認する（remove後の独自ホストは対象外）。

通常の公開GETはpaused中に503を返す。停止中の到達確認は管理API、feed/媒体の確認は認証済み管理経路で行い、「停止中にも公開GETで200を確認する」ための配信gate迂回は作らない。対象Showが0件でも設定変更は行う。

- R2の小さな操作recordには、固定要求、全体の進捗、所有者・実行token、確認済みreceiptだけを残す。タイトル・説明・emailを複製せず、音源やrevisionの移行inventoryも作らない。
- 同じadd/removeで同じ操作を再開する。成功済みfeedの再確認・再生成とpurgeの再試行を許し、全Show分の大きな計画や最適化用履歴は不要とする。処理量には既存同様の明示的上限を設ける。
- Attach/Detachの応答喪失はCloudflareの照会で確認し、ローカル設定だけが未更新なら同じ要求のremote完了記録から同期する。公開feedが途中で新旧混在しても、全体確認までは再開を拒否する。
- ただし生存不明の実行・IO・lockは経過時間やHEAD不在で解放しない。同じコマンドの再実行でも、古い書き手が残る可能性があれば停止したままにする。

## 通常deployはドメインから独立させる

`prepareCompatibleM6WorkerUpload`の「Custom Domainが1件でもあれば拒否」は未提供機能用の制限であり、今回解除する。別のdomain専用deployは作らない。

- 現在は`migrationWorkerPath`にも`public_base_url`をworkers.devへ限定する条件があり、1行の拒否だけを消すと独自URLで失敗する。通常deployのREST対象はaccount/worker identityで決め、公開URLのhostnameから分離する。旧形式変換・新規initの制約まで一律に緩めない。
- 同じ既存deployでCustom Domain・正規URL・workers.dev有効化を保持し、更新前後に接続先を確認する。停止、所有者、version、receipt、runtime検証は既存のまま使う。
- 既存workspaceの`init`は新規リソース専用というM6仕様を維持する。独自ドメイン保持のために既存リソースを再初期化・採用しない。

## DNS・TLSと利用者への案内

- 対象accountのActive/full Cloudflare Zoneを必須とする。Route 53等を権威DNSのまま使う方式は扱わず、登録事業者の移管自体は要求しない。
- DNS/TLSはWorkers Custom Domainsに任せる。A/AAAA/CNAME/NSや既存の別サービス経路を勝手に上書きしない。対象hostだけを操作し、www/apexのaliasやredirectは追加しない。
- Cloudflare一次資料ではCustom Domain用証明書に別のAdvanced Certificate Manager契約は不要。実環境の権限・Freeプランでの動作は検証して案内し、有料プラン変更はしない。Detach後に残る証明書の手動整理も案内する。
- Podcast directoryの登録URL変更は管理者が行う。HTTP redirect、`itunes:new-feed-url`、購読先の自動変更保証は今回含めない。
- 操作には既存のCloudflare account/API tokenと管理鍵を使う。配布バイナリ以外のBun/Node.js/npm/WranglerやR2 S3 credentialsは要求しない。

## 開発順・受け入れ

1. 共通管理URLの解決と通常deployの拒否解除・接続保持を実装する。既存設定を読めるstrict schemaと、変更箇所のテストを追加する。
2. 共通admissionを最小限拡張し、同じ正規URL変更処理でadd/remove、feed/cache/設定の収束・再開を実装する。ファイル保存・lock・feed選別・purgeの重複を作らない。
3. domain CLIを接続し、TLS待ち、API応答喪失、feed/purge失敗、設定片側更新からの再開と、早すぎるresume/deployの拒否を変更箇所で検証する。既存のM6全安全条件を別のテスト群へ複製しない。
4. 承認された専用hostnameとM6サービスで、単一バイナリによるadd→明示再開→公開・停止/restore→通常deploy→remove→明示再開を確認し、READMEを更新する。

実機では複数Show、非公開/削除Episodeの不復活、両hostのfeed/cover/audio、GET/HEAD/Range、cache purge、GUID・媒体・revision不変を確認する。300 MB uploadの既存受け入れは再利用し、URL切替で音源再uploadやWorker全量hash計算は追加しない。

add/removeの完了は接続/TLS、全対象feed・purge、R2/ローカル設定の収束と記録を意味し、配信再開とは区別する。pause中の公開停止とprivate領域の非公開を維持し、未知のIOがある状態で完了・再開を報告しない。

既存の公開サービス・DNS・未知のownerを持つ試験環境は変更しない。実機の対象hostname指定はその段階で求め、ローカル実装を止める理由にはしない。

## 参照

- [実装ログ](./custom_domain_implementation_log.md) — M6先行前の履歴と今回の確認。
- [M6通常更新](./m6_compatible_updates.md) / [M6公開状態](./m6_content_lifecycle_plan.md) — 既存の停止・所有者・配信条件。
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) / [Workers Domains API](https://developers.cloudflare.com/api/resources/workers/subresources/domains/) — 接続・DNS/TLS・証明書。
- [Cloudflare DNS full setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/) / [partial setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/) — 権威DNSの前提。
