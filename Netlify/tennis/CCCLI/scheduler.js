
        // --- Constants & State ---
        const LS_KEY = 'interactiveDoublesDashboard_v2_17'; // Version up for new data structure
        const LS_KEY_EMPIRICAL_BEST = LS_KEY + '_empiricalBest'; // 条件ごとの実測ベストスコア
        const MAX_EMPIRICAL_ENTRIES = 30;
        const DEFAULT_MAX_CONSECUTIVE = 2;
        const JOIN_NOT_ARRIVED = 9999; // joinsに設定する「未到着（全試合不参加）」を表す十分大きい値


        const appState = {
            currentSurfaceCount: 1,
            currentTotalMemberCount: 0,
            maxConsecutiveLimit: DEFAULT_MAX_CONSECUTIVE,
            forcedInfinity: false,
            members: [],
            groups: {},
            exclusions: {},
            joins: {}, // 途中参加（{playerIdx: fromMatch} = fromMatch試合目「から」参加。exclusionsの逆）
            joinOffsets: {}, // 途中参加者の按分型公平性用オフセット（{playerIdx: offset}）。表示には使わず判定にのみ使用
            allPossiblePairs: [],
            matches: [],
            completedMatches: new Set(),
            favorites: [],
            dialogCallback: null,
            _pendingDialogScrollHandler: null, // ダイアログ確認ボタンに一時登録するスクロール用リスナー（未消費残留対策）
            charts: { cumulativePlayCountChart: null, memberProfileRadarChart: null },
            areAnalysisSectionsVisible: false,
            editingMatch: null,
            isRegeneratingAfterDropout: false,
            pairIdMap: {},
            pairColorMap: {},
            dataSource: null,
            editingFavoriteIndex: null,
            generationSettings: {},
            exportAfterSave: false,
            lastRunAnalysis: null,
            currentMemo: '',
            // ▼▼▼ Undo/Redo機能のために追加 ▼▼▼
            history: [],
            historyIndex: -1,
        };

        // ─── genderMix best-effortモード判定ヘルパー ──────────────────────────
        // 男女いずれかが全コート分以下の場合はbest-effortモード
        function isGenderMixBestEffort(groups, surfaces) {
            // 人数から自動判定（男女いずれかがコート数×2以下ならbest-effort）
            groups = groups || appState.groups || {};
            surfaces = surfaces || appState.currentSurfaceCount;
            const mCount = Object.keys(groups).filter(k => groups[k] === 'M').length;
            const fCount = Object.keys(groups).filter(k => groups[k] === 'F').length;
            return mCount <= surfaces * 2 || fCount <= surfaces * 2;
        }

        // ─── 出場可否の一元判定ヘルパー（離脱・途中参加を統合） ─────────────────
        // matchNumberは1-indexed（第1試合=1）。exclusions/joinsが未指定の場合は
        // appStateから読む（呼び出し元がsettings経由で明示的に渡すのが望ましい）。
        function isPlayerActive(playerIdx, matchNumber, exclusions, joins) {
            if (exclusions == null) exclusions = appState.exclusions;
            if (joins == null) joins = appState.joins;
            if (exclusions[playerIdx] && matchNumber >= exclusions[playerIdx]) return false;
            if (joins[playerIdx] && matchNumber < joins[playerIdx]) return false;
            return true;
        }

        // ─── 途中参加者の按分型公平性オフセット ──────────────────────────────
        // 遅れて参加した人は「参加した時点から他の人と同じペースで出場する」のが正しく、
        // 参加前の分を毎試合出場で取り戻す（追いつき型）のは意図しない挙動だった。
        // このオフセットをjoins対象者の累積プレイ数に仮想的に加算してから他メンバーと
        // 比較することで、按分型（参加後は同ペース、総数は参加が遅い分だけ少ない）にする。
        //
        // オフセット = 参加試合の直前時点までの総プレイ枠数を、その時点でアクティブな
        // メンバー数で割った理論値（四捨五入）。実際に生成された試合データではなく
        // 理論値を使うのは、生成結果に依存すると「公平性の判定基準」と「生成される結果」
        // が互いに影響し合う循環を避けるため。
        function calculateJoinOffset(playerIndex, fromMatch, exclusions, joins) {
            if (fromMatch <= 1) return 0;
            // 未到着(全試合不参加)にオフセットは無意味。fromMatch=9999のまま計算すると
            // 数千という巨大な値が保存・エクスポートされてしまうため0にする
            if (fromMatch === JOIN_NOT_ARRIVED) return 0;
            const surfaces = appState.currentSurfaceCount;
            const totalSlotsBeforeJoin = surfaces * 4 * (fromMatch - 1);
            const activeCount = Array.from({ length: appState.currentTotalMemberCount }, (_, i) => i)
                .filter(i => i !== playerIndex && isPlayerActive(i, fromMatch - 1, exclusions, joins)).length;
            if (activeCount <= 0) return 0;
            return Math.round(totalSlotsBeforeJoin / activeCount);
        }

        // 生成開始時にjoinsの全エントリについてjoinOffsetsを最新化する。
        // pushStateToHistory/saveStateは呼び出し元に任せる（副作用を持たない）。
        function recalculateAllJoinOffsets() {
            const newOffsets = {};
            Object.entries(appState.joins).forEach(([idxStr, fromMatch]) => {
                const idx = parseInt(idxStr, 10);
                newOffsets[idx] = calculateJoinOffset(idx, fromMatch, appState.exclusions, appState.joins);
            });
            appState.joinOffsets = newOffsets;
        }

        function updateJoinOffset(playerIndex, fromMatch) {
            appState.joinOffsets[playerIndex] = calculateJoinOffset(playerIndex, fromMatch, appState.exclusions, appState.joins);
        }

        // 上限スコア(calcConditionCeiling)用の実効メンバー数。
        // 未到着(全試合不参加)のメンバーはスケジュール上存在しないのと同じため、
        // 総メンバー数のまま計算すると上限・目標が実際より高く/低く見積もられる
        function getEffectiveMemberCountForCeiling() {
            const _notArr = Object.values(appState.joins || {}).filter(v => v === JOIN_NOT_ARRIVED).length;
            return Math.max(0, appState.currentTotalMemberCount - _notArr);
        }

        const LS_KEY_PW = LS_KEY + '_pw';
        const PENALTY_DEFAULTS = {
            maxPlayStreak:   40,   // 連続プレイ上限超過 (超過1につき)
            restHard:        80,   // 連続休憩超過 (超過1につき)
            restSoft:       120,   // 連続休憩ソフト (streak>1で固定加算)
            restVariance:    25,   // 連続休憩差・選手間 (差1超過につき)
            playVariance:   120,   // 連続プレイ差・選手間 (差1超過につき)
            playCount:      150,   // 合計プレイ数差 (差1超過につき)
            genderMixPair:  200,   // genderMix F+F同士ペア (コートにつき)
            fixedPairSplit: 200,   // fixedPairペア分離 (コートにつき)
            firstMatch:     500,   // 第1試合固定
            saIter:         200,   // SAリスタートあたりイテレーション数
            saConverge:       5,   // 収束判定: 連続同点リスタート数
            saMinRestart:    10,   // 収束判定: 最低リスタート数
            saMinTime:      0.4,   // 収束判定: 最低経過時間割合 (0〜1)
        };
        (function _initPw() {
            try {
                const _saved = localStorage.getItem(LS_KEY_PW);
                appState.pw = _saved ? { ...PENALTY_DEFAULTS, ...JSON.parse(_saved) } : { ...PENALTY_DEFAULTS };
            } catch (_) { appState.pw = { ...PENALTY_DEFAULTS }; }
        })();

        const SCORE_SETTINGS = {
            GENERATION_ATTEMPTS: 5000,          // 組み合わせの試行回数
            PENALTY_CARD_DUPLICATION: 1000,     // 対戦カード重複の基本ペナルティ
            PENALTY_CARD_DUPLICATION_LATE: 250, // 試合後半での対戦カード重複ペナルティ
            PENALTY_OPPONENT_REPETITION: 400,   // 同じ相手ペアとの対戦が重なることへのペナルティ係数
            BONUS_SPECIAL_RULE: 500,            // 特別ルール（固定ペア・ミックス）に合致した場合のボーナス
            PENALTY_CONSECUTIVE_PAIR: 800,      // 直前の試合と同じペアが連続した場合のペナルティ
            PENALTY_PAIR_FAIRNESS_CV: 200,      // ペア結成回数の公平性を評価するペナルティ係数
            PENALTY_CONSECUTIVE_REST: 5000,      // 連続休憩に対するペナルティ
            BONUS_REST_PLAYER_PRIORITY: 100,    // 休憩明けの選手を優先する場合のボーナス
            PENALTY_REST_COUNT_FAIRNESS: 300,
            PENALTY_INDIVIDUAL_OPP_FAIRNESS: 200,
            BONUS_PAIR_ENTROPY: 10,
            PENALTY_MIN_REPEAT: 100,
            PENALTY_WINDOW_PLAY_DIFF: 500,
            BONUS_NEW_PAIR: 1000,
            PENALTY_REPEAT_PAIR: 1000,
            PENALTY_CONSECUTIVE_PLAY_STREAK: 800,
        };
        const STAT_INFO = {
            'ペア結成の多様性': `### 指標の説明：ペア結成の多様性\n\n全メンバーから作りうる全ての「2人組ペア」のうち、実際に何%のペアが試合で少なくとも一度は結成されたかを示します。\n\n**計算式:**\n\`(実際に結成されたペアの種類数) / (理論上の全ペア数)\`\n\nこの値が高いほど、パートナーの組み合わせが豊富で、色々な人とペアを組めているバランスの良い組み合わせと言えます。`,
            '対戦グループの多様性': `### 指標の説明：対戦グループの多様性\n\n全メンバーから作りうる全ての「4人組グループ」のうち、実際に何%のグループが同じ試合で顔を合わせたかを示します。\n\n---\n#### 具体例\nメンバー「A, B, C, D」の4人がいたとします。\nこの指標では、\`A&B vs C&D\` という対戦も、\`A&C vs B&D\` という対戦も、**どちらも同じ「A,B,C,D」という1つのグループ**としてカウントします。\n\n---\n**計算式:**\n\`(実際に試合をした4人グループの種類数) / (理論上の全4人グループ数)\`\n\nこの値が高いほど、対戦相手も含めた組み合わせが豊富で、より多くのメンバーと試合を経験できたことを意味します。`,
            '対戦カードの多様性': `### 指標の説明：対戦カードの多様性\n\n今回の試合数で達成可能な「ペア vs ペア」という対戦パターンの上限のうち、実際に何%のパターンを実現できたかを示します。\n\n---\n#### 具体例\nメンバー「A, B, C, D」の4人がいたとします。\nこの指標では、\`A&B vs C&D\` という対戦と、\`A&C vs B&D\` という対戦は、**それぞれ異なる対戦カードとして、2種類としてカウントします。**\n\n---\n**計算式:**\n\`(実際のユニーク対戦数) / (達成可能な対戦数の上限)\`\n\nこの値が高いほど、試合の組み合わせがマンネリ化せず、多様な対戦が組まれたことを意味します。`,
            'ペア結成の公平性': `### 指標の説明：ペア結成の公平性\n\n各ペアが結成された回数の「ばらつき度合い」を示します。\n\nこの値が \`0\` に近いほど、すべてのペアが均等な回数だけ組まれていることを意味し、**公平性が高い**と言えます。\`CV\` と \`Gini\` はその計算に使われる統計値です。`,
            '対戦グループの公平性': `### 指標の説明：対戦グループの公平性\n\n各4人グループが試合をした回数の「ばらつき度合い」を示します。\n\nこの値が \`0\` に近いほど、すべての4人グループが均等な回数だけ試合をしていることを意味し、**公平性が高い**と言えます。\`CV\` と \`Gini\` はその計算に使われる統計値です。`,
            '初重複試合番号 (ペア)': `### 指標の説明：初重複試合番号 (ペア)\n\n新しい（まだ登場していない）ユニークなペアが一つも登場しなくなる最初の試合番号を示します。\n\n---\n**評価のポイント:**\nこの**数値が大きいほど**、試合の序盤で効率よく多様なペアが紹介され続けていることを意味し、組み合わせの「マンネリ化が始まるまでの持続力」を示す良い指標です。`,
            '初重複試合番号 (グループ)': `### 指標の説明：初重複試合番号 (グループ)\n\n新しい（まだ登場していない）ユニークな4人組が一つも登場しなくなる最初の試合番号を示します。\n\n---\n**評価のポイント:**\nこの**数値が大きいほど**、多様な顔ぶれでの対戦が長く続いていることを意味します。`,
            'ペア相手数の分布': `### 指標の説明：ペア相手数の分布\n\n各メンバーが、それぞれ何人の異なる相手とペアを組んだか、その分布を**（最小値 / 平均値 / 最大値）**の形式で示します。\n\n---\n**評価のポイント:**\nこの3つの数値を見ることで、ペアの多様性をより深く評価できます。\n- **最小値が低い:** 特定のメンバーが、あまり色々な人と組めていない（孤立気味）。\n- **平均値が低い:** 全体的にペアの組み合わせがマンネリ気味。\n- **最大値と最小値の差が大きい:** ペア相手の数にメンバー間の格差（不公平）が生じている。`,
            'プレイ回数の最大差': `
### 指標の説明：プレイ回数の最大差

生成された全試合において、最も多く出場したメンバーと最も少なかったメンバーのプレイ回数の**差**を示します。  
値が小さいほど、全員の出場機会が均等であることを意味します。`,

            '対戦の公平性': `
### 指標の説明：対戦の公平性

**ペアvsペア** の対戦機会のばらつきを評価します。  
各ペアが何種類の相手ペアと対戦したかを集計し、その**変動係数(CV)**および**ジニ係数**を算出。  
値が小さいほど、全ペアが均等に様々な相手ペアと対戦しており、公平性が高いことを示します。`
        };
        const FAIRNESS = {
            none: { good: { cv: 0.20, g: 0.15 }, warn: { cv: 0.40, g: 0.35 } }, // しきい値を少し緩和
            fixedPair: { good: { cv: 0.25, g: 0.20 }, warn: { cv: 0.40, g: 0.35 } },
            genderMix: { good: { cv: 0.30, g: 0.25 }, warn: { cv: 0.45, g: 0.40 } }
        };
        const LEVEL_COLOR = { good: 'bg-green-100', warn: 'bg-yellow-100', bad: 'bg-red-200' };
        const LEVEL_ICON = { good: '🟢', warn: '🟡', bad: '🔴' };
        const LEVEL_TEXT = { good: '良好', warn: '注意', bad: '要調整' };

        function judgeFairness(cv, gini, rule = 'none') {
            const th = FAIRNESS[rule] ?? FAIRNESS.none;
            if (cv <= th.good.cv && gini <= th.good.g) return 'good';
            if (cv <= th.warn.cv && gini <= th.warn.g) return 'warn';
            return 'bad';
        }
        const COVER = {
            pair: { good: 0.70, warn: 0.50 },
            card: { good: 0.85, warn: 0.60 },
        };
        function judgeCoverage(ratio, type) {
            const t = COVER[type];
            if (!t) return 'good';
            return ratio >= t.good ? 'good' :
                ratio >= t.warn ? 'warn' : 'bad';
        }

        const MIN_REMATCH_WINDOW = 4;   // 何ラウンド以内を “短すぎ” と見るか
        const REPEAT_BASE_PENALTY = 400; // ペナルティの係数
        // お気に入りの最大保存数を定義
        const MAX_FAVORITES = 30;

        // お気に入り数の表示を更新する関数
        function updateFavoritesCountDisplay() {
            const count = appState.favorites.length;
            const max = MAX_FAVORITES;
            const text = `保存数: ${count} / ${max}`;

            const mainDisplay = document.getElementById('favoritesCount');
            if (mainDisplay) {
                mainDisplay.textContent = text;
            }

            const managerDisplay = document.getElementById('favoritesManagerCount');
            if (managerDisplay) {
                managerDisplay.textContent = text;
            }
        }
        // --- DOM Elements Cache ---
        const dom = {};
        document.addEventListener('DOMContentLoaded', () => {
            const ids = [
                'surfaceCountSelect', 'totalMemberCountSelect', 'maxConsecutiveSelect', 'maxConsecWarning', 'matchCountSelect',
                'memberNamesSection', 'memberNamesContainerWrapper', 'memberNamesContainer', 'toggleNamesBtn',
                'loadingIndicator', 'loadingMessage', 'resultsDashboard', 'matchScheduleCard',
                'progressText', 'progressFill', 'matchListContainer', 'analysisSection', 'attemptCountSelect', 'findBestButton',
                'sankeyChartContainer', 'cumulativePlayCountChart',
                'memberProfileRadarChart', 'pairCombinationHeatmapContainer', 'resetProgressButton',
                'resetAllButton', 'undoButton', 'redoButton', // ← undoButtonとredoButtonを追加
                'resetAllButton', 'customDialog', 'dialogTitle', 'dialogMessage', 'dialogMessageContainer', 'dialogContent',
                'dialogCancelButton', 'dialogConfirmButton', 'currentYear',
                'graphToggleButton', 'graphIconShow', 'graphIconHide',
                'favoritesSelect', 'saveFavoriteButton', 'exportCsvButton', 'summaryStatsCard', 'summaryStatsGrid',
                'exportJsonButton', 'importJsonButton', 'json-importer',
                'detailedStatsCard', 'detailedStatsTabButtons', 'detailedStatsTablesContainer',
                'manageFavoritesButton', 'favoritesManagerDialog', 'favoritesManagerList', 'closeFavoritesManager',
                'favoriteMemoInput', 'pairVsPairHeatmapContainer',
                'specialRulesWrapper', 'fixedPairWrapper', 'fixedPairPlayer1', 'fixedPairPlayer2',
                'genderMixWrapper', 'femalePlayersContainer', 'editMatchModal', 'cancelEditMatchButton', 'saveMatchButton',
                'editMatchTitle', 'editMatchForm', 'jumpNextBtn',
                'dropoutSettingsWrapper', 'dropoutPlayerSelect', 'dropoutMatchNumberInput', 'applyDropoutButton', 'dropoutHint',
                'notArrivedCountInput', 'arrivalButtonsContainer',
                'analysisToggle', 'jumpNextBtn', 'theme-toggle', 'theme-toggle-dark-icon', 'theme-toggle-light-icon',
                'expandScheduleBtn', 'printScheduleBtn',
                'configurationHub', 'memberDetailContent'
            ];
            ids.forEach(id => {
                const element = document.getElementById(id);
                if (!element) {
                    console.error(`DOM element with ID "${id}" not found.`);
                    //alert(`HTML要素が見つかりません！\n\nID: ${id}`);
                }
                dom[id] = element;
            });
            initializeApp();

            // ★ 追加: ルール変更時に上限を更新
            document.querySelectorAll('input[name="ruleType"]').forEach(el => {
                el.addEventListener('change', updateTargetScoreUI);
            });

            // ★ 追加: 女性メンバー選択変更時に上限を更新
            document.getElementById('femalePlayersContainer')?.addEventListener('change', updateTargetScoreUI);

        });
        function applyTheme(theme) {
            if (theme === 'dark') {
                document.body.classList.add('dark');
                dom['theme-toggle-light-icon'].classList.remove('hidden');
                dom['theme-toggle-dark-icon'].classList.add('hidden');
            } else {
                document.body.classList.remove('dark');
                dom['theme-toggle-light-icon'].classList.add('hidden');
                dom['theme-toggle-dark-icon'].classList.remove('hidden');
            }
        }
        function generateColorPalette(count) {
            const palette = [];
            const saturation = 70;
            const lightness = 85;
            for (let i = 0; i < count; i++) {
                const hue = (i * (360 / count) * 1.618) % 360; //黄金比を使って色相を分散
                palette.push(`hsl(${hue}, ${saturation}%, ${lightness}%)`);
            }
            return palette;
        }
        function toggleTheme() {
            const currentTheme = localStorage.getItem('theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            localStorage.setItem('theme', newTheme);
            applyTheme(newTheme);
        }
        // --- Initialization ---
        function initializeApp() {
            const savedTheme = localStorage.getItem('theme') || 'light';
            applyTheme(savedTheme);
            loadState();
            setupEventListeners();
            restoreRuleTypeRadioFromState();
            updateAllUI();
            updateFavoritesCountDisplay();
            dom.currentYear.textContent = new Date().getFullYear();
            addModalCloseBehaviour(dom.editMatchModal);
            addModalCloseBehaviour(dom.customDialog);
            addModalCloseBehaviour(dom.favoritesManagerDialog);
            dom.analysisToggle.checked = appState.areAnalysisSectionsVisible;
            updateScrollableShadows();

            // ▼▼▼ Undo/Redo機能のために追加 ▼▼▼
            pushStateToHistory(); // 初期状態を履歴に保存
            updateUndoRedoButtons();
            updateTargetScoreUI(); // 条件別上限スコアを初期表示
        }
        // --- Undo/Redo History Management ---

        function pushStateToHistory() {
            // 現在の履歴ポインタ以降の「やり直し」履歴を削除
            appState.history.splice(appState.historyIndex + 1);

            // シリアライズできないデータを除外して、状態をディープコピー
            const stateToSave = { ...appState };

            // ★★★★★★★★★★★★★★★★★★★★★★
            // ★★★  ここが今回の修正点です  ★★★
            // ★★★★★★★★★★★★★★★★★★★★★★
            // グラフオブジェクトは保存しない（データから再生成するため）
            delete stateToSave.charts;

            // 履歴データ自体も保存対象から除外
            delete stateToSave.history;
            delete stateToSave.historyIndex;

            // favoritesはUndo/Redoの対象として設計されていない（追加・削除・編集時に
            // pushStateToHistoryを呼んでいない）ため、履歴世代ごとに複製すると
            // メモリを圧迫するだけで意味がない。除外する
            delete stateToSave.favorites;

            stateToSave.completedMatches = Array.from(appState.completedMatches || []);
            // JSONを経由して完全なディープコピーを作成
            const snapshot = JSON.parse(JSON.stringify(stateToSave));

            // 履歴スタックに追加し、ポインタを更新
            appState.history.push(snapshot);
            appState.historyIndex++;

            // 履歴が溜まりすぎないように制御（例：最大50件）
            if (appState.history.length > 50) {
                appState.history.shift();
                appState.historyIndex--;
            }

            updateUndoRedoButtons();
        }

        /**
         * 履歴から特定の状態を復元する
         * @param {number} index - 復元する履歴のインデックス
         */
        function loadStateFromHistory(index) {
            if (index < 0 || index >= appState.history.length) return;

            const stateToLoad = JSON.parse(JSON.stringify(appState.history[index]));

            const arr = Array.isArray(stateToLoad.completedMatches)
                ? stateToLoad.completedMatches
                : [];
            Object.assign(appState, stateToLoad, {
                completedMatches: new Set(arr),
                charts: { cumulativePlayCountChart: null, memberProfileRadarChart: null },
                history: appState.history,
                historyIndex: index,
                favorites: appState.favorites, // 履歴には含まれないため、現在のお気に入り一覧を維持する
            });

            // UI全体を更新
            updateAllUI();
            applyDisplayLogicBasedOnState();
            updateUndoRedoButtons();
        }

        /**
         * 「元に戻す」処理
         */
        function handleUndo() {
            if (appState.historyIndex > 0) {
                loadStateFromHistory(appState.historyIndex - 1);
            }
        }

        /**
         * 「やり直す」処理
         */
        function handleRedo() {
            if (appState.historyIndex < appState.history.length - 1) {
                loadStateFromHistory(appState.historyIndex + 1);
            }
        }

        /**
         * Undo/Redoボタンの有効/無効状態を更新
         */
        function updateUndoRedoButtons() {
            dom.undoButton.disabled = appState.historyIndex <= 0;
            dom.redoButton.disabled = appState.historyIndex >= appState.history.length - 1;
        }

        // --- End of Undo/Redo ---

        function setupEventListeners() {
            dom.surfaceCountSelect.addEventListener('change', handleSurfaceOrMemberCountChange);
            dom.totalMemberCountSelect.addEventListener('change', handleSurfaceOrMemberCountChange);
            dom.totalMemberCountSelect.addEventListener('change', updateTargetScoreUI);
            dom.surfaceCountSelect.addEventListener('change', updateTargetScoreUI);
            document.getElementById('matchCountSelect')?.addEventListener('change', updateTargetScoreUI);
            dom.maxConsecutiveSelect.addEventListener('change', handleMaxConsecutiveChange);
            dom.memberNamesContainer.addEventListener('input', handleMemberNameChange);
            dom.findBestButton.addEventListener('click', findBestOfNGenerations);
            dom.resetProgressButton.addEventListener('click', () => confirmAndReset('progress'));
            dom.resetAllButton.addEventListener('click', () => confirmAndReset('all'));
            dom.undoButton.addEventListener('click', handleUndo);
            dom.redoButton.addEventListener('click', handleRedo);
            dom.dialogCancelButton.addEventListener('click', () => processDialog(false));
            dom.dialogConfirmButton.addEventListener('click', () => processDialog(true));
            dom.graphToggleButton.addEventListener('click', toggleAnalysisVisibility);
            dom.analysisToggle.addEventListener('change', toggleAnalysisVisibility);
            dom['theme-toggle'].addEventListener('click', toggleTheme);
            dom.favoritesSelect.addEventListener('change', handleLoadFavorite);
            dom.saveFavoriteButton.addEventListener('click', handleSaveFavorite);
            dom.manageFavoritesButton.addEventListener('click', openFavoritesManager);
            dom.closeFavoritesManager.addEventListener('click', () => dom.favoritesManagerDialog.classList.add('hidden'));
            dom.exportJsonButton.addEventListener('click', handleExportJson);
            dom.importJsonButton.addEventListener('click', () => dom['json-importer'].click());
            dom['json-importer'].addEventListener('change', handleImportJson);
            dom.exportCsvButton.addEventListener('click', handleExportCsv);
            dom.cancelEditMatchButton.addEventListener('click', () => dom.editMatchModal.classList.add('hidden'));
            dom.saveMatchButton.addEventListener('click', saveMatchEdit);
            dom.applyDropoutButton.addEventListener('click', handleApplyExclusion);
            if (dom.notArrivedCountInput) {
                dom.notArrivedCountInput.addEventListener('change', handleNotArrivedCountChange);
            }
            if (dom.arrivalButtonsContainer) {
                dom.arrivalButtonsContainer.addEventListener('click', (e) => {
                    const btn = e.target.closest('.arrival-button');
                    if (!btn) return;
                    handleArrival(parseInt(btn.dataset.playerIndex, 10));
                });
            }
            dom.expandScheduleBtn.addEventListener('click', toggleScheduleExpansion);
            (function _debugBtnSetup() {
                const _dbBtn = document.getElementById('debugLogBtn');
                let _dbLongPressTimer = null;
                _dbBtn.addEventListener('click', (e) => {
                    if (e.shiftKey) { showPenaltySettingsDialog(); } else { collectDebugLog(); }
                });
                _dbBtn.addEventListener('touchstart', (e) => {
                    _dbLongPressTimer = setTimeout(() => {
                        _dbLongPressTimer = null;
                        e.preventDefault();
                        showPenaltySettingsDialog();
                    }, 800);
                }, { passive: false });
                _dbBtn.addEventListener('touchend', () => {
                    if (_dbLongPressTimer) { clearTimeout(_dbLongPressTimer); _dbLongPressTimer = null; }
                });
                _dbBtn.addEventListener('touchmove', () => {
                    if (_dbLongPressTimer) { clearTimeout(_dbLongPressTimer); _dbLongPressTimer = null; }
                });
            })();
            document.getElementById('specBtn').addEventListener('click', showSpecDialog);
            document.getElementById('dropoutHelpBtn')?.addEventListener('click', () => {
                showDialog('途中離脱・未到着メンバー', null, null, `
<div style="font-size:0.9rem;line-height:1.7;">
<p style="margin-bottom:6px;font-weight:bold;">🚪 途中離脱</p>
<p style="margin-bottom:10px;">試合の途中で参加できなくなったメンバーが出た場合、残りのメンバーで公平な試合を自動的に作り直せます。</p>
<ol style="padding-left:1.2em;margin-bottom:14px;">
<li style="margin-bottom:8px;"><strong>離脱するメンバー</strong>をドロップダウンから選択</li>
<li style="margin-bottom:8px;"><strong>何試合目から</strong>離脱するかを入力（例: 5試合目から不参加なら「5」）</li>
<li style="margin-bottom:8px;">「<strong>離脱を適用して再生成</strong>」ボタンをタップ</li>
</ol>
<p style="font-size:0.8rem;color:#6b7280;margin-bottom:14px;">指定試合<strong>以降のみ</strong>が再計算され、それより前の試合はそのまま残ります。</p>

<p style="margin-bottom:6px;font-weight:bold;">🏃 未到着メンバー（遅刻者への対応）</p>
<p style="margin-bottom:10px;">遅刻者がいる場合は、合計メンバー数の横で未到着人数を指定してから生成してください（遅刻者は自動的に末尾番号になります）。到着したら試合スケジュール上部の「<strong>◯◯さん到着</strong>」ボタンをタップすると、次の試合から自動で組み込まれます。それより前の試合は変わりません。</p>
<ol style="padding-left:1.2em;margin-bottom:14px;">
<li style="margin-bottom:8px;">「1. 設定と生成」の<strong>合計メンバー数</strong>の横にある「<strong>うち未到着</strong>」に人数を入力（例: 18人中2人遅刻なら「2」を入力。自動的に17番・18番が未到着になります）</li>
<li style="margin-bottom:8px;">通常どおり試合を生成（未到着の人抜きで組まれます）</li>
<li style="margin-bottom:8px;">本人が来たら、試合スケジュール上部に表示される「<strong>◯◯さん到着</strong>」ボタンをタップ</li>
<li style="margin-bottom:8px;">確認ダイアログで「はい」を選ぶと、次の未消化試合から自動で組み込まれます（消化済みの試合・チェック済みの進行状況はそのまま）</li>
</ol>
<p style="font-size:0.8rem;color:#6b7280;margin-bottom:6px;">公平性の考え方: 遅れて参加した人は、参加した時点から他の人と同じペースで出場します。参加前の分を取り戻して多く出場することはありません（総プレイ数は参加が遅い分だけ少なくなります）。</p>
<p style="font-size:0.8rem;color:#6b7280;">※ 全試合が消化済みの状態で遅刻者が来た場合は自動組み込みができません。各試合の ✏️ から手動でメンバーを入れ替えてください。</p>
</div>`);
            });
            document.getElementById('scheduleHelpBtn')?.addEventListener('click', () => {
                showDialog('試合スケジュールの操作', null, null, `
<div style="font-size:0.9rem;line-height:1.7;">
<p style="margin-bottom:10px;font-weight:bold;">✏️ メンバー交代（コートごと）</p>
<p style="margin-bottom:10px;">各コートの右端にある ✏️ をタップすると、その試合のメンバーを手動で入れ替えられます。変更後は以降の試合が自動的に再計算されます。</p>
<p style="margin-bottom:10px;font-weight:bold;">☑️ 試合の進行チェック</p>
<p style="margin-bottom:10px;">各試合の左側のチェックボックスをタップすると、その試合を「完了」としてマークできます。進行状況バーに反映されます。</p>
<p style="font-size:0.8rem;color:#6b7280;">💡 ✏️ ボタンで変更できるのは1コートずつです。全体を作り直すには「ベストな組み合わせを探す」を再実行してください。</p>
</div>`);
            });

            // ★★★★★★★★★★★★★★★★★★★★★★★★★★★
            // ★★★  ここが今回の修正点です  ★★★
            // ★★★★★★★★★★★★★★★★★★★★★★★★★★★
            // 抜けていた印刷ボタンのイベントリスナーを追加します。
            dom.printScheduleBtn.addEventListener('click', handlePrintSchedule);

            window.addEventListener('resize', updateScrollableShadows);

            if (dom.matchListContainer) {
                dom.matchListContainer.addEventListener('click', (e) => {
                    if (e.target.type !== 'checkbox' || !e.shiftKey) {
                        delete appState.__lastClickedIdx;
                        return;
                    }
                    const boxes = [...dom.matchListContainer.querySelectorAll('input[type=checkbox]')];
                    const lastIdx = appState.__lastClickedIdx ?? boxes.indexOf(e.target);
                    const curIdx = boxes.indexOf(e.target);
                    const [from, to] = [lastIdx, curIdx].sort((a, b) => a - b);
                    boxes.slice(from, to + 1).forEach((cb) => {
                        cb.checked = e.target.checked;
                        const idx = +cb.dataset.matchIndex;
                        if (cb.checked) {
                            appState.completedMatches.add(idx);
                        } else {
                            appState.completedMatches.delete(idx);
                        }
                    });
                    appState.__lastClickedIdx = curIdx;
                    updateProgressIndicator();
                    saveState(); // このsaveStateはUndo/Redoに影響しないのでそのままでOK
                });
                dom.jumpNextBtn.addEventListener('click', () => {
                    const next = [...dom.matchListContainer.querySelectorAll('input[type=checkbox]')]
                        .find(cb => !cb.checked);
                    if (next) {
                        next.scrollIntoView({
                            behavior: 'smooth',
                            block: 'center'
                        });
                        next.focus();
                    } else {
                        showDialog('完了', 'すべての試合がチェック済みです！');
                    }
                });
            }

            document.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                    e.preventDefault();
                    handleUndo();
                }
                if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
                    e.preventDefault();
                    handleRedo();
                }
                if (e.key.toLowerCase() === 'g' && !(e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    toggleAnalysisVisibility();
                }
            });

            dom.detailedStatsTabButtons.addEventListener('click', (e) => {
                const button = e.target.closest('button[data-table]');
                if (!button) return;
                const tableId = button.dataset.table;
                const wasActive = button.classList.contains('active');
                clearDetailedStatsTabs();
                if (!wasActive) {
                    button.classList.add('active');
                    showDetailedStatsTable(tableId);
                }
            });

            document.body.addEventListener('click', e => {
                if (e.target.matches('.info-icon')) {
                    const rawMsg = STAT_INFO[e.target.dataset.stat] || '説明がありません';
                    const title = rawMsg.split('\n')[0].replace(/###\s*指標の説明：/, '').trim();
                    const messageHtml = rawMsg.split('\n').slice(2)
                        .map(line => {
                            line = line.trim();
                            if (line === '---') return '<hr class="my-3">';
                            if (line.startsWith('#### ')) return `<h4 class="text-md font-semibold mt-3 mb-1 text-left">${line.replace('#### ', '')}</h4>`;
                            if (line === '') return '';
                            line = line.replace(/`([^`]+)`/g, '<code class="bg-gray-200 text-red-600 px-1 rounded text-sm">$1</code>');
                            line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
                            return `<p class="my-2 text-left">${line}</p>`;
                        }).join('');
                    showDialog(title, null, null, messageHtml);
                }
                if (e.target.closest('.edit-match-btn')) {
                    const btn = e.target.closest('.edit-match-btn');
                    const matchIndex = parseInt(btn.dataset.matchIndex, 10);
                    const courtIndex = parseInt(btn.dataset.courtIndex, 10);
                    openEditMatchModal(matchIndex, courtIndex);
                }
            });
            const managerDialog = dom.favoritesManagerDialog;
            managerDialog.addEventListener('click', e => {
                const compareBtn = e.target.closest('#compareFavoritesBtn');
                const actionBtn = e.target.closest('.edit-fav-btn, .save-fav-btn, .cancel-edit-fav-btn, .delete-fav-btn');

                if (compareBtn) {
                    const checked = managerDialog.querySelectorAll('.fav-compare-checkbox:checked');
                    if (checked.length < 2) return;

                    const selectedFavorites = Array.from(checked).map(cb => {
                        const index = parseInt(cb.dataset.index, 10);
                        return appState.favorites[index];
                    });

                    showComparisonDialog(selectedFavorites);
                    return;
                }

                if (actionBtn) {
                    handleFavoritesManagerActions(e);
                    return;
                }
            });
            managerDialog.addEventListener('change', e => {
                if (!e.target.classList.contains('fav-compare-checkbox')) return;

                const compareBtn = document.getElementById('compareFavoritesBtn');
                const compareMsg = document.getElementById('compareMessage');
                const checked = managerDialog.querySelectorAll('.fav-compare-checkbox:checked');

                compareMsg.textContent = '';
                compareBtn.disabled = true;

                if (checked.length < 2) {
                    compareBtn.textContent = `比較する (2件以上選択)`;
                    return;
                }

                const firstFavIndex = parseInt(checked[0].dataset.index, 10);
                const firstFav = appState.favorites[firstFavIndex];
                let allMatch = true;

                for (let i = 1; i < checked.length; i++) {
                    const nextFavIndex = parseInt(checked[i].dataset.index, 10);
                    const nextFav = appState.favorites[nextFavIndex];
                    if (firstFav.settings.totalMemberCount !== nextFav.settings.totalMemberCount ||
                        firstFav.settings.surfaceCount !== nextFav.settings.surfaceCount) {
                        allMatch = false;
                        break;
                    }
                }

                if (allMatch) {
                    compareMsg.textContent = `${checked.length}件を選択中`;
                    compareBtn.disabled = false;
                    compareBtn.textContent = `選択した${checked.length}件を比較`;
                } else {
                    compareMsg.textContent = '人数と面数が同じ設定のみ比較できます。';
                    compareBtn.disabled = true;
                }
            });
            document.querySelectorAll('input[name="ruleType"]').forEach(radio => {
                radio.addEventListener('change', handleRuleTypeChange);
            });
            dom.fixedPairPlayer1.addEventListener('change', () => {
                refreshFixedPairSelect();
                updateGroupsFromSpecialRules();
            });
            dom.fixedPairPlayer2.addEventListener('change', () => {
                refreshFixedPairSelect();
                updateGroupsFromSpecialRules();
            });
            dom.femalePlayersContainer.addEventListener('change', updateGroupsFromSpecialRules);
            dom.toggleNamesBtn.addEventListener('click', () => {
                const wrapper = dom.memberNamesContainerWrapper;
                wrapper.classList.toggle('hidden');
                const buttonTextSpan = dom.toggleNamesBtn.querySelector('span');
                buttonTextSpan.textContent = wrapper.classList.contains('hidden') ? '編集' : '完了';
            });
            dom.favoriteMemoInput.addEventListener('input', e => {
                appState.currentMemo = e.target.value;
            });

            dom.summaryStatsGrid.addEventListener('click', e => {
                const tile = e.target.closest('.cov-tile');
                if (!tile) return;
                const n = tile.dataset.num,
                    d = tile.dataset.den;
                if (!n || !d) return;
                const pct = ((n / d) * 100).toFixed(1);
                showDialog(
                    '網羅率の計算',
                    `生成枚数 : ${n}\n分母      : ${d}\n\n${n} ÷ ${d} = ${pct} %`
                );
            });

            setupWakeLockToggle();
        }

        // ─── 画面スリープ防止 (Screen Wake Lock API) ──────────────────────────
        // コートサイドでスマホの画面を見ながら試合を進行するためのツールなので、
        // ユーザーが明示的にONにしている間だけ画面の自動消灯を防ぐ。
        // WakeLockSentinelはappStateに入れない（saveState/pushStateToHistoryが
        // appStateをJSON化するため、シリアライズ不要なオブジェクトを巻き込まないようにする）。
        let wakeLockSentinel = null;
        let wakeLockEnabled = false; // localStorageには保存しない。毎回OFFで開始する

        function isWakeLockSupported() {
            return 'wakeLock' in navigator;
        }

        async function acquireWakeLock() {
            try {
                wakeLockSentinel = await navigator.wakeLock.request('screen');
                wakeLockSentinel.addEventListener('release', () => {
                    // タブ切替・ホーム画面復帰などブラウザ側の都合で自動解放された場合はsentinelだけ
                    // クリアする。wakeLockEnabledはそのままにし、visible復帰時に再取得を試みる
                    wakeLockSentinel = null;
                });
                return true;
            } catch (err) {
                console.warn('画面スリープ防止の取得に失敗しました:', err);
                wakeLockSentinel = null;
                return false;
            }
        }

        function releaseWakeLock() {
            if (wakeLockSentinel) {
                wakeLockSentinel.release().catch(() => { });
                wakeLockSentinel = null;
            }
        }

        function updateWakeLockButtonUI() {
            const btn = document.getElementById('wakeLockToggleBtn');
            if (!btn) return;
            if (wakeLockEnabled) {
                btn.textContent = '☀️ 画面オンを維持';
                btn.style.background = '#fef3c7';
                btn.style.borderColor = '#f59e0b';
                btn.style.color = '#92400e';
            } else {
                btn.textContent = '🌙 通常';
                btn.style.background = '#f3f4f6';
                btn.style.borderColor = '#d1d5db';
                btn.style.color = '#374151';
            }
        }

        function setupWakeLockToggle() {
            const btn = document.getElementById('wakeLockToggleBtn');
            if (!btn) return;
            if (!isWakeLockSupported()) return; // 非対応ブラウザではボタンを表示しない（display:noneのまま）

            btn.style.display = 'inline-flex';
            btn.addEventListener('click', async () => {
                if (!wakeLockEnabled) {
                    // request()はユーザー操作起点でないと失敗するブラウザがあるため、
                    // 必ずこのclickハンドラ内で直接呼び出す
                    const ok = await acquireWakeLock();
                    wakeLockEnabled = ok; // 失敗時はOFFのまま
                } else {
                    wakeLockEnabled = false;
                    releaseWakeLock();
                }
                updateWakeLockButtonUI();
            });

            document.addEventListener('visibilitychange', async () => {
                if (document.visibilityState === 'visible' && wakeLockEnabled && !wakeLockSentinel) {
                    const ok = await acquireWakeLock();
                    if (!ok) wakeLockEnabled = false;
                    updateWakeLockButtonUI();
                }
            });

            window.addEventListener('beforeunload', () => {
                releaseWakeLock();
            });
        }

        function toBadgesForPrint(pairIndices, members, groups, ruleType, pairIdMap, pairColorMap) {
            const key = [...pairIndices].sort((a, b) => a - b).join(',');
            const pairId = pairIdMap[key];
            const textColor = '#111827';

            const isTheFixedPair = ruleType === 'fixedPair' &&
                groups[pairIndices[0]] === 'P1' && groups[pairIndices[1]] === 'P1';

            const borderStyles = ['', 'border-dashed', 'border-dotted', 'border-double'];
            const borderClass = borderStyles[pairId % borderStyles.length];

            const classNames = ['badge', borderClass];
            let inlineStyle = `color:${textColor};`;

            if (isTheFixedPair) {
                classNames.push('fixedpair');
            } else {
                const pairColor = pairColorMap[key] || '#cccccc';
                inlineStyle += ` background-color:${pairColor};`;
            }

            const _prtSorted = [...pairIndices].sort((a, b) => {
                const na = parseInt(members[a], 10), nb = parseInt(members[b], 10);
                if (!isNaN(na) && !isNaN(nb)) return na - nb;
                return String(members[a]).localeCompare(String(members[b]));
            });
            const namesHtml = _prtSorted.map(idx => {
                const name = members[idx] || `不明(${idx})`;
                if (ruleType === 'genderMix' && groups[idx] === 'F') {
                    return `<span class="female-pill">${name}</span>`;
                }
                return name;
            }).join(' & ');

            return `<span class="${classNames.join(' ')}" style="${inlineStyle}"><span class="player-names">${namesHtml}</span><span class="pair-id">(P${pairId})</span></span>`;
        }


        function handlePrintSchedule() {
            if (appState.matches.length === 0) {
                showDialog('エラー', '印刷する試合データがありません。');
                return;
            }

            const { members, matches, currentTotalMemberCount, currentSurfaceCount, exclusions, joins, pairIdMap, pairColorMap } = appState;
            const generationSettings = appState.generationSettings || {};
            const groups = generationSettings.groups || {};
            const ruleType = generationSettings.ruleType || 'none';
            const ruleMap = { none: 'なし', fixedPair: '固定ペア', genderMix: '男女ミックス' };

            let exclusionText = '';
            const exclusionEntries = Object.entries(exclusions);
            if (exclusionEntries.length > 0) {
                const exclusionDetails = exclusionEntries.map(([playerIdx, fromMatch]) => {
                    return `${members[playerIdx]}(${fromMatch}試合目~)`;
                }).join(', ');
                exclusionText = ` | 離脱: ${exclusionDetails}`;
            }
            const joinEntries = Object.entries(joins || {});
            const notArrivedEntries = joinEntries.filter(([, fromMatch]) => fromMatch === JOIN_NOT_ARRIVED);
            const arrivedJoinEntries = joinEntries.filter(([, fromMatch]) => fromMatch !== JOIN_NOT_ARRIVED);
            if (notArrivedEntries.length > 0) {
                exclusionText += ` | 未到着: ${notArrivedEntries.map(([playerIdx]) => members[playerIdx]).join(', ')}`;
            }
            if (arrivedJoinEntries.length > 0) {
                const joinDetails = arrivedJoinEntries.map(([playerIdx, fromMatch]) => {
                    return `${members[playerIdx]}(第${fromMatch}試合~)`;
                }).join(', ');
                exclusionText += ` | 参加: ${joinDetails}`;
            }

            let tableRows = '';
            matches.forEach((match, matchIdx) => {
                const matchNumber = matchIdx + 1;
                // まだ参加していないメンバーは「休憩」ではなく別枠にする
                const restingActiveNames = match.restingPlayers
                    .filter(i => isPlayerActive(i, matchNumber, exclusions, joins))
                    .map(i => members[i]);
                const notYetJoinedNames = match.restingPlayers
                    .filter(i => !isPlayerActive(i, matchNumber, exclusions, joins))
                    .map(i => members[i]);
                let restingNames = restingActiveNames.join(', ') || 'なし';
                if (notYetJoinedNames.length > 0) {
                    restingNames += `<br><span style="color:#9ca3af;">未参加: ${notYetJoinedNames.join(', ')}</span>`;
                }
                const courtRows = match.courts.map((court, courtIdx) => {
                    const team1HTML = toBadgesForPrint(court.team1, members, groups, ruleType, pairIdMap, pairColorMap);
                    const team2HTML = toBadgesForPrint(court.team2, members, groups, ruleType, pairIdMap, pairColorMap);
                    return `
                <tr>
                    ${courtIdx === 0 ? `<td class="p-2 border align-top" rowspan="${match.courts.length}">第${matchIdx + 1}試合</td>` : ''}
                    <td class="p-2 border align-top">C${courtIdx + 1}</td>
                    <td class="p-2 border align-top">${team1HTML} vs ${team2HTML}</td>
                    ${courtIdx === 0 ? `<td class="p-2 border align-top" rowspan="${match.courts.length}">${restingNames}</td>` : ''}
                </tr>
            `;
                }).join('');
                tableRows += courtRows;
            });
            const cumulativePlaysTimeline = [];
            let currentPlays = new Array(members.length).fill(0);
            matches.forEach(match => {
                const currentMatchPlays = [...currentPlays];
                match.playersThisRound.forEach(playerIdx => {
                    currentMatchPlays[playerIdx]++;
                });
                cumulativePlaysTimeline.push(currentMatchPlays);
                currentPlays = currentMatchPlays;
            });
            const memberHeaders = members.map(name => `<th class="p-2 border text-center">${name}</th>`).join('');
            let memberDetailRows = '';
            matches.forEach((match, matchIdx) => {
                let countCells = '';
                members.forEach((_, memberIdx) => {
                    let isPlaying = false;
                    let style = '';
                    match.courts.forEach((court, courtIdx) => {
                        const courtColors = ['#bfdbfe', '#bbf7d0', '#fef08a'];
                        if (court.team1.includes(memberIdx)) {
                            isPlaying = true;
                            style = `background-color: ${courtColors[courtIdx % courtColors.length]}; font-weight: normal;`;
                        } else if (court.team2.includes(memberIdx)) {
                            isPlaying = true;
                            style = `background-color: ${courtColors[courtIdx % courtColors.length]}; text-decoration: underline; text-decoration-thickness: 2px;`;
                        }
                    });

                    const cellContent = isPlaying ? cumulativePlaysTimeline[matchIdx][memberIdx] : '-';
                    countCells += `<td class="p-2 border text-center" style="${style}">${cellContent}</td>`;
                });
                memberDetailRows += `<tr><td class="p-2 border font-semibold">第${matchIdx + 1}試合</td>${countCells}</tr>`;
            });
            const finalTotals = cumulativePlaysTimeline.length > 0 ? cumulativePlaysTimeline[cumulativePlaysTimeline.length - 1] : new Array(members.length).fill(0);
            const totalCells = finalTotals.map(count => `<td class="p-2 border text-center font-bold">${count}</td>`).join('');
            const totalRow = `<tr class="bg-gray-100"><td class="p-2 border font-bold">合計</td>${totalCells}</tr>`;
            const legendHtmlForPrint = `
                <div style="font-size: 0.8rem; padding: 0.5rem; margin-top: 1rem; border: 1px solid #ccc; border-radius: 0.25rem;">
                    <strong style="font-weight: bold;">凡例:</strong>
                    <span style="display: inline-flex; align-items: center; margin-left: 1rem;"><span style="display: inline-block; width: 12px; height: 12px; background-color: #bfdbfe; border: 1px solid #ccc; margin-right: 4px;"></span>コート1</span>
                    <span style="display: inline-flex; align-items: center; margin-left: 1rem;"><span style="display: inline-block; width: 12px; height: 12px; background-color: #bbf7d0; border: 1px solid #ccc; margin-right: 4px;"></span>コート2</span>
                    <span style="display: inline-flex; align-items: center; margin-left: 1rem;"><span style="display: inline-block; width: 12px; height: 12px; background-color: #fef08a; border: 1px solid #ccc; margin-right: 4px;"></span>コート3</span>
                    <span style="display: inline-flex; align-items: center; margin-left: 1rem;"><span style="text-decoration: underline; text-decoration-thickness: 2px; font-weight: bold;">数字</span>: チーム2</span>
                </div>
            `;
            const memberDetailTableHtml = `
                <h2 class="text-xl font-bold mt-8 mb-2 pt-4 border-t">メンバー別プレイ数詳細</h2>
                ${legendHtmlForPrint}
                <table class="w-full text-left border-collapse text-sm mt-2">
                    <thead><tr class="bg-gray-100"><th class="p-2 border"></th>${memberHeaders}</tr></thead>
                    <tbody>${memberDetailRows}${totalRow}</tbody>
                </table>
            `;

            const content = `
        <!DOCTYPE html>
        <html lang="ja">
        <head>
            <meta charset="UTF-8">
            <title>試合スケジュール - ダブルス組合せ</title>
            <script src="https://cdn.tailwindcss.com/"><\/script>
            <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap" rel="stylesheet">
            <style>
                body { font-family: 'Noto Sans JP', sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
                @media print { #print-button { display: none; } @page { size: A4; margin: 20mm; } }
                .badge { display: inline-flex; align-items: center; justify-content: center; padding: 0.4rem 0.65rem; height: 2.0rem; font-weight: 600; font-size: 0.875rem; color: #111827; border-radius: .5rem; border: 2px solid transparent; box-shadow: 0 1px 2px rgba(0,0,0,0.1); margin: 0 2px; }
                
                /* ▼▼▼ このCSSルールを再修正しました ▼▼▼ */
                .female-pill {
                    display: inline-block;
                    background-color: #ec4899;
                    color: #ffffff;
                    padding: 0.1em 0.4em; /* 上下の余白を少し確保し、左右の余白を調整 */
                    border-radius: 9999px;
                    font-weight: 700;
                    font-size: 0.8em; /* 親要素に対して少しだけ文字を小さくする */
                    line-height: 1; /* 行の高さを文字の高さに合わせる */
                    vertical-align: baseline; /* ベースラインを基準に揃える */
                }

                .badge.fixedpair { background-color: #fbd38d; border-color: #f6ad55; }
                .border-dashed { border-style: dashed; border-color: rgba(0,0,0,0.5); }
                .border-dotted { border-style: dotted; border-color: rgba(0,0,0,0.5); }
                .border-double { border-style: double; border-width: 4px; border-color: rgba(255,255,255,0.7); }
                .player-names { font-weight: 800; font-size: 2.2em; }
                .pair-id { font-weight: 400; font-size: 0.8em; margin-left: 0.3rem; opacity: 0.8; }
                table { border-collapse: collapse; }
                table th, table td { border: 1px solid #9ca3af; }
                thead th { border-bottom: 2px solid #4b5563; }
            </style>
        </head>
        <body class="p-8">
            <div class="flex justify-between items-center border-b pb-4 mb-4">
                <h1 class="text-2xl font-bold">試合スケジュール</h1>
                <button id="print-button" onclick="window.print()" class="bg-blue-500 text-white py-2 px-4 rounded">このページを印刷</button>
            </div>
            <div class="text-sm mb-6 bg-gray-50 p-2 rounded-md">
                <strong>条件:</strong> ${currentTotalMemberCount}名 | ${currentSurfaceCount}面 | ルール: ${ruleMap[ruleType]}${exclusionText}
            </div>
            <table class="w-full text-left border-collapse">
                <thead><tr class="bg-gray-100"><th class="p-2 border">試合</th><th class="p-2 border">コート</th><th class="p-2 border">対戦カード</th><th class="p-2 border">休憩メンバー</th></tr></thead>
                <tbody>${tableRows}</tbody>
            </table>
            ${memberDetailTableHtml}
        </body>
        </html>`;

            const printWindow = window.open('', '_blank');
            printWindow.document.write(content);
            printWindow.document.close();
        }



        function toggleScheduleExpansion() {
            const container = dom.matchListContainer;
            const button = dom.expandScheduleBtn;
            const isCollapsed = container.classList.contains('max-h-96');

            if (isCollapsed) {
                container.classList.remove('max-h-96');
                container.classList.add('max-h-none');
                button.textContent = '折りたたむ';
            } else {
                container.classList.remove('max-h-none');
                container.classList.add('max-h-96');
                button.textContent = 'すべて表示';
            }
        }
        // --- State Management ---
        function saveState() {
            try {
                const stateToSave = {
                    ...appState,
                    charts: undefined,
                    completedMatches: Array.from(appState.completedMatches),
                    editingMatch: null,
                    history: undefined,
                    historyIndex: undefined,
                };
                localStorage.setItem(LS_KEY, JSON.stringify(stateToSave));
            } catch (e) {
                console.error("Failed to save state:", e);
                // ユーザーへの通知が必要な場合は、alertを有効にすることもできます。
                // alert('エラー: データの保存に失敗しました。');
            }
        }

        function loadState() {
            try {
                const savedState = localStorage.getItem(LS_KEY);
                if (savedState) {
                    const parsed = JSON.parse(savedState);
                    Object.assign(appState, parsed, {
                        charts: { cumulativePlayCountChart: null, memberProfileRadarChart: null },
                        editingMatch: null
                    });
                    appState.completedMatches = new Set(parsed.completedMatches || []);
                    appState.favorites = parsed.favorites || [];
                    appState.groups = parsed.groups || {};
                    appState.exclusions = parsed.exclusions || {};
                    appState.joins = parsed.joins || {}; // 後方互換: 旧データにはjoinsが存在しない
                    appState.joinOffsets = parsed.joinOffsets || {}; // 後方互換: 旧データにはjoinOffsetsが存在しない

                    // ▼▼▼ この行を追加 ▼▼▼
                    // 古いデータ形式との互換性を保つため、generationSettingsがなければ空のオブジェクトとして初期化する
                    appState.generationSettings = appState.generationSettings || {};
                }
                appState.areAnalysisSectionsVisible = false; // 常に閉じた状態で起動
                try {
                    const _pwSaved = localStorage.getItem(LS_KEY_PW);
                    appState.pw = _pwSaved ? { ...PENALTY_DEFAULTS, ...JSON.parse(_pwSaved) } : { ...PENALTY_DEFAULTS };
                } catch (_) { appState.pw = { ...PENALTY_DEFAULTS }; }
            } catch (e) { console.error("Failed to load state:", e); localStorage.removeItem(LS_KEY); }
        }

        function updateAllUI() {
            appState.members = Array.from({ length: appState.currentTotalMemberCount }, (_, i) => appState.members[i] || `${i + 1}`);
            updateMemberCountOptions();
            updateMemberNameInputs();
            updateSpecialRulesUI();
            updateExclusionUI();

            updateMaxConsecutiveOptions();

            const savedValue = appState.maxConsecutiveLimit;
            if (dom.maxConsecutiveSelect && ![...dom.maxConsecutiveSelect.options].some(opt => opt.value == savedValue)) {
                const newOpt = new Option(`${savedValue} 連続 (保存値)`, savedValue);
                dom.maxConsecutiveSelect.appendChild(newOpt);
            }
            if (dom.maxConsecutiveSelect) {
                dom.maxConsecutiveSelect.value = savedValue;
            }

            updateSaveFavoriteButtonState();
            updateExportCsvButtonState();
            renderFavoritesList();
            applyDisplayLogicBasedOnState();
        }

        function handleSurfaceOrMemberCountChange() {
            const prevSurface = appState.currentSurfaceCount;
            appState.currentSurfaceCount = +dom.surfaceCountSelect.value;
            const minMembers = appState.currentSurfaceCount * 4;
            const maxMembers = appState.currentSurfaceCount * 8 + 4;
            let wanted = +dom.totalMemberCountSelect.value;

            if (wanted < minMembers || wanted > maxMembers) {
                wanted = minMembers;
                dom.totalMemberCountSelect.value = wanted;
            }
            if (wanted !== appState.currentTotalMemberCount) {
                appState.currentTotalMemberCount = wanted;
                appState.members = Array.from({ length: wanted }, (_, i) => `${i + 1}`);
                appState.groups = {};
                appState.exclusions = {};
                appState.joins = {};
                appState.joinOffsets = {};
            }
            if (appState.currentSurfaceCount < prevSurface) {
                dom.totalMemberCountSelect.value = minMembers;
                appState.currentTotalMemberCount = minMembers;
                appState.members = Array.from({ length: minMembers }, (_, i) => `${i + 1}`);
                appState.groups = {};
                appState.exclusions = {};
                appState.joins = {};
                appState.joinOffsets = {};
            }

            appState.matches = [];
            appState.completedMatches.clear();
            appState.dataSource = null;
            dom.resultsDashboard.style.display = 'none';

            const P = appState.currentSurfaceCount * 4;
            const N = appState.currentTotalMemberCount;
            let newLimit = DEFAULT_MAX_CONSECUTIVE;
            if (N > P) {
                const Kmin = Math.ceil(P / (N - P));
                newLimit = (Kmin >= 99) ? 99 : Math.min(Kmin + 1, 15);
            } else if (N <= P) {
                newLimit = 99;
            }
            appState.maxConsecutiveLimit = newLimit;

            document.querySelector('input[name="ruleType"][value="none"]').checked = true;
            handleRuleTypeChange();
            updateAllUI();
        }

        function handleMemberNameChange(event) {
            if (event.target.matches('.member-name-input')) {
                const index = parseInt(event.target.dataset.index, 10);
                appState.members[index] = event.target.value.trim() || `${index + 1}`;
                updateSpecialRulesUI();
                updateExclusionUI();
                if (appState.matches.length > 0) renderAllResults();
                saveState();
            }
        }

        function handleMaxConsecutiveChange() {
            appState.maxConsecutiveLimit = parseInt(dom.maxConsecutiveSelect.value, 10);
            updateMaxConsecWarning();
            saveState();
        }

        function updateMaxConsecWarning() {
            if (!dom.maxConsecWarning) return;
            const P = appState.currentSurfaceCount * 4;
            const _exclCount = appState.matches.length > 0 ? Object.keys(appState.exclusions).length : 0;
            // 未到着メンバーは試合枠を消費しないため実効人数から除く
            const _notArrCount = Object.values(appState.joins).filter(v => v === JOIN_NOT_ARRIVED).length;
            const N = appState.currentTotalMemberCount - _exclCount - _notArrCount;
            if (P === 0 || N <= P) { dom.maxConsecWarning.classList.add('hidden'); return; }
            const Kmin = Math.ceil(P / (N - P));
            const selected = appState.maxConsecutiveLimit;
            if (selected === Kmin) {
                dom.maxConsecWarning.classList.remove('hidden');
            } else {
                dom.maxConsecWarning.classList.add('hidden');
            }
        }

        function updateMemberCountOptions() {
            const select = dom.totalMemberCountSelect;
            select.innerHTML = '';
            const minMembers = appState.currentSurfaceCount * 4;
            const maxMembers = appState.currentSurfaceCount * 8 + 4;
            for (let i = minMembers; i <= maxMembers; i++) select.add(new Option(`${i}名`, i)); if
                (appState.currentTotalMemberCount < minMembers || appState.currentTotalMemberCount > maxMembers) {
                select.value = minMembers;
                appState.currentTotalMemberCount = minMembers;
                appState.members = Array.from({ length: minMembers }, (_, i) => `${i + 1}`);
                appState.groups = {};
                appState.exclusions = {};
                appState.joins = {};
                appState.joinOffsets = {};
            }
            select.value = appState.currentTotalMemberCount;
        }

        function updateMemberNameInputs() {
            const { memberNamesSection, memberNamesContainerWrapper, memberNamesContainer, toggleNamesBtn } = dom;
            memberNamesContainer.innerHTML = '';
            if (appState.currentTotalMemberCount > 0) {
                memberNamesSection.classList.remove('hidden');
                appState.members.forEach((name, index) => {
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'input-text member-name-input mt-1 block w-full py-2 px-3 border';
                    input.value = name;
                    input.placeholder = `メンバー ${index + 1}`;
                    input.dataset.index = index;
                    memberNamesContainer.appendChild(input);
                });
                memberNamesContainerWrapper.classList.add('hidden');
                toggleNamesBtn.querySelector('span').textContent = '編集';
            } else {
                memberNamesSection.classList.add('hidden');
            }
        }

        function updateMaxConsecutiveOptions() {
            const sel = dom.maxConsecutiveSelect;
            const P = appState.currentSurfaceCount * 4;
            const _exclCount = appState.matches.length > 0 ? Object.keys(appState.exclusions).length : 0;
            // 未到着メンバーは試合枠を消費しないため実効人数から除く
            const _notArrCount = Object.values(appState.joins).filter(v => v === JOIN_NOT_ARRIVED).length;
            const N = appState.currentTotalMemberCount - _exclCount - _notArrCount;
            sel.innerHTML = '';
            sel.disabled = false;
            appState.forcedInfinity = false;

            if (P === 0 || N === 0) {
                sel.appendChild(new Option('---', DEFAULT_MAX_CONSECUTIVE));
                sel.disabled = true;
            } else if (N <= P) {
                sel.appendChild(new Option('制限なし (∞)', 99));
                sel.disabled = true;
                appState.forcedInfinity = true;
            } else {
                sel.disabled = false;
                let Kmin = Math.ceil(P / (N - P));
                const feasible = [];
                const practicalMaxK = 15;
                for (let k_opt = Kmin; k_opt <= practicalMaxK; k_opt++) {
                    if (N >= Math.ceil(P * (k_opt + 1) / k_opt)) {
                        feasible.push(k_opt);
                    }
                }
                if (feasible.length === 0) feasible.push(Kmin);

                feasible.forEach(k => {
                    if (![...sel.options].some(opt => opt.value == k)) {
                        sel.appendChild(new Option(`${k} 連続まで`, k));
                    }
                });

                if (![...sel.options].some(opt => opt.value == 99)) {
                    sel.appendChild(new Option('制限なし (∞)', 99));
                }

                let calculatedDefaultK = (Kmin >= 99) ? 99 : Kmin + 1;
                calculatedDefaultK = Math.min(calculatedDefaultK, practicalMaxK);

                let valueToSet = calculatedDefaultK;
                if (!feasible.includes(valueToSet)) {
                    valueToSet = feasible.find(f => f >= valueToSet) || feasible[0] || Kmin;
                }

                if (![...sel.options].some(opt => opt.value == valueToSet)) {
                    const recommendedOption = new Option(`★ 推奨: ${valueToSet} 連続`, valueToSet);
                    sel.insertBefore(recommendedOption, sel.firstChild);
                }
            }
            updateMaxConsecWarning();
        }

        function applyDisplayLogicBasedOnState() {
            const hasMatches = appState.matches.length > 0;

            // 各要素が存在するかを確認してから、表示を切り替えるように修正
            if (dom.resultsDashboard) dom.resultsDashboard.classList.toggle('hidden', !hasMatches);
            // 分析パネルはareAnalysisSectionsVisibleフラグに従う（hasMatchesだけで開かない）
            if (dom.analysisSection) dom.analysisSection.classList.toggle('hidden', !hasMatches || !appState.areAnalysisSectionsVisible);
            // 途中参加(joins)は試合生成前でも設定できるため、メンバーがいれば表示する
            // （途中離脱は既存の試合が必要なので、モード側で無効化する）
            if (dom.dropoutSettingsWrapper) dom.dropoutSettingsWrapper.classList.toggle('hidden', appState.currentTotalMemberCount === 0);
            // if (dom.configurationHub) dom.configurationHub.open = !hasMatches; // ← この行をコメントアウトして無効化


            if (hasMatches) {
                renderAllResults();
            } else {
                // 表示をリセットする際のメッセージ表示
                if (dom.matchListContainer) {
                    dom.matchListContainer.innerHTML = '<p class="text-center text-gray-500 py-4">まだ試合が生成されていません。</p>';
                }
            }
        }

        function checkConsecutiveRests(matches, members, exclusions, joins) {
            if (!matches || members.length === 0 || matches.length < 2) {
                // 期待されるデータ構造に合わせて playersInfo を返す
                return { maxStreak: 0, playersInfo: [] };
            }
            const _excl = exclusions || {};
            const _jns = joins || {};

            // 各プレイヤーの連続休憩の最大値とその終了試合を記録する
            const playerStreakDetails = members.map((_, memberIdx) => {
                let maxStreak = 0;
                let currentStreak = 0;
                let endMatch = 0;
                matches.forEach((match, matchIdx) => {
                    // 未参加(未到着)・離脱後の期間は「休憩」ではないため連続休憩に数えない。
                    // ここを数えてしまうと、評価関数が未到着メンバーの長期不在を
                    // 連続休憩違反とみなし、SAが未到着メンバーを出場させる方向に最適化してしまう
                    if (!isPlayerActive(memberIdx, matchIdx + 1, _excl, _jns)) return;
                    if (match.restingPlayers.includes(memberIdx)) {
                        currentStreak++;
                    } else {
                        currentStreak = 0;
                    }
                    if (currentStreak >= maxStreak) {
                        maxStreak = currentStreak;
                        endMatch = matchIdx + 1;
                    }
                });
                return { maxStreak, endMatch };
            });

            // 全体での最大連続休憩数を探す
            const overallMaxStreak = Math.max(0, ...playerStreakDetails.map(d => d.maxStreak));

            // 最大連続休憩数が2未満なら、問題なしとして返す
            if (overallMaxStreak < 2) {
                return { maxStreak: 0, playersInfo: [] };
            }

            // 最大連続休憩数に達したプレイヤーの情報を抽出する
            const playersInfo = [];
            playerStreakDetails.forEach((detail, memberIdx) => {
                if (detail.maxStreak === overallMaxStreak) {
                    playersInfo.push({
                        name: members[memberIdx],
                        endMatch: detail.endMatch,
                    });
                }
            });

            // 期待されるデータ構造で返す
            return { maxStreak: overallMaxStreak, playersInfo: playersInfo };
        }

        function finishGeneration(regenerate) {
            if (!regenerate) {
                appState.dataSource = '新規生成';
                dom.favoritesSelect.value = '';
                // 問題の原因となっていた handleLoadFavorite() の呼び出しを削除
            }
            applyDisplayLogicBasedOnState();
            dom.saveFavoriteButton.disabled = false;
            updateSaveFavoriteButtonState();
            saveState();
        }




        // ═══════════════════════════════════════════════════════════════
        // ⚡ Simulated Annealing による高速探索
        // ═══════════════════════════════════════════════════════════════


        // ルール対応の再ペアリングヘルパー
        // genderMix: 2M+2Fなら M+F vs M+F
        // fixedPair: P1メンバーが2人いれば team1 = [P1,P1] vs team2 = [非P1,非P1]
        function makeCourtRespectingGender(ps, groups, ruleType) {
            const getGrp = p => groups[p] || 'default';
            if (ruleType === 'genderMix') {
                const ms = ps.filter(p => getGrp(p) === 'M');
                const fs = ps.filter(p => getGrp(p) === 'F');
                if (ms.length >= 2 && fs.length >= 2) {
                    const team1 = [ms[0], fs[0]].sort((a, b) => a - b);
                    const team2 = [ms[1], fs[1]].sort((a, b) => a - b);
                    return { team1, team2, players: [...team1, ...team2].sort((a, b) => a - b) };
                }
            }
            if (ruleType === 'fixedPair') {
                const p1s = ps.filter(p => getGrp(p) === 'P1');
                const others = ps.filter(p => getGrp(p) !== 'P1');
                if (p1s.length >= 2 && others.length >= 2) {
                    const team1 = [p1s[0], p1s[1]].sort((a, b) => a - b);
                    const team2 = [others[0], others[1]].sort((a, b) => a - b);
                    return { team1, team2, players: [...team1, ...team2].sort((a, b) => a - b) };
                }
            }
            return {
                team1: [ps[0], ps[1]].sort((a, b) => a - b),
                team2: [ps[2], ps[3]].sort((a, b) => a - b),
                players: ps.slice().sort((a, b) => a - b)
            };
        }

        // ── 近傍解生成（4種類の操作からランダムに選択） ──
        function generateNeighbor(matches, settings) {
            const neighbor = JSON.parse(JSON.stringify(matches));
            const n = neighbor.length;
            if (n < 2) return null;

            // 第1試合（index 0）は絶対に変更しない
            const startIdx = 1;
            if (startIdx >= n) return null;
            const pickMatch = () => startIdx + Math.floor(Math.random() * (n - startIdx));

            const op = Math.random();

            if (op < 0.35) {
                // 操作1: 同じ試合内の2コート間で1人ずつ交換（2コート以上の場合のみ）
                const mi = pickMatch();
                const m = neighbor[mi];
                if (!m.courts || m.courts.length < 2) {
                    // 1コートしかない場合は操作3（休憩交換）に切り替え
                    const _rt1fb = settings.ruleType || 'none';
                    const _grp1fb = settings.groups || appState.groups || {};
                    const _getGrp1fb = i => _grp1fb[i] || 'default';
                    return doSwapWithRest(neighbor, n, startIdx, _rt1fb, _getGrp1fb, settings);
                }
                let c1 = Math.floor(Math.random() * m.courts.length);
                let c2 = Math.floor(Math.random() * m.courts.length);
                while (c2 === c1) c2 = Math.floor(Math.random() * m.courts.length);
                const p1Idx = Math.floor(Math.random() * 4);
                const p2Idx = Math.floor(Math.random() * 4);
                const players1 = [...m.courts[c1].team1, ...m.courts[c1].team2];
                const players2 = [...m.courts[c2].team1, ...m.courts[c2].team2];
                if (players1[p1Idx] === players2[p2Idx]) return null;
                const tmp = players1[p1Idx];
                players1[p1Idx] = players2[p2Idx];
                players2[p2Idx] = tmp;
                const _grp1 = settings.groups || appState.groups || {};
                const _rt1 = settings.ruleType || 'none';
                m.courts[c1] = makeCourtRespectingGender(players1, _grp1, _rt1);
                m.courts[c2] = makeCourtRespectingGender(players2, _grp1, _rt1);
                m.playersThisRound = m.courts.flatMap(c => c.players.slice());

            } else if (op < 0.65) {
                // 操作2: 1コート内の4人で違うペアリング
                const mi = pickMatch();
                const m = neighbor[mi];
                const ci = Math.floor(Math.random() * m.courts.length);
                const ps = [...m.courts[ci].team1, ...m.courts[ci].team2];
                const pairings = [
                    [[ps[0], ps[1]], [ps[2], ps[3]]],
                    [[ps[0], ps[2]], [ps[1], ps[3]]],
                    [[ps[0], ps[3]], [ps[1], ps[2]]]
                ];
                // genderMix/fixedPairの場合: 適切なペアリングのみ選択
                const ruleType = settings.ruleType || 'none';
                const groups = settings.groups || appState.groups || {};
                const getGrp = i => groups[i] || 'default';
                const isValidPairing = (t1, t2) => {
                    if (ruleType === 'genderMix') {
                        const t1m = t1.some(p => getGrp(p) === 'M'), t1f = t1.some(p => getGrp(p) === 'F');
                        const t2m = t2.some(p => getGrp(p) === 'M'), t2f = t2.some(p => getGrp(p) === 'F');
                        return t1m && t1f && t2m && t2f;
                    }
                    if (ruleType === 'fixedPair') {
                        // P1メンバーがコートに2人いる場合: 必ず同じチームに揃える
                        const t1AllP1 = t1.every(p => getGrp(p) === 'P1');
                        const t2AllP1 = t2.every(p => getGrp(p) === 'P1');
                        const allP1Count = t1.filter(p => getGrp(p) === 'P1').length + t2.filter(p => getGrp(p) === 'P1').length;
                        if (allP1Count >= 2) return t1AllP1 || t2AllP1;
                        return true;
                    }
                    return true;
                };
                const validPairings = pairings.filter(([t1, t2]) => isValidPairing(t1, t2));
                if (validPairings.length === 0) return null;
                const sel = validPairings[Math.floor(Math.random() * validPairings.length)];
                m.courts[ci].team1 = sel[0].slice().sort((a, b) => a - b);
                m.courts[ci].team2 = sel[1].slice().sort((a, b) => a - b);

            } else if (op < 0.75) {
                // 操作3: プレイヤーと休憩者を交換
                // genderMixの場合: 同性同士のみ交換（性別バランスを維持）
                const ruleType2 = settings.ruleType || 'none';
                const groups2 = settings.groups || appState.groups || {};
                const getGrp2 = i => groups2[i] || 'default';
                return doSwapWithRest(neighbor, n, startIdx, ruleType2, getGrp2, settings);

            } else if (op < 0.9) {
                // 操作5: 2試合間で休憩者を交換（各人のトータル休憩回数を変えずに
                // 休憩の組み合わせだけを変える。1試合内の交換より違反を起こしにくい）
                const ruleType3 = settings.ruleType || 'none';
                const groups3 = settings.groups || appState.groups || {};
                const getGrp3 = i => groups3[i] || 'default';
                return doSwapRestAcrossRounds(neighbor, n, startIdx, ruleType3, getGrp3, settings);

            } else {
                // 操作4: 試合順序入れ替え（第1試合以外）
                if (n < 3) return null;
                const m1 = pickMatch();
                let m2 = pickMatch();
                while (m2 === m1) m2 = pickMatch();
                [neighbor[m1], neighbor[m2]] = [neighbor[m2], neighbor[m1]];
            }

            // 整合性検証：各試合内でプレイヤー番号が重複していないか
            for (const m of neighbor) {
                const seen = new Set();
                for (const c of m.courts) {
                    for (const p of c.players) {
                        if (seen.has(p)) return null;
                        seen.add(p);
                    }
                }
            }
            return neighbor;
        }

        function doSwapWithRest(neighbor, n, startIdx, ruleType, getGrp, settings) {
            const mi = startIdx + Math.floor(Math.random() * (n - startIdx));
            const m = neighbor[mi];
            if (!m.restingPlayers || m.restingPlayers.length === 0) return null;
            const ci = Math.floor(Math.random() * m.courts.length);
            const playerIdx = Math.floor(Math.random() * 4);
            const ps = [...m.courts[ci].team1, ...m.courts[ci].team2];
            const oldPlayer = ps[playerIdx];

            // 呼び出し元のsettingsスナップショットを優先し、実行中のライブappState変更に影響されないようにする
            const _grpSnapshot = (settings && settings.groups) || appState.groups || {};
            const _scSnapshot = (settings && settings.currentSurfaceCount) || appState.currentSurfaceCount;
            const _exclSw = (settings && settings.exclusions) || appState.exclusions || {};
            const _jnsSw = (settings && settings.joins) || appState.joins || {};

            // restingPlayersには未参加(未到着)・離脱済みの選手も含まれるため、
            // この試合に出場できるアクティブな選手だけをコート投入候補にする
            let candidates = m.restingPlayers.filter(p => isPlayerActive(p, mi + 1, _exclSw, _jnsSw));
            if (ruleType === 'genderMix' && getGrp) {
                const _mSw = Object.values(_grpSnapshot).filter(g => g === 'M').length;
                const _fSw = Object.values(_grpSnapshot).filter(g => g === 'F').length;
                const _isStrictSw = _mSw > _scSnapshot * 2 && _fSw > _scSnapshot * 2;
                if (_isStrictSw) {
                    const oldGroup = getGrp(oldPlayer);
                    candidates = candidates.filter(p => getGrp(p) === oldGroup);
                }
                // best-effortでは全員が候補（性別不問）
            }
            if (candidates.length === 0) return null;
            const restIdx = Math.floor(Math.random() * candidates.length);
            const restPlayer = candidates[restIdx];
            const restOrigIdx = m.restingPlayers.indexOf(restPlayer);
            if (oldPlayer === restPlayer) return null;
            ps[playerIdx] = restPlayer;
            m.restingPlayers = m.restingPlayers.slice();
            m.restingPlayers[restOrigIdx] = oldPlayer;
            m.restingPlayers.sort((a, b) => a - b);
            const _grpRst = (ruleType && getGrp) ? _grpSnapshot : {};
            m.courts[ci] = makeCourtRespectingGender(ps, _grpRst, ruleType || 'none');
            m.playersThisRound = m.courts.flatMap(c => c.players.slice());
            // 整合性チェック
            const seen = new Set();
            for (const c of m.courts) {
                for (const p of c.players) {
                    if (seen.has(p)) return null;
                    seen.add(p);
                }
            }
            return neighbor;
        }

        // 2試合間で休憩者を入れ替える（各人のトータル休憩回数は変わらないため、
        // 連続プレイ・連続休憩の記録を崩さずに「誰と誰が一緒に休むか」だけを変更できる）
        function doSwapRestAcrossRounds(neighbor, n, startIdx, ruleType, getGrp, settings) {
            if (n - startIdx < 2) return null;
            const pick = () => startIdx + Math.floor(Math.random() * (n - startIdx));
            const mi1 = pick();
            let mi2 = pick();
            while (mi2 === mi1) mi2 = pick();
            const m1 = neighbor[mi1], m2 = neighbor[mi2];
            if (!m1.restingPlayers.length || !m2.restingPlayers.length) return null;

            const _exclSw2 = (settings && settings.exclusions) || appState.exclusions || {};
            const _jnsSw2 = (settings && settings.joins) || appState.joins || {};
            // m1で休憩・m2でプレイ中の選手候補（交換後はm1でプレイするため、m1でアクティブな選手のみ）
            let cand1 = m1.restingPlayers.filter(p => m2.playersThisRound.includes(p)
                && isPlayerActive(p, mi1 + 1, _exclSw2, _jnsSw2));
            const _grpSnapshot = (settings && settings.groups) || appState.groups || {};
            const _scSnapshot = (settings && settings.currentSurfaceCount) || appState.currentSurfaceCount;
            const _mSw = Object.values(_grpSnapshot).filter(g => g === 'M').length;
            const _fSw = Object.values(_grpSnapshot).filter(g => g === 'F').length;
            const _isStrictSw = ruleType === 'genderMix' && _mSw > _scSnapshot * 2 && _fSw > _scSnapshot * 2;
            if (cand1.length === 0) return null;
            const p1 = cand1[Math.floor(Math.random() * cand1.length)];

            // m2で休憩・m1でプレイ中の選手候補（genderMix strictでは同性のみ。交換後はm2でプレイするため、m2でアクティブな選手のみ）
            let cand2 = m2.restingPlayers.filter(p => m1.playersThisRound.includes(p) && p !== p1
                && isPlayerActive(p, mi2 + 1, _exclSw2, _jnsSw2));
            if (_isStrictSw && getGrp) {
                cand2 = cand2.filter(p => getGrp(p) === getGrp(p1));
            }
            if (cand2.length === 0) return null;
            const p2 = cand2[Math.floor(Math.random() * cand2.length)];

            // m1: p2(プレイ中)をp1に置き換え
            for (const c of m1.courts) {
                const idx = [...c.team1, ...c.team2].indexOf(p2);
                if (idx === -1) continue;
                const ps = [...c.team1, ...c.team2];
                ps[idx] = p1;
                const _grpRst = (ruleType && getGrp) ? _grpSnapshot : {};
                Object.assign(c, makeCourtRespectingGender(ps, _grpRst, ruleType || 'none'));
                break;
            }
            m1.restingPlayers = m1.restingPlayers.map(p => p === p1 ? p2 : p).sort((a, b) => a - b);
            m1.playersThisRound = m1.courts.flatMap(c => c.players.slice());

            // m2: p1(プレイ中)をp2に置き換え
            for (const c of m2.courts) {
                const idx = [...c.team1, ...c.team2].indexOf(p1);
                if (idx === -1) continue;
                const ps = [...c.team1, ...c.team2];
                ps[idx] = p2;
                const _grpRst = (ruleType && getGrp) ? _grpSnapshot : {};
                Object.assign(c, makeCourtRespectingGender(ps, _grpRst, ruleType || 'none'));
                break;
            }
            m2.restingPlayers = m2.restingPlayers.map(p => p === p2 ? p1 : p).sort((a, b) => a - b);
            m2.playersThisRound = m2.courts.flatMap(c => c.players.slice());

            // 整合性チェック
            for (const m of [m1, m2]) {
                const seen = new Set();
                for (const c of m.courts) {
                    for (const p of c.players) {
                        if (seen.has(p)) return null;
                        seen.add(p);
                    }
                }
            }
            return neighbor;
        }

        // ── 解全体を評価（メタスコア計算） ──
        function evaluateFullSolution(matches, settings) {
            const pw = appState.pw || PENALTY_DEFAULTS;
            const _exclGuard = settings.exclusions != null ? settings.exclusions : appState.exclusions;
            const _jnsGuard = settings.joins != null ? settings.joins : appState.joins;
            const _hasInactive = Object.keys(_exclGuard).length > 0 || Object.keys(_jnsGuard).length > 0;
            // 整合性チェック: 各試合内でプレイヤー番号が重複していないか、
            // および未参加(未到着)・離脱済みの選手が出場していないか（構造的に無効な解は即失格）
            for (let mi = 0; mi < matches.length; mi++) {
                const m = matches[mi];
                const seen = new Set();
                for (const c of m.courts) {
                    for (const p of c.players) {
                        if (seen.has(p)) return -1000000;
                        seen.add(p);
                        if (_hasInactive && !isPlayerActive(p, mi + 1, _exclGuard, _jnsGuard)) return -1000000;
                    }
                }
            }
            // ルール違反チェック / ミックスボーナス計算
            const _rtRest = settings.ruleType || document.querySelector('input[name="ruleType"]:checked')?.value || 'none';
            const _grpEval = settings.groups || appState.groups || {};
            const _scEval = settings.currentSurfaceCount || appState.currentSurfaceCount;
            const _isStrictEval = _rtRest === 'genderMix' && !isGenderMixBestEffort(_grpEval, _scEval);
            let mixBonus = 0;
            if (_rtRest === 'genderMix' && !_isStrictEval) {
                // best-effortモード: ミックス率をボーナスとして加算（SAがミックスを強く優先するよう重みを大きく）
                let mixCourts = 0, totalCourts = 0;
                for (const m of matches) {
                    for (const c of m.courts) {
                        totalCourts++;
                        if (isCandidateCorrectType(c, _rtRest, _grpEval)) mixCourts++;
                    }
                }
                mixBonus = totalCourts > 0 ? (mixCourts / totalCourts) * 150 : 0;
            } else if (_rtRest === 'fixedPair') {
                // fixedPair best-effort: P1が2人揃っているコートだけを分母にする
                // 「片方が休憩」のコートを分母に入れると達成可能上限が40%程度になりSAの勾配が弱くなる
                let okCourts = 0, relevantCourts = 0;
                for (const m of matches) {
                    for (const c of m.courts) {
                        const _p1On = c.players.filter(p => (_grpEval[p] || 'default') === 'P1').length;
                        if (_p1On >= 2) {
                            relevantCourts++;
                            if (isCandidateCorrectType(c, _rtRest, _grpEval)) okCourts++;
                        }
                    }
                }
                // P1が同時出場するコートがない場合は制約自明で満点（ボーナス不要だが勾配が消えないよう満点付与）
                mixBonus = relevantCourts > 0 ? (okCourts / relevantCourts) * 150 : 150;
            } else {
                // strictモードまたは他ルール: ルール違反は即失格
                for (const m of matches) {
                    for (const c of m.courts) {
                        if (!isCandidateCorrectType(c, _rtRest, _grpEval)) return -100000;
                    }
                }
            }
            let penalty = 0;
            // 最大連続プレイ数チェック（超過分をペナルティ化、即失格にしない）
            const _maxConsec = settings.maxConsecutiveLimit || appState.maxConsecutiveLimit || Infinity;
            if (isFinite(_maxConsec)) {
                const _mcLen = settings.members ? settings.members.length : appState.currentTotalMemberCount;
                const _streaks = new Array(_mcLen).fill(0);
                for (const m of matches) {
                    for (let p = 0; p < _mcLen; p++) {
                        if (m.playersThisRound.includes(p)) {
                            _streaks[p]++;
                            if (_streaks[p] > _maxConsec) {
                                penalty -= (_streaks[p] - _maxConsec) * pw.maxPlayStreak;
                            }
                        } else {
                            _streaks[p] = 0;
                        }
                    }
                }
            }
            const restInfo = checkConsecutiveRests(matches, settings.members,
                settings.exclusions != null ? settings.exclusions : appState.exclusions,
                settings.joins != null ? settings.joins : appState.joins);
            // 仕様1-2-3/2-2: 連続休憩ペナルティ
            // 連続休憩は高優先で回避: 表示上限(maxConsecutiveLimit-1)を超えたら厳しくペナルティ
            const _maxRest = settings.maxConsecutiveLimit || appState.maxConsecutiveLimit || 2;
            const _restTol = Math.max(1, _maxRest - 1); // 表示上限と一致させる
            // 仕様1-2-3/2-2: 上限超過ペナルティ
            if (restInfo.maxStreak > _restTol) {
                penalty -= (restInfo.maxStreak - _restTol) * pw.restHard;
            }
            // 連続休憩２以上: ソフトペナルティ（全ルール共通、SAが無視できない大きさに）
            if (restInfo.maxStreak > 1) {
                penalty -= pw.restSoft;
            }
            // プレイヤー間の連続休憩ストリーク差ペナルティ（公平性）
            const _mcLen2 = settings.members ? settings.members.length : appState.currentTotalMemberCount;
            const _indivRestStr = new Array(_mcLen2).fill(0);
            const _maxIndivRest = new Array(_mcLen2).fill(0);
            for (const m of matches) {
                for (let p = 0; p < _mcLen2; p++) {
                    if (m.playersThisRound.includes(p)) {
                        _indivRestStr[p] = 0;
                    } else {
                        _indivRestStr[p]++;
                        if (_indivRestStr[p] > _maxIndivRest[p]) _maxIndivRest[p] = _indivRestStr[p];
                    }
                }
            }
            const _exclForRest = settings.exclusions != null ? settings.exclusions : appState.exclusions;
            const _joinsForRest = settings.joins != null ? settings.joins : appState.joins;
            // 途中離脱・途中参加のいずれかがあり、全試合を通して出場していない選手は
            // ストリーク比較が歪むため対象外にする（両端(第1試合・最終試合)で活動中かで判定）
            const _activeRestStreaks = _maxIndivRest.filter((_, p) =>
                isPlayerActive(p, 1, _exclForRest, _joinsForRest) && isPlayerActive(p, matches.length, _exclForRest, _joinsForRest));
            if (_activeRestStreaks.length > 1) {
                const _restStrMax = Math.max(..._activeRestStreaks);
                const _restStrMin = Math.min(..._activeRestStreaks);
                if (_restStrMax - _restStrMin > 1) {
                    // 差が2以上: -25点/超過分
                    penalty -= (_restStrMax - _restStrMin - 1) * pw.restVariance;
                }
            }
            // 選手間の最大連続プレイ差ペナルティ（公平性：連続プレイのばらつきは最高優先）
            const _pcLen3 = settings.members ? settings.members.length : appState.currentTotalMemberCount;
            const _indivPlayStreak = new Array(_pcLen3).fill(0);
            const _maxIndivPlayStreak = new Array(_pcLen3).fill(0);
            for (const m of matches) {
                for (let p = 0; p < _pcLen3; p++) {
                    if (m.playersThisRound.includes(p)) {
                        _indivPlayStreak[p]++;
                        if (_indivPlayStreak[p] > _maxIndivPlayStreak[p]) _maxIndivPlayStreak[p] = _indivPlayStreak[p];
                    } else {
                        _indivPlayStreak[p] = 0;
                    }
                }
            }
            const _exclForPlay = settings.exclusions != null ? settings.exclusions : appState.exclusions;
            const _joinsForPlay = settings.joins != null ? settings.joins : appState.joins;
            const _activePlayStreaks = _maxIndivPlayStreak.filter((_, p) =>
                isPlayerActive(p, 1, _exclForPlay, _joinsForPlay) && isPlayerActive(p, matches.length, _exclForPlay, _joinsForPlay));
            if (_activePlayStreaks.length > 1) {
                const _playStrMax = Math.max(..._activePlayStreaks);
                const _playStrMin = Math.min(..._activePlayStreaks);
                if (_playStrMax - _playStrMin > 1) {
                    penalty -= (_playStrMax - _playStrMin - 1) * pw.playVariance;
                }
            }
            // プレイ回数バランスペナルティ（軽量・早期フィードバック）
            const _pcLen = settings.members ? settings.members.length : appState.currentTotalMemberCount;
            const _playCnts = new Array(_pcLen).fill(0);
            for (const m of matches) {
                m.playersThisRound.forEach(p => { if (p < _pcLen) _playCnts[p]++; });
            }
            const _exclForPc = settings.exclusions != null ? settings.exclusions : appState.exclusions;
            const _joinsForPc = settings.joins != null ? settings.joins : appState.joins;
            const _joinOffsetsForPc = settings.joinOffsets != null ? settings.joinOffsets : appState.joinOffsets;
            // 途中参加者(按分型): 仮想オフセットを加算してから比較する。
            // 最終試合時点でアクティブなら比較対象（到着済みの途中参加者はオフセット込みで
            // 他メンバーと比較できる）。離脱済み・未到着は最終試合で非アクティブのため除外
            const _activePc = _playCnts
                .map((cnt, i) => cnt + (_joinOffsetsForPc[i] || 0))
                .filter((_, i) => isPlayerActive(i, matches.length, _exclForPc, _joinsForPc));
            if (_activePc.length > 1) {
                const _pcDiff = Math.max(..._activePc) - Math.min(..._activePc);
                if (_pcDiff > 1) penalty -= (_pcDiff - 1) * pw.playCount;
            }

            // genderMixモード: 2M+2FいるのにF+FペアになっているコートにSAが避けるよう重いペナルティ
            if (_rtRest === 'genderMix') {
                const _grpP = settings.groups || appState.groups || {};
                const _getGrpP = p => _grpP[p] || 'default';
                for (const m of matches) {
                    for (const c of m.courts) {
                        const allGrps = c.players.map(_getGrpP);
                        if (allGrps.some(g => g === 'F') && allGrps.some(g => g === 'M')) {
                            const t1AllF = c.team1.map(_getGrpP).every(g => g === 'F');
                            const t2AllF = c.team2.map(_getGrpP).every(g => g === 'F');
                            if (t1AllF || t2AllF) penalty -= pw.genderMixPair;
                        }
                    }
                }
            }
            // fixedPairモード: P1ペアが揃ってコートにいるのに分離されているコートに重いペナルティ
            if (_rtRest === 'fixedPair') {
                const _grpFP = settings.groups || appState.groups || {};
                const _getGrpFP = p => _grpFP[p] || 'default';
                for (const m of matches) {
                    for (const c of m.courts) {
                        const _p1Count = c.players.filter(p => _getGrpFP(p) === 'P1').length;
                        const _nonP1Count = c.players.filter(p => _getGrpFP(p) !== 'P1').length;
                        if (_p1Count >= 2 && _nonP1Count >= 2) {
                            const _t1AllP1 = c.team1.every(p => _getGrpFP(p) === 'P1');
                            const _t2AllP1 = c.team2.every(p => _getGrpFP(p) === 'P1');
                            if (!_t1AllP1 && !_t2AllP1) penalty -= pw.fixedPairSplit;
                        }
                    }
                }
            }
            // 第1試合は表示名順の先頭4人が出場しなければ大ペナルティ
            if (matches.length > 0 && settings.firstMatchPlayers) {
                const _fmp = settings.firstMatchPlayers;
                const _fmActual = matches[0].playersThisRound;
                let _fmOk = true;
                for (const p of _fmp) { if (!_fmActual.includes(p)) { _fmOk = false; break; } }
                if (!_fmOk) penalty -= pw.firstMatch;
            }
            // メインスコア
            const allPairs = settings.allPossiblePairs || appState.allPossiblePairs;
            const excl = settings.exclusions != null ? settings.exclusions : appState.exclusions;
            const jns = settings.joins != null ? settings.joins : appState.joins;
            const jOffs = settings.joinOffsets != null ? settings.joinOffsets : appState.joinOffsets;
            const stats = calculateSummaryStats(
                matches, settings.members, allPairs,
                settings.currentSurfaceCount, excl, _rtRest, _grpEval, jns, jOffs
            );
            return calculateMetaScore(stats) + mixBonus + penalty;
        }


        // ═══════════════════════════════════════════════════════════════
        // ⚡ Simulated Annealing による高速探索
        // ═══════════════════════════════════════════════════════════════
        // ─── 達成率計算（スコアは0〜100点スケール） ──────────────────────
        function calcAchievementRate(score) {
            return Math.min(100, score);
        }


        // ─── 制約仕様書表示 ───────────────────────────────────────────────────
        function showPenaltySettingsDialog() {
            const pw = appState.pw || { ...PENALTY_DEFAULTS };
            const rows = [
                { key: 'playCount',       label: '合計プレイ数差',          unit: '点/差1超過' },
                { key: 'playVariance',    label: '連続プレイ差・選手間',    unit: '点/差1超過' },
                { key: 'restVariance',    label: '連続休憩差・選手間',      unit: '点/差1超過' },
                { key: 'restHard',        label: '連続休憩超過',            unit: '点/回超過' },
                { key: 'restSoft',        label: '連続休憩ソフト(固定)',    unit: '点(streak>1)' },
                { key: 'maxPlayStreak',   label: '連続プレイ上限超過',      unit: '点/回超過' },
                { key: 'genderMixPair',   label: 'genderMix F+Fペア',      unit: '点/コート' },
                { key: 'fixedPairSplit',  label: 'fixedPairペア分離',       unit: '点/コート' },
                { key: 'firstMatch',      label: '第1試合固定',              unit: '点' },
                { key: 'saIter',          label: 'SAイテレーション/再起動', unit: '回' },
                { key: 'saConverge',      label: 'SA収束判定・連続回数',    unit: '回' },
                { key: 'saMinRestart',    label: 'SA収束判定・最低再起動',  unit: '回' },
                { key: 'saMinTime',       label: 'SA収束判定・最低時間割合', unit: '(0〜1)' },
            ];
            const rowsHtml = rows.map(({ key, label, unit }) => `
<tr style="border-bottom:1px solid #f3f4f6;">
  <td style="padding:4px 8px 4px 0;font-size:12px;color:#374151;">${label}</td>
  <td style="padding:4px;font-size:11px;color:#9ca3af;text-align:right;">${PENALTY_DEFAULTS[key]}</td>
  <td style="padding:4px;"><input type="number" id="_pw_${key}" value="${pw[key]}"
    step="${key === 'saMinTime' ? 0.05 : key.startsWith('sa') ? 1 : 5}"
    style="border:1px solid #d1d5db;border-radius:4px;padding:2px 4px;font-size:12px;width:70px;text-align:right;"></td>
  <td style="padding:4px 0 4px 4px;font-size:11px;color:#9ca3af;">${unit}</td>
</tr>`).join('');
            const html = `
<div style="font-size:11px;color:#6b7280;margin-bottom:8px;">⚙️ デバッグボタンをShift+クリックで開く上級設定です。変更はlocalStorageに保存されます。</div>
<table style="border-collapse:collapse;width:100%;">
  <thead><tr>
    <th style="text-align:left;font-size:11px;color:#6b7280;padding-bottom:4px;">項目</th>
    <th style="text-align:right;font-size:11px;color:#9ca3af;padding-right:4px;padding-bottom:4px;">デフォ</th>
    <th style="text-align:right;font-size:11px;color:#6b7280;padding-bottom:4px;">現在値</th>
    <th style="padding-bottom:4px;"></th>
  </tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
<div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">
  <button id="_pw_reset" style="background:#6b7280;color:white;border:none;border-radius:6px;padding:5px 14px;font-size:12px;cursor:pointer;">リセット</button>
  <button id="_pw_save" style="background:#2563eb;color:white;border:none;border-radius:6px;padding:5px 14px;font-size:12px;cursor:pointer;">保存して閉じる</button>
</div>`;
            showDialog('⚙️ ペナルティ調整（上級）', null, null, html);
            setTimeout(() => {
                document.getElementById('_pw_reset')?.addEventListener('click', () => {
                    rows.forEach(({ key }) => {
                        const el = document.getElementById(`_pw_${key}`);
                        if (el) el.value = PENALTY_DEFAULTS[key];
                    });
                });
                document.getElementById('_pw_save')?.addEventListener('click', () => {
                    const newPw = { ...PENALTY_DEFAULTS };
                    rows.forEach(({ key }) => {
                        const el = document.getElementById(`_pw_${key}`);
                        if (!el) return;
                        newPw[key] = key === 'saMinTime' ? parseFloat(el.value) : parseInt(el.value, 10);
                        if (isNaN(newPw[key])) newPw[key] = PENALTY_DEFAULTS[key];
                    });
                    appState.pw = newPw;
                    try { localStorage.setItem(LS_KEY_PW, JSON.stringify(newPw)); } catch (_) {}
                    dom.customDialog.classList.add('hidden');
                });
            }, 50);
        }

        function showSpecDialog() {
            const specHtml = `
<div style="font-size:0.8rem;text-align:left;max-height:70vh;overflow-y:auto;padding:0 4px;">
<h3 style="font-weight:bold;font-size:1rem;margin:8px 0 4px;color:#1e40af;">制約仕様書 v2</h3>
<h4 style="font-weight:bold;margin:10px 0 4px;color:#dc2626;">1. ハード制約（絶対厳守・違反は即失格）</h4>
<b>1-1 コート構成</b><br>
&nbsp;1-1-1: 1コートに必ず4人（2vs2ダブルス形式）<br>
&nbsp;1-1-2: 面数×4人 = 1試合の総出場人数<br><br>
<b>1-2 人数・面数</b><br>
&nbsp;1-2-1: 参加人数 ≥ 面数×4人<br>
&nbsp;1-2-2: 余りの人数が休憩者<br>
&nbsp;1-2-3: 同じ人が連続して休憩しないよう原則制御<br>
&nbsp;1-2-4: <b>最初の試合は必ずアクティブなメンバーの番号順先頭から面数×4人</b>（離脱済み・未到着のメンバーは除く）<br><br>
<b>1-3 対戦カード重複禁止（直近限定）</b><br>
&nbsp;1-3-1: 同じパートナーペア（味方）の連続重複禁止<br>
&nbsp;1-3-2: 同じ対戦相手ペアの連続重複禁止<br>
&nbsp;1-3-3: 同じ4人組（対戦カード全体）の連続重複禁止<br>
<h4 style="font-weight:bold;margin:10px 0 4px;color:#d97706;">2. 優先制約（強く守る・違反はペナルティ大）</h4>
<b>2-1 最大連続プレイ数</b><br>
&nbsp;2-1-1: UI設定値を上限とする<br>
&nbsp;2-1-2: 設定値+1まで許容、それ以上は大ペナルティ<br><br>
<b>2-2 最大連続休憩数</b><br>
&nbsp;2-2-1: UI設定値を上限とする<br>
&nbsp;2-2-2: 設定値+1まで許容<br>
&nbsp;2-2-3: genderMix best-effortモードでは+1の余裕を追加<br><br>
<b>2-3 プレイ回数の公平性</b><br>
&nbsp;2-3-1: 全員の出場回数の差を最小化<br>
&nbsp;2-3-2: genderMix best-effortでは性別内での公平性を優先<br>
&nbsp;2-3-3: best-effortでの男女間差は評価対象外<br>
&nbsp;2-3-4: 途中参加者（joins）は按分型で評価する。参加開始試合（未到着メンバーが
「到着」をタップした時点の次の未消化試合）の直前時点における他メンバーの
理論上の平均累積プレイ数を仮想オフセットとして加算してから比較し、参加後は
同ペースで出場していれば公平とみなす（参加前の分を追いつくために多く
出場させることはしない。総プレイ数は参加が遅い分だけ少なくなるのが正しい）<br>
<h4 style="font-weight:bold;margin:10px 0 4px;color:#16a34a;">3. ソフト制約（スコア最大化）</h4>
<b>3-1 男女ミックス</b><br>
&nbsp;3-1-1: strictモード（男女ともに面数×2超）→ 全試合ミックス必須<br>
&nbsp;3-1-2: best-effortモード（どちらかが面数×2以下）→ ミックス率スコア化（+30点）<br><br>
<b>3-2 ペア多様性（パートナー）</b>: 出現回数均等化・全有効ペア一巡が目標<br>
<b>3-3 対戦相手多様性</b>: 対戦回数均等化<br>
<b>3-4 対戦カード多様性（4人組）</b>: 再登場抑制<br>
<h4 style="font-weight:bold;margin:10px 0 4px;color:#7c3aed;">4. スコア構成（100点満点）</h4>
<table style="border-collapse:collapse;width:100%;font-size:0.75rem;">
<tr style="background:#e5e7eb;"><th style="padding:3px 6px;text-align:left;">項目</th><th style="padding:3px 6px;">制約</th><th style="padding:3px 6px;">配点</th></tr>
<tr><td style="padding:3px 6px;">プレイ公平性</td><td style="padding:3px 6px;text-align:center;">2-3</td><td style="padding:3px 6px;text-align:center;">35点</td></tr>
<tr style="background:#f9fafb;"><td style="padding:3px 6px;">ペア多様性</td><td style="padding:3px 6px;text-align:center;">3-2</td><td style="padding:3px 6px;text-align:center;">20点</td></tr>
<tr><td style="padding:3px 6px;">ペア公平性CV</td><td style="padding:3px 6px;text-align:center;">3-2</td><td style="padding:3px 6px;text-align:center;">20点</td></tr>
<tr style="background:#f9fafb;"><td style="padding:3px 6px;">対戦相手多様性</td><td style="padding:3px 6px;text-align:center;">3-3</td><td style="padding:3px 6px;text-align:center;">15点</td></tr>
<tr><td style="padding:3px 6px;">カード多様性</td><td style="padding:3px 6px;text-align:center;">3-4</td><td style="padding:3px 6px;text-align:center;">10点</td></tr>
<tr style="background:#f9fafb;"><td style="padding:3px 6px;">ミックスボーナス（best-effort）</td><td style="padding:3px 6px;text-align:center;">3-1-2</td><td style="padding:3px 6px;text-align:center;">+30点</td></tr>
</table>
<h4 style="font-weight:bold;margin:10px 0 4px;color:#374151;">5. 用語集</h4>
<b>best-effort</b>: 絶対条件ではなくスコア最大化で近似するモード。genderMix・fixedPairで採用。<br>
<b>グレード</b>: この条件での達成率（スコア÷上限×100%）でS/A/B/C/Dを表示。上限到達時は常にS。<br>
<span style="font-size:0.75rem;color:#9ca3af;">※ ペア・対戦グループ・対戦カードの定義はサマリー各指標の ❓ ボタンを参照</span>
</div>`;
            showDialog('📋 制約仕様書', null, null, specHtml);
        }

        // ─── デバッグログ収集 ────────────────────────────────────────────────
        function collectDebugLog() {
            const groups = appState.groups || {};
            const members = appState.members || [];
            const ruleType = document.querySelector('input[name="ruleType"]:checked')?.value || 'none';
            const surfaces = appState.currentSurfaceCount;
            const memberCount = appState.currentTotalMemberCount;

            // グループ情報
            const groupInfo = members.map((m, i) => `  [${i}] ${m || ('P' + (i + 1))}: ${groups[i] || 'default'}`).join('\n');

            // 離脱情報
            const exclusions = appState.exclusions || {};
            const exclusionEntries = Object.entries(exclusions);
            const exclusionInfo = exclusionEntries.length > 0
                ? exclusionEntries.map(([idx, fromMatch]) => `  [${idx}] ${members[idx] || ('P' + (Number(idx) + 1))}: 第${fromMatch}試合から離脱`).join('\n')
                : '  なし';

            // 途中参加情報（未到着=JOIN_NOT_ARRIVEDと参加済みを区別して表示）
            const joins = appState.joins || {};
            const joinEntries = Object.entries(joins);
            const joinInfo = joinEntries.length > 0
                ? joinEntries.map(([idx, fromMatch]) => {
                    const name = members[idx] || ('P' + (Number(idx) + 1));
                    return fromMatch === JOIN_NOT_ARRIVED
                        ? `  [${idx}] ${name}: 未到着`
                        : `  [${idx}] ${name}: 第${fromMatch}試合から参加`;
                }).join('\n')
                : '  なし';

            // genderMix用の分類
            const males = Array.from({ length: memberCount }, (_, i) => i).filter(i => (groups[i] || 'default') === 'M');
            const females = Array.from({ length: memberCount }, (_, i) => i).filter(i => (groups[i] || 'default') === 'F');

            // 初期解の生成テスト
            let initTestResult = 'N/A';
            if (ruleType === 'genderMix') {
                const settings = {
                    ruleType, groups,
                    currentSurfaceCount: surfaces,
                    currentTotalMemberCount: memberCount,
                    members: [...(appState.members || [])],
                    allPossiblePairs: [...(appState.allPossiblePairs || [])],
                    exclusions: { ...(appState.exclusions || {}) },
                    maxConsecutiveLimit: appState.maxConsecutiveLimit,
                };
                const initSol = generateInitialSolutionForGenderMix(5, settings);
                if (!initSol) {
                    initTestResult = '❌ 初期解生成失敗（null）';
                } else {
                    const isBE = isGenderMixBestEffort(groups, surfaces);
                    const scores = initSol.map(m => {
                        const isValid = m.courts.every(c => isCandidateCorrectType(c));
                        const hasDup = (() => {
                            const seen = new Set();
                            for (const c of m.courts) for (const p of c.players) {
                                if (seen.has(p)) return true;
                                seen.add(p);
                            }
                            return false;
                        })();
                        const validLabel = isValid ? 'valid=true'
                            : isBE ? 'valid=false（best-effort: 正常）'
                                : 'valid=false ⚠️';
                        return `${validLabel} dup=${hasDup}`;
                    });
                    initTestResult = '試合1〜5: ' + scores.join(' / ');
                    if (isBE) initTestResult += '\n※ best-effortモードでは非ミックス試合は許容（仕様3-1-2）';
                }
            }

            // 現在の結果の検証
            let matchValidation = 'マッチなし';
            if (appState.matches && appState.matches.length > 0) {
                const isBE2 = ruleType === 'genderMix' && isGenderMixBestEffort(groups, surfaces);
                const results = appState.matches.slice(0, 5).map((m, i) => {
                    const validRule = m.courts.every(c => isCandidateCorrectType(c));
                    const seen = new Set();
                    let dup = false;
                    for (const c of m.courts) for (const p of c.players) {
                        if (seen.has(p)) dup = true;
                        seen.add(p);
                    }
                    let ruleLabel;
                    if (validRule) {
                        ruleLabel = 'ruleOK=true';
                    } else if (isBE2) {
                        ruleLabel = 'ruleOK=false（best-effort: 正常）';
                    } else if (ruleType === 'fixedPair') {
                        // P1が2人同時出場しているコートがあるか確認
                        const hasP1Pair = m.courts.some(c => {
                            const p1count = c.players.filter(p => (groups[p] || 'default') === 'P1').length;
                            return p1count >= 2;
                        });
                        ruleLabel = hasP1Pair ? 'ruleOK=false ⚠️（P1ペア分離）' : 'ruleOK=N/A（P1片方休憩中・制約対象外）';
                    } else {
                        ruleLabel = 'ruleOK=false ⚠️';
                    }
                    return `第${i + 1}試合: ${ruleLabel} dup=${dup}`;
                });
                matchValidation = results.join('\n');
                if (isBE2) {
                    // コート単位で集計（m.courts.everyだと面数>1かつ少数派の人数が
                    // 全コート分に満たない構成では構造上常に0になり実態を反映しない）
                    let mixCourtCount = 0, totalCourtCount = 0;
                    appState.matches.forEach(m => {
                        m.courts.forEach(c => {
                            totalCourtCount++;
                            if (isCandidateCorrectType(c, 'genderMix', groups)) mixCourtCount++;
                        });
                    });
                    const mixCourtRate = totalCourtCount > 0 ? Math.round(mixCourtCount / totalCourtCount * 100) : 0;
                    matchValidation += `\n※ best-effortモードでは非ミックス試合は許容（仕様3-1-2）`;
                    matchValidation += `\n  ミックスコート率: ${mixCourtCount}/${totalCourtCount}コート (${mixCourtRate}%)`;

                    // 少数派の性別が全員同時出場した試合のうち、実際にミックスコートを作れた試合数
                    const minorityIsMale = males.length <= females.length;
                    const minorityGroup = minorityIsMale ? males : females;
                    const minorityLabel = minorityIsMale ? '男性' : '女性';
                    if (minorityGroup.length > 0) {
                        const minorityPresentMatches = appState.matches.filter(m => minorityGroup.every(p => m.playersThisRound.includes(p)));
                        const mixAchievedMatches = minorityPresentMatches.filter(m => m.courts.some(c => isCandidateCorrectType(c, 'genderMix', groups)));
                        matchValidation += `\n  ${minorityLabel}${minorityGroup.length}人が全員同時出場した試合: ${minorityPresentMatches.length}試合中${mixAchievedMatches.length}試合でミックスコートを形成`;
                    }
                }
                if (ruleType === 'fixedPair') {
                    const p1Matches = appState.matches.filter(m => m.courts.some(c => {
                        const p1count = c.players.filter(p => (groups[p] || 'default') === 'P1').length;
                        return p1count >= 2;
                    }));
                    const p1OkMatches = p1Matches.filter(m => m.courts.every(c => isCandidateCorrectType(c)));
                    if (p1Matches.length > 0) {
                        matchValidation += `\n※ fixedPair同時出場試合: ${p1OkMatches.length}/${p1Matches.length}試合で同チーム（全${appState.matches.length}試合中${p1Matches.length}試合が制約対象）`;
                    } else {
                        matchValidation += `\n※ fixedPair: P1の2人が同時出場する試合なし`;
                    }
                }
            }

            // 連続プレイ・連続休憩の実績
            let playRestStats = 'マッチなし';
            if (appState.matches && appState.matches.length > 0) {
                const playStreaks = new Array(memberCount).fill(0);
                const restStreaks = new Array(memberCount).fill(0);
                const maxPlay = new Array(memberCount).fill(0);
                const maxRest = new Array(memberCount).fill(0);
                appState.matches.forEach((m, matchIdx) => {
                    const matchNumber = matchIdx + 1;
                    for (let p = 0; p < memberCount; p++) {
                        // 離脱後・未参加のあいだは対象外にする（ずっと不出場なだけの期間を
                        // 連続休憩としてカウントしてしまわないようにするため）
                        if (!isPlayerActive(p, matchNumber, appState.exclusions, appState.joins)) continue;
                        if (m.playersThisRound.includes(p)) {
                            playStreaks[p]++; restStreaks[p] = 0;
                        } else {
                            restStreaks[p]++; playStreaks[p] = 0;
                        }
                        maxPlay[p] = Math.max(maxPlay[p], playStreaks[p]);
                        maxRest[p] = Math.max(maxRest[p], restStreaks[p]);
                    }
                });
                const mcLimit = appState.maxConsecutiveLimit || 2;
                const playLimit = mcLimit;
                const restLimit = Math.max(1, mcLimit - 1); // 休憩は1小さい
                const maxRestAll = Math.max(...maxRest);
                const minRestAll = Math.min(...maxRest);
                playRestStats = members.map((m, i) => {
                    const playNG = maxPlay[i] > playLimit ? ' ⚠️NG' : '';
                    const restNG = maxRest[i] > restLimit ? ' ⚠️NG' : '';
                    return `  [${i}] ${m || 'P' + (i + 1)}: 最大連続プレイ=${maxPlay[i]}${playNG}(上限${playLimit}) 最大連続休憩=${maxRest[i]}${restNG}(上限${restLimit})`;
                }).join('\n');
                if (maxRestAll - minRestAll > 1) {
                    playRestStats += `\n  ⚠️ 連続休憩の偏り: 最大${maxRestAll} - 最小${minRestAll} = 差${maxRestAll - minRestAll}（仕様上は差1以内推奨）`;
                }
            }

            // genderMix best-effortモード判定
            const bestEffortMode = ruleType === 'genderMix'
                ? isGenderMixBestEffort(groups, surfaces)
                : null;

            // 休憩ペアの偏り（同じ顔ぶれが繰り返し一緒に休んでいないか）
            let restPairInfo = 'マッチなし';
            if (appState.matches && appState.matches.length > 0) {
                const restPairUsage = calculateRestPairUsageCounts(appState.matches, memberCount, appState.exclusions, appState.joins);
                const cvRestPair = calcCV(Object.values(restPairUsage));
                const restRoster = appState.matches.map((m, i) => {
                    const names = m.restingPlayers.map(p => members[p] || ('P' + (p + 1))).join(',');
                    return `  第${i + 1}試合: [${names}]`;
                }).join('\n');
                restPairInfo = `変動係数(CV)=${cvRestPair.toFixed(3)}（0に近いほど休憩ペアが分散、大きいほど同じ顔ぶれが繰り返し休憩）\n${restRoster}`;
            }

            const log = [
                '=== デバッグログ ===',
                `日時: ${new Date().toLocaleString()}`,
                `条件: ${surfaces}面 ${memberCount}人 ルール:${ruleType}`,
                ruleType === 'genderMix' ? `genderMixモード: ${bestEffortMode ? 'best-effort（公平性優先）' : 'strict（全試合ミックス必須）'}` : '',
                `maxConsecutiveLimit: ${appState.maxConsecutiveLimit}`,
                '',
                '【メンバー・グループ】',
                groupInfo,
                `男性(M): [${males.join(',')}]`,
                `女性(F): [${females.join(',')}]`,
                `default(未設定): [${Array.from({ length: memberCount }, (_, i) => i).filter(i => !groups[i] || groups[i] === 'default').join(',')}]`,
                '',
                '【離脱情報】',
                exclusionInfo,
                '',
                '【参加情報】',
                joinInfo,
                '',
                '【isCandidateCorrectTypeテスト】',
                `ruleType取得: ${ruleType}`,
                '',
                '【初期解生成テスト(最初の5試合)】',
                initTestResult,
                '',
                '【現在のマッチ検証(最初の5試合)】',
                matchValidation,
                '',
                '【連続プレイ・連続休憩の実績（全メンバー）】',
                playRestStats,
                '',
                '【休憩ペアの偏り（全試合）】',
                restPairInfo,
                '',
                '【lastRunAnalysis】',
                appState.lastRunAnalysis ? JSON.stringify({
                    attempts: appState.lastRunAnalysis.attempts,
                    validAttempts: appState.lastRunAnalysis.validAttempts,
                    bestMetaScore: appState.lastRunAnalysis.bestMetaScore,
                    converged: appState.lastRunAnalysis.converged,
                    conclusionText: appState.lastRunAnalysis.conclusionText,
                }, null, 2) : 'なし',
            ].filter(l => l !== null).join('\n');

            // クリップボードへコピー（showDialogより前に実行してfocusトラップを回避）
            const _ta = document.createElement('textarea');
            _ta.style.position = 'fixed';
            _ta.style.opacity = '0';
            _ta.value = log;
            document.body.appendChild(_ta);
            _ta.focus();
            _ta.select();
            try { document.execCommand('copy'); } catch (e) { }
            document.body.removeChild(_ta);

            // ダイアログに表示（preタグで改行を保持）
            // ダイアログ表示（コピーボタン付き）
            window._debugLogText = log; // コピー用に保存
            showDialog('🪲 デバッグログ', null, null,
                `<div style="text-align:right;margin-bottom:4px;">
                  <button id="_debugCopyBtn"
                    style="font-size:0.75rem;padding:3px 10px;background:#e5e7eb;border:1px solid #d1d5db;border-radius:4px;cursor:pointer;">📋 コピー</button>
                </div>
                <pre style="white-space:pre-wrap;font-size:0.75rem;text-align:left;max-height:55vh;overflow-y:auto;word-break:break-all;">${log.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`
            );
            // ダイアログ描画後にボタンのイベントを設定
            setTimeout(() => {
                const btn = document.getElementById('_debugCopyBtn');
                if (btn) {
                    btn.addEventListener('click', () => {
                        const ta = document.createElement('textarea');
                        ta.style.position = 'fixed'; ta.style.opacity = '0';
                        ta.value = window._debugLogText || '';
                        document.body.appendChild(ta);
                        ta.focus(); ta.select();
                        try { document.execCommand('copy'); } catch (e) { }
                        document.body.removeChild(ta);
                        btn.textContent = '✅ コピー済';
                        setTimeout(() => { btn.textContent = '📋 コピー'; }, 1500);
                    });
                }
            }, 50);
            console.log(log);
        }

        async function findBestBySimulatedAnnealing() {
            appState.exclusions = {};
            // 途中参加(joins)は生成のたびに再計算する（生成前設定・条件変更後も常に最新化される）
            recalculateAllJoinOffsets();
            const targetMatchCount = parseInt(document.getElementById('matchCountSelect').value, 10);
            if (appState.currentTotalMemberCount < appState.currentSurfaceCount * 4) {
                showDialog('エラー', 'メンバーが足りません。\\n試合を生成するには、少なくとも' + (appState.currentSurfaceCount * 4) + '人のメンバーが必要です。');
                return;
            }

            const userAttempts = parseInt(document.getElementById('attemptCountSelect').value, 10);
            const timeLimitSec = parseInt(document.getElementById('timeLimitSelect')?.value || '30');
            // 目標スコア = 条件別上限スコアを自動計算
            const currentRuleType = document.querySelector('input[name="ruleType"]:checked')?.value || 'none';
            const ceilingData = calcConditionCeiling(
                appState.currentSurfaceCount,
                getEffectiveMemberCountForCeiling(),
                targetMatchCount,
                currentRuleType,
                appState.groups
            );
            // SA目標値はmixBonus除いたベーススコアを使用
            // （mixBonusは条件依存で上限まで届かないため）
            const targetRate = ceilingData.totalBase ?? ceilingData.total;
            // 時間制限まで探索し続ける（収束したら早期終了）
            const ITER_PER_RESTART = appState.pw?.saIter ?? 200;
            const TOTAL_ITERATIONS = Infinity;
            const RESTART_COUNT = Infinity;

            dom.loadingIndicator.style.display = 'block';

            const originalSettings = {
                matchCount: targetMatchCount,
                currentSurfaceCount: appState.currentSurfaceCount,
                currentTotalMemberCount: appState.currentTotalMemberCount,
                maxConsecutiveLimit: appState.maxConsecutiveLimit,
                groups: JSON.parse(JSON.stringify(appState.groups)),
                ruleType: document.querySelector('input[name="ruleType"]:checked').value,
                members: [...appState.members],
                exclusions: { ...appState.exclusions },
                joins: { ...appState.joins },
                joinOffsets: { ...appState.joinOffsets },
            };
            // 第1試合に出場すべきプレイヤー（アクティブなメンバーの登録順先頭4人）を
            // 事前計算してsettingsに保持。途中参加者は参加前の第1試合には出せないため、
            // 全メンバーではなくアクティブなメンバーからのみ選ぶ
            {
                const _sf = originalSettings.currentSurfaceCount;
                const _n = originalSettings.currentTotalMemberCount;
                const _allMembers = Array.from({ length: _n }, (_, i) => i);
                const _sorted = _allMembers.filter(i => isPlayerActive(i, 1, originalSettings.exclusions, originalSettings.joins));
                const _fmTop4Arr = _sorted.slice(0, _sf * 4);
                originalSettings.firstMatchPlayers = new Set(_fmTop4Arr);
                // restingPlayers相当は「選ばれなかった全メンバー」（アクティブな休憩者 + 未参加・離脱済み）にする
                originalSettings.firstMatchRest = _allMembers.filter(i => !_fmTop4Arr.includes(i));
                originalSettings.firstMatchSortedTop4 = _fmTop4Arr;
            }

            regenerateAllPossiblePairs();

            // ★ mixBonus事前計算ヘルパー
            // ★ mixBonusヘルパー（SA内部高速計算用）
            function _calcMixBonus(solution, settings) {
                if (settings.ruleType !== 'genderMix') return 0;
                if (!isGenderMixBestEffort(settings.groups, settings.currentSurfaceCount)) return 0;
                let mixCourts = 0, totalCourts = 0;
                for (const m of solution) {
                    for (const c of m.courts) {
                        totalCourts++;
                        if (isCandidateCorrectType(c, settings.ruleType, settings.groups)) mixCourts++;
                    }
                }
                return totalCourts > 0 ? (mixCourts / totalCourts) * 30 : 0;
            }
            let cachedMixBonus = 0;

            let bestSolution = null;
            let bestScore = -Infinity;
            const allScores = [];
            let totalIters = 0;
            let lastImprovement = 0;
            let lastImprovementRestart = 0;
            const startTime = performance.now();

            let restart = 0;
            let reachedTarget = false;
            let stagnated = false; // 改善停止による早期終了（=これ以上回しても改善しないと判断した状態）
            while (true) {
                // 終了条件チェック
                const elapsedSoFar = (performance.now() - startTime) / 1000;
                if (elapsedSoFar >= timeLimitSec) {
                    dom.loadingMessage.textContent = `⏱️ 時間制限到達 (${elapsedSoFar.toFixed(1)}秒)`;
                    await new Promise(r => setTimeout(r, 200));
                    break;
                }
                if (targetRate > 0 && bestSolution && totalIters % 500 === 0) {
                    const tmpStats = calculateSummaryStats(bestSolution, originalSettings.members, appState.allPossiblePairs, originalSettings.currentSurfaceCount, originalSettings.exclusions, originalSettings.ruleType, originalSettings.groups, originalSettings.joins, originalSettings.joinOffsets);
                    const gradeScore = calcOverallGrade(tmpStats, bestSolution, originalSettings.members, appState.allPossiblePairs, cachedMixBonus).totalBase;
                    if (gradeScore >= targetRate) {
                        reachedTarget = true;
                        dom.loadingMessage.textContent = `🎯 目標達成！総合グレードスコア ${gradeScore}点 ≥ ${targetRate}点`;
                        await new Promise(r => setTimeout(r, 300));
                        break;
                    }
                    // 95%以上かつスコアが安定 → 近似最良解として早期終了
                    if (gradeScore >= targetRate * 0.95 && allScores.length >= 3) {
                        const _nearEps = Math.max(0.2, Math.abs(bestScore) * 0.01);
                        if (allScores.slice(-3).every(s => Math.abs(s - bestScore) < _nearEps)) {
                            reachedTarget = true;
                            dom.loadingMessage.textContent = `✅ 近似最良解 ${gradeScore}点 (目標${targetRate}点の${(gradeScore / targetRate * 100).toFixed(0)}%)`;
                            await new Promise(r => setTimeout(r, 300));
                            break;
                        }
                    }
                }
                if (targetRate === 0 && restart >= RESTART_COUNT) break;

                const _remaining = Math.max(0, timeLimitSec - elapsedSoFar).toFixed(0);
                dom.loadingMessage.textContent = `🔥 探索中... あと最大${_remaining}秒`;
                await new Promise(r => setTimeout(r, 0));

                let current = (restart === 0)
                    ? generateBlockRotationSeed(targetMatchCount, originalSettings)
                    : null;
                if (!current) current = await generateInitialSolution(targetMatchCount, originalSettings);
                if (!current || current.length < targetMatchCount) { restart++; continue; }
                // genderMix/fixedPair: 初期解の不適切なペアリングを修正（パターン由来のF+F/P1分離を除去）
                if (originalSettings.ruleType === 'genderMix' || originalSettings.ruleType === 'fixedPair') {
                    const _grpFix = originalSettings.groups || appState.groups || {};
                    for (const _m of current) {
                        for (let _ci = 0; _ci < _m.courts.length; _ci++) {
                            const _ps = [..._m.courts[_ci].team1, ..._m.courts[_ci].team2];
                            _m.courts[_ci] = makeCourtRespectingGender(_ps, _grpFix, originalSettings.ruleType);
                        }
                    }
                }
                let currentScore = evaluateFullSolution(current, originalSettings);
                let bestScoreThisRestart = currentScore;  // このリスタートのベスト

                // 変更後
                if (currentScore > bestScore) {
                    bestScore = currentScore;
                    bestSolution = JSON.parse(JSON.stringify(current));
                    lastImprovement = totalIters;
                    lastImprovementRestart = restart;
                    // ★ mixBonusキャッシュ更新
                    cachedMixBonus = _calcMixBonus(current, originalSettings);
                }
                //const itersPerRes

                const itersPerRestart = ITER_PER_RESTART;
                let T = 5.0;
                const T_MIN = 0.01;
                const COOLING = Math.pow(T_MIN / T, 1 / itersPerRestart);

                for (let i = 0; i < itersPerRestart; i++) {
                    totalIters++;
                    if (i % 500 === 0) {
                        const _rem = Math.max(0, timeLimitSec - (performance.now() - startTime) / 1000).toFixed(0);
                        dom.loadingMessage.textContent = `🔥 探索中... あと最大${_rem}秒`;
                        await new Promise(r => setTimeout(r, 0));

                        // 時間制限チェック（内側ループでも）
                        if ((performance.now() - startTime) / 1000 >= timeLimitSec) break;
                    }

                    const neighbor = generateNeighbor(current, originalSettings);
                    if (!neighbor) continue;

                    const neighborScore = evaluateFullSolution(neighbor, originalSettings);
                    const delta = neighborScore - currentScore;

                    if (delta > 0 || Math.random() < Math.exp(delta / T)) {
                        current = neighbor;
                        currentScore = neighborScore;
                        if (currentScore > bestScoreThisRestart) bestScoreThisRestart = currentScore;
                        // 変更後
                        if (currentScore > bestScore) {
                            bestScore = currentScore;
                            bestSolution = JSON.parse(JSON.stringify(current));
                            lastImprovement = totalIters;
                            lastImprovementRestart = restart;
                            // ★ mixBonusキャッシュ更新
                            cachedMixBonus = _calcMixBonus(current, originalSettings);
                        }
                    }
                    T *= COOLING;
                }
                allScores.push(bestScoreThisRestart);  // 最終スコアでなくリスタート中のベストを記録
                restart++;

                // 収束判定：直近N回が同スコア かつ 時間・リスタート数の最低ラインを超えた場合のみ
                const CONVERGE_COUNT = appState.pw?.saConverge ?? 5;
                const MIN_RESTARTS_CONVERGE = appState.pw?.saMinRestart ?? 10;
                const MIN_TIME_FRAC_CONVERGE = appState.pw?.saMinTime ?? 0.4;
                const _elapsedFracConv = (performance.now() - startTime) / 1000 / timeLimitSec;
                const CONVERGE_EPS = Math.max(0.1, Math.abs(bestScore) * 0.005);
                if (allScores.length >= CONVERGE_COUNT
                    && allScores.length >= MIN_RESTARTS_CONVERGE
                    && _elapsedFracConv >= MIN_TIME_FRAC_CONVERGE) {
                    const recent = allScores.slice(-CONVERGE_COUNT);
                    const converged = recent.every(s => Math.abs(s - bestScore) < CONVERGE_EPS);
                    if (converged) {
                        dom.loadingMessage.textContent = `✅ 収束検出 - ${CONVERGE_COUNT}回連続で同じ結果(${bestScore.toFixed(1)}点) → これが最良解`;
                        await new Promise(r => setTimeout(r, 500));
                        break;
                    }
                }

                // 改善停止チェック（時間ベース: 制限時間の80%を使ってから初めて有効化）
                // ユーザーが指定した思考時間は基本的に使い切る。早期終了は真の収束(3-in-a-row)に任せる
                const _elapsedFracEnd = (performance.now() - startTime) / 1000 / timeLimitSec;
                if (_elapsedFracEnd >= 0.8 && allScores.length >= 5 && restart - lastImprovementRestart >= 20) {
                    stagnated = true; // これ以上回しても改善しないと判断 → 収束扱い
                    dom.loadingMessage.textContent = `✅ 収束 - ${restart}回探索して改善なし (経過${(_elapsedFracEnd*100).toFixed(0)}%)`;
                    await new Promise(r => setTimeout(r, 200));
                    break;
                }

                // 目標なしの場合: イテレーション停止チェック
                if (targetRate === 0 && totalIters - lastImprovement > 500) {
                    dom.loadingMessage.textContent = `✅ 改善停止 - 早期終了 (${totalIters}回)`;
                    await new Promise(r => setTimeout(r, 200));
                    break;
                }
            }

            // 第1試合の参加者が若い番号になるようにリナンバー（ミックスルール以外）。
            // joins/exclusionsがある場合はスキップ: これらはプレイヤー番号をキーに持つが
            // リナンバーに追従させていないため、実行すると別人に紐付いてしまう
            // （現行フローでは未到着・参加者は末尾番号のため恒等置換となりスキップと同じだが防御的に明示）
            if (bestSolution && originalSettings.ruleType !== 'genderMix'
                && Object.keys(originalSettings.joins || {}).length === 0
                && Object.keys(originalSettings.exclusions || {}).length === 0) {
                const _p0 = [...bestSolution[0].playersThisRound].sort((a, b) => a - b);
                const _r0 = [...bestSolution[0].restingPlayers].sort((a, b) => a - b);
                const _ord = [..._p0, ..._r0]; // 第1試合参加者が先頭（低い番号）になる順
                console.log('[renumber] p0=', _p0, 'r0=', _r0, 'ord=', _ord, 'alreadySorted=', _ord.every((v, i) => v === i));
                if (!_ord.every((v, i) => v === i)) { // すでに順番通りなら何もしない
                    const _perm = new Array(_ord.length);
                    _ord.forEach((oldIdx, newIdx) => { _perm[oldIdx] = newIdx; });
                    bestSolution = bestSolution.map(m => ({
                        ...m,
                        playersThisRound: m.playersThisRound.map(i => _perm[i]),
                        restingPlayers:   m.restingPlayers.map(i => _perm[i]),
                        courts: m.courts.map(c => ({
                            ...c,
                            team1: c.team1.map(i => _perm[i]),
                            team2: c.team2.map(i => _perm[i]),
                        })),
                    }));
                    // groups（性別・固定ペア等のインデックス依存データ）はプレイヤーの入れ替えに
                    // 必ず追従させる。追従させないと、リナンバー後にP1/M/F等のタグが
                    // 別人に付いてしまう（固定ペア判定・混合ペア判定が壊れる）。
                    if (originalSettings.groups && Object.keys(originalSettings.groups).length > 0) {
                        const _newGroups = {};
                        Object.entries(originalSettings.groups).forEach(([oldIdxStr, g]) => {
                            _newGroups[_perm[Number(oldIdxStr)]] = g;
                        });
                        originalSettings.groups = _newGroups;
                        appState.groups = { ..._newGroups };
                    }
                    // デフォルト名（1...N、Pなしの連番）の場合: 名前は並び替えない
                    // → 新インデックス0は"1"のまま、2は"3"のまま → 第1試合が1,2,...と表示される
                    // カスタム名の場合: 名前も並び替えてプレイヤー同一性を保持（見た目は変わらないが整合性維持）
                    console.log('[renumber] perm=', _perm, 'round1after=', bestSolution[0].playersThisRound);
                    const _allDefault = originalSettings.members.every((n, i) => n === `${i + 1}`);
                    console.log('[renumber] allDefault=', _allDefault);
                    if (!_allDefault) {
                        const _newMembers = new Array(originalSettings.members.length);
                        _ord.forEach((oldIdx, newIdx) => { _newMembers[newIdx] = originalSettings.members[oldIdx]; });
                        originalSettings.members = _newMembers;
                        appState.members = [..._newMembers];
                    }
                }
            }

            if (bestSolution) {
                // 最終安全処理: genderMix/fixedPairで不適切なペアリングが残っていたら強制修正
                if (originalSettings.ruleType === 'genderMix' || originalSettings.ruleType === 'fixedPair') {
                    const _grpFF = originalSettings.groups || appState.groups || {};
                    const _getGrpFF = p => _grpFF[p] || 'default';
                    for (const _m of bestSolution) {
                        for (let _ci = 0; _ci < _m.courts.length; _ci++) {
                            const _c = _m.courts[_ci];
                            let _needFix = false;
                            if (originalSettings.ruleType === 'genderMix') {
                                const _t1AllF = _c.team1.every(p => _getGrpFF(p) === 'F');
                                const _t2AllF = _c.team2.every(p => _getGrpFF(p) === 'F');
                                _needFix = (_t1AllF || _t2AllF) && _c.players.some(p => _getGrpFF(p) === 'M');
                            } else if (originalSettings.ruleType === 'fixedPair') {
                                const _p1Count = _c.players.filter(p => _getGrpFF(p) === 'P1').length;
                                const _nonP1Count = _c.players.filter(p => _getGrpFF(p) !== 'P1').length;
                                const _t1AllP1 = _c.team1.every(p => _getGrpFF(p) === 'P1');
                                const _t2AllP1 = _c.team2.every(p => _getGrpFF(p) === 'P1');
                                _needFix = _p1Count >= 2 && _nonP1Count >= 2 && !_t1AllP1 && !_t2AllP1;
                            }
                            if (_needFix) {
                                const _ps = [..._c.team1, ..._c.team2];
                                _m.courts[_ci] = makeCourtRespectingGender(_ps, _grpFF, originalSettings.ruleType);
                            }
                        }
                    }
                }
                appState.matches = bestSolution;
                appState.generationSettings = { groups: originalSettings.groups, ruleType: originalSettings.ruleType };

                const stats = calculateSummaryStats(bestSolution, originalSettings.members, appState.allPossiblePairs, originalSettings.currentSurfaceCount, originalSettings.exclusions, originalSettings.ruleType, originalSettings.groups, originalSettings.joins, originalSettings.joinOffsets);
                const restInfo = checkConsecutiveRests(bestSolution, originalSettings.members, originalSettings.exclusions, originalSettings.joins);
                let metaScore = calculateMetaScore(stats);
                // 仕様2-2: 連続休憩ペナルティ（evaluateFullSolutionと全く同じ式に統一）
                const _repPw = appState.pw || PENALTY_DEFAULTS;
                const _repMaxRest = originalSettings.maxConsecutiveLimit || appState.maxConsecutiveLimit || 2;
                const _repRestTol = Math.max(1, _repMaxRest - 1);
                if (restInfo.maxStreak > _repRestTol) {
                    metaScore -= (restInfo.maxStreak - _repRestTol) * _repPw.restHard;
                }
                if (restInfo.maxStreak > 1) {
                    metaScore -= _repPw.restSoft;
                }

                const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
                const avg = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
                const stdDev = calculateStandardDeviation(allScores, avg);

                // 収束判定（相対閾値: bestScoreの0.5%または0.1の大きい方）
                // 改善停止による早期終了(stagnated)も「これ以上改善しない」という意味で収束扱いにする
                const CONV_EPS = Math.max(0.1, Math.abs(bestScore) * 0.005);
                const converged = stagnated || (allScores.length >= 3 &&
                    allScores.slice(-3).every(s => Math.abs(s - bestScore) < CONV_EPS));

                appState.lastRunAnalysis = {
                    attempts: userAttempts,
                    validAttempts: allScores.length,
                    bestMetaScore: metaScore,
                    averageScore: avg,
                    stdDev: stdDev,
                    converged: converged,
                    reachedTarget: reachedTarget,
                    conclusionText: `⚡ アニーリング探索完了：${totalIters}回の評価を ${elapsed}秒で実行 / 達成率: ${calcAchievementRate(metaScore).toFixed(1)}%${reachedTarget ? ' 🎯目標達成' : ''}${converged ? ' ✅収束済み' : ''} `,
                    bestResult: { matches: bestSolution, stats: stats, metaScore: metaScore, settings: originalSettings },
                    method: 'sa',
                    iterations: totalIters,
                    elapsedSec: elapsed
                };

                // 総合グレード計算
                const gradeForReport = calcOverallGrade(stats, bestSolution, originalSettings.members, appState.allPossiblePairs, cachedMixBonus);

                // 条件ごとの実測ベストを更新（理論上限が構造的に到達不能な条件でも、
                // 過去の実績と比較して「これ以上は現実的に望めない」を判断できるようにする）
                const _empiricalEntry = updateEmpiricalBest(originalSettings, gradeForReport.totalBase);

                appState.lastRunAnalysis.reportText = `グレード: ${gradeForReport.grade} ${gradeForReport.total}点 / ${elapsed}秒 / ${totalIters}回評価`;
                appState.dataSource = '⚡ アニーリング探索';
                appState.areAnalysisSectionsVisible = false;
                regenerateAllPossiblePairs();
                pushStateToHistory();
                updateAllUI();

                // ── 簡潔な結果ダイアログ ─────────────────────────────────────
                const _pct = targetRate > 0 ? gradeForReport.totalBase / targetRate : 1;
                const _pctInt = Math.round(_pct * 100);
                // 達成率ベースの相対グレード（この条件でどれだけ良い解か）
                let _relGrade, _relColor, _relStars;
                if (_pctInt >= 95) { _relGrade = 'S'; _relColor = '#16a34a'; _relStars = '★★★★★'; }
                else if (_pctInt >= 88) { _relGrade = 'A'; _relColor = '#2563eb'; _relStars = '★★★★☆'; }
                else if (_pctInt >= 78) { _relGrade = 'B'; _relColor = '#7c3aed'; _relStars = '★★★☆☆'; }
                else if (_pctInt >= 65) { _relGrade = 'C'; _relColor = '#d97706'; _relStars = '★★☆☆☆'; }
                else { _relGrade = 'D'; _relColor = '#dc2626'; _relStars = '★☆☆☆☆'; }

                // 再試行推奨の判定は優先順(a)>(b)>(c)>(d)で行う
                // (a) 理論上限との差1点以内
                const _reachedCeilDialog = targetRate > 0 && (targetRate - gradeForReport.totalBase) <= 1.0;
                // (b) 同条件の実測ベストとの差1点以内 かつ 過去3回以上の記録がある
                const _empiricalGap = Math.max(0, _empiricalEntry.bestScore - gradeForReport.totalBase);
                const _empiricalReached = _empiricalEntry.runCount >= 3 && _empiricalGap <= 1.0;
                const _practicalBestReached = _reachedCeilDialog || _empiricalReached;
                if (_practicalBestReached && _relGrade !== 'S') {
                    _relGrade = 'S'; _relColor = '#16a34a'; _relStars = '★★★★★';
                }
                let _verdict, _action, _verdictColor;
                if (_relGrade === 'S') {
                    if (_reachedCeilDialog) {
                        _verdict = '✅ この条件での最高スコア — 再試行不要';
                    } else if (_empiricalReached) {
                        _verdict = `✅ 過去${_empiricalEntry.runCount}回の実測ベスト(${_empiricalEntry.bestScore.toFixed(1)}点)と同等 — 再試行不要`;
                    } else {
                        _verdict = '✅ S評価達成 — 再試行不要';
                    }
                    _action = 'このままご利用いただけます。';
                    _verdictColor = '#16a34a';
                } else if (_pctInt >= 78) {
                    // (c) 収束(改善停止含む) かつ 上限比88%以上
                    if (converged && _pctInt >= 88) {
                        _verdict = '✅ この条件での上限付近です — 再試行しても大きな改善は見込めません';
                        _action = '試合数を増やすか、人数を増やすとSランクが出やすくなります。';
                        _verdictColor = '#059669';
                    } else {
                        // (d)
                        _verdict = '🔄 もう1〜2回試すとさらに良くなる可能性があります';
                        _action = '再度実行して比較してみてください。';
                        _verdictColor = '#2563eb';
                    }
                } else {
                    // (d)
                    _verdict = '⚠️ まだ改善の余地があります。再試行を推奨します';
                    _action = '設定の連続制限や試合数を緩和することで大きく改善する可能性があります。';
                    _verdictColor = '#dc2626';
                }
                // 実測ベスト行（過去に1回以上の記録がある場合のみ表示）
                const _empiricalRow = _empiricalEntry.runCount > 0
                    ? `<div class="flex justify-between text-sm text-gray-500 py-1 border-b">
                         <span>実測ベスト</span><span class="font-semibold">${_empiricalEntry.bestScore.toFixed(1)}点 <span class="text-xs text-gray-400 font-normal">(過去${_empiricalEntry.runCount}回)</span></span>
                       </div>`
                    : '';
                // 上限行(targetRate)はmixBonus抜きなので、並べて比較する「今回の結果」も同じ基準(totalBase)で揃える
                const _ceilRow = targetRate > 0
                    ? `<div class="flex justify-between text-sm text-gray-500 py-1 border-b">
                         <span>この条件での上限</span><span class="font-semibold">${targetRate}点</span>
                       </div>
                       ${_empiricalRow}
                       <div class="flex justify-between text-sm py-1 border-b">
                         <span>今回の結果</span><span class="font-semibold">${gradeForReport.totalBase}点</span>
                       </div>`
                    : `<div class="text-center text-sm py-1 border-b">今回の結果: <strong>${gradeForReport.total}点</strong></div>`;
                const _dialogHtml = `
<div class="px-1">
  ${_ceilRow}
  <div class="text-center py-3">
    <div class="text-5xl font-bold leading-none" style="color:${_relColor}">${_relGrade}</div>
    <div class="text-2xl font-semibold mt-1">${_pctInt}% ${_relStars}</div>
  </div>
  <div class="p-2 rounded text-sm font-medium text-center" style="background:#f3f4f6;color:${_verdictColor}">
    ${_verdict}
  </div>
  <p class="mt-2 text-sm text-gray-600 text-center">${_action}</p>
</div>`;
                showDialog('探索完了', null, null, _dialogHtml);
                if (_relGrade === 'S' || _reachedCeilDialog) {
                    // 前回分が未消費のまま残っていれば先に解除してから登録する
                    clearPendingDialogScrollHandler();
                    appState._pendingDialogScrollHandler = () => {
                        setTimeout(() => {
                            const _el = document.getElementById('resultsDashboard');
                            if (_el) {
                                const _top = _el.getBoundingClientRect().top + window.pageYOffset - 8;
                                window.scrollTo({ top: _top, behavior: 'smooth' });
                            }
                        }, 350);
                    };
                    dom.dialogConfirmButton.addEventListener('click', appState._pendingDialogScrollHandler, { once: true });
                }
            } else {
                showDialog('探索失敗', '有効な組み合わせが見つかりませんでした。条件を変更してください。');
            }
            dom.loadingIndicator.style.display = 'none';
        }

        // 数学的に連続プレイ・連続休憩の上限を超えない「ブロックローテーション」初期解を生成
        // （SAが局所解にはまり込むのを防ぐため、条件が合う場合のみ最初のリスタートの種として使う）
        function generateBlockRotationSeed(targetCount, settings) {
            const ruleType = settings.ruleType || 'none';
            if (ruleType !== 'none') return null; // genderMix/fixedPairは非対応（既存の探索に任せる）

            const excl = settings.exclusions || appState.exclusions || {};
            if (Object.keys(excl).length > 0) return null; // 離脱ありは非対応
            const jns = settings.joins || appState.joins || {};
            if (Object.keys(jns).length > 0) return null; // 途中参加ありも非対応（第1試合が全員参加前提のため）

            const surfaces = settings.currentSurfaceCount || appState.currentSurfaceCount;
            const N = settings.currentTotalMemberCount || appState.currentTotalMemberCount;
            const P = surfaces * 4;
            const R = N - P;
            if (R <= 0 || N % R !== 0) return null; // 休憩者0人 or 均等なグループに分割できない

            const numGroups = N / R;
            const maxConsec = settings.maxConsecutiveLimit || appState.maxConsecutiveLimit || Infinity;
            if (!isFinite(maxConsec) || numGroups - 1 > maxConsec) return null; // このローテーションでも上限超過

            // グループ0 = 第1試合で休む固定メンバー（登録順の後方R人、createDeterministicFirstMatchと一致させる）
            const groups = [Array.from({ length: R }, (_, i) => P + i)];
            for (let g = 1; g < numGroups; g++) {
                groups.push(Array.from({ length: R }, (_, i) => (g - 1) * R + i));
            }

            const matches = [];
            for (let r = 0; r < targetCount; r++) {
                const restGroup = groups[r % numGroups];
                const restSet = new Set(restGroup);
                let playing = Array.from({ length: N }, (_, i) => i).filter(i => !restSet.has(i));
                if (r > 0) {
                    // 第1試合以外はペアの偏りを避けるためプレイ順をシャッフル（休憩の割当は変えない）
                    for (let i = playing.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [playing[i], playing[j]] = [playing[j], playing[i]];
                    }
                }
                const courts = [];
                for (let c = 0; c < surfaces; c++) {
                    const four = playing.slice(c * 4, c * 4 + 4);
                    const team1 = [four[0], four[1]].sort((a, b) => a - b);
                    const team2 = [four[2], four[3]].sort((a, b) => a - b);
                    courts.push({ team1, team2, players: [...team1, ...team2].sort((a, b) => a - b) });
                }
                const playersThisRound = courts.flatMap(c => c.players);
                matches.push({ courts, restingPlayers: [...restGroup].sort((a, b) => a - b), playersThisRound });
            }
            return matches;
        }

        async function generateInitialSolution(targetCount, settings) {
            const savedMatches = appState.matches;
            const ruleType = settings.ruleType || 'none';

            // genderMix用: ランダムに男女ペアを作って初期解を生成
            if (ruleType === 'genderMix') {
                const result = generateInitialSolutionForGenderMix(targetCount, settings);
                appState.matches = savedMatches;
                return result;
            }

            // 第1試合: 表示名順の先頭(surfaces×4)人で固定、コート数=surfaces分作成
            const _fmTop4 = settings.firstMatchSortedTop4;
            const _fmRest = settings.firstMatchRest;
            const _fmSurfaces = settings.currentSurfaceCount || appState.currentSurfaceCount;
            let fixedFirstMatch = null;
            if (_fmTop4 && _fmTop4.length === _fmSurfaces * 4) {
                const _grpFM = settings.groups || appState.groups || {};
                const _rtFM = ruleType;
                const _fmCourts = [];
                for (let _c = 0; _c < _fmSurfaces; _c++) {
                    _fmCourts.push(makeCourtRespectingGender(_fmTop4.slice(_c * 4, (_c + 1) * 4), _grpFM, _rtFM));
                }
                fixedFirstMatch = { courts: _fmCourts, playersThisRound: [..._fmTop4], restingPlayers: [...(_fmRest || [])] };
            }

            const MAX_RETRIES = 8;
            for (let retry = 0; retry < MAX_RETRIES; retry++) {
                appState.matches = [];
                const firstMatch = fixedFirstMatch || generateRandomSingleMatch(0);
                if (!firstMatch) continue;
                appState.matches.push(JSON.parse(JSON.stringify(firstMatch)));

                let success = true;
                for (let i = 1; i < targetCount; i++) {
                    const m = findBestMatchCandidate(i, settings.maxConsecutiveLimit);
                    if (m) {
                        appState.matches.push(m);
                    } else {
                        success = false;
                        break;
                    }
                }

                if (success) {
                    const result = [...appState.matches];
                    appState.matches = savedMatches;
                    return result;
                }
            }

            appState.matches = savedMatches;
            return null;
        }

        function generateInitialSolutionForGenderMix(targetCount, settings) {
            const groups = settings.groups || appState.groups || {};
            const memberCount = settings.currentTotalMemberCount;
            const members = Array.from({ length: memberCount }, (_, i) => i);
            const males = members.filter(i => (groups[i] || 'default') === 'M');
            const females = members.filter(i => (groups[i] || 'default') === 'F');
            const surfaces = settings.currentSurfaceCount;
            const totalM = surfaces * 2;
            const totalF = surfaces * 2;
            // best-effortモード: どちらかの性別が全コート分以下の場合
            const isBestEffort = males.length <= totalM || females.length <= totalF;

            if (!isBestEffort && (males.length < totalM || females.length < totalF)) return null;
            if (memberCount < surfaces * 4) return null;

            function shuffle(arr) {
                const a = [...arr];
                for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; }
                return a;
            }
            function makeCourt(mPair, fPair) {
                const pairing = Math.random() < 0.5
                    ? [[mPair[0], fPair[0]], [mPair[1], fPair[1]]]
                    : [[mPair[0], fPair[1]], [mPair[1], fPair[0]]];
                return {
                    team1: pairing[0].slice().sort((a, b) => a - b),
                    team2: pairing[1].slice().sort((a, b) => a - b),
                    players: [...pairing[0], ...pairing[1]].sort((a, b) => a - b)
                };
            }
            function getCombinations(arr, k) {
                if (k === 0) return [[]];
                if (arr.length < k) return [];
                const result = [];
                for (let i = 0; i <= arr.length - k; i++) {
                    for (const rest of getCombinations(arr.slice(i + 1), k - 1)) {
                        result.push([arr[i], ...rest]);
                    }
                }
                return result;
            }
            function getPermutations(arr) {
                if (arr.length <= 1) return [[...arr]];
                const result = [];
                for (let i = 0; i < arr.length; i++) {
                    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
                    for (const perm of getPermutations(rest)) {
                        result.push([arr[i], ...perm]);
                    }
                }
                return result;
            }

            function factorial(n) {
                let r = 1;
                for (let i = 2; i <= n; i++) r *= i;
                return r;
            }

            // パターン列挙
            const allPatterns = [];
            if (!isBestEffort) {
                // 理論パターン数が大きすぎる場合（例: 3面・男女12人ずつ等）は全列挙すると
                // 数億パターンになりブラウザがフリーズするため、ランダムサンプリングに切り替える
                const RANDOM_SAMPLE_LIMIT = 50000;
                const totalPatternCount = nCk(males.length, totalM) * nCk(females.length, totalF) * factorial(totalF);
                if (totalPatternCount > RANDOM_SAMPLE_LIMIT) {
                    // 重複パターンは許容（SAが後段で改善するため厳密なユニーク性は不要）
                    for (let i = 0; i < RANDOM_SAMPLE_LIMIT; i++) {
                        const playingM = shuffle(males).slice(0, totalM);
                        const fPerm = shuffle(females).slice(0, totalF);
                        const courts = [];
                        for (let c = 0; c < surfaces; c++) {
                            const mPair = [playingM[c * 2], playingM[c * 2 + 1]];
                            const fPair = [fPerm[c * 2], fPerm[c * 2 + 1]];
                            courts.push(makeCourt(mPair, fPair));
                        }
                        const playersThisRound = courts.flatMap(c => c.players).sort((a, b) => a - b);
                        const restingPlayers = members.filter(p => !playersThisRound.includes(p)).sort((a, b) => a - b);
                        allPatterns.push({ courts, playersThisRound, restingPlayers });
                    }
                } else {
                    // strictモード: M-Fペアのみで厳密に生成
                    for (const playingM of getCombinations(males, totalM)) {
                        for (const playingF of getCombinations(females, totalF)) {
                            for (const fPerm of getPermutations(playingF)) {
                                const courts = [];
                                for (let c = 0; c < surfaces; c++) {
                                    const mPair = [playingM[c * 2], playingM[c * 2 + 1]];
                                    const fPair = [fPerm[c * 2], fPerm[c * 2 + 1]];
                                    courts.push(makeCourt(mPair, fPair));
                                }
                                const playersThisRound = courts.flatMap(c => c.players).sort((a, b) => a - b);
                                const restingPlayers = members.filter(p => !playersThisRound.includes(p)).sort((a, b) => a - b);
                                allPatterns.push({ courts, playersThisRound, restingPlayers });
                            }
                        }
                    }
                }
            } else {
                // best-effortモード: 全員から4*surfaces人を選ぶ、ミックスを最大化
                for (const playing of getCombinations(members, surfaces * 4)) {
                    const restingPlayers = members.filter(p => !playing.includes(p)).sort((a, b) => a - b);
                    const courts = [];
                    for (let c = 0; c < surfaces; c++) {
                        const cp = playing.slice(c * 4, (c + 1) * 4);
                        const cpM = cp.filter(p => (groups[p] || 'default') === 'M');
                        const cpF = cp.filter(p => (groups[p] || 'default') === 'F');
                        if (cpM.length >= 2 && cpF.length >= 2) {
                            courts.push(makeCourt([cpM[0], cpM[1]], [cpF[0], cpF[1]]));
                        } else {
                            courts.push({
                                team1: [cp[0], cp[1]].sort((a, b) => a - b),
                                team2: [cp[2], cp[3]].sort((a, b) => a - b),
                                players: cp.slice().sort((a, b) => a - b)
                            });
                        }
                    }
                    const playersThisRound = courts.flatMap(c => c.players).sort((a, b) => a - b);
                    allPatterns.push({ courts, playersThisRound, restingPlayers });
                }
            }
            if (allPatterns.length === 0) return null;

            // 仕様: 最初の試合は選手0,1,2,3（P1,P2,P3,P4）の組み合わせを使用
            const firstPlayers = [0, 1, 2, 3].slice(0, surfaces * 4);
            const firstPatternIdx = allPatterns.findIndex(pat =>
                firstPlayers.every(p => pat.playersThisRound.includes(p)) &&
                pat.playersThisRound.length === surfaces * 4
            );

            // グリーディ順序付け: 連続プレイ・連続休憩の両方を制御
            const _maxC = settings ? (settings.maxConsecutiveLimit || appState.maxConsecutiveLimit || 99) : (appState.maxConsecutiveLimit || 99);
            // 連続休憩上限はプレイ上限より小さく設定（休憩の偏りを防ぐ）
            const _maxRestC = Math.max(1, _maxC - 1);
            const _mCount = memberCount;
            const _streaksG = new Array(_mCount).fill(0); // 連続プレイ
            const _restStreaksG = new Array(_mCount).fill(0); // 連続休憩
            const pool = shuffle([...allPatterns]);
            // 最初の試合パターンをプールの先頭に移動
            if (firstPatternIdx >= 0) {
                const fp = allPatterns[firstPatternIdx];
                const fpInPool = pool.findIndex(p => p === fp || JSON.stringify(p.playersThisRound) === JSON.stringify(fp.playersThisRound));
                if (fpInPool > 0) pool.unshift(pool.splice(fpInPool, 1)[0]);
            }
            const matches = [];

            for (let i = 0; i < targetCount; i++) {
                // pool が尽きたら補充（再シャッフル）
                if (pool.length === 0) pool.push(...shuffle(allPatterns));

                // pool の先頭 min(20, pool.length) 件をスコアリングしてベストを選ぶ
                const checkN = Math.min(pool.length, 20);
                let bestIdx = 0, bestScore = -Infinity;
                for (let j = 0; j < checkN; j++) {
                    const pat = pool[j];
                    let sc = 0;
                    pat.playersThisRound.forEach(p => {
                        // 連続プレイ制御
                        if (_streaksG[p] >= _maxC) sc -= 2000;
                        else sc -= _streaksG[p] * 5;
                        // 長休憩中の選手を優先出場（二乗ペナルティで強く制御）
                        if (_restStreaksG[p] >= _maxRestC) sc += 2000;
                        else if (_restStreaksG[p] >= 2) sc += _restStreaksG[p] * _restStreaksG[p] * 60;
                        else sc += _restStreaksG[p] * 8;
                    });
                    pat.restingPlayers.forEach(p => {
                        // 連続プレイ中の選手を休ませる
                        if (_streaksG[p] >= _maxC) sc += 1000;
                        else sc += _streaksG[p] * 3;
                        // 既に連続休憩中は強く避ける（二乗ペナルティ）
                        if (_restStreaksG[p] >= _maxRestC) sc -= 2000;
                        else if (_restStreaksG[p] >= 2) sc -= _restStreaksG[p] * _restStreaksG[p] * 50;
                        else sc -= _restStreaksG[p] * 5;
                    });
                    if (sc > bestScore) { bestScore = sc; bestIdx = j; }
                }

                const chosen = pool.splice(bestIdx, 1)[0];
                // ペアリングをランダム化して追加
                const newMatch = JSON.parse(JSON.stringify(chosen));
                newMatch.courts = newMatch.courts.map(c => {
                    const ps = [...c.team1, ...c.team2];
                    const msInCourt = ps.filter(p => (groups[p] || 'default') === 'M');
                    const fsInCourt = ps.filter(p => (groups[p] || 'default') === 'F');
                    if (msInCourt.length >= 2 && fsInCourt.length >= 2) {
                        return makeCourt([msInCourt[0], msInCourt[1]], [fsInCourt[0], fsInCourt[1]]);
                    } else {
                        const sps = shuffle([...ps]);
                        return {
                            team1: [sps[0], sps[1]].sort((a, b) => a - b),
                            team2: [sps[2], sps[3]].sort((a, b) => a - b),
                            players: ps.slice().sort((a, b) => a - b)
                        };
                    }
                });
                matches.push(newMatch);

                // ストリーク更新（プレイ・休憩の両方）
                for (let p = 0; p < _mCount; p++) {
                    if (chosen.playersThisRound.includes(p)) {
                        _streaksG[p]++;
                        _restStreaksG[p] = 0;
                    } else {
                        _restStreaksG[p]++;
                        _streaksG[p] = 0;
                    }
                }
            }
            return matches;
        }





        async function findBestOfNGenerations() {
            // 探索方式の選択
            const method = document.getElementById('searchMethodSelect')?.value || 'sa';
            if (method === 'sa') {
                return findBestBySimulatedAnnealing();
            }
            // 従来のランダム探索
            appState.exclusions = {};
            recalculateAllJoinOffsets();
            const targetMatchCount = parseInt(document.getElementById('matchCountSelect').value, 10);
            if (appState.currentTotalMemberCount < appState.currentSurfaceCount * 4) {
                showDialog('エラー', 'メンバーが足りません。\n試合を生成するには、少なくとも' + (appState.currentSurfaceCount * 4) + '人のメンバーが必要です。');
                return;
            }

            const attempts = parseInt(document.getElementById('attemptCountSelect').value, 10);
            let bestResult = null;
            let bestMetaScore = -1;
            const allScores = [];
            let lastBestScoreUpdateAttempt = 0;

            dom.loadingIndicator.style.display = 'block';

            const originalSettings = {
                matchCount: targetMatchCount,
                currentSurfaceCount: appState.currentSurfaceCount,
                currentTotalMemberCount: appState.currentTotalMemberCount,
                maxConsecutiveLimit: appState.maxConsecutiveLimit,
                groups: JSON.parse(JSON.stringify(appState.groups)),
                ruleType: document.querySelector('input[name="ruleType"]:checked').value,
                members: [...appState.members],
                allPossiblePairs: [...appState.allPossiblePairs],
                exclusions: { ...appState.exclusions },
                joins: { ...appState.joins },
                joinOffsets: { ...appState.joinOffsets },
            };

            regenerateAllPossiblePairs();

            for (let i = 1; i <= attempts; i++) {
                dom.loadingMessage.textContent = `ベストな組み合わせを探索中... (${i} / ${attempts}回)`;
                await new Promise(resolve => setTimeout(resolve, 0));

                const generatedMatches = await generateMatchesInBackground(targetMatchCount, originalSettings);
                if (!generatedMatches || generatedMatches.length < targetMatchCount) continue;

                const stats = calculateSummaryStats(generatedMatches, originalSettings.members, appState.allPossiblePairs, originalSettings.currentSurfaceCount, originalSettings.exclusions, originalSettings.ruleType, originalSettings.groups, originalSettings.joins, originalSettings.joinOffsets);
                let metaScore = calculateMetaScore(stats);

                const restInfo = checkConsecutiveRests(generatedMatches, originalSettings.members, originalSettings.exclusions, originalSettings.joins);
                // genderMixでは2連続休憩は構造上避けられないためペナルティ免除
                // 仕様2-2: 連続休憩ペナルティ（evaluateFullSolutionと全く同じ式に統一）
                const _repPw = appState.pw || PENALTY_DEFAULTS;
                const _repMaxRest = originalSettings.maxConsecutiveLimit || appState.maxConsecutiveLimit || 2;
                const _repRestTol = Math.max(1, _repMaxRest - 1);
                if (restInfo.maxStreak > _repRestTol) {
                    metaScore -= (restInfo.maxStreak - _repRestTol) * _repPw.restHard;
                }
                if (restInfo.maxStreak > 1) {
                    metaScore -= _repPw.restSoft;
                }

                allScores.push(metaScore);

                if (metaScore > bestMetaScore) {
                    bestMetaScore = metaScore;
                    bestResult = { matches: generatedMatches, stats: stats, metaScore: metaScore, settings: originalSettings };
                    lastBestScoreUpdateAttempt = i;
                    dom.loadingMessage.textContent = `ベストな組み合わせを探索中... (${i} / ${attempts}回) - 新記録！ スコア: ${bestMetaScore.toFixed(2)}`;
                }
            }

            if (bestResult) {
                appState.matches = bestResult.matches;
                appState.generationSettings = { groups: originalSettings.groups, ruleType: originalSettings.ruleType };

                let resultMessage = '';
                if (allScores.length > 0) {
                    const averageScore = allScores.reduce((a, b) => a + b, 0) / allScores.length;
                    const stdDev = calculateStandardDeviation(allScores, averageScore);
                    const conclusionText = (lastBestScoreUpdateAttempt < attempts / 2) ? '結論: スコアが頭打ちになりました。これ以上の改善はあまり期待できません。' :
                        (stdDev < 2.0) ? '結論: 結果が安定しています。試行回数は十分だった可能性が高いです。' :
                            '結論: 質の高い組み合わせです。必要に応じて再試行を検討してください。';

                    appState.lastRunAnalysis = {
                        attempts, validAttempts: allScores.length, bestMetaScore, averageScore, stdDev, conclusionText,
                        bestResult: bestResult
                    };

                    const { stats, metaScore, settings } = bestResult;
                    const partnerStats = calculatePartnerDiversityStats(bestResult.matches, settings.members);
                    const ruleMap = { none: 'なし', fixedPair: '固定ペア', genderMix: '男女ミックス' };
                    const frpPair = calculateFirstRepetitionMatch(bestResult.matches, 'pair');
                    const frpGroup = calculateFirstRepetitionMatch(bestResult.matches, 'group');

                    const reportText = `
【探索結果レポート】
探索条件: ${settings.currentSurfaceCount}面${settings.currentTotalMemberCount}人 / ${bestResult.matches.length}試合 / 最大${settings.maxConsecutiveLimit}連続 / ルール: ${ruleMap[settings.ruleType]}

【総合評価】
ベストスコア: ${metaScore.toFixed(2)}
平均スコア: ${averageScore.toFixed(2)}
標準偏差: ${stdDev.toFixed(2)}
結論: ${conclusionText}

【詳細指標】
プレイ回数の最大差: ${stats.maxPlayCountDiff}
ペア結成の多様性: ${(stats.pairCoverage.ratio * 100).toFixed(0)}% (${stats.pairCoverage.used}/${stats.pairCoverage.total})
対戦グループの多様性: ${(stats.cardCoverage.ratio * 100).toFixed(0)}% (${stats.cardCoverage.used}/${stats.cardCoverage.total})
対戦カードの多様性: ${(stats.opponentCoverage.ratio * 100).toFixed(0)}% (${stats.opponentCoverage.used}/${stats.opponentCoverage.max})
ペア結成の公平性 (CV): ${stats.pairFairness.cv.toFixed(3)}
対戦グループの公平性 (CV): ${stats.cardFairness.cv.toFixed(3)}
対戦の公平性 (CV): ${stats.matchupFairness.cv.toFixed(3)}
初重複試合番号 (ペア): ${frpPair}
初重複試合番号 (グループ): ${frpGroup}
ペア相手数の分布 (最小/平均/最大): ${partnerStats.min} / ${partnerStats.avg.toFixed(1)} / ${partnerStats.max}
`.trim();

                    appState.currentMemo = reportText;
                    dom.favoriteMemoInput.value = reportText;

                    const historicalBest = findHistoricalBestScore(originalSettings, appState.favorites);
                    let newRecordMessage = '';
                    if (historicalBest.score > -1) {
                        if (bestMetaScore > historicalBest.score) {
                            newRecordMessage = `<div style="background-color: #f0fff4; border-left: 5px solid #48bb78; padding: 10px; margin: 12px 0; border-radius: 4px;"><p style="font-weight: bold; color: #2f855a;">🎉 過去のベストスコアを更新しました！</p></div>`;
                        } else if (bestMetaScore === historicalBest.score) {
                            newRecordMessage = `<div style="background-color: #fffbeb; border-left: 5px solid #f59e0b; padding: 10px; margin: 12px 0; border-radius: 4px;"><p style="font-weight: bold; color: #b45309;">👑 過去のベストスコアに並びました！</p><p style="font-size: 0.8em; color: #b45309; margin-top: 4px;">「初重複試合番号」などを比較し、今回の結果がより優れていれば保存をお勧めします。</p></div>`;
                        }
                    }

                    const warnings = [];
                    const checks = [
                        { label: 'プレイ回数の最大差', level: stats.maxPlayCountDiff > 2 ? 'bad' : (stats.maxPlayCountDiff > 1 ? 'warn' : 'good') },
                        { label: 'ペア結成の公平性', level: judgeFairness(stats.pairFairness.cv, stats.pairFairness.gini, settings.ruleType) },
                        { label: '対戦グループの公平性', level: judgeFairness(stats.cardFairness.cv, stats.cardFairness.gini, 'none') }
                    ];

                    checks.forEach(check => {
                        if (check.level !== 'good') {
                            const colorClass = check.level === 'bad' ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800';
                            warnings.push(`<div class="p-2 my-1 rounded-md text-sm text-center ${colorClass}"><strong>${check.label}:</strong> ${LEVEL_TEXT[check.level]}</div>`);
                        }
                    });

                    let qualityWarningHtml = '';
                    if (warnings.length > 0) {
                        qualityWarningHtml = `<div class="mt-4 border-t pt-3"><h4 class="font-bold text-center text-sm mb-2">品質に関する警告</h4>${warnings.join('')}</div>`;
                    }

                    const additionalMetricsText = `\n【序盤の多様性評価】\n初重複試合番号 (ペア): ${frpPair}\n初重複試合番号 (グループ): ${frpGroup}`;

                    resultMessage = `
                ${newRecordMessage}
                <pre class="text-left font-mono text-sm bg-gray-50 p-3 rounded-md overflow-x-auto">
【統計情報】
有効試行回数: ${allScores.length} / ${attempts}回
ベストスコア: ${bestMetaScore.toFixed(2)} (${lastBestScoreUpdateAttempt}回目で発見)
平均スコア  : ${averageScore.toFixed(2)}
標準偏差    : ${stdDev.toFixed(2)}${additionalMetricsText}
---------------------------------
${conclusionText}</pre>
                ${qualityWarningHtml}
            `;

                } else {
                    resultMessage = '有効な組み合わせが見つかりませんでした。';
                    appState.lastRunAnalysis = null;
                }

                finishGeneration(false);
                showDialog('探索完了', null, null, resultMessage); // メッセージの渡し方を修正
                pushStateToHistory();

            } else {
                appState.lastRunAnalysis = null;
                showDialog('エラー', '有効な組み合わせが見つかりませんでした。条件を変えてお試しください。');
            }
            dom.loadingIndicator.style.display = 'none';
        }




        /**
         * 配列の標準偏差を計算する関数
         * @param {number[]} array - 数値の配列
         * @param {number} average - 事前に計算された配列の平均値
         * @returns {number} 標準偏差
         */
        function calculateStandardDeviation(array, average) {
            if (array.length < 2) return 0;
            const variance = array.reduce((acc, val) => acc + Math.pow(val - average, 2), 0) / array.length;
            return Math.sqrt(variance);
        }

        /**
         * 総合スコアを計算する関数
         * @param {object} stats - calculateSummaryStatsから返される統計オブジェクト
         * @returns {number} 総合スコア
         */

        /**
                 * 2つの設定オブジェクトが完全に同一であるかを厳密に比較する関数
                 * @param {object} settingsA - 比較する設定1
                 * @param {object} settingsB - 比較する設定2
                 * @returns {boolean} 同一であれば true
                 */
        /**
                 * 2つの設定オブジェクトが完全に同一であるかを厳密に比較する関数
                 * @param {object} settingsA - 比較する設定1
                 * @param {object} settingsB - 比較する設定2
                 * @returns {boolean} 同一であれば true
                 */
        function areSettingsIdentical(settingsA, settingsB) {
            if (!settingsA || !settingsB) return false;

            // ▼▼▼ この比較条件に試合数を追加 ▼▼▼
            const basicMatch =
                settingsA.matchCount === settingsB.matchCount && // 試合数が一致するかをチェック
                settingsA.currentSurfaceCount === settingsB.surfaceCount &&
                settingsA.currentTotalMemberCount === settingsB.totalMemberCount &&
                settingsA.maxConsecutiveLimit === settingsB.maxConsecutiveLimit &&
                settingsA.ruleType === settingsB.ruleType;
            // ▲▲▲

            if (!basicMatch) {
                return false;
            }

            const groupsAMatch = JSON.stringify(settingsA.groups || {});
            const groupsBMatch = JSON.stringify(settingsB.groups || {});
            if (groupsAMatch !== groupsBMatch) {
                return false;
            }

            const exclusionsAMatch = JSON.stringify(settingsA.exclusions || {});
            const exclusionsBMatch = JSON.stringify(settingsB.exclusions || {});
            if (exclusionsAMatch !== exclusionsBMatch) {
                return false;
            }

            const joinsAMatch = JSON.stringify(settingsA.joins || {});
            const joinsBMatch = JSON.stringify(settingsB.joins || {});
            if (joinsAMatch !== joinsBMatch) {
                return false;
            }

            return true;
        }

        // ─── 条件ごとの実測ベストスコア（localStorage永続化） ──────────────────
        // 理論上限(calcConditionCeiling)は構造的に到達不能な値を含むため、
        // 実際にこれまで出た最良スコアを条件シグネチャ単位で記録し、
        // 「これ以上は現実的に望めない」の判断材料として併用する。
        function getConditionSignature(settings) {
            return JSON.stringify({
                surfaces: settings.currentSurfaceCount,
                members: settings.currentTotalMemberCount,
                matchCount: settings.matchCount,
                maxConsecutiveLimit: settings.maxConsecutiveLimit,
                ruleType: settings.ruleType,
                groups: settings.groups || {},
                exclusions: settings.exclusions || {},
                joins: settings.joins || {}
            });
        }

        function loadEmpiricalBestStore() {
            try {
                return JSON.parse(localStorage.getItem(LS_KEY_EMPIRICAL_BEST)) || {};
            } catch (_) { return {}; }
        }

        function saveEmpiricalBestStore(store) {
            try { localStorage.setItem(LS_KEY_EMPIRICAL_BEST, JSON.stringify(store)); } catch (_) { }
        }

        // 読み取り専用（表示用）。runCountは増やさない
        function getEmpiricalBest(settings) {
            const store = loadEmpiricalBestStore();
            return store[getConditionSignature(settings)] || null;
        }

        // 探索完了時にのみ呼ぶ。runCountを増やし、bestScoreを必要なら更新して返す
        function updateEmpiricalBest(settings, scoreTotalBase) {
            const store = loadEmpiricalBestStore();
            const key = getConditionSignature(settings);
            const entry = store[key] || { bestScore: -Infinity, runCount: 0 };
            entry.runCount++;
            if (scoreTotalBase > entry.bestScore) entry.bestScore = scoreTotalBase;
            entry.lastUsed = Date.now();
            store[key] = entry;

            // 保存件数が上限を超えたら、lastUsedが古い条件から削除
            const keys = Object.keys(store);
            if (keys.length > MAX_EMPIRICAL_ENTRIES) {
                keys.sort((a, b) => (store[a].lastUsed || 0) - (store[b].lastUsed || 0));
                for (let i = 0; i < keys.length - MAX_EMPIRICAL_ENTRIES; i++) delete store[keys[i]];
            }
            saveEmpiricalBestStore(store);
            return entry;
        }

        /**
/**
         * 同じ設定の過去のお気に入りから、最高のメタスコアを探す
         * @param {object} currentSettings - 現在の生成設定
         * @param {Array} favorites - お気に入りの全リスト
         * @returns {object} { score: 過去の最高スコア, name: そのお気に入りの名前 }
         */
        function findHistoricalBestScore(currentSettings, favorites) {
            let historicalBest = { score: -1, name: null };

            for (const fav of favorites) {
                if (!fav.analysis || !fav.settings || !fav.analysis.bestMetaScore) continue;

                // ▼▼▼ このオブジェクトに matchCount を追加 ▼▼▼
                const settingsMatch = areSettingsIdentical(currentSettings, {
                    ...fav.settings,
                    matchCount: fav.matches.length, // 保存されているお気に入りの試合数を渡す
                    groups: fav.groups,
                    exclusions: fav.exclusions
                });
                // ▲▲▲

                if (settingsMatch) {
                    if (fav.analysis.bestMetaScore > historicalBest.score) {
                        historicalBest = {
                            score: fav.analysis.bestMetaScore,
                            name: fav.name
                        };
                    }
                }
            }
            return historicalBest;
        }



        // ─── 総合グレード計算 ───────────────────────────────────────────────

        // ─── 組み合わせ計算（グローバル） ───────────────────────────────────
        function nCk(n, k) {
            if (k < 0 || k > n) return 0;
            let r = 1;
            for (let i = 1; i <= k; i++) r = r * (n - i + 1) / i;
            return Math.round(r);
        }

        // ─── 条件別の達成可能上限スコアを計算 ──────────────────────────────
        function calcConditionCeiling(surfaces, members, matchCount, ruleType, groups) {
            if (!ruleType) ruleType = document.querySelector('input[name="ruleType"]:checked')?.value || 'none';
            if (!groups) groups = appState.groups || {};
            const getGroup = (i) => groups[i] || 'default';
            // 重み合計=100点（restPairFairness追加時に115点になっていたのを正規化）
            const weights = {
                playCount: 26, pairCoverage: 17, cardCoverage: 9,
                opponentCoverage: 9, pairFairness: 13, matchupFairness: 4, earlyDiversity: 9,
                restPairFairness: 13
            };

            // genderMixモード判定: 人数ベースの自動判定に一本化（calculateSummaryStats等と揃える）
            const _isBestEffortGM = ruleType === 'genderMix' && isGenderMixBestEffort(groups, surfaces);
            const isGenderMixStrict = ruleType === 'genderMix' && !_isBestEffortGM;

            // (1) プレイ公平性
            const totalPlaySlots = surfaces * 4 * matchCount;
            let ceilPlayCount;
            if (isGenderMixStrict) {
                // strictモード: 全コート2M+2F固定なので、男女別に均等分割できるかで判定
                const maleCount = Object.values(groups).filter(g => g === 'M').length;
                const femaleCount = Object.values(groups).filter(g => g === 'F').length;
                const mSlots = surfaces * 2 * matchCount;
                const fSlots = surfaces * 2 * matchCount;
                const mOk = maleCount > 0 && mSlots % maleCount === 0;
                const fOk = femaleCount > 0 && fSlots % femaleCount === 0;
                ceilPlayCount = (mOk && fOk) ? 100 : 70;
            } else {
                // best-effort（人数不足で男女別に分けられない場合）・ruleType='none'等:
                // 全員で全枠を分け合うだけなので、男女別ではなく総人数で判定する
                ceilPlayCount = (totalPlaySlots % members === 0) ? 100 : 70;
            }

            // (2) ペア多様性
            let totalPairs;
            if (ruleType === 'genderMix') {
                const maleCount = Object.values(groups).filter(g => g === 'M').length;
                const femaleCount = Object.values(groups).filter(g => g === 'F').length;
                if (isGenderMixStrict) {
                    // strictモード: 有効なM×Fペアのみ
                    totalPairs = maleCount * femaleCount;
                } else {
                    // best-effortモード: 非ミックス試合も許容するので全ペアを対象
                    totalPairs = members * (members - 1) / 2;
                }
            } else {
                totalPairs = members * (members - 1) / 2;
            }
            if (totalPairs === 0) totalPairs = members * (members - 1) / 2;
            const pairAppearances = matchCount * surfaces * 2;
            const ceilPairCoverage = Math.min(100, Math.round(Math.min(totalPairs, pairAppearances) / totalPairs * 100));

            // (3)(4) グループ・対戦カード多様性
            let validGroupCount;
            if (ruleType === 'genderMix') {
                const mCount = Object.values(groups).filter(g => g === 'M').length;
                const fCount = Object.values(groups).filter(g => g === 'F').length;
                if (isGenderMixStrict) {
                    // strictモード: 2M+2Fの組み合わせのみ
                    validGroupCount = nCk(mCount, 2) * nCk(fCount, 2) * 3;
                } else {
                    // best-effortモード: 全組み合わせを対象
                    validGroupCount = nCk(members, 4) * 3;
                }
            } else {
                validGroupCount = nCk(members, 4) * 3;
            }
            if (validGroupCount === 0) validGroupCount = nCk(members, 4) * 3;
            const ceilCardCoverage = 100;
            const ceilOpponentCoverage = 100;

            // (5) ペア公平性
            function minCV(total, slots) {
                if (slots === 0 || total === 0) return 0;
                const base = Math.floor(total / slots);
                const rem = total % slots;
                const mean = total / slots;
                if (mean === 0) return 0;
                const variance = (rem * Math.pow(base + 1 - mean, 2) + (slots - rem) * Math.pow(base - mean, 2)) / slots;
                return Math.sqrt(variance) / mean;
            }
            const cvPair = minCV(pairAppearances, totalPairs);
            const ceilPairFairness = Math.max(0, Math.round((1 - cvPair) * 100));

            // (6) 対戦公平性
            const maxOppPerPair = nCk(members - 2, 2);
            const baseApp = Math.floor(pairAppearances / totalPairs);
            const remApp = pairAppearances % totalPairs;
            const divHigh = Math.min(baseApp + 1, maxOppPerPair);
            const divLow = Math.min(baseApp, maxOppPerPair);
            let cvMatchup = 0;
            if (divHigh !== divLow) {
                const actualRem = (baseApp < maxOppPerPair) ? remApp : 0;
                const actualLowCnt = totalPairs - actualRem;
                const meanDiv = (actualRem * divHigh + actualLowCnt * divLow) / totalPairs;
                if (meanDiv > 0) {
                    const varM = (actualRem * Math.pow(divHigh - meanDiv, 2) + actualLowCnt * Math.pow(divLow - meanDiv, 2)) / totalPairs;
                    cvMatchup = Math.sqrt(varM) / meanDiv;
                }
            }
            const ceilMatchupFairness = Math.max(0, Math.round((1 - Math.min(1, cvMatchup)) * 100));

            // (7) 序盤多様性
            const frpPairCeil = Math.min(Math.floor(totalPairs / (surfaces * 2)) + 1, matchCount + 1);
            const frpGroupCeil = Math.min(Math.floor(validGroupCount / 3) + 1, matchCount + 1);
            const ceilEarlyDiv = Math.round(Math.min(100, (frpPairCeil + frpGroupCeil) / (matchCount * 2) * 200));

            // (8) 休憩ペアの公平性（休憩を共にする顔ぶれの分散度）
            const restPerRound = Math.max(0, members - surfaces * 4);
            const restPairsPerRound = nCk(restPerRound, 2);
            const totalRestPairSlots = restPairsPerRound * matchCount;
            const totalRestPairTypes = nCk(members, 2);
            const cvRestPair = minCV(totalRestPairSlots, totalRestPairTypes);
            // 実測側(calcOverallGrade/calculateMetaScore)と同じ1/(1+cv)の式で揃え、比率の整合性を保つ
            const ceilRestPairFairness = Math.round(100 / (1 + cvRestPair));

            const scores = {
                playCount: ceilPlayCount, pairCoverage: ceilPairCoverage,
                cardCoverage: ceilCardCoverage, opponentCoverage: ceilOpponentCoverage,
                pairFairness: ceilPairFairness, matchupFairness: ceilMatchupFairness,
                earlyDiversity: ceilEarlyDiv, restPairFairness: ceilRestPairFairness
            };
            let total = Object.keys(weights).reduce((sum, k) => sum + (scores[k] * weights[k] / 100), 0);

            // ★ best-effortのmixボーナスを上限に加算
            if (_isBestEffortGM) {
                const maleCount = Object.values(groups).filter(g => g === 'M').length;
                const femaleCount = Object.values(groups).filter(g => g === 'F').length;
                if (maleCount > 0 && femaleCount > 0) {
                    total += 30;
                }
            }

            const rounded = Math.round(total * 10) / 10;

            let grade, color;
            if (rounded >= 95) { grade = 'S'; color = '#16a34a'; }
            else if (rounded >= 88) { grade = 'A'; color = '#2563eb'; }
            else if (rounded >= 78) { grade = 'B'; color = '#7c3aed'; }
            else if (rounded >= 65) { grade = 'C'; color = '#d97706'; }
            else { grade = 'D'; color = '#dc2626'; }


            return {
                total: rounded,        // 表示用（mixBonus込み）
                totalBase: Math.round(Object.keys(weights).reduce((sum, k) =>
                    sum + (scores[k] * weights[k] / 100), 0) * 10) / 10,
                grade, color, scores
            };
        }
        // ─── 目標スコアUIを条件変更時に更新 ────────────────────────────────
        function updateTargetScoreUI() {
            const surfaces = parseInt(document.getElementById('surfaceCountSelect')?.value || 1);
            const membersTotal = parseInt(document.getElementById('totalMemberCountSelect')?.value || 0);
            const matches = parseInt(document.getElementById('matchCountSelect')?.value || 20);
            const info = document.getElementById('ceilingInfo');
            if (!info) return;
            if (membersTotal < 4) { info.innerHTML = ''; return; }

            // 未到着メンバーはスケジュール上存在しないため実効人数で上限を計算
            const _notArrTS = Object.values(appState.joins || {}).filter(v => v === JOIN_NOT_ARRIVED).length;
            const members = Math.max(0, membersTotal - _notArrTS);
            const ceiling = calcConditionCeiling(surfaces, members, matches);
            const _ceilScore = ceiling.totalBase ?? ceiling.total;
            info.innerHTML = `この条件での上限: <b style="color:#15803d;">${_ceilScore}点</b> <span style="font-size:10px;color:#6b7280;">（${_ceilScore}点到達で再試行不要）</span><span style="font-size:10px;color:#9ca3af;margin-left:4px;">(プレイ公平${ceiling.scores.playCount}・ペア多様${ceiling.scores.pairCoverage}・カード多様${ceiling.scores.cardCoverage}・序盤多様${ceiling.scores.earlyDiversity})</span>`;
        }

        function calcOverallGrade(statsData, matches, members, allPossiblePairs, precomputedMixBonus) {
            // 重み合計=100点（calcConditionCeilingと同じ配分に揃える）
            const weights = {
                playCount: 26, pairCoverage: 17, cardCoverage: 9,
                opponentCoverage: 9, pairFairness: 13, matchupFairness: 4, earlyDiversity: 9,
                restPairFairness: 13,
            };
            const scores = {};
            const diffPenalty = [100, 70, 30, 0];
            scores.playCount = diffPenalty[Math.min(3, statsData.maxPlayCountDiff)];
            scores.pairCoverage = Math.round(statsData.pairCoverage.ratio * 100);
            scores.cardCoverage = Math.round(statsData.cardCoverage.ratio * 100);
            scores.opponentCoverage = Math.round(statsData.opponentCoverage.ratio * 100);
            scores.pairFairness = Math.round(Math.max(0, (1 - statsData.pairFairness.cv)) * 100);
            scores.matchupFairness = Math.round(Math.max(0, (1 - Math.min(1, statsData.matchupFairness.cv))) * 100);
            // 休憩ペアのCVは構造上1を超えやすいため、1で頭打ちにせず1/(1+cv)で滑らかに評価する
            scores.restPairFairness = Math.round(100 / (1 + statsData.restPairFairness.cv));
            const frpPair = calculateFirstRepetitionMatch(matches, 'pair');
            const frpGroup = calculateFirstRepetitionMatch(matches, 'group');
            const n = matches.length;
            const frpPairNum = (frpPair === '全て新規') ? n + 1 : frpPair;
            const frpGroupNum = (frpGroup === '全て新規') ? n + 1 : frpGroup;
            scores.earlyDiversity = Math.round(Math.min(100, (frpPairNum + frpGroupNum) / (n * 2) * 200));

            const total = Object.keys(weights).reduce((sum, k) => sum + (scores[k] * weights[k] / 100), 0);

            // ★ mixボーナス
            let mixBonus = 0;
            if (precomputedMixBonus !== undefined) {
                mixBonus = precomputedMixBonus;
            } else {
                const _rt = document.querySelector('input[name="ruleType"]:checked')?.value;
                if (_rt === 'genderMix' && isGenderMixBestEffort(appState.groups, appState.currentSurfaceCount) && matches && matches.length > 0) {
                    let mixCourts = 0, totalCourts = 0;
                    for (const m of matches) {
                        for (const c of m.courts) {
                            totalCourts++;
                            if (isCandidateCorrectType(c)) mixCourts++;
                        }
                    }
                    mixBonus = totalCourts > 0 ? (mixCourts / totalCourts) * 30 : 0;
                }
            }
            const totalWithBonus = total + mixBonus;

            let grade, stars, color, label;
            if (totalWithBonus >= 95) { grade = 'S'; stars = '★★★★★'; color = '#16a34a'; label = '最高'; }
            else if (totalWithBonus >= 88) { grade = 'A'; stars = '★★★★☆'; color = '#2563eb'; label = '優秀'; }
            else if (totalWithBonus >= 78) { grade = 'B'; stars = '★★★☆☆'; color = '#7c3aed'; label = '良好'; }
            else if (totalWithBonus >= 65) { grade = 'C'; stars = '★★☆☆☆'; color = '#d97706'; label = '普通'; }
            else { grade = 'D'; stars = '★☆☆☆☆'; color = '#dc2626'; label = '要改善'; }
            return {
                total: Math.round(totalWithBonus * 10) / 10,
                totalBase: Math.round(total * 10) / 10, // mixBonus抜き。targetRate(ceilingData.totalBase)との比較には必ずこちらを使う
                grade, stars, color, label, scores
            };
        }


        function calculateMetaScore(stats) {
            // 各指標を0-1の範囲に正規化
            const scorePlayCount = 1 / (1 + stats.maxPlayCountDiff);
            const scorePairCoverage = stats.pairCoverage.ratio;
            const scoreCardCoverage = stats.cardCoverage.ratio;
            const scoreOpponentCoverage = stats.opponentCoverage.ratio;
            // CV(変動係数)は0に近いほど良いので、1から引く。値が大きくなりすぎないように調整。
            const scorePairFairness = 1 - Math.min(1, stats.pairFairness.cv);
            // 休憩を共にする顔ぶれの偏り（同じメンバーばかりが一緒に休むのを防ぐ）
            // 休憩ペアのCVは構造上1を超えやすいため、1で頭打ちにせず1/(1+cv)で滑らかに評価する
            const scoreRestPairFairness = 1 / (1 + stats.restPairFairness.cv);

            // 重要度に応じた重み付け
            // restPairFairnessは既存指標を犠牲にしないよう既存の重み(合計100)には手を付けず、
            // 加算のみに留める。重み5では休憩ペアCVの差が最大2点程度にしかならず
            // SAが固定ブロックローテーションを崩す動機にならなかったため、
            // pairFairnessと同格の20に引き上げて実効的な改善圧力を持たせる
            const weights = {
                playCount: 35,
                pairCoverage: 20,
                cardCoverage: 10,
                opponentCoverage: 15,
                pairFairness: 20,
                restPairFairness: 20
            };

            const metaScore =
                (scorePlayCount * weights.playCount) +
                (scorePairCoverage * weights.pairCoverage) +
                (scoreCardCoverage * weights.cardCoverage) +
                (scoreOpponentCoverage * weights.opponentCoverage) +
                (scorePairFairness * weights.pairFairness) +
                (scoreRestPairFairness * weights.restPairFairness);

            return metaScore;
        }

        async function generateMatchesInBackground(targetCount, settings) {
            // 処理開始時にグローバルなappState.matchesをクリーンな状態にする
            appState.matches = [];

            regenerateAllPossiblePairs();

            if (settings.members.length < settings.currentSurfaceCount * 4) {
                return null;
            }

            appState.matches.push(createDeterministicFirstMatch());

            for (let i = 1; i < targetCount; i++) {
                // 【修正点】settings オブジェクトから正しい maxConsecutiveLimit を findBestMatchCandidate に渡す
                const bestMatch = findBestMatchCandidate(i, settings.maxConsecutiveLimit);

                if (bestMatch) {
                    appState.matches.push(bestMatch);
                } else {
                    appState.matches = []; // 探索失敗時はリセット
                    return null;
                }
            }

            const finalMatches = [...appState.matches];
            appState.matches = []; // 探索完了後、グローバルなmatchesをリセット
            return finalMatches;
        }

        async function generateAndDisplayMatches(
            targetCount,
            isRegenerate = false,
            regenerateFrom = 0
        ) {
            appState.lastRunAnalysis = null;
            dom.loadingIndicator.style.display = 'block';
            dom.loadingMessage.textContent = `組み合わせを生成中...`;
            await new Promise(resolve => setTimeout(resolve, 10));

            // ▼▼▼ 新規生成のロジックのみを残す ▼▼▼
            if (!isRegenerate) {
                // 新規生成モード
                appState.matches = [];
                appState.exclusions = {};
            } else {
                // 再生成モード：1〜regenerateFrom-1 試合までを保持
                appState.matches = appState.matches.slice(0, regenerateFrom - 1);
                // appState.exclusions はあらかじめ handleApplyExclusion でセット済み
            }
            appState.dataSource = '新規生成';
            appState.areAnalysisSectionsVisible = false;
            appState.generationSettings = {
                groups: JSON.parse(JSON.stringify(appState.groups)),
                ruleType: document.querySelector('input[name="ruleType"]:checked').value
            };
            updateExclusionUI();
            regenerateAllPossiblePairs();
            // isRegenerateでもregenerateFrom<=1でmatchesが空になるケース（joinの全再生成等）では
            // 第1試合を決定的に生成する必要がある。「matchesが現在空かどうか」で判定する
            if (appState.matches.length === 0 && appState.members.length >= appState.currentSurfaceCount * 4) {
                appState.matches.push(createDeterministicFirstMatch());
            }

            try {
                const startIndex = appState.matches.length;
                for (let i = appState.matches.length; i < targetCount; i++) {
                    const bestMatch = findBestMatchCandidate(i, appState.maxConsecutiveLimit);
                    if (bestMatch) {
                        appState.matches.push(bestMatch);
                    } else {
                        showDialog('生成中断', `ラウンド ${i + 1}で有効な組み合わせが見つかりませんでした。試合数を減らすか、条件を変更してください。`);
                        break; // 生成できたところまでで終了
                    }
                }
            } finally {
                dom.loadingIndicator.style.display = 'none';
                finishGeneration(false);
                updateSaveFavoriteButtonState();
            }
        }


        // ◆ 軽量評価：basicScore にも最初の diff チェックを入れる
        function basicScore(candidate, existingMatches, matchIndex) {
            // 一時的に候補まで含めた全試合を組み立て
            const temp = [...existingMatches, candidate];

            // 再生成モードかどうかで許容する diff の閾値を変える
            const diff = calcMaxPlayCountDiff(temp, appState.currentTotalMemberCount);
            // 通常＝1、再生成モード＝∞（すべて通す）
            const diffThreshold = appState.isRegeneratingAfterDropout ? Infinity : 1;
            if (diff > diffThreshold) {
                // ここが関数内なら合法
                return -Infinity;
            }

            // 再生成時は連続プレイ制限チェックをスキップ
            if (!appState.isRegeneratingAfterDropout
                && isConsecutivePlayLimitViolated(candidate, existingMatches, appState.maxConsecutiveLimit)) {
                return -Infinity;
            }

            // 軽量版のヒストリーデータ取得＆スコア計算
            const history = getHistoryDataLight(existingMatches);
            return calculateScore(candidate, history, existingMatches, /*skipHeavy=*/true);
        }


        // これで calculateScore が期待する lastPairs, cardHistory, opponentCounts, pairCounts, lastRestingPlayers が揃う
        function getHistoryDataLight(existingMatches) {
            const history = {
                lastPairs: new Set(),        // ← これを必ず定義する
                cardHistory: {},             // 対戦カード履歴
                opponentCounts: {},          // 相手ペア履歴
                pairCounts: {},              // ペア結成回数履歴
                lastRestingPlayers: new Set()// 前試合休憩プレイヤー
                // （restCounts や individ… は不要なので定義しない）
            };

            if (existingMatches.length > 0) {
                const lastMatch = existingMatches[existingMatches.length - 1];
                lastMatch.courts.forEach(c => {
                    const k1 = c.team1.join(','), k2 = c.team2.join(',');
                    history.lastPairs.add(k1);
                    history.lastPairs.add(k2);
                    history.lastRestingPlayers = new Set(lastMatch.restingPlayers);
                });
            }

            // cardHistory・opponentCounts・pairCounts を軽量に集計
            existingMatches.forEach(m => {
                m.courts.forEach(c => {
                    // カード履歴
                    const cardKey = c.team1.concat(c.team2).sort().join(',');
                    history.cardHistory[cardKey] = (history.cardHistory[cardKey] || 0) + 1;
                    // ペア履歴
                    [c.team1, c.team2].forEach(team => {
                        const pairKey = team.join(',');
                        history.pairCounts[pairKey] = (history.pairCounts[pairKey] || 0) + 1;
                    });
                    // 相手ペア履歴
                    [[c.team1, c.team2], [c.team2, c.team1]].forEach(([me, opp]) => {
                        const key = `${me.join(',')}|${opp.join(',')}`;
                        history.opponentCounts[key] = (history.opponentCounts[key] || 0) + 1;
                    });
                });
            });

            return history;
        }

        // ◆ 重評価：fullScore にも必ず diff チェックを入れる
        function fullScore(candidate, existingMatches, matchIndex) {
            const temp = [...existingMatches, candidate];
            const diff = calcMaxPlayCountDiff(temp, appState.currentTotalMemberCount);
            const diffThreshold = appState.isRegeneratingAfterDropout ? 3 : 1;
            if (diff > diffThreshold) {
                return -Infinity;
            }
            // まず basicScore を呼んで基礎点が -Infinity なら棄却
            let score = basicScore(candidate, existingMatches, matchIndex);
            if (score === -Infinity) {
                return -Infinity;
            }
            // 本物の heavy 履歴取得
            const history = getHistoryData(existingMatches);
            // heavy 評価分を上乗せ
            score = calculateScore(candidate, history, existingMatches, /*skipHeavy=*/false);
            return score;
        }


        // ◆ 二段階フィルタ版 findBestMatchCandidate
        function findBestMatchCandidate(matchIndex, maxConsecutiveLimit) {
            const existing = appState.matches.slice(0, matchIndex);
            const LIGHT = 2000, POOL = 100;

            // 探索を2段階で行うためのヘルパー関数
            const runSearch = (strictPlayCount) => {
                const pool = [];
                for (let i = 0; i < LIGHT; i++) {
                    const cand = generateRandomSingleMatch(matchIndex);
                    if (!cand) continue;

                    // isPlayCountRuleViolated を直接呼び出す（初期解生成は差2まで許容）
                    if (isPlayCountRuleViolated([...existing, cand], existing.length, 2)) {
                        continue;
                    }
                    if (isConsecutivePlayLimitViolated(cand, existing, maxConsecutiveLimit)) {
                        continue;
                    }

                    const history = getHistoryDataLight(existing);
                    const sc = calculateScore(cand, history, existing, true);
                    pool.push({ cand, score: sc });
                }

                if (pool.length === 0) return null;

                pool.sort((a, b) => b.score - a.score);
                const topCandidates = pool.slice(0, POOL);

                let best = null, bestScore = -Infinity;
                for (const { cand } of topCandidates) {
                    const history = getHistoryData(existing);
                    const sc = calculateScore(cand, history, existing, false);
                    if (sc > bestScore) {
                        bestScore = sc;
                        best = cand;
                    }
                }
                return best;
            };

            // ステップ1：まず、最も厳しいルール（回数差1以内）で探索
            let bestMatch = runSearch(true);

            // ステップ2：もし厳しいルールで見つからなければ、少しルールを緩和して再探索
            if (!bestMatch) {
                console.warn(`第${matchIndex + 1}試合: 厳しい条件で見つからなかったため、プレイ回数差の制約を緩和して再探索します。`);
                bestMatch = runSearch(false);
            }

            return bestMatch;
        }

        // appState.matches + candidate で計算した「最大差」を返す
        function calcMaxPlayCountDiff(matches, totalPlayers) {
            const cnt = Array(totalPlayers).fill(0);
            matches.forEach(m =>
                m.playersThisRound.forEach(p => cnt[p]++)
            );
            return Math.max(...cnt) - Math.min(...cnt);
        }


        // 決定版修正：evaluateCandidate
        function evaluateCandidate(candidate, existingMatches, regenerationStartIndex = -1, limit) {
            const temp = [...existingMatches, candidate];
            const diff = calcMaxPlayCountDiff(temp, appState.currentTotalMemberCount);
            const diffThreshold = appState.isRegeneratingAfterDropout ? 2 : 1;
            if (diff > diffThreshold) {
                return -Infinity;
            }
            // 再生成モードでは上限チェックをスキップ
            if (!appState.isRegeneratingAfterDropout &&
                isConsecutivePlayLimitViolated(candidate, existingMatches, limit)
            ) {
                return -Infinity;
            }
            const tempMatches = [...existingMatches, candidate];
            if (isPlayCountRuleViolated(tempMatches, regenerationStartIndex)) {
                return -Infinity;
            }

            const history = getHistoryData(existingMatches);
            let score = calculateScore(candidate, history, existingMatches);
            return score + Math.random();
        }


        function generateRandomSingleMatch(matchIndex) {
            const allPlayers = Array.from({ length: appState.currentTotalMemberCount }, (_, k) =>
                k);
            let availablePlayersForRound = allPlayers.filter(pIdx =>
                isPlayerActive(pIdx, matchIndex + 1, appState.exclusions, appState.joins));
            const courts = [];
            for (let c = 0; c < appState.currentSurfaceCount; c++) {
                if
                    (availablePlayersForRound.length < 4) break; const courtPlayers = []; for (let p = 0; p
                        < 4; p++) {
                    const playerIndex = Math.floor(Math.random() *
                        availablePlayersForRound.length);
                    courtPlayers.push(availablePlayersForRound.splice(playerIndex, 1)[0]);
                } const
                    team1 = [courtPlayers[0], courtPlayers[1]].sort((a, b) => a - b);
                const team2 = [courtPlayers[2], courtPlayers[3]].sort((a, b) => a - b);
                courts.push({ team1, team2, players: courtPlayers.sort((a, b) => a - b) });
            }
            if (courts.length === 0) return null;
            const playersThisRound = courts.flatMap(c => c.players);
            const restingPlayers = allPlayers.filter(p => !playersThisRound.includes(p));
            return { courts, restingPlayers, playersThisRound };
        }

        function isCandidateCorrectType(court, ruleType, groups) {
            if (ruleType === undefined) ruleType = document.querySelector('input[name="ruleType"]:checked').value;
            if (groups === undefined) groups = appState.groups;
            if (ruleType === 'none') return true;
            const getGroup = (index) => groups[index] || 'default';
            if (ruleType === 'fixedPair') {
                const team1IsFixed = getGroup(court.team1[0]) === 'P1' && getGroup(court.team1[1])
                    === 'P1';
                const team2IsFixed = getGroup(court.team2[0]) === 'P1' && getGroup(court.team2[1])
                    === 'P1';
                return (team1IsFixed && !team2IsFixed) || (!team1IsFixed && team2IsFixed);
            }
            if (ruleType === 'genderMix') {
                const team1Groups = new Set(court.team1.map(p => getGroup(p)));
                const team2Groups = new Set(court.team2.map(p => getGroup(p)));
                const team1IsMix = team1Groups.has('M') && team1Groups.has('F');
                const team2IsMix = team2Groups.has('M') && team2Groups.has('F');
                return team1IsMix && team2IsMix;
            }
            return false;
        }

        /**
         * 過去の試合履歴から、評価に必要な各種データを集計するヘルパー関数
         * @param {Array} existingMatches - 過去の試合の配列
         * @returns {Object} 集計済みデータ（ペアごとの出場回数、相手ペアとの対戦回数など）
         */
        function getHistoryData(existingMatches) {
            const history = {
                lastPairs: new Set(),
                opponentCounts: {},
                pairCounts: {},
                cardHistory: {},
                lastRestingPlayers: new Set(),
                individualOpponentCounts: {},  //  "p1|p2": 回数
                restCounts: {}                 //  pIdx: 休憩回数
            };
            // 全員キーを用意
            const N = appState.currentTotalMemberCount;
            for (let i = 0; i < N; i++) {
                history.restCounts[i] = 0;
            }
            if (existingMatches.length > 0) {
                const lastMatch = existingMatches[existingMatches.length - 1];
                lastMatch.courts.forEach(c => {
                    history.lastPairs.add(c.team1.join(','));
                    history.lastPairs.add(c.team2.join(','));
                });
                history.lastRestingPlayers = new Set(lastMatch.restingPlayers);
            }

            existingMatches.forEach(m => {
                // 休憩カウント
                m.restingPlayers.forEach(p => history.restCounts[p]++);

                m.courts.forEach(c => {
                    const teamA = c.team1, teamB = c.team2;

                    // 個人対戦カウント
                    teamA.forEach(p => {
                        const key = `${p}|${teamB.join(',')}`;
                        history.individualOpponentCounts[key] = (history.individualOpponentCounts[key] || 0) + 1;
                    });
                    teamB.forEach(p => {
                        const key = `${p}|${teamA.join(',')}`;
                        history.individualOpponentCounts[key] = (history.individualOpponentCounts[key] || 0) + 1;
                    });

                    // 対戦カード履歴
                    const cardKey = c.players.join(',');
                    history.cardHistory[cardKey] = (history.cardHistory[cardKey] || 0) + 1;

                    // ペア出場履歴
                    [c.team1, c.team2].forEach(team => {
                        const pairKey = team.join(',');
                        history.pairCounts[pairKey] = (history.pairCounts[pairKey] || 0) + 1;
                    });

                    // 相手ペアとの対戦履歴
                    [[c.team1, c.team2], [c.team2, c.team1]].forEach(([me, opp]) => {
                        me.forEach(p => {
                            const key = `${p}|${opp.join(',')}`;
                            history.opponentCounts[key] = (history.opponentCounts[key] || 0) + 1;
                        });
                    });
                });
            });
            return history;
        }

        // 3) 各種ヘルパー関数
        function calcCV(values) {
            const n = values.length;
            if (n === 0) return 0;
            const avg = values.reduce((a, b) => a + b, 0) / n;
            if (avg === 0) return 0;
            const sd = Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / n);
            return sd / avg;
        }

        function entropy(values) {
            const total = values.reduce((a, b) => a + b, 0);
            return -values.reduce((sum, v) => {
                if (v === 0) return sum;
                const p = v / total;
                return sum + p * Math.log2(p);
            }, 0);
        }

        function minRepetitionInterval(cardHistory, currentRound) {
            // cardHistory: { "p1,p2,p3,p4": [r1,r2,…], … }
            let minI = Infinity;
            for (const rounds of Object.values(cardHistory)) {
                if (rounds.length === 0) continue;
                const last = rounds[rounds.length - 1];
                minI = Math.min(minI, currentRound - last);
            }
            return minI;
        }

        function windowPlayDiff(matches, windowSize, playerCount) {
            let worst = 0;
            for (let i = windowSize; i <= matches.length; i++) {
                const slice = matches.slice(i - windowSize, i);
                const cnt = Array(playerCount).fill(0);
                slice.forEach(m => m.playersThisRound.forEach(p => cnt[p]++));
                worst = Math.max(worst, Math.max(...cnt) - Math.min(...cnt));
            }
            return worst;
        }


        /**
         * 必須ルール：プレイ回数差が1を超えていないかチェックする
         * @param {Array} tempMatches - 評価対象の試合を含む全試合
         * @param {number} regenerationStartIndex - 再生成の開始インデックス
         * @returns {boolean} ルール違反があれば true
         */
        function isPlayCountRuleViolated(tempMatches, regenerationStartIndex, overrideDiffThreshold = undefined) {
            const cumulativePlays = new Array(appState.currentTotalMemberCount).fill(0);
            for (let i = 0; i < tempMatches.length; i++) {
                const match = tempMatches[i];
                const matchNumber = i + 1;

                match.playersThisRound.forEach(playerIdx => {
                    cumulativePlays[playerIdx]++;
                });

                if (regenerationStartIndex === -1 || i >= regenerationStartIndex) {
                    const activePlayerPlays = [];
                    for (let pIdx = 0; pIdx < appState.currentTotalMemberCount; pIdx++) {
                        if (isPlayerActive(pIdx, matchNumber, appState.exclusions, appState.joins)) {
                            // 途中参加者(按分型): 仮想オフセットを加算してから比較する
                            activePlayerPlays.push(cumulativePlays[pIdx] + (appState.joinOffsets[pIdx] || 0));
                        }
                    }

                    if (activePlayerPlays.length > 1) {
                        const diff = Math.max(...activePlayerPlays) - Math.min(...activePlayerPlays);
                        const diffThreshold = overrideDiffThreshold !== undefined
                            ? overrideDiffThreshold
                            : (appState.isRegeneratingAfterDropout ? 2 : 1);
                        if (diff > diffThreshold) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }

        /**
         * スコアを計算するメイン関数。各評価関数を呼び出す。
         * @param {Object} candidate - 評価対象の試合候補
         * @param {Object} history - getHistoryDataで集計済みの履歴データ
         * @param {Array} existingMatches - 過去の試合の配列
         * @returns {number} 評価スコア
         */
        function calculateScore(candidate, history, existingMatches, skipHeavy = false) {
            let score = 0;
            // 直前の連続プレイ回数に応じて重くペナルティ
            candidate.playersThisRound.forEach(pIdx => {
                // 既存マッチを後ろからさかのぼって連続出場を数える
                let streak = 1;
                for (let i = existingMatches.length - 1; i >= 0; i--) {
                    if (existingMatches[i].playersThisRound.includes(pIdx)) streak++;
                    else break;
                }
                score -= streak * SCORE_SETTINGS.PENALTY_CONSECUTIVE_PLAY_STREAK;
            });
            const { PENALTY_CARD_DUPLICATION, PENALTY_CARD_DUPLICATION_LATE, PENALTY_OPPONENT_REPETITION, BONUS_SPECIAL_RULE, PENALTY_CONSECUTIVE_PAIR, PENALTY_PAIR_FAIRNESS_CV, PENALTY_CONSECUTIVE_REST, BONUS_REST_PLAYER_PRIORITY } = SCORE_SETTINGS;

            candidate.playersThisRound.forEach(pIdx => {
                if (history.lastRestingPlayers.has(pIdx)) score += BONUS_REST_PLAYER_PRIORITY;
            });
            candidate.restingPlayers.forEach(pIdx => {
                if (history.lastRestingPlayers.has(pIdx)) score -= PENALTY_CONSECUTIVE_REST;
            });

            const tempPairCounts = { ...history.pairCounts };

            candidate.courts.forEach(court => {
                const cardKey = court.players.join(',');
                if (history.cardHistory[cardKey]) {
                    const penalty = existingMatches.length > 12 ? PENALTY_CARD_DUPLICATION_LATE : PENALTY_CARD_DUPLICATION;
                    score -= penalty * (history.cardHistory[cardKey] || 0);
                }

                // ▼▼▼ 特別ルールの評価ロジックをここに集約・修正 ▼▼▼
                const ruleType = appState.generationSettings.ruleType || document.querySelector('input[name="ruleType"]:checked').value;
                const groups = appState.generationSettings.groups || {};
                const getGroup = (index) => groups[index] || 'M';

                if (ruleType === 'genderMix') {
                    // 各チームが男女MIXかを判定
                    const team1IsMix = new Set(court.team1.map(getGroup)).size > 1;
                    const team2IsMix = new Set(court.team2.map(getGroup)).size > 1;
                    // MIXペアが1つ作られるごとにボーナス点を加算
                    if (team1IsMix) score += BONUS_SPECIAL_RULE;
                    if (team2IsMix) score += BONUS_SPECIAL_RULE;
                } else if (ruleType === 'fixedPair') {
                    // 固定ペアが正しく含まれているかを判定
                    const team1IsFixed = getGroup(court.team1[0]) === 'P1' && getGroup(court.team1[1]) === 'P1';
                    const team2IsFixed = getGroup(court.team2[0]) === 'P1' && getGroup(court.team2[1]) === 'P1';
                    // 固定ペアがコートに1組だけ含まれていればボーナス
                    if ((team1IsFixed && !team2IsFixed) || (!team1IsFixed && team2IsFixed)) {
                        score += BONUS_SPECIAL_RULE;
                    }
                }
                // ▲▲▲ 修正ここまで ▲▲▲

                [court.team1, court.team2].forEach(team => {
                    const pairKey = team.join(',');
                    if (history.lastPairs.has(pairKey)) score -= PENALTY_CONSECUTIVE_PAIR;
                    tempPairCounts[pairKey] = (tempPairCounts[pairKey] || 0) + 1;
                });

                [[court.team1, court.team2], [court.team2, court.team1]].forEach(([me, opp]) => {
                    me.forEach(p => {
                        const key = `${p}|${opp.join(',')}`;
                        if (history.opponentCounts[key]) {
                            score -= PENALTY_OPPONENT_REPETITION * (history.opponentCounts[key] ** 2);
                        }
                    });
                });

                const key1 = court.team1.slice().sort((a, b) => a - b).join(',');
                if (!history.pairCounts[key1]) score += SCORE_SETTINGS.BONUS_NEW_PAIR;
                else score -= SCORE_SETTINGS.PENALTY_REPEAT_PAIR;

                const key2 = court.team2.slice().sort((a, b) => a - b).join(',');
                if (!history.pairCounts[key2]) score += SCORE_SETTINGS.BONUS_NEW_PAIR;
                else score -= SCORE_SETTINGS.PENALTY_REPEAT_PAIR;
            });

            if (!skipHeavy) {
                const pairValues = Object.values(tempPairCounts);
                if (pairValues.length) {
                    const cv = calcCV(pairValues);
                    score -= cv * PENALTY_PAIR_FAIRNESS_CV;
                }
            }

            return score + Math.random() * 1e-6;
        }



        function regenerateAllPossiblePairs() {
            appState.allPossiblePairs = [];
            const _ruleType = document.querySelector('input[name="ruleType"]:checked')?.value || 'none';
            const _groups = appState.groups || {};
            // genderMixの場合: strictモード（両性とも十分な人数がいる）のみM-Fペアに限定
            // best-effortモード（片性が不足）では全ペアを対象にする
            const _isStrict = _ruleType === 'genderMix' && !isGenderMixBestEffort(_groups, appState.currentSurfaceCount);
            // 未到着(全試合不参加)のメンバーを含むペアは構造上決して成立しないため母数から除く。
            // 含めるとペア多様性・公平性の分母が実現不可能なペアで膨らみ、評価が常に悪化する
            const _jnsPairs = appState.joins || {};
            for (let i = 0; i < appState.currentTotalMemberCount; i++) {
                if (_jnsPairs[i] === JOIN_NOT_ARRIVED) continue;
                for (let j = i + 1; j < appState.currentTotalMemberCount; j++) {
                    if (_jnsPairs[j] === JOIN_NOT_ARRIVED) continue;
                    if (_isStrict) {
                        const gi = _groups[i] || 'default';
                        const gj = _groups[j] || 'default';
                        if (!((gi === 'M' && gj === 'F') || (gi === 'F' && gj === 'M'))) continue;
                    }
                    appState.allPossiblePairs.push([i, j]);
                }
            }
            const colors = generateColorPalette(appState.allPossiblePairs.length);
            appState.pairIdMap = {}; appState.pairColorMap = {};
            appState.allPossiblePairs.forEach((pair, index) => {
                const key = pair.join(',');
                appState.pairIdMap[key] = index + 1;
                appState.pairColorMap[key] = colors[index];
            });
        }

        function createDeterministicFirstMatch() {
            const allMembers = Array.from({ length: appState.currentTotalMemberCount }, (_, i) => i);
            // 第1試合は「現時点でアクティブなメンバー」の登録順先頭(面数×4)人のみを使う。
            // 途中参加者は参加前の第1試合には出せないため、全メンバーからではなく
            // アクティブなメンバーからのみ選ぶ（人数が足りなければコート数を減らす）
            const p = allMembers.filter(i => isPlayerActive(i, 1, appState.exclusions, appState.joins));
            const courts = [], playersThisRound = [];
            for (let c = 0; c < appState.currentSurfaceCount; c++) {
                if (p.length < 4)
                    break; const team1 = [p.shift(), p.shift()], team2 = [p.shift(), p.shift()];
                courts.push({
                    team1, team2, players: [...team1, ...team2].sort((a, b) => a -
                        b)
                });
                playersThisRound.push(...team1, ...team2);
            }
            // restingPlayers = 選ばれなかった全メンバー（アクティブな休憩者 + 未参加・離脱済み）
            const restingPlayers = allMembers.filter(i => !playersThisRound.includes(i));
            return { courts, restingPlayers, playersThisRound };
        }

        // ▼▼▼ この新しい関数を追加してください ▼▼▼

        function renderAnalysisCharts() {
            if (appState.matches.length === 0) return; // 念のためデータチェック

            // renderPlayPatternTable(); // ← 不要になったこの行を削除しました

            renderSankeyChart();
            renderCumulativePlayCountChart();
            renderMemberProfileRadarChart();
            renderPairCombinationHeatmap();
            renderPairVsPairHeatmap();
        }


        function renderMatchList() {
            // 1. まずリスト表示エリアを空にする
            dom.matchListContainer.innerHTML = '';
            // 2. HTMLに追加した「設計図」を取得する
            const template = document.getElementById('match-item-template');

            // 3. 全ての試合データについてループ処理を行う
            appState.matches.forEach((match, matchIdx) => {
                // 4. 設計図から新しい試合アイテムを1つ複製（コピー）する
                const clone = template.content.cloneNode(true);
                const item = clone.firstElementChild; // 複製した要素の本体を取得

                // 5. 複製したアイテム内の各部分（チェックボックス、タイトルなど）を探し出す
                const checkbox = item.querySelector('.match-checkbox');
                const titleLabel = item.querySelector('.match-title');
                const restingPlayersSpan = item.querySelector('.resting-players');
                const courtsContainer = item.querySelector('.courts-container');

                // 6. 探し出した部分に、実際の試合データを設定していく
                checkbox.id = `match-${matchIdx}`;
                checkbox.dataset.matchIndex = matchIdx;
                checkbox.checked = appState.completedMatches.has(matchIdx);
                if (checkbox.checked) { item.style.opacity = '0.38'; item.style.transition = 'opacity 0.3s'; }

                titleLabel.htmlFor = `match-${matchIdx}`;
                titleLabel.textContent = `第${matchIdx + 1}試合`;

                const matchNumber = matchIdx + 1;
                // まだ参加していないメンバーは「休憩」ではなく「未参加」として区別する
                const restingActiveNames = match.restingPlayers
                    .filter(i => isPlayerActive(i, matchNumber, appState.exclusions, appState.joins))
                    .map(i => appState.members[i]);
                const notYetJoinedNames = match.restingPlayers
                    .filter(i => !isPlayerActive(i, matchNumber, appState.exclusions, appState.joins))
                    .map(i => appState.members[i]);
                let restingLabel = `休憩: ${restingActiveNames.join(', ') || 'なし'}`;
                if (notYetJoinedNames.length > 0) {
                    restingLabel += ` ｜ 未参加: ${notYetJoinedNames.join(', ')}`;
                }
                restingPlayersSpan.textContent = restingLabel;

                // 7. コート情報（対戦カード）を生成して追加する
                match.courts.forEach((court, courtIdx) => {
                    const leftBadges = toBadges(court.team1, 'teamA');
                    const rightBadges = toBadges(court.team2, 'teamB');

                    const courtDiv = document.createElement('div');
                    courtDiv.className = 'text-sm flex items-center gap-2 flex-shrink-0';
                    courtDiv.innerHTML = `
                        <strong class="font-semibold text-gray-600">C${courtIdx + 1}:</strong>
                        <div class="flex items-center gap-1">${leftBadges}</div>
                        <span class="text-gray-400">vs</span>
                        <div class="flex items-center gap-1">${rightBadges}</div>
                        <button class="edit-match-btn ml-2 text-xs p-1 rounded hover:bg-gray-200" data-match-index="${matchIdx}" data-court-index="${courtIdx}" aria-label="この試合を編集">
                            <svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036 a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.5L16.732 3.732z" />
                            </svg>
                        </button>
                    `;
                    courtsContainer.appendChild(courtDiv);
                });

                // 8. チェックボックスのクリックイベントを設定する
                checkbox.addEventListener('change', e => {
                    const idx = +e.target.dataset.matchIndex;
                    item.style.transition = 'opacity 0.3s';
                    if (e.target.checked) {
                        appState.completedMatches.add(idx);
                        item.style.opacity = '0.38';
                    } else {
                        appState.completedMatches.delete(idx);
                        item.style.opacity = '1';
                    }
                    updateProgressIndicator();
                    saveState();
                });

                // 9. 完成した試合アイテムを、画面のリストに1つ追加する
                dom.matchListContainer.appendChild(item);
            });
        }

        function toBadges(pairIndices, teamClass = '') {
            const key = [...pairIndices].sort((a, b) => a - b).join(',');
            const pairId = appState.pairIdMap[key];
            const textColor = '#111827';

            const generationGroups = appState.generationSettings?.groups || {};
            const ruleType = appState.generationSettings?.ruleType || document.querySelector('input[name="ruleType"]:checked').value;

            const isTheFixedPair = ruleType === 'fixedPair' &&
                generationGroups[pairIndices[0]] === 'P1' && generationGroups[pairIndices[1]] === 'P1';

            // 利用可能な「枠線スタイル」のクラス名を配列で定義 (''は無地の枠)
            const borderStyles = ['', 'border-dashed', 'border-dotted', 'border-double'];
            // ペアIDから適用する枠線スタイルを決定
            const borderClass = borderStyles[pairId % borderStyles.length];

            // 枠線スタイルクラスを含めて、classNames変数を「1回だけ」宣言する
            const classNames = ['badge', teamClass, borderClass];

            let inlineStyle = `color:${textColor};`;

            if (isTheFixedPair) {
                classNames.push('fixedpair');
            } else {
                const pairColor = appState.pairColorMap[key] || '#cccccc';
                inlineStyle += ` background-color:${pairColor};`;
            }

            const isMixRule = ruleType === 'genderMix';
            // 表示順: 表示名の数値順にソート（インデックス順ではなく "1 & 2" が "2 & 1" にならないよう）
            const _displaySorted = [...pairIndices].sort((a, b) => {
                const na = parseInt(appState.members[a], 10), nb = parseInt(appState.members[b], 10);
                if (!isNaN(na) && !isNaN(nb)) return na - nb;
                return String(appState.members[a]).localeCompare(String(appState.members[b]));
            });
            const namesHtml = _displaySorted.map(idx => {
                const name = appState.members[idx];
                if (isMixRule && generationGroups[idx] === 'F') {
                    return `<span class="female-pill">${name}</span>`;
                }
                return name;
            }).join(' & ');

            return `<span class="${classNames.join(' ')}" style="${inlineStyle}">${namesHtml}(P${pairId})</span>`;
        }

        function updateProgressIndicator() {
            const total = appState.matches.length, completed =
                appState.completedMatches.size;
            const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
            dom.progressText.textContent = `進行状況: ${completed} / ${total} 試合完了
                                            (${percent}%)`;
            dom.progressFill.style.width = `${percent}%`;
        }

        function renderSankeyChart() {
            const container = dom.sankeyChartContainer;
            container.innerHTML = '';
            if (appState.matches.length === 0) return;
            const { nodes, links } = prepareSankeyData();
            if (links.length === 0 || !container.clientWidth) return;

            const width = container.clientWidth;
            const height = 450;
            const svg = d3.select(container).append("svg").attr("width",
                width).attr("height", height);
            const sankey = d3.sankey().nodeWidth(24).nodePadding(10).extent([[1, 5],
            [width - 1, height - 5]]);
            const { nodes: graphNodes, links: graphLinks } = sankey({
                nodes: nodes.map(d => ({ ...d })),
                links: links.map(d => ({ ...d }))
            });
            const color = d3.scaleOrdinal(d3.schemeCategory10);

            svg.append("g").selectAll(".sankey-link").data(graphLinks).enter().append("path")
                .attr("class", "sankey-link").attr("d", d3.sankeyLinkHorizontal())
                .attr("stroke", d => color(d.source.name)).attr("stroke-width", d =>
                    Math.max(1, d.width));

            const node =
                svg.append("g").selectAll(".sankey-node").data(graphNodes).enter().append("g")
                    .attr("class", "sankey-node").attr("transform", d =>
                        `translate(${d.x0},${d.y0})`);

            node.append("rect").attr("height", d => d.y1 - d.y0).attr("width",
                sankey.nodeWidth()).attr("fill", d => color(d.name.split('&')[0].trim()));
            node.append("text").attr("x", d => d.x0 < width / 2 ? sankey.nodeWidth() + 6
                : -6).attr("y", d => (d.y1 - d.y0) / 2)
                .attr("dy", "0.35em").attr("text-anchor", d => d.x0 < width / 2
                    ? "start" : "end").text(d => d.name);
        }

        function prepareSankeyData() {
            const memberNodes = appState.members.map(name => ({ name }));
            const pairUsage = calculateAllPairUsageCounts(appState.matches);
            // value > 0 のペアのみ使用（0回のペアはsankeyに不要）
            const activePairUsage = Object.fromEntries(
                Object.entries(pairUsage).filter(([_, v]) => v > 0)
            );
            const pairNodes = Object.keys(activePairUsage).map(key => ({
                name: key.split(',').map(i => (appState.members[i] || `P${parseInt(i) + 1}`)).join(' & ')
            }));
            const nodes = [...memberNodes, ...pairNodes];
            const nodeIndexMap = new Map(nodes.map((n, i) => [n.name, i]));
            const links = [];
            Object.entries(activePairUsage).forEach(([key, value]) => {
                const pairName = key.split(',').map(i => (appState.members[i] || `P${parseInt(i) + 1}`)).join(' & ');
                const pairIndex = nodeIndexMap.get(pairName);
                if (pairIndex === undefined) return; // nullチェック
                key.split(',').forEach(memberIndex => {
                    const memberName = appState.members[memberIndex] || `P${parseInt(memberIndex) + 1}`;
                    const memberNodeIndex = nodeIndexMap.get(memberName);
                    if (memberNodeIndex === undefined) return; // nullチェック
                    links.push({ source: memberNodeIndex, target: pairIndex, value });
                });
            });
            return { nodes, links };
        }

        function renderMemberProfileRadarChart() {
            // 既存チャートが残っていたら破棄
            const existing2 = Chart.getChart(dom.memberProfileRadarChart);
            if (existing2) existing2.destroy();
            // --------------------------
            if (appState.charts.memberProfileRadarChart)
                appState.charts.memberProfileRadarChart.destroy();

            // メンバー数を appState から取得して渡す
            const totalMembers = appState.currentTotalMemberCount;
            const stats = appState.members.map((_, memberIdx) => ({
                playCount: calculateTotalPlayCounts(appState.matches, totalMembers)[memberIdx] || 0,
                maxConsecutive: calculateMaxConsecutiveOverallPerMember(appState.matches, totalMembers)[memberIdx] || 0,
                pairingDiversity: calculatePairingDiversity(appState.matches)[memberIdx] || 0,
                restCount: appState.matches.length - (calculateTotalPlayCounts(appState.matches, totalMembers)[memberIdx] || 0),
            }));

            const maxValues = {
                playCount: Math.max(1, ...stats.map(s => s.playCount)),
                maxConsecutive: Math.max(1, ...stats.map(s => s.maxConsecutive)),
                pairingDiversity: Math.max(1, ...stats.map(s => s.pairingDiversity)),
                restCount: Math.max(1, ...stats.map(s => s.restCount)),
            };
            const colorPalette = generateColorPalette(appState.members.length);
            const datasets = appState.members.map((name, i) => {
                const hsl = colorPalette[i];
                const bgColor = hsl.replace('hsl(', 'hsla(').replace(')', ', 0.5)');
                const borderColor = hsl.replace('hsl(', 'hsla(').replace(')', ', 1)');
                return {
                    label: name,
                    data: [(stats[i].playCount / maxValues.playCount) * 100,
                    (stats[i].pairingDiversity / maxValues.pairingDiversity) * 100,
                    (stats[i].restCount / maxValues.restCount) * 100,
                    (stats[i].maxConsecutive / maxValues.maxConsecutive) * 100],
                    backgroundColor: bgColor, borderColor: borderColor,
                };
            });
            appState.charts.memberProfileRadarChart = new
                Chart(dom.memberProfileRadarChart, {
                    type: 'radar', data: {
                        labels: ['総プレイ回数', 'ペア多様性', '総休憩回数', '最大連続プレイ'], datasets
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false, scales: {
                            r: { suggestedMin: 0, suggestedMax: 100 }
                        }
                    }
                });
        }

        function handleChartClick(event, elements) {
            if (elements.length > 0) {
                const memberIndex = elements[0].datasetIndex;
                const memberName = appState.members[memberIndex];
                const memberMatches = appState.matches.map((match, matchIdx) => {
                    let playedIn = null;
                    match.courts.forEach(court => {
                        if (court.team1.includes(memberIndex)) playedIn = {
                            team:
                                court.team1, opponent: court.team2
                        };
                        if (court.team2.includes(memberIndex)) playedIn = {
                            team:
                                court.team2, opponent: court.team1
                        };
                    });
                    return playedIn ? { matchIdx, ...playedIn } : null;
                }).filter(Boolean);

                const contentHtml = memberMatches.map(m => `<div
                                                        class="p-2 border-b"><strong>第${m.matchIdx + 1}試合:</strong>
                                                        <span class="text-sm">ペア: ${toBadges(m.team, 'teamA')} vs
                                                            ${toBadges(m.opponent, 'teamB')}</span>
                                                    </div>`).join('');
                showDialog(`${memberName} の試合履歴`, null, null, contentHtml);
            }
        }

        function renderCumulativePlayCountChart() {
            // 既存チャートが残っていたら破棄
            const existing1 = Chart.getChart(dom.cumulativePlayCountChart);
            if (existing1) existing1.destroy();
            if (appState.charts.cumulativePlayCountChart)
                appState.charts.cumulativePlayCountChart.destroy();
            const memberCumulativePlays = appState.members.map(() => [0]);
            appState.matches.forEach((match, matchIndex) => {
                appState.members.forEach((_, memberIndex) => {
                    let lastCount = memberCumulativePlays[memberIndex][matchIndex];
                    if (match.playersThisRound.includes(memberIndex)) lastCount++;
                    memberCumulativePlays[memberIndex].push(lastCount);
                });
            });
            const datasets = appState.members.map((name, i) => ({
                label: name,
                data: memberCumulativePlays[i].slice(1), tension: 0.1, borderWidth:
                    2,
            }));
            appState.charts.cumulativePlayCountChart = new
                Chart(dom.cumulativePlayCountChart, {
                    type: 'line', data: {
                        labels: appState.matches.map((_, i) => `M${i + 1}`), datasets
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false, scales: {
                            y: { beginAtZero: true }
                        }, onClick: handleChartClick
                    }
                });
        }

        function renderPairCombinationHeatmap() {
            const pairCounts = calculateAllPairUsageCounts(appState.matches);
            const maxCount = Math.max(1, ...Object.values(pairCounts));
            const headers = [' ', ...appState.members].map(h => `<th>${h}</th>
                                                    `).join('');
            const rows = appState.members.map((m1, i) => {
                const cells = appState.members.map((m2, j) => {
                    if (i === j) return `<td class="bg-gray-200">-</td>`;
                    if (j < i) return `<td>
                                                        </td>`;
                    const key = [i, j].join(',');
                    const count = pairCounts[key] || 0;
                    const opacity = count / maxCount;
                    return `<td
                                                            style="background-color: rgba(74, 144, 226, ${opacity})"
                                                            class="${opacity > 0.6 ? 'text-white font-bold' : ''}">
                                                            ${count}</td>`;
                }).join('');
                return `<tr>
                                                            <th>${m1}</th>${cells}
                                                        </tr>`;
            }).join('');
            dom.pairCombinationHeatmapContainer.innerHTML = `<table
                                                            class="heatmap-table">
                                                            <thead>
                                                                <tr>${headers}</tr>
                                                            </thead>
                                                            <tbody>${rows}</tbody>
                                                        </table>`;
        }

        function calculateTotalPlayCounts(matches, totalMembers) {
            const counts = {};
            for (let i = 0; i < totalMembers; i++) {
                counts[i] = 0;
            }
            matches.forEach(m => m.playersThisRound.forEach(pIdx => {
                if (counts[pIdx] !== undefined) {
                    counts[pIdx]++;
                }
            }));
            return counts;
        }

        function calculateAllPairUsageCounts(matches, memberCount) {
            const counts = {};
            // allPossiblePairsに含まれるペアのみ初期化（ruleTypeに応じてフィルタ済み）
            (appState.allPossiblePairs || []).forEach(([i, j]) => {
                counts[`${i},${j}`] = 0;
            });
            matches.forEach(m => m.courts.forEach(c => [c.team1, c.team2].forEach(team => {
                const key = [...team].sort((a, b) => a - b).join(',');
                if (key in counts) counts[key]++;
            })));
            return counts;
        }

        // 休憩を共にした回数をペアごとに集計（同じ顔ぶれが繰り返し休憩する偏りを検出するため）
        function calculateRestPairUsageCounts(matches, memberCount, exclusions, joins) {
            const counts = {};
            const excl = exclusions || {};
            const jns = joins || {};
            // 未到着(全試合不参加)のメンバーを含む休憩ペアは決して発生しないため母数から除く
            for (let i = 0; i < memberCount; i++) {
                if (jns[i] === JOIN_NOT_ARRIVED) continue;
                for (let j = i + 1; j < memberCount; j++) {
                    if (jns[j] === JOIN_NOT_ARRIVED) continue;
                    counts[`${i},${j}`] = 0;
                }
            }
            matches.forEach((m, matchIdx) => {
                const matchNumber = matchIdx + 1;
                // 離脱済み・未参加のメンバーは「常に休憩」扱いになり集計を歪めるため対象外にする
                const activeResting = m.restingPlayers.filter(p => isPlayerActive(p, matchNumber, excl, jns));
                for (let a = 0; a < activeResting.length; a++) {
                    for (let b = a + 1; b < activeResting.length; b++) {
                        const i = Math.min(activeResting[a], activeResting[b]);
                        const j = Math.max(activeResting[a], activeResting[b]);
                        counts[`${i},${j}`]++;
                    }
                }
            });
            return counts;
        }

        function calculateMaxConsecutiveRestsPerMember(matches, totalMembers) {
            const playerMaxStreaks = {};
            for (let pIdx = 0; pIdx < totalMembers; pIdx++) {
                let currentStreak = 0, maxStreak = 0;
                matches.forEach(m => {
                    // 休憩メンバーに含まれているかをチェック
                    if (m.restingPlayers.includes(pIdx)) {
                        currentStreak++;
                    } else {
                        currentStreak = 0;
                    }
                    if (currentStreak > maxStreak) {
                        maxStreak = currentStreak;
                    }
                });
                playerMaxStreaks[pIdx] = maxStreak;
            }
            return playerMaxStreaks;
        }

        function calculateMaxConsecutiveOverallPerMember(matches, totalMembers) {
            const playerMaxStreaks = {};
            for (let pIdx = 0; pIdx < totalMembers; pIdx++) {
                let currentStreak = 0, maxStreak = 0;
                matches.forEach(m => {
                    currentStreak = m.playersThisRound.includes(pIdx) ? currentStreak + 1 : 0;
                    if (currentStreak > maxStreak) maxStreak = currentStreak;
                });
                playerMaxStreaks[pIdx] = maxStreak;
            }
            return playerMaxStreaks;
        }
        function calculatePairingDiversity(matches) {
            const diversity = {};
            appState.members.forEach((_, pIdx) => {
                const partners = new Set();
                matches.forEach(m => m.courts.forEach(c => {
                    if (c.team1.includes(pIdx)) partners.add(c.team1.find(p => p
                        !== pIdx));
                    if (c.team2.includes(pIdx)) partners.add(c.team2.find(p => p
                        !== pIdx));
                }));
                partners.delete(undefined); diversity[pIdx] = partners.size;
            }); return diversity;
        }
        function getCardKey(court) {
            return [...court.team1, ...court.team2].sort((a, b) => a -
                b).join(',');
        }
        function calculateMatchCardCounts(matches) {
            const counts = {};
            matches.forEach((m, roundIdx) => {
                m.courts.forEach(c => {
                    const key = getCardKey(c);
                    if (!counts[key]) counts[key] = { count: 0, rounds: [] };
                    counts[key].count++;
                    counts[key].rounds.push(roundIdx + 1);
                });
            });
            return counts;
        }

        function calcGini(values) {
            const n = values.length;
            if (!n) return 0;
            const avg = values.reduce((a, b) => a + b, 0) / n;
            if (avg === 0) return 0;
            let sum = 0;
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    sum += Math.abs(values[i] - values[j]);
                }
            } return sum /
                (2 * n * n * avg);
        } function totalFourPlayerCards(n) { return nCk(n, 4); } function
            calcOpponentCoverage(matches, ruleType, groups, surfaceCount, totalMemberCount) {
            const seen = new
                Set(); matches.forEach(m => m.courts.forEach(c => {
                    const k = [c.team1.join(','),
                    c.team2.join(',')].sort().join('|');
                    seen.add(k);
                }));
            // genderMix strictモードのみ有効な対戦カード数を使う
            // 呼び出し元がruleType/groups/surfaceCount/totalMemberCountを渡さない場合のみ、現在のライブ状態にフォールバック
            const _rtOC = ruleType !== undefined ? ruleType : (document.querySelector('input[name="ruleType"]:checked')?.value || 'none');
            const _grpOC = groups !== undefined ? groups : (appState.groups || {});
            const _mcOC = Object.values(_grpOC).filter(g => g === 'M').length;
            const _fcOC = Object.values(_grpOC).filter(g => g === 'F').length;
            const _scOC = surfaceCount !== undefined ? surfaceCount : appState.currentSurfaceCount;
            const _tmcOC = totalMemberCount !== undefined ? totalMemberCount : appState.currentTotalMemberCount;
            const _isStrictOC = _rtOC === 'genderMix' && _mcOC > _scOC * 2 && _fcOC > _scOC * 2;
            let theoCap;
            if (_isStrictOC) {
                theoCap = nCk(_mcOC, 2) * nCk(_fcOC, 2) * 3;
                if (theoCap === 0) theoCap = nCk(_tmcOC, 4) * 3;
            } else {
                theoCap = nCk(_tmcOC, 4) * 3;
            }
            const roundCap = matches.length * _scOC;
            const max = Math.min(theoCap, roundCap);
            return {
                ratio: seen.size / max, used: seen.size,
                max
            };
        }


        /**
         * 統計情報を計算し、オブジェクトとして返す純粋な計算関数
         * @param {Array} matches - 試合の配列
         * @param {Array} members - メンバーの配列
         * @param {Array} allPossiblePairs - 全ペアの配列
         * @returns {object} 計算された統計情報のオブジェクト
         */
        function calculateSummaryStats(matches, members, allPossiblePairs, surfaceCount, exclusions, ruleType, groups, joins, joinOffsets) {
            // surfaceCount・exclusions・joins・joinOffsets・ruleType・groupsは、呼び出し元が渡さない場合のみ
            // 現在のライブ状態にフォールバック（後方互換）。SA探索中は必ず呼び出し元のsettingsを渡すこと。
            if (surfaceCount == null) surfaceCount = appState.currentSurfaceCount;
            if (exclusions == null) exclusions = appState.exclusions;
            if (joins == null) joins = appState.joins;
            if (joinOffsets == null) joinOffsets = appState.joinOffsets;
            if (ruleType === undefined) ruleType = document.querySelector('input[name="ruleType"]:checked')?.value || 'none';
            if (groups === undefined) groups = appState.groups || {};
            const pairUsage = calculateAllPairUsageCounts(matches, members.length);
            const cardCounts = calculateMatchCardCounts(matches);

            // 実際に1回以上出現したペアのみを「使用済み」とカウント
            const usedPairTypes = Object.values(pairUsage).filter(v => v > 0).length;
            const totalPairTypes = allPossiblePairs.length;
            const pairCoverageRatio = totalPairTypes > 0 ? usedPairTypes / totalPairTypes : 0;

            const usedCardTypes = Object.keys(cardCounts).length;
            // genderMix strictモードのみ有効な4人グループ（2M+2F）を分母に使う
            const _mcCard = Object.values(groups).filter(g => g === 'M').length;
            const _fcCard = Object.values(groups).filter(g => g === 'F').length;
            const _isStrictCard = ruleType === 'genderMix' && _mcCard > surfaceCount * 2 && _fcCard > surfaceCount * 2;
            let totalCardTypes;
            if (_isStrictCard) {
                totalCardTypes = nCk(_mcCard, 2) * nCk(_fcCard, 2);
                if (totalCardTypes === 0) totalCardTypes = totalFourPlayerCards(members.length);
            } else {
                totalCardTypes = totalFourPlayerCards(members.length);
            }
            const totalMatchesPlayed = matches.length * surfaceCount;
            const realisticMaxCards = Math.min(totalCardTypes, totalMatchesPlayed);
            const cardCoverageRatio = realisticMaxCards > 0 ? usedCardTypes / realisticMaxCards : 0;

            const opponentCoverageData = calcOpponentCoverage(matches, ruleType, groups, surfaceCount, members.length);

            const cvPair = calcCV(Object.values(pairUsage));
            const giniPair = calcGini(Object.values(pairUsage));

            const cardValues = Object.values(cardCounts).map(d => d.count);
            const cvCard = calcCV(cardValues);
            const giniCard = calcGini(cardValues);

            let maxDiff = 0;
            if (members.length > 0) {
                const cumulativePlays = new Array(members.length).fill(0);
                matches.forEach((match, matchIdx) => {
                    match.playersThisRound.forEach(playerIdx => cumulativePlays[playerIdx]++);
                    const activeIdx = members
                        .map((_, i) => i)
                        .filter(i => isPlayerActive(i, matchIdx + 1, exclusions, joins));
                    const _malesPC = activeIdx.filter(i => (groups[i] || 'default') === 'M');
                    const _femalesPC = activeIdx.filter(i => (groups[i] || 'default') === 'F');
                    const _isStrictPC = ruleType === 'genderMix' && _malesPC.length > surfaceCount * 2 && _femalesPC.length > surfaceCount * 2;
                    // 途中参加者(按分型): 参加前に他メンバーが積んでいたはずの理論プレイ数を
                    // 仮想的に加算してから比較する（参加後は同ペースで出場していれば公平とみなす）
                    const _effectivePlays = (i) => cumulativePlays[i] + (joinOffsets[i] || 0);
                    if (_isStrictPC) {
                        // strictモード: 性別内の最大差（性別間の差は構造上必然）
                        const mPlays = _malesPC.map(_effectivePlays);
                        const fPlays = _femalesPC.map(_effectivePlays);
                        const mDiff = mPlays.length > 1 ? Math.max(...mPlays) - Math.min(...mPlays) : 0;
                        const fDiff = fPlays.length > 1 ? Math.max(...fPlays) - Math.min(...fPlays) : 0;
                        maxDiff = Math.max(mDiff, fDiff);
                    } else {
                        // best-effortまたは他モード: 全員対象
                        const activePlays = activeIdx.map(_effectivePlays);
                        if (activePlays.length > 1) {
                            maxDiff = Math.max(...activePlays) - Math.min(...activePlays);
                        }
                    }
                });
            }

            const matchupFairness = calculateMatchupFairness(matches, allPossiblePairs);

            const restPairUsage = calculateRestPairUsageCounts(matches, members.length, exclusions, joins);
            const cvRestPair = calcCV(Object.values(restPairUsage));
            const giniRestPair = calcGini(Object.values(restPairUsage));

            return {
                maxPlayCountDiff: maxDiff,
                pairCoverage: { ratio: pairCoverageRatio, used: usedPairTypes, total: totalPairTypes },
                cardCoverage: { ratio: cardCoverageRatio, used: usedCardTypes, total: realisticMaxCards },
                opponentCoverage: { ratio: opponentCoverageData.ratio, used: opponentCoverageData.used, max: opponentCoverageData.max },
                pairFairness: { cv: cvPair, gini: giniPair },
                cardFairness: { cv: cvCard, gini: giniCard },
                matchupFairness: matchupFairness,
                restPairFairness: { cv: cvRestPair, gini: giniRestPair },
            };
        }



        function renderSummaryStats() {
            dom.summaryStatsGrid.innerHTML = '';
            if (appState.matches.length === 0) return;

            // --- 1. 必要な統計データをすべて計算 ---
            const statsData = calculateSummaryStats(appState.matches, appState.members, appState.allPossiblePairs);
            const firstRepetitionPair = calculateFirstRepetitionMatch(appState.matches, 'pair');
            const firstRepetitionGroup = calculateFirstRepetitionMatch(appState.matches, 'group');
            const partnerStats = calculatePartnerDiversityStats(appState.matches, appState.members);

            // --- 2. 各指標のレベルを判定 ---
            const frpPairLevel = (firstRepetitionPair === '全て新規' || firstRepetitionPair > appState.matches.length / 2) ? 'good' : (firstRepetitionPair > appState.matches.length / 3 ? 'warn' : 'bad');
            const frpGroupLevel = (firstRepetitionGroup === '全て新規' || firstRepetitionGroup > appState.matches.length / 2) ? 'good' : (firstRepetitionGroup > appState.matches.length / 3 ? 'warn' : 'bad');
            const partnerLevel = (partnerStats.min >= (appState.currentTotalMemberCount - 1) / 2) ? 'good' : (partnerStats.min >= (appState.currentTotalMemberCount - 1) / 3 ? 'warn' : 'bad');
            const ruleType = appState.generationSettings.ruleType || 'none';
            const pairFairnessLevel = judgeFairness(statsData.pairFairness.cv, statsData.pairFairness.gini, ruleType);
            const cardFairnessLevel = judgeFairness(statsData.cardFairness.cv, statsData.cardFairness.gini, 'none');
            const playCountDiffLevel = statsData.maxPlayCountDiff > 2 ? 'bad' : (statsData.maxPlayCountDiff > 1 ? 'warn' : 'good');
            const matchupFairnessLevel = judgeFairness(statsData.matchupFairness.cv, statsData.matchupFairness.gini, 'none');

            // --- 3. 各サマリーカードのHTMLを生成 ---

            // 多様性サマリー
            const createGraphHtml = (label, ratio, level, used, total) => {
                const percent = Math.round(ratio * 100);
                const colorClass = { good: 'bg-green-500', warn: 'bg-yellow-500', bad: 'bg-red-500' }[level] || 'bg-gray-500';
                return `<div class="w-full"><div class="flex justify-between items-center text-xs text-gray-500 mb-1"><span class="flex items-center gap-1"><span>${label}</span><span class="info-icon" data-stat="${label}">?</span></span><span><span class="font-semibold text-gray-700 dark:text-gray-200">${percent}%</span><span class="text-gray-400 ml-1">(${used}/${total})</span></span></div><div class="w-full bg-gray-200 rounded-full h-2.5 dark:bg-gray-700"><div class="${colorClass} h-2.5 rounded-full" style="width: ${percent}%"></div></div></div>`;
            };
            const diversityGraphHtml = `<div class="space-y-3">${createGraphHtml('ペア結成の多様性', statsData.pairCoverage.ratio, judgeCoverage(statsData.pairCoverage.ratio, 'pair'), statsData.pairCoverage.used, statsData.pairCoverage.total)}${createGraphHtml('対戦グループの多様性', statsData.cardCoverage.ratio, judgeCoverage(statsData.cardCoverage.ratio, 'card'), statsData.cardCoverage.used, statsData.cardCoverage.total)}${createGraphHtml('対戦カードの多様性', statsData.opponentCoverage.ratio, judgeCoverage(statsData.opponentCoverage.ratio, 'card'), statsData.opponentCoverage.used, statsData.opponentCoverage.max)}</div>`;
            const diversityTileHtml = `<div class="p-3 rounded-lg shadow bg-gray-50 dark:bg-gray-800 md:col-span-2 lg:col-span-3"><h4 class="font-bold text-center mb-2 text-sm dark:text-gray-300">多様性サマリー</h4>${diversityGraphHtml}</div>`;

            // 公平性サマリー
            const fairnessMetrics = [
                { label: 'ペア結成の公平性', level: pairFairnessLevel, cv: statsData.pairFairness.cv },
                { label: '対戦グループの公平性', level: cardFairnessLevel, cv: statsData.cardFairness.cv },
                { label: '対戦の公平性', level: matchupFairnessLevel, cv: statsData.matchupFairness.cv }
            ];
            const fairnessHtmlContent = fairnessMetrics.map(metric => {
                const infoIcon = STAT_INFO[metric.label] ? `<span class="info-icon ml-1" data-stat="${metric.label}">?</span>` : '';
                const levelColorClass = { good: 'text-green-600', warn: 'text-yellow-600', bad: 'text-red-600' }[metric.level] || 'text-gray-600';
                return `<div class="flex justify-between items-center py-1.5"><span class="text-xs text-gray-600 dark:text-gray-400 flex items-center">${metric.label}${infoIcon}</span><span class="font-semibold text-sm ${levelColorClass} dark:text-white">${LEVEL_TEXT[metric.level]} ${LEVEL_ICON[metric.level]}<span class="text-xs text-gray-500 dark:text-gray-400 ml-1">(${metric.cv.toFixed(2)})</span></span></div>`;
            }).join('<hr class="my-0.5 border-gray-200 dark:border-gray-700">');
            const fairnessTileHtml = `<div class="p-3 rounded-lg shadow bg-gray-50 dark:bg-gray-800 md:col-span-2 lg:col-span-2"><h4 class="font-bold text-center mb-1 text-sm dark:text-gray-300">公平性サマリー</h4><div class="space-y-0">${fairnessHtmlContent}</div></div>`;

            // ★★★ ここからが今回の修正点です ★★★

            // 序盤の多様性評価サマリー
            const frpMetrics = [
                { label: '初重複試合番号 (ペア)', level: frpPairLevel, value: firstRepetitionPair, subValue: '試合目' },
                { label: '初重複試合番号 (グループ)', level: frpGroupLevel, value: firstRepetitionGroup, subValue: '試合目' }
            ];
            const frpHtmlContent = frpMetrics.map(metric => {
                const infoIcon = STAT_INFO[metric.label] ? `<span class="info-icon ml-1" data-stat="${metric.label}">?</span>` : '';
                const levelColorClass = { good: 'text-green-600', warn: 'text-yellow-600', bad: 'text-red-600' }[metric.level] || 'text-gray-600';
                return `<div class="flex justify-between items-center py-1.5"><span class="text-xs text-gray-600 dark:text-gray-400 flex items-center">${metric.label}${infoIcon}</span><span class="font-semibold text-sm ${levelColorClass} dark:text-white">${metric.value}<span class="text-xs font-normal text-gray-500 dark:text-gray-400 ml-1">${metric.subValue}</span></span></div>`;
            }).join('<hr class="my-0.5 border-gray-200 dark:border-gray-700">');
            const frpTileHtml = `<div class="p-3 rounded-lg shadow bg-gray-50 dark:bg-gray-800"><h4 class="font-bold text-center mb-1 text-sm dark:text-gray-300">序盤の多様性</h4><div class="space-y-0">${frpHtmlContent}</div></div>`;

            // --- 残りの単独表示する指標 ---
            const otherStatsForUI = [
                { label: 'プレイ回数の最大差', value: `${statsData.maxPlayCountDiff} 回`, level: playCountDiffLevel },
                { label: 'ペア相手数の分布', value: `${partnerStats.min}/${partnerStats.avg.toFixed(1)}/${partnerStats.max}`, subValue: `(最小/平均/最大)`, level: partnerLevel }
            ];

            // --- 4. 全てのサマリーカードをグリッドに描画 ---
            // ── 総合グレードカード ──
            const gradeData = calcOverallGrade(statsData, appState.matches, appState.members, appState.allPossiblePairs);
            const ana = appState.lastRunAnalysis;
            const isConverged = ana?.converged === true;
            // 上限スコアと現在スコアを比較して再試行要否を判定
            const ceilRuleType = appState.generationSettings?.ruleType || 'none';
            const ceilInfo = calcConditionCeiling(
                appState.currentSurfaceCount,
                getEffectiveMemberCountForCeiling(),
                appState.matches.length,
                ceilRuleType,
                appState.groups
            );
            const ceilScore = ceilInfo.totalBase ?? ceilInfo.total;
            const curScore = gradeData.totalBase; // targetRate/ceilScoreはmixBonus抜きなので、比較側もbonus抜きで揃える
            const gapFromCeil = Math.max(0, ceilScore - curScore); // 上限超えは0として扱う
            // 上限との差が1点以内 → 実質上限到達（計算誤差・丸め誤差を吸収）
            const reachedCeiling = gapFromCeil <= 1.0;
            // 達成率（探索完了ダイアログ・renderGenerationSummaryと同じ「上限比の相対評価」）
            const relPct = ceilScore > 0 ? Math.round(curScore / ceilScore * 100) : 100;
            // 同条件の実測ベスト（表示専用の読み取りのみ、runCountは増やさない）
            const _empiricalEntryTile = getEmpiricalBest({
                currentSurfaceCount: appState.currentSurfaceCount,
                currentTotalMemberCount: appState.currentTotalMemberCount,
                matchCount: appState.matches.length,
                maxConsecutiveLimit: appState.maxConsecutiveLimit,
                ruleType: ceilRuleType,
                groups: appState.groups
            }) || { bestScore: -Infinity, runCount: 0 };
            const _empiricalGapTile = Math.max(0, _empiricalEntryTile.bestScore - curScore);
            const empiricalReached = _empiricalEntryTile.runCount >= 3 && _empiricalGapTile <= 1.0;
            // 「再試行不要」の判定も、ダイアログ等と同じく 相対95%以上 または gap≤1.0 または 実測ベスト同等 に揃える
            const noRetryNeeded = reachedCeiling || empiricalReached || relPct >= 95;

            // グレード文字・星・ラベルを絶対点数ではなく上限比の相対評価に統一
            // （条件によっては絶対100点満点に届かない上限しか存在しないため、絶対評価だと
            //   ダイアログでは「S・再試行不要」なのにここでは「C・再試行できます」という
            //   矛盾した表示になっていた）
            if (noRetryNeeded) {
                gradeData.grade = 'S';
                gradeData.stars = '★★★★★';
                gradeData.color = '#16a34a';
                gradeData.label = reachedCeiling ? '最高 (条件上限)' : '最高';
            } else if (relPct >= 88) {
                gradeData.grade = 'A'; gradeData.stars = '★★★★☆'; gradeData.color = '#2563eb'; gradeData.label = '優秀';
            } else if (relPct >= 78) {
                gradeData.grade = 'B'; gradeData.stars = '★★★☆☆'; gradeData.color = '#7c3aed'; gradeData.label = '良好';
            } else if (relPct >= 65) {
                gradeData.grade = 'C'; gradeData.stars = '★★☆☆☆'; gradeData.color = '#d97706'; gradeData.label = '普通';
            } else {
                gradeData.grade = 'D'; gradeData.stars = '★☆☆☆☆'; gradeData.color = '#dc2626'; gradeData.label = '要改善';
            }

            let convergeBadge;
            if (reachedCeiling) {
                // 上限との差1点以内 = 真のベスト（この条件で出せる最高の結果）
                convergeBadge = `<div style="display:inline-block;background:#dcfce7;color:#15803d;border:1px solid #86efac;border-radius:20px;padding:6px 16px;font-size:13px;font-weight:700;margin-top:10px;">✅ この条件での最高スコア (${ceilScore}点) — 再試行不要</div>`;
            } else if (empiricalReached) {
                // 理論上限には届かないが、過去の実測ベストと同等（構造的にこれが実用上限）
                convergeBadge = `<div style="display:inline-block;background:#dcfce7;color:#15803d;border:1px solid #86efac;border-radius:20px;padding:6px 16px;font-size:13px;font-weight:700;margin-top:10px;">✅ 過去${_empiricalEntryTile.runCount}回の実測ベスト(${_empiricalEntryTile.bestScore.toFixed(1)}点)と同等 — 再試行不要</div>`;
            } else if (noRetryNeeded) {
                // 上限には僅かに届かないが、達成率95%以上で目標達成とみなす
                convergeBadge = `<div style="display:inline-block;background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd;border-radius:20px;padding:6px 16px;font-size:13px;font-weight:700;margin-top:10px;">🎯 達成率${relPct}% — 再試行不要 (最高${ceilScore}点まであと${gapFromCeil.toFixed(1)}点)</div>`;
            } else {
                // 達成率95%未満 = 収束の有無にかかわらず改善余地あり
                const reason = isConverged ? '同じ結果が繰り返されています（局所最適の可能性）' : '時間切れ';
                convergeBadge = `<div style="display:inline-block;background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;border-radius:20px;padding:6px 16px;font-size:13px;font-weight:700;margin-top:10px;">🔄 達成率${relPct}%（最高${ceilScore}点まであと${gapFromCeil.toFixed(1)}点） — 再試行できます（${reason}）</div>`;
            }
            const gradeTileHtml = `
            <div style="background:linear-gradient(135deg,${gradeData.color}18,${gradeData.color}08);border:2px solid ${gradeData.color};border-radius:12px;padding:16px;text-align:center;grid-column:1/-1;">
                <div style="font-size:11px;color:#6b7280;font-weight:600;letter-spacing:0.05em;margin-bottom:6px;">総合評価</div>
                <div style="display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;">
                    <div style="text-align:center;">
                        <div style="font-size:52px;font-weight:900;color:${gradeData.color};line-height:1;">${gradeData.grade}</div>
                        <div style="font-size:12px;color:${gradeData.color};font-weight:600;">${gradeData.label}</div>
                    </div>
                    <div style="text-align:left;">
                        <div style="font-size:22px;letter-spacing:2px;color:${gradeData.color};">${gradeData.stars}</div>
                        <div style="font-size:28px;font-weight:700;color:${gradeData.color};">${gradeData.total}<span style="font-size:14px;font-weight:400;color:#9ca3af;">/100点</span></div>
                    </div>
                    <div style="text-align:left;font-size:12px;color:#6b7280;border-left:1px solid #e5e7eb;padding-left:16px;">
                        <div>プレイ公平性: <b>${gradeData.scores.playCount}点</b></div>
                        <div>ペア多様性: <b>${gradeData.scores.pairCoverage}点</b></div>
                        <div>グループ多様性: <b>${gradeData.scores.cardCoverage}点</b></div>
                        <div>対戦カード多様性: <b>${gradeData.scores.opponentCoverage}点</b></div>
                        <div>ペア公平性: <b>${gradeData.scores.pairFairness}点</b></div>
                        <div>対戦公平性: <b>${gradeData.scores.matchupFairness}点</b></div>
                        <div>序盤多様性: <b>${gradeData.scores.earlyDiversity}点</b></div>
                        <div>休憩ペア公平性: <b>${gradeData.scores.restPairFairness}点</b></div>
                    </div>
                </div>
                ${convergeBadge}
            </div>`;

            dom.summaryStatsGrid.innerHTML = `
        ${gradeTileHtml}
        ${diversityTileHtml}
        ${fairnessTileHtml}
        ${frpTileHtml}
    `;

            otherStatsForUI.forEach(stat => {
                const col = stat.level ? LEVEL_COLOR[stat.level] : 'bg-gray-50';
                const infoIcon = STAT_INFO[stat.label] ? `<span class="info-icon ml-1" data-stat="${stat.label}">?</span>` : '';
                const subValueHtml = stat.subValue ? `<p class="text-xs text-gray-500 dark:text-gray-400 mt-1">${stat.subValue}</p>` : '';
                dom.summaryStatsGrid.innerHTML += `
             <div class="p-3 rounded-lg shadow text-center flex flex-col justify-between h-full ${col} dark:bg-gray-800">
                 <div>
                     <p class="text-xl lg:text-2xl font-bold text-blue-600">${stat.value}</p>
                     <p class="text-xs text-gray-600 dark:text-gray-400 uppercase tracking-wider flex items-center justify-center mt-1">${stat.label}${infoIcon}</p>
                 </div>
                 ${subValueHtml}
             </div>`;
            });
        }

        function showDetailedStatsTable(tableId) {
            // ▼▼▼ dom.statsTabs と dom.statsTableContainer を正しいIDに修正 ▼▼▼
            const container = dom.detailedStatsTablesContainer;
            const tabs = dom.detailedStatsTabButtons.querySelectorAll('button');

            tabs.forEach(t => {
                if (t.dataset.table === tableId) {
                    t.classList.add('active');
                } else {
                    t.classList.remove('active');
                }
            });

            // コンテナを一度クリア
            if (container) container.innerHTML = '';

            let tableHTML = '';
            let cardHTML = '';

            switch (tableId) {
                case 'pairStats':
                    tableHTML = generatePairDetailTableHTML();
                    cardHTML = generatePairDetailCardHTML();
                    break;
                case 'matchStats':
                    tableHTML = generateMatchCardDetailTableHTML();
                    cardHTML = generateMatchCardCardHTML();
                    break;
                case 'opponentStats':
                    tableHTML = generateOpponentDetailTableHTML();
                    cardHTML = generateOpponentDetailCardHTML();
                    break;
            }

            if (container) {
                container.innerHTML = `
                    <div class="table-responsive">${tableHTML}</div>
                    <div class="card-view-responsive card-view">${cardHTML}</div>
                `;
            }
        }

        function generateTableShell(headers) {
            return `<div class="overflow-x-auto">
                                                                        <table
                                                                            class="min-w-full divide-y divide-gray-200 text-sm">
                                                                            <thead class="bg-gray-50">
                                                                                <tr>${headers.map(h => `<th scope="col"
                                                                                        class="px-4 py-2 text-left font-medium text-gray-500 uppercase tracking-wider">
                                                                                        ${h}</th>`).join('')}</tr>
                                                                            </thead>
                                                                            <tbody
                                                                                class="bg-white divide-y divide-gray-200">
                                                                                `;
        }

        function generateMemberDetailTableHTML() {
            const { members, matches } = appState;
            if (!members.length || !matches.length) return '<p class="text-sm text-gray-500 py-4 text-center">データがありません。</p>';

            // ▼▼▼ 凡例のHTMLを追加 ▼▼▼
            const legendHtml = `
                <div class="p-2 my-2 text-xs text-gray-600 bg-gray-50 rounded-md border">
                    <h4 class="font-bold mb-1">凡例:</h4>
                    <div class="flex flex-wrap gap-x-4 gap-y-1">
                        <div class="flex items-center"><span class="inline-block w-3 h-3 rounded bg-blue-100 mr-1 border"></span>コート1</div>
                        <div class="flex items-center"><span class="inline-block w-3 h-3 rounded bg-green-100 mr-1 border"></span>コート2</div>
                        <div class="flex items-center"><span class="inline-block w-3 h-3 rounded bg-yellow-100 mr-1 border"></span>コート3</div>
                        <div class="flex items-center"><span class="underline decoration-2 decoration-indigo-700 font-bold">数字</span>: チーム2 (対戦表の右側)</div>
                    </div>
                </div>
            `;

            const headers = ['メンバー', '最大連続プレイ', '最大連続休憩', ...matches.map((_, i) => `第${i + 1}試合`), '合計'];
            let tableHTML = generateTableShell(headers);

            const _sortedMembers4Table = members
                .map((name, index) => ({ name, index }))
                .sort((a, b) => {
                    const na = parseInt(a.name, 10), nb = parseInt(b.name, 10);
                    if (!isNaN(na) && !isNaN(nb) && `${na}` === String(a.name) && `${nb}` === String(b.name)) return na - nb;
                    return String(a.name).localeCompare(String(b.name));
                });

            _sortedMembers4Table.forEach(({ name, index: memberIdx }) => {
                let cumulativePlays = 0;
                let consecutivePlayStreak = 0, maxPlayStreak = 0;
                let consecutiveRestStreak = 0, maxRestStreak = 0;
                let timelineCellsHtml = '';

                matches.forEach(match => {
                    let isPlaying = false;
                    let courtClass = '';
                    let playerClass = '';

                    match.courts.forEach((court, courtIdx) => {
                        const courtColors = ['bg-blue-100', 'bg-green-100', 'bg-yellow-100'];
                        if (court.team1.includes(memberIdx)) {
                            isPlaying = true;
                            courtClass = courtColors[courtIdx % courtColors.length];
                            playerClass = 'font-normal';
                        } else if (court.team2.includes(memberIdx)) {
                            isPlaying = true;
                            courtClass = courtColors[courtIdx % courtColors.length];
                            playerClass = 'team-2-player'; // 下線スタイルを適用
                        }
                    });

                    if (isPlaying) {
                        cumulativePlays++;
                        consecutivePlayStreak++;
                        consecutiveRestStreak = 0;
                    } else {
                        consecutivePlayStreak = 0;
                        consecutiveRestStreak++;
                    }

                    if (consecutivePlayStreak > maxPlayStreak) maxPlayStreak = consecutivePlayStreak;
                    if (consecutiveRestStreak > maxRestStreak) maxRestStreak = consecutiveRestStreak;

                    if (isPlaying) {
                        timelineCellsHtml += `<td class="px-4 py-2 whitespace-nowrap text-center ${courtClass} ${playerClass}">${cumulativePlays}</td>`;
                    } else {
                        timelineCellsHtml += `<td class="px-4 py-2 whitespace-nowrap text-center">-</td>`;
                    }
                });

                let row = `<tr>`;
                row += `<td class="px-4 py-2 whitespace-nowrap font-medium">${name}</td>`;
                row += `<td class="px-4 py-2 whitespace-nowrap text-center">${maxPlayStreak}</td>`;
                row += `<td class="px-4 py-2 whitespace-nowrap text-center">${maxRestStreak}</td>`;
                row += timelineCellsHtml;
                row += `<td class="px-4 py-2 whitespace-nowrap text-center font-bold">${cumulativePlays}</td>`;
                row += `</tr>`;
                tableHTML += row;
            });

            tableHTML += `</tbody></table></div>`;
            return legendHtml + tableHTML; // テーブルの前に凡例を追加
        }


        function generateMemberDetailCardHTML() {
            const { members, matches } = appState;
            if (!members.length || !matches.length) return '<p class="text-sm text-gray-500 py-4 text-center">データがありません。</p>';

            // ▼▼▼ 凡例のHTMLを追加 ▼▼▼
            const legendHtml = `
                <div class="p-2 mb-4 text-xs text-gray-600 bg-gray-50 rounded-md border">
                    <h4 class="font-bold mb-1">凡例:</h4>
                    <div class="flex flex-wrap gap-x-4 gap-y-1">
                        <div class="flex items-center"><span class="inline-block w-3 h-3 rounded bg-blue-100 mr-1 border"></span>コート1</div>
                        <div class="flex items-center"><span class="inline-block w-3 h-3 rounded bg-green-100 mr-1 border"></span>コート2</div>
                        <div class="flex items-center"><span class="inline-block w-3 h-3 rounded bg-yellow-100 mr-1 border"></span>コート3</div>
                        <div class="flex items-center"><span class="underline decoration-2 decoration-indigo-700 font-bold">数字</span>: チーム2</div>
                    </div>
                </div>
            `;

            const cardsHtml = members.map((name, memberIdx) => {
                let cumulativePlays = 0;
                let consecutivePlayStreak = 0, maxPlayStreak = 0;
                let consecutiveRestStreak = 0, maxRestStreak = 0;
                let historyRows = '';

                matches.forEach((match, i) => {
                    let isPlaying = false;
                    let courtClass = '';
                    let playerClass = '';

                    match.courts.forEach((court, courtIdx) => {
                        const courtColors = ['bg-blue-100', 'bg-green-100', 'bg-yellow-100'];
                        if (court.team1.includes(memberIdx)) {
                            isPlaying = true;
                            courtClass = courtColors[courtIdx % courtColors.length];
                            playerClass = 'font-normal';
                        } else if (court.team2.includes(memberIdx)) {
                            isPlaying = true;
                            courtClass = courtColors[courtIdx % courtColors.length];
                            playerClass = 'team-2-player'; // 下線スタイルを適用
                        }
                    });

                    if (isPlaying) {
                        cumulativePlays++;
                        consecutivePlayStreak++;
                        consecutiveRestStreak = 0;
                    } else {
                        consecutivePlayStreak = 0;
                        consecutiveRestStreak++;
                    }
                    if (consecutivePlayStreak > maxPlayStreak) maxPlayStreak = consecutivePlayStreak;
                    if (consecutiveRestStreak > maxRestStreak) maxRestStreak = consecutiveRestStreak;

                    const valueHtml = isPlaying
                        ? `<span class="card-item-row-value p-1 rounded ${courtClass} ${playerClass}">${cumulativePlays}</span>`
                        : `<span class="card-item-row-value">-</span>`;

                    historyRows += `<div class="card-item-row"><span class="card-item-row-label">第${i + 1}試合</span>${valueHtml}</div>`;
                });

                return `<div class="card-item">
                    <div class="card-item-header">${name}</div>
                    <div class="card-item-row"><span class="card-item-row-label">最大連続プレイ</span><span class="card-item-row-value">${maxPlayStreak}</span></div>
                    <div class="card-item-row"><span class="card-item-row-label">最大連続休憩</span><span class="card-item-row-value">${maxRestStreak}</span></div>
                    ${historyRows}
                    <div class="card-item-row font-bold mt-2 border-t pt-2"><span class="card-item-row-label">合計</span><span class="card-item-row-value">${cumulativePlays}</span></div>
                </div>`;
            }).join('');

            return legendHtml + cardsHtml; // カード群の前に凡例を追加
        }

        function generatePairDetailTableHTML() {
            // データなければ空文字
            if (appState.allPossiblePairs.length === 0) return '';

            // ペアごとの使用回数
            const pairTotalCounts = calculateAllPairUsageCounts(appState.matches);

            // テーブルのヘッダー
            const headers = [
                'ペア',
                ...appState.matches.map((_, i) => `第${i + 1}試合`),
                '合計'
            ];

            // generateTableShell で <div><table>～<thead>～<tbody> まで作成してくれる想定
            let html = generateTableShell(headers);

            // 各ペアの行を作成
            appState.allPossiblePairs.forEach(pairIndices => {
                // key と表示名を構築
                const pairKey = pairIndices.slice().sort((a, b) => a - b).join(',');
                const pairName = pairIndices
                    .map(i => appState.members[i])
                    .join(' & ');

                html += `<tr>
      <td class="px-4 py-2 whitespace-nowrap font-medium">${pairName}</td>`;

                // 累計使用数と緑背景セルのロジック
                let cumulativeUses = 0;
                appState.matches.forEach(match => {
                    const before = cumulativeUses;
                    if (
                        match.courts.some(c =>
                            c.team1.join(',') === pairKey ||
                            c.team2.join(',') === pairKey
                        )
                    ) {
                        cumulativeUses++;
                    }
                    html += `<td class="px-4 py-2 whitespace-nowrap text-center ${cumulativeUses > before ? 'bg-green-50 font-semibold' : ''
                        }">${cumulativeUses}</td>`;
                });

                // 合計セル
                html += `<td class="px-4 py-2 whitespace-nowrap text-center font-bold">${pairTotalCounts[pairKey] || 0
                    }</td></tr>`;
            });

            // テーブル／ラッパーを閉じる
            html += '</tbody></table></div>';
            return html;
        }


        function generatePairDetailCardHTML() {
            // 空なら空文字を返す（改行しない）
            if (appState.allPossiblePairs.length ===
                0) return '';

            const pairTotalCounts =
                calculateAllPairUsageCounts(appState.matches);

            // allPossiblePairs を map → join
            return appState.allPossiblePairs
                .map(pairIndices => {
                    const pairKey =
                        pairIndices.slice().sort((a, b) => a -
                            b).join(',');
                    const pairName = pairIndices.map(i =>
                        appState.members[i]).join(' & ');
                    let cumulativeUses = 0;

                    // ← ここを１行にまとめる
                    const historyRows = appState.matches
                        .map((match, i) => {
                            const before = cumulativeUses;
                            if (
                                match.courts.some(c =>
                                    c.team1.join(',') === pairKey ||
                                    c.team2.join(',') === pairKey
                                )
                            ) {
                                cumulativeUses++;
                            }
                            return `
                                                                                <div class="card-item-row">
                                                                                    <span
                                                                                        class="card-item-row-label">第${i
                                + 1}試合</span>
                                                                                    <span class="card-item-row-value ${cumulativeUses > before ? 'text-green-600 font-semibold' : ''
                                }">${cumulativeUses}</span>
                                                                                </div>`;
                        })
                        .join('');

                    return `
                                                                                <div class="card-item">
                                                                                    <div class="card-item-header">
                                                                                        ${pairName}</div>
                                                                                    ${historyRows}
                                                                                    <div
                                                                                        class="card-item-row font-bold mt-2 border-t pt-2">
                                                                                        <span
                                                                                            class="card-item-row-label">合計</span>
                                                                                        <span
                                                                                            class="card-item-row-value">${pairTotalCounts[pairKey]
                        || 0
                        }</span>
                                                                                    </div>
                                                                                </div>`;
                })
                .join('');
        }

        function
            generateMatchCardDetailTableHTML() {
            const counts =
                calculateMatchCardCounts(appState.matches);
            if (Object.keys(counts).length === 0)
                return '<p class="text-sm text-gray-500 py-4 text-center" >対戦カードがありません。</p > ';
            const headers = ['対戦カード (4人)', '使用回数',
                '該当ラウンド'];
            let table = generateTableShell(headers);
            Object.entries(counts).forEach(([key,
                data]) => {
                const names = key.split(',').map(i =>
                    appState.members[+i]).join(', ');
                table += `<tr>
                                                                                    <td
                                                                                        class="px-4 py-2 whitespace-nowrap font-medium">
                                                                                        ${names}</td>
                                                                                    <td
                                                                                        class="px-4 py-2 whitespace-nowrap text-center">
                                                                                        ${data.count}</td>
                                                                                    <td
                                                                                        class="px-4 py-2 whitespace-nowrap">
                                                                                        ${data.rounds.join(', ')}</td>
                                                                                </tr>`;
            });
            return table + '</tbody ></table ></div > ';
        }
        function generateMatchCardCardHTML() {
            const counts =
                calculateMatchCardCounts(appState.matches);
            if (Object.keys(counts).length === 0) {
                return '<p class="text-sm text-gray-500 py-4 text-center" >対戦カードがありません。</p > ';
            }
            return Object.entries(counts).map(([key, data]) => {
                const names = key.split(',').map(i =>
                    appState.members[+i]).join(', ');
                return `<div class="card-item">
                                                                        <div class="card-item-header">${names}</div>
                                                                        <div class="card-item-row"><span
                                                                                class="card-item-row-label">使用回数</span><span
                                                                                class="card-item-row-value">${data.count}</span>
                                                                        </div>
                                                                        <div class="card-item-row"><span
                                                                                class="card-item-row-label">該当ラウンド</span><span
                                                                                class="card-item-row-value">${data.rounds.join(',')}</span>
                                                                        </div>
                                                                    </div> `;
            }).join('');
        }

        function calculatePairVsPairCounts(matches) {
            const counts = {};
            matches.forEach(match => {
                match.courts.forEach(court => {
                    const pair1Key = court.team1.join(',');
                    const pair2Key = court.team2.join(',');
                    const matchupKey = [pair1Key,
                        pair2Key].sort().join('_vs_');
                    counts[matchupKey] = (counts[matchupKey] || 0) + 1;
                });
            });
            return counts;
        }

        function renderPairVsPairHeatmap() {
            const container = dom.pairVsPairHeatmapContainer;
            container.innerHTML = ''; // まず中身をクリア
            const { members, matches, allPossiblePairs } = appState;

            if (matches.length === 0 || allPossiblePairs.length < 2) return;

            const matchupCounts = calculatePairVsPairCounts(matches);
            const maxCount = Math.max(1, ...Object.values(matchupCounts));
            const pairNames = allPossiblePairs.map(p => p.map(i => members[i]).join(' & '));

            // テーブルのヘッダー部分（HTML）を生成
            const headerHtml = [' ', ...pairNames].map(h => `<th class="whitespace-nowrap">${h}</th>`).join('');

            // テーブルのボディ部分（HTML）を生成
            let bodyHtml = '';
            allPossiblePairs.forEach((pair1, i) => {
                let rowHtml = `<tr><th class="whitespace-nowrap">${pairNames[i]}</th>`;
                allPossiblePairs.forEach((pair2, j) => {
                    if (i === j) {
                        rowHtml += `<td class="bg-gray-200">-</td>`;
                    } else if (j < i) {
                        rowHtml += `<td></td>`;
                    } else {
                        const isDisjoint = pair1.every(p1 => !pair2.includes(p1));
                        if (isDisjoint) {
                            const pair1Key = pair1.join(',');
                            const pair2Key = pair2.join(',');
                            const matchupKey = [pair1Key, pair2Key].sort().join('_vs_');
                            const count = matchupCounts[matchupKey] || 0;
                            const opacity = count / maxCount;
                            rowHtml += `<td style="background-color: rgba(74, 144, 226, ${opacity})" class="${opacity > 0.6 ? 'text-white font-bold' : ''}">${count}</td>`;
                        } else {
                            rowHtml += `<td class="bg-gray-100"></td>`;
                        }
                    }
                });
                rowHtml += '</tr>';
                bodyHtml += rowHtml;
            });

            // ★重要：生成したHTMLの文字列を innerHTML を使ってコンテナに設定する
            container.innerHTML = `
                <table class="heatmap-table">
                    <thead>
                        <tr>${headerHtml}</tr>
                    </thead>
                    <tbody>${bodyHtml}</tbody>
                </table>
            `;
        }

        function
            calcOpponentDetail(matches) {
            const map = {};
            matches.forEach(m =>
                m.courts.forEach(c => {
                    [[c.team1, c.team2],
                    [c.team2,
                    c.team1]].forEach(([me,
                        opp]) => {
                        const key =
                            `${me.join(',')} |
                                                                                                    ${opp.join(',')}`;
                        map[key] = (map[key]
                            || 0) + 1;
                    });
                }));
            return map;
        }

        function
            generateOpponentDetailTableHTML() {
            const counts =
                calcOpponentDetail(appState.matches);
            if
                (!Object.keys(counts).length) {
                return '<p class="text-sm text-gray-500 py-4 text-center" >データがありません。</p >                        ';
            }
            const headers =
                ['味方ペア', '相手ペア',
                    '回数'];
            let table =
                generateTableShell(headers);
            const rows =
                Object.entries(counts).map(([k, v]) => {
                    const [ally, enemy]
                        = k.split('|').map(x =>
                            `"${x.trim().split(',').map(i => appState.members[i]).join(' & ')}"`); return `<tr>
                                                                                                        <td
                                                                                                            class="px-4 py-2">
                                                                                                            ${ally}</td>
                                                                                                        <td
                                                                                                            class="px-4 py-2">
                                                                                                            ${enemy}
                                                                                                        </td>
                                                                                                        <td
                                                                                                            class="px-4 py-2 text-center font-bold">
                                                                                                            ${v}</td>
                                                                                                    </tr>`;
                }).join('');
            return table + rows
                + '</tbody></table >                                                                                                    </div > ';
        }

        function
            generateOpponentDetailCardHTML() {
            const counts =
                calcOpponentDetail(appState.matches);
            if
                (!Object.keys(counts).length) {
                return '<p class="text-sm text-gray-500 py-4 text-center" >データがありません。</p >';
            }
            return Object.entries(counts)
                .map(([key, count]) => {
                    const [ally, enemy] = key
                        .split('|')
                        .map(x => x.trim()
                            .split(',')
                            .map(i => appState.members[i])
                            .join(' & '));
                    return `
                    <div class="card-item">
                        <div class="card-item-header">味方: ${ally}</div>
                        <div class="card-item-row">
                            <span class="card-item-row-label">相手ペア</span>
                            <span class="card-item-row-value">${enemy}</span>
                        </div>
                        <div class="card-item-row">
                            <span class="card-item-row-label">対戦回数</span>
                            <span class="card-item-row-value">${count}</span>
                        </div>
                    </div>`;
                })
                .join('');
        }

        // --- Favorites &   CSV Logic-- -
        function
            updateSaveFavoriteButtonState() {
            dom.saveFavoriteButton.disabled
                =
                !(appState.currentTotalMemberCount
                    > 0 &&
                    appState.maxConsecutiveLimit
                    > 0);
        }
        function
            setFavoriteSelection(name) {
            dom.favoritesSelect.value
                = name;
            updateExportCsvButtonState();
        }

        function updateExportCsvButtonState() {
            dom.exportCsvButton.disabled = appState.matches.length === 0;
        }
        function renderFavoritesList() {
            const currentSelection = dom.favoritesSelect.value;
            dom.favoritesSelect.innerHTML = '<option value="">お気に入りを選択...</option>';

            const sortedFavorites = [...appState.favorites].sort((a, b) => {
                if (a.matches.length !== b.matches.length) return a.matches.length - b.matches.length;
                if (a.settings.totalMemberCount !== b.settings.totalMemberCount) return a.settings.totalMemberCount - b.settings.totalMemberCount;
                if (a.settings.surfaceCount !== b.settings.surfaceCount) return a.settings.surfaceCount - b.settings.surfaceCount;
                return a.name.localeCompare(b.name);
            });

            // ▼▼▼ ここからが新しいロジック ▼▼▼

            // 1. 各お気に入りの表示名を事前に生成するヘルパー関数
            const generateDisplayText = (fav) => {
                const { settings, matches } = fav;
                const baseInfo = `${matches.length}試合 ${settings.surfaceCount}面${settings.totalMemberCount}人`;
                const frpPairRaw = calculateFirstRepetitionMatch(matches, 'pair');
                const frpPair = frpPairRaw === '全て新規' ? '全' : frpPairRaw;
                const frpGroupRaw = calculateFirstRepetitionMatch(matches, 'group');
                const frpGroup = frpGroupRaw === '全て新規' ? '全' : frpGroupRaw;
                const qualityInfo = `(P:${frpPair}/G:${frpGroup})`;
                let ruleInfo = '';
                if (settings.ruleType === 'fixedPair') ruleInfo = ' (固定)';
                else if (settings.ruleType === 'genderMix') ruleInfo = ' (Mix)';
                return `${baseInfo} ${qualityInfo}${ruleInfo}`;
            };

            // 2. 全お気に入りの表示名をリスト化し、重複をカウントする
            const displayTexts = sortedFavorites.map(generateDisplayText);
            const textCounts = new Map();
            displayTexts.forEach(text => textCounts.set(text, (textCounts.get(text) || 0) + 1));

            // 3. プルダウンの選択肢を生成する
            sortedFavorites.forEach((fav, index) => {
                const option = document.createElement('option');
                const baseDisplayText = displayTexts[index];

                // 4. もし表示名が重複している場合は、ユニークな名前を追記する
                if (textCounts.get(baseDisplayText) > 1) {
                    option.textContent = `${baseDisplayText}  [${fav.name}]`;
                } else {
                    option.textContent = baseDisplayText;
                }

                option.value = fav.name;
                option.title = `${fav.name}\n${fav.memo || ''}`.trim();

                dom.favoritesSelect.appendChild(option);
            });

            // ▲▲▲ ここまでが新しいロジック ▲▲▲

            if (appState.favorites.some(fav => fav.name === currentSelection)) {
                dom.favoritesSelect.value = currentSelection;
            }
            setFavoriteSelection(dom.favoritesSelect.value);
        }

        function generateFavoriteName() {
            let baseName = `${appState.currentSurfaceCount}面${appState.currentTotalMemberCount}人${appState.maxConsecutiveLimit}連続`;

            const ruleType = document.querySelector('input[name="ruleType"]:checked').value;
            switch (ruleType) {
                case 'fixedPair':
                    baseName += '_固定';
                    break;
                case 'genderMix':
                    baseName += '_ミックス';
                    break;
            }

            let newName = baseName;
            let counter = 1;
            // 同じベース名のお気に入りが既に存在する場合、(1), (2) と連番を振る
            const baseRegex = new RegExp(`^${baseName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}`);
            const existingFavoritesWithBase = appState.favorites.filter(f => baseRegex.test(f.name));

            while (existingFavoritesWithBase.some(f => f.name.startsWith(newName))) {
                // 既に(1)などが付いている場合も考慮し、新しいユニークな名前を探す
                const existingNumbers = existingFavoritesWithBase
                    .map(f => {
                        const match = f.name.match(/\((\d+)\)/);
                        return match ? parseInt(match[1], 10) : (f.name === baseName ? 0 : -1);
                    })
                    .filter(n => n >= 0);

                if (counter <= Math.max(0, ...existingNumbers)) {
                    counter = Math.max(0, ...existingNumbers) + 1;
                }

                newName = `${baseName} (${counter++})`;
            }
            return newName;
        }


        function showOverwriteFavoriteDialog(overrides = {}) {
            console.log('[DIALOG] showOverwriteFavoriteDialog 呼び出し:', overrides);
            let listHtml = `<div id="overwriteFavoriteDialogListContainer" class="my-4">`;
            appState.favorites.forEach((fav, index) => {
                listHtml += `<label><input type="radio" name="favoriteToOverwrite" value="${index}"> ${fav.name}</label>`;
            });
            listHtml += '</div>';

            showDialog(
                `お気に入り上書き`,
                `最大${MAX_FAVORITES}件です。上書きする項目を選んでください。`,
                (confirmed) => {
                    if (confirmed) {
                        const selected = document.querySelector('input[name="favoriteToOverwrite"]:checked');
                        if (selected) {
                            const indexToOverwrite = parseInt(selected.value, 10);
                            console.log('[DIALOG] 上書き対象:', indexToOverwrite, 'overrides:', overrides);
                            const favoriteToSave = {
                                name: overrides.name || generateFavoriteName(),
                                memo: overrides.memo !== undefined ? overrides.memo : (appState.currentMemo || ''),
                                settings: {
                                    surfaceCount: appState.currentSurfaceCount,
                                    totalMemberCount: appState.currentTotalMemberCount,
                                    maxConsecutiveLimit: appState.maxConsecutiveLimit,
                                    ruleType: document.querySelector('input[name="ruleType"]:checked').value,
                                },
                                members: [...appState.members],
                                groups: { ...appState.groups },
                                exclusions: { ...appState.exclusions },
                                joins: { ...appState.joins },
                                joinOffsets: { ...appState.joinOffsets },
                                matches: JSON.parse(JSON.stringify(appState.matches)),
                                completedMatches: Array.from(appState.completedMatches),
                                generationSettings: { ...appState.generationSettings },
                                analysis: appState.lastRunAnalysis
                            };
                            saveFavorite(favoriteToSave, indexToOverwrite);
                        } else {
                            showDialog('エラー', '上書きする項目を選択してください。');
                        }
                    }
                },
                listHtml
            );
        }




        function exportDataToCsv(favoriteData) {
            if (!favoriteData || !favoriteData.matches || favoriteData.matches.length === 0) {
                showDialog('エラー', 'エクスポート可能な試合データがありません。');
                return;
            }

            const tempPairIdMap = {};
            const favMembersCount = favoriteData.members.length;
            let pairCounter = 1;
            for (let i = 0; i < favMembersCount; i++) {
                for (let j = i + 1; j < favMembersCount; j++) {
                    const key = [i, j].join(',');
                    tempPairIdMap[key] = pairCounter++;
                }
            }

            const csvData = formatFavoriteToCSV(favoriteData, tempPairIdMap);
            const fileName = (favoriteData.name || '試合結果') + '.csv';

            // --- ここからが修正箇所 ---
            // CSV用のBlobをここで作成する
            const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
            const blob = new Blob([bom, csvData], {
                type: 'text/csv;charset=utf-8;'
            });
            // 汎用的なダウンロード関数を呼び出す
            triggerDownload(blob, fileName);
        }

        function handleLoadFavorite() {
            const selectedName = dom.favoritesSelect.value;
            const previousValue = dom.favoritesSelect.dataset.previousValue || "";
            if (!selectedName) {
                dom.favoriteMemoInput.value = '';
                appState.currentMemo = '';
                updateExportCsvButtonState();
                return;
            }
            showDialog(
                'お気に入りの読み込み',
                `「${selectedName}」を読み込みますか？\n現在の設定と試合結果は上書きされます。`,
                (confirmed) => {
                    if (confirmed) {
                        const fav = appState.favorites.find(f => f.name === selectedName);
                        if (fav) {
                            appState.exclusions = fav.exclusions || {};
                            appState.joins = fav.joins || {}; // 後方互換: 旧お気に入りにはjoinsが存在しない
                            appState.joinOffsets = fav.joinOffsets || {}; // 後方互換: 旧お気に入りにはjoinOffsetsが存在しない
                            appState.currentSurfaceCount = fav.settings.surfaceCount;
                            appState.currentTotalMemberCount = fav.settings.totalMemberCount;
                            appState.maxConsecutiveLimit = fav.settings.maxConsecutiveLimit;
                            appState.members = [...fav.members];
                            appState.groups = fav.groups || {};
                            appState.dataSource = fav.name;
                            appState.matches = JSON.parse(JSON.stringify(fav.matches));
                            appState.completedMatches = new Set(fav.completedMatches);
                            appState.generationSettings = fav.generationSettings || { groups: fav.groups || {}, ruleType: fav.settings.ruleType || 'none' };
                            appState.lastRunAnalysis = fav.analysis || null;
                            appState.currentMemo = fav.memo || '';
                            dom.favoriteMemoInput.value = appState.currentMemo;

                            // 新しいメンバー構成に合わせて、ペアのIDとカラーマップを再生成する
                            regenerateAllPossiblePairs();

                            restoreRuleTypeRadioFromState();
                            updateAllUI();
                            applyDisplayLogicBasedOnState();
                            showDialog('読込完了', `「${selectedName}」を読み込みました。`);
                        }
                        dom.favoritesSelect.dataset.previousValue = selectedName;
                    } else {
                        dom.favoritesSelect.value = previousValue;
                    }
                    updateExportCsvButtonState();
                }
            );
        }





        function handleSaveFavorite() {
            if (appState.matches.length === 0) {
                showDialog('エラー', '保存する試合がありません。');
                return;
            }
            if (appState.favorites.length >= MAX_FAVORITES) {
                showDialog('エラー', `お気に入りは最大${MAX_FAVORITES}件までしか保存できません。`);
                return;
            }

            let suggestedName;
            const now = new Date();
            const dateStr = `${now.getFullYear().toString().slice(-2)}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
            const currentRule = document.querySelector('input[name="ruleType"]:checked').value;
            const ruleTextMap = { 'fixedPair': '(固定)', 'genderMix': '(Mix)' };
            const ruleText = ruleTextMap[currentRule] || '';

            // ▼▼▼ ここからが修正されたロジック ▼▼▼
            // データソースが '新規生成' でない、つまりお気に入りが読み込まれている場合
            if (appState.dataSource && appState.dataSource !== '新規生成') {
                // 提案される名前は、現在読み込まれているお気に入りの名前にする
                suggestedName = appState.dataSource;
            } else {
                // 新規生成の場合のみ、新しい名前を自動生成する
                if (appState.lastRunAnalysis && appState.lastRunAnalysis.bestResult) {
                    const { bestResult } = appState.lastRunAnalysis;
                    const { matches, metaScore, settings } = bestResult;
                    suggestedName = `${matches.length}試合 ${settings.currentSurfaceCount}面${settings.currentTotalMemberCount}人 ${settings.maxConsecutiveLimit}連続 S${metaScore.toFixed(2)}_${dateStr} (P:${calculateFirstRepetitionMatch(matches, 'pair')}/G:${calculateFirstRepetitionMatch(matches, 'group')})`;
                } else {
                    suggestedName = `${appState.matches.length}試合-${appState.currentSurfaceCount}面${appState.currentTotalMemberCount}人${appState.maxConsecutiveLimit}連続${ruleText}_${dateStr}`;
                }
            }
            // ▲▲▲ 修正ここまで ▲▲▲

            const suggestedMemo = appState.currentMemo || '';

            showDialog(
                'お気に入りに保存',
                null,
                (confirmed, inputs) => {
                    if (confirmed) {
                        processSaveRequest(inputs);
                    }
                },
                `<div class="space-y-4">
                    <div><label class="block text-sm font-medium text-gray-700">お気に入り名</label><input type="text" name="name" class="input-text w-full" value="${suggestedName}"></div>
                    <div><label class="block text-sm font-medium text-gray-700">メモ</label><textarea name="memo" class="input-text w-full" rows="15" style="white-space: pre-wrap;">${suggestedMemo}</textarea></div>
                 </div>`
            );
        }


        function processSaveRequest(inputs) {
            const favName = inputs.name.trim();
            if (!favName) {
                showDialog('エラー', '名前は空にできません。');
                return;
            }

            const favoriteToSave = {
                name: favName,
                memo: inputs.memo || '',
                settings: {
                    surfaceCount: appState.currentSurfaceCount,
                    totalMemberCount: appState.currentTotalMemberCount,
                    maxConsecutiveLimit: appState.maxConsecutiveLimit,
                    ruleType: document.querySelector('input[name="ruleType"]:checked').value,
                },
                members: [...appState.members],
                groups: { ...appState.groups },
                exclusions: { ...appState.exclusions },
                joins: { ...appState.joins },
                joinOffsets: { ...appState.joinOffsets },
                matches: JSON.parse(JSON.stringify(appState.matches)),
                completedMatches: Array.from(appState.completedMatches),
                generationSettings: { ...appState.generationSettings },
                analysis: appState.lastRunAnalysis
            };

            const existingFavIndex = appState.favorites.findIndex(f => f.name === favName);

            if (existingFavIndex === -1) {
                saveFavorite(favoriteToSave);
            } else {
                createConfirmationDialog(
                    '確認',
                    `同名のお気に入り「${favName}」が既に存在します。上書きしますか？`,
                    () => {
                        saveFavorite(favoriteToSave, existingFavIndex);
                    }
                );
            }
        }

        function saveFavorite(favoriteObject, indexToOverwrite = -1) {
            if (indexToOverwrite !== -1) {
                const newFavorites = [...appState.favorites];
                newFavorites[indexToOverwrite] = favoriteObject;
                appState.favorites = newFavorites;
            } else {
                appState.favorites = [...appState.favorites, favoriteObject];
            }

            appState.dataSource = favoriteObject.name;
            renderGenerationSummary();
            renderFavoritesList();
            setFavoriteSelection(favoriteObject.name);
            saveState();
            updateFavoritesCountDisplay();
            showDialog('成功', `「${favoriteObject.name}」を保存しました。`);
            if (appState.exportAfterSave) {
                appState.exportAfterSave = false;
                exportDataToCsv(favoriteObject);
            }
        }

        function finishSave(savedName) {
            appState.dataSource = savedName;
            renderGenerationSummary();
            renderFavoritesList();
            setFavoriteSelection(savedName);
            saveState();
            updateFavoritesCountDisplay();
        }


        function openFavoritesManager() {
            const tableBody = document.getElementById('favoritesTableBody');
            const cardList = dom.favoritesManagerList;
            if (!tableBody || !cardList) return;

            tableBody.innerHTML = '';
            cardList.innerHTML = '';

            if (appState.favorites.length === 0) {
                cardList.innerHTML = `<p class="text-center text-gray-500 py-4">保存されたお気に入りはありません。</p>`;
                const tr = tableBody.insertRow();
                const td = tr.insertCell();
                td.colSpan = 10;
                td.className = 'text-center text-gray-500 p-4';
                td.textContent = '保存されたお気に入りはありません。';
                dom.favoritesManagerDialog.classList.remove('hidden');
                return;
            }

            const cardTemplate = document.getElementById('favorite-item-template');
            const sortedFavorites = [...appState.favorites].sort((a, b) => {
                if (a.matches.length !== b.matches.length) return a.matches.length - b.matches.length;
                if (a.settings.totalMemberCount !== b.settings.totalMemberCount) return a.settings.totalMemberCount - b.settings.totalMemberCount;
                if (a.settings.surfaceCount !== b.settings.surfaceCount) return a.settings.surfaceCount - b.settings.surfaceCount;
                return a.name.localeCompare(b.name, 'ja');
            });

            sortedFavorites.forEach(fav => {
                const index = appState.favorites.findIndex(originalFav => originalFav.name === fav.name);
                const tr = document.createElement('tr');
                tr.className = 'border-b';
                tr.dataset.index = index;

                // ▼▼▼ ここからが修正箇所 ▼▼▼
                const tooltipText = `${fav.name}\n--------------------\n${fav.memo || 'メモはありません'}`.trim();
                tr.title = tooltipText; // テーブルの行にツールチップを設定
                // ▲▲▲ 修正ここまで ▲▲▲

                if (index === appState.editingFavoriteIndex) {
                    tr.innerHTML = `
                        <td class="p-2 text-center align-top"><input type="checkbox" class="fav-compare-checkbox h-4 w-4" data-index="${index}" disabled></td>
                        <td class="p-2" colspan="8">
                            <div><label class="text-xs font-bold">お気に入り名:</label><input type="text" class="input-text fav-name-input w-full" value="${fav.name}"></div>
                            <div class="mt-2"><label class="text-xs font-bold">メモ:</label><textarea class="input-text fav-memo-input w-full text-sm" rows="3">${fav.memo || ''}</textarea></div>
                        </td>
                        <td class="p-2 text-right align-top">
                            <div class="flex flex-col items-end"><button class="save-fav-btn button-primary text-xs font-semibold py-1 px-2 rounded-md w-full" data-index="${index}">保存</button><button class="cancel-edit-fav-btn button-secondary text-xs font-semibold py-1 px-2 rounded-md w-full mt-2" data-index="${index}">ｷｬﾝｾﾙ</button></div>
                        </td>`;
                } else {
                    const frp_pair = calculateFirstRepetitionMatch(fav.matches, 'pair');
                    const frp_group = calculateFirstRepetitionMatch(fav.matches, 'group');
                    const bestScore = fav.analysis?.bestMetaScore?.toFixed(2) || '---';
                    tr.className += ' hover:bg-gray-50';
                    let ruleText = '-';
                    if (fav.settings.ruleType === 'fixedPair') ruleText = '固定';
                    else if (fav.settings.ruleType === 'genderMix') ruleText = 'Mix';

                    tr.innerHTML = `
                        <td class="p-2 text-center"><input type="checkbox" class="fav-compare-checkbox h-4 w-4" data-index="${index}"></td>
                        <td class="p-2 font-semibold text-gray-800">${fav.name}</td>
                        <td class="p-2 text-center">${fav.matches.length}</td>
                        <td class="p-2 text-center">${fav.settings.totalMemberCount}</td>
                        <td class="p-2 text-center">${fav.settings.surfaceCount}</td>
                        <td class="p-2 text-center">${ruleText}</td>
                        <td class="p-2 text-center">${bestScore}</td>
                        <td class="p-2 text-center">${frp_pair}</td>
                        <td class="p-2 text-center">${frp_group}</td>
                        <td class="p-2 text-right"><button class="edit-fav-btn button-secondary text-xs font-semibold py-1 px-2 rounded-md" data-index="${index}">編集</button><button class="delete-fav-btn button-danger text-xs font-semibold py-1 px-2 rounded-md ml-1" data-index="${index}">削除</button></td>`;
                }
                tableBody.appendChild(tr);

                const clone = cardTemplate.content.cloneNode(true);
                const item = clone.firstElementChild;
                item.dataset.index = index;
                item.querySelector('.fav-compare-checkbox').dataset.index = index;
                // ▼▼▼ ここからが修正箇所 ▼▼▼
                item.title = tooltipText; // スマホ表示のカードにもツールチップを設定
                // ▲▲▲ 修正ここまで ▲▲▲
                const nameDisplay = item.querySelector('.fav-name-display'), nameInput = item.querySelector('.fav-name-input'), memoDisplay = item.querySelector('.fav-memo-display'), memoInput = item.querySelector('.fav-memo-input'), editBtn = item.querySelector('.edit-fav-btn'), saveBtn = item.querySelector('.save-fav-btn'), cancelBtn = item.querySelector('.cancel-edit-fav-btn');

                if (index === appState.editingFavoriteIndex) {
                    nameDisplay.classList.add('hidden'); memoDisplay.classList.add('hidden'); nameInput.classList.remove('hidden'); memoInput.classList.remove('hidden'); nameInput.value = fav.name; memoInput.value = fav.memo || ''; editBtn.classList.add('hidden'); saveBtn.classList.remove('hidden'); cancelBtn.classList.remove('hidden');
                } else {
                    nameDisplay.textContent = fav.name;
                    if (fav.memo) { memoDisplay.textContent = fav.memo; memoDisplay.className = 'text-sm text-gray-600 whitespace-pre-wrap border-l-2 pl-2 border-gray-200'; } else { memoDisplay.textContent = 'メモはありません'; memoDisplay.className = 'text-sm text-gray-500'; }
                    editBtn.classList.remove('hidden'); saveBtn.classList.add('hidden'); cancelBtn.classList.add('hidden');
                }
                cardList.appendChild(item);
            });
            dom.favoritesManagerDialog.classList.remove('hidden');
        }

        function handleFavoritesManagerActions(e) {
            const target = e.target;
            const container = target.closest('tr, .p-3.border');
            if (!container) return;

            const index = parseInt(container.dataset.index, 10);
            if (isNaN(index)) return;

            if (target.matches('.edit-fav-btn')) {
                appState.editingFavoriteIndex = index;
                openFavoritesManager();
                return;
            }

            if (target.matches('.cancel-edit-fav-btn')) {
                appState.editingFavoriteIndex = null;
                openFavoritesManager();
                return;
            }

            if (target.matches('.save-fav-btn')) {
                const nameInput = container.querySelector('.fav-name-input');
                const memoInput = container.querySelector('.fav-memo-input');

                if (!nameInput || !memoInput) return;

                const newName = nameInput.value.trim();
                const newMemo = memoInput.value.trim();
                const isUnique = !appState.favorites.some((fav, i) => i !== index && fav.name === newName);

                if (newName && isUnique) {
                    appState.favorites[index].name = newName;
                    appState.favorites[index].memo = newMemo;
                    saveState();
                    renderFavoritesList();
                    appState.editingFavoriteIndex = null;
                    openFavoritesManager();
                    showDialog('成功', 'お気に入りを更新しました。');
                } else {
                    showDialog('エラー', newName ? 'その名前は既に使用されています。' : '名前は空にできません。');
                }
                return;
            }

            if (target.matches('.delete-fav-btn')) {
                showDialog('確認', `「${appState.favorites[index].name}」を削除しますか？`, (confirmed) => {
                    if (confirmed) {
                        const deletedName = appState.favorites[index].name;
                        appState.favorites.splice(index, 1);
                        saveState();
                        if (dom.favoritesSelect.value === deletedName) {
                            setFavoriteSelection('');
                            dom.favoriteMemoInput.value = '';
                        }
                        renderFavoritesList();
                        openFavoritesManager();
                        updateFavoritesCountDisplay(); // ← この行を追加
                    }
                });
            }
        }

        function handleExportCsv() {
            const selectedName = dom.favoritesSelect.value;

            if (selectedName) {
                const fav = appState.favorites.find(f => f.name === selectedName);
                if (fav) {
                    exportDataToCsv(fav);
                }
                return;
            }

            if (appState.matches.length > 0) {
                showDialog(
                    'エクスポートの確認',
                    'この試合結果をお気に入りに保存してからエクスポートしますか？\n\n「実行」：お気に入り保存後にCSV出力\n「キャンセル」：保存せずCSV出力のみ',
                    (confirmed) => {
                        if (confirmed) {
                            appState.exportAfterSave = true;
                            handleSaveFavorite();
                        } else {
                            const currentData = {
                                name: '試合結果',
                                settings: {
                                    surfaceCount: appState.currentSurfaceCount,
                                    totalMemberCount: appState.currentTotalMemberCount,
                                    maxConsecutiveLimit: appState.maxConsecutiveLimit,
                                    ruleType: document.querySelector('input[name="ruleType"]:checked').value,
                                },
                                members: [...appState.members],
                                groups: { ...appState.groups },
                                matches: [...appState.matches],
                                memo: dom.favoriteMemoInput.value,
                                generationSettings: { ...appState.generationSettings }
                            };
                            exportDataToCsv(currentData);
                        }
                    }
                );
            } else {
                showDialog('エラー', 'エクスポートできる試合がありません。');
            }
        }


        function handleExportJson() {
            try {
                const stateToSave = {
                    ...appState,
                    charts: undefined,
                    completedMatches: Array.from(appState.completedMatches),
                    editingMatch: null
                };
                const jsonString = JSON.stringify(stateToSave, null, 2);
                const blob = new Blob([jsonString], {
                    type: 'application/json'
                });
                const now = new Date();
                const dateStr = `${now.getFullYear().toString().slice(-2)}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}`;
                const fileName = `doubles_dashboard_backup_${dateStr}.json`;

                // 呼び出す関数を downloadCSV から triggerDownload に変更
                triggerDownload(blob, fileName);

            } catch (e) {
                console.error("Failed to export JSON: ", e);
                showDialog('エラー', 'JSONのエクスポートに失敗しました。');
            }
        }

        function
            handleImportJson(event) {
            const file =
                event.target.files[0];
            if (!file) return;
            const reader = new
                FileReader();
            reader.onload = (e) => {
                try {
                    const importedState
                        =
                        JSON.parse(e.target.result);
                    showDialog(
                        '確認：データのインポート',
                        'ファイルをインポートすると、現在の設定、試合結果、お気に入りが全て上書きされます。よろしいですか？',
                        (confirmed) => {
                            if (confirmed) {
                                Object.assign(appState,
                                    importedState);
                                appState.completedMatches
                                    = new
                                        Set(importedState.completedMatches
                                            || []);
                                appState.joins = importedState.joins || {}; // 後方互換: 旧バックアップにはjoinsが存在しない
                                appState.joinOffsets = importedState.joinOffsets || {}; // 後方互換: 旧バックアップにはjoinOffsetsが存在しない
                                restoreRuleTypeRadioFromState();
                                updateAllUI();
                                showDialog('成功',
                                    'データのインポートが完了しました。');
                            }
                            event.target.value =
                                '';
                        }
                    );
                } catch (err) {
                    console.error("Failed to parse JSON: ",
                        err);
                    showDialog('エラー',
                        'JSONファイルの読み込みに失敗しました。ファイルが破損しているか、形式が正しくありません。');
                    event.target.value =
                        '';
                }
            };
            reader.readAsText(file);
        }
        function formatFavoriteToCSV(favorite, pairIdMap) {
            let csvContent = "";
            csvContent += "【生成条件】\r\n";
            csvContent += formatConditionsForCSV(favorite);
            csvContent += "\r\n\r\n";
            csvContent += "【試合結果詳細(データ分析用)】\r\n";
            // 受け取ったpairIdMapをさらに次の関数へ渡す
            csvContent += formatMatchesForCSV(favorite, pairIdMap);
            csvContent += "\r\n\r\n";
            csvContent += "【メンバー別プレイ数詳細】\r\n";
            csvContent += formatMemberDetailForCSV(favorite);
            csvContent += "\r\n\r\n";
            csvContent += "【ペア組み合わせ数詳細】\r\n";
            csvContent += formatPairDetailForCSV(favorite);
            // ▼▼▼ ここから追加 ▼▼▼
            csvContent += "\r\n\r\n";
            csvContent += "【試合組合せ（シンプル表示）】\r\n";
            csvContent += formatSimpleMatchupForCSV(favorite);
            // ▲▲▲ ここまで追加 ▲▲▲
            return csvContent;
        }

        // ▼▼▼ 修正版の関数 ▼▼▼
        function formatConditionsForCSV(favorite) {
            const { settings, members, memo, exclusions, joins } = favorite;

            // ruleMapの定義を正しく閉じます
            const ruleMap = {
                none: 'なし',
                fixedPair: '固定ペア',
                genderMix: '男女ミックス'
            };

            const conditions = [
                ['面数', settings.surfaceCount],
                ['合計メンバー数', settings.totalMemberCount],
                ['最大連続プレイ数', settings.maxConsecutiveLimit],
                ['特別ルール', ruleMap[settings.ruleType] || ''],
            ];

            // 本来ここにあるべきif文です
            if (settings.ruleType === 'fixedPair' && settings.fixedPair?.length === 2) {
                const p1 = members[settings.fixedPair[0]] || '未設定';
                const p2 = members[settings.fixedPair[1]] || '未設定';
                // この行が正しい位置になります
                conditions.push(['固定ペア', `"${p1} & ${p2}"`]);
            }

            if (settings.ruleType === 'genderMix' && settings.femalePlayers?.length > 0) {
                const femaleNames = settings.femalePlayers.map(idx => members[idx]).join(',');
                conditions.push(['女子メンバー', `"${femaleNames}"`]);
            }

            const exclusionEntries = Object.entries(exclusions || {});
            if (exclusionEntries.length > 0) {
                const exclusionText = exclusionEntries.map(([playerIdx, fromMatch]) => {
                    return `${members[playerIdx]}(${fromMatch}試合目~)`;
                }).join('; '); // カンマを避けるためセミコロンで連結
                conditions.push(['離脱情報', `"${exclusionText}"`]);
            }

            const joinEntries = Object.entries(joins || {});
            const notArrivedEntries = joinEntries.filter(([, fromMatch]) => fromMatch === JOIN_NOT_ARRIVED);
            const arrivedJoinEntries = joinEntries.filter(([, fromMatch]) => fromMatch !== JOIN_NOT_ARRIVED);
            if (notArrivedEntries.length > 0) {
                conditions.push(['未到着メンバー', `"${notArrivedEntries.map(([playerIdx]) => members[playerIdx]).join('; ')}"`]);
            }
            if (arrivedJoinEntries.length > 0) {
                const joinText = arrivedJoinEntries.map(([playerIdx, fromMatch]) => {
                    return `${members[playerIdx]}(第${fromMatch}試合~)`;
                }).join('; ');
                conditions.push(['参加情報', `"${joinText}"`]);
            }

            conditions.push(['メモ', `"${memo || ''}"`]);

            let csv = "項目,設定値\r\n";
            csv += conditions.map(row => row.join(',')).join('\r\n');

            return csv;
        }
        // ▲▲▲ 修正版の関数 ▲▲▲

        function formatMatchesForCSV(favorite, pairIdMap) {
            const { matches, members, groups } = favorite;

            const headers = ['試合番号', 'コート番号', '区分', 'ペア番号', 'プレイヤー名', '性別'];
            let rows = [headers.join(',')];

            matches.forEach((match, matchIdx) => {
                match.courts.forEach((court, courtIdx) => {
                    const teamAKey = court.team1.join(',');
                    // 引数で渡されたpairIdMapをここで使用する
                    const teamAId = pairIdMap[teamAKey] ? `P${pairIdMap[teamAKey]}` : '';

                    court.team1.forEach(playerIdx => {
                        rows.push([matchIdx + 1, courtIdx + 1, 'プレイ', teamAId, `"${members[playerIdx]}"`, groups[playerIdx] === 'F' ? '女' : ''].join(','));
                    });

                    const teamBKey = court.team2.join(',');
                    // 引数で渡されたpairIdMapをここで使用する
                    const teamBId = pairIdMap[teamBKey] ? `P${pairIdMap[teamBKey]}` : '';

                    court.team2.forEach(playerIdx => {
                        rows.push([matchIdx + 1, courtIdx + 1, 'プレイ', teamBId, `"${members[playerIdx]}"`, groups[playerIdx] === 'F' ? '女' : ''].join(','));
                    });
                });

                match.restingPlayers.forEach(playerIdx => {
                    rows.push([matchIdx + 1, '', '休憩', '', `"${members[playerIdx]}"`, groups[playerIdx] === 'F' ? '女' : ''].join(','));
                });
            });

            return rows.join('\r\n');
        }

        function formatMemberDetailForCSV(favorite) {
            const { members, matches } = favorite;
            if (members.length === 0) return "";

            const headers = ['メンバー', '最大連続(結果)', ...matches.map((_, i) => `第${i + 1}試合`), '合計'];
            const rows = [headers.join(",")];
            const totalMembers = members.length; // お気に入りデータのメンバー数を取得

            // メンバー数を引数として渡す
            const maxConsecutiveMap = calculateMaxConsecutiveOverallPerMember(matches, totalMembers);
            const playCounts = calculateTotalPlayCounts(matches, totalMembers);

            members.forEach((name, memberIdx) => {
                const row = [name, maxConsecutiveMap[memberIdx] || 0];
                let cumulativePlays = 0;
                matches.forEach(match => {
                    if (match.playersThisRound.includes(memberIdx)) {
                        cumulativePlays++;
                    }
                    row.push(cumulativePlays);
                });
                row.push(playCounts[memberIdx] || 0);
                rows.push(row.join(","));
            });
            return rows.join("\r\n");
        }

        function formatPairDetailForCSV(favorite) {
            const { members, matches } = favorite;
            if (members.length < 2) return "";

            let allPairs = [];
            for (let i = 0; i < members.length; i++) {
                for (let j = i + 1; j < members.length; j++) {
                    allPairs.push([i, j]);
                }
            }

            const headers = ['ペア', ...matches.map((_, i) => `第${i + 1}試合`), '合計'];
            const rows = [headers.join(",")];
            const pairTotalCounts = calculateAllPairUsageCounts(matches);

            allPairs.forEach(pairIndices => {
                const pairKey = pairIndices.join(',');
                const pairName = '"' + pairIndices.map(idx => members[idx]).join(' & ') + '"';
                const row = [pairName];
                let cumulativeUses = 0;

                matches.forEach(match => {
                    let usedThisMatch = false;
                    match.courts.forEach(court => {
                        const cPair1Key = court.team1.join(',');
                        const cPair2Key = court.team2.join(',');
                        if (cPair1Key === pairKey || cPair2Key === pairKey) {
                            usedThisMatch = true;
                        }
                    });
                    if (usedThisMatch) {
                        cumulativeUses++;
                    }
                    row.push(cumulativeUses);
                });

                row.push(pairTotalCounts[pairKey] || 0);
                rows.push(row.join(","));
            });

            return rows.join("\r\n");
        }

        /**
                 * シンプルな対戦リスト形式でCSV文字列を生成する（新規作成）
                 * @param {Object} favorite - お気に入りデータ
                 * @returns {string} CSV形式の文字列
                 */
        function formatSimpleMatchupForCSV(favorite) {
            const { matches, members } = favorite;
            const headers = ['チームA', 'チームB'];
            let rows = [headers.join(',')]; // ヘッダー行

            matches.forEach(match => {
                match.courts.forEach(court => {
                    // チームのメンバーを名前に変換し、カンマ区切りの文字列にする
                    // ※画像では数字ですが、実際のメンバー名で出力します
                    const team1Names = court.team1.map(playerIdx => members[playerIdx]).join(', ');
                    const team2Names = court.team2.map(playerIdx => members[playerIdx]).join(', ');

                    // 各チームのセルをダブルクォーテーションで囲む
                    rows.push(`"${team1Names}","${team2Names}"`);
                });
            });

            return rows.join('\r\n');
        }

        function triggerDownload(blob, fileName) {
            const link = document.createElement("a");
            const url = URL.createObjectURL(blob);
            link.setAttribute("href", url);
            link.setAttribute("download", fileName);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            // メモリリークを避けるためにオブジェクトURLを解放します
            setTimeout(() => URL.revokeObjectURL(url), 100);
        }

        function confirmAndReset(type) {
            showDialog('確認',
                type === 'all' ?
                    'お気に入り以外の全ての設定とデータをリセットしますか？' :
                    '進行状況のみリセットしますか？',
                (confirmed) => {
                    if (!confirmed)
                        return;

                    if (type === 'all') {
                        const favoritesToKeep = [...appState.favorites];
                        localStorage.removeItem(LS_KEY);

                        Object.assign(appState, {
                            currentSurfaceCount: 1,
                            totalMemberCount: 0,
                            // ★★★ ここの値を 0 から DEFAULT_MAX_CONSECUTIVE に修正しました ★★★
                            maxConsecutiveLimit: DEFAULT_MAX_CONSECUTIVE,
                            forcedInfinity: false,
                            members: [],
                            groups: {},
                            exclusions: {},
                            joins: {},
                            joinOffsets: {},
                            allPossiblePairs: [],
                            matches: [],
                            completedMatches: new Set(),
                            favorites: favoritesToKeep,
                            dialogCallback: null,
                            charts: {
                                cumulativePlayCountChart: null,
                                memberProfileRadarChart: null
                            },
                            areAnalysisSectionsVisible: false,
                            editingMatch: null,
                            isRegeneratingAfterDropout: false
                        });

                        saveState();
                        window.location.reload();
                    } else {
                        appState.completedMatches.clear();
                        appState.exclusions = {};
                        appState.joins = {};
                        appState.joinOffsets = {};
                        updateExclusionUI();
                        applyDisplayLogicBasedOnState();
                        saveState();
                    }
                });
        }

        function
            showSwipeHint(el) {
            if
                (localStorage.getItem('swipeHintShown'))
                return;
            const tip =
                document.createElement('div');
            tip.className =
                'animate-bounce absolute right - 4 bottom - 4 z - 20 bg - gray - 800 text - white text - xs px - 2 py - 1 rounded';
            tip.textContent
                = '←→ スワイプで横へ';
            el.appendChild(tip);
            setTimeout(() => {
                tip.remove();
                localStorage.setItem('swipeHintShown',
                    'yes');
            }, 4000);
        }

        function toggleAnalysisVisibility() {
            appState.areAnalysisSectionsVisible = !appState.areAnalysisSectionsVisible;
            dom.analysisToggle.checked = appState.areAnalysisSectionsVisible;
            applyAnalysisVisibility();
        }
        function applyAnalysisVisibility() {
            const { analysisSection, graphToggleButton, graphIconShow, graphIconHide } = dom;
            const isVisible = appState.areAnalysisSectionsVisible;

            // ボタンアイコンの状態を更新
            graphToggleButton.title = `分析情報 ${isVisible ? '非表示' : '表示'} (Gキー)`;
            if (graphIconShow) graphIconShow.style.display = isVisible ? 'none' : 'block';
            if (graphIconHide) graphIconHide.style.display = isVisible ? 'block' : 'none';

            if (isVisible) {
                analysisSection.classList.remove('hidden');
                renderAnalysisCharts();
            } else {
                analysisSection.classList.add('hidden');
            }
        }

        function
            showDialog(title,
                message,
                callback,
                contentHtml =
                    '') {
            dom.dialogTitle.textContent
                = title;
            dom.dialogMessage.textContent
                = message ||
                '';
            dom.dialogMessageContainer.style.display
                =
                message ||
                    contentHtml ?
                    'block' :
                    'none';
            if (contentHtml) {
                dom.dialogMessageContainer.innerHTML
                    =
                    contentHtml;
            } else {
                dom.dialogMessageContainer.innerHTML
                    = `<p
                                                                                                            id="dialogMessage"
                                                                                                            class="text-sm text-gray-500">
                                                                                                            ${message
                    || ''}</p>`;
            }
            appState.dialogCallback
                = callback;
            dom.dialogCancelButton.style.display
                =
                callback ?
                    'inline-flex' :
                    'none';
            dom.dialogConfirmButton.textContent
                =
                callback ? '実行'
                    : '閉じる';
            dom.customDialog.classList.remove('hidden');
        }

        function createConfirmationDialog(title, message, onConfirm) {
            // 既存のダイアログとの競合を避ける
            if (document.getElementById('confirmationDialog')) return;

            const dialogOverlay = document.createElement('div');
            dialogOverlay.id = 'confirmationDialog';
            dialogOverlay.className = 'modal-base';
            dialogOverlay.innerHTML = `
                <div class="relative mx-auto p-5 border w-11/12 md:w-1/2 lg:w-1/3 shadow-lg rounded-md bg-white">
                    <div class="mt-3 text-center">
                        <h3 class="text-lg leading-6 font-medium text-gray-900">${title}</h3>
                        <div class="mt-2 px-7 py-3">
                            <p class="text-sm text-gray-500 whitespace-pre-wrap">${message}</p>
                        </div>
                    </div>
                    <div class="items-center px-4 py-3 space-x-2 text-center">
                        <button id="confirm-cancel-btn" class="px-4 py-2 bg-gray-200 text-gray-800 rounded-md hover:bg-gray-300">キャンセル</button>
                        <button id="confirm-ok-btn" class="px-4 py-2 button-primary text-white rounded-md">実行</button>
                    </div>
                </div>
            `;

            document.body.appendChild(dialogOverlay);

            const closeDialog = () => document.body.removeChild(dialogOverlay);

            document.getElementById('confirm-ok-btn').addEventListener('click', () => {
                onConfirm();
                closeDialog();
            });
            document.getElementById('confirm-cancel-btn').addEventListener('click', closeDialog);
            dialogOverlay.addEventListener('click', (e) => {
                if (e.target === dialogOverlay) closeDialog();
            });
        }

        // ダイアログ確認ボタンに一時登録したスクロール用リスナー（S評価時の探索完了ダイアログ等）を解除する。
        // OKボタン以外（Esc・オーバーレイクリック）で閉じられ、リスナーが未消費のまま残るのを防ぐ。
        function clearPendingDialogScrollHandler() {
            if (appState._pendingDialogScrollHandler) {
                dom.dialogConfirmButton.removeEventListener('click', appState._pendingDialogScrollHandler);
                appState._pendingDialogScrollHandler = null;
            }
        }

        function processDialog(confirmed) {
            // 同一クリックでこのダイアログ自身のスクロールリスナーがまだ発火していない場合に
            // 備え、この場で即座に解除せず次のタスクへ遅延する（{once:true}での正常発火を妨げない）。
            // 別ダイアログのOKボタンで前回分が残留しているケースは、これでそこで解除される。
            if (appState._pendingDialogScrollHandler) {
                const _staleScrollHandler = appState._pendingDialogScrollHandler;
                appState._pendingDialogScrollHandler = null;
                setTimeout(() => dom.dialogConfirmButton.removeEventListener('click', _staleScrollHandler), 0);
            }
            dom.customDialog.classList.add('hidden');
            if (appState.dialogCallback) {
                // ▼▼▼ このブロックで、ダイアログ内の入力値を取得します ▼▼▼
                let inputs = null;
                const formContainer = dom.dialogMessageContainer; // ダイアログのコンテンツエリア

                // コンテナ内にinputやtextareaが存在するかチェック
                if (formContainer && formContainer.querySelector('input, textarea')) {
                    inputs = {};
                    const inputElements = formContainer.querySelectorAll('input, textarea');
                    inputElements.forEach(el => {
                        // name属性をキーとして、値を格納
                        if (el.name) {
                            inputs[el.name] = el.value;
                        }
                    });
                }
                // ▲▲▲ ここまで ▲▲▲

                // ▼▼▼ コールバック関数に、取得した入力値(inputs)も渡すように変更 ▼▼▼
                appState.dialogCallback(confirmed, inputs);
            }
            appState.dialogCallback = null;
        }

        function updateSpecialRulesUI() {
            const { specialRulesWrapper, fixedPairPlayer1, fixedPairPlayer2, femalePlayersContainer } = dom;
            if (appState.currentTotalMemberCount > 0) {
                specialRulesWrapper.classList.remove('hidden');

                // appState.groupsのP1マーカーを正とする（loadState等の復元直後はDOM選択値が
                // 反映されていないため、appState.groups側にP1が2人いればそちらを優先する）
                const _p1Indices = Object.keys(appState.groups || {}).filter(k => appState.groups[k] === 'P1');
                const currentP1 = _p1Indices.length === 2 ? _p1Indices[0] : fixedPairPlayer1.value;
                const currentP2 = _p1Indices.length === 2 ? _p1Indices[1] : fixedPairPlayer2.value;

                // 表示順を名前でソート（数値名なら数値順、それ以外は文字列順）
                // 配列順序は過去のリナンバー処理で並び替わっている可能性があるため、表示時にソート
                const _sortedMembers = appState.members
                    .map((name, index) => ({ name, index }))
                    .sort((a, b) => {
                        const na = parseInt(a.name, 10), nb = parseInt(b.name, 10);
                        if (!isNaN(na) && !isNaN(nb) && `${na}` === String(a.name) && `${nb}` === String(b.name)) {
                            return na - nb;
                        }
                        return String(a.name).localeCompare(String(b.name));
                    });

                // ★★★ 修正点：value属性を正しく設定するため、appState.membersの現在のインデックスを使用します ★★★
                const optionsHTML = '<option value="-1">--</option>' + _sortedMembers.map(({ name, index }) => `<option value="${index}">${name}</option>`).join('');

                fixedPairPlayer1.innerHTML = optionsHTML;
                fixedPairPlayer2.innerHTML = optionsHTML;
                fixedPairPlayer1.value = currentP1;
                fixedPairPlayer2.value = currentP2;

                femalePlayersContainer.innerHTML = _sortedMembers.map(({ name, index }) => {
                    // ★★★ 修正点：appState.groupsのキーは新しいメンバー配列のインデックスに対応するため、直接indexで参照します ★★★
                    const isFemale = appState.groups[index] === 'F';
                    return `
                <label class="flex items-center space-x-2 text-sm">
                    <input type="checkbox" value="${index}" class="female-player-cb h-4 w-4 text-blue-600 border-gray-300 rounded" ${isFemale ? 'checked' : ''}>
                    <span>${name}</span>
                </label>`;
                }).join('');

            } else {
                specialRulesWrapper.classList.add('hidden');
            }

            handleRuleTypeChange();
            refreshFixedPairSelect();
        }

        function
            refreshFixedPairSelect() {
            const p1 =
                dom.fixedPairPlayer1.value;
            const p2 =
                dom.fixedPairPlayer2.value;
            [...dom.fixedPairPlayer1.options].forEach(o => {
                o.disabled =
                    (o.value === p2
                        && o.value
                        !== '-1');
            });[...dom.fixedPairPlayer2.options].forEach(o => {
                o.disabled =
                    (o.value === p1
                        && o.value !==
                        '-1');
            });
        }

        // loadState/お気に入り読込/JSONインポートの直後、updateAllUIを呼ぶ前に使用。
        // これを怠るとinput[name="ruleType"]がHTMLのデフォルト値のまま残り、
        // updateAllUI → updateSpecialRulesUI → handleRuleTypeChange → updateGroupsFromSpecialRules
        // の経路で、復元したはずのappState.groupsが空オブジェクトで上書き保存されてしまう。
        function restoreRuleTypeRadioFromState() {
            const rt = (appState.generationSettings && appState.generationSettings.ruleType) || 'none';
            const radio = document.querySelector(`input[name="ruleType"][value="${rt}"]`);
            if (radio) radio.checked = true;
        }

        function
            handleRuleTypeChange() {
            const ruleType =
                document.querySelector('input[name="ruleType"]:checked').value;
            dom.fixedPairWrapper.classList.toggle('hidden',
                ruleType !==
                'fixedPair');
            dom.genderMixWrapper.classList.toggle('hidden',
                ruleType !==
                'genderMix');
            updateGroupsFromSpecialRules();
        }

        function updateGroupsFromSpecialRules() {
            const ruleType =
                document.querySelector('input[name="ruleType"]:checked').value;
            const newGroups = {};
            if (ruleType === 'fixedPair') {
                const p1 = parseInt(dom.fixedPairPlayer1.value, 10);
                const p2 = parseInt(dom.fixedPairPlayer2.value, 10);
                if (p1 !== -1 && p2 !== -1 && p1 !== p2) {
                    newGroups[p1] = 'P1';
                    newGroups[p2] = 'P1';
                }
            } else if (ruleType === 'genderMix') {
                dom.femalePlayersContainer.querySelectorAll('.female-player-cb:checked').forEach(cb => {
                    const playerIndex = parseInt(cb.value, 10);
                    newGroups[playerIndex] = 'F';
                });
                appState.members.forEach((_, index) => {
                    if (!newGroups[index]) {
                        newGroups[index] = 'M';
                    }
                });
            }
            appState.groups = newGroups;
            saveState();
        }

        // メンバーを表示名でソートしたヘルパー（離脱・手動参加・未到着の各UIで共用）
        function getSortedMembersForDropoutUI() {
            return appState.members
                .map((name, index) => ({ name, index }))
                .sort((a, b) => {
                    const na = parseInt(a.name, 10), nb = parseInt(b.name, 10);
                    if (!isNaN(na) && !isNaN(nb)) return na - nb;
                    return String(a.name).localeCompare(String(b.name));
                });
        }

        function updateExclusionUI() {
            const _dropoutSorted = getSortedMembersForDropoutUI();
            const _optionsHtml = _dropoutSorted
                .map(({ name, index }) => `<option value="${index}">${name}</option>`)
                .join('');

            // 途中離脱
            dom.dropoutPlayerSelect.innerHTML = _optionsHtml;
            dom.dropoutMatchNumberInput.value = '';
            const hasMatches = appState.matches.length > 0;
            dom.applyDropoutButton.disabled = !hasMatches;
            dom.dropoutMatchNumberInput.max = appState.matches.length;
            dom.dropoutHint.textContent = hasMatches
                ? `1〜${appState.matches.length}の範囲で選択できます。`
                : '先に試合を生成してください。';

            updateNotArrivedCountDisplay();
            renderArrivalButtons();
        }

        // 「うち未到着」数値入力の表示値を、実際のappState.joins(JOIN_NOT_ARRIVED)の
        // 件数に同期する。人数構成が変わってjoinsがリセットされた場合は自動的に0になる
        function updateNotArrivedCountDisplay() {
            if (!dom.notArrivedCountInput) return;
            const count = Object.values(appState.joins).filter(v => v === JOIN_NOT_ARRIVED).length;
            dom.notArrivedCountInput.value = String(count);
            const maxN = Math.max(0, appState.currentTotalMemberCount - appState.currentSurfaceCount * 4);
            dom.notArrivedCountInput.max = String(maxN);
        }

        // 「うち未到着」の人数指定に応じて、登録順の末尾からN人をjoins[idx]=JOIN_NOT_ARRIVED
        // (全試合不参加)に設定する。既に到着済み(実際のfromMatch値)・離脱設定済みの
        // メンバーは対象外として飛ばす。「末尾N個の席」を固定で見ると、到着済みメンバーが
        // 末尾の席を占めている場合に指定人数より少なくマークされ、表示が実カウントに
        // 戻ってしまう（入力が効かないように見える）ため、設定可能なメンバーだけを数える
        function handleNotArrivedCountChange() {
            const total = appState.currentTotalMemberCount;
            const maxN = Math.max(0, total - appState.currentSurfaceCount * 4);
            let n = parseInt(dom.notArrivedCountInput.value, 10);
            if (isNaN(n) || n < 0) n = 0;
            if (n > maxN) n = maxN;

            let remaining = n;
            for (let i = total - 1; i >= 0; i--) {
                const hasArrivedJoin = appState.joins[i] != null && appState.joins[i] !== JOIN_NOT_ARRIVED;
                if (hasArrivedJoin || appState.exclusions[i] != null) continue;
                if (remaining > 0) {
                    appState.joins[i] = JOIN_NOT_ARRIVED;
                    remaining--;
                } else {
                    delete appState.joins[i];
                }
            }
            recalculateAllJoinOffsets();
            updateMaxConsecutiveForActiveCount();
            updateNotArrivedCountDisplay();
            renderArrivalButtons();
            updateTargetScoreUI();
            saveState();
        }

        // 未到着人数の変更に応じて最大連続プレイ数の推奨値・選択肢を更新する。
        // 未到着メンバーは試合枠を消費しないため、実効人数(合計-未到着)で計算しないと
        // 「上限が緩すぎて生成が破綻する/厳しすぎて選択肢に出ない」が起こる
        function updateMaxConsecutiveForActiveCount() {
            const P = appState.currentSurfaceCount * 4;
            const _notArr = Object.values(appState.joins).filter(v => v === JOIN_NOT_ARRIVED).length;
            const N = appState.currentTotalMemberCount - _notArr;
            let newLimit = DEFAULT_MAX_CONSECUTIVE;
            if (N > P) {
                const Kmin = Math.ceil(P / (N - P));
                newLimit = (Kmin >= 99) ? 99 : Math.min(Kmin + 1, 15);
            } else {
                newLimit = 99;
            }
            appState.maxConsecutiveLimit = newLimit;
            updateMaxConsecutiveOptions();
            if (![...dom.maxConsecutiveSelect.options].some(opt => opt.value == newLimit)) {
                dom.maxConsecutiveSelect.appendChild(new Option(`${newLimit} 連続`, newLimit));
            }
            dom.maxConsecutiveSelect.value = String(newLimit);
        }

        // 試合スケジュールカード上部に、未到着メンバー(joins===JOIN_NOT_ARRIVED)の
        // 「到着」ボタンを末尾番号側から順に表示する。試合未生成なら何も表示しない
        function renderArrivalButtons() {
            const container = dom.arrivalButtonsContainer;
            if (!container) return;
            if (appState.matches.length === 0) { container.innerHTML = ''; return; }
            const notArrivedIndices = Object.entries(appState.joins)
                .filter(([, v]) => v === JOIN_NOT_ARRIVED)
                .map(([idx]) => parseInt(idx, 10))
                .sort((a, b) => a - b);
            if (notArrivedIndices.length === 0) { container.innerHTML = ''; return; }
            container.innerHTML = notArrivedIndices.map(idx =>
                `<button type="button" class="arrival-button inline-flex items-center gap-1.5 text-sm border rounded-full px-3 py-1.5 bg-amber-50 border-amber-300 text-amber-800 font-semibold" data-player-index="${idx}">
                    🏃 ${appState.members[idx]}さん到着
                </button>`
            ).join('');
        }

        async function handleArrival(playerIndex) {
            if (appState.matches.length === 0) return;

            // fromMatch = 最初の未消化試合番号（1-indexed）
            let fromMatch = null;
            for (let i = 0; i < appState.matches.length; i++) {
                if (!appState.completedMatches.has(i)) { fromMatch = i + 1; break; }
            }
            if (fromMatch === null) {
                showDialog('エラー', '全ての試合が消化済みのため、途中参加を自動的に組み込めません。試合をタップして手動で編集してください。');
                return;
            }

            showDialog(
                '確認',
                `${appState.members[playerIndex]}さんを第${fromMatch}試合から参加させ、以降の試合を再生成しますか？（第${fromMatch - 1}試合までは変更されません）`,
                async (confirmed) => {
                    if (!confirmed) return;

                    appState.joins[playerIndex] = fromMatch;
                    updateJoinOffset(playerIndex, fromMatch);

                    // 人数が増える方向なので緩和は不要だが、上限が∞(99)だった場合は
                    // 参加後にN>Pへ転じることがあるため、有限値に戻せないか確認する
                    const P = appState.currentSurfaceCount * 4;
                    const activeCountAtJoin = Array.from({ length: appState.currentTotalMemberCount }, (_, i) => i)
                        .filter(i => isPlayerActive(i, fromMatch, appState.exclusions, appState.joins)).length;
                    if (appState.maxConsecutiveLimit >= 99 && activeCountAtJoin > P) {
                        const newLimit = Math.ceil(P / (activeCountAtJoin - P));
                        appState.maxConsecutiveLimit = newLimit;
                        dom.maxConsecutiveSelect.value = String(newLimit);
                        saveState();
                    }

                    // 「未到着」だった選手は元のスケジュール全体で最初から除外されているため、
                    // 第fromMatch試合より前を作り直す必要はない（離脱と同じ部分再生成でよい）。
                    // 完了済み試合・進行状況チェックは温存する
                    appState.isRegeneratingAfterDropout = true;
                    await generateAndDisplayMatches(appState.matches.length, /*isRegenerate=*/true, /*regenerateFrom=*/fromMatch);
                    appState.isRegeneratingAfterDropout = false;
                }
            );
        }

        async function handleApplyExclusion() {
            // 入力値を取得
            const playerIndex = parseInt(dom.dropoutPlayerSelect.value, 10);
            const fromMatch = parseInt(dom.dropoutMatchNumberInput.value, 10);

            // 入力値が有効かチェック
            if (isNaN(playerIndex) || isNaN(fromMatch) || fromMatch < 1 || fromMatch > appState.matches.length) {
                showDialog('入力エラー', '有効なメンバーと試合番号（1〜' + appState.matches.length + '）を入力してください。');
                return;
            }

            // 制約: 同一メンバーへのjoins/exclusionsは joins < exclusions のみ許可
            const existingJoin = appState.joins[playerIndex];
            if (existingJoin === JOIN_NOT_ARRIVED) {
                showDialog('入力エラー', `${appState.members[playerIndex]}さんは未到着のため、離脱を設定できません。（参加しないまま終わる場合は未到着のままで問題ありません）`);
                return;
            }
            if (existingJoin != null && !(existingJoin < fromMatch)) {
                showDialog('入力エラー', `${appState.members[playerIndex]}さんは第${existingJoin}試合から途中参加の設定があります。離脱はそれより後の試合番号にしてください。`);
                return;
            }

            // ★★★ ここが修正点です ★★★
            // showDialog関数に「タイトル」「メッセージ」「実行する処理」を正しく渡します。
            showDialog(
                '確認',
                `${appState.members[playerIndex]}さんを第${fromMatch}試合から離脱させ、以降の試合を再生成しますか？`,
                async (confirmed) => {
                    if (!confirmed) return;

                    // 離脱情報を設定
                    appState.exclusions[playerIndex] = fromMatch;

                    // 人数に応じて、最大連続プレイ数を自動で調整
                    const P = appState.currentSurfaceCount * 4;
                    const dropCount = Object.values(appState.exclusions)
                        .filter(v => v <= fromMatch).length;
                    const N = appState.currentTotalMemberCount - dropCount;
                    let newLimit = (N <= P) ? 99 : Math.ceil(P / (N - P));

                    if (appState.maxConsecutiveLimit < newLimit) {
                        appState.maxConsecutiveLimit = newLimit;
                        dom.maxConsecutiveSelect.value = String(newLimit);
                        saveState();
                    }

                    // 再生成フラグを立てて、試合を再生成
                    appState.isRegeneratingAfterDropout = true;
                    await generateAndDisplayMatches(appState.matches.length, /*isRegenerate=*/true, /*regenerateFrom=*/fromMatch);
                    appState.isRegeneratingAfterDropout = false;
                }
            );
        }

        function openEditMatchModal(matchIndex, courtIndex) {
            if (!dom.editMatchTitle || !dom.editMatchForm) {
                console.error('Edit-match modal elements not found');
                return;
            }
            appState.editingMatch = { matchIndex, courtIndex };
            const match = appState.matches[matchIndex];
            const courtToEdit = match.courts[courtIndex];

            // ▼▼▼ ここからが新しいロジック ▼▼▼
            // 同じ試合の、編集対象「以外」のコートでプレイしている全プレイヤーを特定する
            const lockedPlayers = new Set();
            match.courts.forEach((court, cIdx) => {
                if (cIdx !== courtIndex) { // 編集中のコートは除外
                    court.players.forEach(pIdx => lockedPlayers.add(String(pIdx)));
                }
            });
            // ▲▲▲ 新しいロジックここまで ▲▲▲

            dom.editMatchTitle.textContent = `第${matchIndex + 1}試合 - コート${courtIndex + 1} の編集`;

            const playerOptionsHTML = appState.members.map((name, index) => `<option value="${index}">${name}</option>`).join('');

            const formContent = `
                <div class="grid grid-cols-2 gap-4">
                    <div><label class="block text-sm font-medium text-gray-700">チームA - 1人目</label><select id="edit-player-0" class="input-select mt-1 block w-full">${playerOptionsHTML}</select></div>
                    <div><label class="block text-sm font-medium text-gray-700">チームA - 2人目</label><select id="edit-player-1" class="input-select mt-1 block w-full">${playerOptionsHTML}</select></div>
                    <div><label class="block text-sm font-medium text-gray-700">チームB - 1人目</label><select id="edit-player-2" class="input-select mt-1 block w-full">${playerOptionsHTML}</select></div>
                    <div><label class="block text-sm font-medium text-gray-700">チームB - 2人目</label><select id="edit-player-3" class="input-select mt-1 block w-full">${playerOptionsHTML}</select></div>
                </div>`;
            dom.editMatchForm.innerHTML = formContent;

            const _t1 = courtToEdit.team1 || [];
            const _t2 = courtToEdit.team2 || [];
            document.getElementById('edit-player-0').value = _t1[0];
            document.getElementById('edit-player-1').value = _t1[1];
            document.getElementById('edit-player-2').value = _t2[0];
            document.getElementById('edit-player-3').value = _t2[1];

            // プルダウンの選択肢を無効化するヘルパー関数を修正
            function refreshEditSelect() {
                const chosenInModal = new Set([...Array(4).keys()].map(i => document.getElementById(`edit-player-${i}`).value));

                [...Array(4).keys()].forEach(i => {
                    const sel = document.getElementById(`edit-player-${i}`);
                    [...sel.options].forEach(o => {
                        const isLocked = lockedPlayers.has(o.value);
                        const isChosenInOtherModalDropdown = chosenInModal.has(o.value) && !o.selected;

                        // ▼▼▼ 無効化の条件を修正 ▼▼▼
                        o.disabled = isLocked || isChosenInOtherModalDropdown;

                        if (isLocked) {
                            o.textContent = `✗ ${appState.members[o.value]} (他コートでプレイ中)`;
                        } else if (isChosenInOtherModalDropdown) {
                            o.textContent = `✗ ${appState.members[o.value]} (他の枠で選択中)`;
                        } else {
                            o.textContent = appState.members[o.value];
                        }
                    });
                });
            }

            [...Array(4).keys()].forEach(i => {
                document.getElementById(`edit-player-${i}`).addEventListener('change', refreshEditSelect);
            });

            refreshEditSelect(); // 初回実行
            dom.editMatchModal.classList.remove('hidden');
        }

        async function saveMatchEdit() {
            const { matchIndex, courtIndex } = appState.editingMatch;

            // --- 1. 新しいプレイヤーを取得し、基本的な重複チェック ---
            const newPlayers = [
                +document.getElementById('edit-player-0').value,
                +document.getElementById('edit-player-1').value,
                +document.getElementById('edit-player-2').value,
                +document.getElementById('edit-player-3').value
            ];
            if (new Set(newPlayers).size !== 4) {
                showDialog('エラー', '同じメンバーを重複して選択することはできません。');
                return;
            }

            // --- 2. 編集内容をテストするための一時的な試合リストを作成 ---
            const tempMatches = JSON.parse(JSON.stringify(appState.matches));
            const matchToTest = tempMatches[matchIndex];

            // 一時的な試合リストに編集を適用
            matchToTest.courts[courtIndex] = {
                team1: newPlayers.slice(0, 2).sort((a, b) => a - b),
                team2: newPlayers.slice(2).sort((a, b) => a - b),
                players: [...newPlayers].sort((a, b) => a - b)
            };
            matchToTest.playersThisRound = matchToTest.courts.flatMap(c => c.players);

            // 手動編集はルールチェックを行わない（遅刻・任意交代など意図した操作を妨げないため）

            // --- 4. ルール上問題なければ、後続の試合の再生成を試みる ---
            const originalMatchesBackup = JSON.parse(JSON.stringify(appState.matches)); // 失敗時に復元するためのバックアップ
            appState.matches = tempMatches.slice(0, matchIndex + 1); // 編集した試合までを正式にコミット

            let regenerationSuccess = true;
            for (let i = appState.matches.length; i < originalMatchesBackup.length; i++) {
                // 通常の（厳密な）ルールで後続の試合を探す
                const bestMatch = findBestMatchCandidate(i, appState.maxConsecutiveLimit);
                if (bestMatch) {
                    appState.matches.push(bestMatch);
                } else {
                    regenerationSuccess = false; // 1つでも見つからなければ失敗
                    break;
                }
            }

            // --- 5. 再生成の結果に応じて最終処理を行う ---
            if (regenerationSuccess) {
                // 成功した場合
                dom.editMatchModal.classList.add('hidden');
                appState.editingMatch = null;
                renderAllResults();
                showDialog('更新完了', `第${matchIndex + 1}試合を更新し、以降の試合を再計算しました。`);
                dom.saveFavoriteButton.disabled = false;
                pushStateToHistory(); // 成功したので履歴に保存
            } else {
                // 失敗した場合
                appState.matches = originalMatchesBackup; // バックアップから元の状態に復元
                showDialog('再計算中断', `そのメンバー交代は可能ですが、後続の公平な試合が見つかりませんでした。\n\n編集前の状態に戻ります。`);
                renderAllResults(); // UIも元に戻す
            }

            saveState(); // localStorageに保存
        }

        function
            clearDetailedStatsTabs() {
            dom.detailedStatsTabButtons.querySelectorAll('button').forEach(b =>
                b.classList.remove('active'));
            dom.detailedStatsTablesContainer.querySelectorAll('.detailed-table').forEach(div =>
                div.classList.add('hidden'));
        }
        function isConsecutivePlayLimitViolated(candidate, existingMatches, limit) {
            if (limit >= 99) return false;
            for (const pIdx of candidate.playersThisRound) {
                let count = 1;
                for (let i = existingMatches.length - 1; i >= 0; i--) {
                    if (existingMatches[i].playersThisRound.includes(pIdx)) count++;
                    else break;
                }
                const threshold = appState.isRegeneratingAfterDropout ? limit + 1 : limit;
                if (count > threshold) return true;
            }
            return false;
        }

        function
            addModalCloseBehaviour(modalElm) {
            document.addEventListener('keydown',
                e => {
                    if
                        (e.key
                        ===
                        'Escape'
                        &&
                        !modalElm.classList.contains('hidden')) {
                        modalElm.classList.add('hidden');
                        // Escで閉じた場合はprocessDialogを経由しないため、ここで直接解除する
                        if (modalElm === dom.customDialog) clearPendingDialogScrollHandler();
                    }
                });
            modalElm.addEventListener('click',
                e => {
                    if
                        (e.target
                        ===
                        modalElm) {
                        modalElm.classList.add('hidden');
                        // オーバーレイクリックで閉じた場合も同様にprocessDialogを経由しない
                        if (modalElm === dom.customDialog) clearPendingDialogScrollHandler();
                    }
                });
        }

        function renderGenerationSummary() {
            const { currentSurfaceCount, currentTotalMemberCount, members, exclusions, joins, dataSource } = appState;
            const container = document.getElementById('generationSummaryContainer');
            if (!container) return;

            const ruleMap = { none: 'なし', fixedPair: '固定ペア', genderMix: '男女ミックス' };
            const currentRule = document.querySelector('input[name="ruleType"]:checked').value;

            let summaryParts = [];

            // データ元の情報を表示
            if (dataSource) {
                const _isSA = dataSource && dataSource.includes('アニーリング');
                const _isFav = dataSource && !_isSA && dataSource !== '新規生成';
                const label = _isSA ? 'AI最適化'
                    : _isFav ? `お気に入り: <span class="font-normal">${dataSource}</span>`
                    : dataSource;
                summaryParts.push(`<strong>データ元:</strong> <span class="text-blue-600 font-semibold">${label}</span>`);
            }

            // 生成条件を表示
            let conditionsText = `<strong>条件:</strong> ${currentSurfaceCount}面 / ${currentTotalMemberCount}人 / ルール: ${ruleMap[currentRule]}`;
            const exclusionEntries = Object.entries(exclusions || {});
            if (exclusionEntries.length > 0) {
                const exclusionText = exclusionEntries.map(([playerIdx, fromMatch]) => {
                    return `${members[playerIdx]}(${fromMatch}試合目~)`;
                }).join(', ');
                conditionsText += ` / <strong>離脱:</strong> ${exclusionText}`;
            }
            const joinEntries = Object.entries(joins || {});
            const notArrivedEntries = joinEntries.filter(([, fromMatch]) => fromMatch === JOIN_NOT_ARRIVED);
            const arrivedJoinEntries = joinEntries.filter(([, fromMatch]) => fromMatch !== JOIN_NOT_ARRIVED);
            if (notArrivedEntries.length > 0) {
                conditionsText += ` / <strong>未到着:</strong> ${notArrivedEntries.length}名`;
            }
            if (arrivedJoinEntries.length > 0) {
                const joinText = arrivedJoinEntries.map(([playerIdx, fromMatch]) => {
                    return `${members[playerIdx]}(第${fromMatch}試合~)`;
                }).join(', ');
                conditionsText += ` / <strong>参加:</strong> ${joinText}`;
            }
            summaryParts.push(conditionsText);

            // 試合がある場合はグレードも表示
            if (appState.matches.length > 0 && appState.allPossiblePairs.length > 0) {
                const statsSnap = calculateSummaryStats(appState.matches, appState.members, appState.allPossiblePairs);
                const gradeSnap = calcOverallGrade(statsSnap, appState.matches, appState.members, appState.allPossiblePairs);
                const ceilInfo2 = calcConditionCeiling(appState.currentSurfaceCount, getEffectiveMemberCountForCeiling(), appState.matches.length);
                const _ceilScore2 = ceilInfo2.totalBase ?? ceilInfo2.total;
                // _ceilScore2はmixBonus抜きなので、比較側もtotalBase(bonus抜き)で揃える
                const _reachedCeil2 = Math.max(0, _ceilScore2 - gradeSnap.totalBase) <= 1.0;
                // サマリーパネルと同様に上限到達時はSへ昇格
                if (_reachedCeil2) {
                    gradeSnap.grade = 'S';
                    gradeSnap.stars = '★★★★★';
                    gradeSnap.color = '#16a34a';
                }
                // ステータスバーも達成率ベースの相対グレードを使用（ダイアログと一致させる）
                let _sb_grade = gradeSnap.grade, _sb_color = gradeSnap.color, _sb_stars = gradeSnap.stars;
                if (_reachedCeil2) {
                    _sb_grade = 'S'; _sb_color = '#16a34a'; _sb_stars = '★★★★★';
                } else if (_ceilScore2 > 0) {
                    const _sbPct = Math.round(gradeSnap.totalBase / _ceilScore2 * 100);
                    if (_sbPct >= 95) { _sb_grade = 'S'; _sb_color = '#16a34a'; _sb_stars = '★★★★★'; }
                    else if (_sbPct >= 88) { _sb_grade = 'A'; _sb_color = '#2563eb'; _sb_stars = '★★★★☆'; }
                    else if (_sbPct >= 78) { _sb_grade = 'B'; _sb_color = '#7c3aed'; _sb_stars = '★★★☆☆'; }
                    else if (_sbPct >= 65) { _sb_grade = 'C'; _sb_color = '#d97706'; _sb_stars = '★★☆☆☆'; }
                    else { _sb_grade = 'D'; _sb_color = '#dc2626'; _sb_stars = '★☆☆☆☆'; }
                }
                const retryIcon = _reachedCeil2 ? ' ✅' : ' 🔄';
                const badgeStyle = `display:inline-block;background:${_sb_color}22;color:${_sb_color};border:1px solid ${_sb_color}66;border-radius:12px;padding:1px 8px;font-weight:700;font-size:13px;margin-left:8px;`;
                summaryParts.push(`<span style="${badgeStyle}">${_sb_grade} ${gradeSnap.total}点 ${_sb_stars}${retryIcon}</span>`);
            }
            container.innerHTML = summaryParts.join('<span class="mx-2 text-gray-300">|</span>');
        }

        function renderAllResults() {
            renderGenerationSummary(); // ← 抜け落ちていたこの行を追加
            renderArrivalButtons();
            renderMatchList();
            updateProgressIndicator();
            renderSummaryStats();

            const results = dom.resultsDashboard;
            if (results) {
                results.classList.remove('hidden');
                // ついでに display:block にもしておく
                results.style.display = 'block';
            }


            const memberDetailContent = document.getElementById('memberDetailContent');
            if (memberDetailContent) {
                const pcTable = generateMemberDetailTableHTML();
                const spCards = generateMemberDetailCardHTML();
                memberDetailContent.innerHTML = `
                    <div class="hidden md:block">${pcTable}</div>
                    <div class="md:hidden">${spCards}</div>
                `;
            }

            // ビジュアル分析を描画
            renderSankeyChart();
            renderCumulativePlayCountChart();
            renderMemberProfileRadarChart();
            renderPairCombinationHeatmap();
            renderPairVsPairHeatmap();

            // 詳細統計のデフォルトタブを表示
            if (dom.detailedStatsTabButtons.querySelector('button[data-table]')) {
                showDetailedStatsTable('pairStats');
            }
        }

        function updateScrollableShadows() {
            const scrollableElements = document.querySelectorAll('.scrollable-x');
            scrollableElements.forEach(el => {
                // 要素の中身の幅(scrollWidth)が、表示されている幅(clientWidth)より大きいかチェック
                const isScrollable = el.scrollWidth > el.clientWidth;
                // isScrollableがtrueの場合のみ is-scrolling クラスを付与/削除
                el.classList.toggle('is-scrolling', isScrollable);
            });
        }

        /**
             * 「初重複試合番号」を計算する関数（新規作成）
             * @param {Array} matches - 試合スケジュールの配列
             * @param {string} type - 'pair' または 'group'
             * @returns {number | string} 重複が始まった試合番号、または「全て新規」
             */
        /**
                 * 「初重複試合番号」を計算する関数（ユーザー様のロジックを反映した最終版）
                 * @param {Array} matches - 試合スケジュールの配列
                 * @param {string} type - 'pair' または 'group'
                 * @returns {number | string} 重複が始まった試合番号、または「全て新規」
                 */
        function calculateFirstRepetitionMatch(matches, type) {
            if (!matches || matches.length === 0) return 'N/A';

            const uniqueItemsSeen = new Set();

            for (let i = 0; i < matches.length; i++) {
                const match = matches[i];
                let isRepetitionFound = false;

                if (type === 'pair') {
                    const currentPairs = match.courts.flatMap(c => [
                        [...c.team1].sort().join(','),
                        [...c.team2].sort().join(',')
                    ]);
                    // この試合のペアのいずれかが、既に登場済みかチェック
                    if (currentPairs.some(p => uniqueItemsSeen.has(p))) {
                        isRepetitionFound = true;
                    }
                    // チェックが終わったら、今回のペアを既出リストに追加
                    currentPairs.forEach(p => uniqueItemsSeen.add(p));
                } else if (type === 'group') {
                    const currentGroups = match.courts.map(c => [...c.players].sort((a, b) => a - b).join(','));
                    if (currentGroups.some(g => uniqueItemsSeen.has(g))) {
                        isRepetitionFound = true;
                    }
                    currentGroups.forEach(g => uniqueItemsSeen.add(g));
                }

                // もしこの試合で初めて重複が見つかったら、その試合番号を返す
                if (isRepetitionFound) {
                    return i + 1;
                }
            }
            return '全て新規'; // ループを抜けた = 全ての試合で新規アイテムがあった
        }
        /**
             * 各メンバーのユニークなペア相手数を計算し、その最小/平均/最大を返す（新規作成）
             * @param {Array} matches - 試合スケジュールの配列
             * @param {Array} members - メンバーの配列
             * @returns {Object} {min, avg, max}
             */
        function calculatePartnerDiversityStats(matches, members) {
            if (members.length < 2) return { min: 0, avg: 0, max: 0 };

            const diversityCounts = members.map((_, memberIdx) => {
                const partners = new Set();
                matches.forEach(m => {
                    m.courts.forEach(c => {
                        if (c.team1.includes(memberIdx)) {
                            partners.add(c.team1.find(p => p !== memberIdx));
                        }
                        if (c.team2.includes(memberIdx)) {
                            partners.add(c.team2.find(p => p !== memberIdx));
                        }
                    });
                });
                partners.delete(undefined);
                return partners.size;
            });

            const total = diversityCounts.reduce((sum, count) => sum + count, 0);
            const avg = total / diversityCounts.length;
            const min = Math.min(...diversityCounts);
            const max = Math.max(...diversityCounts);

            return { min, avg, max };
        }

        function calculateMatchupFairness(matches, allPossiblePairs) {
            if (allPossiblePairs.length === 0) {
                return { cv: 0, gini: 0 };
            }

            const pairOpponentDiversity = {};
            allPossiblePairs.forEach(p => {
                const key = p.join(',');
                pairOpponentDiversity[key] = new Set();
            });

            matches.forEach(m => {
                m.courts.forEach(c => {
                    const p1_key = [...c.team1].sort((a, b) => a - b).join(',');
                    const p2_key = [...c.team2].sort((a, b) => a - b).join(',');

                    if (pairOpponentDiversity[p1_key] && pairOpponentDiversity[p2_key]) {
                        pairOpponentDiversity[p1_key].add(p2_key);
                        pairOpponentDiversity[p2_key].add(p1_key);
                    }
                });
            });

            const diversityCounts = Object.values(pairOpponentDiversity).map(s => s.size);

            return {
                cv: calcCV(diversityCounts),
                gini: calcGini(diversityCounts)
            };
        }

        // ▼▼▼ このヘルパー関数をまるごと追加 ▼▼▼
        const formatFairness = (cv) => {
            if (typeof cv !== 'number' || isNaN(cv)) return 'N/A';

            let stars = '';
            let text = '';

            if (cv <= 0.20) { stars = '★★★★★'; text = 'ほぼ均等'; }
            else if (cv <= 0.35) { stars = '★★★★☆'; text = '僅かな偏り'; }
            else if (cv <= 0.50) { stars = '★★★☆☆'; text = 'やや偏りあり'; }
            else if (cv <= 0.75) { stars = '★★☆☆☆'; text = '偏りあり'; }
            else { stars = '★☆☆☆☆'; text = '特定の対象に集中'; }

            return `${stars} <small class="block text-gray-500">${text} (${cv.toFixed(2)})</small>`;
        };

        function showComparisonDialog(selectedFavorites) {
            const allCalculatedStats = selectedFavorites.map(fav => ({
                fav,
                stats: calculateSummaryStats(fav.matches, fav.members, appState.allPossiblePairs),
                frp: {
                    pair: calculateFirstRepetitionMatch(fav.matches, 'pair'),
                    group: calculateFirstRepetitionMatch(fav.matches, 'group')
                },
                partnerStats: calculatePartnerDiversityStats(fav.matches, fav.members)
            }));

            // ▼▼▼ ここからが修正箇所 ▼▼▼
            // ヘルパー関数をこの場で完全に定義します
            function formatFairness(cv) {
                if (typeof cv !== 'number' || isNaN(cv)) return 'N/A';
                let stars = '', text = '';
                if (cv <= 0.20) { stars = '★★★★★'; text = 'ほぼ均等'; }
                else if (cv <= 0.35) { stars = '★★★★☆'; text = '僅かな偏り'; }
                else if (cv <= 0.50) { stars = '★★★☆☆'; text = 'やや偏りあり'; }
                else if (cv <= 0.75) { stars = '★★☆☆☆'; text = '偏りあり'; }
                else { stars = '★☆☆☆☆'; text = '特定の対象に集中'; }
                return `${stars} <small class="block text-gray-500">${text} (${cv.toFixed(2)})</small>`;
            }

            const areNumbersEffectivelyEqual = (a, b) => {
                if (typeof a !== 'number' || typeof b !== 'number') return false;
                return parseFloat(a.toPrecision(10)) === parseFloat(b.toPrecision(10));
            };

            function getWinnerClass(isHigherBetter, currentValue, allValues) {
                const numericValues = allValues.filter(v => typeof v === 'number' && !isNaN(v));
                if (numericValues.length < 2) return '';
                const allEqual = numericValues.every(v => areNumbersEffectivelyEqual(v, numericValues[0]));
                if (allEqual) return '';
                if (currentValue === '全て新規') return 'bg-green-100 font-bold';
                if (allValues.some(v => v === '全て新規' && v !== currentValue)) return '';
                const bestValue = isHigherBetter ? Math.max(...numericValues) : Math.min(...numericValues);
                if (typeof currentValue === 'number' && areNumbersEffectivelyEqual(currentValue, bestValue)) {
                    return 'bg-green-100 font-bold';
                }
                return '';
            }
            // ▲▲▲ 修正ここまで ▲▲▲

            const metrics = [
                { label: 'ベストスコア', higherIsBetter: true, format: v => v?.toFixed(2) || 'N/A', values: allCalculatedStats.map(s => s.fav.analysis?.bestMetaScore) },
                { label: 'プレイ回数の最大差', higherIsBetter: false, values: allCalculatedStats.map(s => s.stats.maxPlayCountDiff) },
                { label: 'ペア結成の多様性 (%)', higherIsBetter: true, format: v => v.toFixed(0), values: allCalculatedStats.map(s => s.stats.pairCoverage.ratio * 100) },
                { label: '対戦グループの多様性 (%)', higherIsBetter: true, format: v => v.toFixed(0), values: allCalculatedStats.map(s => s.stats.cardCoverage.ratio * 100) },
                { label: '対戦カードの多様性 (%)', higherIsBetter: true, format: v => v.toFixed(0), values: allCalculatedStats.map(s => s.stats.opponentCoverage.ratio * 100) },
                { label: 'ペア結成の公平性', higherIsBetter: false, format: formatFairness, values: allCalculatedStats.map(s => s.stats.pairFairness.cv) },
                { label: '対戦グループの公平性', higherIsBetter: false, format: formatFairness, values: allCalculatedStats.map(s => s.stats.cardFairness.cv) },
                { label: '対戦の公平性', higherIsBetter: false, format: formatFairness, values: allCalculatedStats.map(s => s.stats.matchupFairness.cv) },
                { label: '初重複試合番号 (ペア)', higherIsBetter: true, values: allCalculatedStats.map(s => s.frp.pair) },
                { label: '初重複試合番号 (グループ)', higherIsBetter: true, values: allCalculatedStats.map(s => s.frp.group) },
                { label: 'ペア相手数の分布', higherIsBetter: true, format: v => v ? `${v.min}/${v.avg.toFixed(1)}/${v.max}` : 'N/A', values: allCalculatedStats.map(s => s.partnerStats) }
            ];

            function renderCompareTableBody(showOnlyDiffs) {
                let tableRowsHtml = '';
                metrics.forEach(m => {
                    let isDifferent = false;
                    if (m.values.length > 1) {
                        const firstVal = m.values[0];
                        isDifferent = m.values.slice(1).some(val => {
                            if (typeof firstVal === 'object' && firstVal !== null) return JSON.stringify(firstVal) !== JSON.stringify(val);
                            if (typeof firstVal === 'number' && typeof val === 'number') return !areNumbersEffectivelyEqual(firstVal, val);
                            return firstVal !== val;
                        });
                    }

                    if (showOnlyDiffs && !isDifferent) return;

                    let cellsHtml = '';
                    m.values.forEach(val => {
                        const formattedVal = m.format ? m.format(val) : (val ?? 'N/A');
                        const winnerClass = getWinnerClass(m.higherIsBetter, val, m.values);
                        const textAlignClass = typeof val === 'object' || (m.label && m.label.includes('公平性')) ? 'text-left' : 'text-center';
                        cellsHtml += `<td class="p-2 border ${textAlignClass} ${winnerClass}">${formattedVal}</td>`;
                    });

                    tableRowsHtml += `<tr><td class="p-2 border font-semibold bg-gray-50">${m.label}</td>${cellsHtml}</tr>`;
                });
                const tbody = document.getElementById('compareTableBody');
                if (tbody) tbody.innerHTML = tableRowsHtml;
            }

            const nameListHtml = selectedFavorites.map((fav, i) => `<p class="truncate"><strong>比較${i + 1}:</strong> ${fav.name}</p>`).join('');
            const tableHeadersHtml = selectedFavorites.map((_, i) => `<th class="p-2 border">比較${i + 1}</th>`).join('');

            const dialogContent = `
                <div class="text-sm space-y-3">
                    <div class="space-y-1 text-xs bg-gray-50 p-2 rounded-md border">${nameListHtml}</div>
                    <div class="flex items-center justify-end">
                        <input type="checkbox" id="compareDiffOnly" class="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500">
                        <label for="compareDiffOnly" class="ml-2 text-xs text-gray-600 cursor-pointer">差がある項目のみ表示</label>
                    </div>
                    <div>
                        <p class="mb-2 text-xs text-gray-500">※ 緑色の背景は、その指標でより優れている項目を示します。</p>
                        <div class="overflow-x-auto">
                            <table class="w-full border-collapse" style="min-width: 500px;">
                                <thead class="bg-gray-100"><tr><th class="p-2 border w-auto">評価指標</th>${tableHeadersHtml}</tr></thead>
                                <tbody id="compareTableBody"></tbody>
                            </table>
                        </div>
                    </div>
                </div>`;

            showDialog('お気に入り比較', null, null, dialogContent);
            const dialogPanel = dom.customDialog.querySelector('.relative');
            if (dialogPanel) {
                dialogPanel.classList.remove('md:w-1/2', 'lg:w-1/3');
                dialogPanel.classList.add('md:w-4/5', 'lg:w-3/4', 'xl:max-w-6xl');
            }

            renderCompareTableBody(false);
            const diffCheckbox = document.getElementById('compareDiffOnly');
            if (diffCheckbox) {
                diffCheckbox.addEventListener('change', (e) => {
                    renderCompareTableBody(e.target.checked);
                });
            }
        }


        //ダブルス組合せてみっかv4.6t2.html ベース
    