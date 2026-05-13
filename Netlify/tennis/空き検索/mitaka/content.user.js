// ==UserScript==
// @name         三鷹テニス自動予約 (UX改善版 v3.1)
// @match        https://www.yoyaku.mitaka.site/*
// @description  クイックフィルタパネル対応・日付/曜日/テキストフィルタ追加・施設複数選択対応
// @run-at       document-idle
// @updateURL    https://egmassa.github.io/koukai/Netlify/tennis/空き検索/mitaka/content.user.js
// @downloadURL  https://egmassa.github.io/koukai/Netlify/tennis/空き検索/mitaka/content.user.js
// @version      3.1   
// ==/UserScript==

(function() {
    'use strict';
    console.log('テニスコートチェッカー: 起動（UX改善版 v3.1）');

    // ========================================
    // クイックフィルタ用グローバル変数
    // ========================================
    let lastSearchResults = null;
    let lastSearchTimestamp = null;
    let lastSearchScope = null;
    let lastSearchTimeFilter = 'all'; // 検索時の時間帯設定
    let currentQuickFilters = {
        timeFilter: 'all',
        facilityFilter: [],    // 複数選択対応
        dateFilter: [],        // 日付フィルタ（例: ['2/10', '2/11']）
        dayOfWeekFilter: [],   // 曜日フィルタ（例: ['月', '水', '金']）
        textFilter: ''         // テキストフィルタ（時刻や詳細で検索）
    };

    // ========================================
    // 設定・定数
    // ========================================
    const DEFAULT_SETTINGS = {
        notificationEnabled: true,
        soundEnabled: true,
        autoRunEnabled: false, // ★ここをtrueにすれば初期値ON
        autoRunInterval: 15,
        timeFilter: 'all',
        searchWeeks: 4, // ★ここを追加（デフォルト4週間）
// content.js 20行目付近を修正
facilities: [
            { name: '第一中学校', priority: 1, enabled: true },
            { name: '第二中学校', priority: 2, enabled: true },
            { name: '第四中学校', priority: 3, enabled: true },
            { name: '第六中学校', priority: 4, enabled: true },
            { name: '第七中学校', priority: 5, enabled: true },
            { name: '大沢野川グラウンド', priority: 6, enabled: true },
            { name: '新川テニスコート', priority: 7, enabled: true },
            { name: '大沢総合グラウンド', priority: 8, enabled: true } // ★ここを追加
        ],
        statisticsEnabled: true,
        statisticsRetentionDays: 90,
        iftttEnabled: false,
        iftttWebhookKey: '',
        iftttEventName: 'mitaka_tennis'
    };

// 関数単位での置換用: debugLog (2つある定義をこれ1つに統合してください)
let logBuffer = [];
setInterval(() => {
    if (logBuffer.length > 0) {
        StorageHelper.get(['debugLogs']).then(data => {
            const current = data.debugLogs || [];
            // 最新1000件程度に保つ（例）
            const nextLogs = [...current, ...logBuffer].slice(-1000);
            StorageHelper.set({ debugLogs: nextLogs });
            logBuffer = [];
        });
    }
}, 5000);

async function debugLog(message) {
    const time = new Date().toLocaleTimeString('ja-JP');
    const logMessage = `[${time}] ${message}`;
    logBuffer.push(logMessage);
    console.log(logMessage);
}

    // 初期化
    setTimeout(initialize, 800);

    // 常駐監視
    setInterval(() => {
        if (!document.getElementById('mitaka-panel')) createControlPanel();
    }, 1000);

    // 自動実行監視
    let autoRunTimer = null;
    let lastAutoRunSettings = null;
    
    async function checkAutoRun() {
        const settings = await loadSettings();
        const currentSettings = JSON.stringify({
            enabled: settings.autoRunEnabled,
            interval: settings.autoRunInterval
        });
        
        if (currentSettings !== lastAutoRunSettings) {
            lastAutoRunSettings = currentSettings;
            
            if (settings.autoRunEnabled && !autoRunTimer) {
                await debugLog('自動実行: 有効化されました');
                startAutoRun();
            } else if (!settings.autoRunEnabled && autoRunTimer) {
                await debugLog('自動実行: 無効化されました');
                stopAutoRun();
            } else if (settings.autoRunEnabled && autoRunTimer) {
                await debugLog('自動実行: 間隔変更を検出');
                stopAutoRun();
                startAutoRun();
            }
        }
    }
// 設定キャッシュ


// 設定変更時だけ反応するように変更
setInterval(async () => {
    const settings = await loadSettings();
    const current = JSON.stringify({
        enabled: settings.autoRunEnabled,
        interval: settings.autoRunInterval
    });

    if (current !== lastAutoRunSettings) {
        lastAutoRunSettings = current;
        if (settings.autoRunEnabled) startAutoRun();
        else stopAutoRun();
    }
}, 8000); // ← 5秒 → 8秒に緩和（負荷軽減）


    // ESCキー停止
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            stopAll();
            alert('緊急停止しました。');
        }
    });

    // ========================================
    // ヘルパー関数群
    // ========================================

    const isMobile = () => {
        const ua = navigator.userAgent.toLowerCase();
        return (ua.indexOf('iphone') > -1 || ua.indexOf('android') > -1 || ua.indexOf('mobile') > -1);
    };

    const getScale = () => {
        if (!isMobile()) return 1;
        const width = window.innerWidth;
        let ratio = width / 375;
        if (ratio < 1) ratio = 1;
        return ratio;
    };

    const formatTime = (timestamp, includeSeconds = false) => {
        if (!timestamp) return '';
        const d = new Date(timestamp);
        const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        if (includeSeconds) {
            return `${d.getMonth() + 1}/${d.getDate()} ${time}:${String(d.getSeconds()).padStart(2, '0')}`;
        }
        return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
    };

    function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

    const StorageHelper = {
        get: (keys) => new Promise(resolve => {
            let result = {};
            (Array.isArray(keys) ? keys : [keys]).forEach(k => {
                const val = localStorage.getItem('mitaka_' + k);
                try { result[k] = val ? JSON.parse(val) : undefined; } catch (e) { result[k] = val; }
            });
            resolve(result);
        }),
        set: (items) => new Promise(resolve => {
            for (const [k, v] of Object.entries(items)) localStorage.setItem('mitaka_' + k, JSON.stringify(v));
            resolve();
        })
    };


// ========================================
// 設定ロード機能（重複定義を統合・修正版）
// ※既存の loadSettings 関数と let cachedSettings = ... は全て削除して、これに置き換えてください
// ========================================
let cachedSettings = null;

async function loadSettings() {
    if (cachedSettings) return cachedSettings;
    const data = await StorageHelper.get(['settings']);
    const savedSettings = data.settings || {};

    let mergedFacilities = [...DEFAULT_SETTINGS.facilities];
    if (savedSettings.facilities) {
        mergedFacilities = DEFAULT_SETTINGS.facilities.map(defF => {
            const savedF = savedSettings.facilities.find(sf => sf.name === defF.name);
            return savedF ? savedF : defF;
        });
    }

    cachedSettings = { ...DEFAULT_SETTINGS, ...savedSettings, facilities: mergedFacilities };
    return cachedSettings;
}
    async function saveSettings(settings) {
        await StorageHelper.set({ settings });
        await debugLog('設定を保存しました');
    }

    // ========================================
    // 通知機能
    // ========================================
    async function requestNotificationPermission() {
        if (!('Notification' in window)) return false;
        if (Notification.permission === 'default') {
            const permission = await Notification.requestPermission();
            return permission === 'granted';
        }
        return Notification.permission === 'granted';
    }

    async function sendIFTTTNotification(title, body) {
        const settings = await loadSettings();
        if (!settings.iftttEnabled || !settings.iftttWebhookKey) return;

        try {
            const url = `https://maker.ifttt.com/trigger/${settings.iftttEventName}/with/key/${settings.iftttWebhookKey}`;
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    value1: title,
                    value2: body,
                    value3: new Date().toLocaleString('ja-JP')
                })
            });
            await debugLog('IFTTT通知送信成功');
        } catch (error) {
            await debugLog(`IFTTT通知エラー: ${error.message}`);
        }
    }

    async function sendNotification(title, body, isSuccess = true) {
        const settings = await loadSettings();
        
        if (settings.iftttEnabled) await sendIFTTTNotification(title, body);
        if (!settings.notificationEnabled) return;
        if (Notification.permission !== 'granted') return;

        try {
            const notification = new Notification(title, {
                body: body,
                requireInteraction: true,
                silent: !settings.soundEnabled
            });
            notification.onclick = () => { window.focus(); notification.close(); };
            await debugLog(`通知送信: ${title}`);
        } catch (e) {
            await debugLog(`通知エラー: ${e.message}`);
        }
    }

    // ========================================
    // 時間帯フィルター
    // ========================================
    function matchesTimeFilter(details, filter) {
        if (filter === 'all') return true;
        const detailsLower = details.toLowerCase();
        switch(filter) {
            case 'morning': return detailsLower.includes('午前') || /0[6-9]:|1[0-1]:/.test(details);
            case 'afternoon': return detailsLower.includes('午後') || /1[2-7]:/.test(details);
            case 'evening': return detailsLower.includes('夜間') || /1[8-9]:|2[0-2]:/.test(details);
            default: return true;
        }
    }

    function filterResultsByTime(results, timeFilter) {
        if (timeFilter === 'all') return results;
        const filtered = {};
        for (const [facility, slots] of Object.entries(results)) {
            const filteredSlots = slots.filter(slot => matchesTimeFilter(slot.details, timeFilter));
            if (filteredSlots.length > 0) filtered[facility] = filteredSlots;
        }
        return filtered;
    }

    // ========================================
    // 自動定期実行
    // ========================================
    async function startAutoRun() {
        const settings = await loadSettings();
        if (!settings.autoRunEnabled) return;
        
        await debugLog(`自動実行開始: ${settings.autoRunInterval}分間隔`);
        updateStatus(`⏰ 自動実行ON (${settings.autoRunInterval}分間隔)`, 'blue');
        
        let isPageVisible = !document.hidden;
let lastStatusMsg = '';

function safeUpdateStatus(msg, color) {
    if (msg !== lastStatusMsg) {
        updateStatus(msg, color);
        lastStatusMsg = msg;
    }
}

document.addEventListener('visibilitychange', async () => {
    const settings = await loadSettings();
    isPageVisible = !document.hidden;

    if (!isPageVisible) {
        safeUpdateStatus('⚠️ 画面オフ: 自動実行一時停止', 'orange');
    } else {
        safeUpdateStatus(`⏰ 自動実行ON (${settings.autoRunInterval}分間隔)`, 'blue');
    }
});

        
        const runCheck = async () => {
            if (!isPageVisible) return;
            const data = await StorageHelper.get(['isRunning']);
            if (data.isRunning) return;
            
            await debugLog('自動実行: チェック開始');
            await StorageHelper.set({ isNavigating: true, autoCheckAfterNav: true, isRunning: false });
            resetAndStart();
        };
        
        autoRunTimer = setInterval(runCheck, settings.autoRunInterval * 60 * 1000);
    }

    function stopAutoRun() {
        if (autoRunTimer) {
            clearInterval(autoRunTimer);
            autoRunTimer = null;
            debugLog('自動実行停止');
            updateStatus('🤖 待機中', 'black');
        }
    }

// ========================================
// 統計記録（高速化版：localStorageアクセス削減）
// ========================================
async function recordStatistics(results) {
    const settings = await loadSettings();
    if (!settings.statisticsEnabled) return;

    // 既存データの読み込み（1回だけ）
    const data = await StorageHelper.get(['statistics']);
    const stats = data.statistics || [];
    const now = Date.now();

    // 曜日ごとの件数集計
    const dayOfWeekCounts = { '月': 0, '火': 0, '水': 0, '木': 0, '金': 0, '土': 0, '日': 0 };

    for (const [facility, slots] of Object.entries(results)) {
        for (const slot of slots) {
            const match = slot.date.match(/[（\()](.)[）\)]/);
            if (match && dayOfWeekCounts[match[1]] !== undefined) {
                dayOfWeekCounts[match[1]]++;
            }
        }
    }

    const record = {
        timestamp: now,
        date: new Date(now).toISOString().split('T')[0],
        facilityCount: Object.keys(results).length,
        totalSlots: Object.values(results).reduce((sum, slots) => sum + slots.length, 0),
        facilities: {},
        dayOfWeekStats: dayOfWeekCounts
    };

    for (const [facility, slots] of Object.entries(results)) {
        record.facilities[facility] = slots.length;
    }

    stats.push(record);

    // 古いデータの削除
    const cutoffTime = now - (settings.statisticsRetentionDays * 24 * 60 * 60 * 1000);
    const filteredStats = stats.filter(s => s.timestamp > cutoffTime);

    // 書き込みは1回だけ
    await StorageHelper.set({ statistics: filteredStats });
    await debugLog(`統計記録完了: ${record.totalSlots}件 (内訳保存済み)`);
}

// ========================================
// 統計集計（高速化版）
// ========================================
async function getStatisticsSummary() {
    const data = await StorageHelper.get(['statistics']);
    const stats = data.statistics || [];
    if (stats.length === 0) return null;

    const summary = {
        totalChecks: stats.length,
        averageSlots: 0,
        maxSlots: 0,
        minSlots: Infinity,
        facilityStats: {},
        dailyTrends: {}
    };

    const days = ['月', '火', '水', '木', '金', '土', '日'];
    for (const d of days) summary.dailyTrends[d] = { count: stats.length, total: 0 };

    let totalSlots = 0;

    for (const record of stats) {
        totalSlots += record.totalSlots;
        summary.maxSlots = Math.max(summary.maxSlots, record.totalSlots);
        summary.minSlots = Math.min(summary.minSlots, record.totalSlots);

        // 施設別
        for (const [facility, count] of Object.entries(record.facilities)) {
            if (!summary.facilityStats[facility]) {
                summary.facilityStats[facility] = { count: 0, total: 0 };
            }
            summary.facilityStats[facility].count++;
            summary.facilityStats[facility].total += count;
        }

        // 曜日別
        if (record.dayOfWeekStats) {
            for (const day in record.dayOfWeekStats) {
                summary.dailyTrends[day].total += record.dayOfWeekStats[day];
            }
        } else {
            const execDay = ['日', '月', '火', '水', '木', '金', '土'][new Date(record.timestamp).getDay()];
            summary.dailyTrends[execDay].total += record.totalSlots;
        }
    }

    summary.averageSlots = totalSlots / stats.length;
    return summary;
}

// ========================================
// UI操作（軽量化）
// ========================================
function updatePanelState(isRunning) {
    const btns = document.querySelectorAll('.mitaka-ctrl-btn');
    const stopBtn = document.getElementById('mitaka-stop-btn');

    if (isRunning) {
        btns.forEach(b => { if (b.id !== 'mitaka-stop-btn') b.style.display = 'none'; });
        if (stopBtn) {
            stopBtn.style.display = 'block';
            if (isMobile()) stopBtn.style.gridColumn = "1 / -1";
        }
    } else {
        btns.forEach(b => { if (b.id !== 'mitaka-stop-btn') b.style.display = 'block'; });
        if (stopBtn) stopBtn.style.display = 'none';
    }
}

function updateStatus(text, color = 'black') {
    const header = document.getElementById('mitaka-header');
    if (header) {
        header.innerText = text;
        header.style.color = color;
    }
    console.log(`[Status] ${text}`);
}

// ========================================
// ページ遷移（軽量化）
// ========================================
async function resetAndStart() {
    updatePanelState(true);
    updateStatus('トップページへ戻ります...', 'orange');
    window.location.href = 'https://www.yoyaku.mitaka.site/reservations';
}

// ========================================
// 通知音（軽量化）
// ========================================
const playNotificationSound = async (isSuccess) => {
    const settings = await loadSettings();
    if (!settings.soundEnabled) return;

    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;

        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.connect(gain);
        gain.connect(ctx.destination);

        if (isSuccess) {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(880, ctx.currentTime);
            osc.frequency.setValueAtTime(1760, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
            osc.start();
            osc.stop(ctx.currentTime + 0.5);
        }
    } catch (e) {
        console.log('Audio error:', e);
    }
};

// ========================================
// ドラッグ処理（そのまま高速）
// ========================================
function enableDrag(elmnt, handle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    handle.onmousedown = dragStart;
    handle.ontouchstart = dragStart;

    function dragStart(e) {
        const clientX = e.clientX || (e.touches ? e.touches[0].clientX : 0);
        const clientY = e.clientY || (e.touches ? e.touches[0].clientY : 0);
        pos3 = clientX; pos4 = clientY;
        document.onmouseup = closeDragElement;
        document.onmousemove = elementDrag;
        document.ontouchend = closeDragElement;
        document.ontouchmove = elementDrag;
    }

    function elementDrag(e) {
        if (e.type === 'touchmove') e.preventDefault();
        const clientX = e.clientX || (e.touches ? e.touches[0].clientX : 0);
        const clientY = e.clientY || (e.touches ? e.touches[0].clientY : 0);
        pos1 = pos3 - clientX; pos2 = pos4 - clientY;
        pos3 = clientX; pos4 = clientY;
        elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
        elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
        elmnt.style.bottom = "auto";
        elmnt.style.right = "auto";
    }

    function closeDragElement() {
        document.onmouseup = null;
        document.onmousemove = null;
        document.ontouchend = null;
        document.ontouchmove = null;
    }
}

// ========================================
// ラベル検索・リンククリック（軽量化）
// ========================================
function findLabelByText(text) {
    return Array.from(document.querySelectorAll('label'))
        .find(l => (l.textContent || '').replace(/\s/g, '').includes(text));
}

async function clickLinkByText(text) {
    let target = Array.from(document.querySelectorAll('a'))
        .find(el => (el.textContent || '').replace(/\s/g, '').includes(text));

    if (!target) {
        target = Array.from(document.querySelectorAll('input[type="button"], button'))
            .find(el => (el.value || el.textContent || '').replace(/\s/g, '').includes(text));
    }

    if (target) {
        target.style.outline = "3px solid red";
        target.click();
        return true;
    }
    return false;
}


// ========================================
// チェックボックス操作（高速化）
// ========================================
function getInputChecked(labelElement) {
    if (!labelElement) return false;
    const input = labelElement.querySelector('input[type="checkbox"]');
    return input?.checked ?? false;
}

async function ensureChecked(element) {
    if (getInputChecked(element)) return;

    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.style.outline = "4px solid red";

    // クリック試行を最小限に
    for (let i = 0; i < 2; i++) {
        element.click();
        await wait(200);
        if (getInputChecked(element)) return;

        const icon = element.querySelector('.po-checkbox, span');
        if (icon) {
            icon.click();
            await wait(200);
            if (getInputChecked(element)) return;
        }
    }
}

// ========================================
// ページ遷移ロジック（高速化）
// ========================================
async function tryClickNextPage() {
    // 1. クラス指定のボタン
    const classTarget = document.querySelector('.po-pagenator-bt-front');
    if (classTarget) {
        const text = (classTarget.textContent || '').trim();
        const title = classTarget.getAttribute('title') || '';

        if (!text.includes('前') && !text.includes('戻') && !title.includes('前')) {
            await debugLog(`次ページボタン発見(Class): [${text}]`);
            classTarget.style.outline = "3px solid orange";
            classTarget.scrollIntoView({ behavior: "smooth", block: "center" });
            classTarget.click();
            return true;
        }
    }

    // 2. title 属性で探す
    const titleTarget = document.querySelector(
        'a[title="次の期間"], a[title="次週"], a[title="次の週"]'
    );
    if (titleTarget) {
        await debugLog(`次ページボタン発見(Title): [${titleTarget.title}]`);
        titleTarget.style.outline = "3px solid orange";
        titleTarget.scrollIntoView({ behavior: "smooth", block: "center" });
        titleTarget.click();
        return true;
    }

    // 3. テキストで探す（高速化）
    const textTarget = [...document.querySelectorAll('a, button')].find(el => {
        const t = (el.textContent || el.value || '').trim();
        if (t.includes('前') || t.includes('戻') || t.includes('<')) return false;
        return ['次の期間', '次週', '次へ', '>'].includes(t) || t.includes('次の期間');
    });

    if (textTarget) {
        await debugLog(`次ページボタン発見(Text): [${textTarget.textContent}]`);
        textTarget.style.outline = "3px solid orange";
        textTarget.scrollIntoView({ behavior: "smooth", block: "center" });
        textTarget.click();
        return true;
    }

    await debugLog('❌ 次ページボタンが見つかりませんでした');
    return false;
}

function clickNextButton() {
    const btn = document.querySelector('.po-bt-forward');
    if (btn) btn.click();
}
// ========================================
// メインロジック（initialize / stopAll）
// ========================================
async function initialize() {
    createControlPanel();

    const data = await StorageHelper.get([
        'isRunning', 'isNavigating', 'autoCheckAfterNav', 'searchPhase'
    ]);

    const url = window.location.href;

    // --- 実行中（データ収集中） ---
    if (data.isRunning) {
        updatePanelState(true);
        updateStatus('データ収集中...', 'blue');
        setTimeout(executeCollection, 1200); // 少し短縮
        return;
    }

    // --- ナビゲーション中 ---
    if (data.isNavigating) {
        updatePanelState(true);

        // 目的地に到着（rooms or table）
        if (url.includes('/rooms') || document.querySelector('table')) {
            if (data.autoCheckAfterNav) {
                const phaseName = data.searchPhase === 2 ? '大沢総合' : '中学等';
                updateStatus(`${phaseName}チェック開始...`, 'green');

                const settings = await loadSettings();

                await StorageHelper.set({
                    isNavigating: false,
                    isRunning: true,
                    autoCheckAfterNav: true,
                    currentWeek: 0,
                    maxWeeks: settings.searchWeeks,
                    results: {}
                });

                setTimeout(executeCollection, 800);
            } else {
                await StorageHelper.set({ isNavigating: false });
                updateStatus('目的地に到着しました', 'green');
                updatePanelState(false);
            }
        } else {
            setTimeout(executeNavigation, 800);
        }
    }
}

async function stopAll() {
    await StorageHelper.set({
        isRunning: false,
        isNavigating: false,
        autoCheckAfterNav: false
    });

    updateStatus('停止しました', 'red');
    updatePanelState(false);
    stopAutoRun();
}

// ========================================
// executeNavigation（高速化版）
// ========================================
async function executeNavigation() {
    await debugLog('=== executeNavigation開始 ===');

    const settings = await loadSettings();
    const data = await StorageHelper.get(['searchPhase']);
    const phase = data.searchPhase || 1;

    const url = window.location.href;
    const TARGET_NAMES = settings.facilities
        .filter(f => f.enabled)
        .map(f => f.name);

    // ---------------------------------------------------------
    // 1. トップページ（施設リスト画面）
    // ---------------------------------------------------------
    if (url.endsWith('/reservations') || url.endsWith('/reservations/')) {

        // --- フェーズ1：中学ルート ---
        if (phase === 1) {
            updateStatus('中学ルート：目的から探す', 'blue');

            const link = [...document.querySelectorAll('a')]
                .find(el => el.textContent.includes('使用目的から探す'));

            if (link) {
                await wait(300);
                link.click();
            } else {
                updateStatus('「使用目的から探す」が見つかりません', 'red');
            }
            return;
        }

        // --- フェーズ2：大沢総合ルート ---
        if (phase === 2) {
            updateStatus('大沢ルート：施設を選択して次へ', 'orange');

            const labels = [...document.querySelectorAll('label')];
            const targetLabel = labels.find(l => l.textContent.includes('大沢総合グラウンド'));

            if (targetLabel) {
                const checkbox = targetLabel.querySelector('input[type="checkbox"]');
                if (checkbox && !checkbox.checked) {
                    updateStatus('大沢総合グラウンドをチェックします');
                    targetLabel.click();
                    await wait(300);
                }
            } else {
                updateStatus('大沢総合が見つかりません。ページをめくります...', 'red');
                await tryClickNextPage();
                return;
            }

            // 次へボタン探索（高速化）
            updateStatus('「次へ」ボタンを探しています...');

            const nextBtn = [...document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')]
                .find(el => {
                    const t = (el.textContent || el.value || '').trim();
                    return (t.includes('次へ') || t.includes('Next')) && el.offsetParent !== null;
                });

            if (nextBtn) {
                updateStatus('次へ進みます！', 'green');
                await debugLog(`Clicking button: ${nextBtn.textContent}`);
                nextBtn.click();
            } else {
                updateStatus('❌「次へ」ボタンが見つかりません', 'red');
                const fallbackBtn = document.querySelector('.po-pageflow-bt-booking-top button');
                if (fallbackBtn) fallbackBtn.click();
            }
            return;
        }
    }

    // ---------------------------------------------------------
    // 2. 目的選択（フェーズ1）
    // ---------------------------------------------------------
    if (url.includes('/purposes') && phase === 1) {
        updateStatus('目的選択：屋外スポーツ');
        await clickLinkByText('屋外スポーツ');
        return;
    }

    // ---------------------------------------------------------
    // 3. 種目選択（フェーズ1）
    // ---------------------------------------------------------
    if ((url.includes('/subpurposes') || url.includes('/events') || url.includes('/commodities')) && phase === 1) {
        updateStatus('種目選択：硬式テニス');

        const target = findLabelByText('硬式テニス');
        if (target) {
            if (!getInputChecked(target)) await ensureChecked(target);
            await wait(200);
            clickNextButton();
        }
        return;
    }

    // ---------------------------------------------------------
    // 4. 施設選択（フェーズ1：中学）
    // ---------------------------------------------------------
    if (url.includes('/facilities')) {
        updateStatus('施設を選択中(中学)...');

        const labels = [...document.querySelectorAll('label')];
        let foundCount = 0;

        for (const label of labels) {
            const text = label.textContent.trim();

            if (TARGET_NAMES.some(name => text.includes(name) && !name.includes('大沢総合'))) {
                if (!getInputChecked(label)) {
                    await ensureChecked(label);
                    await wait(150);
                }
                foundCount++;
            }
        }

        if (foundCount > 0 || document.querySelectorAll('input:checked').length > 0) {
            clickNextButton();
        } else {
            await tryClickNextPage();
        }
        return;
    }

    // ---------------------------------------------------------
    // 5. 条件確認（時間帯指定）
    // ---------------------------------------------------------
    if (url.includes('/dates') || url.includes('/search_dates')) {
        updateStatus('条件を適用中...', 'orange');

        const timeFilter = settings.timeFilter;
        const dts = [...document.querySelectorAll('dt')];
        const timeDt = dts.find(el => el.textContent.includes('表示時間帯'));

        if (timeDt?.nextElementSibling?.tagName === 'DD') {
            const timeDd = timeDt.nextElementSibling;
            const checkBoxes = [...timeDd.querySelectorAll('input[type="checkbox"]')];

            let changed = false;

            const targetKeywords =
                timeFilter === 'all'
                    ? ['全て', '午前', '午後', '夜間']
                    : timeFilter === 'morning'
                    ? ['午前']
                    : timeFilter === 'afternoon'
                    ? ['午後']
                    : ['夜間'];

            for (const input of checkBoxes) {
                const label = input.closest('label');
                if (!label) continue;

                const labelText = label.textContent.trim();
                const shouldBeChecked = targetKeywords.some(kw => labelText.includes(kw));

                if (shouldBeChecked !== input.checked) {
                    label.click();
                    await wait(150);
                    changed = true;
                }
            }

            if (changed) await wait(300);
        } else {
            await debugLog('⚠️ 「表示時間帯」エリアが見つかりませんでした');
        }

        clickNextButton();
        return;
    }
}
async function executeCollection() {
    console.log('%c[DEBUG] executeCollection 開始（ボタン探索強化版）', 'color: white; background: green; font-weight: bold;');

    const data = await StorageHelper.get(['isRunning']);
    if (!data.isRunning) return;

    const settings = await loadSettings();
    const maxWeeks = settings.searchWeeks || 4;

    const stored = await StorageHelper.get(['currentWeek', 'results']);
    let currentWeek = stored.currentWeek ?? 0;
    let results = stored.results || {};

    console.log(`📅 週次処理: ${currentWeek + 1}週目/${maxWeeks}週`);

    // --- 日付ヘッダーの取得と範囲保存 ---
    const dateHeaders = [...document.querySelectorAll('th')]
        .map(th => th.innerText.trim().replace(/\s/g, ''))
        .filter(t => /\d/.test(t) && (t.includes('/') || t.includes('月')));

    if (dateHeaders.length > 0) {
        const pageStart = dateHeaders[0];
        const pageEnd = dateHeaders[dateHeaders.length - 1];

        const rangeData = await StorageHelper.get(['searchRange']);
        let range = rangeData.searchRange || { start: null, end: null };

        if (currentWeek === 0) {
            range.start = pageStart;
            range.end = pageEnd;
        } else {
            range.end = pageEnd;
        }

        await StorageHelper.set({ searchRange: range });
    }

    // --- 1. 現在ページをスクレイピング ---
    const pageResults = scrapePage(results);
    results = pageResults;

    const totalSlots = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
    updateStatus(`${currentWeek + 1}週目完了 (有効:${totalSlots})`, 'blue');

    await StorageHelper.set({ 
        results,
        currentWeek: currentWeek + 1
    });

    // --- 2. 最終週なら finish() ---
    if (currentWeek + 1 >= maxWeeks) {
        console.log('[DEBUG] 全週の収集が完了 → finish へ');
        await finish(results, {}, true);
        return;
    }

    // --- 3. 次週へ（強化されたボタン探索） ---
    console.log(`[DEBUG] 次の週へ移動: ${currentWeek + 2} / ${maxWeeks}`);
    updateStatus(`次週へ... (${currentWeek + 2}/${maxWeeks})`, 'blue');
    await wait(800);

    // ボタン探索ロジックの強化（tryClickNextPageと同様のロジックを適用）
    let nextBtn = document.querySelector('.po-forward'); // 既存のクラス
    
    if (!nextBtn) {
        // 見つからない場合、テキストやTitle属性で広範囲に探す
        nextBtn = [...document.querySelectorAll('a, button, input[type="button"]')].find(el => {
            const t = (el.textContent || el.value || '').trim();
            const title = el.getAttribute('title') || '';
            // "次週", "次の期間", ">", "Next" などを判定
            return t.includes('次週') || t.includes('次の期間') || t === '>' || t === '次へ' || title.includes('次週') || title.includes('次の期間');
        });
    }

    if (nextBtn) {
        console.log('[DEBUG] 次週ボタンをクリックします:', nextBtn);
        nextBtn.click();
    } else {
        console.warn('[DEBUG] ⚠️ 次週ボタンが見つからないため、ここで終了します');
        await finish(results, {}, false);
    }
}

/**
 * 置換対象: finish 関数 (統計・保存・表示ロジック修正版)
 */
async function finish(results, excludedResults = {}, isFinal = false) {
    console.log('%c[DEBUG] finish 開始（不整合修正版）', 'color: white; background: #444; font-weight: bold;');

    const now = Date.now();
    const settings = await loadSettings();

    // --- フェーズ管理データの取得 ---
    const data = await StorageHelper.get([
        'searchPhase', 'tempResults', 'tempExcludedResults', 'executionMode', 
        'autoCheckAfterNav', 'searchRange'
    ]);

    const phase = data.searchPhase || 1;
    const mode = data.executionMode;
    const autoCheckAfterNav = data.autoCheckAfterNav;
    const tempResults = data.tempResults || {};
    const tempExcluded = data.tempExcludedResults || {};

    // --- 大沢総合への遷移判定 ---
    const isCheckOnly = (mode === 'check') || (!autoCheckAfterNav);
    const isOsawaEnabled = settings.facilities.some(f => f.name.includes('大沢総合グラウンド') && f.enabled);
    const shouldProceedToPhase2 = (phase === 1 && !isCheckOnly && isOsawaEnabled);

    if (shouldProceedToPhase2) {
        updateStatus('中学分を保存。次は大沢総合へ...', 'orange');
        const rangeData = await StorageHelper.get(['searchRange']);
        await StorageHelper.set({
            tempResults: results,
            tempExcludedResults: excludedResults,
            searchPhase: 2,
            isNavigating: true,
            autoCheckAfterNav: true,
            isRunning: false,
            currentWeek: 0
        });
        await wait(1200);
        window.location.href = 'https://www.yoyaku.mitaka.site/reservations';
        return;
    }

    // --- 結果統合 ---
    const mergedResults = { ...tempResults, ...results };
    
    // --- 1. 統計記録の実行 (引数修正) ---
    // v3.1の recordStatistics は mergedResults を直接受け取る仕様
    await recordStatistics(mergedResults);

    // --- 2. 前回結果とのマージ（新規判定） ---
    const prev = await StorageHelper.get(['lastResults', 'lastTimestamp']);
    const prevResults = prev.lastResults || {};
    const prevTimestamp = prev.lastTimestamp || 0;

    for (const [fac, slots] of Object.entries(mergedResults)) {
        slots.forEach(s => {
            const prevSlots = prevResults[fac] || [];
            const old = prevSlots.find(p => p.date === s.date && p.details === s.details);
            if (!old) {
                s.isNew = true;
                s.firstFound = now;
            } else {
                s.isNew = false;
                s.firstFound = old.firstFound || prevTimestamp;
            }
        });
    }

    // --- 3. データの保存 ---
    const rangeData = await StorageHelper.get(['searchRange']);
    const range = rangeData.searchRange || { start: '?', end: '?' };
    const rangeStr = `${range.start}〜${range.end}`;

    await StorageHelper.set({
        lastResults: mergedResults,
        lastTimestamp: now,
        lastSearchRange: rangeStr,
        lastTimeFilter: settings.timeFilter,
        isRunning: false,
        searchPhase: 1,
        tempResults: {},
        tempExcludedResults: {},
        isNavigating: false,
        autoCheckAfterNav: false
    });

    // --- 4. モーダルの表示 (不整合回避) ---
    updateStatus('完了', 'green');
    updatePanelState(false);
    
    // showResultsModalを確実に呼び出す
    setTimeout(() => {
        showResultsModal(mergedResults, now, '自動検索');
    }, 500);
}


// ========================================
// scrapePage（高速化・DOMアクセス削減版）
// ========================================
function scrapePage(existingResults, currentScope) {
    const tables = document.querySelectorAll('table');
    const now = Date.now();
    const results = existingResults || {};

    tables.forEach((table, tableIndex) => {
        console.log(`[scrapePage] テーブル ${tableIndex + 1} を処理中`);

        const rows = [...table.querySelectorAll('tr')];
        let dateHeaders = [];
        let parentName = '';

        for (const row of rows) {
            const ths = row.querySelectorAll('th');
            const tds = row.querySelectorAll('td');

            // -------------------------------
            // 1. 日付ヘッダー行の処理
            // -------------------------------
            if (ths.length > 1) {
                const txts = [...ths].map(t =>
                    t.textContent.trim().replace(/\s/g, '')
                );

                if (txts.some(t => /\d/.test(t))) {
                    dateHeaders = txts;

                    // 先頭が施設名の場合
                    if (txts[0] && !/\d/.test(txts[0])) {
                        parentName = txts[0];
                    }
                }
                continue;
            }

            // -------------------------------
            // 2. データ行の処理
            // -------------------------------
            if (tds.length === 0) continue;

            const rowHeader = row.querySelector('th');
            if (!rowHeader) continue;

            const rowName = rowHeader.textContent.trim();

            // 大沢総合の複合施設対策
            if (parentName.includes('大沢総合グラウンド')) {
                if (!rowName.includes('テニスコート')) continue;
            }

            // 施設名の決定
            let fullName = parentName;
            if (parentName !== rowName && rowName !== '') {
                const cleanRowName = rowName.split('\n')[0].trim();
                fullName = `${parentName} (${cleanRowName})`;
            }

            if (!results[fullName]) results[fullName] = [];

            // -------------------------------
            // 3. 各セルの処理
            // -------------------------------
            [...tds].forEach((td, i) => {
                const date = dateHeaders[i + 1];
                if (!date) return;

                const circle = td.querySelector('.po-icon-circle');
                const triangle = td.querySelector('.po-icon-triangle');
                const icon = circle || triangle;

                if (!icon) return;

                const status = circle ? '空き' : '一部空き';
                const ariaLabel = icon.getAttribute('aria-label') || '';
                const ariaDetails = parseAriaLabel(ariaLabel);

                // --- A. aria-label に詳細がある場合 ---
                if (ariaDetails.length > 0) {
                    // 同じ日付の「夜間/空き/一部空き」などの重複を削除
                    results[fullName] = results[fullName].filter(
                        d => !(d.date === date &&
                               (d.details === '夜間' ||
                                d.details === '空き' ||
                                d.details === '一部空き'))
                    );

                    ariaDetails.forEach(info => {
                        const details = `${info.court}: ${info.time}`.trim();

                        if (!results[fullName].some(
                            d => d.date === date && d.details === details
                        )) {
                            results[fullName].push({
                                date,
                                status,
                                details,
                                court: info.court,
                                foundTime: now
                            });
                        }
                    });
                }

                // --- B. aria-label に詳細がない（全部空き） ---
                else {
                    const scopeInfo = currentScope
                        ? `${currentScope} (全部空き)`
                        : '全部空き';

                    if (!results[fullName].some(d => d.date === date)) {
                        results[fullName].push({
                            date,
                            status,
                            details: scopeInfo,
                            foundTime: now
                        });
                    }
                }
            });
        }
    });

    console.log(
        `[scrapePage] 最終結果:`,
        Object.keys(results).map(k => `${k}: ${results[k].length}件`)
    );

    return results;
}


    function parseAriaLabel(ariaLabel) {
        if (!ariaLabel) return [];
        const lines = ariaLabel.split('\n').map(l => l.trim()).filter(l => l);
        let result = [];
        let currentCourt = '';
        for (const line of lines) {
            if (/^\d+$/.test(line)) currentCourt = `コート${line}`;
            else if (line.includes('○')) {
                const timeMatch = line.match(/(\d{1,2}:\d{2}.*?\d{1,2}:\d{2})/);
                if (timeMatch && currentCourt) result.push({ court: currentCourt, time: timeMatch[1] });
            }
        }
        return result;
    }

    // ========================================
    // UI作成
    // ========================================
// ========================================
// createControlPanel（高速化・DOM操作最適化版）
// ========================================
function createControlPanel() {
    if (document.getElementById('mitaka-panel')) return;

    const scale = getScale();
    const mobile = isMobile();

    // --- パネル本体 ---
    const div = document.createElement('div');
    div.id = 'mitaka-panel';

    if (mobile) {
        const pad = 15 * scale;
        const radius = 12 * scale;
        div.style.cssText = `
            position: fixed; bottom: 0; left: 0; width: 100%;
            z-index: 999999; background: rgba(255,255,255,0.98);
            padding: ${pad}px; border-top-left-radius: ${radius}px;
            border-top-right-radius: ${radius}px; border-top: 2px solid #ccc;
            box-shadow: 0 -5px 20px rgba(0,0,0,0.3);
            text-align: center; box-sizing: border-box;
            font-family: sans-serif; max-height: 80vh; overflow-y: auto;
        `;
    } else {
        div.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; width: 280px;
            z-index: 99999; background: rgba(255,255,255,0.98);
            padding: 15px; border-radius: 12px; border: 1px solid #ccc;
            box-shadow: 0 4px 15px rgba(0,0,0,0.3);
            text-align: center; font-family: sans-serif;
        `;
    }

    // --- ヘッダー ---
    const header = document.createElement('div');
    header.id = 'mitaka-header';
    const fontSize = mobile ? (16 * scale) : 14;

    header.style.cssText = `
        font-size: ${fontSize}px; margin-bottom: 12px; color: #333;
        font-weight: bold; padding: 5px; background: #eee;
        border-radius: 6px; cursor: move; user-select: none; touch-action: none;
    `;
    header.innerText = mobile ? '🤖 テニスコートチェッカー v3.1' : '🤖 待機中 (v3.1)';
    div.appendChild(header);

    enableDrag(div, header);

    // --- ボタンコンテナ ---
    const btnContainer = document.createElement('div');
    btnContainer.style.cssText = mobile
        ? `display: grid; grid-template-columns: 1fr 1fr; gap: ${10 * scale}px;`
        : `display: flex; flex-direction: column; gap: 8px;`;

    // --- ボタン生成ヘルパー ---
    const makeBtn = (text, color, onClick) => {
        const btn = document.createElement('button');
        btn.innerText = text;
        btn.className = 'mitaka-ctrl-btn';

        const fs = mobile ? (16 * scale) : 14;
        const pd = mobile ? (12 * scale) : 10;

        btn.style.cssText = `
            color: white; font-size: ${fs}px; font-weight: bold;
            padding: ${pd}px; border: none; border-radius: 8px;
            cursor: pointer; background: ${color}; width: 100%;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            -webkit-appearance: none;
        `;
        btn.onclick = onClick;
        return btn;
    };

    // --- 各ボタン定義 ---
    const quickBtnExec = makeBtn('⚡ 一発実行', '#4CAF50', async () => {
        await requestNotificationPermission();
        const settings = await loadSettings();

        await StorageHelper.set({
            isNavigating: true,
            autoCheckAfterNav: true,
            isRunning: false,
            searchPhase: 1,
            tempResults: {},
            currentWeek: 0,
            maxWeeks: settings.searchWeeks,
            results: {}
        });

        resetAndStart();
    });

    const navChugakuBtn = makeBtn('① 移動(中学等)', '#2196F3', async () => {
        await StorageHelper.set({
            isNavigating: true,
            searchPhase: 1,
            autoCheckAfterNav: false
        });
        resetAndStart();
    });

    const navOsawaBtn = makeBtn('①\' 移動(大沢)', '#009688', async () => {
        await StorageHelper.set({
            isNavigating: true,
            searchPhase: 2,
            autoCheckAfterNav: false
        });
        resetAndStart();
    });

    const checkBtnExec = makeBtn('② チェックのみ', '#c41e3a', async () => {
        await requestNotificationPermission();
        const settings = await loadSettings();

        await StorageHelper.set({
            isRunning: true,
            isNavigating: false,
            currentWeek: 0,
            maxWeeks: settings.searchWeeks,
            results: {}
        });

        updatePanelState(true);
        executeCollection();
    });

    const showResultBtn = makeBtn('📋 結果を見る', '#FF9800', async () => {
        const data = await StorageHelper.get(['lastResults', 'lastScanTime', 'searchScope']);
        if (data.lastResults && Object.keys(data.lastResults).length > 0) {
            showResultsModal(data.lastResults, data.lastScanTime, data.searchScope);
        } else {
            alert('まだ保存された結果がありません。\nまずは検索を実行してください。');
        }
    });

    const settingsBtn = makeBtn('⚙️ 設定', '#9C27B0', () => showSettingsModal());
    const statsBtn = makeBtn('📊 統計', '#00BCD4', () => showStatisticsModal());

    const debugBtn = makeBtn('🐛 ログ', '#666', async () => {
        const data = await StorageHelper.get(['debugLogs']);
        const logs = data.debugLogs || [];

        if (logs.length === 0) {
            alert('ログがありません');
            return;
        }

        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6); z-index: 1000001;
            display: flex; justify-content: center; align-items: center;
        `;

        const content = document.createElement('div');
        const width = mobile ? 350 * scale : 600;
        const height = mobile ? window.innerHeight * 0.8 : 500;

        content.style.cssText = `
            background: white; width: ${width}px; height: ${height}px;
            border-radius: 12px; padding: 20px; display: flex;
            flex-direction: column; box-shadow: 0 10px 30px rgba(0,0,0,0.5);
        `;

        const h3 = document.createElement('h3');
        h3.innerText = '🐛 デバッグログ';
        h3.style.cssText = `
            margin: 0 0 15px 0; border-bottom: 2px solid #666;
            padding-bottom: 10px;
        `;
        content.appendChild(h3);

        const ta = document.createElement('textarea');
        ta.value = logs.join('\n');
        ta.readOnly = true;
        ta.style.cssText = `
            flex: 1; width: 100%; padding: 10px; font-family: monospace;
            font-size: 12px; border: 1px solid #ccc; border-radius: 4px;
            resize: none; box-sizing: border-box;
        `;
        content.appendChild(ta);

        const ba = document.createElement('div');
        ba.style.cssText = 'display: flex; gap: 10px; margin-top: 15px;';

        const cb = document.createElement('button');
        cb.innerText = '閉じる';
        cb.style.cssText = `
            flex: 1; padding: 12px; background: #333; color: white;
            border: none; border-radius: 8px; font-weight: bold; cursor: pointer;
        `;
        cb.onclick = () => modal.remove();

        ba.appendChild(cb);
        content.appendChild(ba);
        modal.appendChild(content);
        document.body.appendChild(modal);
    });

    const stopBtn = makeBtn('■ 停止', '#333', async () => stopAll());
    stopBtn.id = 'mitaka-stop-btn';
    stopBtn.style.display = 'none';

    // --- ボタン追加 ---
    [
        quickBtnExec, navChugakuBtn, navOsawaBtn, checkBtnExec,
        showResultBtn, settingsBtn, statsBtn, debugBtn, stopBtn
    ].forEach(btn => btnContainer.appendChild(btn));

    div.appendChild(btnContainer);
    document.body.appendChild(div);
}


// ========================================
// 設定モーダル (UX改善: ×ボタンで保存終了)
// ========================================
async function showSettingsModal() {
    const settings = await loadSettings();
    
    // 既存のモーダルがあれば削除
    const old = document.getElementById('mitaka-settings-modal');
    if (old) old.remove();

    const modal = document.createElement('div');
    modal.id = 'mitaka-settings-modal';
    modal.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000001; font-family: sans-serif;`;

    // コンテンツ本体
    const content = document.createElement('div');
    const scale = getScale();
    const isMobileDevice = isMobile();
    const width = isMobileDevice ? window.innerWidth * 0.95 : 600;
    const maxHeight = isMobileDevice ? window.innerHeight * 0.9 : 800;
    
    // 初期位置を中央に
    const initialTop = (window.innerHeight - (isMobileDevice ? 500 : 600)) / 2;
    const initialLeft = (window.innerWidth - width) / 2;

    content.style.cssText = `
        position: absolute; top: ${initialTop}px; left: ${initialLeft}px;
        background: white; width: ${width}px; max-height: ${maxHeight}px;
        border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.5);
        display: flex; flex-direction: column; overflow: hidden;
    `;

    // --- 1. ヘッダー（×ボタン追加） ---
    const header = document.createElement('div');
    header.style.cssText = `
        padding: 15px; background: #f5f5f5; border-bottom: 1px solid #ddd;
        font-weight: bold; color: #333; cursor: move; user-select: none;
        display: flex; justify-content: space-between; align-items: center;
        flex-shrink: 0;
    `;
    // 保存して閉じる機能を持つ×ボタン
    header.innerHTML = `
        <div>⚙️ 設定 <span style="font-size:11px; font-weight:normal; color:#666;">(ドラッグ可)</span></div>
        <button id="settings-header-close" style="background:none; border:none; font-size:24px; color:#666; cursor:pointer; line-height:1; padding:0 5px;">×</button>
    `;
    content.appendChild(header);
    enableDrag(content, header);

    // --- 2. スクロールエリア ---
    const scrollArea = document.createElement('div');
    scrollArea.style.cssText = `padding: 15px; overflow-y: auto; flex: 1;`;

    const createSection = (title, contentHtml, isOpen = false) => {
        const section = document.createElement('div');
        section.style.cssText = `border: 1px solid #eee; border-radius: 8px; margin-bottom: 10px; overflow: hidden;`;
        
        const head = document.createElement('div');
        head.style.cssText = `
            padding: 10px 15px; background: #fafafa; cursor: pointer;
            font-weight: bold; font-size: 14px; display: flex; justify-content: space-between;
            align-items: center; user-select: none;
        `;
        head.innerHTML = `<span>${title}</span><span>${isOpen ? '▼' : '▶'}</span>`;
        
        const body = document.createElement('div');
        body.style.display = isOpen ? 'block' : 'none';
        body.style.padding = '15px';
        body.style.borderTop = '1px solid #eee';
        body.innerHTML = contentHtml;
        
        head.onclick = () => {
            const isClosed = body.style.display === 'none';
            body.style.display = isClosed ? 'block' : 'none';
            head.querySelector('span:last-child').innerText = isClosed ? '▼' : '▶';
        };
        
        section.appendChild(head);
        section.appendChild(body);
        return section;
    };

    // カレンダー生成
    const createCalendar = (year, month, selectedDates) => {
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const startDay = firstDay.getDay();
        const daysInMonth = lastDay.getDate();
        let html = `<div style="text-align:center; margin-bottom:5px; font-weight:bold; color:#333;">${year}年 ${month + 1}月</div>`;
        html += `<div style="display:grid; grid-template-columns:repeat(7, 1fr); gap:2px; text-align:center; font-size:12px;">`;
        ['日','月','火','水','木','金','土'].forEach(d => html += `<div style="color:#666; padding:2px;">${d}</div>`);
        for (let i = 0; i < startDay; i++) html += `<div></div>`;
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${month + 1}/${d}`;
            const isSelected = selectedDates.includes(dateStr);
            const bg = isSelected ? '#ffcdd2' : '#f5f5f5';
            const color = isSelected ? '#b71c1c' : '#333';
            const weight = isSelected ? 'bold' : 'normal';
            html += `<div class="cal-day" data-date="${dateStr}" style="background:${bg}; color:${color}; font-weight:${weight}; padding:6px; cursor:pointer; border-radius:4px;">${d}</div>`;
        }
        html += `</div>`;
        return html;
    };

    let currentKws = (settings.exclusionKw || '').split(',').map(s => s.trim()).filter(s => s);
    let selectedDates = currentKws.filter(k => /^\d{1,2}\/\d{1,2}$/.test(k));
    let otherKeywords = currentKws.filter(k => !/^\d{1,2}\/\d{1,2}$/.test(k));
    const today = new Date();
    const calHtml = `
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
            <div>${createCalendar(today.getFullYear(), today.getMonth(), selectedDates)}</div>
            <div>${createCalendar(today.getFullYear(), today.getMonth() + 1, selectedDates)}</div>
        </div>
    `;
    
    const days = ['日', '月', '火', '水', '木', '金', '土'];
    const dayChecks = days.map((d, i) => {
        const isChecked = (settings.exclusionDays || []).includes(i) ? 'checked' : '';
        return `<label style="margin-right:10px; cursor:pointer;"><input type="checkbox" class="ex-day" value="${i}" ${isChecked}>${d}</label>`;
    }).join('');

    let weeksOptions = '';
    for (let i = 1; i <= 8; i++) weeksOptions += `<option value="${i}" ${settings.searchWeeks == i ? 'selected' : ''}>${i}週間</option>`;

    // --- セクション構築 ---
    const basicHtml = `
        <div style="margin-bottom: 10px;">
            <label>📅 検索週数: <select id="searchWeeks">${weeksOptions}</select></label>
            <label style="margin-left:10px;">⏰ 時間帯: 
                <select id="timeFilter">
                    <option value="all">すべて</option><option value="morning">午前</option><option value="afternoon">午後</option><option value="evening">夜間</option>
                </select>
            </label>
        </div>
        <div style="font-size:13px;">
            <label>🔔 通知: <input type="checkbox" id="notificationEnabled" ${settings.notificationEnabled ? 'checked' : ''}></label>
            <label style="margin-left:10px;">🔊 音: <input type="checkbox" id="soundEnabled" ${settings.soundEnabled ? 'checked' : ''}></label>
            <button id="test-notification" style="margin-left:10px; padding: 2px 6px; font-size: 10px;">テスト</button>
        </div>
    `;
    scrollArea.appendChild(createSection('📝 基本設定', basicHtml, true));

    const exclusionHtml = `
        <label style="display: block; margin-bottom: 10px; font-weight:bold; cursor:pointer;">
            <input type="checkbox" id="exclusionEnabled" ${settings.exclusionEnabled ? 'checked' : ''}> フィルターを有効にする
        </label>
        <div style="margin-bottom:10px;">
            <div style="font-size:12px; margin-bottom:5px; font-weight:bold;">除外する曜日:</div>
            ${dayChecks}
        </div>
        <div style="margin-bottom:10px;">
            <div style="font-size:12px; margin-bottom:5px; font-weight:bold;">除外する日付:</div>
            ${calHtml}
        </div>
        <div style="margin-bottom:10px;">
            <div style="font-size:12px; margin-bottom:5px; font-weight:bold;">その他KW (コート名など):</div>
            <input type="text" id="otherKw" value="${otherKeywords.join(', ')}" placeholder="例: コート5, 壁打ち" style="width: 100%; padding: 6px; box-sizing:border-box;">
        </div>
        <div style="text-align:right;">
            <button id="reset-exclusion" style="padding:4px 10px; font-size:11px; background:#ef5350; color:white; border:none; border-radius:4px; cursor:pointer;">🗑️ リセット</button>
        </div>
    `;
    scrollArea.appendChild(createSection('🆖 除外フィルタ', exclusionHtml, false));

    const facilitiesContainerId = 'facilities-list-container';
    scrollArea.appendChild(createSection('🏫 施設選択', `<div id="${facilitiesContainerId}"></div>`, false));

    const otherHtml = `
        <div style="font-size:12px;">
            <label><input type="checkbox" id="iftttEnabled" ${settings.iftttEnabled ? 'checked' : ''}> IFTTT連携</label>
            <div style="margin-top:5px;">
                Key: <input type="text" id="iftttWebhookKey" value="${settings.iftttWebhookKey}" style="width:120px;"><br>
                Event: <input type="text" id="iftttEventName" value="${settings.iftttEventName}" style="width:80px; margin-top:4px;">
            </div>
        </div>
    `;
    scrollArea.appendChild(createSection('🔌 IFTTT連携', otherHtml, false));
    content.appendChild(scrollArea);

    // --- 3. フッター ---
    const footer = document.createElement('div');
    footer.style.cssText = `
        padding: 15px; background: white; border-top: 1px solid #ddd;
        display: flex; gap: 10px; flex-shrink: 0;
    `;
    footer.innerHTML = `
        <button id="save-settings" style="flex: 1; padding: 12px; background: #4CAF50; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">保存して閉じる</button>
        <button id="cancel-settings" style="flex: 1; padding: 12px; background: #666; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">キャンセル</button>
    `;
    content.appendChild(footer);
    modal.appendChild(content);
    document.body.appendChild(modal);

    // --- ロジック適用 ---
    const facilitiesList = document.getElementById(facilitiesContainerId);
    settings.facilities.forEach((facility, index) => {
        const div = document.createElement('div');
        div.style.cssText = 'display: flex; align-items: center; gap: 15px; margin-bottom: 6px; padding: 10px; background: #f9f9f9; border-radius: 6px; font-size: 13px; border-bottom: 1px solid #eee;';
        const checkbox = `<input type="checkbox" class="facility-enabled" data-index="${index}" ${facility.enabled ? 'checked' : ''} style="transform: scale(1.2); cursor: pointer;">`;
        div.innerHTML = `${checkbox}<span style="flex: 1;">${facility.name}</span>`;
        div.onclick = (e) => {
            if (e.target.type !== 'checkbox') {
                const cb = div.querySelector('input');
                cb.checked = !cb.checked;
            }
        };
        facilitiesList.appendChild(div);
    });

    if (content.querySelector('#timeFilter')) content.querySelector('#timeFilter').value = settings.timeFilter;

    content.querySelectorAll('.cal-day').forEach(el => {
        el.onclick = () => {
            const date = el.getAttribute('data-date');
            if (selectedDates.includes(date)) {
                selectedDates = selectedDates.filter(d => d !== date);
                el.style.background = '#f5f5f5'; el.style.color = '#333'; el.style.fontWeight = 'normal';
            } else {
                selectedDates.push(date);
                el.style.background = '#ffcdd2'; el.style.color = '#b71c1c'; el.style.fontWeight = 'bold';
            }
        };
    });

    content.querySelector('#reset-exclusion').onclick = () => {
        if (!confirm('除外設定をリセットしますか？')) return;
        content.querySelectorAll('.ex-day').forEach(cb => cb.checked = false);
        selectedDates = [];
        content.querySelectorAll('.cal-day').forEach(el => {
            el.style.background = '#f5f5f5'; el.style.color = '#333'; el.style.fontWeight = 'normal';
        });
        content.querySelector('#otherKw').value = '';
    };

    // === 保存ロジック（共通化） ===
    const saveAndClose = async () => {
        const exDays = Array.from(content.querySelectorAll('.ex-day:checked')).map(cb => parseInt(cb.value));
        const otherKwStr = content.querySelector('#otherKw').value;
        const otherKws = otherKwStr.split(',').map(s => s.trim()).filter(s => s);
        const finalExKw = [...selectedDates, ...otherKws].join(', ');

        const newSettings = {
            ...settings,
            notificationEnabled: content.querySelector('#notificationEnabled').checked,
            soundEnabled: content.querySelector('#soundEnabled').checked,
            searchWeeks: parseInt(content.querySelector('#searchWeeks').value),
            exclusionEnabled: content.querySelector('#exclusionEnabled').checked,
            exclusionDays: exDays,
            exclusionKw: finalExKw,
            timeFilter: content.querySelector('#timeFilter').value,
            facilities: settings.facilities.map((f, i) => ({
                name: f.name,
                priority: f.priority,
                enabled: content.querySelector(`.facility-enabled[data-index="${i}"]`).checked
            })),
            iftttEnabled: content.querySelector('#iftttEnabled').checked,
            iftttWebhookKey: content.querySelector('#iftttWebhookKey').value.trim(),
            iftttEventName: content.querySelector('#iftttEventName').value.trim()
        };

        await saveSettings(newSettings);
        cachedSettings = null; // キャッシュクリア
        
        // ユーザーへのフィードバック
        const saveBtn = content.querySelector('#save-settings');
        saveBtn.innerText = "保存しました！";
        saveBtn.style.background = "#2e7d32";
        setTimeout(() => modal.remove(), 500);
    };

    // 保存ボタンと×ボタンの両方に保存ロジックを割り当て
    content.querySelector('#save-settings').onclick = saveAndClose;
    header.querySelector('#settings-header-close').onclick = saveAndClose;

    // キャンセルボタン（保存せずに閉じる）
    content.querySelector('#cancel-settings').onclick = () => modal.remove();

    content.querySelector('#test-notification').onclick = async () => {
        await requestNotificationPermission();
        await sendNotification('🔔 通知テスト', 'これはテスト通知です。', true);
    };
}

// ========================================
// showStatisticsModal（高速化・DOM操作最適化版）
// ========================================
async function showStatisticsModal() {
    const summary = await getStatisticsSummary();

    // --- モーダル背景 ---
    const modal = document.createElement('div');
    modal.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(0,0,0,0.6); z-index: 1000001;
        display: flex; justify-content: center; align-items: center;
    `;

    // --- モーダル本体 ---
    const scale = getScale();
    const width = isMobile() ? 350 * scale : 500;
    const height = isMobile() ? window.innerHeight * 0.8 : 600;

    const content = document.createElement('div');
    content.style.cssText = `
        background: white; width: ${width}px; max-height: ${height}px;
        border-radius: 12px; padding: 20px; overflow-y: auto;
        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    `;

    // --- HTML生成（テンプレート化で高速化） ---
    let html = `
        <h2 style="margin: 0 0 20px 0; border-bottom: 2px solid #00BCD4; padding-bottom: 10px;">
            📊 統計
        </h2>
    `;

    if (!summary) {
        html += `<p>統計データがまだありません。</p>`;
    } else {
        html += `
            <div style="background: #e3f2fd; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                <p>総チェック: <strong>${summary.totalChecks}回</strong> /
                平均空き: <strong>${summary.averageSlots.toFixed(1)}件</strong></p>
            </div>

            <h3 style="margin: 0 0 10px 0; font-size: 16px;">📅 曜日別傾向</h3>
        `;

        const days = ['月', '火', '水', '木', '金', '土', '日'];

        for (const day of days) {
            const trend = summary.dailyTrends[day];
            if (!trend) continue;

            const avg = (trend.total / trend.count).toFixed(1);
            const barWidth = Math.min((avg / summary.maxSlots) * 100, 100) || 0;

            html += `
                <div style="margin-bottom: 10px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                        <span>${day}曜日</span>
                        <span><strong>${avg}件</strong> (${trend.count}回)</span>
                    </div>
                    <div style="background: #ddd; height: 15px; border-radius: 4px; overflow: hidden;">
                        <div style="background: #00BCD4; height: 100%; width: ${barWidth}%;"></div>
                    </div>
                </div>
            `;
        }

        // --- 施設別傾向 ---
        html += `
            <h3 style="margin: 20px 0 10px 0; font-size: 16px;">🏫 施設別傾向</h3>
        `;

        for (const [facility, stats] of Object.entries(summary.facilityStats)) {
            const avg = (stats.total / stats.count).toFixed(1);
            const barWidth = Math.min((avg / 10) * 100, 100) || 0;

            html += `
                <div style="margin-bottom: 10px;">
                    <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
                        <span>${facility}</span>
                        <span><strong>${avg}件</strong> (${stats.count}回)</span>
                    </div>
                    <div style="background: #ddd; height: 15px; border-radius: 4px; overflow: hidden;">
                        <div style="background: #4CAF50; height: 100%; width: ${barWidth}%;"></div>
                    </div>
                </div>
            `;
        }
    }

    // --- ボタン ---
    html += `
        <div style="display: flex; gap: 10px; margin-top: 20px;">
            <button id="close-stats" style="
                flex: 1; padding: 12px; background: #333; color: white;
                border: none; border-radius: 8px; font-weight: bold; cursor: pointer;
            ">閉じる</button>

            <button id="reset-stats" style="
                flex: 1; padding: 12px; background: #c41e3a; color: white;
                border: none; border-radius: 8px; font-weight: bold; cursor: pointer;
            ">🗑️ データ削除</button>
        </div>
    `;

    content.innerHTML = html;

    // --- 閉じるボタン ---
    content.querySelector('#close-stats').onclick = () => modal.remove();

    // --- データ削除 ---
    const resetBtn = content.querySelector('#reset-stats');
    resetBtn.onclick = async () => {
        if (confirm('統計データをすべて削除しますか？\nこの操作は取り消せません。')) {
            await StorageHelper.set({ statistics: [] });
            alert('統計データを削除しました。');
            modal.remove();
        }
    };

    modal.appendChild(content);
    document.body.appendChild(modal);
}

// ========================================
// クイックフィルタ機能（UX改善版 v2）
// ========================================
function applyQuickFilters(rawResults, filters) {
    const filtered = {};
    const excluded = {};

    for (const [facility, slots] of Object.entries(rawResults || {})) {
        // 施設除外
        if (filters.facilityFilter.length > 0 && filters.facilityFilter.includes(facility)) {
            if (!excluded[facility]) excluded[facility] = [];
            excluded[facility].push(...slots.map(s => ({ ...s, excludeReason: '施設除外' })));
            continue; 
        }

        filtered[facility] = [];
        
        slots.forEach(slot => {
            let shouldInclude = true;
            let excludeReason = '';
            
            // --- 1. テキスト除外 (17:00, コート名など) ---
            if (filters.textFilter) {
                const keywords = filters.textFilter.split(',').map(k => k.trim()).filter(Boolean);
                const targetText = (slot.date + ' ' + slot.details + ' ' + facility).toLowerCase();
                const hitKeyword = keywords.find(kw => targetText.includes(kw.toLowerCase()));
                if (hitKeyword) {
                    shouldInclude = false;
                    excludeReason = `検索(${hitKeyword})`;
                }
            }

            // --- 2. 時間帯除外 ---
            if (shouldInclude && filters.timeFilter !== 'all') {
                const timeMatch = slot.details.match(/(\d{1,2}):(\d{2})/);
                const hour = timeMatch ? parseInt(timeMatch[1]) : -1;
                const detailStr = slot.details.toLowerCase();

                const isMorning = (hour >= 6 && hour < 12) || detailStr.includes('午前');
                const isAfternoon = (hour >= 12 && hour < 18) || detailStr.includes('午後');
                const isEvening = (hour >= 18 && hour < 22) || detailStr.includes('夜間');

                if (filters.timeFilter === 'morning' && isMorning) {
                    shouldInclude = false; excludeReason = '時間帯(午前)';
                } else if (filters.timeFilter === 'afternoon' && isAfternoon) {
                    shouldInclude = false; excludeReason = '時間帯(午後)';
                } else if (filters.timeFilter === 'evening' && isEvening) {
                    shouldInclude = false; excludeReason = '時間帯(夜間)';
                }
            }
            
            // --- 3. 日付・曜日除外 ---
            if (shouldInclude && filters.dateFilter.length > 0) {
                const dateMatch = slot.date.match(/(\d{1,2}\/\d{1,2})/);
                if (dateMatch && filters.dateFilter.includes(dateMatch[1])) {
                    shouldInclude = false; excludeReason = '日付除外';
                }
            }
            if (shouldInclude && filters.dayOfWeekFilter.length > 0) {
                const dayMatch = slot.date.match(/[（\(](.)[）\)]/);
                if (dayMatch && filters.dayOfWeekFilter.includes(dayMatch[1])) {
                    shouldInclude = false; excludeReason = '曜日除外';
                }
            }

            if (shouldInclude) {
                filtered[facility].push(slot);
            } else {
                if (!excluded[facility]) excluded[facility] = [];
                excluded[facility].push({ ...slot, excludeReason });
            }
        });

        if (filtered[facility].length === 0) delete filtered[facility];
    }
    return { results: filtered, excludedResults: excluded };
}

// 関数単位での置換用: createQuickFilterPanel
function createQuickFilterPanel(currentFilters, rawResults, searchTimeFilter, onChange) {
    const panel = document.createElement('div');
    panel.style.cssText = 'padding: 12px 15px; background: #fff5f5; border-bottom: 1px solid #feb2b2; max-height: 65vh; overflow-y: auto;';
    
    let tempFilters = JSON.parse(JSON.stringify(currentFilters));
    const container = document.createElement('div');
    container.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
    
    // --- ヘッダー ---
    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;';
    headerRow.innerHTML = `
        <div style="display:flex; flex-direction:column;">
            <span style="font-size: 13px; font-weight: bold; color: #c53030;">🚫 クイック除外フィルタ</span>
            <span style="font-size: 9px; color: #e53e3e;">※チェック項目や入力文字を含む枠を消します</span>
        </div>
        <div style="display:flex; gap:8px;">
            <button id="quick-filter-reset" style="padding: 5px 10px; background: #718096; color: white; border: none; border-radius: 6px; font-size: 11px; cursor: pointer;">全解除</button>
            <button id="quick-filter-apply" style="padding: 5px 15px; background: #e53e3e; color: white; border: none; border-radius: 6px; font-size: 11px; font-weight: bold; cursor: pointer; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">除外を適用</button>
        </div>
    `;
    container.appendChild(headerRow);

    const createGroup = (icon, title, badgeId) => {
        const group = document.createElement('div');
        group.style.cssText = 'padding: 10px; background: white; border-radius: 6px; border: 1px solid #feb2b2;';
        const labelRow = document.createElement('div');
        labelRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;';
        labelRow.innerHTML = `<span style="font-size: 12px; font-weight: bold; color: #2d3748;">${icon} ${title}</span><span id="${badgeId}" style="font-size: 10px; background: #edf2f7; color: #4a5568; padding: 2px 6px; border-radius: 10px;">-</span>`;
        group.appendChild(labelRow);
        return group;
    };

    const updateBadge = (id, count) => {
        const b = container.querySelector(`#${id}`);
        if (!b) return;
        b.innerText = count === 0 || !count ? 'すべて表示中' : (typeof count === 'string' ? count : `${count}件除外中`);
        b.style.background = (count === 0 || !count) ? '#edf2f7' : '#fff5f5';
        b.style.color = (count === 0 || !count) ? '#4a5568' : '#c53030';
    };

    // 1. 時間帯
    const timeGroup = createGroup('🕐', '除外する時間帯', 'badge-time');
    const timeSelect = document.createElement('select');
    timeSelect.style.cssText = 'width: 100%; padding: 6px; border: 1px solid #cbd5e0; border-radius: 4px; font-size: 12px;';
    [{v:'all',l:'除外なし'},{v:'morning',l:'午前を除外'},{v:'afternoon',l:'午後を除外'},{v:'evening',l:'夜間を除外'}].forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.v; opt.textContent = o.l;
        if (searchTimeFilter !== 'all' && o.v !== 'all' && o.v !== searchTimeFilter) { opt.disabled = true; opt.textContent += ' (検索外)'; }
        timeSelect.appendChild(opt);
    });
    timeSelect.value = tempFilters.timeFilter;
    timeSelect.onchange = () => { tempFilters.timeFilter = timeSelect.value; updateBadge('badge-time', timeSelect.value==='all'?0:1); };
    timeGroup.appendChild(timeSelect);
    container.appendChild(timeGroup);

    // 2. テキスト除外
    const textGroup = createGroup('🔍', 'テキストで除外', 'badge-text');
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.placeholder = '例: 17:00, コート1, 壁打ち...';
    textInput.value = tempFilters.textFilter || '';
    textInput.style.cssText = 'width: 100%; padding: 8px; border: 1px solid #cbd5e0; border-radius: 4px; font-size: 12px; box-sizing: border-box;';
    textInput.oninput = () => {
        tempFilters.textFilter = textInput.value;
        updateBadge('badge-text', textInput.value ? '入力あり' : 0);
    };
    const textHint = document.createElement('div');
    textHint.style.cssText = 'font-size: 9px; color: #718096; margin-top: 5px;';
    textHint.innerText = '※カンマ区切りで複数指定可能。時刻や詳細に含まれる文字で消去します。';
    textGroup.appendChild(textInput);
    textGroup.appendChild(textHint);
    container.appendChild(textGroup);

    // 3. 施設 (修正箇所: 結果一覧と同じく、カッコ書きの削除のみを行う)
    const facGroup = createGroup('🏫', '除外する施設', 'badge-fac');
    const facList = document.createElement('div');
    facList.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 4px; max-height: 80px; overflow-y: auto;';
    
    // 施設名でソート
    const facKeys = Object.keys(rawResults || {}).sort();
    
    facKeys.forEach(fac => {
        const lbl = document.createElement('label');
        lbl.style.cssText = 'font-size: 11px; display: flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = tempFilters.facilityFilter.includes(fac);
        cb.onchange = () => {
            tempFilters.facilityFilter = cb.checked ? [...tempFilters.facilityFilter, fac] : tempFilters.facilityFilter.filter(f => f !== fac);
            updateBadge('badge-fac', tempFilters.facilityFilter.length);
        };
        
        // ★修正ポイント: 結果一覧の shortenFac と同じロジック (カッコ以降を削除のみ)
        const shortName = fac.split(/[（\(]/)[0].trim();
        
        lbl.appendChild(cb); 
        lbl.appendChild(document.createTextNode(shortName));
        lbl.title = fac; // マウスホバーで正式名称を表示
        facList.appendChild(lbl);
    });
    facGroup.appendChild(facList);
    container.appendChild(facGroup);

    // 4. 日付
    const dateGroup = createGroup('📅', '除外する日付', 'badge-date');
    const dateList = document.createElement('div');
    dateList.style.cssText = 'display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; max-height: 100px; overflow-y: auto;';
    const allDates = new Set();
    Object.values(rawResults || {}).forEach(slots => slots.forEach(s => {
        const m = s.date.match(/(\d{1,2}\/\d{1,2})/); if (m) allDates.add(m[1]);
    }));
    Array.from(allDates).sort((a,b) => {
        const [m1,d1]=a.split('/').map(Number), [m2,d2]=b.split('/').map(Number);
        return m1!==m2 ? m1-m2 : d1-d2;
    }).forEach(d => {
        const lbl = document.createElement('label');
        lbl.style.cssText = 'font-size: 11px; border: 1px solid #edf2f7; padding: 4px 0; text-align: center; cursor: pointer; border-radius: 4px; transition: 0.2s;';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.style.display = 'none'; cb.checked = tempFilters.dateFilter.includes(d);
        const updateStyle = () => {
            lbl.style.background = cb.checked ? '#fff5f5' : '#fff';
            lbl.style.color = cb.checked ? '#c53030' : '#4a5568';
            lbl.style.borderColor = cb.checked ? '#feb2b2' : '#edf2f7';
        };
        cb.onchange = () => {
            tempFilters.dateFilter = cb.checked ? [...tempFilters.dateFilter, d] : tempFilters.dateFilter.filter(x => x !== d);
            updateStyle(); updateBadge('badge-date', tempFilters.dateFilter.length);
        };
        updateStyle(); lbl.appendChild(cb); lbl.appendChild(document.createTextNode(d));
        dateList.appendChild(lbl);
    });
    dateGroup.appendChild(dateList);
    container.appendChild(dateGroup);

    // 5. 曜日
    const dayGroup = createGroup('📆', '除外する曜日', 'badge-day');
    const dayBox = document.createElement('div');
    dayBox.style.cssText = 'display: flex; gap: 4px;';
    ['月', '火', '水', '木', '金', '土', '日'].forEach(d => {
        const lbl = document.createElement('label');
        lbl.style.cssText = `flex:1; text-align:center; font-size:11px; padding:6px 0; border:1px solid #edf2f7; border-radius:4px; cursor:pointer;`;
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.style.display = 'none'; cb.checked = tempFilters.dayOfWeekFilter.includes(d);
        const updateStyle = () => {
            lbl.style.background = cb.checked ? '#fff5f5' : '#fff';
            lbl.style.color = cb.checked ? '#c53030' : '#4a5568';
            lbl.style.borderColor = cb.checked ? '#feb2b2' : '#edf2f7';
        };
        cb.onchange = () => {
            tempFilters.dayOfWeekFilter = cb.checked ? [...tempFilters.dayOfWeekFilter, d] : tempFilters.dayOfWeekFilter.filter(x => x !== d);
            updateStyle(); updateBadge('badge-day', tempFilters.dayOfWeekFilter.length);
        };
        updateStyle(); lbl.appendChild(cb); lbl.appendChild(document.createTextNode(d));
        dayBox.appendChild(lbl);
    });
    dayGroup.appendChild(dayBox);
    container.appendChild(dayGroup);

    headerRow.querySelector('#quick-filter-apply').onclick = () => onChange(tempFilters);
    headerRow.querySelector('#quick-filter-reset').onclick = () => {
        tempFilters = { timeFilter: searchTimeFilter, facilityFilter: [], dateFilter: [], dayOfWeekFilter: [], textFilter: '' };
        onChange(tempFilters);
    };

    setTimeout(() => {
        updateBadge('badge-time', tempFilters.timeFilter==='all'?0:1);
        updateBadge('badge-text', tempFilters.textFilter? '入力あり':0);
        updateBadge('badge-fac', tempFilters.facilityFilter.length);
        updateBadge('badge-date', tempFilters.dateFilter.length);
        updateBadge('badge-day', tempFilters.dayOfWeekFilter.length);
    }, 10);

    panel.appendChild(container);
    return panel;
}

// ============================================================
// 【改善4・5】置換・追加 対象関数
//
// 使い方:
//   1. renderCalendarView → content.js の showResultsModal の直前に「追加」
//   2. showResultsModal   → content.js の既存 showResultsModal を「置換」
// ============================================================


// ============================================================
// ★【追加】renderCalendarView
//   showResultsModal の直前（2112行目付近）に挿入してください
// ============================================================
function renderCalendarView(results, scrollArea) {
    scrollArea.innerHTML = '';

    // --- 空き情報を日付ごとに集計 ---
    // ★修正: "2/19(木)" "02/19" "2月19日" など複数フォーマットに対応
    const dateMap = {}; // { '2/19': { count: 5, facilities: Set } }
    const normalizeDate = (dateStr) => {
        if (!dateStr) return null;
        // パターン1: "2/19" "2/19(木)" → そのまま抽出
        const slashMatch = dateStr.match(/(\d{1,2})\/(\d{1,2})/);
        if (slashMatch) return `${parseInt(slashMatch[1])}/${parseInt(slashMatch[2])}`;
        // パターン2: "2月19日" → "2/19"
        const jpMatch = dateStr.match(/(\d{1,2})月(\d{1,2})日/);
        if (jpMatch) return `${parseInt(jpMatch[1])}/${parseInt(jpMatch[2])}`;
        return null;
    };
    for (const [fac, slots] of Object.entries(results)) {
        slots.forEach(s => {
            const key = normalizeDate(s.date);
            if (!key) return;
            if (!dateMap[key]) dateMap[key] = { count: 0, facilities: new Set() };
            dateMap[key].count++;
            dateMap[key].facilities.add(fac.split(/[（\(]/)[0].trim());
        });
    }

    if (Object.keys(dateMap).length === 0) {
        scrollArea.innerHTML = '<div style="padding:40px; color:#888; text-align:center;">空き枠はありません</div>';
        return;
    }

    // --- 表示する年月を決定（空きがある最初の月〜最後の月） ---
    const now = new Date();
    const allDates = Object.keys(dateMap).map(d => {
        const [mo, day] = d.split('/').map(Number);
        const year = (mo < now.getMonth() + 1 - 1) ? now.getFullYear() + 1 : now.getFullYear();
        return new Date(year, mo - 1, day);
    });
    allDates.sort((a, b) => a - b);
    const firstDate = allDates[0];
    const lastDate  = allDates[allDates.length - 1];

    // --- 月ごとにカレンダーを描画 ---
    let cur = new Date(firstDate.getFullYear(), firstDate.getMonth(), 1);
    const end = new Date(lastDate.getFullYear(), lastDate.getMonth(), 1);

    const DAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
    const DAY_COLORS = ['#e53e3e','#333','#333','#333','#333','#333','#3182ce']; // 日曜赤・土曜青

    while (cur <= end) {
        const year  = cur.getFullYear();
        const month = cur.getMonth(); // 0-indexed

        // カレンダーブロック
        const block = document.createElement('div');
        block.style.cssText = 'margin-bottom:16px; background:#fafafa; border:1px solid #e2e8f0; border-radius:8px; overflow:hidden;';

        // 月ヘッダー
        const mHead = document.createElement('div');
        mHead.style.cssText = 'background:#2c3e50; color:white; text-align:center; padding:6px; font-size:13px; font-weight:bold;';
        mHead.textContent = `${year}年 ${month + 1}月`;
        block.appendChild(mHead);

        // 曜日ヘッダー行
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid; grid-template-columns:repeat(7,1fr); gap:2px; padding:4px;';

        DAY_LABELS.forEach((d, i) => {
            const cell = document.createElement('div');
            cell.style.cssText = `text-align:center; font-size:10px; color:${DAY_COLORS[i]}; padding:2px; font-weight:bold;`;
            cell.textContent = d;
            grid.appendChild(cell);
        });

        // 空白セル（月初の曜日オフセット）
        const firstWeekday = new Date(year, month, 1).getDay();
        for (let i = 0; i < firstWeekday; i++) {
            grid.appendChild(document.createElement('div'));
        }

        // 日付セル
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        for (let day = 1; day <= daysInMonth; day++) {
            const key = `${month + 1}/${day}`;
            const info = dateMap[key];
            const weekday = new Date(year, month, day).getDay();

            const cell = document.createElement('div');
            cell.style.cssText = `
                text-align:center; padding:4px 2px; border-radius:6px; font-size:11px;
                cursor:${info ? 'pointer' : 'default'};
                background:${info ? '#ebf8ff' : 'transparent'};
                border:${info ? '1px solid #bee3f8' : '1px solid transparent'};
                position:relative;
            `;

            // 日付数字
            const dayNum = document.createElement('div');
            dayNum.style.cssText = `color:${info ? '#2b6cb0' : DAY_COLORS[weekday]}; font-weight:${info ? 'bold' : 'normal'};`;
            dayNum.textContent = day;
            cell.appendChild(dayNum);

            // 空き枠バッジ
            if (info) {
                const badge = document.createElement('div');
                badge.style.cssText = 'font-size:9px; color:#2c7a7b; background:#e6fffa; border-radius:3px; padding:1px; margin-top:1px; line-height:1.2;';
                badge.textContent = `${info.count}枠`;
                cell.appendChild(badge);

                // タップで施設一覧ツールチップ
                const facNames = Array.from(info.facilities).join('\n');
                cell.title = `${month + 1}/${day} の空き (${info.count}枠)\n${facNames}`;

                // タップで下部に詳細を表示
                cell.onclick = () => {
                    const existing = block.querySelector('.cal-detail');
                    if (existing) existing.remove();
                    const detail = document.createElement('div');
                    detail.className = 'cal-detail';
                    detail.style.cssText = 'padding:8px 10px; background:#e6fffa; border-top:1px solid #81e6d9; font-size:11px;';
                    detail.innerHTML = `<b>📅 ${month + 1}/${day}</b><br>` +
                        Array.from(info.facilities).map(f => `• ${f}`).join('<br>') +
                        `<br><span style="color:#888; font-size:10px;">計 ${info.count} コマ空きあり</span>`;
                    block.appendChild(detail);
                };
            }

            grid.appendChild(cell);
        }

        block.appendChild(grid);
        scrollArea.appendChild(block);
        cur = new Date(year, month + 1, 1); // 翌月へ
    }
}

// ============================================================
// ★【置換】showResultsModal
//   content.js 2116行目〜2361行目 を、以下全体で置き換えてください
// ============================================================
async function showResultsModal(rawResults, timestamp, scopeText, timeFilterOverride = null) {
    const settings = await loadSettings();
    const dataForRange = await StorageHelper.get(['lastSearchRange', 'lastTimeFilter']);
    const searchTimeFilter = timeFilterOverride || dataForRange.lastTimeFilter || 'all';

    const timeLabelMap = { 'all': 'すべて', 'morning': '午前', 'afternoon': '午後', 'evening': '夜間' };
    const displayTimeFilter = timeLabelMap[searchTimeFilter] || searchTimeFilter;

    if (!lastSearchResults || JSON.stringify(lastSearchResults) !== JSON.stringify(rawResults)) {
        lastSearchResults = rawResults;
        lastSearchTimestamp = timestamp;
        lastSearchScope = scopeText;
        lastSearchTimeFilter = searchTimeFilter;

        const dayNames = ['日','月','火','水','木','金','土'];
        const initialExcludedDays = (settings.exclusionDays || []).map(d => dayNames[d]);
        const exKws = (settings.exclusionKw || '').split(',').map(s => s.trim()).filter(Boolean);
        const initialExcludedDates = exKws.filter(kw => /^\d{1,2}\/\d{1,2}$/.test(kw));
        const initialExcludedTexts = exKws.filter(kw => !/^\d{1,2}\/\d{1,2}$/.test(kw));

        currentQuickFilters = {
            timeFilter: 'all',
            facilityFilter: [],
            dateFilter: initialExcludedDates,
            dayOfWeekFilter: initialExcludedDays,
            textFilter: initialExcludedTexts.join(', ')
        };
    }

    const quickFiltered = applyQuickFilters(rawResults, currentQuickFilters);
    const filteredByQuick = quickFiltered.results;
    const excludedByQuick = quickFiltered.excludedResults;

    const old = document.getElementById('mitaka-results-modal');
    if (old) old.remove();

    const checkTime = new Date(timestamp).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const dateRangeStr = dataForRange.lastSearchRange || '範囲不明';

    // --- 除外データの集計 ---
    const allExcluded = [];
    const statsSummary = { time: {}, day: {}, date: {}, fac: {}, text: {} };

    for (const [fac, slots] of Object.entries(excludedByQuick)) {
        slots.forEach(s => {
            const slotWithFac = {...s, facility: fac};
            allExcluded.push(slotWithFac);
            const dayMatch  = s.date.match(/[（\(](.)[）\)]/);
            const dateMatch = s.date.match(/(\d{1,2}\/\d{1,2})/);
            const r = s.excludeReason || '';
            if (r.includes('検索')) {
                const kw = r.match(/\((.+)\)/)?.[1] || 'キーワード';
                statsSummary.text[kw] = (statsSummary.text[kw] || 0) + 1;
            } else if (r.includes('時間帯')) {
                const t = r.match(/\((.+)\)/)?.[1] || '時間帯';
                statsSummary.time[t] = (statsSummary.time[t] || 0) + 1;
            } else if (dayMatch && r.includes('曜日')) {
                statsSummary.day[dayMatch[1]] = (statsSummary.day[dayMatch[1]] || 0) + 1;
            } else if (dateMatch && (r.includes('日付') || r.includes('KW'))) {
                statsSummary.date[dateMatch[1]] = (statsSummary.date[dateMatch[1]] || 0) + 1;
            } else if (r.includes('施設')) {
                statsSummary.fac[fac] = (statsSummary.fac[fac] || 0) + 1;
            }
        });
    }

    const headerParts = [];
    if (Object.keys(statsSummary.text).length > 0) headerParts.push(`検索:${Object.keys(statsSummary.text).join(',')}`);
    if (Object.keys(statsSummary.time).length > 0) headerParts.push(Object.keys(statsSummary.time).join(','));
    if (Object.keys(statsSummary.day).length > 0)  headerParts.push(Object.keys(statsSummary.day).join('') + '曜');
    const dKeys = Object.keys(statsSummary.date);
    if (dKeys.length > 0) headerParts.push(dKeys.length >= 3 ? `${dKeys.length}日程` : dKeys.join(','));
    const headerExSummary = headerParts.length > 0 ? `[除外: ${headerParts.join(' / ')}]` : '[除外なし]';

    const results = {};
    const enabledFacilityNames = settings.facilities.filter(f => f.enabled).map(f => f.name);
    for (const [fac, slots] of Object.entries(filteredByQuick)) {
        if (enabledFacilityNames.some(en => fac.includes(en))) results[fac] = slots;
    }

    // --- UI構築 ---
    const modal = document.createElement('div');
    modal.id = 'mitaka-results-modal';
    modal.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 1000000; font-family: sans-serif; pointer-events: none;`;

    const isMobileUI = window.innerWidth < 600;
    const width = isMobileUI ? window.innerWidth * 0.95 : 720;
    const content = document.createElement('div');
    content.style.cssText = `position: absolute; top: 4%; left: ${(window.innerWidth - width) / 2}px; background: white; width: ${width}px; max-height: 94vh; border-radius: 12px; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,0.5); pointer-events: auto; border: 1px solid #ccc; overflow: hidden;`;

    const header = document.createElement('div');
    header.style.cssText = `padding: 10px 12px; background: #2c3e50; color: white; cursor: move; user-select: none; display: flex; justify-content: space-between; align-items: center;`;
    header.innerHTML = `
        <div style="flex:1">
            <div style="font-size: 14px; font-weight: bold;">🎾 三鷹テニス空き状況 (${displayTimeFilter}) <span style="font-size:10px; color:#ffb74d; margin-left:5px;">${headerExSummary}</span></div>
            <div style="font-size: 10px; opacity: 0.8;">${checkTime} 確認 / ${dateRangeStr}</div>
        </div>
        <button id="mitaka-modal-close-top" style="background:none; border:none; color:white; font-size:24px; cursor:pointer; line-height:1;">×</button>
    `;
    content.appendChild(header);
    enableDrag(content, header);

    const filterToggle = document.createElement('div');
    filterToggle.style.cssText = `padding: 8px 15px; background: #fff5f5; border-bottom: 1px solid #feb2b2; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: bold; color:#c53030;`;
    filterToggle.innerHTML = `<span>🚫 除外フィルタ設定を編集する</span><span id="filter-arrow">▶</span>`;
    content.appendChild(filterToggle);

    const filterContainer = document.createElement('div');
    filterContainer.style.display = 'none';
    filterContainer.appendChild(createQuickFilterPanel(currentQuickFilters, rawResults, searchTimeFilter, (newFilters) => {
        currentQuickFilters = newFilters;
        showResultsModal(lastSearchResults, lastSearchTimestamp, lastSearchScope, lastSearchTimeFilter);
    }));
    content.appendChild(filterContainer);
    filterToggle.onclick = () => {
        const isHidden = filterContainer.style.display === 'none';
        filterContainer.style.display = isHidden ? 'block' : 'none';
        document.getElementById('filter-arrow').innerText = isHidden ? '▼' : '▶';
    };

    const bodyContainer = document.createElement('div');
    bodyContainer.style.cssText = 'flex: 1; display: flex; flex-direction: column; overflow: hidden; padding: 10px; background: white;';

    const tabArea = document.createElement('div');
    tabArea.style.cssText = "display: flex; gap: 4px; margin-bottom: 8px; flex-shrink: 0;";

    // ★【改善4】カレンダータブを追加
    const tabs = [
        { id: 'date',     label: '📅 日付' },
        { id: 'facility', label: '🏫 施設' },
        { id: 'calendar', label: '🗓️ カレンダー' },  // ← 追加
        { id: 'detail',   label: '📝 詳細' },
        { id: 'excluded', label: `🗑️ 除外(${allExcluded.length})` }
    ];
    let currentMode = 'date';
    let activeSubFilter = null;
    const scrollArea = document.createElement('div');
    scrollArea.style.cssText = 'flex: 1; overflow-y: auto; background: #fff; border: 1px solid #eee; border-radius: 4px; padding: 5px;';

    tabs.forEach(t => {
        const btn = document.createElement('div');
        btn.style.cssText = "flex: 1; padding: 10px 2px; border-radius: 6px; cursor: pointer; text-align:center; font-size: 11px; background: #f0f0f0; font-weight:bold;";
        btn.innerText = t.label; btn.dataset.tabId = t.id;
        btn.onclick = () => { currentMode = t.id; activeSubFilter = null; updateTabs(); render(); };
        tabArea.appendChild(btn);
    });

    const updateTabs = () => {
        tabArea.querySelectorAll('div').forEach(btn => {
            const active = btn.dataset.tabId === currentMode;
            btn.style.background = active ? '#2c3e50' : '#f0f0f0';
            btn.style.color = active ? '#fff' : '#555';
        });
    };

    const shortenFac  = (n) => n ? n.split(/[（\(]/)[0].trim() : '';
    const getStatusMark = (s) => s.isNew ? '🔴' : (s.date && new Date().getDate() == parseInt(s.date.split('/')[1]) ? '🟠' : '⚪');
    const padDate     = (d) => { const m = d.match(/(\d{1,2})\/(\d{1,2})/); return m ? `${m[1].padStart(2,'0')}/${m[2].padStart(2,'0')}` : d; };
    const extractTime = (det) => { const m = det.match(/(\d{1,2}:\d{2})/); return m ? m[1] : ''; };

    const render = () => {
        scrollArea.innerHTML = '';

        // ★【改善4】カレンダーモード
        if (currentMode === 'calendar') {
            renderCalendarView(results, scrollArea);
            return;
        }

        if (currentMode === 'excluded') {
            const statsBar = document.createElement('div');
            statsBar.style.cssText = "display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; padding: 8px; background: #fdf2f2; border-radius: 6px; border: 1px solid #feb2b2;";
            const createStatBtn = (label, count, filterVal) => {
                const b = document.createElement('button');
                const active = activeSubFilter === filterVal;
                b.style.cssText = `padding: 4px 8px; font-size: 10px; border-radius: 4px; border: 1px solid #feb2b2; cursor: pointer; background: ${active ? '#e53e3e' : '#fff'}; color: ${active ? '#fff' : '#c53030'}; font-weight: bold;`;
                b.innerText = `${label} (${count})`;
                b.onclick = () => { activeSubFilter = active ? null : filterVal; render(); };
                statsBar.appendChild(b);
            };
            Object.entries(statsSummary.time).forEach(([k, v]) => createStatBtn(k, v, k));
            Object.entries(statsSummary.day).forEach(([k, v]) => createStatBtn(k + '曜', v, k));
            Object.entries(statsSummary.date).forEach(([k, v]) => createStatBtn(k, v, k));
            Object.entries(statsSummary.fac).forEach(([k, v]) => createStatBtn(shortenFac(k), v, k));
            Object.entries(statsSummary.text).forEach(([k, v]) => createStatBtn(k, v, k));
            if (allExcluded.length > 0) scrollArea.appendChild(statsBar);
            const displayList = activeSubFilter
                ? allExcluded.filter(x => x.date.includes(activeSubFilter) || x.facility === activeSubFilter || x.excludeReason.includes(activeSubFilter))
                : allExcluded;
            displayList.sort((a, b) => padDate(a.date).localeCompare(padDate(b.date)));
            if (displayList.length === 0) { scrollArea.innerHTML += '<div style="padding:20px; color:#999; text-align:center;">対象はありません</div>'; return; }
            displayList.forEach(s => {
                const row = document.createElement('div');
                row.style.cssText = "font-size:11px; padding:6px; border-bottom:1px solid #f8f9fa; display:flex; justify-content:space-between; align-items:center;";
                row.innerHTML = `<span><b>${s.date}</b> ${shortenFac(s.facility)} ${s.details}</span><span style="color:#dc3545; font-size:9px; background:#fff5f5; padding:2px 4px; border-radius:3px; border:1px solid #feb2b2;">${s.excludeReason}</span>`;
                scrollArea.appendChild(row);
            });
            return;
        }

        const grouped = {};
        for (const [fac, slots] of Object.entries(results)) {
            slots.forEach(s => {
                const mainKey = (currentMode === 'facility') ? shortenFac(fac) : s.date;
                const subKey  = (currentMode === 'facility') ? s.date : shortenFac(fac);
                if (!grouped[mainKey]) grouped[mainKey] = {};
                if (!grouped[mainKey][subKey]) grouped[mainKey][subKey] = [];
                grouped[mainKey][subKey].push(s);
            });
        }
        const sortedKeys = Object.keys(grouped).sort((a, b) => (currentMode === 'facility') ? a.localeCompare(b) : padDate(a).localeCompare(padDate(b)));
        if (sortedKeys.length === 0) { scrollArea.innerHTML = '<div style="padding:40px; color:#888; text-align:center;">空き枠はありません</div>'; return; }
        sortedKeys.forEach(mainKey => {
            const wrap = document.createElement('div'); wrap.style.marginBottom = "10px";
            const head = document.createElement('div'); head.style.cssText = "font-weight:bold; font-size:12px; background:#f1f3f5; color:#495057; padding:5px 10px; border-radius:4px; border-left:4px solid #2c3e50;";
            head.innerText = `${(currentMode === 'facility' ? '🏫' : '📅')} ${mainKey}`;
            wrap.appendChild(head);
            const subKeys = Object.keys(grouped[mainKey]).sort((a, b) => (currentMode === 'facility') ? padDate(a).localeCompare(b) : a.localeCompare(b));
            subKeys.forEach(subKey => {
                const subHead = document.createElement('div'); subHead.style.cssText = "font-weight:bold; font-size:11px; color:#00796b; margin: 4px 0 2px 12px;";
                subHead.innerText = `${(currentMode === 'facility' ? '📅' : '🏫')} ${subKey}`;
                wrap.appendChild(subHead);
                grouped[mainKey][subKey].sort((a, b) => extractTime(a.details).localeCompare(extractTime(b.details))).forEach(s => {
                    const row = document.createElement('div'); row.style.cssText = "margin-left:24px; font-size:11px; color:#333; padding:2px 0; border-bottom:1px solid #f8f9fa;";
                    const timeInfo = (currentMode === 'detail' && s.firstFound)
                        ? ` <span style="font-size:9px; color:#999; margin-left:8px;">[発見:${new Date(s.firstFound).toLocaleString('ja-JP', {month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit'})}]</span>`
                        : '';
                    row.innerHTML = `<span style="color:#dee2e6;">└ </span>${getStatusMark(s)} ${s.details}${timeInfo}`;
                    wrap.appendChild(row);
                });
            });
            scrollArea.appendChild(wrap);
        });
    };

    const footer = document.createElement('div');
    footer.style.cssText = "margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;";

    const closeBtn = document.createElement('button');
    closeBtn.innerText = "閉じる";
    closeBtn.style.cssText = "flex:1; padding:12px; cursor:pointer; border-radius:8px; border:1px solid #ccc; background:white; font-size:12px;";
    const closeModal = () => modal.remove();
    closeBtn.onclick = closeModal;
    const topClose = header.querySelector('#mitaka-modal-close-top');
    if (topClose) topClose.onclick = closeModal;

    // --- 共通: results データからテキストを生成（タブ表示に依存しない） ---
    const buildResultText = () => {
        const byDate = {};
        for (const [fac, slots] of Object.entries(results)) {
            slots.forEach(s => {
                if (!byDate[s.date]) byDate[s.date] = {};
                const facShort = shortenFac(fac);
                if (!byDate[s.date][facShort]) byDate[s.date][facShort] = [];
                byDate[s.date][facShort].push(s); // ★ オブジェクトごと格納
            });
        }
        const sortedDates = Object.keys(byDate).sort((a, b) => padDate(a).localeCompare(padDate(b)));
        return sortedDates.map(date => {
            const facLines = Object.entries(byDate[date]).map(([fac, slotObjs]) =>
                `🏫 ${fac}\n` + slotObjs.sort((a,b) => extractTime(a.details).localeCompare(extractTime(b.details)))
                    .map(s => `  └ ${getStatusMark(s)} ${s.details}`).join('\n')
            ).join('\n');
            return `━━ ${date} ━━\n${facLines}`;
        }).join('\n\n');
    };

    const copyBtn = document.createElement('button');
    copyBtn.innerText = "結果をコピー";
    copyBtn.style.cssText = "flex:2; padding:12px; background:#2c3e50; color:#fff; border:none; border-radius:8px; font-weight:bold; cursor:pointer; font-size:12px;";
    copyBtn.onclick = () => {
        const footerSummary = `\n【除外内訳】\n` + [
            ...Object.entries(statsSummary.text).map(([k,v]) => `・検索キーワード(${k}): ${v}件`),
            ...Object.entries(statsSummary.time).map(([k,v]) => `・時間帯(${k}): ${v}件`),
            ...Object.entries(statsSummary.day).map(([k,v]) => `・${k}曜: ${v}件`),
            ...Object.entries(statsSummary.date).map(([k,v]) => `・日付(${k}): ${v}件`),
            ...Object.entries(statsSummary.fac).map(([k,v]) => `・施設(${shortenFac(k)}): ${v}件`)
        ].join('\n');
        const txt = `【三鷹テニス空き】 ${checkTime}\n時間帯: ${displayTimeFilter}\n範囲: ${dateRangeStr}\n${headerExSummary}\n\n`
                  + buildResultText() + footerSummary;
        navigator.clipboard.writeText(txt).then(() => {
            copyBtn.innerText = "コピー完了！";
            setTimeout(() => { copyBtn.innerText = "結果をコピー"; }, 1000);
        });
    };

    // ★【改善5】シェアボタン追加
    const shareBtn = document.createElement('button');
    shareBtn.innerText = "📤 シェア";
    shareBtn.style.cssText = "flex:1; padding:12px; background:#25d366; color:#fff; border:none; border-radius:8px; font-weight:bold; cursor:pointer; font-size:12px;";
    shareBtn.onclick = async () => {
        const shareText = `【三鷹テニス空き】 ${checkTime}\n時間帯: ${displayTimeFilter}\n範囲: ${dateRangeStr}\n\n`
                        + buildResultText()
                        + `\n\n🔗 https://www.yoyaku.mitaka.site/reservations`;

        if (navigator.share) {
            try {
                await navigator.share({
                    title: '🎾 三鷹テニスコートに空きあり！',
                    text: shareText
                });
            } catch (e) {
                // キャンセルは無視
                if (e.name !== 'AbortError') console.warn('Share error:', e);
            }
        } else {
            // Web Share API非対応ブラウザはクリップボードコピーにフォールバック
            await navigator.clipboard.writeText(shareText);
            shareBtn.innerText = "コピー完了！";
            setTimeout(() => { shareBtn.innerText = "📤 シェア"; }, 1500);
        }
    };

    bodyContainer.appendChild(tabArea);
    bodyContainer.appendChild(scrollArea);
    footer.appendChild(closeBtn);
    footer.appendChild(copyBtn);
    footer.appendChild(shareBtn); // ★ シェアボタンをフッターに追加
    bodyContainer.appendChild(footer);
    content.appendChild(bodyContainer);
    modal.appendChild(content);
    document.body.appendChild(modal);
    render();
    updateTabs();
}

  // setTimeout(createControlPanel, 500);
})();
