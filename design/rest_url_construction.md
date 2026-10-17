# Cloudflare REST URLの構築

CLIのREST URLでは、account ID、bucket名、Worker名、version IDをそれぞれ`encodeURIComponent`でエンコードする。既存schemaの文字種・対象照合はそのまま維持し、エンコードを入力検証の代わりにしない。

R2 object keyは未エンコードの文字列を受け取り、`/`で分割した各要素だけをエンコードして再結合する。[Upload Objectの仕様](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/upload/)に従い、区切りの`/`を`%2F`へ置換しない。文字列として含まれる`%2F`は`%252F`になり、既存のエスケープ表現として解釈しない。

`putVerifiedR2Object`のPUTと検証GETには同じURLを使い、応答receiptのkeyは元の未エンコードkeyと照合する。管理GETも同じ要素単位の方式を使用する。CLIが生成する固定key、サイズ・SHA-256・ETag/versionの検証、単一PUT、未知の結果の自動再送禁止は変更しない。

ローカル回帰テストでは通常key、深い階層、空白・予約文字、文字列としてのpercent escape、UTF-8を検証する。これはURL構築と既存フローの検証であり、実Cloudflareでの受け入れ結果や切断後のPUT取消保証ではない。
