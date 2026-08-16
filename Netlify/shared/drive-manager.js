/**
 * drive-manager.js — 個人アプリ共通のGoogle Drive連携モジュール
 *
 * 設計方針:
 *   - メインファイルは常に1つの固定名（世代判定バグの温床だった「日付入りファイル名 + name desc ソート」を廃止）
 *   - 保存のたびに、直前のメインファイルを "_backup_" 付きファイルとして退避してから上書き
 *   - バックアップは modifiedTime 基準で新しい順に並べ、直近 maxBackups 件だけ残して古い物を削除
 *
 * 使い方:
 *   <script src="https://egmassa.github.io/koukai/Netlify/shared/drive-manager.js"></script>
 *   ...
 *   await driveManager.setup(clientId, folderId);
 *   await driveManager.getToken(false); // 初回は false（ポップアップ許可あり）
 *   await driveManager.saveJsonWithBackup('energy_unified_data.json', dataObj, {
 *       backupPrefix: 'energy_unified_backup', maxBackups: 10
 *   });
 *   const { data, modifiedTime } = await driveManager.loadJson('energy_unified_data.json');
 */
const driveManager = {
    clientId: '',
    folderId: '',
    accessToken: null,
    tokenClient: null,

    _loadScript(src) {
        return new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
            const s = document.createElement('script');
            s.src = src; s.onload = resolve; s.onerror = reject;
            document.head.appendChild(s);
        });
    },

    async setup(clientId, folderId) {
        this.clientId = clientId;
        this.folderId = folderId.replace(/^(folders\/|https:\/\/drive\.google\.com\/.*\/folders\/)/, '').trim();
        await this._loadScript('https://apis.google.com/js/api.js');
        await new Promise(resolve => gapi.load('client', resolve));
        await gapi.client.init({ discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'] });
        await this._loadScript('https://accounts.google.com/gsi/client');
        this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId, scope: 'https://www.googleapis.com/auth/drive', callback: () => {}
        });
    },

    getToken(silent = true) {
        return new Promise((resolve, reject) => {
            let timer = silent ? setTimeout(() => reject(new Error('silent_timeout')), 5000) : null;
            this.tokenClient.callback = (resp) => {
                if (timer) clearTimeout(timer);
                if (resp.error) { reject(new Error(resp.error)); return; }
                this.accessToken = resp.access_token;
                gapi.client.setToken(resp);
                resolve(resp.access_token);
            };
            this.tokenClient.requestAccessToken({ prompt: silent ? 'none' : '' });
        });
    },

    async ensureToken() { if (!this.accessToken) await this.getToken(false); },

    /** 完全一致するファイル名で1件検索（メインファイルの取得に使う） */
    async findExact(filename) {
        await this.ensureToken();
        const resp = await gapi.client.drive.files.list({
            q: `'${this.folderId}' in parents and name='${filename}' and trashed=false`,
            fields: 'files(id,name,modifiedTime)', pageSize: 1
        });
        const files = resp.result.files || [];
        return files.length > 0 ? files[0] : null;
    },

    /**
     * 前方一致するファイル群を modifiedTime 降順で取得。
     * 旧バージョンは name desc（文字列比較）でバグの原因になっていたため、必ず modifiedTime で判定する。
     */
    async listByPrefix(prefix) {
        await this.ensureToken();
        const resp = await gapi.client.drive.files.list({
            q: `'${this.folderId}' in parents and name contains '${prefix}' and trashed=false`,
            orderBy: 'modifiedTime desc', pageSize: 100, fields: 'files(id,name,modifiedTime)'
        });
        return resp.result.files || [];
    },

    async copyFile(fileId, newName) {
        await this.ensureToken();
        const resp = await gapi.client.drive.files.copy({
            fileId, resource: { name: newName, parents: [this.folderId] }
        });
        return resp.result;
    },

    async deleteFile(fileId) {
        await this.ensureToken();
        await gapi.client.drive.files.delete({ fileId });
    },

    async downloadJson(fileId) {
        const resp = await gapi.client.drive.files.get({ fileId, alt: 'media' });
        return typeof resp.body === 'string' ? JSON.parse(resp.body) : resp.result;
    },

    /** メインファイルを読み込む。存在しなければ null を返す。 */
    async loadJson(mainFilename) {
        const file = await this.findExact(mainFilename);
        if (!file) return null;
        const data = await this.downloadJson(file.id);
        return { data, modifiedTime: file.modifiedTime, fileId: file.id };
    },

    /** 生データのアップロード（新規作成 or 上書き）。通常は直接使わず saveJsonWithBackup 経由を推奨。 */
    async uploadFile(filename, content, mimeType, existingId = undefined) {
        await this.ensureToken();
        let targetId = existingId;
        if (targetId === undefined) {
            const resp = await gapi.client.drive.files.list({
                q: `'${this.folderId}' in parents and name='${filename}' and trashed=false`,
                fields: 'files(id)'
            });
            targetId = (resp.result.files || [])[0]?.id || null;
        }
        if (targetId) {
            await fetch(`https://www.googleapis.com/upload/drive/v3/files/${targetId}?uploadType=media`, {
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${this.accessToken}`, 'Content-Type': mimeType },
                body: content
            });
            return targetId;
        } else {
            const meta = { name: filename, mimeType, parents: [this.folderId] };
            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
            form.append('file', new Blob([content], { type: mimeType }));
            const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST', headers: { 'Authorization': `Bearer ${this.accessToken}` }, body: form
            });
            const json = await resp.json();
            return json.id;
        }
    },

    async uploadJson(filename, data, existingId = undefined) {
        return this.uploadFile(filename, JSON.stringify(data, null, 2), 'application/json', existingId);
    },

    async uploadCsv(filename, csvContent, existingId = undefined) {
        return this.uploadFile(filename, '\uFEFF' + csvContent, 'text/csv', existingId);
    },

    /**
     * メインファイルを保存。保存前に既存のメインファイルを backupPrefix 付きでコピー退避し、
     * バックアップが maxBackups 件を超えたら modifiedTime の古い順に削除する。
     *
     * @param {string} mainFilename    例: 'energy_unified_data.json'
     * @param {object} data            保存するJSONデータ
     * @param {object} opts            { backupPrefix: string, maxBackups: number }
     * @returns {object}               { modifiedTime, backedUp: boolean }
     */
    async saveJsonWithBackup(mainFilename, data, opts = {}) {
        const backupPrefix = opts.backupPrefix || (mainFilename.replace(/\.json$/, '') + '_backup');
        const maxBackups = opts.maxBackups ?? 10;

        await this.ensureToken();

        const existing = await this.findExact(mainFilename);
        let backedUp = false;

        if (existing) {
            // 直前の内容を退避
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            await this.copyFile(existing.id, `${backupPrefix}_${ts}.json`);
            backedUp = true;

            // 古いバックアップを整理（modifiedTime基準・maxBackups件だけ残す）
            const backups = await this.listByPrefix(backupPrefix);
            if (backups.length > maxBackups) {
                const toDelete = backups.slice(maxBackups); // 新しい順に並んでいるので、超過分＝末尾
                for (const f of toDelete) {
                    await this.deleteFile(f.id);
                }
            }
        }

        const targetId = existing ? existing.id : undefined;
        await this.uploadJson(mainFilename, data, targetId);

        // 保存後の正確な modifiedTime を取得して返す（表示用）
        const saved = await this.findExact(mainFilename);
        return { modifiedTime: saved ? saved.modifiedTime : new Date().toISOString(), backedUp };
    },

    /** バックアップ一覧を新しい順で取得（復元UIなどに使う） */
    async listBackups(backupPrefix) {
        return this.listByPrefix(backupPrefix);
    }
};
