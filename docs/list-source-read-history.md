# 一覧型sourceの既読更新とTourism復旧案

## 既読更新の修正

従来は通知成功ごとのcheckpointの後、source正常終了時に取得一覧全体を履歴へ取り込み、lastSeenItemIdを一覧先頭に上書きしていた。新着なしの場合も同様で、通知していない項目が既読へ追加される可能性があった。

初回baselineでは従来どおり通知せず、取得一覧の先頭IDと最大100件のIDを保存する。2回目以降は取得や正常終了だけでは状態を更新しない。通知成功後にそのIDだけを既存履歴へ追加し、lastSeenItemIdもその成功IDへ進め、checkpointを保存する。既存履歴が取得一覧から消えていても保持し、重複排除と100件上限は維持する。通知失敗した項目や既読範囲より古い未通知項目は追加しない。新着なしの場合はlastSeenItemIdを含め状態をそのまま維持する。

RSS、公開HTML一覧、X profileは同じ一覧処理を使う。既読の間に挟まった新着、X profileとYouTube RSSの取得窓落ち復旧の通知判定は変更しない。lastSeenItemIdは一覧先頭ではなく最後に通知成功したIDになり得るが、既読判定はそのIDとseenItemIdsの統合履歴で行う。通知成功分だけを保持するため、通知済みか確認できない古い項目が後の取得順変更で新着範囲へ入れば通知される可能性はある。

## 現在のTourism状態（2026-10-06確認）

[run 37427241198](https://github.com/hihiroya/triple-monitor-system/actions/runs/37427241198)は33件の通知に成功した後、EnjoyTokyoとartscapeの429待機予算超過、およびSciencePortalの既読履歴と取得結果の非交差で失敗した。成功通知分は[monitor-stateの6799555](https://github.com/hihiroya/triple-monitor-system/commit/6799555f77047ec4df345aa915cf45b82ce2e4c1)に保存済み。Tourismは無効のまま。このPRは運用状態を変更しない。

### Walkerの7項目

lastSeenItemIdは`https://www.walkerplus.com/event/ar0313e564201/`、保存済み履歴は100件。正常終了時の旧処理で、今回のrunでは通知成功が記録されていない次の7項目も追加された。過去の通知履歴は未確認だが、個人用途として今回はそのまま保持する方針であり、削除や再通知は行わない。

- https://www.walkerplus.com/event/ar0313e616855/
- https://www.walkerplus.com/event/ar0313e611043/
- https://www.walkerplus.com/event/ar0313e515815/
- https://www.walkerplus.com/event/ar0313e575013/
- https://www.walkerplus.com/event/ar0314e600972/
- https://www.walkerplus.com/event/ar0314e601130/
- https://www.walkerplus.com/event/ar0313e612933/

### SciencePortalの復旧案（未実施）

保存済みlastSeenItemIdは`https://scienceportal.jst.go.jp/events/19531/`、履歴は97件。現在設定の取得専用関数で読み取った75件は先頭`19829`、末尾`19668`で、保存済み履歴との交差は0件だった。取得窓落ち・掲載終了・構造変更などのどれが原因かは、この情報だけでは断定しない。現行の安全停止を維持し、自動でbaselineを作り直す処理は追加しない。

再開案は、別途承認後にSciencePortalだけを現取得結果でbaselineし直すこと。**その時点で現在掲載中の記事は通知しない。過去の未通知記事も救済通知しない。** 今回確認した75件は参考値であり、実施時に再取得・確認した一覧を使用する。

承認後の手順案:

1. Tourismが無効で、queued・実行中runが残っていないことを確認する。
2. 最新monitor-stateのcommit SHA・tourism-state blob SHAとJSONを退避する。Walkerの7項目および他sourceの既読状態を保持する。
3. mainの現設定と取得専用関数でSciencePortalを取得し、一覧が非空でIDが妥当であることを確認する。通知処理を呼ばず、SciencePortalのlastSeenItemIdを先頭ID、seenItemIdsを現一覧の先頭100件以内へ置き換える。旧履歴は退避資料に残す。
4. 状態検証を行い、SciencePortal以外の差分がないことを確認する。取得時のprovenanceとblobを使った既存の状態保存処理でmonitor-stateだけへ保存し、競合・保存失敗時は停止して復旧資料を残す。mainへ状態pushしない。
5. 別途再開承認後に有効化し、次の新着だけを通知する。状態取得・checkpoint・保存結果を確認する。

このPRでは状態変更、マージ、実通知、Tourism再開を実施しない。429対象の直ちの再実行、待機上限の引き上げ、Notion・依存・保護設定・workflowの変更も行わない。
