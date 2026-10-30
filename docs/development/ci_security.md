# リリースCIのAction固定と更新

[ビルドワークフロー](../../.github/workflows/build-binaries.yml)の外部Actionは、完全な40桁commit SHAへ固定します。横の英語コメントは確認したrelease tagです。可変major tag・branch・短縮SHAは使いません。ビルド・配布全体は[リリース保守](releasing.md)を参照してください。

## 更新手順

1. リリース準備時に、各Actionの公式upstreamで互換releaseとsecurity告知を確認する。SHA固定では修正を自動取得しないため、固定後も確認が必要。
2. 公式repositoryのrelease tagが指すcommitを取得する。annotated tagならtag objectを辿ってcommitを確認し、forkのSHAを流用しない。release差分・`action.yml`・実行runtime・追加権限やdownload先をレビューする。
3. 同じActionを使うすべてのstepのSHAとversionコメントを同時に更新する。major更新・runner/Bun/Node変更は単なるSHA更新と区別してレビューする。
4. `bun test`と`npm run check`を行い、PRのbuild/smoke結果を確認する。SHA形式のローカルテストは、upstreamの真正性やAction内部の安全性の証明ではない。
5. 既定`contents: read`、tag push限定release jobの`contents: write`を維持する。Action更新のために権限・自動更新bot・release tagを追加しない。

SHA固定は更新を制御する仕組みであり、Action全依存の完全監査ではありません。Bun・Node、runner image、外部ダウンロードやnpm依存まで不変にはなりません。GitHub-hosted buildの成功を、ローカル検証の代用として扱わないでください。

公式案内: [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)。
