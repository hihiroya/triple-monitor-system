# 通知途中の停止と状態チェックポイント

この修正は #50 の状態ブランチ分離と独立して、最新mainを基に実装する。状態の保存先・通知対象・既読判定・workflow・リポジトリ設定は変更しない。実通知、既読状態の手動変更、PRマージ、監視移行は実施していない。

## 10月5日の調査結果

Tourism run [37324667308](https://github.com/hihiroya/triple-monitor-system/actions/runs/37324667308) は2026-10-05 14:26:26 UTCに監視を開始した。最初のwalkerplus-kanto-art-eventsで14:26:28にnewItems=23を記録し、その後のsource完了・通知成功・状態保存ログなしに14:36:21にキャンセルされた。workflowのtimeout-minutes: 10と時刻が整合するが、キャンセル主体や通知処理が長引いた原因はログから確定できない。

保存ActionはNo state changes.として成功した。従来は各通知成功後にメモリだけ更新し、全source処理後にファイルへ保存するため、途中でプロセスが停止すると通知済み分がファイルへ届かない。通知ごとのログもないので、実際に何件通知したかは不明。Discord通知履歴未確認の項目を既読にしてはならない。

通信・待機の現状（今回変更しない）:

- fetchWithTimeoutの既定20秒はfetchが応答ヘッダーを返すまで。finallyでタイマーを解除するため、response.text/jsonなど本文取得全体の上限にはならない。
- Discordの429は最大3回試行（追加2回）。数値秒または日時のRetry-Afterを尊重するが、待機時間上限・1通知の総時間上限はない。テスト用の待機時間overrideにも上限はない。
- HTTP429以外のエラー・通信失敗はDiscord内で再試行しない。
- Tourism全jobには10分の上限がある。23件の逐次通知には、各要求の待機・本文取得・429待機が累積する可能性がある。

10月5日のHTTPステータス、Retry-After、応答本文取得時間の証拠はないため、429や通信停止を原因と断定しない。原因は不明。今後の別修正では、本文取得までを含む通信期限と1通知の総時間予算を設け、予算を超えるRetry-Afterは早く再送せず今回の通知を失敗にする設計が望ましい。

## 最小修正

本番runMainからrunSourceへsaveStateをチェックポイントとして渡す。一覧通知は1件の通知が成功し、その項目だけを既読に反映した直後、次の通知へ進む前にawaitしてファイル保存する。version通知も成功後に同様に保存する。一覧型sourceの初回baselineを除き、既存履歴と通知成功したIDだけを保持する。全通知成功後や新着なしの場合に、取得一覧全体で既読履歴・lastSeenItemIdを上書きしない。初回の通知なしbaselineやsource終了時の最終保存も維持する。

保存は同じディレクトリの一時ファイルに全JSONを書き、flushしてからrenameする。途中書き込みで元のJSONを破壊しない。チェックポイント保存の例外は通常のsource失敗に変換せずrunMainまで伝播し、後続通知・後続sourceを停止する。直前までの正常ファイルを残す。

通知後のファイル保存前に停止する短い窓や、通知自体の成功応答喪失は依然残る。通知とファイルはトランザクションではなく、完全なexactly-onceにはならない。またrunnerそのものが消失した場合はローカルファイルも回収できない。既存のalways保存Action、#50反映後の状態保存・復旧artifactで回収する前提であり、#50の分離や初期化をこの修正で実施するものではない。

## 検証

実通信なしで、1件目成功後・2件目失敗、初回通知失敗、チェックポイント保存失敗による後続通知停止、version通知の保存を確認する。compiled CLIと同じrunnerを子プロセスで起動し、2件目の通信中に強制終了して、ディスクに1件目だけが残り未通知2件目は既読にならないことを確認する。通知履歴の確認・運用中状態の復旧は未実施。

## #50との一時ブランチ統合検証

#51の723a240a2818bcb35917fd466a726c7752619167と#50のed1ff357f299c8f0dcd46504f775aca6c7ecb563を一時ブランチで統合し、競合なし・追加の実装修正不要を確認した。[検証コード](https://github.com/hihiroya/triple-monitor-system/blob/7d60a532cf0930078c318da2abcd0dfb21374a08/tests/checkpoints-state-branch.integration.test.ts)は運用mainとは別のブランチに保存した。

Node 24.19.0 / npm 11.15.0でnpm run check成功（18ファイル・162テスト、型検査・ビルド・設定検証・lint・knip・coverage・整形）。一時bare remoteを使い、実通知なしで以下を確認した。

- 1件目成功後、2件目を開始する前にcheckpoint JSONが保存済み。後続通知が失敗しrunMainがexitCode=1でも、Actionと同じcompiled save CLIを実行して1件目だけをmonitor-stateへ保存できる。mainと他の状態ファイルは不変。
- 実際のrename失敗を発生させ、後続通知・後続sourceが停止する。別テストでは以前の正常checkpointを保持し、保存失敗を致命的エラーとして伝播することを確認。
- remoteのpre-receive hookでpushを拒否し、3回後にsave CLIが失敗する。成功済み状態、取得時baseline、branch/statePath/stateCommit/baseBlob/codeCommitのprovenanceがすべて残る。
- composite Actionの失敗時条件、hidden filesを含む設定、欠落時エラー、30日保持を確認し、実際のpath入力3ファイルをローカルartifact捕捉先へコピーして内容を照合。未通知2件目は既読にならない。

GitHub Actionsでの本物のartifactアップロード・ダウンロード、GITHUB_TOKENによる状態push、キャンセル時のAction実行・runner消失時の回収は未検証。ローカル入力捕捉を実アップロード成功として扱わない。通知成功とファイル保存の間に停止する短い窓も残る。過去の既読状態・通知履歴の復旧、実通知、workflow設定変更、PRマージ、状態移行、#49有効化は実施しない。

## 別修正候補: 通信期限と429の待機予算

このPRでは通信・再試行の挙動を変更しない。次の値は別PRで検証する初期案であり、10月5日の原因を示すものではない。

1. 本文読み取りまで含む1要求20秒の期限: fetchWithTimeoutでResponseだけを返す方式から、Response消費callbackを期限内でawaitする共通処理にする。headers取得、text/json、エラー本文の読み取りまでAbortControllerを維持する。期限超過でstreamを停止し、未使用本文もcancelする。上位の停止signalも合成する。
2. Discordの1通知に総時間90秒、429は従来どおり最大3試行、1回の待機許容量30秒を設ける。Retry-Afterが待機許容量・残り予算を超える場合は今回を失敗にし、指定時間より早く再送しない。各要求期限を残り予算以下にし、単調時計で期限を計算する。テストoverrideも同じ予算内に制限する。
3. HTTP成功応答の喪失・通信timeoutを自動再送する範囲は広げない。通知の成否が不明な通信障害で重複送信しない。未確認の通知を既読にはしない。
4. source key、試行番号、HTTP status、経過時間、採用した待機時間、期限超過を秘密情報なしで記録する。停止した本文stream、数値/日付形式のRetry-After、巨大値・不正値、3試行の上限、総時間切れをfake timersとローカルHTTP fixtureで検証する。

これらは1要求・1通知の期限であり、複数通知を合計した全jobの10分上限を保証するものではない。必要なら別途run全体の通知予算も設計し、期限到達前に今回のcheckpointを保存して終了させる。
