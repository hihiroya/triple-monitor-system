# 監視状態をmainから分離する設計

## 対象と不変条件

RSS、X/Twitter、X profile、Notion、Public Site、Tourismの6workflowを対象にする。コード・設定・ローカルActionはmainから取得し、実行時の既読状態だけを専用のmonitor-stateブランチから読み書きする。監視処理はmainへpushせず、mainの保護のbypassも不要。

| 状態                                               | 保存パス                 | 同時実行group         |
| -------------------------------------------------- | ------------------------ | --------------------- |
| RSS / X/Twitter / X profile / Notion / Public Site | state/default-state.json | default-monitor-state |
| Tourism                                            | state/tourism-state.json | tourism-monitor-state |

既存のschedule、group名、cancel-in-progress=false、保存パス、source key、lastSeenItemId / seenItemIds / lastSeenVersion、通知成功後だけ状態を進める処理を維持する。共有default-stateの取得→監視→保存は既存groupで直列化し、別ファイルのtourismは並行実行できる。GitHub concurrencyの既存pending置換動作も変更しない。

monitor-stateは初期化時に2つの状態JSONだけを持つ独立したroot commitとして作る。コード、設定、workflowは含めない。状態ブランチをcheckout・実行せず、main側のプログラムがGit blobをJSONとして検証してコピーする。

## 取得と検証

1. 監視workflowはmainを明示checkoutし、Node 24 / npm 11.15.0 / npm ci --ignore-scriptsでビルドする。main以外を選んだ手動dispatchは監視jobを実行しない。
2. load-monitor-stateがmonitor-stateを必須fetchし、対象ファイルが通常ファイルかつ正しいJSON状態形式であることを確認して、既存のstateパスへ読み込む。
3. 取得時のblob SHA・state commit・main code commitと取得時JSONを回復用のローカルファイルに記録する。
4. mainの設定と読み込んだ実行時状態をvalidate:configで検証してから監視する。MONITOR_REQUIRE_STATE=trueでファイル欠落もエラーにする。

ブランチ未作成、fetchの認証・通信失敗、ファイル欠落・symlink・壊れたJSONは監視前に失敗する。mainの古い状態や空状態へのfallbackはない。load失敗時に保存Actionも実行しない。

main上のstate/*.jsonは移行用スナップショットとして残し、監視から更新しない。Quality CheckはPR/mainの設定と両スナップショットを必須検証するため、外部ブランチの可用性でPRのCIが不安定にならない。実行時はmainの最新コードで状態ブランチのJSONも別途検証する。将来のスキーマ変更ではスナップショットと実行時状態の互換性を維持する。移行後の復旧・再作成に古いmainスナップショットを使わない。

## 保存と競合

commit-monitor-stateはmainの作業用indexやHEADを変更しない。別の一時indexで最新monitor-stateのtreeに対象の1ファイルだけを載せ、parent付きcommitを作って、明示的なrefs/heads/monitor-stateだけに通常のfast-forward pushを行う。force push、mainへのpush、git pull --rebaseは使わない。

- 変化がなければcommitしない。
- 保存前とpush再試行時にremoteを再取得する。他のパスだけが更新されていればその最新treeを引き継ぐ。
- 同じファイルのremote blobが取得時baselineから変わっていれば、通知済み状態を上書きせず失敗する。JSONの自動unionでversionの巻き戻りや重複を隠さない。
- fetchからpushまでの競合はnon-fast-forward拒否後に再取得・再構築する。最大3回まで。通知は再実行しない。
- remoteが更新後JSONと一致する場合は、push成功後の通信応答喪失も含めて保存済みとして扱う。

一部sourceの監視が失敗しても、成功済み通知の状態を保存する既存挙動を維持する。状態取得が成功し、監視stepが実行された場合だけ保存する。

## 保存失敗と回復

保存失敗ではjobを成功扱いにしない。更新後JSON、取得時JSON、取得時commit/blobとcode commitをmonitor-state-recovery-<run_id>-<attempt> artifactに30日保存する。アップロードActionは検証した完全なcommit SHAで固定する。artifact保存自体も失敗する可能性があるため、成功を確認する。

Discord通知とGitへの保存は分散した処理であり、完全なexactly-onceは保証できない。通知成功後に保存できなかった場合、次回の監視はremoteにある古い状態を読むので重複通知の可能性がある。これは既存の保存失敗時にもある制約で、状態を空にする・通知を再実行する・成功扱いにする対応は行わない。

失敗を確認した運用者は、該当状態を共有するworkflowを停止し、実行中・pendingのrunも終了させる。artifactのbaselineと更新後JSON、最新remoteを比較して成功済み通知分を保全し、monitor-stateの対象ファイルだけを通常のfast-forward更新で復旧する。異なるrunの状態をblindに上書きしない。branch保護をbypassしたりmainへ保存したりしない。復旧確認後に監視を再開する。Gitのpush不能時にGit自体へ障害フラグを保存することはできないため、この最小構成には次のscheduleを自動停止する別の永続制御基盤は含めない。

## 将来の移行手順（今回は実施しない）

このPRの作成時にはmonitor-stateを作成せず、workflowの実運用先も変更しない。別途承認された移行作業で以下を実施する。

1. 6監視workflowを停止し、旧コードによるmain保存runが全て完了したことを確認する。監視失敗や保存失敗の回復も先に済ませる。
2. このPRをマージし、mainのQuality Check成功を確認する。monitor-state未作成のまま監視を再開しない。
3. mainからInitialize monitor stateを手動実行し、monitors-paused=trueで停止確認する。workflow自身も6workflowのdisabled_manuallyとactive runなしをAPIで確認する。
4. 初期化処理は実行時に最新mainをfetchし、当時の2つの状態JSONをbyte単位で引き継ぐ。PR作成時のスナップショットは固定しない。mainが読み取り中に動いた場合は停止して再試行する。
5. 既存monitor-stateがあれば初期化は拒否する。同時に別プロセスが作成した場合もroot commitのnon-fast-forward push拒否で上書きしない。認証・通信・push失敗でも監視は停止したままにする。
6. 初期stateのblobがコピー元mainと一致すること、ブランチにJSON2ファイルだけがあることを確認し、6監視workflowを再開する。
7. 各workflowの取得・通知・保存が成功し、mainへ状態pushされないことを確認してから、PR #49のAllow auto-mergeとmainの必須quality / strict / bypassなし設定を有効化する。monitor-stateのためにmain保護を緩めない。新しいmain rulesetの対象はmainのみとし、状態ブランチへPR/quality要件を誤適用しない。

状態JSONの共有・通知ロジックはこのPRでは変更しない。状態ブランチへの手動変更は監視停止中に限定する。

## 検証範囲

一時的なローカルbare remoteと2つのcloneを使い、最新mainからの初期化、JSONだけのroot history、main不変、取得失敗、状態破損・欠落、同一ファイル競合、別ファイル競合、push拒否の有限再試行、保存済み判定、Actionが使うcompiled CLIを検証する。既存の通知成功後だけ状態を進めるテスト、必須state欠落でsourceを実行しないテスト、全監視workflowのロード・検証・保存条件を確認する。

実リポジトリでの初期化dispatch、状態ブランチの作成、実通知、GitHub上の競合、GITHUB_TOKENのpush、失敗artifactのアップロードは未実施。今回は関連テストとQuality Checkのみを実行し、リポジトリ設定・PRマージ・稼働先の切り替えは行わない。#46は保留のまま維持する。
