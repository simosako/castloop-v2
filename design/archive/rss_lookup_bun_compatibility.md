# RSS取得のDNS lookupとBunの互換性（Issue #32）

## 2026-10-18の結論

[Issue #32](https://github.com/simosako/castloop-v2/issues/32)の調査対象は現行v0.6.0にも残っている。Queue公開の削除とは独立したローカルdownload処理であり、調査は有効だった。

対応するBun 1.4.2/Linux x86-64で調べた結果、**現行の明示family 4/6ではcallback形式の不一致を再現しなかった**。本番コードの修正や通常DNSへのfallbackは追加しない。不具合・SSRF脆弱性が確認されたという結果ではない。

未検証範囲を明記した[調査結果](https://github.com/simosako/castloop-v2/issues/32#issuecomment-6248625218)を追記し、Issue #32は対応不要（not planned）としてクローズした。当初の完了条件をすべて実施済みにしたという意味ではない。

family省略または0で`autoSelectFamily: true`を指定した比較条件では、`all: true`と単一IP形式のcallbackの組み合わせにより`ERR_INVALID_IP_ADDRESS`を再現した。同じ条件で配列形式を返すと成功した。これは現行経路のbugではなく、将来family指定を変更するときに再評価すべき条件である。

## 固定した条件と観測方法

- checkout: `a500ba5f9c1d04896fadb22ea5eb35a1a0636514`。`packages/cli/src/rss-import-download.ts`はIssueの一次調査時点（`862c8ddf845914b32057d3b55d9b55614c33e38a`）と同一。
- Bun: `1.4.2`、revision `744846f844374847c902b5e7fd59b4342a51ef99`。Linux x86-64。ビルドCIの固定版と一致する。
- fixture: [`scripts/test-support/rss-lookup-probe.ts`](../../scripts/test-support/rss-lookup-probe.ts)。Bunソース実行と`bun-linux-x64` compile実行を比較。compileは正式ビルドと同じ`env: "disable"`、`autoloadDotenv: false`、`autoloadBunfig: false`を指定。
- HTTP/HTTPSサーバーは`127.0.0.1`と`::1`の一時portだけにbind。`.invalid`のhostnameを指定IPへ固定する。外部のfeed、DNSサーバー、Cloudflareサービスは使わない。
- 観測用requestは本番のmethod、agent、family、lookupの単一IP返却、headers、signal、timeout、maxHeaderSizeを再現し、lookup引数の`hostname`/`family`/`all`/`hints`を記録する。比較条件だけfamily、autoSelectFamily、callback形式を変える。mockではなくnative HTTP/HTTPSを通す。
- **本番transport自体のlookup引数に計測hookを追加したわけではない**。別途、importした実際の`defaultRssAssetTransport.request`でも4組み合わせの接続・本文を検証する。
- HTTPSはOpenSSL 3.0.13で生成したテスト用の自己署名証明書（SAN: `does-not-exist.invalid`）を`NODE_EXTRA_CA_CERTS`で信頼する。証明書検証は無効化しない。正しいhostnameでの成功と、同じIPに接続したhostname不一致での拒否を確認する。
- 全成功ケースで本文、元のHost header、接続先IP、HTTPSのSNIを照合し、管理認証header/cookieが送られていないことを確認する。

## 結果

下表はIPv4/IPv6 × HTTP/HTTPSのすべてに共通。ソースとcompile実行で同じ結果だった。`all`の「未指定」はJSON出力では`null`として保存している。

| request条件 | lookupのfamily / all / hints | callback | 接続結果 |
| --- | --- | --- | --- |
| 現行: family 4/6、autoSelectFamily既定 | 4/6 / 未指定 / 0 | 単一IP | 成功 |
| family 4/6、autoSelectFamily true | 4/6 / 未指定 / 0 | 単一IP | 成功 |
| family省略、autoSelectFamily true | 未指定 / true / 32 | 単一IP | `ERR_INVALID_IP_ADDRESS` |
| family省略、autoSelectFamily true | 未指定 / true / 32 | 配列 | 成功 |
| family 0、autoSelectFamily true | 0 / true / 32 | 単一IP | `ERR_INVALID_IP_ADDRESS` |
| family 0、autoSelectFamily true | 0 / true / 32 | 配列 | 成功 |

各実行は観測用24ケース、本番transport成功4ケース、本番transportのTLS hostname不一致拒否2ケースの計30件。比較条件の8失敗は意図した再現であり、fixture全体の失敗ではない。

compileしたfixtureは`env -i PATH=/nonexistent`でも成功し、実行時に外部のBun/Node.jsを使っていない。ソースとcompileのJSONは`cmp`で完全一致した。両出力のSHA-256は`20931dea4031b58e1168f91c927cf0b8e9be6e47d9002e23a3ba62a82fa36f34`。

既存の検証も成功した。

- `bun test packages/cli/src/rss-import-download.test.ts`: 5 pass / 0 fail、53 expects。
- `bun test`: 439 pass / 0 fail、5931 expects、56 files。
- `npm run check`: 成功。

## 検証の境界と安全条件

- これは本番transportを含む最小fixtureのcompile試験であり、正式配布CLIの`import-rss`を実行した受け入れ試験ではない。「配布CLIまで確認」は未実施のまま区別し、現行条件では追加対応不要と判断して調査を終了した。
- fixtureは低層transportを直接呼ぶ。公開URLの検証を通してloopbackや一時portを許したわけではない。fixture URLが`validateRssSourceUrl`で拒否されることも確認する。
- DNS解決段階の`lookup(hostname, { all: true })`と、接続時にruntimeが独自lookupへ渡す`all`は別物。現行は`receiveRssAsset`が全候補のpublic IPとfamily整合性を検証してから、選択したfamily 4/6を接続時にも指定する。
- public IP検証、DNS pinning、TLS hostname検証、redirect再検証、HTTPS downgrade拒否、サイズ/timeout制限は一切変更していない。redirectやサイズ制限のnative全組み合わせを今回新たに測定したという意味ではない。
- 他のBun revision、OS、正式配布artifact、公開ネットワークでの取り込み全体の成功は保証しない。Bun更新、family指定、agent、transportを変更する場合は再調査する。
- 本番操作、公開、配備、Cloudflare資源の変更は行っていない。テストCAを管理者の通常環境へ設定する運用変更も不要。

## 再現手順

開発機でBun 1.4.2、OpenSSL、IPv4/IPv6 loopbackを使用する。通常の`bun test`には追加せず、調査用の手動fixtureとして保持する。証明書は毎回生成するため、有効期限が固定された秘密鍵をリポジトリに置かない。

```sh
probeDirectory=$(mktemp -d /tmp/opencode/rss-lookup-32-XXXXXX)
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj /CN=does-not-exist.invalid \
  -addext subjectAltName=DNS:does-not-exist.invalid \
  -keyout "$probeDirectory/key.pem" -out "$probeDirectory/cert.pem"

NODE_EXTRA_CA_CERTS="$probeDirectory/cert.pem" \
  bun scripts/test-support/rss-lookup-probe.ts "$probeDirectory" > "$probeDirectory/source.json"

PROBE_OUTFILE="$probeDirectory/probe" bun -e '
  const outfile = process.env.PROBE_OUTFILE;
  if (!outfile) throw new Error("Missing probe output path");
  const result = await Bun.build({
    entrypoints: ["scripts/test-support/rss-lookup-probe.ts"],
    compile: { target: "bun-linux-x64", outfile,
      autoloadDotenv: false, autoloadBunfig: false },
    env: "disable",
  });
  if (!result.success) throw new AggregateError(result.logs, "Probe build failed");
'

env -i PATH=/nonexistent NODE_EXTRA_CA_CERTS="$probeDirectory/cert.pem" \
  "$probeDirectory/probe" "$probeDirectory" > "$probeDirectory/compiled.json"
cmp "$probeDirectory/source.json" "$probeDirectory/compiled.json"
sha256sum "$probeDirectory/source.json" "$probeDirectory/compiled.json"
```
