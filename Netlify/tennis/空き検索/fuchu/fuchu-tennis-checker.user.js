// ==UserScript==
// @name         府中テニスチェッカー
// @namespace    fuchu-tennis-checker
// @version      2.9
// @description  府中市庭球場の空き時間帯を自動収集・表示
// -----------------------------------------------------------------------------
// 変更履歴
// 2.0            ページ遷移ベースの自動収集フローを確立
// 2.1 (2026-09-18) ヘッダーにバージョン表示を追加。
//                  ウォッチドッグを追加：一定時間（25秒）進捗がなければ
//                  「処理が止まっている可能性」を赤字で明示するように
//                  （ページ遷移ベースのため、1ステップの静かな失敗が
//                  　気づかれず放置されるリスクへの対策）
// 2.2 (2026-09-18) ウォッチドッグが実際に検知した停止を修正：
//                  「カレンダーへ戻る」リンク（javascript:__doPostBack形式）が
//                  疑似クリックでは遷移しないことがあったため、
//                  __doPostBackを直接呼び出す方式に変更（clickLink関数を追加）
// 2.3 (2026-09-18) v2.2でも同じ箇所で再現（タイミング起因の一時的な失敗と判断）。
//                  ウォッチドッグを「警告のみ」から「自動で同じ操作をやり直す
//                  （最大2回）→それでもダメなら警告」に変更。
//                  ヘッダーのバージョン表示が@versionとズレていたのを修正
// 2.4 (2026-09-18) DevToolsで実測した結果、v2.3の停止は「処理が止まっていた」の
//                  ではなく「サーバー応答が60秒以上かかっていただけ」と判明
//                  （時間をおいたら正しく遷移できていた）。
//                  同じ操作を重ねて送るとかえって悪化しうるため方針変更：
//                  ①60秒待つ→②まだなら追加で60秒待つ（何も送信しない）→
//                  ③それでもダメならTOPページから安全にやり直す
//                  （このときフィルターも再適用されるよう修正）
// 2.5 (2026-09-18) 実際のバグを発見・修正：翌月へ進むリンクは実際には
//                  __doPostBack('period','next')だが、コードは
//                  __doPostBack('btnNext','')と決め打ちしていたため、
//                  存在しない操作名でサーバーに何も伝わらず、
//                  2ヶ月目以降が同じ月のまま再取得され続けていた。
//                  実際のhrefの引数をそのまま使うclickLinkに統一して解消
// 2.6 (2026-09-18) ウォッチドッグの自動TOPリダイレクトを廃止。
//                  （まだ処理中のリクエストを強制キャンセルして内部の
//                  　処理位置とズレる＝取りこぼしのリスクがあったため）
//                  待機秒数を設定画面で調整可能に（既定30秒）。
//                  応答待ちが発生した場合は完了画面に注記を残し、
//                  「本当に取り切れたか」を人間が判断できるようにした
// 2.7 (2026-09-24) Android版Edge/Vivaldiで処理中に何度も
//                  「サイトから移動しますか？」ダイアログが出る問題に対応。
//                  従来の「登録させない」方式はスクリプト起動が遅れると間に合わないため、
//                  「登録されてもダイアログを出す合図（preventDefault/returnValue）を
//                  無効化する」方式を追加（beforeunloadのみ対象、他イベントは影響なし）。
//                  ページ本体への直接注入＋遷移直前の再適用で確実性を上げた
// 2.8 (2026-09-24) 待ち時間の見直し。「ページの準備を待つ」固定待ち（読み込み後2秒、
//                  各画面冒頭0.5〜0.8秒）を、準備完了を確認したら即進む方式に変更
//                  （従来の秒数は上限として残すので、遅い場合は従来と同じ動き）。
//                  操作後の待ちはサイト側の反応が確認できないため変更なし。
//                  サーバーから機械的に見えないよう、ページ表示から次の
//                  リクエストまで最低1秒空ける下限を追加。完了時に所要時間をログ出力
// 2.9 (2026-09-24) 準備完了の判定を「ページ読み込み＋サイト側初期化の完了」
//                  （document.readyState==='complete'）に強化。
//                  v2.8で施設検索画面のチェックがサイト側の初期化前に入り、
//                  コンソールにTooltipsterのエラーが出ていたため
// -----------------------------------------------------------------------------
// @match        https://shisetsu.city.fuchu.tokyo.jp/*
// @grant        unsafeWindow
// @grant        GM_setClipboard
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ─── 2重実行防止（DOMベース）───
    if (document.getElementById('_fuchu_guard')) return;
    var g = document.createElement('div');
    g.id = '_fuchu_guard';
    g.style.display = 'none';
    (document.head || document.body || document.documentElement).appendChild(g);

    // ─── ページ離脱ダイアログを完全抑制 ───
    // 方式A（従来）：ページがbeforeunloadを「登録」するのを握りつぶす
    //   → スクリプト起動がページより遅れると間に合わない（Android版Edge/Vivaldiで発生）
    // 方式B（追加）：登録されてしまっても、ダイアログを出す「合図」
    //   （preventDefault / returnValue の設定）自体を無効化する
    //   → 登録の順番に関係なく効く
    // これをページ本体（script注入）と拡張機能側（unsafeWindow）の両方に適用する
    function neutralizeBeforeUnload(w) {
        try {
            // 既に設定済みのonbeforeunloadを外してから、以後の設定を無視させる
            try { w.onbeforeunload = null; } catch (e) {}
            try {
                Object.defineProperty(w, 'onbeforeunload', {
                    get: function () { return null; },
                    set: function () {},
                    configurable: true
                });
            } catch (e) {}

            // 方式A：以後の登録を握りつぶす
            if (!w.__fcAddPatched) {
                var origAdd = w.addEventListener;
                w.addEventListener = function (type, fn, opts) {
                    if (type === 'beforeunload') return;
                    return origAdd.call(this, type, fn, opts);
                };
                w.__fcAddPatched = true;
            }

            // 方式B：beforeunloadイベントの「ダイアログを出して」という合図を無効化
            var proto = w.Event && w.Event.prototype;
            if (proto && !proto.__fcPdPatched) {
                var origPd = proto.preventDefault;
                proto.preventDefault = function () {
                    if (this && this.type === 'beforeunload') return;
                    return origPd.apply(this, arguments);
                };
                proto.__fcPdPatched = true;
            }
            [w.BeforeUnloadEvent && w.BeforeUnloadEvent.prototype, proto].forEach(function (p) {
                if (!p || p.__fcRvPatched) return;
                try {
                    var orig = Object.getOwnPropertyDescriptor(p, 'returnValue');
                    if (!orig || !orig.configurable) return;
                    Object.defineProperty(p, 'returnValue', {
                        get: function () {
                            if (this && this.type === 'beforeunload') return '';
                            return orig.get ? orig.get.call(this) : undefined;
                        },
                        set: function (v) {
                            if (this && this.type === 'beforeunload') return; // ダイアログの合図だけ無視
                            if (orig.set) orig.set.call(this, v);           // それ以外は元の動き
                        },
                        configurable: true
                    });
                    p.__fcRvPatched = true;
                } catch (e) {}
            });
        } catch (e) {}
    }

    (function () {
        var uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

        // 拡張機能側から適用
        neutralizeBeforeUnload(uw);
        if (uw !== window) neutralizeBeforeUnload(window);

        // ページ本体の中に直接差し込んで適用（拡張機能の分離環境の影響を受けないように）
        try {
            var s = document.createElement('script');
            s.textContent = '(' + neutralizeBeforeUnload.toString() + ')(window);';
            (document.head || document.documentElement).appendChild(s);
            s.remove();
        } catch (e) {}

        // フォームsubmit時にcheckboxをcleanに（dirty判定を防ぐ）
        uw.document.addEventListener('submit', function () {
            uw.document.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
                cb.defaultChecked = cb.checked;
            });
        }, true);
    })();

    /* ============================================================
       定数・デフォルト設定
    ============================================================ */
    var TOP_URL = 'https://shisetsu.city.fuchu.tokyo.jp/web/Home/WgR_ModeSelect';
    var SCRIPT_VERSION = '2.9'; // ヘッダー表示用。@versionと必ず一致させること

    var ALL_FACILITIES = [
        '郷土の森庭球場', '寿町庭球場', '武蔵台庭球場',
        '小柳庭球場（Ａ～Ｄ）', '小柳庭球場Ｅ', '押立庭球場',
        '四谷庭球場', '栄町庭球場', '住吉庭球場', '若松庭球場',
        '西府庭球場', '日新第２庭球場', '紅葉丘庭球場',
        '紅葉丘第２庭球場', '平和の森庭球場'
    ];

    var DEFAULT_CONFIG = {
        enabledFacilities: ['郷土の森庭球場', '武蔵台庭球場', '小柳庭球場（Ａ～Ｄ）', '押立庭球場', '住吉庭球場', '平和の森庭球場'],
        youbi: [],          // [] = 全曜日
        jikan: 'all',       // all / am / pm / nt
        maxMonths: 2,
        startDate: '',      // '' = 今日
        watchdogSec: 30     // これだけ進捗がなければ警告（抽選申込最終日等は伸ばす）
    };

    /* ============================================================
       ストレージ
    ============================================================ */
    var S = {
        get: function (k) { try { var v = localStorage.getItem('fc2_' + k); return v !== null ? JSON.parse(v) : undefined; } catch (e) { return undefined; } },
        set: function (k, v) { try { localStorage.setItem('fc2_' + k, JSON.stringify(v)); } catch (e) {} },
        del: function (k) { try { localStorage.removeItem('fc2_' + k); } catch (e) {} },
        cfg: function () { return S.get('config') || DEFAULT_CONFIG; }
    };

    /* ============================================================
       ログ
    ============================================================ */
    var LOG = [];
    function log(msg) {
        var t = new Date();
        var ts = t.getHours() + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds());
        var line = '[' + ts + '] ' + msg;
        LOG.push(line);
        if (LOG.length > 300) LOG.shift();
        // localStorage にも保存
        try {
            var saved = JSON.parse(localStorage.getItem('fc2_log') || '[]');
            saved.push(line);
            if (saved.length > 300) saved = saved.slice(-300);
            localStorage.setItem('fc2_log', JSON.stringify(saved));
        } catch (e) {}
        renderLog();
        console.log('[府中チェッカー]', msg);
    }
    function pad(n) { return String(n).padStart(2, '0'); }

    /* ============================================================
       ページ判定
    ============================================================ */
    function page() {
        var u = location.href;
        if (u.includes('WgR_ModeSelect'))              return 'top';
        if (u.includes('WgR_ShisetsuKensaku'))          return 'search';
        if (u.includes('WgR_ShisetsubetsuAkiJoukyou')) return 'calendar';
        if (u.includes('WgR_JikantaibetsuAkiJoukyou')) return 'timeslot';
        if (u.includes('GoBackError'))                  return 'error';
        return 'other';
    }

    /* ============================================================
       要素操作ヘルパー
    ============================================================ */
    function click(el) {
        if (!el) return false;
        cleanForm();
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
    }

    // <a href="javascript:__doPostBack('target','argument')">形式のリンクは、
    // 疑似クリック（dispatchEvent）では遷移しないことがある（実際に発生した停止の原因）。
    // __doPostBackが見つかればそれを直接呼び出し、確実に遷移させる。
    function clickLink(a) {
        if (!a) return false;
        var href = a.getAttribute('href') || '';
        var m = href.match(/__doPostBack\('([^']*)'\s*,\s*'([^']*)'\)/);
        if (m) {
            log('  __doPostBack検出: target=' + m[1] + ' arg=' + m[2]);
            cleanForm();
            var uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            if (typeof uw.__doPostBack === 'function') {
                uw.__doPostBack(m[1], m[2]);
                return true;
            }
            log('  __doPostBack関数なし → formSubmitにフォールバック');
            return formSubmit(m[1], m[2]);
        }
        // 通常のリンクはネイティブclick()の方が確実（javascript:以外のhrefも含む）
        cleanForm();
        a.click();
        return true;
    }

    function clickLabel(id) {
        var lbl = document.querySelector('label[for="' + id + '"]');
        return click(lbl);
    }

    function findBtn(text) {
        var all = Array.from(document.querySelectorAll('a, input[type=button], input[type=submit], button'));
        return all.find(function (b) {
            return (b.value || b.textContent || '').trim() === text;
        }) || all.find(function (b) {
            return (b.value || b.textContent || '').trim().indexOf(text) >= 0;
        });
    }

    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    // 条件が満たされたら即座に進む待ち方。maxMsは従来の固定待ち時間（＝上限）なので、
    // 準備が早ければ早く進み、遅い場合も従来と同じ時間で打ち切って従来通りに動く
    async function waitFor(cond, maxMs) {
        var start = Date.now();
        while (true) {
            try { if (cond()) return true; } catch (e) {}
            if (Date.now() - start >= maxMs) return false;
            await wait(100);
        }
    }

    // 各ページで「次の操作に必要なものが揃ったか」の判定
    // readyState==='complete'＝サイト自身の初期化処理まで終わった状態。
    // （v2.8では'loading'以外で進んでいたため、施設検索画面でサイト側の
    // 　吹き出し部品が初期化前にクリックが入り、コンソールにエラーが出ていた）
    function pageReady(p) {
        if (document.readyState !== 'complete') return false;
        var hasForm = !!document.querySelector('form');
        if (p === 'top')      return !!document.getElementById('category_06');
        if (p === 'search')   return hasForm && !!document.getElementById('checkShisetsu206001');
        if (p === 'calendar') return hasForm && !!document.getElementById('btnHyoji');
        if (p === 'timeslot') return hasForm && document.querySelectorAll('h4').length > 0;
        return true;
    }

    async function waitReady(p, maxMs) {
        var t0 = Date.now();
        var ok = await waitFor(function () { return pageReady(p); }, maxMs);
        log('  準備' + (ok ? '完了' : '待ち上限到達') + '（' + (Date.now() - t0) + 'ms）');
        return ok;
    }

    // サーバーから機械的に見えないよう、ページ表示から次のリクエストまで最低1秒空ける
    // （人が画面を見てすぐボタンを押す程度の間隔）
    var PAGE_LOADED_AT = Date.now();
    var MIN_PAGE_GAP_MS = 1000;
    async function ensureMinGap() {
        var remain = MIN_PAGE_GAP_MS - (Date.now() - PAGE_LOADED_AT);
        if (remain > 0) await wait(remain);
    }

    // フォームの全inputをcleanな状態にリセット（Chrome組み込みbeforeunload対策）
    function cleanForm() {
        document.querySelectorAll('input, select, textarea').forEach(function(el) {
            var tag = el.tagName;
            var type = (el.type || '').toLowerCase();
            if (type === 'checkbox' || type === 'radio') {
                el.defaultChecked = el.checked;
            } else if (tag === 'SELECT') {
                Array.from(el.options).forEach(function(o) { o.defaultSelected = o.selected; });
            } else if (tag === 'TEXTAREA') {
                el.defaultValue = el.value;
            } else {
                el.defaultValue = el.value;
            }
        });
        // 遷移直前にも離脱ダイアログ抑制をかけ直す（ページ側に後から登録されていても無効化）
        try {
            var uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
            neutralizeBeforeUnload(uw);
            try { uw.onbeforeunload = null; } catch (e) {}
        } catch (e) {}
    }

    // cleanFormを定期実行（Chromeネイティブbeforeunload対策）
    setInterval(function() { cleanForm(); }, 2000); // 間隔を長くして遷移タイミングと衝突防止

    // フォームを直接サブミット（ナビゲーション前にcleanFormを呼ぶ）
    function formSubmit(target, argument) {
        var form = document.querySelector('form');
        if (!form) { log('フォームが見つかりません'); return false; }
        var et = form.querySelector('input[name="__EVENTTARGET"]');
        var ea = form.querySelector('input[name="__EVENTARGUMENT"]');
        if (et) et.value = target;
        if (ea) ea.value = argument || '';
        cleanForm();  // Chromeのネイティブbeforeunload対策
        log('formSubmit: ' + target);
        form.submit();
        return true;
    }

    /* ============================================================
       カレンダー解析
    ============================================================ */
    function parseCalendar(enabledFacs) {
        var today = new Date();
        var curYear = today.getFullYear(), curMonth = today.getMonth() + 1;
        var dateCols = [], results = [];

        document.querySelectorAll('table').forEach(function (table) {
            table.querySelectorAll('tr').forEach(function (row) {
                var cells = Array.from(row.querySelectorAll('th, td'));
                if (!cells.length) return;
                var firstText = cells[0].textContent.trim();

                // ヘッダー行（年月）
                var ym = firstText.match(/(\d{4})年(\d{1,2})月/);
                if (ym) {
                    curYear = +ym[1]; curMonth = +ym[2]; dateCols = [];
                    cells.forEach(function (cell, ci) {
                        if (!(cell.className || '').split(' ').includes('day')) return;
                        var dm = cell.textContent.trim().match(/^(\d{1,2})([月火水木金土日])$/);
                        if (!dm) return;
                        var day = +dm[1], wd = dm[2], mo = curMonth, yr = curYear;
                        if (dateCols.length && day < dateCols[dateCols.length - 1].day && day <= 15) {
                            mo++; if (mo > 12) { mo = 1; yr++; }
                        }
                        dateCols.push({ ci: ci, year: yr, month: mo, day: day, wd: wd,
                                        dateStr: mo + '/' + day + '(' + wd + ')' });
                    });
                    return;
                }

                if (!dateCols.length) return;
                var fac = firstText;
                if (!fac || fac.length < 3 || fac === '施設名' || fac === '定員') return;

                // 施設フィルター（全角半角・部分一致で判定）
                if (enabledFacs.length) {
                    function normalize(s) {
                        return s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(c) {
                            return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
                        }).replace(/[～〜]/g,'~').replace(/\s/g,'');
                    }
                    var facN = normalize(fac);
                    var matched = enabledFacs.some(function (f) {
                        var fN = normalize(f);
                        return facN.includes(fN) || fN.includes(facN);
                    });
                    if (!matched) return;
                }

                dateCols.forEach(function (dc) {
                    if (dc.ci >= cells.length) return;
                    var ct = cells[dc.ci].textContent.trim();
                    var sym = ['○','△','×','－','-'].find(function (s) { return ct.includes(s); }) || '';
                    var cb = cells[dc.ci].querySelector('input[type="checkbox"]');
                    results.push({
                        facility: fac, dateStr: dc.dateStr, wd: dc.wd,
                        status: sym, cbId: cb ? cb.id : ''
                    });
                });
            });
        });
        return results;
    }

    /* ============================================================
       時間帯詳細解析
    ============================================================ */
    function parseTimeslots(jikan) {
        var results = [];
        var h4s = document.querySelectorAll('h4');
        log('h4要素数: ' + h4s.length);

        // h4が0の場合は別の構造を試みる
        if (h4s.length === 0) {
            log('h4なし → h3/h2/divで代替検索');
            var tables = document.querySelectorAll('table');
            log('table数: ' + tables.length);
            if (tables.length > 0) {
                var firstRows = Array.from(tables[0].querySelectorAll('tr')).slice(0, 2);
                firstRows.forEach(function(row, ri) {
                    log('table[0] row[' + ri + ']: ' + row.textContent.trim().slice(0, 80));
                });
            }
        }

        h4s.forEach(function (h4, hi) {
            var fac = h4.textContent.trim();
            if (!fac) return;
            // nextElementSiblingだけでなく親要素内・DOM順で次のtableを探す
            var table = null;
            // 1) 直近の兄弟要素
            var sib = h4.nextElementSibling;
            while (sib) {
                if (sib.tagName === 'TABLE') { table = sib; break; }
                var t = sib.querySelector('table');
                if (t) { table = t; break; }
                sib = sib.nextElementSibling;
            }
            // 2) 親コンテナ内の最初のtable
            if (!table) {
                var parent = h4.parentElement;
                if (parent) table = parent.querySelector('table');
            }
            // 3) DOM全体で h4 の後の最初のtable
            if (!table) {
                var allTables = Array.from(document.querySelectorAll('table'));
                var h4Rect = h4.getBoundingClientRect();
                table = allTables.find(function(t) {
                    return t.getBoundingClientRect().top > h4Rect.bottom;
                }) || null;
            }
            if (!table) { log('h4[' + hi + '] テーブルなし: ' + fac); return; }

            var rows = Array.from(table.querySelectorAll('tr'));
            log('h4[' + hi + '] ' + fac + ' rows=' + rows.length);
            if (!rows.length) return;

            var headers = Array.from(rows[0].querySelectorAll('th, td'));
            var dateStr = headers[0] ? headers[0].textContent.trim() : '';
            var timeCols = [];
            headers.forEach(function (cell, ci) {
                if (ci <= 1) return;
                var t = cell.textContent.trim();
                // 全角チルダ・半角チルダ・波ダッシュ等に対応
                var m = t.match(/(\d{1,2}:\d{2})[～〜~]+(\d{1,2}:\d{2})/);
                if (m) {
                    timeCols.push({ ci: ci, time: m[1] + '～' + m[2], start: m[1] });
                }
            });
            log('  dateStr=' + dateStr + ' timeCols=' + timeCols.length);
            if (timeCols.length === 0 && rows.length > 0) {
                log('  headers raw: ' + headers.map(function(c){return c.textContent.trim().slice(0,10);}).join('|'));
            }

            rows.slice(1).forEach(function (row) {
                var cells = Array.from(row.querySelectorAll('th, td'));
                if (!cells.length) return;
                var men = cells[0].textContent.trim();
                timeCols.forEach(function (tc) {
                    if (tc.ci >= cells.length) return;
                    var txt = cells[tc.ci].textContent.trim();
                    // ○または△を空きとして扱う
                    var isAvail = txt.includes('○') || txt.includes('△');
                    if (!isAvail) return;
                    if (!passJikan(tc.start, jikan)) return;
                    results.push({ facility: fac, dateStr: dateStr, men: men, time: tc.time, timeStart: tc.start });
                });
            });
        });
        log('parseTimeslots結果: ' + results.length + '件');
        return results;
    }

    function passJikan(start, jikan) {
        if (!jikan || jikan === 'all') return true;
        var h = parseInt(start);
        if (isNaN(h)) return true;
        if (jikan === 'am') return h >= 6 && h < 13;
        if (jikan === 'pm') return h >= 13 && h < 18;
        if (jikan === 'nt') return h >= 18;
        return true;
    }

    /* ============================================================
       ウォッチドッグ（処理が止まっていないかの監視）
       ページ遷移を伴う仕組みのため、途中の1ステップが静かに失敗すると
       「実行中のまま何も起きない」状態になりうる。
       以前は自動でTOPページに戻していたが、これは「まだ処理中の
       リクエストを強制キャンセルし、内部の処理位置とズレを生む
       （＝本当は空きがあるのに取りこぼす）」リスクがあるため廃止。
       自動では何もせず、待って、それでもダメなら警告するだけにする
       （原因が「単に遅い」のか「ボタンを間違えている」のかは、
       　その時々でDevToolsを見て人間が判断する）。
    ============================================================ */
    var _watchdogWarned = false;
    var _watchdogHadTimeout = false; // このセッション中に一度でも警告が出たか（完了画面での注記用）

    function touchProgress() {
        S.set('watchdogLastProgress', Date.now());
        _watchdogWarned = false;
    }

    function showStuckBanner(secs) {
        var ctrlPane = document.getElementById('fc-pane-ctrl');
        if (!ctrlPane || document.getElementById('fc-stuck-banner')) return;
        var b = document.createElement('div');
        b.id = 'fc-stuck-banner';
        b.style.cssText = 'background:#fff3e0;border:2px solid #e53935;border-radius:6px;padding:8px;margin-top:8px;font-size:11px;color:#c62828;';
        b.innerHTML = '<b>⚠ ' + secs + '秒間、応答がありません</b><br>' +
            'サイトが混み合って遅いだけの可能性も、ボタンを取り違えている可能性もあります。' +
            '自動では何もしないので、そのまましばらく待つか、実際のタブを確認するか、' +
            'いったん「■ 停止」して判断してください。（待つ秒数は「設定」タブで変更できます）';
        ctrlPane.appendChild(b);
    }

    function checkWatchdog() {
        if (!S.get('running')) return;
        var cfg = S.cfg();
        var staleMs = (cfg.watchdogSec || 30) * 1000;
        var last = S.get('watchdogLastProgress') || 0;
        var elapsed = Date.now() - last;
        if (elapsed <= staleMs || _watchdogWarned) return;

        _watchdogWarned = true;
        _watchdogHadTimeout = true;
        S.set('hadTimeout', true);
        var secs = Math.floor(elapsed / 1000);
        log('⚠ ' + secs + '秒間、応答がありません（自動では何もしません）');
        setStatus('⚠ ' + secs + '秒間応答なし。手動で確認してください', 'red');
        showStuckBanner(secs);
    }


    /* ============================================================
       フロー実行
    ============================================================ */
    async function run() {
        touchProgress();
        var p = page();
        log('ページ: ' + p);

        // ─── TOP ───
        if (p === 'top') {
            log('テニスカテゴリへ移動...');
            await waitReady('top', 600);
            var cat = document.getElementById('category_06');
            if (cat) { await ensureMinGap(); click(cat); return; }
            log('category_06 が見つかりません');
            return;
        }

        // ─── 施設検索 ───
        if (p === 'search') {
            log('庭球場を選択して次へ...');
            await waitReady('search', 800);
            var cbId = 'checkShisetsu206001';
            var cb = document.getElementById(cbId);
            if (!cb) { log('checkShisetsu206001 が見つかりません'); return; }
            if (!cb.checked) { clickLabel(cbId); await wait(400); }
            log('チェック状態: ' + cb.checked);

            // フォームをcleanにしてからサブミット（beforeunload対策）
            await wait(300);
            cleanForm();
            await wait(200);
            cleanForm(); // 2回呼んで確実に
            await ensureMinGap();
            formSubmit('next', '');
            return;
        }

        // ─── カレンダー ───
        if (p === 'calendar') {
            var state = S.get('state') || 'filter';

            if (state === 'filter') {
                log('フィルター設定中...');
                await waitReady('calendar', 600);
                log('cfg取得開始');
                var cfg = S.cfg();
                log('cfg取得OK youbi=' + (cfg.youbi||[]).join(',') + ' jikan=' + cfg.jikan);
                log('applyFilters呼び出し');
                try {
                    await applyFilters(cfg);
                    log('applyFilters完了');
                } catch(e) {
                    log('applyFiltersエラー: ' + e.message);
                }
                S.set('state', 'parse');
                S.set('monthIdx', S.get('monthIdx') || 0);
                S.set('batchStart', 0);
                await wait(500);
                // checkboxのdefaultCheckedをリセットしてformをcleanに
                document.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
                    cb.defaultChecked = cb.checked;
                });
                await ensureMinGap();
                formSubmit('hyouji', '');
                return;
            }

            if (state === 'parse') {
                var batchStart = S.get('batchStart') || 0;
                log('カレンダー解析中... (batchStart=' + batchStart + ')');
                await waitReady('calendar', 600);
                var cfg = S.cfg();
                var cal = parseCalendar(cfg.enabledFacilities || []);
                var avail = cal.filter(function (d) {
                    return (d.status === '○' || d.status === '△') && d.cbId;
                });
                log('空き: ' + avail.length + '件');

                var batch = avail.slice(batchStart, batchStart + 30);

                if (batch.length === 0) {
                    // このバッチは空 → 翌月へ or 完了
                    var monthIdx = S.get('monthIdx') || 0;
                    if (monthIdx + 1 < (cfg.maxMonths || 2)) {
                        log('翌月へ移動...');
                        S.set('monthIdx', monthIdx + 1);
                        S.set('state', 'filter');
                        S.set('batchStart', 0);
                        await wait(400);
                        // 「次へ」リンク（テーブルヘッダー内）
                        var nextLinks = Array.from(document.querySelectorAll('th a, td a'));
                        var nl = nextLinks.find(function (a) { return a.textContent.trim() === '次へ'; });
                        if (!nl) {
                            nl = Array.from(document.querySelectorAll('a')).reverse().find(function (a) {
                                return a.textContent.trim() === '次へ';
                            });
                        }
                        if (nl) {
                            // 実際のhrefの__doPostBack引数をそのまま使う（決め打ちしない）
                            log('翌月リンク href=' + (nl.getAttribute('href') || ''));
                            await ensureMinGap();
                            clickLink(nl);
                            return;
                        }
                        log('翌月リンクが見つかりません');
                    } else {
                        log('全月完了！');
                        finish();
                    }
                    return;
                }

                // チェックボックスをクリア
                document.querySelectorAll('input[type="checkbox"]:checked').forEach(function (c) {
                    clickLabel(c.id);
                });
                await wait(300);

                // チェック実行
                log('バッチ ' + (batchStart + 1) + '〜' + (batchStart + batch.length) + ' をチェック');
                batch.forEach(function (entry) { clickLabel(entry.cbId); });
                await wait(600);

                // チェック確認
                var checkedNow = document.querySelectorAll('input[type="checkbox"]:checked').length;
                log('チェック確認: ' + checkedNow + '件');

                if (checkedNow === 0) {
                    // ラベルクリックが効いていない → 直接 checked=true
                    log('直接 checked を設定...');
                    batch.forEach(function (entry) {
                        var el = document.getElementById(entry.cbId);
                        if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
                    });
                    await wait(400);
                    checkedNow = document.querySelectorAll('input[type="checkbox"]:checked').length;
                    log('再確認: ' + checkedNow + '件');
                }

                if (checkedNow === 0) {
                    log('チェック不可 → スキップ');
                    S.set('batchStart', batchStart + batch.length);
                    await wait(300);
                    run();
                    return;
                }

                // 次へ進む
                S.set('state', 'timeslot');
                S.set('batchStart', batchStart);
                S.set('batchSize', batch.length);
                await wait(500);
                // チェックボックスをcleanにしてからサブミット（beforeunload防止）
                document.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
                    cb.defaultChecked = cb.checked;
                });
                await ensureMinGap();
                formSubmit('next', '');
                return;
            }
        }

        // ─── 時間帯詳細 ───
        if (p === 'timeslot') {
            log('時間帯詳細を解析中...');
            await waitReady('timeslot', 500);
            var cfg = S.cfg();
            var slots = parseTimeslots(cfg.jikan);
            log('このバッチの空きコマ: ' + slots.length + '件');

            // 重複除去してマージ
            var existing = S.get('results') || [];
            var all = existing.concat(slots);
            var seen = {};
            all = all.filter(function (s) {
                var k = s.facility + '|' + s.dateStr + '|' + s.men + '|' + s.time;
                if (seen[k]) return false;
                seen[k] = true; return true;
            });
            S.set('results', all);
            S.set('lastUpdate', new Date().toISOString());
            log('累計: ' + all.length + '件');
            try {
                renderResults(all);
            } catch(e) {
                log('renderResultsエラー: ' + e.message + ' / ' + e.stack);
            }
            setStatus('収集中... 累計 ' + all.length + '件', 'blue');

            // 次バッチ設定
            var batchStart = S.get('batchStart') || 0;
            var batchSize  = S.get('batchSize')  || 30;
            S.set('batchStart', batchStart + batchSize);
            S.set('state', 'parse');

            // カレンダーに戻る
            await wait(600);
            log('カレンダーへ戻る処理中...');
            var allLinks = Array.from(document.querySelectorAll('a'));
            var backLink = allLinks.find(function (a) {
                return a.textContent.trim().indexOf('施設別空き状況') >= 0;
            });
            if (backLink) {
                log('カレンダーへ戻る: ' + backLink.href);
                cleanForm();
                await wait(200);
                cleanForm();
                await ensureMinGap();
                clickLink(backLink);
            } else {
                // パンくずがない場合はTOPから再開
                log('戻るリンクなし (links=' + allLinks.map(function(a){return a.textContent.trim().slice(0,8);}).join(',') + ')');
                S.set('state', 'filter');
                location.href = TOP_URL;
            }
            return;
        }

        // ─── GoBackError（POSTページへの不正な戻り）───
        if (p === 'error') {
            log('GoBackError → TOPへリダイレクト');
            await wait(500);
            location.href = TOP_URL;
            return;
        }

        // ─── その他（スタート時） ───
        if (p === 'other') {
            log('TOPへ移動...');
            await wait(500);
            cleanForm();
            location.href = TOP_URL;
        }
    }

    async function applyFilters(cfg) {
        log('--- applyFilters開始 ---');

        // ヘルパー: 多重クリック試行
        async function tryClick(id, name) {
            var el = document.getElementById(id);
            if (!el) { log('  ' + name + ': 要素なし(' + id + ')'); return false; }
            var lbl = document.querySelector('label[for="' + id + '"]');
            log('  ' + name + ': el=' + !!el + ' lbl=' + !!lbl + ' checked=' + el.checked);

            // 方法1: ラベルクリック
            if (lbl) {
                lbl.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
                await wait(150);
                if (el.checked) { log('  → ' + name + ' OK(ラベルクリック)'); return true; }
            }
            // 方法2: 要素自体クリック
            el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
            await wait(150);
            if (el.checked) { log('  → ' + name + ' OK(要素クリック)'); return true; }
            // 方法3: el.click()
            try { el.click(); } catch(e) {}
            await wait(150);
            if (el.checked) { log('  → ' + name + ' OK(click())'); return true; }
            // 方法4: 直接設定+changeイベント
            el.checked = true;
            el.dispatchEvent(new Event('change', {bubbles:true}));
            el.dispatchEvent(new Event('input', {bubbles:true}));
            await wait(150);
            log('  → ' + name + ' 強制設定 checked=' + el.checked);
            return el.checked;
        }

        // 1ヶ月表示
        await tryClick('radioPeriod1month', '1ヶ月');

        // 表示開始日
        if (cfg.startDate) {
            var di = document.getElementById('dpStartDate');
            if (di) {
                di.value = cfg.startDate;
                di.dispatchEvent(new Event('change', { bubbles: true }));
                log('  startDate=' + cfg.startDate);
            } else {
                log('  dpStartDate要素なし');
            }
        }

        // 曜日
        var youbiMap = { 月:'checkYobi1', 火:'checkYobi2', 水:'checkYobi3', 木:'checkYobi4',
                         金:'checkYobi5', 土:'checkYobi6', 日:'checkYobi7', 祝:'checkYobi8' };
        if (cfg.youbi && cfg.youbi.length) {
            log('  曜日設定: ' + cfg.youbi.join(','));
            // 全解除
            for (var key in youbiMap) {
                var id = youbiMap[key];
                var c = document.getElementById(id);
                if (c && c.checked) {
                    var lb = document.querySelector('label[for="' + id + '"]');
                    if (lb) lb.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
                    else { c.checked = false; c.dispatchEvent(new Event('change', {bubbles:true})); }
                    await wait(80);
                }
            }
            // 対象だけON
            for (var i = 0; i < cfg.youbi.length; i++) {
                var w = cfg.youbi[i];
                if (youbiMap[w]) await tryClick(youbiMap[w], '曜日' + w);
            }
        }

        // 時間帯
        var jikanMap = { all:'radioJikan4', am:'radioJikan1', pm:'radioJikan2', nt:'radioJikan3' };
        var jid = jikanMap[cfg.jikan] || 'radioJikan4';
        await tryClick(jid, '時間帯' + cfg.jikan);

        log('--- applyFilters完了 ---');
    }

    function finish() {
        S.set('running', false);
        S.set('state', null);
        updateButtons();
        var results = S.get('results') || [];
        var hadTO = S.get('hadTimeout');
        setStatus('完了！ 空きコマ ' + results.length + '件' + (hadTO ? '（⚠応答待ちあり）' : ''), hadTO ? 'orange' : 'green');
        renderResults(results);
        renderStats(results);
        log('=== 完了 ' + results.length + '件 ===' + (hadTO ? '（⚠途中で応答待ちが発生）' : ''));
        var startedAt = S.get('runStartedAt');
        if (startedAt) log('所要時間: ' + Math.round((Date.now() - startedAt) / 1000) + '秒');
    }

    /* ============================================================
       UI
    ============================================================ */
    var PANEL_ID = 'fuchu-panel-v2';

    function setStatus(msg, color) {
        log(msg);
        var el = document.getElementById('fc-status');
        if (!el) return;
        el.textContent = msg;
        var colors = { blue:'#2196F3', green:'#4CAF50', red:'#e53935', orange:'#f57c00' };
        el.style.color = colors[color] || '#555';
        updateButtons();
    }

    // 実行状態に応じてボタンを有効/無効化
    function updateButtons() {
        var running = !!S.get('running');
        var startBtn = document.getElementById('fc-start');
        var stopBtn  = document.getElementById('fc-stop');
        if (startBtn) {
            startBtn.disabled = running;
            startBtn.style.opacity = running ? '0.4' : '1';
            startBtn.style.cursor  = running ? 'not-allowed' : 'pointer';
            startBtn.textContent   = running ? '⏳ 実行中...' : '⚡ チェック開始';
        }
        if (stopBtn) {
            stopBtn.disabled = !running;
            stopBtn.style.opacity = !running ? '0.4' : '1';
            stopBtn.style.cursor  = !running ? 'not-allowed' : 'pointer';
        }
    }

    function renderLog() {
        var el = document.getElementById('fc-log');
        if (!el) return;
        try {
            var saved = JSON.parse(localStorage.getItem('fc2_log') || '[]');
            var logText = saved.slice().reverse().join('\n');
            var copyBtn = '<button id="fc-log-copy" style="width:100%;padding:5px;margin-bottom:6px;background:#555;color:white;border:none;border-radius:4px;font-size:10px;cursor:pointer;">📋 ログをコピー</button>';
            el.innerHTML = copyBtn + saved.slice().reverse().map(function(l) {
                return '<div style="font-size:10px;color:#555;padding:1px 0;border-bottom:1px solid #f5f5f5;">' + l + '</div>';
            }).join('');
            var btn = document.getElementById('fc-log-copy');
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

    // ─── 表示エンジン ───
    var _timeFilter = []; // [] = 全時間, ['13:00','15:00'] = 複数選択
    var _facFilter  = []; // [] = 全施設
    var _viewMode   = 'pivot';

    function facShort(f) {
        return f.replace('（市民庭球場）','').replace('庭球場','')
                .replace('（Ａ～Ｄ）','A-D').replace('（A～D）','A-D')
                .replace('第２','2').replace('第2','2').trim();
    }

    function dateKey(ds) {
        var m = ds.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
        if (m) return m[1] + ('0'+m[2]).slice(-2) + ('0'+m[3]).slice(-2);
        m = ds.match(/(\d{1,2})\/(\d{1,2})/);
        if (m) return ('0'+m[1]).slice(-2) + ('0'+m[2]).slice(-2);
        return ds;
    }

    function isWeekend(ds) { return /[土日]/.test(ds); }

    function getWeekday(ds) {
        var m = ds.match(/[（(]([月火水木金土日])[）)]/);
        return m ? m[1] : '';
    }

    function shortDate(ds) {
        return ds.replace(/\d{4}年/,'').replace('月','/').replace('日','');
    }

    // フィルター適用（表示用） 配列が空=全選択扱い
    function applyDisplayFilters(results) {
        return results.filter(function(s) {
            var okTime = !_timeFilter.length || _timeFilter.indexOf(s.timeStart) >= 0;
            var okFac  = !_facFilter.length  || _facFilter.indexOf(s.facility)  >= 0;
            return okTime && okFac;
        });
    }

    // Android対応：fc-resultsの高さをJSで計算して設定
    function setResultsHeight() {
        var el = document.getElementById('fc-results');
        var pane = document.getElementById('fc-pane-results');
        if (!el || !pane || pane.style.display === 'none') return;
        var h = Math.floor(window.innerHeight * 0.55);

        if (_viewMode === 'week') {
            // 週別：ヘッダー固定＋ボディスクロール
            el.style.height = '';
            el.style.overflowY = 'visible';
            el.style.overflowX = 'visible';
            var wb = document.getElementById('fc-week-body');
            var wh = document.getElementById('fc-week-header');
            if (wb && wh) {
                var headerH = wh.offsetHeight || 36;
                wb.style.height = (h - headerH) + 'px';
                wb.style.overflowY = 'scroll';
                wb.style.webkitOverflowScrolling = 'touch';
                wb.style.overscrollBehavior = 'contain';
            }
        } else {
            // 表形式：単一スクロール（週別用スタイルをリセット）
            var wb2 = document.getElementById('fc-week-body');
            if (wb2) { wb2.style.height = ''; wb2.style.overflowY = ''; }
            el.style.height = h + 'px';
            el.style.overflowY = 'scroll';
            el.style.overflowX = 'auto';
            el.style.webkitOverflowScrolling = 'touch';
            el.style.overscrollBehavior = 'contain';
        }
    }

    function renderResults(results) {
        var el = document.getElementById('fc-results');
        if (!el) return;
        var badge = document.getElementById('fc-tab-results');
        if (badge) badge.textContent = '結果(' + results.length + ')';

        var timeoutBanner = '';
        if (S.get('hadTimeout')) {
            timeoutBanner =
                '<div style="background:#fff3e0;border:2px solid #f57c00;border-radius:8px;padding:10px;margin:8px;font-size:12px;color:#e65100;">' +
                '<div style="font-weight:bold;margin-bottom:4px;">⚠ 途中で応答待ちが発生しました</div>' +
                '<div>処理中に一度、サイトからの応答がなく待機した箇所があります。' +
                'その間のデータが正しく取得できているか確証がないため、<b>念のためもう一度実行して確認</b>することをおすすめします。</div>' +
                '</div>';
        }

        if (!results.length) {
            el.innerHTML = timeoutBanner + '<div style="color:#999;font-size:11px;padding:8px;">空きコマなし</div>';
            return;
        }

        var BG = '#c41e3a';

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

        // 全時間帯・全施設を収集
        var allTimes = [], allFacs = [];
        results.forEach(function(s) {
            if (allTimes.indexOf(s.timeStart) < 0) allTimes.push(s.timeStart);
            if (allFacs.indexOf(s.facility)   < 0) allFacs.push(s.facility);
        });
        allTimes.sort(function(a,b){ return parseInt(a)-parseInt(b); });
        allFacs.sort();

        // ── コントロールバー ──
        function pillBtn(cls, val, label, active) {
            return '<button class="' + cls + '" data-v="' + val + '" style="' +
                'padding:4px 8px;font-size:10px;border-radius:12px;cursor:pointer;margin:2px;' +
                'border:1px solid ' + (active ? BG : '#ddd') + ';' +
                'background:' + (active ? BG : 'white') + ';' +
                'color:' + (active ? 'white' : '#555') + ';' +
                'font-weight:' + (active ? 'bold' : 'normal') + ';' +
                '">' + label + '</button>';
        }

        var ctrl = '<div style="padding:4px;border-bottom:2px solid #f0f0f0;">';

        // 表示切替
        ctrl += '<div style="display:flex;gap:4px;margin-bottom:4px;">';
        ctrl += pillBtn('fc-vm', 'pivot', '📋 表形式', _viewMode==='pivot');
        ctrl += pillBtn('fc-vm', 'week',  '📅 週別',   _viewMode==='week');
        ctrl += '</div>';

        // 時間フィルター（複数選択：空=全選択）
        ctrl += '<div style="display:flex;flex-wrap:wrap;gap:2px;margin-bottom:3px;align-items:center;">';
        ctrl += '<span style="font-size:9px;color:#888;margin-right:2px;">時間</span>';
        ctrl += pillBtn('fc-tf', '__all', '全時間', !_timeFilter.length);
        allTimes.forEach(function(t) {
            ctrl += pillBtn('fc-tf', t, t, _timeFilter.indexOf(t) >= 0);
        });
        ctrl += '</div>';

        // 施設フィルター（複数選択：空=全選択）
        ctrl += '<div style="display:flex;flex-wrap:wrap;gap:2px;align-items:center;">';
        ctrl += '<span style="font-size:9px;color:#888;margin-right:2px;">施設</span>';
        ctrl += pillBtn('fc-ff', '__all', '全施設', !_facFilter.length);
        allFacs.forEach(function(f) {
            ctrl += pillBtn('fc-ff', f, facShort(f), _facFilter.indexOf(f) >= 0);
        });
        ctrl += '</div>';

        ctrl += '</div>';

        // コピーボタン
        ctrl += '<div style="display:flex;gap:4px;margin-top:4px;padding-top:4px;border-top:1px solid #eee;">';
        ctrl += '<button id="fc-copy" style="flex:1;padding:5px;font-size:10px;background:#4CAF50;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:bold;">📋 テキスト</button>';
        ctrl += '<button id="fc-copyimg" style="flex:1;padding:5px;font-size:10px;background:#2196F3;color:white;border:none;border-radius:4px;cursor:pointer;font-weight:bold;">📷 画像</button>';
        ctrl += '</div>';

        // ── ビュー本体 ──
        var filtered = applyDisplayFilters(results);
        var body = _viewMode === 'week'
            ? renderWeekView(filtered)
            : renderPivotView(filtered);

        el.innerHTML = timeoutBanner + updBar + ctrl + body;

        // イベント設定
        el.querySelectorAll('.fc-vm').forEach(function(b) {
            b.onclick = function() { _viewMode = this.getAttribute('data-v'); renderResults(results); };
        });
        el.querySelectorAll('.fc-tf').forEach(function(b) {
            b.onclick = function() {
                var v = this.getAttribute('data-v');
                if (v === '__all') { _timeFilter = []; }
                else {
                    var i = _timeFilter.indexOf(v);
                    if (i >= 0) _timeFilter.splice(i, 1);
                    else _timeFilter.push(v);
                }
                renderResults(results);
            };
        });
        el.querySelectorAll('.fc-ff').forEach(function(b) {
            b.onclick = function() {
                var v = this.getAttribute('data-v');
                if (v === '__all') { _facFilter = []; }
                else {
                    var i = _facFilter.indexOf(v);
                    if (i >= 0) _facFilter.splice(i, 1);
                    else _facFilter.push(v);
                }
                renderResults(results);
            };
        });

        setTimeout(setResultsHeight, 50);
        // コピーボタン
        var copyBtn = document.getElementById('fc-copy');
        if (copyBtn) {
            copyBtn.onclick = function() {
                var filtered = applyDisplayFilters(results);
                if (!filtered.length) { alert('コピーする内容がありません'); return; }

                // 日付→施設→時間のテキスト形式に整形
                var byDate = {};
                filtered.forEach(function(s) {
                    if (!byDate[s.dateStr]) byDate[s.dateStr] = {};
                    if (!byDate[s.dateStr][s.facility]) byDate[s.dateStr][s.facility] = {};
                    byDate[s.dateStr][s.facility][s.time] = (byDate[s.dateStr][s.facility][s.time]||0)+1;
                });

                // 全時間帯/全施設をリスト化
                var allTimesT = [], allFacsT = [];
                results.forEach(function(s) {
                    if (allTimesT.indexOf(s.timeStart) < 0) allTimesT.push(s.timeStart);
                    if (allFacsT.indexOf(s.facility)  < 0) allFacsT.push(s.facility);
                });
                allTimesT.sort(function(a,b){ return parseInt(a)-parseInt(b); });
                allFacsT.sort();

                var timeLblT = (_timeFilter.length ? _timeFilter : allTimesT).join(', ');
                var facLblT  = (_facFilter.length  ? _facFilter  : allFacsT).map(facShort).join(', ');

                var lastUpdT = S.get('lastUpdate');
                var updLblT = '不明';
                if (lastUpdT) {
                    var uT = new Date(lastUpdT);
                    updLblT = uT.getFullYear() + '/' + (uT.getMonth()+1) + '/' + uT.getDate() +
                              ' ' + uT.getHours() + ':' + ('0'+uT.getMinutes()).slice(-2);
                }
                var nowT = new Date();
                var nowLblT = nowT.getFullYear() + '/' + (nowT.getMonth()+1) + '/' + nowT.getDate() +
                              ' ' + nowT.getHours() + ':' + ('0'+nowT.getMinutes()).slice(-2);

                var lines = [
                    '🎾 府中市 庭球場 空き状況',
                    '🕒 データ取得: ' + updLblT,
                    '📝 作成: ' + nowLblT,
                    '⏰ 時間帯(' + (_timeFilter.length ? _timeFilter.length+'/'+allTimesT.length : '全'+allTimesT.length) + '): ' + timeLblT,
                    '🏟 施設(' + (_facFilter.length ? _facFilter.length+'/'+allFacsT.length : '全'+allFacsT.length) + '): ' + facLblT,
                    ''
                ];

                var dates = Object.keys(byDate).sort(function(a,b){ return dateKey(a)>dateKey(b)?1:-1; });
                dates.forEach(function(ds) {
                    var weekend = isWeekend(ds);
                    lines.push((weekend?'🔴':'') + '【' + shortDate(ds) + '】');
                    var facMap = byDate[ds];
                    Object.keys(facMap).sort().forEach(function(f) {
                        var times = Object.keys(facMap[f]).sort(function(a,b){ return parseInt(a)-parseInt(b); });
                        var timeStr = times.map(function(t) {
                            var n = facMap[f][t];
                    var s = t.replace(/:00/g,'').replace(/[\u301c\uff5e~]/g,'-');
                            return s + (n>1 ? '×' + n : '');
                        }).join(' ');
                        lines.push('  ' + facShort(f) + ': ' + timeStr);
                    });
                    lines.push('');
                });

                var text = lines.join('\n');

                // クリップボードにコピー
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(function() {
                        copyBtn.textContent = '✓ コピーしました！';
                        copyBtn.style.background = '#2196F3';
                        setTimeout(function() {
                            copyBtn.textContent = '📋 LINEで送れる形式でコピー';
                            copyBtn.style.background = '#4CAF50';
                        }, 2000);
                    }).catch(function() {
                        // フォールバック: 選択用テキストエリアを表示
                        showCopyFallback(text);
                    });
                } else {
                    showCopyFallback(text);
                }
            };
        }

        // 画像コピーボタン
        var copyImgBtn = document.getElementById('fc-copyimg');
        if (copyImgBtn) {
            copyImgBtn.onclick = async function() {
                if (typeof html2canvas !== 'function') {
                    alert('html2canvasが読み込まれていません。スクリプトを更新してください。');
                    return;
                }
                copyImgBtn.textContent = '⏳ 生成中...';
                copyImgBtn.disabled = true;
                try {
                    // resultsEl と そのpane(fc-pane-results) の高さ制限を一時解除
                    var resultsEl = document.getElementById('fc-results');
                    var paneEl = document.getElementById('fc-pane-results');

                    // コントロール部分を一時的に隠す
                    var ctrlEl = resultsEl.querySelector('div[style*="border-bottom"]');
                    var origCtrlDisplay = ctrlEl ? ctrlEl.style.display : null;
                    if (ctrlEl) ctrlEl.style.display = 'none';

                    // 条件サマリーヘッダーを一時挿入
                    var headerEl = document.createElement('div');
                    var now = new Date();
                    var dateLbl = now.getFullYear() + '/' + (now.getMonth()+1) + '/' + now.getDate() +
                                  ' ' + now.getHours() + ':' + ('0'+now.getMinutes()).slice(-2);
                    var modeLbl = _viewMode === 'week' ? '週別' : '表形式';

                    // 全時間帯/全施設はallTimes/allFacsを実際に列挙
                    var allTimes2 = [], allFacs2 = [];
                    results.forEach(function(s) {
                        if (allTimes2.indexOf(s.timeStart) < 0) allTimes2.push(s.timeStart);
                        if (allFacs2.indexOf(s.facility)  < 0) allFacs2.push(s.facility);
                    });
                    allTimes2.sort(function(a,b){ return parseInt(a)-parseInt(b); });
                    allFacs2.sort();

                    var timeLbl = (_timeFilter.length ? _timeFilter : allTimes2).join(', ');
                    var facLbl  = (_facFilter.length  ? _facFilter  : allFacs2).map(facShort).join(', ');

                    // 取得日時（最後のチェック実行時刻）
                    var lastUpd = S.get('lastUpdate');
                    var updLbl = '不明';
                    if (lastUpd) {
                        var u = new Date(lastUpd);
                        updLbl = u.getFullYear() + '/' + (u.getMonth()+1) + '/' + u.getDate() +
                                 ' ' + u.getHours() + ':' + ('0'+u.getMinutes()).slice(-2);
                    }
                    headerEl.style.cssText = 'background:linear-gradient(135deg,#c41e3a,#e54870);color:white;padding:10px 14px;font-family:sans-serif;border-radius:6px 6px 0 0;';
                    headerEl.innerHTML =
                        '<div style="font-size:14px;font-weight:bold;margin-bottom:4px;">🎾 府中市 庭球場 空き状況</div>' +
                        '<div style="font-size:10px;opacity:0.95;line-height:1.6;">' +
                            '🕒 データ取得: ' + updLbl + '（画像作成: ' + dateLbl + '）<br>' +
                            '📋 表示形式: ' + modeLbl + '<br>' +
                            '⏰ 時間帯(' + (_timeFilter.length ? _timeFilter.length+'/'+allTimes2.length : '全'+allTimes2.length) + '): ' + timeLbl + '<br>' +
                            '🏟 施設(' + (_facFilter.length ? _facFilter.length+'/'+allFacs2.length : '全'+allFacs2.length) + '): ' + facLbl +
                        '</div>';
                    resultsEl.insertBefore(headerEl, resultsEl.firstChild);

                    // fc-results自体の高さ制限を解除
                    var origH   = resultsEl.style.height;
                    var origOvY = resultsEl.style.overflowY;
                    resultsEl.style.height    = "auto";
                    resultsEl.style.overflowY = "visible";
                    resultsEl.style.overflow  = "visible";

                    // 週別ビューのスクロールボディも解除
                    var weekBody = document.getElementById("fc-week-body");
                    var origWH = weekBody ? weekBody.style.height   : null;
                    var origWO = weekBody ? weekBody.style.overflowY : null;
                    if (weekBody) {
                        weekBody.style.height    = "auto";
                        weekBody.style.overflowY = "visible";
                        weekBody.style.overflow  = "visible";
                    }

                    await wait(200);

                    var captureTarget = resultsEl;
                    var canvas = await html2canvas(captureTarget, {
                        backgroundColor: "#ffffff",
                        scale: 2,
                        logging: false,
                        width:  captureTarget.scrollWidth,
                        height: captureTarget.scrollHeight,
                        windowWidth:  Math.max(captureTarget.scrollWidth, window.innerWidth),
                        windowHeight: Math.max(captureTarget.scrollHeight, window.innerHeight)
                    });

                    // スタイルを元に戻す
                    resultsEl.style.height    = origH;
                    resultsEl.style.overflowY = origOvY;
                    resultsEl.style.overflow  = "";
                    if (weekBody) {
                        weekBody.style.height    = origWH;
                        weekBody.style.overflowY = origWO;
                        weekBody.style.overflow  = "";
                    }
                    if (ctrlEl) ctrlEl.style.display = origCtrlDisplay || "";
                    if (headerEl && headerEl.parentNode) headerEl.parentNode.removeChild(headerEl);
                    setResultsHeight();

                    showImageModal(canvas);
                    copyImgBtn.textContent = '📷 画像';
                    copyImgBtn.disabled = false;
                } catch(e) {
                    log('画像生成エラー: ' + e.message);
                    alert('画像生成に失敗: ' + e.message);
                    copyImgBtn.textContent = '📷 画像';
                    copyImgBtn.disabled = false;
                }
            };
        }
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
        modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
        document.body.appendChild(modal);
    }

    // クリップボードAPIが使えない時のフォールバック
    function showCopyFallback(text) {
        var modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:20px;';
        modal.innerHTML =
            '<div style="background:white;border-radius:8px;padding:15px;max-width:90vw;width:400px;">' +
            '<div style="font-size:12px;font-weight:bold;margin-bottom:8px;">テキストを選択してコピーしてください</div>' +
            '<textarea readonly style="width:100%;height:300px;font-size:11px;border:1px solid #ddd;border-radius:4px;padding:5px;font-family:monospace;">' + text + '</textarea>' +
            '<button id="fc-modal-close" style="margin-top:10px;width:100%;padding:8px;background:#c41e3a;color:white;border:none;border-radius:4px;font-size:12px;cursor:pointer;">閉じる</button>' +
            '</div>';
        document.body.appendChild(modal);
        var ta = modal.querySelector('textarea');
        ta.focus();
        ta.select();
        modal.querySelector('#fc-modal-close').onclick = function() { modal.remove(); };
        modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    }

    // ── ピボット表示 ──
    function renderPivotView(filtered) {
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
            pivot[s.dateStr][s.facility][s.time] = (pivot[s.dateStr][s.facility][s.time]||0)+1;
        });

        if (!allDates.length) return '<div style="color:#999;font-size:11px;padding:8px;">該当なし</div>';

        var BG = '#c41e3a';
        var COLS = allFacs.length;
        var colWidth = Math.floor(85 / COLS) + '%';

        // thead に sticky を設定（fc-bodyがスクロールコンテナになるため機能する）
        var thStyle = 'padding:5px 4px;font-size:10px;background:' + BG + ';color:white;font-weight:bold;text-align:center;border:1px solid #d88;';
        var tdStyle = 'padding:3px;font-size:9px;text-align:center;border:1px solid #eee;vertical-align:top;';

        var html = '<table style="border-collapse:collapse;width:100%;table-layout:fixed;">';
        html += '<colgroup><col style="width:70px;">';
        allFacs.forEach(function(){ html += '<col style="width:' + colWidth + ';">'; });
        html += '</colgroup>';

        // thead（sticky）
        html += '<thead style="position:sticky;top:0;z-index:3;">';
        html += '<tr><th style="' + thStyle + '">日付</th>';
        allFacs.forEach(function(f){ html += '<th style="' + thStyle + '">' + facShort(f) + '</th>'; });
        html += '</tr></thead>';

        // tbody
        html += '<tbody>';
        allDates.forEach(function(ds) {
            var hasData = allFacs.some(function(f){ return pivot[ds] && pivot[ds][f]; });
            if (!hasData) return;
            var wknd = isWeekend(ds);
            var dateStyle = tdStyle + 'font-weight:bold;white-space:nowrap;' +
                (wknd ? 'color:#c41e3a;background:#fff5f5;' : 'color:#333;background:#fafafa;');
            html += '<tr><td style="' + dateStyle + '">' + shortDate(ds) + '</td>';
            allFacs.forEach(function(f) {
                var cd = pivot[ds] && pivot[ds][f];
                if (!cd) { html += '<td style="' + tdStyle + 'color:#e0e0e0;">-</td>'; return; }
                var times = Object.keys(cd).sort(function(a,b){ return parseInt(a)-parseInt(b); });
                var bg = wknd ? '#fff0f0' : '#f0fff0';
                var cells = times.map(function(t) {
                    var n = cd[t];
                    var s = t.replace(/:00/g,'').replace(/[〜～~]/g,'-');
                    return '<div style="background:' + (wknd?'#ffd0d0':'#c8f0c8') + ';border-radius:3px;padding:1px 3px;margin:1px;white-space:nowrap;font-size:9px;">'
                        + s + (n>1?'<b style="color:'+(wknd?'#a00':'#060')+';">×'+n+'</b>':'') + '</div>';
                }).join('');
                html += '<td style="' + tdStyle + 'background:' + bg + ';">' + cells + '</td>';
            });
            html += '</tr>';
        });
        html += '</tbody></table>';
        return html;
    }

    // ── 週別カレンダー表示 ──
    function renderWeekView(filtered) {
        var WDS = ['月','火','水','木','金','土','日'];

        function parseDate(ds) {
            var m = ds.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[（(]([月火水木金土日])[）)]/);
            if (m) return { year:+m[1], month:+m[2], day:+m[3], wd:m[4], ds:ds };
            m = ds.match(/(\d{1,2})\/(\d{1,2})[（(]([月火水木金土日])[）)]/);
            if (m) return { month:+m[1], day:+m[2], wd:m[3], ds:ds };
            return null;
        }

        var pivot = {};
        filtered.forEach(function(s) {
            if (!pivot[s.dateStr]) pivot[s.dateStr] = {};
            if (!pivot[s.dateStr][s.facility]) pivot[s.dateStr][s.facility] = [];
            pivot[s.dateStr][s.facility].push(s.time);
        });

        var dates = Object.keys(pivot).sort(function(a,b){ return dateKey(a)>dateKey(b)?1:-1; });
        if (!dates.length) return '<div style="color:#999;font-size:11px;padding:8px;">該当なし</div>';

        function wdIdx(ds) {
            var m = ds.match(/[（(]([月火水木金土日])[）)]/);
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

        var BG = '#c41e3a';
        var thStyle = 'padding:4px 3px;font-size:10px;text-align:center;background:' + BG + ';color:white;border:1px solid #d88;min-width:38px;';
        var tdStyle = 'padding:3px 2px;font-size:9px;text-align:center;border:1px solid #eee;vertical-align:top;min-width:38px;';

        // ヘッダーテーブル（固定）
        var header = '<div id="fc-week-header" style="overflow:hidden;flex-shrink:0;">';
        header += '<table style="border-collapse:collapse;width:100%;table-layout:fixed;">';
        header += '<colgroup><col style="width:52px;">';
        WDS.forEach(function(){ header += '<col>'; });
        header += '</colgroup><tr>';
        header += '<th style="' + thStyle + '">週</th>';
        WDS.forEach(function(wd) {
            var wknd = wd==='土'||wd==='日';
            header += '<th style="' + thStyle + (wknd?'color:#ffc0c0;':'') + '">' + wd + '</th>';
        });
        header += '</tr></table></div>';

        // データテーブル（スクロール - JSで高さ設定）
        var body = '<div id="fc-week-body" style="overflow-y:scroll;overflow-x:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;">';
        body += '<table style="border-collapse:collapse;width:100%;table-layout:fixed;">';
        body += '<colgroup><col style="width:52px;">';
        WDS.forEach(function(){ body += '<col>'; });
        body += '</colgroup>';

        weekKeys.forEach(function(wk) {
            var dsMap = weekMap[wk];
            var firstDs = Object.keys(dsMap).sort(function(a,b){ return dateKey(a)>dateKey(b)?1:-1; })[0];
            var parsed = parseDate(firstDs);
            var weekLabel = parsed ? (parsed.month + '/' + parsed.day) : wk;

            body += '<tr>';
            body += '<td style="' + tdStyle + 'font-weight:bold;color:' + BG + ';white-space:nowrap;background:#fff8f8;">' + weekLabel + '</td>';
            WDS.forEach(function(wd) {
                var ds = Object.keys(dsMap).find(function(d){ return d.indexOf('('+wd+')')>=0; });
                var wknd = wd==='土'||wd==='日';
                if (!ds) { body += '<td style="' + tdStyle + 'color:#e8e8e8;">-</td>'; return; }
                var facData = dsMap[ds];
                var bg = wknd ? '#fff0f0' : '#f0fff0';
                var dateLabel = ds.replace(/[（(][月火水木金土日][）)]/,'').replace(/\d{4}年/,'').replace('月','/').replace('日','');
                var cellContent = '<div style="font-size:8px;color:#888;margin-bottom:1px;">' + dateLabel + '</div>';
                cellContent += Object.keys(facData).map(function(f) {
                    var tStrs = facData[f].map(function(t){
                        return t.replace(/:00/g,'').replace(/[〜～~]/g,'-');
                    }).join(' ');
                    return '<div style="background:' + (wknd?'#ffc8c8':'#c8f0c8') + ';border-radius:2px;padding:1px 2px;margin:1px;font-size:8px;">'
                        + '<b>' + facShort(f) + '</b> ' + tStrs + '</div>';
                }).join('');
                body += '<td style="' + tdStyle + 'background:' + bg + ';">' + cellContent + '</td>';
            });
            body += '</tr>';
        });
        body += '</table></div>';

        return '<div id="fc-week-wrap" style="display:flex;flex-direction:column;">' + header + body + '</div>';
    }

    function renderStats(results) {
        var el = document.getElementById('fc-stats');
        if (!el) return;
        if (!results.length) { el.innerHTML = '<div style="color:#999;font-size:11px;">データなし</div>'; return; }

        // 施設×日付の件数集計
        var byFac = {};
        results.forEach(function (s) {
            if (!byFac[s.facility]) byFac[s.facility] = { total: 0, dates: {} };
            byFac[s.facility].total++;
            byFac[s.facility].dates[s.dateStr] = (byFac[s.facility].dates[s.dateStr] || 0) + 1;
        });

        var html = '<div style="font-size:11px;font-weight:bold;margin-bottom:6px;">施設別サマリー</div>';
        Object.keys(byFac).sort().forEach(function (f) {
            var info = byFac[f];
            var dayCount = Object.keys(info.dates).length;
            var facShort = f.replace('庭球場','').replace('（市民庭球場）','');
            html += '<div style="padding:4px 0;border-bottom:1px solid #f0f0f0;">';
            html += '<div style="display:flex;justify-content:space-between;font-size:10px;font-weight:bold;">' +
                '<span>' + facShort + '</span>' +
                '<span style="color:#c41e3a;">' + dayCount + '日 / ' + info.total + 'コマ</span></div>';
            // 日付別コマ数（小さく）
            var dateItems = Object.keys(info.dates).sort().map(function(d) {
                return d + ':' + info.dates[d];
            }).join('　');
            html += '<div style="font-size:9px;color:#888;margin-top:1px;">' + dateItems + '</div>';
            html += '</div>';
        });

        el.innerHTML = html;
    }

    function renderSettings() {
        var el = document.getElementById('fc-settings');
        if (!el) return;
        var cfg = S.cfg();
        var wds = ['月','火','水','木','金','土','日','祝'];
        var jkOpts = [{v:'all',l:'全日'},{v:'am',l:'午前'},{v:'pm',l:'午後'},{v:'nt',l:'夜間'}];

        el.innerHTML =
            // 表示開始日
            '<div style="margin-bottom:8px;"><div style="font-size:10px;font-weight:bold;color:#555;margin-bottom:3px;">📅 表示開始日</div>' +
            '<input id="s-date" type="text" placeholder="例: 2026/5/1 (空欄=今日)" value="' + (cfg.startDate||'') + '" style="width:100%;font-size:11px;border:1px solid #ddd;border-radius:3px;padding:3px 5px;box-sizing:border-box;"></div>' +

            // 施設
            '<div style="margin-bottom:8px;"><div style="font-size:10px;font-weight:bold;color:#555;margin-bottom:3px;">🏟 対象施設</div>' +
            ALL_FACILITIES.map(function (f) {
                var chk = (cfg.enabledFacilities||[]).includes(f) ? ' checked' : '';
                return '<label style="display:flex;align-items:center;gap:4px;font-size:10px;padding:1px 0;cursor:pointer;">' +
                    '<input type="checkbox" class="s-fac" value="' + f + '"' + chk + '>' + f + '</label>';
            }).join('') + '</div>' +

            // 曜日
            '<div style="margin-bottom:8px;"><div style="font-size:10px;font-weight:bold;color:#555;margin-bottom:3px;">📅 曜日（未選択=全曜日）</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:6px;">' +
            wds.map(function (w) {
                var chk = (cfg.youbi||[]).includes(w) ? ' checked' : '';
                return '<label style="font-size:10px;cursor:pointer;">' +
                    '<input type="checkbox" class="s-wd" value="' + w + '"' + chk + '> ' + w + '</label>';
            }).join('') + '</div></div>' +

            // 時間帯
            '<div style="margin-bottom:8px;"><div style="font-size:10px;font-weight:bold;color:#555;margin-bottom:3px;">⏰ 時間帯</div>' +
            '<div style="display:flex;gap:8px;">' +
            jkOpts.map(function (j) {
                var chk = cfg.jikan === j.v ? ' checked' : '';
                return '<label style="font-size:10px;cursor:pointer;">' +
                    '<input type="radio" name="s-jk" value="' + j.v + '"' + chk + '> ' + j.l + '</label>';
            }).join('') + '</div></div>' +

            // 月数
            '<div style="margin-bottom:10px;"><div style="font-size:10px;font-weight:bold;color:#555;margin-bottom:3px;">📆 収集月数</div>' +
            '<div style="display:flex;gap:8px;">' +
            [1, 2].map(function (n) {
                var chk = cfg.maxMonths === n ? ' checked' : '';
                return '<label style="font-size:10px;cursor:pointer;">' +
                    '<input type="radio" name="s-mo" value="' + n + '"' + chk + '> ' + n + 'ヶ月</label>';
            }).join('') + '</div></div>' +

            // 応答待ち秒数
            '<div style="margin-bottom:10px;"><div style="font-size:10px;font-weight:bold;color:#555;margin-bottom:3px;">⏱ 応答待ちの秒数（既定30秒）</div>' +
            '<div style="font-size:9px;color:#888;margin-bottom:3px;">これ以上応答がないと警告します。抽選申込最終日など混雑が予想される日は長めに。</div>' +
            '<input id="s-watchdog" type="number" min="10" step="10" value="' + (cfg.watchdogSec || 30) + '" style="width:100%;font-size:11px;border:1px solid #ddd;border-radius:3px;padding:3px 5px;box-sizing:border-box;"></div>' +

            '<button id="s-save" style="width:100%;padding:7px;background:#c41e3a;color:white;border:none;border-radius:5px;cursor:pointer;font-size:11px;font-weight:bold;">保存</button>';

        document.getElementById('s-save').onclick = function () {
            var wdVal = parseInt(document.getElementById('s-watchdog').value, 10);
            if (isNaN(wdVal) || wdVal < 5) wdVal = 30;
            var newCfg = {
                startDate: (document.getElementById('s-date').value || '').trim(),
                enabledFacilities: Array.from(document.querySelectorAll('.s-fac:checked')).map(function (c) { return c.value; }),
                youbi: Array.from(document.querySelectorAll('.s-wd:checked')).map(function (c) { return c.value; }),
                jikan: (document.querySelector('input[name="s-jk"]:checked') || {}).value || 'all',
                maxMonths: +((document.querySelector('input[name="s-mo"]:checked') || {}).value || 2),
                watchdogSec: wdVal
            };
            S.set('config', newCfg);
            alert('保存しました！');
        };
    }

    function showTab(t) {
        ['ctrl','results','stats','settings','log'].forEach(function (tab) {
            var pane = document.getElementById('fc-pane-' + tab);
            var btn  = document.getElementById('fc-tab-' + tab);
            if (!pane || !btn) return;
            var active = tab === t;
            pane.style.display = active ? 'block' : 'none';
            btn.style.cssText = 'flex:1;padding:5px 2px;border:none;font-size:10px;cursor:pointer;' +
                (active ? 'font-weight:bold;color:#c41e3a;border-bottom:2px solid #c41e3a;background:#fff8f8;' : 'color:#888;background:#fafafa;');
        });
        if (t === 'settings') renderSettings();
        if (t === 'log') renderLog();
        if (t === 'results') setTimeout(setResultsHeight, 50);
    }

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
        if (document.getElementById(PANEL_ID)) return;

        // ミニボタン
        var mini = document.createElement('div');
        mini.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;display:none;width:38px;height:38px;background:#c41e3a;color:white;border-radius:50%;align-items:center;justify-content:center;cursor:grab;font-size:20px;box-shadow:0 2px 8px rgba(0,0,0,0.4);';
        mini.textContent = '🎾';
        mini.onclick = function () { mini.style.display = 'none'; panel.style.display = 'block'; };

        var panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483646;background:white;border:2px solid #c41e3a;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3);width:480px;max-width:calc(100vw - 40px);font-family:sans-serif;';
        // ドラッグ移動を有効化
        setTimeout(function() {
            makeDraggable(panel, 'fc-header');
            makeDraggable(mini, null);
        }, 100);

        var tabs = ['ctrl','results','stats','settings','log'];
        var tabLabels = ['操作','結果','統計','設定','ログ'];

        panel.innerHTML =
            '<div id="fc-header" style="background:#c41e3a;color:white;padding:7px 10px;font-size:13px;font-weight:bold;border-radius:6px 6px 0 0;display:flex;align-items:center;justify-content:space-between;cursor:grab;">' +
                '<span>🎾 府中テニスチェッカー <span style="font-size:9px;font-weight:normal;opacity:0.8;">v' + SCRIPT_VERSION + '</span></span>' +
                '<div style="display:flex;gap:4px;">' +
                    '<span id="fc-fs" style="cursor:pointer;padding:0 4px;" title="全画面切替">⛶</span>' +
                    '<span id="fc-min" style="cursor:pointer;padding:0 4px;" title="最小化">━</span>' +
                '</div>' +
            '</div>' +
            '<div id="fc-body">' +
                '<div style="display:flex;border-bottom:1px solid #ddd;">' +
                tabs.map(function (t, i) {
                    return '<button id="fc-tab-' + t + '" style="flex:1;padding:5px 2px;border:none;font-size:10px;cursor:pointer;color:#888;background:#fafafa;">' + tabLabels[i] + '</button>';
                }).join('') +
                '</div>' +

                // 操作
                '<div id="fc-pane-ctrl" style="padding:10px;display:none;">' +
                '<div id="fc-status" style="font-size:12px;color:#555;min-height:18px;margin-bottom:8px;">待機中</div>' +
                '<button id="fc-start" style="width:100%;padding:8px;background:#c41e3a;color:white;border:none;border-radius:5px;font-size:12px;font-weight:bold;cursor:pointer;margin-bottom:5px;">⚡ チェック開始</button>' +
                '<button id="fc-stop"  style="width:100%;padding:6px;background:#888;color:white;border:none;border-radius:5px;font-size:11px;cursor:pointer;margin-bottom:5px;">■ 停止</button>' +
                '<button id="fc-clear" style="width:100%;padding:6px;background:#eee;color:#555;border:none;border-radius:5px;font-size:11px;cursor:pointer;">クリア</button>' +
                '</div>' +

                tabs.slice(1).map(function (t) {
                    return '<div id="fc-pane-' + t + '" style="padding:8px;display:none;' + (t==="results"?"flex:1;overflow:hidden;min-height:0;overscroll-behavior:contain;":"") + '"><div id="fc-' + t + '" style="' + (t==="results"?"max-height:none;":"max-height:380px;overflow-y:auto;overflow-x:auto;") + '"></div></div>';
                }).join('') +
            '</div>';

        document.body.appendChild(mini);
        document.body.appendChild(panel);

        document.getElementById('fc-min').onclick = function () { panel.style.display = 'none'; mini.style.display = 'flex'; };

        // 全画面切替
        var _isFullscreen = false;
        document.getElementById('fc-fs').onclick = function () {
            _isFullscreen = !_isFullscreen;
            if (_isFullscreen) {
                panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;width:100vw;height:100vh;max-width:none;z-index:2147483646;background:white;border:none;border-radius:0;font-family:sans-serif;display:flex;flex-direction:column;';
                document.getElementById('fc-body').style.cssText = 'flex:1;overflow:auto;display:flex;flex-direction:column;';
                // 各paneのmax-heightを解除
                document.querySelectorAll('[id^="fc-pane-"]').forEach(function(p) {
                    p.style.flex = '1';
                });
                document.querySelectorAll('[id^="fc-results"], [id^="fc-stats"], [id^="fc-log"], [id^="fc-settings"]').forEach(function(p) {
                    if (p.style) p.style.maxHeight = 'none';
                });
                this.textContent = '⊟';
                this.title = '通常表示に戻す';
            } else {
                panel.style.cssText = 'position:fixed;bottom:20px;right:20px;left:auto;top:auto;z-index:2147483646;background:white;border:2px solid #c41e3a;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.3);width:480px;max-width:calc(100vw - 40px);font-family:sans-serif;';
                document.getElementById('fc-body').style.cssText = '';
                document.querySelectorAll('[id^="fc-pane-"]').forEach(function(p) {
                    p.style.flex = '';
                });
                document.querySelectorAll('[id="fc-results"], [id="fc-stats"], [id="fc-log"], [id="fc-settings"]').forEach(function(p) {
                    if (p.style) p.style.maxHeight = '500px';
                });
                this.textContent = '⛶';
                this.title = '全画面切替';
            }
        };

        tabs.forEach(function (t) {
            document.getElementById('fc-tab-' + t).onclick = function () { showTab(t); };
        });

        document.getElementById('fc-start').onclick = async function () {
            // 古いキーも含めて全状態をクリア
            ['state','monthIdx','batchStart','results','batchSize',
             'calState','calData','isRunning','watchdogLastProgress'].forEach(function(k) { S.del(k); });
            try { localStorage.removeItem('fc2_log'); localStorage.removeItem('fc2_logLines'); } catch(e) {}
            LOG.length = 0;
            S.set('running', true);
            S.set('state', 'filter');
            S.set('monthIdx', 0);
            S.set('batchStart', 0);
            S.set('results', []);
            S.set('hadTimeout', false);
            S.set('runStartedAt', Date.now());
            _watchdogHadTimeout = false;
            touchProgress();
            log('開始...');
            setStatus('開始...', 'blue');
            cleanForm();
            if (page() !== 'top') {
                location.href = TOP_URL;
            } else {
                await run();
            }
        };

        document.getElementById('fc-stop').onclick = function () {
            S.set('running', false);
            S.del('watchdogLastProgress');
            _watchdogWarned = false;
            var banner = document.getElementById('fc-stuck-banner');
            if (banner) banner.remove();
            setStatus('停止', 'red');
            updateButtons();
        };

        document.getElementById('fc-clear').onclick = function () {
            ['running','state','monthIdx','batchStart','results','batchSize',
             'calState','calData','isRunning','watchdogLastProgress','hadTimeout'].forEach(function (k) { S.del(k); });
            try { localStorage.removeItem('fc2_log'); localStorage.removeItem('fc2_logLines'); } catch (e) {}
            LOG.length = 0;
            _watchdogWarned = false;
            _watchdogHadTimeout = false;
            var banner2 = document.getElementById('fc-stuck-banner');
            if (banner2) banner2.remove();
            renderResults([]);
            renderStats([]);
            renderLog();
            var badge = document.getElementById('fc-tab-results');
            if (badge) badge.textContent = '結果';
            setStatus('待機中');
        };

        showTab('ctrl');

        // 既存結果を表示
        var existing = S.get('results');
        if (existing && existing.length) {
            renderResults(existing);
            renderStats(existing);
            var lastU = S.get('lastUpdate');
            var lastLbl = '';
            if (lastU) {
                var lu = new Date(lastU);
                var diffMin = Math.floor((Date.now() - lu.getTime()) / 60000);
                if (diffMin < 60) lastLbl = ' (' + diffMin + '分前)';
                else if (diffMin < 1440) lastLbl = ' (' + Math.floor(diffMin/60) + '時間前)';
                else lastLbl = ' (' + Math.floor(diffMin/1440) + '日前)';
            }
            setStatus('前回結果: ' + existing.length + '件' + lastLbl, 'green');
        }
    }

    /* ============================================================
       エントリーポイント
    ============================================================ */
    async function main() {
        // ログ復元
        try { var saved = JSON.parse(localStorage.getItem('fc2_log') || '[]'); if (saved.length) LOG.push.apply(LOG, saved); } catch (e) {}

        buildPanel();

        updateButtons();

        // ウォッチドッグを5秒おきに確認
        setInterval(checkWatchdog, 5000);

        // 実行中なら自動継続
        if (S.get('running')) {
            touchProgress(); // ページ読み込み自体が進捗の証拠なので更新
            _watchdogHadTimeout = !!S.get('hadTimeout');
            await waitReady(page(), 2000);
            if (S.get('running')) await run();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }

})();
