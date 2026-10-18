# 管理者キーの照合

現行SQLite方式のHTTP管理APIは、従来どおり`X-Castloop-Key`の管理者キーで認証する。CLIの送信形式、秘密鍵の保存形式・更新手順、各routeの401応答は変更しない。v0.5.xのQueue/R2方式も同じHTTP認証を使ったが、v0.6.0以降のコードから旧管理routeは削除した。

`src/admin-auth.ts`は受信値と設定値のUTF-8をSHA-256で32 bytesへそろえ、Workersでは[`crypto.subtle.timingSafeEqual`](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal)で比較する。受信値の長さ不一致や先頭文字の一致で比較を打ち切らず、空の設定鍵は必ず拒否する。

Workers固有の比較APIがない標準Web Crypto環境（Bunのローカルテストを含む）では、照合ごとに非exportableな一時HMAC-SHA-256鍵を生成し、設定値のdigestに署名、受信値のdigestを`crypto.subtle.verify`で検証する。固定長の比較をネイティブ検証へ委ね、JSのXORループや通常の文字列比較へfallbackしない。一時鍵・digest・署名は保存・応答・ログ出力しない。Node.js互換flagや新しい依存関係も追加しない。

認証は非同期なので、全呼び出し元は結果を`await`し、認証の成功前にリクエストbodyやR2/SQLiteの管理処理へ進まない。暗号処理の失敗時は拒否し、診断は固定のevent/reason codeだけに制限する。public配信は別の最新状態gateを維持する。旧domain runtime probeとQueue署名protocolは現行コードに残さない。

ローカルテストでは一致・不一致・長さ違い・空鍵・暗号処理失敗と、Workers拡張の呼び出し境界および標準HMAC検証経路を確認する。Workers拡張の境界テストはNode.jsのネイティブ比較をadapterとして使い、実Workers内のタイミング耐性・CPUやFree適合を実証したものとは扱わない。
