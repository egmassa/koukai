// ==UserScript==
// @name         都立公園テニスチェッカー
// @namespace    kouen-tennis-checker
// @version      1.8
// @description  都立公園テニスコートの空き時間帯を自動収集・表示
// -----------------------------------------------------------------------------
// 変更履歴
// 1.0 (2026-04-30) 初版
// 1.3 (2026-04-30) 表形式末尾切れ修正・時間帯ソート数値順統一
// 1.4 (2026-04-30) スマホパネルはみ出し修正（visualViewport対応）
// 1.5 (2026-04-30) initFacilityを週ごとに実行（スマホ2週目以降0件対策）
//                  APIレスポンス詳細デバッグログ追加
// 1.6 (2026-04-30) 全修正を統合。結果ヘッダーに有効フィルター表示を追加
// 1.7 (2026-09-18) 施設切替後の待機時間を設定画面で調整可能に（既定値400msは変更なし）。
//                  items異常時（0件等）やエラー時は自動で最大3回まで取り直すリトライを追加。
//                  取得に失敗した週はステータス表示・ログに❌で明記し、
//                  「本当に空きがない0件」と「取得失敗による0件」を区別できるように
//                  （ベータ版で検証：施設間の並列実行は都のサーバーが耐えられずエラー多発のため不採用。
//                  　待機時間の短縮も、PCでは0msでも問題ないがスマホでは不安定だったため既定値を維持）
// 1.8 (2026-09-25) 府中版の知見を反映。通信にタイムアウト（既定30秒・設定で変更可）を追加し、
//                  応答が返ってこない場合も「失敗」として取り直し→❌表示の仕組みに乗せた
//                  （以前は応答がないと画面が「N週目」のまま黙って止まり続けた）。
//                  ヘッダーにバージョン表示、完了時に所要時間をログ出力
// -----------------------------------------------------------------------------
// @match        https://kouen.sports.metro.tokyo.lg.jp/*
// @grant        GM_setClipboard
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    if (document.getElementById('_kouen_guard')) return;
    var g = document.createElement('div');
    g.id = '_kouen_guard'; g.style.display = 'none';
    (document.head || document.body).appendChild(g);

    /* ============================================================
       デフォルト設定
    ============================================================ */
    var DEFAULT_CONFIG = {
        facilities: [
            { name: '祖師谷公園',  bldCd: '1070',  instCd: '10700010', mode: '11' },
            { name: '高井戸公園',  bldCd: '1180',  instCd: '11800030', mode: '11' },
            { name: '小金井公園',  bldCd: '1240',  instCd: '12400020', mode: '11' },
            { name: '野川公園',    bldCd: '1260',  instCd: '12600010', mode: '11' },
            { name: '府中の森公園', bldCd: '1270',  instCd: '12700020', mode: '11' }
        ],
        enabledFacilities: ['祖師谷公園', '高井戸公園', '小金井公園', '野川公園', '府中の森公園'],
        youbi: [],       // [] = 全曜日
        jikan: [],       // [] = 全時間帯
        weeks: 8,        // 何週先まで検索
        startDate: '',   // '' = 今日
        initDelayMs: 400, // initFacility後の待機時間（ms）。短くする場合はリトライに頼る前提
        requestTimeoutSec: 30 // 通信の応答をこれ以上待たない（時間切れは「失敗」扱いで取り直し）
    };

    var SCRIPT_VERSION = '1.8'; // ヘッダー表示用。@versionと必ず一致させること

    var API_URL = '/web/rsvWOpeInstSrchVacantAjaxAction.do';
    var LOG = [];

    /* ============================================================
       ストレージ
    ============================================================ */
    var S = {
        get: function(k) { try { var v = localStorage.getItem('kouen_' + k); return v !== null ? JSON.parse(v) : undefined; } catch(e) { return undefined; } },
        set: function(k, v) { try { localStorage.setItem('kouen_' + k, JSON.stringify(v)); } catch(e) {} },
        del: function(k) { try { localStorage.removeItem('kouen_' + k); } catch(e) {} },
        cfg: function() {
            var saved = S.get('config') || {};
            // 施設マスタは常にDEFAULT_CONFIGを使用（スクリプト更新で自動反映）
            return {
                facilities:        DEFAULT_CONFIG.facilities,
                enabledFacilities: saved.enabledFacilities || DEFAULT_CONFIG.enabledFacilities,
                youbi:             saved.youbi  || DEFAULT_CONFIG.youbi,
                jikan:             saved.jikan  || DEFAULT_CONFIG.jikan,
                weeks:             saved.weeks  || DEFAULT_CONFIG.weeks,
                initDelayMs:       (typeof saved.initDelayMs === 'number') ? saved.initDelayMs : DEFAULT_CONFIG.initDelayMs,
                requestTimeoutSec: (typeof saved.requestTimeoutSec === 'number') ? saved.requestTimeoutSec : DEFAULT_CONFIG.requestTimeoutSec,
            };
        }
        };

    /* ============================================================
       ログ
    ============================================================ */
    function log(msg) {
        var t = new Date();
        var ts = t.getHours() + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
        var line = '[' + ts + '] ' + msg;
        LOG.push(line);
        if (LOG.length > 300) LOG.shift();
        try {
            var saved = JSON.parse(localStorage.getItem('kouen_log') || '[]');
            saved.push(line); if (saved.length > 300) saved = saved.slice(-300);
            localStorage.setItem('kouen_log', JSON.stringify(saved));
        } catch(e) {}
        renderLog();
        console.log('[都立公園チェッカー]', msg);
    }
    function pad(n) { return String(n).padStart(2, '0'); }

    /* ============================================================
       ステータス判定
       status: 100=空き, 110=一部空き, 200=空きなし(選択可能), 210=予約あり, 1=保守日, etc
    ============================================================ */
    function isAvailable(item) {
        var alt = item.alt || '';
        var img = item.imgURL || '';
        var s   = item.status;

        // altで空きと判定
        if (alt === '空き') return true;
        if (alt === '一部空き') return true;
        if (alt.indexOf('空き') >= 0 && alt.indexOf('予約') < 0 && alt.indexOf('なし') < 0) return true;

        // imgURLで判定（svg名に"vacant"や"available"）
        if (img.indexOf('calendar_vacant') >= 0) return true;
        if (img.indexOf('calendar_available') >= 0) return true;
        if (img.indexOf('calendar_parttime') >= 0) return true;
        // "full"や"maintenance"でなければ空きとみなす
        if (img.indexOf('calendar_') >= 0 &&
            img.indexOf('full') < 0 &&
            img.indexOf('maintenance') < 0 &&
            img.indexOf('holiday') < 0 &&
            img.indexOf('non_') < 0) return true;

        // statusで判定（100番台=空き、200番台=埋まり、1=保守）
        if (s !== undefined && s !== null) {
            if (s >= 100 && s < 200) return true;
        }

        return false;
    }

    function statusLabel(item) {
        var alt = item.alt || '';
        if (alt) return alt;
        var s = item.status;
        if (s >= 100 && s < 200) return '空き';
        if (s === 210) return '予約あり';
        if (s === 1)   return '保守日';
        return '不明(' + s + ')';
    }

    function formatTime(t) {
        // 900 → "9:00", 1100 → "11:00"
        var h = Math.floor(t / 100), m = t % 100;
        return h + ':' + (m < 10 ? '0' + m : m);
    }

    function formatDate(useDay) {
        // 20260520 → "5/20(水)"
        var s = String(useDay);
        var m = parseInt(s.slice(4,6)), d = parseInt(s.slice(6,8));
        var WDS = ['日','月','火','水','木','金','土'];
        var dt = new Date(parseInt(s.slice(0,4)), m-1, d);
        return m + '/' + d + '(' + WDS[dt.getDay()] + ')';
    }

    function isWeekend(useDay) {
        var s = String(useDay);
        var m = parseInt(s.slice(4,6)), d = parseInt(s.slice(6,8));
        var dt = new Date(parseInt(s.slice(0,4)), m-1, d);
        return dt.getDay() === 0 || dt.getDay() === 6;
    }

    function getWeekday(useDay) {
        var s = String(useDay);
        var m = parseInt(s.slice(4,6)), d = parseInt(s.slice(6,8));
        var WDS = ['日','月','火','水','木','金','土'];
        var dt = new Date(parseInt(s.slice(0,4)), m-1, d);
        return WDS[dt.getDay()];
    }

    /* ============================================================
       API呼び出し
    ============================================================ */
    var INIT_URL  = '/web/rsvWOpeInstSrchVacantAction.do';

    function requestTimeoutMs() {
        var sec = S.cfg().requestTimeoutSec;
        return (typeof sec === 'number' && sec > 0 ? sec : 30) * 1000;
    }

    // ① 施設ページを初期化（セッションCookieにdaystart等を設定させる）
    function initFacility(bldCd, instCd, useDay) {
        return new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', INIT_URL, true);
            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
            xhr.timeout = requestTimeoutMs();
            xhr.onload = function() { resolve(); };
            xhr.onerror = function() { resolve(); }; // エラーでも続行
            // 応答が返ってこない場合も続行する（直後のデータ取得の検査・取り直しで救済される）
            xhr.ontimeout = function() { log('  ⚠ 初期化の通信が' + (xhr.timeout/1000) + '秒応答なし'); resolve(); };
            var iniICd = instCd + '_3';
            var body = [
                'displayNo=prwrc2000',
                'displayNoFrm=prwrc2000',
                'applyFlg=0',
                'dayofweekClearFlg=1',
                'timezoneClearFlg=1',
                'selectPpsClsCd=1000',
                'selectPpsCd=1030',
                'selectBldCd=' + bldCd,
                'selectInstCd=' + instCd,
                'iniBCd=' + bldCd,
                'iniICd=' + iniICd,
                'useDay=' + useDay,
                'selectSize=0',
                'penaltyday=3',
                'selectAreaBcd=' + bldCd,
                'selectIcd=0',
                'initBcd=null',
                'initIcd=null',
                'initPpsClPpscd=null'
            ].join('&');
            xhr.send(body);
        });
    }

    // ② 週データをAjaxで取得
    function fetchWeek(bldCd, instCd, useDay, mode) {
        return new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', API_URL, true);
            xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
            xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            xhr.onload = function() {
                if (xhr.status === 200) {
                    try { resolve(JSON.parse(xhr.responseText)); }
                    catch(e) { reject(new Error('JSON parse error: ' + xhr.responseText.slice(0,100))); }
                } else {
                    reject(new Error('HTTP ' + xhr.status));
                }
            };
            xhr.onerror = function() { reject(new Error('Network error')); };
            // 応答が返ってこない場合は「失敗」として扱い、既存の取り直し→❌表示の仕組みに乗せる
            xhr.timeout = requestTimeoutMs();
            xhr.ontimeout = function() { reject(new Error('タイムアウト（' + (xhr.timeout/1000) + '秒応答なし）')); };
            xhr.send([
                'displayNo=prwrc2000',
                'useDay=' + useDay,
                'bldCd=' + bldCd,
                'instCd=' + instCd,
                'transVacantMode=' + (mode || '4'),
                'clearFlag=0'
            ].join('&'));
        });
    }

    /* ============================================================
       メイン処理
    ============================================================ */
    async function runSearch() {
        var runStartedAt = Date.now();
        var cfg = S.cfg();
        var enabledFacs = cfg.facilities.filter(function(f) {
            return cfg.enabledFacilities.indexOf(f.name) >= 0;
        });

        if (!enabledFacs.length) { log('施設が選択されていません'); return; }

        S.set('running', true);
        S.set('failCount', 0);
        updateButtons();

        // 開始日（今週の月曜）
        var startDate = cfg.startDate ? new Date(cfg.startDate) : new Date();
        // 月曜に合わせる
        var day = startDate.getDay();
        var diff = day === 0 ? -6 : 1 - day;
        startDate.setDate(startDate.getDate() + diff);

        function toUseDay(d) {
            return d.getFullYear() * 10000 + (d.getMonth()+1) * 100 + d.getDate();
        }

        var results = [];
        var totalWeeks = cfg.weeks || 8;
        var failCount = 0; // 最終的に取得失敗した週の数（サマリー表示用）
        var MAX_ATTEMPTS = 3; // 固定リトライ回数（初回+2回）

        // 施設ごとに全週を検索
        for (var fi = 0; fi < enabledFacs.length; fi++) {
            var fac = enabledFacs[fi];
            log('=== ' + fac.name + ' 開始 ===');

            var currentUseDay = toUseDay(startDate);

            for (var w = 0; w < totalWeeks; w++) {
                if (!S.get('running')) { log('停止しました'); break; }

                var data = null;
                var failReason = '';
                var attempt;
                for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                    // 各週ごとにinitFacility（スマホ新規セッションで2週目以降0件になる対策）
                    log('初期化中: ' + fac.name + ' ' + currentUseDay + (attempt > 1 ? '（' + attempt + '/' + MAX_ATTEMPTS + '回目）' : ''));
                    await initFacility(fac.bldCd, fac.instCd, currentUseDay);
                    await new Promise(function(r) { setTimeout(r, cfg.initDelayMs); });

                    log(fac.name + ' useDay=' + currentUseDay + ' (' + (w+1) + '/' + totalWeeks + '週目)');
                    setStatus(fac.name + ' ' + (w+1) + '/' + totalWeeks + '週目', 'blue');

                    try {
                        var candidate = await fetchWeek(fac.bldCd, fac.instCd, currentUseDay, fac.mode);
                        var candidateItems = 0;
                        if (candidate.result) {
                            candidate.result.forEach(function(tz){ candidateItems += tz.timeResult.length; });
                        }
                        if (candidateItems === 0) {
                            // items=0は「本当に対象外の週」ではなく、待機不足で
                            // サーバーの反映が間に合わなかった空振りの可能性があるため取り直す
                            failReason = 'items=0';
                            if (attempt < MAX_ATTEMPTS) {
                                log('  ⚠ items=0のため取り直します（' + attempt + '/' + MAX_ATTEMPTS + '）');
                                continue;
                            }
                            break; // 最大試行到達 → dataはnullのまま失敗扱い
                        }
                        data = candidate;
                        failReason = '';
                        break;
                    } catch(e) {
                        failReason = e.message;
                        if (attempt < MAX_ATTEMPTS) {
                            log('  ⚠ エラーのため取り直します（' + attempt + '/' + MAX_ATTEMPTS + '）: ' + e.message);
                            continue;
                        }
                        data = null;
                        break;
                    }
                }

                if (!data) {
                    failCount++;
                    log('  ❌ 取得失敗（' + MAX_ATTEMPTS + '回試行して断念）: ' + fac.name + ' ' + currentUseDay + ' 理由=' + failReason);
                }

                try {
                    var count = 0;

                    if (data && data.result) {
                        // デバッグ：items数とサンプルをログ出力
                        var totalItems = 0;
                        data.result.forEach(function(tz){ totalItems += tz.timeResult.length; });
                        if (totalItems > 0) {
                            var sample = data.result[0].timeResult[0];
                            log('  [DBG] items=' + totalItems + ' alt=' + sample.alt + ' status=' + sample.status);
                        } else {
                            log('  [DBG] result配列あり・timeResult合計0件');
                        }
                        data.result.forEach(function(tzone) {
                            tzone.timeResult.forEach(function(item) {
                                if (!isAvailable(item)) return;

                                // 曜日フィルター
                                var wd = getWeekday(item.useDay);
                                if (cfg.youbi.length && cfg.youbi.indexOf(wd) < 0) return;

                                // 時間帯フィルター
                                var timeStr = formatTime(item.startTime);
                                if (cfg.jikan.length && cfg.jikan.indexOf(timeStr) < 0) return;

                                // 今日以降のデータのみ保存
                                var today2 = new Date();
                                var todayInt2 = today2.getFullYear()*10000 + (today2.getMonth()+1)*100 + today2.getDate();
                                if (item.useDay < todayInt2) return; // 過去はスキップ

                                results.push({
                                    facility:  fac.name,
                                    useDay:    item.useDay,
                                    dateStr:   formatDate(item.useDay),
                                    weekday:   getWeekday(item.useDay),
                                    weekend:   isWeekend(item.useDay),
                                    startTime: item.startTime,
                                    endTime:   item.endTime,
                                    timeStr:   formatTime(item.startTime) + '～' + formatTime(item.endTime),
                                    timeStart: formatTime(item.startTime),
                                    status:    statusLabel(item)
                                });
                                count++;
                            });
                        });
                    } else {
                        log('  [DBG] data.result なし。キー=' + (data ? Object.keys(data).join(',') : '(取得失敗)'));
                    }
                    log('  → ' + count + '件 (累計' + results.length + '件)');

                    // 途中結果を随時表示
                    S.set('results', results.slice());
                    renderResults(results);

                    // 次週のuseDay をAPIレスポンスから取得（バリデーション付き）
                    if (data && data.nextWeekStartDay) {
                        var nw = data.nextWeekStartDay;
                        var nwYear = Math.floor(nw / 10000);
                        var today = new Date();
                        var todayInt = today.getFullYear()*10000 + (today.getMonth()+1)*100 + today.getDate();
                        // 返ってきた日付が過去や明らかにおかしい場合は+7日フォールバック
                        if (nwYear >= today.getFullYear() && nw >= todayInt) {
                            currentUseDay = nw;
                            log('  次週: ' + currentUseDay);
                        } else {
                            // 現在のuseDayに+7する（整数演算）
                            var cy = Math.floor(currentUseDay/10000);
                            var cm = Math.floor((currentUseDay%10000)/100);
                            var cd = currentUseDay % 100;
                            var dt = new Date(cy, cm-1, cd+7);
                            currentUseDay = dt.getFullYear()*10000 + (dt.getMonth()+1)*100 + dt.getDate();
                            log('  次週(+7日): ' + currentUseDay);
                        }
                    } else {
                        var cy2 = Math.floor(currentUseDay/10000);
                        var cm2 = Math.floor((currentUseDay%10000)/100);
                        var cd2 = currentUseDay % 100;
                        var dt2 = new Date(cy2, cm2-1, cd2+7);
                        currentUseDay = dt2.getFullYear()*10000 + (dt2.getMonth()+1)*100 + dt2.getDate();
                        log('  次週(フォールバック): ' + currentUseDay);
                    }

                } catch(e) {
                    log('エラー: ' + fac.name + ' ' + e.message);
                }

                await new Promise(function(r) { setTimeout(r, 300); });
            }
            log('=== ' + fac.name + ' 完了 ===');
        }

        S.set('results', results);
        S.set('lastUpdate', new Date().toISOString());
        S.set('running', false);
        S.set('failCount', failCount);

        var ts = results.length;
        log('=== 完了 ' + ts + '件 ===' + (failCount > 0 ? '（⚠取得失敗 ' + failCount + '週ぶん）' : ''));
        log('所要時間: ' + Math.round((Date.now() - runStartedAt) / 1000) + '秒');
        setStatus('完了！ 空きコマ ' + ts + '件' + (failCount > 0 ? '（失敗' + failCount + '件）' : ''), failCount > 0 ? 'orange' : 'green');
        renderResults(results);
        renderStats(results);
        updateButtons();
    }

    /* ============================================================
       表示
    ============================================================ */
    var _timeFilter = [], _facFilter = [], _viewMode = 'pivot';

    function isWeekendStr(ds) { return /[土日]/.test(ds); }

    function dateKey(ds) {
        var m = ds.match(/(\d+)\/(\d+)/);
        return m ? ('0'+m[1]).slice(-2) + ('0'+m[2]).slice(-2) : ds;
    }

    function facShort(f) { return f.replace('テニス人工芝','').replace('テニス（人工芝）','').trim(); }

    function applyFilters(results) {
        return results.filter(function(s) {
            var okTime = !_timeFilter.length || _timeFilter.indexOf(s.timeStart) >= 0;
            var okFac  = !_facFilter.length  || _facFilter.indexOf(s.facility)  >= 0;
            return okTime && okFac;
        });
    }

    // Android対応：高さをJSで制御
    function setResultsHeight() {
        var el = document.getElementById('ko-results');
        var pane = document.getElementById('ko-pane-results');
        if (!el || !pane) return;

        var wb  = document.getElementById('ko-week-body');
        var pb  = document.getElementById('ko-pivot-body');
        var wh  = document.getElementById('ko-week-header');
        var ph  = document.getElementById('ko-pivot-header');

        // フィルターエリア（updBar+ctrl+コピーボタン）の高さを実測
        var usedH = 0;
        el.childNodes.forEach(function(node) {
            if (node !== document.getElementById('ko-pivot-wrap') &&
                node !== document.getElementById('ko-week-wrap')) {
                usedH += (node.offsetHeight || 0);
            }
        });

        // 利用可能な高さをBoundingClientRectで実測
        // パネル下端 - ko-results上端 - 下部padding(8px) - 余白(10px) - フィルター等
        var panelEl = document.getElementById('kouen-panel');
        var availH;
        if (panelEl) {
            var panelBottom = panelEl.getBoundingClientRect().bottom;
            var elTop       = el.getBoundingClientRect().top;
            availH = panelBottom - elTop - 18 - usedH;
        } else {
            var vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
            availH = Math.floor(vh * 0.9) - usedH - 10;
        }
        if (availH < 150) availH = 150;

        if (_viewMode === 'week') {
            el.style.height = '';
            el.style.overflowY = 'visible';
            el.style.overflow = 'visible';
            if (pb) { pb.style.height = ''; pb.style.overflowY = ''; pb.style.overflow = ''; }
            if (wb && wh) {
                var headerH = wh.offsetHeight || 30;
                var bodyH = availH - headerH;
                if (bodyH < 100) bodyH = 100;
                wb.style.height = bodyH + 'px';
                wb.style.overflowY = 'scroll';
                wb.style.overflowX = 'auto';
                wb.style.webkitOverflowScrolling = 'touch';
                wb.style.overscrollBehavior = 'contain';
            }
        } else {
            el.style.overflow = 'visible';
            el.style.overflowY = 'visible';
            el.style.maxHeight = '';
            el.style.height = '';
            if (wb) { wb.style.height = ''; wb.style.overflowY = ''; wb.style.overflow = ''; }
            if (pb && ph) {
                var pHeaderH = ph.offsetHeight || 30;
                var pBodyH = availH - pHeaderH;
                if (pBodyH < 100) pBodyH = 100;
                pb.style.height = pBodyH + 'px';
                pb.style.overflowY = 'scroll';
                pb.style.overflowX = 'auto';
                pb.style.webkitOverflowScrolling = 'touch';
                pb.style.overscrollBehavior = 'contain';
            }
        }
    }

    function renderResults(results) {
        var el = document.getElementById('ko-results');
        if (!el) return;
        var badge = document.getElementById('ko-tab-results');
        if (badge) badge.textContent = '結果(' + results.length + ')';

        // 取得失敗があれば、空き0件かどうかに関わらず必ず分かりやすく案内する
        var failCountR = S.get('failCount') || 0;
        var failBanner = '';
        if (failCountR > 0) {
            failBanner =
                '<div style="background:#fff3e0;border:2px solid #f57c00;border-radius:8px;padding:10px;margin:8px;font-size:12px;color:#e65100;">' +
                '<div style="font-weight:bold;margin-bottom:4px;">⚠ ' + failCountR + '週ぶん、情報を取得できませんでした</div>' +
                '<div>サイトが混み合っていた可能性があります。下にある「空きコマなし」や件数は<b>不正確な場合があります</b>。' +
                'お手数ですが、<b>もう一度「検索する」ボタンを押して</b>取得し直してください。</div>' +
                '</div>';
        }

        if (!results.length) {
            el.innerHTML = failBanner + '<div style="color:#999;font-size:11px;padding:8px;">空きコマなし</div>';
            return;
        }

        // 取得日時バー
        var lastUpdBar = S.get('lastUpdate');
        var updBar = '';
        if (lastUpdBar) {
            var luB = new Date(lastUpdBar);
            var updStrB = luB.getFullYear() + '/' + (luB.getMonth()+1) + '/' + luB.getDate() +
                         ' ' + luB.getHours() + ':' + ('0'+luB.getMinutes()).slice(-2);
            var diffMinB = Math.floor((Date.now() - luB.getTime()) / 60000);
            var diffStrB = diffMinB < 60 ? diffMinB + '分前' :
                           diffMinB < 1440 ? Math.floor(diffMinB/60) + '時間前' :
                           Math.floor(diffMinB/1440) + '日前';
            updBar = '<div style="background:#f5f5f5;border-bottom:1px solid #e0e0e0;padding:4px 8px;font-size:10px;color:#666;display:flex;justify-content:space-between;">' +
                '<span>🕒 取得: ' + updStrB + '</span>' +
                '<span style="color:#999;">（' + diffStrB + '）</span>' +
                '</div>';
        }

        // 有効フィルターバー（曜日・時間が絞られている場合に表示）
        var filterBar = '';
        var cfg2 = S.cfg();
        var filterParts = [];
        if (cfg2.youbi && cfg2.youbi.length) filterParts.push('曜日: ' + cfg2.youbi.join('・'));
        if (_timeFilter.length)              filterParts.push('時間: ' + _timeFilter.join(', '));
        if (_facFilter.length)               filterParts.push('施設: ' + _facFilter.join(', '));
        if (filterParts.length) {
            filterBar = '<div style="background:#fff8e1;border-bottom:1px solid #ffe082;padding:3px 8px;font-size:10px;color:#795548;">' +
                '🔍 ' + filterParts.join('　') + '</div>';
        }

        var allTimes = [], allFacs = [];
        results.forEach(function(s) {
            if (allTimes.indexOf(s.timeStart) < 0) allTimes.push(s.timeStart);
            if (allFacs.indexOf(s.facility)   < 0) allFacs.push(s.facility);
        });
        allTimes.sort(function(a,b){ return parseInt(a)-parseInt(b); }); allFacs.sort();

        var BG = '#1a7a3c';

        function pillBtn(cls, val, label, active) {
            return '<button class="' + cls + '" data-v="' + val + '" style="' +
                'padding:4px 8px;font-size:10px;border-radius:12px;cursor:pointer;margin:2px;' +
                'border:1px solid ' + (active ? BG : '#ddd') + ';' +
                'background:' + (active ? BG : 'white') + ';' +
                'color:' + (active ? 'white' : '#555') + ';' +
                'font-weight:' + (active ? 'bold' : 'normal') + ';">' + label + '</button>';
        }

        // コントロールバー
        var ctrl = '<div style="padding:4px;border-bottom:2px solid #f0f0f0;">';
        ctrl += '<div style="display:flex;gap:4px;margin-bottom:4px;">';
        ctrl += pillBtn('ko-vm', 'pivot', '📋 表形式', _viewMode==='pivot');
        ctrl += pillBtn('ko-vm', 'week',  '📅 週別',   _viewMode==='week');
        ctrl += '</div>';

        ctrl += '<div style="display:flex;flex-wrap:wrap;gap:2px;margin-bottom:3px;align-items:center;">';
        ctrl += '<span style="font-size:9px;color:#888;margin-right:2px;">時間</span>';
        ctrl += pillBtn('ko-tf', '__all', '全時間', !_timeFilter.length);
        allTimes.forEach(function(t) { ctrl += pillBtn('ko-tf', t, t, _timeFilter.indexOf(t)>=0); });
        ctrl += '</div>';

        ctrl += '<div style="display:flex;flex-wrap:wrap;gap:2px;align-items:center;">';
        ctrl += '<span style="font-size:9px;color:#888;margin-right:2px;">施設</span>';
        ctrl += pillBtn('ko-ff', '__all', '全施設', !_facFilter.length);
        allFacs.forEach(function(f) { ctrl += pillBtn('ko-ff', f, facShort(f), _facFilter.indexOf(f)>=0); });
        ctrl += '</div>';

        // コピーボタン
        ctrl += '<div style="display:flex;gap:4px;margin-top:4px;padding-top:4px;border-top:1px solid #eee;">';
        ctrl += '<button id="ko-copy" style="flex:1;padding:5px;font-size:10px;background:#4CAF50;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:bold;">📋 テキスト</button>';
        ctrl += '<button id="ko-copyimg" style="flex:1;padding:5px;font-size:10px;background:#2196F3;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:bold;">📷 画像</button>';
        ctrl += '</div>';
        ctrl += '</div>';

        var filtered = applyFilters(results);
        var body = _viewMode === 'pivot' ? renderPivot(filtered) : renderWeek(filtered);
        el.innerHTML = failBanner + updBar + filterBar + ctrl + body;
        // innerHTML設定後に高さを2段階で設定（ブラウザのレイアウト完了を待つ）
        setTimeout(setResultsHeight, 100);
        setTimeout(setResultsHeight, 400);

        // イベント
        el.querySelectorAll('.ko-vm').forEach(function(b) {
            b.onclick = function() { _viewMode = this.getAttribute('data-v'); renderResults(results); };
        });
        el.querySelectorAll('.ko-tf').forEach(function(b) {
            b.onclick = function() {
                var v = this.getAttribute('data-v');
                if (v === '__all') { _timeFilter = []; }
                else { var i = _timeFilter.indexOf(v); if (i>=0) _timeFilter.splice(i,1); else _timeFilter.push(v); }
                renderResults(results);
            };
        });
        el.querySelectorAll('.ko-ff').forEach(function(b) {
            b.onclick = function() {
                var v = this.getAttribute('data-v');
                if (v === '__all') { _facFilter = []; }
                else { var i = _facFilter.indexOf(v); if (i>=0) _facFilter.splice(i,1); else _facFilter.push(v); }
                renderResults(results);
            };
        });

        // テキストコピー
        var copyBtn = document.getElementById('ko-copy');
        if (copyBtn) {
            copyBtn.onclick = function() {
                var filtered2 = applyFilters(results);
                var allTimesT = [], allFacsT = [];
                results.forEach(function(s) {
                    if (allTimesT.indexOf(s.timeStart)<0) allTimesT.push(s.timeStart);
                    if (allFacsT.indexOf(s.facility)<0)  allFacsT.push(s.facility);
                });
                allTimesT.sort(function(a,b){ return parseInt(a)-parseInt(b); });
                allFacsT.sort();
                var lastUpd = S.get('lastUpdate');
                var updLbl = '不明';
                if (lastUpd) {
                    var u = new Date(lastUpd);
                    updLbl = u.getFullYear() + '/' + (u.getMonth()+1) + '/' + u.getDate() +
                             ' ' + u.getHours() + ':' + pad(u.getMinutes());
                }
                var now = new Date();
                var nowLbl = now.getFullYear() + '/' + (now.getMonth()+1) + '/' + now.getDate() +
                             ' ' + now.getHours() + ':' + pad(now.getMinutes());

                var timeLbl = (_timeFilter.length ? _timeFilter : allTimesT).join(', ');
                var facLbl  = (_facFilter.length  ? _facFilter  : allFacsT).join(', ');

                var byDate = {};
                filtered2.forEach(function(s) {
                    if (!byDate[s.dateStr]) byDate[s.dateStr] = {};
                    if (!byDate[s.dateStr][s.facility]) byDate[s.dateStr][s.facility] = [];
                    byDate[s.dateStr][s.facility].push(s.timeStr);
                });

                var lines = [
                    '🎾 都立公園 テニスコート 空き状況',
                    '🕒 データ取得: ' + updLbl,
                    '📝 作成: ' + nowLbl,
                    '⏰ 時間帯: ' + timeLbl,
                    '🏟 施設: ' + facLbl,
                    ''
                ];
                Object.keys(byDate).sort(function(a,b){ return dateKey(a)>dateKey(b)?1:-1; }).forEach(function(ds) {
                    var weekend = isWeekendStr(ds);
                    lines.push((weekend?'🔴':'') + '【' + ds + '】');
                    Object.keys(byDate[ds]).sort().forEach(function(f) {
                        lines.push('  ' + f + ': ' + byDate[ds][f].join(' '));
                    });
                    lines.push('');
                });

                var text = lines.join('\n');
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(function() {
                        copyBtn.textContent = '✓ コピーしました！';
                        setTimeout(function(){ copyBtn.textContent = '📋 テキストコピー'; }, 2000);
                    }).catch(function(){ showCopyFallback(text); });
                } else { showCopyFallback(text); }
            };
        }

        // 画像コピーボタン
        var copyImgBtn = document.getElementById('ko-copyimg');
        if (copyImgBtn) {
            copyImgBtn.onclick = async function() {
                if (typeof html2canvas !== 'function') { alert('html2canvasが読み込まれていません'); return; }
                copyImgBtn.textContent = '⏳ 生成中...';
                copyImgBtn.disabled = true;
                try {
                    var resultsEl = document.getElementById('ko-results');
                    var origH = resultsEl.style.height;
                    var origOvY = resultsEl.style.overflowY;
                    resultsEl.style.height = 'auto';
                    resultsEl.style.overflowY = 'visible';
                    resultsEl.style.overflow = 'visible';
                    var weekBody = document.getElementById('ko-week-body');
                    var origWH = weekBody ? weekBody.style.height : null;
                    var origWO = weekBody ? weekBody.style.overflowY : null;
                    if (weekBody) { weekBody.style.height='auto'; weekBody.style.overflowY='visible'; weekBody.style.overflow='visible'; }
                    var pivotBody = document.getElementById('ko-pivot-body');
                    var origPH = pivotBody ? pivotBody.style.height : null;
                    var origPO = pivotBody ? pivotBody.style.overflowY : null;
                    if (pivotBody) { pivotBody.style.height='auto'; pivotBody.style.overflowY='visible'; pivotBody.style.overflow='visible'; }
                    // 条件ヘッダー挿入
                    var headerEl = document.createElement('div');
                    var now = new Date();
                    var dateLbl = now.getFullYear()+'/'+(now.getMonth()+1)+'/'+now.getDate()+' '+now.getHours()+':'+('0'+now.getMinutes()).slice(-2);
                    var lastUpd2 = S.get('lastUpdate');
                    var updLbl2 = lastUpd2 ? (function(){ var u=new Date(lastUpd2); return u.getFullYear()+'/'+(u.getMonth()+1)+'/'+u.getDate()+' '+u.getHours()+':'+('0'+u.getMinutes()).slice(-2); })() : '不明';
                    var allT2=[],allF2=[]; results.forEach(function(s){ if(allT2.indexOf(s.timeStart)<0)allT2.push(s.timeStart); if(allF2.indexOf(s.facility)<0)allF2.push(s.facility); }); allT2.sort(function(a,b){ return parseInt(a)-parseInt(b); }); allF2.sort();
                    headerEl.style.cssText = 'background:linear-gradient(135deg,#1a7a3c,#2a9a5c);color:white;padding:10px 14px;font-family:sans-serif;';
                    headerEl.innerHTML = '<div style="font-size:14px;font-weight:bold;margin-bottom:4px;">🎾 都立公園 テニスコート 空き状況</div>'+
                        '<div style="font-size:10px;opacity:0.95;line-height:1.6;">'+
                        '🕒 データ取得: '+updLbl2+'（画像作成: '+dateLbl+'）<br>'+
                        '⏰ 時間帯('+ (_timeFilter.length?_timeFilter.length+'/'+allT2.length:'全'+allT2.length)+'): '+(_timeFilter.length?_timeFilter:allT2).join(', ')+'<br>'+
                        '🏟 施設('+ (_facFilter.length?_facFilter.length+'/'+allF2.length:'全'+allF2.length)+'): '+(_facFilter.length?_facFilter:allF2).map(facShort).join(', ')+
                        '</div>';
                    resultsEl.insertBefore(headerEl, resultsEl.firstChild);
                    await new Promise(function(r){ setTimeout(r, 200); });
                    var canvas = await html2canvas(resultsEl, { backgroundColor:'#ffffff', scale:2, logging:false, width:resultsEl.scrollWidth, height:resultsEl.scrollHeight, windowWidth:Math.max(resultsEl.scrollWidth,window.innerWidth), windowHeight:Math.max(resultsEl.scrollHeight,window.innerHeight) });
                    resultsEl.style.height=origH; resultsEl.style.overflowY=origOvY; resultsEl.style.overflow='';
                    if(weekBody){ weekBody.style.height=origWH; weekBody.style.overflowY=origWO; weekBody.style.overflow=''; }
                    if(pivotBody){ pivotBody.style.height=origPH; pivotBody.style.overflowY=origPO; pivotBody.style.overflow=''; }
                    if(headerEl.parentNode) headerEl.parentNode.removeChild(headerEl);
                    setResultsHeight();
                    showImageModal(canvas);
                    copyImgBtn.textContent = '📷 画像';
                    copyImgBtn.disabled = false;
                } catch(e) {
                    alert('画像生成失敗: '+e.message);
                    copyImgBtn.textContent = '📷 画像';
                    copyImgBtn.disabled = false;
                }
            };
        }
    }

    function renderPivot(filtered) {
        var allFacs = [], allDates = [];
        filtered.forEach(function(s) {
            if (allFacs.indexOf(s.facility)  < 0) allFacs.push(s.facility);
            if (allDates.indexOf(s.dateStr)  < 0) allDates.push(s.dateStr);
        });
        allFacs.sort();
        allDates.sort(function(a,b){ return dateKey(a)>dateKey(b)?1:-1; });

        var pivot = {};
        filtered.forEach(function(s) {
            if (!pivot[s.dateStr]) pivot[s.dateStr] = {};
            if (!pivot[s.dateStr][s.facility]) pivot[s.dateStr][s.facility] = {};
            pivot[s.dateStr][s.facility][s.timeStr] = (pivot[s.dateStr][s.facility][s.timeStr]||0)+1;
        });

        if (!allDates.length) return '<div style="color:#999;font-size:11px;padding:8px;">該当なし</div>';

        var BG = '#1a7a3c';
        var th = 'padding:5px 4px;font-size:10px;text-align:center;white-space:nowrap;border:1px solid #3a9a5c;background:'+BG+';color:white;font-weight:bold;';
        var td = 'padding:3px;font-size:9px;text-align:center;border:1px solid #eee;vertical-align:top;';
        var tdDate = td + 'font-weight:bold;white-space:nowrap;';

        var colWidth = Math.floor(85/allFacs.length) + '%';
        // ヘッダーテーブル（固定）
        var headerHtml = '<div id="ko-pivot-header" style="overflow:hidden;flex-shrink:0;">';
        headerHtml += '<table style="border-collapse:collapse;width:100%;table-layout:fixed;">';
        headerHtml += '<colgroup><col style="width:70px;">';
        allFacs.forEach(function(){ headerHtml += '<col style="width:' + colWidth + ';">'; });
        headerHtml += '</colgroup><tr>';
        headerHtml += '<th style="' + th + '">日付</th>';
        allFacs.forEach(function(f){ headerHtml += '<th style="' + th + '">' + facShort(f) + '</th>'; });
        headerHtml += '</tr></table></div>';

        // データテーブル（スクロール）
        var html = '<div id="ko-pivot-body" style="overflow-y:scroll;overflow-x:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;">';
        html += '<table style="border-collapse:collapse;width:100%;table-layout:fixed;">';
        html += '<colgroup><col style="width:70px;">';
        allFacs.forEach(function(){ html += '<col style="width:' + colWidth + ';">'; });
        html += '</colgroup>';

        allDates.forEach(function(ds) {
            var hasData = allFacs.some(function(f){ return pivot[ds] && pivot[ds][f]; });
            if (!hasData) return;
            var wknd = isWeekendStr(ds);
            var dateStyle = tdDate + (wknd ? 'color:#c00;background:#fff5f5;' : 'color:#333;background:#fafafa;');
            html += '<tr><td style="' + dateStyle + '">' + ds + '</td>';
            allFacs.forEach(function(f) {
                var cd = pivot[ds] && pivot[ds][f];
                if (!cd) { html += '<td style="' + td + 'color:#e0e0e0;">-</td>'; return; }
                var times = Object.keys(cd).sort(function(a,b){ return parseInt(a)-parseInt(b); });
                var bg = wknd ? '#fff0f0' : '#f0fff4';
                var cells = times.map(function(t) {
                    var n = cd[t];
                    var s = t.replace(/:00/g,'').replace(/[\u301c\uff5e~]/g,'-');
                    return '<div style="background:' + (wknd?'#ffd0d0':'#c8f0d8') + ';border-radius:3px;padding:1px 3px;margin:1px;white-space:nowrap;font-size:9px;">'
                        + s + (n>1?'<b style="color:'+(wknd?'#a00':'#060')+';">×'+n+'</b>':'') + '</div>';
                }).join('');
                html += '<td style="' + td + 'background:' + bg + ';">' + cells + '</td>';
            });
            html += '</tr>';
        });
        html += '</table></div>';
        return '<div id="ko-pivot-wrap" style="display:flex;flex-direction:column;">' + headerHtml + html + '</div>';
    }

    function renderWeek(filtered) {
        var WDS = ['月','火','水','木','金','土','日'];

        function parseDate(ds) {
            var m = ds.match(/(\d+)\/(\d+)[（(]([月火水木金土日])[）)]/);
            return m ? { month:+m[1], day:+m[2], wd:m[3], ds:ds } : null;
        }

        var pivot = {};
        filtered.forEach(function(s) {
            if (!pivot[s.dateStr]) pivot[s.dateStr] = {};
            if (!pivot[s.dateStr][s.facility]) pivot[s.dateStr][s.facility] = [];
            pivot[s.dateStr][s.facility].push(s.timeStr);
        });

        var dates = Object.keys(pivot).sort(function(a,b){ return dateKey(a)>dateKey(b)?1:-1; });
        if (!dates.length) return '<div style="color:#999;font-size:11px;padding:8px;">該当なし</div>';

        function wdIdx(ds) {
            var m = ds.match(/[(（]([月火水木金土日])[)）]/);
            return m ? WDS.indexOf(m[1]) : -1;
        }

        var weekMap = {}, weekKeys = [];
        dates.forEach(function(ds) {
            var wi = wdIdx(ds);
            var key = dateKey(ds);
            var monKey = String(parseInt(key) - wi).padStart(4,'0');
            if (!weekMap[monKey]) { weekMap[monKey] = {}; weekKeys.push(monKey); }
            weekMap[monKey][ds] = pivot[ds];
        });
        weekKeys.sort();

        var BG = '#1a7a3c';
        var thStyle = 'padding:4px 3px;font-size:10px;text-align:center;background:' + BG + ';color:white;border:1px solid #3a9a5c;min-width:38px;';
        var tdStyle = 'padding:3px 2px;font-size:9px;text-align:center;border:1px solid #eee;vertical-align:top;min-width:38px;';

        // ヘッダー固定（fc-week-headerと同じ方式）
        var header = '<div id="ko-week-header" style="overflow:hidden;flex-shrink:0;">';
        header += '<table style="border-collapse:collapse;width:100%;table-layout:fixed;">';
        header += '<colgroup><col style="width:50px;">';
        WDS.forEach(function(){ header += '<col>'; });
        header += '</colgroup><tr>';
        header += '<th style="' + thStyle + '">週</th>';
        WDS.forEach(function(wd) {
            var wknd = wd==='土'||wd==='日';
            header += '<th style="' + thStyle + (wknd?'color:#c8ffd4;':'') + '">' + wd + '</th>';
        });
        header += '</tr></table></div>';

        // データ（スクロール）
        var body = '<div id="ko-week-body" style="overflow-y:scroll;overflow-x:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;">';
        body += '<table style="border-collapse:collapse;width:100%;table-layout:fixed;">';
        body += '<colgroup><col style="width:50px;">';
        WDS.forEach(function(){ body += '<col>'; });
        body += '</colgroup>';

        weekKeys.forEach(function(wk) {
            var dsMap = weekMap[wk];
            var firstDs = Object.keys(dsMap).sort(function(a,b){ return dateKey(a)>dateKey(b)?1:-1; })[0];
            var parsed = parseDate(firstDs);
            var weekLabel = parsed ? (parsed.month + '/' + parsed.day) : wk;

            body += '<tr>';
            body += '<td style="' + tdStyle + 'font-weight:bold;color:' + BG + ';white-space:nowrap;background:#f0fff4;">' + weekLabel + '</td>';
            WDS.forEach(function(wd) {
                var ds = Object.keys(dsMap).find(function(d){ return d.indexOf('('+wd+')')>=0; });
                var wknd = wd==='土'||wd==='日';
                if (!ds) { body += '<td style="' + tdStyle + 'color:#e8e8e8;">-</td>'; return; }
                var facData = dsMap[ds];
                var bg = wknd ? '#fff0f0' : '#f0fff0';
                var dateLabel = ds.replace(/[(（][月火水木金土日][)）]/,'');
                var cellContent = '<div style="font-size:8px;color:#888;margin-bottom:1px;">' + dateLabel + '</div>';
                cellContent += Object.keys(facData).map(function(f) {
                    var tStrs = facData[f].slice().sort(function(a,b){ return parseInt(a)-parseInt(b); }).map(function(t){
                        return t.replace(/:00/g,'').replace(/[\u301c\uff5e~]/g,'-');
                    }).join(' ');
                    return '<div style="background:' + (wknd?'#ffc8c8':'#c8f0c8') + ';border-radius:2px;padding:1px 2px;margin:1px;font-size:8px;">'
                        + '<b>' + facShort(f) + '</b> ' + tStrs + '</div>';
                }).join('');
                body += '<td style="' + tdStyle + 'background:' + bg + ';">' + cellContent + '</td>';
            });
            body += '</tr>';
        });
        body += '</table></div>';

        return '<div id="ko-week-wrap" style="display:flex;flex-direction:column;">' + header + body + '</div>';
    }

    function renderStats(results) {
        var el = document.getElementById('ko-stats');
        if (!el) return;
        if (!results.length) { el.innerHTML = '<div style="color:#999;font-size:11px;">データなし</div>'; return; }
        var by = {};
        results.forEach(function(s) {
            if (!by[s.facility]) by[s.facility] = { total:0, dates:{} };
            by[s.facility].total++;
            by[s.facility].dates[s.dateStr] = (by[s.facility].dates[s.dateStr]||0)+1;
        });
        var html = '<div style="font-size:11px;font-weight:bold;margin-bottom:6px;">施設別サマリー</div>';
        Object.keys(by).sort().forEach(function(f) {
            var info = by[f];
            var dayCount = Object.keys(info.dates).length;
            html += '<div style="padding:4px 0;border-bottom:1px solid #f0f0f0;">';
            html += '<div style="display:flex;justify-content:space-between;font-size:10px;font-weight:bold;">'
                + '<span>' + f + '</span><span style="color:#1a7a3c;">' + dayCount + '日 / ' + info.total + 'コマ</span></div>';
            var dStrs = Object.keys(info.dates).sort().map(function(d){ return d+':'+info.dates[d]; }).join('　');
            html += '<div style="font-size:9px;color:#888;margin-top:1px;">' + dStrs + '</div>';
            html += '</div>';
        });
        el.innerHTML = html;
    }

    function renderLog() {
        var el = document.getElementById('ko-log');
        if (!el) return;
        try {
            var saved = JSON.parse(localStorage.getItem('kouen_log') || '[]');
            var logText = saved.slice().reverse().join('\n');
            var copyBtn = '<button id="ko-log-copy" style="width:100%;padding:5px;margin-bottom:6px;background:#555;color:white;border:none;border-radius:4px;font-size:10px;cursor:pointer;">📋 ログをコピー</button>';
            el.innerHTML = copyBtn + saved.slice().reverse().map(function(l) {
                return '<div style="font-size:10px;color:#555;padding:1px 0;border-bottom:1px solid #f5f5f5;">' + l + '</div>';
            }).join('');
            var btn = document.getElementById('ko-log-copy');
            if (btn) btn.addEventListener('click', function() {
                var b = this;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(logText).then(function() {
                        b.textContent = '✓ コピーしました';
                        setTimeout(function(){ b.textContent = '📋 ログをコピー'; }, 2000);
                    }).catch(function(){ alert(logText); });
                } else { alert(logText); }
            });
        } catch(e) {}
    }

    function renderSettings() {
        var el = document.getElementById('ko-settings');
        if (!el) return;
        var cfg = S.cfg();

        function selBtn(id, val, label, active) {
            var bg = active ? '#1a7a3c' : 'white';
            var cl = active ? 'white' : '#333';
            var bd = active ? '#1a7a3c' : '#ccc';
            return '<button id="' + id + '" data-v="' + val + '" style="' +
                'padding:10px 16px;font-size:13px;border-radius:8px;cursor:pointer;margin:3px;' +
                'border:2px solid ' + bd + ';background:' + bg + ';color:' + cl + ';' +
                'font-weight:' + (active?'bold':'normal') + ';min-height:44px;">' + label + '</button>';
        }

        var cfg = S.cfg();
        var weeks = cfg.weeks || 8;
        var youbi = cfg.youbi || [];
        var jikan = cfg.jikan || [];
        var enabledFacs = cfg.enabledFacilities || [];
        var facilities = cfg.facilities || [];
        var wds = ['月','火','水','木','金','土','日'];
        var times = ['9:00','11:00','13:00','15:00','17:00','19:00'];

        var html = '<div style="padding:4px;">';

        // 検索週数
        html += '<div style="margin-bottom:14px;">';
        html += '<div style="font-size:11px;font-weight:bold;color:#555;margin-bottom:6px;">📆 検索週数</div>';
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
        [4,8,12].forEach(function(n) {
            html += selBtn('s-weeks-' + n, n, n + '週', weeks === n);
        });
        html += '</div></div>';

        // 曜日
        html += '<div style="margin-bottom:14px;">';
        html += '<div style="font-size:11px;font-weight:bold;color:#555;margin-bottom:6px;">📅 曜日（未選択=全曜日）</div>';
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
        wds.forEach(function(w) {
            html += selBtn('s-wd-' + w, w, w, youbi.indexOf(w) >= 0);
        });
        html += '</div></div>';

        // 時間帯
        html += '<div style="margin-bottom:14px;">';
        html += '<div style="font-size:11px;font-weight:bold;color:#555;margin-bottom:6px;">⏰ 時間帯（未選択=全時間帯）</div>';
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
        times.forEach(function(t) {
            html += selBtn('s-jk-' + t.replace(':',''), t, t, jikan.indexOf(t) >= 0);
        });
        html += '</div></div>';

        // 施設
        html += '<div style="margin-bottom:14px;">';
        html += '<div style="font-size:11px;font-weight:bold;color:#555;margin-bottom:6px;">🏟 対象施設</div>';
        html += '<div style="display:flex;flex-direction:column;gap:6px;">';
        facilities.forEach(function(f) {
            var active = enabledFacs.indexOf(f.name) >= 0;
            html += '<div style="display:flex;align-items:center;gap:8px;">';
            html += selBtn('s-fac-' + f.bldCd, f.name, (active ? '✓ ' : '') + f.name, active);
            html += '<span style="font-size:9px;color:#aaa;">inst:' + f.instCd + '</span>';
            html += '</div>';
        });
        html += '</div>';
        html += '<div style="display:flex;gap:6px;margin-top:8px;">';
        html += '<button id="s-add-fac" style="padding:10px 14px;font-size:12px;border:2px solid #1a7a3c;border-radius:8px;cursor:pointer;background:white;color:#1a7a3c;min-height:44px;">＋ 手動追加</button>';
        html += '<button id="s-detect-fac" style="padding:10px 14px;font-size:12px;border:2px solid #2196F3;border-radius:8px;cursor:pointer;background:#2196F3;color:white;min-height:44px;">🔍 ページから検出</button>';
        html += '</div></div>';

        // 開始日
        html += '<div style="margin-bottom:14px;">';
        html += '<div style="font-size:11px;font-weight:bold;color:#555;margin-bottom:6px;">📅 検索開始日（空欄=今日）</div>';
        html += '<input id="s-date" type="text" placeholder="例: 2026/5/1" value="' + (cfg.startDate||'') + '" ';
        html += 'style="width:100%;font-size:14px;border:2px solid #ccc;border-radius:8px;padding:10px;box-sizing:border-box;">';
        html += '</div>';

        // 初期化後の待機時間
        html += '<div style="margin-bottom:14px;">';
        html += '<div style="font-size:11px;font-weight:bold;color:#555;margin-bottom:6px;">🧪 施設切替後の待機時間（ms）</div>';
        html += '<div style="font-size:10px;color:#888;margin-bottom:6px;">短くすると速くなりますが、失敗が増えると自動リトライで逆に遅くなることがあります。既定値は400です。</div>';
        html += '<input id="s-delay" type="number" min="0" step="50" value="' + (cfg.initDelayMs != null ? cfg.initDelayMs : 400) + '" ';
        html += 'style="width:100%;font-size:14px;border:2px solid #ccc;border-radius:8px;padding:10px;box-sizing:border-box;">';
        html += '</div>';

        // 通信のタイムアウト
        html += '<div style="margin-bottom:14px;">';
        html += '<div style="font-size:11px;font-weight:bold;color:#555;margin-bottom:6px;">⏱ 応答待ちの上限（秒）</div>';
        html += '<div style="font-size:10px;color:#888;margin-bottom:6px;">これ以上応答がないと失敗扱いにして取り直します。サイトが混雑する日は長めに。既定値は30です。</div>';
        html += '<input id="s-timeout" type="number" min="5" step="5" value="' + (cfg.requestTimeoutSec || 30) + '" ';
        html += 'style="width:100%;font-size:14px;border:2px solid #ccc;border-radius:8px;padding:10px;box-sizing:border-box;">';
        html += '</div>';

        html += '<button id="s-save" style="width:100%;padding:14px;background:#1a7a3c;color:white;border:none;border-radius:8px;cursor:pointer;font-size:15px;font-weight:bold;min-height:48px;">💾 保存</button>';
        html += '</div>';

        el.innerHTML = html;

        // 状態管理
        var state = {
            weeks: weeks,
            youbi: youbi.slice(),
            jikan: jikan.slice(),
            enabledFacs: enabledFacs.slice()
        };

        // 週数ボタン
        [4,8,12].forEach(function(n) {
            var btn = document.getElementById('s-weeks-' + n);
            if (!btn) return;
            btn.addEventListener('click', function() {
                state.weeks = n;
                [4,8,12].forEach(function(m) {
                    var b = document.getElementById('s-weeks-' + m);
                    if (!b) return;
                    var active = m === n;
                    b.style.background = active ? '#1a7a3c' : 'white';
                    b.style.color = active ? 'white' : '#333';
                    b.style.borderColor = active ? '#1a7a3c' : '#ccc';
                    b.style.fontWeight = active ? 'bold' : 'normal';
                });
            });
        });

        // 曜日ボタン
        wds.forEach(function(w) {
            var btn = document.getElementById('s-wd-' + w);
            if (!btn) return;
            btn.addEventListener('click', function() {
                var i = state.youbi.indexOf(w);
                if (i >= 0) state.youbi.splice(i, 1);
                else state.youbi.push(w);
                var active = state.youbi.indexOf(w) >= 0;
                btn.style.background = active ? '#1a7a3c' : 'white';
                btn.style.color = active ? 'white' : '#333';
                btn.style.borderColor = active ? '#1a7a3c' : '#ccc';
                btn.style.fontWeight = active ? 'bold' : 'normal';
            });
        });

        // 時間帯ボタン
        times.forEach(function(t) {
            var btn = document.getElementById('s-jk-' + t.replace(':',''));
            if (!btn) return;
            btn.addEventListener('click', function() {
                var i = state.jikan.indexOf(t);
                if (i >= 0) state.jikan.splice(i, 1);
                else state.jikan.push(t);
                var active = state.jikan.indexOf(t) >= 0;
                btn.style.background = active ? '#1a7a3c' : 'white';
                btn.style.color = active ? 'white' : '#333';
                btn.style.borderColor = active ? '#1a7a3c' : '#ccc';
                btn.style.fontWeight = active ? 'bold' : 'normal';
            });
        });

        // 施設ボタン
        facilities.forEach(function(f) {
            var btn = document.getElementById('s-fac-' + f.bldCd);
            if (!btn) return;
            btn.addEventListener('click', function() {
                var i = state.enabledFacs.indexOf(f.name);
                if (i >= 0) state.enabledFacs.splice(i, 1);
                else state.enabledFacs.push(f.name);
                var active = state.enabledFacs.indexOf(f.name) >= 0;
                btn.style.background = active ? '#1a7a3c' : 'white';
                btn.style.color = active ? 'white' : '#333';
                btn.style.borderColor = active ? '#1a7a3c' : '#ccc';
                btn.textContent = (active ? '✓ ' : '') + f.name;
            });
        });

        // 保存
        document.getElementById('s-save').addEventListener('click', function() {
            var btn = this;
            var delayVal = parseInt(document.getElementById('s-delay').value, 10);
            if (isNaN(delayVal) || delayVal < 0) delayVal = 400;
            var timeoutVal = parseInt(document.getElementById('s-timeout').value, 10);
            if (isNaN(timeoutVal) || timeoutVal < 5) timeoutVal = 30;
            // 施設マスタは保存せず、ユーザー設定のみ保存
            S.set('config', {
                weeks:             state.weeks,
                youbi:             state.youbi,
                jikan:             state.jikan,
                enabledFacilities: state.enabledFacs,
                startDate:         (document.getElementById('s-date').value||'').trim(),
                initDelayMs:       delayVal,
                requestTimeoutSec: timeoutVal
            });
            btn.textContent = '✓ 保存しました！';
            btn.style.background = '#2196F3';
            setTimeout(function(){ btn.textContent = '💾 保存'; btn.style.background = '#1a7a3c'; }, 2000);
        });

        // 手動追加
        document.getElementById('s-add-fac').addEventListener('click', function() {
            var name = prompt('施設名（例: 砧公園テニス人工芝）');
            if (!name) return;
            var bldCd = prompt('bldCd');
            if (!bldCd) return;
            var instCd = prompt('instCd');
            if (!instCd) return;
            addFacility(name, bldCd, instCd);
        });

        // ページから検出
        document.getElementById('s-detect-fac').addEventListener('click', function() {
            var origSend = XMLHttpRequest.prototype.send;
            var detected = false;
            XMLHttpRequest.prototype.send = function(body) {
                if (!detected && body && typeof body === 'string' && body.indexOf('instCd') >= 0) {
                    detected = true;
                    XMLHttpRequest.prototype.send = origSend;
                    origSend.apply(this, arguments);
                    var params = {};
                    body.split('&').forEach(function(p) {
                        var kv = p.split('='); if (kv.length===2) params[kv[0]] = kv[1];
                    });
                    if (params.bldCd && params.instCd) {
                        var info = 'bldCd=' + params.bldCd + ' / instCd=' + params.instCd;
                        var name = prompt(info + ' -- 施設名を入力:');
                        if (name) addFacility(name, params.bldCd, params.instCd);
                    }
                } else {
                    origSend.apply(this, arguments);
                }
            };
            alert('検索ボタンを押してください。自動でパラメータを取得します。');
            setTimeout(function() { if (!detected) XMLHttpRequest.prototype.send = origSend; }, 15000);
        });
    }

    function addFacility(name, bldCd, instCd) {
        var newCfg = S.cfg();
        if (!newCfg.facilities) newCfg.facilities = [];
        var exists = newCfg.facilities.some(function(f){ return f.name === name; });
        if (exists) { alert(name + ' は既に登録済みです'); return; }
        newCfg.facilities.push({ name: name, bldCd: bldCd, instCd: instCd });
        if (!newCfg.enabledFacilities) newCfg.enabledFacilities = [];
        newCfg.enabledFacilities.push(name);
        S.set('config', newCfg);
        alert(name + ' を追加しました！');
        renderSettings();
    }

    // 画像モーダル
    function showImageModal(canvas) {
        var modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:10px;';

        var inner = document.createElement('div');
        inner.style.cssText = 'background:white;border-radius:8px;padding:10px;max-width:95vw;max-height:90vh;display:flex;flex-direction:column;gap:8px;';

        var msg = document.createElement('div');
        msg.style.cssText = 'font-size:11px;color:#555;text-align:center;';
        msg.innerHTML = '画像を長押しで「写真に保存」「画像をコピー」<br>その後LINEに貼り付けできます';

        var imgWrap = document.createElement('div');
        imgWrap.style.cssText = 'overflow:auto;max-height:65vh;border:1px solid #eee;';
        canvas.style.cssText = 'display:block;max-width:100%;height:auto;';
        imgWrap.appendChild(canvas);

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;';

        var dlBtn = document.createElement('button');
        dlBtn.textContent = '⬇ DL';
        dlBtn.style.cssText = 'flex:1;padding:8px;background:#4CAF50;color:white;border:none;border-radius:5px;font-size:12px;cursor:pointer;';
        dlBtn.onclick = function() {
            canvas.toBlob(function(blob) {
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = 'fuchu_tennis_' + new Date().toISOString().slice(0,10) + '.png';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
            });
        };

        var copyBtn = document.createElement('button');
        copyBtn.textContent = '📋 コピー';
        copyBtn.style.cssText = 'flex:1;padding:8px;background:#2196F3;color:white;border:none;border-radius:5px;font-size:12px;cursor:pointer;';
        copyBtn.onclick = function() {
            canvas.toBlob(async function(blob) {
                try {
                    if (navigator.clipboard && window.ClipboardItem) {
                        await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
                        copyBtn.textContent = '✓ コピー完了';
                        setTimeout(function(){ copyBtn.textContent = '📋 コピー'; }, 2000);
                    } else {
                        alert('このブラウザは画像コピー非対応です。\nダウンロードを使ってください。');
                    }
                } catch(e) {
                    alert('コピー失敗: ' + e.message);
                }
            }, 'image/png');
        };

        var closeBtn = document.createElement('button');
        closeBtn.textContent = '✕ 閉じる';
        closeBtn.style.cssText = 'flex:1;padding:8px;background:#888;color:white;border:none;border-radius:5px;font-size:12px;cursor:pointer;';
        closeBtn.onclick = function() {
            modal.remove();
            setTimeout(setResultsHeight, 50);
        };

        btnRow.appendChild(dlBtn);
        btnRow.appendChild(copyBtn);
        btnRow.appendChild(closeBtn);

        inner.appendChild(msg);
        inner.appendChild(imgWrap);
        inner.appendChild(btnRow);
        modal.appendChild(inner);
        modal.onclick = function(e) { if (e.target === modal) { modal.remove(); setTimeout(setResultsHeight, 50); } };
        document.body.appendChild(modal);
    }


    function showCopyFallback(text) {
        var modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;';
        modal.innerHTML = '<div style="background:white;border-radius:8px;padding:15px;max-width:90vw;width:400px;">' +
            '<div style="font-size:12px;font-weight:bold;margin-bottom:8px;">テキストを選択してコピー</div>' +
            '<textarea readonly style="width:100%;height:300px;font-size:11px;border:1px solid #ddd;border-radius:4px;padding:5px;font-family:monospace;">' + text + '</textarea>' +
            '<button id="ko-modal-close" style="margin-top:10px;width:100%;padding:8px;background:#1a7a3c;color:white;border:none;border-radius:4px;font-size:12px;cursor:pointer;">閉じる</button>' +
            '</div>';
        document.body.appendChild(modal);
        modal.querySelector('textarea').select();
        modal.querySelector('#ko-modal-close').onclick = function() { modal.remove(); };
        modal.onclick = function(e) { if (e.target===modal) modal.remove(); };
    }

    function setStatus(msg, color) {
        log(msg);
        var el = document.getElementById('ko-status');
        if (!el) return;
        el.textContent = msg;
        var colors = { blue:'#2196F3', green:'#4CAF50', red:'#e53935', orange:'#f57c00' };
        el.style.color = colors[color] || '#555';
        updateButtons();
    }

    function updateButtons() {
        var running = !!S.get('running');
        var startBtn = document.getElementById('ko-start');
        var stopBtn  = document.getElementById('ko-stop');
        if (startBtn) {
            startBtn.disabled = running;
            startBtn.style.opacity = running ? '0.4' : '1';
            startBtn.style.cursor  = running ? 'not-allowed' : 'pointer';
            startBtn.textContent   = running ? '⏳ 検索中...' : '⚡ チェック開始';
        }
        if (stopBtn) {
            stopBtn.style.opacity = !running ? '0.4' : '1';
        }
    }

    function showTab(t) {
        ['ctrl','results','stats','settings','log'].forEach(function(tab) {
            var pane = document.getElementById('ko-pane-' + tab);
            var btn  = document.getElementById('ko-tab-' + tab);
            if (!pane || !btn) return;
            var active = tab === t;
            pane.style.display = active ? 'block' : 'none';
            btn.style.cssText = 'flex:1;padding:5px 2px;border:none;font-size:10px;cursor:pointer;' +
                (active ? 'font-weight:bold;color:#1a7a3c;border-bottom:2px solid #1a7a3c;background:#f0fff4;' : 'color:#888;background:#fafafa;');
        });
        if (t === 'settings') renderSettings();
        if (t === 'log') renderLog();
        if (t === 'results') {
            // 要素が未生成の場合はrenderResultsを呼び直す
            var pb = document.getElementById('ko-pivot-body');
            var wb = document.getElementById('ko-week-body');
            var hasContent = (_viewMode === 'week') ? !!wb : !!pb;
            if (!hasContent) {
                var existing = S.get('results');
                if (existing && existing.length) renderResults(existing);
            }
            setTimeout(setResultsHeight, 200);
        }
    }

    /* ============================================================
       UI構築
    ============================================================ */
    // ドラッグ移動ヘルパー
    function makeDraggable(el, handleId) {
        var isDragging = false;
        var startX, startY, origX, origY;

        function onStart(clientX, clientY) {
            isDragging = true;
            var r = el.getBoundingClientRect();
            startX = clientX; startY = clientY;
            origX = r.left;   origY = r.top;
            el.style.left = origX + 'px'; el.style.top = origY + 'px';
            el.style.right = 'auto'; el.style.bottom = 'auto';
        }
        function onMove(clientX, clientY) {
            if (!isDragging) return;
            var nx = Math.max(0, Math.min(window.innerWidth  - el.offsetWidth,  origX + clientX - startX));
            var ny = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, origY + clientY - startY));
            el.style.left = nx + 'px'; el.style.top = ny + 'px';
        }
        function onEnd() { isDragging = false; }

        function shouldDrag(target) {
            // ボタン・スパン操作はドラッグしない
            return target.tagName !== 'BUTTON' && target.tagName !== 'INPUT';
        }

        var dragEl = handleId ? null : el;
        el.addEventListener('mousedown', function(e) {
            var h = handleId ? document.getElementById(handleId) : el;
            if (!h || !h.contains(e.target)) return;
            if (!shouldDrag(e.target)) return;
            e.preventDefault();
            onStart(e.clientX, e.clientY);
        });
        document.addEventListener('mousemove', function(e) { onMove(e.clientX, e.clientY); });
        document.addEventListener('mouseup', onEnd);

        el.addEventListener('touchstart', function(e) {
            var h = handleId ? document.getElementById(handleId) : el;
            if (!h || !h.contains(e.target)) return;
            if (!shouldDrag(e.target)) return;
            var t = e.touches[0];
            onStart(t.clientX, t.clientY);
        }, { passive: true });
        document.addEventListener('touchmove', function(e) {
            if (!isDragging) return;
            e.preventDefault();
            var t = e.touches[0];
            onMove(t.clientX, t.clientY);
        }, { passive: false });
        document.addEventListener('touchend', onEnd);
    }


    function buildPanel() {
        if (document.getElementById('kouen-panel')) return;

        var mini = document.createElement('div');
        mini.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;display:none;width:38px;height:38px;background:#1a7a3c;color:white;border-radius:50%;align-items:center;justify-content:center;cursor:grab;font-size:20px;box-shadow:0 2px 8px rgba(0,0,0,0.4);';
        mini.textContent = '🎾';
        mini.onclick = function() { mini.style.display='none'; panel.style.display='block'; };

        var panel = document.createElement('div');
        panel.id = 'kouen-panel';
        panel.style.cssText = 'position:fixed;bottom:20px;right:20px;left:auto;top:auto;z-index:2147483646;background:white;border:2px solid #1a7a3c;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3);width:480px;max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);overflow:hidden;font-family:sans-serif;';

        var tabs = ['ctrl','results','stats','settings','log'];
        var tabLabels = ['操作','結果','統計','設定','ログ'];

        panel.innerHTML =
            '<div id="ko-header" style="background:#1a7a3c;color:white;padding:7px 10px;font-size:13px;font-weight:bold;border-radius:6px 6px 0 0;display:flex;align-items:center;justify-content:space-between;cursor:grab;">' +
                '<span>🎾 都立公園テニスチェッカー <span style="font-size:9px;font-weight:normal;opacity:0.8;">v' + SCRIPT_VERSION + '</span></span>' +
                '<div style="display:flex;gap:4px;">' +
                    '<span id="ko-fs" style="cursor:pointer;padding:0 4px;" title="全画面">⛶</span>' +
                    '<span id="ko-min" style="cursor:pointer;padding:0 4px;" title="最小化">━</span>' +
                '</div>' +
            '</div>' +
            '<div id="ko-body">' +
                '<div style="display:flex;border-bottom:1px solid #ddd;">' +
                tabs.map(function(t,i) {
                    return '<button id="ko-tab-' + t + '" style="flex:1;padding:5px 2px;border:none;font-size:10px;cursor:pointer;color:#888;background:#fafafa;">' + tabLabels[i] + '</button>';
                }).join('') +
                '</div>' +

                '<div id="ko-pane-ctrl" style="padding:10px;display:none;">' +
                '<div id="ko-status" style="font-size:12px;color:#555;min-height:18px;margin-bottom:8px;">待機中</div>' +
                '<button id="ko-start" style="width:100%;padding:8px;background:#1a7a3c;color:white;border:none;border-radius:5px;font-size:12px;font-weight:bold;cursor:pointer;margin-bottom:5px;">⚡ チェック開始</button>' +
                '<button id="ko-stop"  style="width:100%;padding:6px;background:#888;color:white;border:none;border-radius:5px;font-size:11px;cursor:pointer;margin-bottom:5px;">■ 停止</button>' +
                '<button id="ko-clear" style="width:100%;padding:6px;background:#eee;color:#555;border:none;border-radius:5px;font-size:11px;cursor:pointer;">クリア</button>' +
                '</div>' +

                tabs.slice(1).map(function(t) {
                    return '<div id="ko-pane-' + t + '" style="padding:8px;display:none;"><div id="ko-' + t + '" style="max-height:500px;overflow-y:auto;overflow-x:auto;"></div></div>';
                }).join('') +
            '</div>';

        document.body.appendChild(mini);
        document.body.appendChild(panel);

        // visualViewport対応：ページレイアウト幅でなく実際の表示幅でパネル位置を調整
        function adjustPanelForViewport() {
            if (_fs) return;
            var vw = window.visualViewport ? window.visualViewport.width  : window.innerWidth;
            var vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
            var pw = Math.min(480, vw - 20);
            panel.style.width     = pw + 'px';
            panel.style.maxWidth  = 'none';
            panel.style.maxHeight = (vh - 40) + 'px';
            panel.style.right  = '';
            panel.style.bottom = '';
            panel.style.left   = Math.max(5, vw - pw - 10) + 'px';
            panel.style.top    = Math.max(5, vh - panel.offsetHeight - 10) + 'px';
        }
        setTimeout(adjustPanelForViewport, 150);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', adjustPanelForViewport);
        }

        setTimeout(function() { makeDraggable(panel, 'ko-header'); makeDraggable(mini, null); }, 100);

        document.getElementById('ko-min').onclick = function() { panel.style.display='none'; mini.style.display='flex'; };

        // 全画面
        var _fs = false;
        document.getElementById('ko-fs').onclick = function() {
            _fs = !_fs;
            if (_fs) {
                var vw = window.visualViewport ? window.visualViewport.width  : window.innerWidth;
                var vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
                panel.style.cssText = 'position:fixed;top:0;left:0;width:' + vw + 'px;height:' + vh + 'px;max-width:none;max-height:none;z-index:2147483646;background:white;border:none;border-radius:0;font-family:sans-serif;display:flex;flex-direction:column;';
                document.getElementById('ko-body').style.cssText = 'flex:1;overflow:auto;display:flex;flex-direction:column;';
                this.textContent = '⊟';
            } else {
                panel.style.cssText = 'position:fixed;z-index:2147483646;background:white;border:2px solid #1a7a3c;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3);overflow:hidden;font-family:sans-serif;';
                document.getElementById('ko-body').style.cssText = '';
                this.textContent = '⛶';
                adjustPanelForViewport();
            }
        };

        tabs.forEach(function(t) {
            document.getElementById('ko-tab-' + t).onclick = function() { showTab(t); };
        });

        document.getElementById('ko-start').onclick = function() {
            ['results','lastUpdate'].forEach(function(k){ S.del(k); });
            try { localStorage.removeItem('kouen_log'); } catch(e) {}
            LOG.length = 0;
            _timeFilter = []; _facFilter = [];
            runSearch();
        };

        document.getElementById('ko-stop').onclick = function() {
            S.set('running', false);
            setStatus('停止', 'red');
            updateButtons();
        };

        document.getElementById('ko-clear').onclick = function() {
            ['running','results','lastUpdate'].forEach(function(k){ S.del(k); });
            try { localStorage.removeItem('kouen_log'); } catch(e) {}
            LOG.length = 0;
            renderResults([]);
            renderStats([]);
            renderLog();
            document.getElementById('ko-tab-results').textContent = '結果';
            setStatus('待機中');
        };

        showTab('ctrl');
        updateButtons();

        var existing = S.get('results');
        if (existing && existing.length) {
            renderResults(existing);
            renderStats(existing);
            var lastU = S.get('lastUpdate');
            var lastLbl = '';
            if (lastU) {
                var lu = new Date(lastU);
                var diffMin = Math.floor((Date.now()-lu.getTime())/60000);
                if (diffMin<60) lastLbl = ' (' + diffMin + '分前)';
                else if (diffMin<1440) lastLbl = ' (' + Math.floor(diffMin/60) + '時間前)';
                else lastLbl = ' (' + Math.floor(diffMin/1440) + '日前)';
            }
            setStatus('前回結果: ' + existing.length + '件' + lastLbl, 'green');
        }
    }

    /* ============================================================
       エントリーポイント
    ============================================================ */
    function main() {
        try { var saved = JSON.parse(localStorage.getItem('kouen_log')||'[]'); if(saved.length) LOG.push.apply(LOG,saved); } catch(e) {}
        buildPanel();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
    else main();

})();
