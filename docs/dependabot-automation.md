# Dependabot運用

## 更新グループ

weekly、npmのcooldown（major 30日、minor 14日、patch 7日）、各ecosystemのPR上限5件を維持する。

| 更新                                      | version updates         | security updates                 |
| ----------------------------------------- | ----------------------- | -------------------------------- |
| vitest / @vitest/* の開発依存minor・patch | vitest-minor-patch      | vitest-security-minor-patch      |
| vitest / @vitest/* の開発依存major        | vitest-major            | 個別、手動レビュー               |
| その他の開発依存minor・patch              | development-minor-patch | development-security-minor-patch |
| その他のmajor・本番依存・GitHub Actions   | 個別、手動レビュー      | 個別、手動レビュー               |

security updatesは`applies-to: security-updates`で独立して定義する。version updatesのグループに混ぜず、majorや本番依存の修正を自動マージ対象に広げない。cooldownはsecurity updatesの待機期間として扱わない。Dependabotサービスによるsecurity PRの実際の生成・グループ化は、マージ後のイベントで確認する。

## 自動マージの対象と安全性

`pull_request_target`で、同一リポジトリのDependabot作成PR・main宛て・非draftだけを対象とする。書き込みjobはcheckoutせず、PRのコード、npmスクリプト、依存のinstall scriptを実行しない。外部Actionは上流タグと署名済みコミットを確認した完全なSHAで固定する。

`dependabot/fetch-metadata`の作成者・署名検証を維持し、`updated-dependencies-json`を全件検査する。npmのルートディレクトリの開発依存minor・patch以外、majorや本番依存を含むグループ、情報不足のPRを除外する。indirect更新も実際のlockfileがdev専用の場合だけ対象とする。

APIからimmutable SHAのmanifestとlockfileをJSONデータとして読み、以下も確認する。

- 変更ファイルは既存のpackage.jsonとpackage-lock.jsonだけ。追加・削除・renameは禁止。
- package.jsonの変更は既存devDependenciesの安定版minor・patchだけ。scripts、本番依存、依存の追加・削除、その他の設定変更は禁止。
- lockfileの本番依存・本番と共有する依存の変更は禁止。dev専用の推移依存でもmajor、prerelease、downgradeは手動レビュー。
- 更新された依存はnpm公式registryのtarballとsha512 integrityを必要とする。
- APIエラー、metadataとの不一致、古いイベントSHAは自動マージを有効化しない。

条件を満たしたPRに`gh pr merge --auto --squash --match-head-commit`を使用する。`--admin`、自動承認、保護設定の変更は行わない。headが変わった場合はコマンドが拒否し、新しいイベントで再判定する。

既知の最新quality失敗・cancel・skipでは有効化しない。CIがpendingならauto-mergeを予約できるが、実際のマージはGitHubの必須チェック・最新mainへの追従・レビューなど既存の保護要件を満たすまで待つ。CIが後で失敗すればマージされない。自動マージを予約した後に他の要件を省略する処理はない。

既存Quality Checkのaudit、ignore-scripts、npm 11.15.0、.npmrcのインストール元制限を変更しない。

## 必要なリポジトリ設定（このPRでは変更しない）

2026-10-06の読み取り確認結果：Allow auto-mergeは無効、squash mergeは有効。ruleset一覧とmainの有効ルール一覧は空。mainのclassic branch protectionは404（未設定）。実際のQuality Check jobのチェック名は`quality`、提供AppはGitHub Actions（App ID 15368）。workflow表示名`Quality Check`を必須チェック名として登録しない。

有効化前に以下を設定する。workflowも設定不足を確認して自動マージを停止する。

1. Settings → General → Pull Requestsで**Allow auto-merge**を有効にする。squash mergeを維持する。
2. Settings → Rules → Rulesetsで、branch対象`refs/heads/main`、enforcement **Active**のrulesetを追加する。
3. **Require a pull request before merging**と**Require status checks to pass**を有効にする。必須チェックを`quality`、提供元をGitHub Actionsに限定する（REST表現は`context: quality`、`integration_id: 15368`）。
4. **Require branches to be up to date before merging**を有効にする（`strict_required_status_checks_policy: true`）。最新mainに対するテスト成功を要求する。古いbaseの成功だけではマージさせない。
5. GitHub Actions／Dependabot／管理者をbypass actorに追加しない。既存の保護設定が後から追加されていた場合は、レビュー・署名・会話解決・force push／削除制限などを削除せず、必要項目だけ追加する。

classic branch protectionを使う場合はmainを対象に、`required_status_checks.strict: true`、`checks: [{ context: quality, app_id: 15368 }]`を設定し、PR経由のマージ、管理者を含む保護、bypass禁止を維持する。workflowはstrictかつAppを限定したrulesetまたはclassic protectionを確認する。設定の確認APIをGITHUB_TOKENで読めない場合も停止するため、実イベントで権限を確認する。

mainが更新されてPRがbehindになった場合はDependabotのrebaseまたは手動のbranch更新が必要。strict要件を緩和して対応しない。merge queueの導入や専用App/PATの追加はこのPRの対象外。

## 検証と未検証事項

`tests/dependabot-auto-merge.test.ts`はworkflowに埋め込まれた実際の判定scriptを読み、APIとmetadataをモックして実行する。通常PR、fork、major／本番依存が混ざるグループ、CI失敗、チェック保護不足、設定無効、余分なファイル、lockfileの本番依存・major変更などの除外条件を確認する。

実際のDependabotイベント、グループmetadata、署名検証Action、GITHUB_TOKENでの保護API参照、auto-merge予約とCI失敗時の待機、main更新後のstrict enforcement、security updatesの生成は未検証。今回の通常PRでQuality Checkとactionlintは確認するが、新しいworkflow自体はmainへのマージ後に初めて利用可能になる。実運用ではまず適格なDependabot PRでこれらを確認する。

#46のTypeScript 7移行は保留し、この設定変更でマージ・クローズ・無視指定を行わない。

参考：[Dependabot設定](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)、[Dependabot自動化](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automate-dependabot-with-actions)、[fetch-metadata](https://github.com/dependabot/fetch-metadata)、[gh pr merge](https://cli.github.com/manual/gh_pr_merge)。
