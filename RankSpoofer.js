/**
 * @name RankSpoofer
 * @author Darksvenor
 * @description Virtual ranks for League of Legends (profiles, tooltips, leaderboards, end of game, custom lobbies), name spoofer and automatic rank sharing between friends.
 * @version 0.9.0
 */

export function load() {
    const VERSION = "0.9.0";
    const STORAGE_KEY = "pengu_virtual_ranks";
    const SETTINGS_KEY = "pengu_virtual_settings";
    const CUTOFFS_KEY = "pengu_virtual_cutoffs";
    const LAST_EOG_KEY = "pengu_virtual_last_eog";
    const EOG_PROMO_KEY = "pengu_virtual_eog_promo";
    const APEX_TIERS = ["MASTER", "GRANDMASTER", "CHALLENGER"];
    const TIER_ORDER = ["CHALLENGER", "GRANDMASTER", "MASTER", "DIAMOND", "EMERALD", "PLATINUM", "GOLD", "SILVER", "BRONZE", "IRON"];
    const DIV_ORDER = { "I": 1, "II": 2, "III": 3, "IV": 4 };
    const DEFAULT_SETTINGS = { spoofBanners: true, spoofHovercards: true, spoofEndGame: true, spoofLeaderboard: true, syncLcu: true, spoofNames: true, autoCutoffs: true, receiveShares: true, shareAlts: true, shareViaStatus: false };
    const DEFAULT_CUTOFFS = { GRANDMASTER: 1824, CHALLENGER: 2438 };

    // Original fetch: used for the plugin's own requests so it never reads its own spoofed data.
    const originalFetch = window.fetch.bind(window);

    const log = (...a) => console.log('%c[VirtualRanks]', 'color:#b36bff', ...a);

    // ---------------------------------------------------------------------
    // STORAGE (with an in-memory cache: no more reading DataStore 25 times per second)
    // ---------------------------------------------------------------------
    function storeGet(key, fallback) {
        try {
            if (window.DataStore) {
                const v = window.DataStore.get(key);
                return (v === undefined || v === null) ? fallback : v;
            }
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function storeSet(key, value) {
        try {
            if (window.DataStore) { window.DataStore.set(key, value); return; }
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {}
    }

    let ranksCache = null;
    let settingsCache = null;

    function getAllVirtualRanks() {
        if (!ranksCache) {
            const r = storeGet(STORAGE_KEY, {});
            ranksCache = (r && typeof r === 'object') ? r : {};
        }
        return ranksCache;
    }

    function saveAllVirtualRanks(ranks) {
        ranksCache = ranks;
        storeSet(STORAGE_KEY, ranks);
        onConfigChanged();
    }

    function saveVirtualRank(puuid, rankData) {
        if (!puuid) return;
        saveAllVirtualRanks({ ...getAllVirtualRanks(), [puuid]: rankData });
    }

    function getSettings() {
        if (!settingsCache) settingsCache = { ...DEFAULT_SETTINGS, ...(storeGet(SETTINGS_KEY, {}) || {}) };
        return settingsCache;
    }

    function saveSettings(settings) {
        settingsCache = { ...DEFAULT_SETTINGS, ...settings };
        storeSet(SETTINGS_KEY, settingsCache);
        onConfigChanged();
    }

    // Cutoffs: manual base values (persisted) + a small random drift on each launch.
    let cutoffBase = { ...DEFAULT_CUTOFFS, ...(storeGet(CUTOFFS_KEY, {}) || {}) };
    let apexCutoffs = { ...cutoffBase };

    function setCutoffBase(gm, chall) {
        gm = parseInt(gm, 10);
        chall = parseInt(chall, 10);
        if (!Number.isFinite(gm) || !Number.isFinite(chall) || gm < 0 || chall < gm) return false;
        cutoffBase = { GRANDMASTER: gm, CHALLENGER: chall };
        apexCutoffs = (getSettings().autoCutoffs && realCutoffs) ? { ...realCutoffs } : { ...cutoffBase };
        storeSet(CUTOFFS_KEY, cutoffBase);
        onConfigChanged();
        return true;
    }

    // ---------------------------------------------------------------------
    // CONNECTED ACCOUNT
    // ---------------------------------------------------------------------
    let currentPuuid = null;
    let currentSummonerId = null;
    // Virtual promotion from the last game (shown while on the end-of-game screen)
    let eogPromo = storeGet("pengu_virtual_eog_promo", null);
    let lastSyncedPresenceStr = null;
    let activeHoveredPuuid = null;

    async function fetchCurrentPuuid() {
        try {
            const res = await originalFetch('/lol-summoner/v1/current-summoner');
            if (res.ok) {
                const data = await res.json();
                if (data && data.puuid) currentPuuid = data.puuid;
                if (data && data.summonerId) currentSummonerId = data.summonerId;
            }
        } catch (e) {}
        return currentPuuid;
    }

    (async () => {
        // The plugin may load before login: retry until we get the PUUID.
        for (let i = 0; i < 120 && !currentPuuid; i++) {
            await fetchCurrentPuuid();
            if (!currentPuuid) await new Promise(r => setTimeout(r, 5000));
        }
        if (currentPuuid) schedulePatch();
    })();

    document.addEventListener('mouseover', (e) => {
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        for (const el of path) {
            if (el === document.body || el === document) break;
            const p = el.getAttribute?.('puuid') || el.dataset?.puuid;
            if (p) { activeHoveredPuuid = p; return; }
        }
        let curr = e.target;
        while (curr && curr !== document.body) {
            const p = curr.getAttribute?.('puuid') || curr.dataset?.puuid;
            if (p) { activeHoveredPuuid = p; return; }
            curr = curr.parentElement || (curr.parentNode && curr.parentNode.host);
        }
    }, true);

    // ---------------------------------------------------------------------
    // CHAT STATUS SYNC (visible to your friends)
    // ---------------------------------------------------------------------
    // ---------------------------------------------------------------------
    // RANK SHARING BETWEEN FRIENDS (through the chat presence, which the client already sends to all your friends)
    // Sending: your virtual rank is put in your presence in 2 ways
    //   1) a "vrShare" field in the presence "lol" data
    //   2) optional: an invisible marker (zero-width characters) at the end of your status message,
    //      in case Riot ever strips field 1
    // Receiving: the plugin reads your friends' presence and creates / updates their card automatically.
    // ---------------------------------------------------------------------
    const SHARE_PREFIX = 'VR1';
    const ZW = ['​', '‌', '‍', '⁠'];
    const ZW_MARK = '⁣';
    const ZW_TAG_RE = new RegExp(`${ZW_MARK}[${ZW.join('')}]*${ZW_MARK}`, 'g');

    function encodeZw(str) {
        const bytes = unescape(encodeURIComponent(str));
        let out = '';
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes.charCodeAt(i);
            out += ZW[(b >> 6) & 3] + ZW[(b >> 4) & 3] + ZW[(b >> 2) & 3] + ZW[b & 3];
        }
        return ZW_MARK + out + ZW_MARK;
    }

    function decodeZw(s) {
        const str = String(s || '');
        const a = str.indexOf(ZW_MARK);
        const b = a < 0 ? -1 : str.indexOf(ZW_MARK, a + 1);
        if (a < 0 || b < 0) return null;
        const body = str.slice(a + 1, b);
        if (!body.length || body.length % 4) return null;
        let bytes = '';
        for (let i = 0; i < body.length; i += 4) {
            let v = 0;
            for (let j = 0; j < 4; j++) {
                const d = ZW.indexOf(body[i + j]);
                if (d < 0) return null;
                v = v * 4 + d;
            }
            bytes += String.fromCharCode(v);
        }
        try { return decodeURIComponent(escape(bytes)); } catch (e) { return null; }
    }

    function stripZw(s) {
        return String(s || '').replace(ZW_TAG_RE, '');
    }

    // Names can contain anything: escape the separators | ; ~ and %
    const escField = (v) => String(v || '').replace(/%/g, '%25').replace(/\|/g, '%7C').replace(/;/g, '%3B').replace(/~/g, '%7E');
    const unescField = (v) => { try { return decodeURIComponent(String(v || '')); } catch (e) { return String(v || ''); } };

    // Fields: VR1 | tier | division | lp | wins | losses | banner | spoofed name | real name (alts only)
    function buildSharePayload(conf, withRealName = false) {
        const losses = conf.losses === undefined || conf.losses === null || conf.losses === '' ? '' : String(Number(conf.losses) || 0);
        const parts = [SHARE_PREFIX, String(conf.tier || '').toUpperCase(), conf.division || 'NA', Number(conf.lp) || 0, Number(conf.wins) || 0, losses, String(conf.lastSeasonTier || 'UNRANKED').toUpperCase(), escField(conf.spoofName)];
        if (withRealName) parts.push(escField(conf.name));
        return parts.join('|');
    }

    // Short version for the invisible marker (fewer characters in the status message)
    const TIER_CODE = { IRON: 'I', BRONZE: 'B', SILVER: 'S', GOLD: 'G', PLATINUM: 'P', EMERALD: 'E', DIAMOND: 'D', MASTER: 'M', GRANDMASTER: 'K', CHALLENGER: 'C', UNRANKED: 'U' };
    const CODE_TIER = Object.fromEntries(Object.entries(TIER_CODE).map(([k, v]) => [v, k]));
    const DIV_CODE = { I: '1', II: '2', III: '3', IV: '4', NA: '0' };
    const CODE_DIV = Object.fromEntries(Object.entries(DIV_CODE).map(([k, v]) => [v, k]));

    function buildShortPayload(conf, withRealName = false) {
        const full = buildSharePayload(conf, withRealName).split('|');
        return ['V2', TIER_CODE[full[1]] || 'U', DIV_CODE[full[2]] || '0', full[3], full[4], full[5], TIER_CODE[full[6]] || 'U', ...full.slice(7)].join('|');
    }

    function parseSharePayload(str) {
        if (!str) return null;
        let p = String(str).split('|');
        if (p[0] === 'V2' && p.length >= 7) {
            p = [SHARE_PREFIX, CODE_TIER[p[1]] || '', CODE_DIV[p[2]] || 'NA', p[3], p[4], p[5], CODE_TIER[p[6]] || 'UNRANKED', ...p.slice(7)];
        }
        if (p[0] !== SHARE_PREFIX || p.length < 7) return null;
        const tier = p[1];
        if (!TIER_ORDER.includes(tier)) return null;
        return {
            tier,
            division: p[2] || 'NA',
            lp: Number(p[3]) || 0,
            wins: Number(p[4]) || 0,
            losses: p[5] === '' ? undefined : Number(p[5]) || 0,
            lastSeasonTier: p[6] || 'UNRANKED',
            spoofName: unescField(p[7]),
            realName: unescField(p[8])
        };
    }

    // "Alt" accounts shared on top of the connected account: "puuid~payload;puuid~payload"
    function buildAltsPayload(ranks) {
        if (!getSettings().shareAlts) return '';
        return Object.entries(ranks)
            .filter(([p, c]) => p !== currentPuuid && c && c.type === 'alt' && !c.shared && c.tier)
            .slice(0, 10)
            .map(([p, c]) => `${p}~${buildShortPayload(c, true)}`)
            .join(';');
    }

    function parseAltsPayload(str) {
        if (!str) return [];
        return String(str).split(';').map(part => {
            const i = part.indexOf('~');
            if (i < 0) return null;
            const puuid = part.slice(0, i);
            const share = parseSharePayload(part.slice(i + 1));
            return /^[0-9a-f-]{20,}$/i.test(puuid) && share ? { puuid, share } : null;
        }).filter(Boolean);
    }

    let shareStatusCleaned = false;

    async function syncChatPresenceToLCU(force = false) {
        const settings = getSettings();

        if (!currentPuuid) await fetchCurrentPuuid();
        if (!currentPuuid) return;

        if (!settings.syncLcu) {
            // Option disabled: remove the invisible marker from your status once
            if (!shareStatusCleaned) {
                shareStatusCleaned = true;
                try {
                    const me = await (await originalFetch('/lol-chat/v1/me')).json();
                    if (me && typeof me.statusMessage === 'string' && stripZw(me.statusMessage) !== me.statusMessage) {
                        await originalFetch('/lol-chat/v1/me', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ statusMessage: stripZw(me.statusMessage) }) });
                    }
                } catch (e) {}
            }
            return;
        }
        shareStatusCleaned = false;

        const myRank = getAllVirtualRanks()[currentPuuid];
        if (!myRank || !myRank.tier) return;

        const resolved = resolveTierAndDiv(myRank.tier, myRank.lp, myRank.division);
        const tierU = resolved.tier;
        const divStr = APEX_TIERS.includes(tierU) ? "" : (resolved.div === "NA" ? "" : resolved.div);
        const winsStr = String(myRank.wins || 0);
        const payload = buildSharePayload(myRank);
        const altsPayload = buildAltsPayload(getAllVirtualRanks());

        const signature = `${tierU}_${divStr}_${winsStr}_${payload}_${altsPayload}`;
        if (!force && signature === lastSyncedPresenceStr) return;

        try {
            const body = {
                lol: {
                    rankedLeagueQueue: "RANKED_SOLO_5x5",
                    rankedLeagueTier: tierU,
                    rankedLeagueDivision: divStr,
                    rankedWins: winsStr,
                    vrShare: payload,
                    vrAlts: buildAltsPayload(getAllVirtualRanks())
                }
            };
            try {
                const me = await (await originalFetch('/lol-chat/v1/me')).json();
                const current = me && typeof me.statusMessage === 'string' ? me.statusMessage : '';
                // Backup copy in the status message: off by default (the vrShare field is enough).
                // Disabled -> remove the marker if it is still there.
                const wanted = stripZw(current) + (settings.shareViaStatus ? encodeZw(buildShortPayload(myRank)) : '');
                if (wanted !== current) body.statusMessage = wanted;
            } catch (e) {}

            const res = await originalFetch('/lol-chat/v1/me', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (res.ok) lastSyncedPresenceStr = signature;
        } catch (e) {}
    }

    // Read your friends' presence and update their card
    let lastShareDebug = null;
    async function pullFriendShares() {
        if (!getSettings().receiveShares) return;
        let friends;
        try {
            const res = await originalFetch('/lol-chat/v1/friends');
            if (!res.ok) return;
            friends = await res.json();
        } catch (e) { return; }
        if (!Array.isArray(friends)) return;

        const ranks = getAllVirtualRanks();
        const next = { ...ranks };
        let changed = false;
        const seen = [];

        const apply = (puuid, share, fallbackName, sharedBy) => {
            if (!puuid || puuid === currentPuuid) return;
            const old = next[puuid];
            const resolved = resolveTierAndDiv(share.tier, share.lp, share.division);
            const entry = {
                ...(old || {}),
                name: (old && old.name) || share.realName || fallbackName || '',
                // The friend's own spoofed name wins; if he shares none, keep yours
                spoofName: share.spoofName || (old && old.spoofName) || '',
                tier: resolved.tier,
                division: resolved.div,
                lp: share.lp,
                wins: share.wins,
                losses: share.losses,
                lastSeasonTier: share.lastSeasonTier,
                banner: bannerPath(share.lastSeasonTier),
                type: 'friend',
                shared: true,
                sharedBy,
                text: resolved.text,
                div: resolved.div
            };
            if (entry.losses === undefined) delete entry.losses;
            const keys = ['name', 'spoofName', 'tier', 'division', 'lp', 'wins', 'losses', 'lastSeasonTier', 'type', 'shared', 'sharedBy'];
            if (!old || keys.some(k => String(old[k]) !== String(entry[k]))) {
                next[puuid] = entry;
                changed = true;
            }
        };

        for (const f of friends) {
            if (!f || !f.puuid || f.puuid === currentPuuid) continue;
            const viaField = parseSharePayload(f.lol && f.lol.vrShare);
            const share = viaField || parseSharePayload(decodeZw(f.statusMessage));
            if (!share) continue;
            const alts = parseAltsPayload(f.lol && f.lol.vrAlts);
            seen.push({ name: f.gameName, via: viaField ? 'presence field' : 'invisible status marker', alts: alts.length });
            apply(f.puuid, share, f.gameName ? (f.gameTag ? `${f.gameName}#${f.gameTag}` : f.gameName) : '', f.puuid);
            for (const a of alts) apply(a.puuid, a.share, '', f.puuid);
        }
        lastShareDebug = { at: new Date().toLocaleTimeString(), friends: seen };
        if (changed) {
            saveAllVirtualRanks(next);
            refreshSummonerIds();
            log('Shared ranks received:', seen.map(s => `${s.name} (${s.via}${s.alts ? `, +${s.alts} alt(s)` : ''})`).join(', '));
        }
    }

    // General diagnostics: type  VirtualRanksDebug()  in the console
    window.VirtualRanksDebug = () => ({
        version: VERSION,
        openHookActive: String(XMLHttpRequest.prototype.open).includes('__vrMethod'),
        responseTextHookActive: String(Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText')?.get).includes('transformed'),
        cutoffs: apexCutoffs,
        realCutoffs: realCutoffs,
        accounts: Object.keys(getAllVirtualRanks()).length
    });

    // Sharing diagnostics: type  await VirtualRanksShareDebug()  in the console
    window.VirtualRanksShareDebug = async () => {
        const out = { lastPass: lastShareDebug, friends: [] };
        try {
            const friends = await (await originalFetch('/lol-chat/v1/friends')).json();
            for (const f of friends) {
                const field = f.lol && f.lol.vrShare;
                const hidden = decodeZw(f.statusMessage);
                if (field || hidden) out.friends.push({ name: f.gameName, field: field || null, alts: (f.lol && f.lol.vrAlts) || null, invisible: hidden || null });
            }
        } catch (e) { out.error = String(e); }
        return out;
    };

    // ---------------------------------------------------------------------
    // FETCH INTERCEPTION (data returned to the client)
    // ---------------------------------------------------------------------
    function spoofPlayerObjects(root, ranks) {
        let modified = false;
        const seen = new Set();
        const visit = (obj, depth) => {
            if (!obj || typeof obj !== 'object' || depth > 6 || seen.has(obj)) return;
            seen.add(obj);
            if (Array.isArray(obj)) { obj.forEach(o => visit(o, depth + 1)); return; }

            const conf = obj.puuid ? ranks[obj.puuid] : null;
            if (conf && conf.spoofName) {
                const [sGame, sTag] = splitRiotId(conf.spoofName);
                if (sGame) {
                    for (const k of ['gameName', 'displayName', 'name']) {
                        if (typeof obj[k] === 'string' && obj[k] !== sGame) { obj[k] = sGame; modified = true; }
                    }
                }
                if (sTag) {
                    for (const k of ['tagLine', 'gameTag']) {
                        if (typeof obj[k] === 'string' && obj[k] !== sTag) { obj[k] = sTag; modified = true; }
                    }
                }
            }
            for (const v of Object.values(obj)) {
                if (v && typeof v === 'object') visit(v, depth + 1);
            }
        };
        visit(root, 0);
        return modified;
    }

    function spoofRankedStats(data, myRank) {
        const resolved = resolveTierAndDiv(myRank.tier, myRank.lp, myRank.division);
        const tierU = resolved.tier;
        const divStr = APEX_TIERS.includes(tierU) ? '' : (resolved.div === 'NA' ? '' : resolved.div);
        const apply = (q) => {
            if (!q) return;
            q.tier = tierU;
            q.division = divStr;
            q.leaguePoints = myRank.lp;
            q.wins = myRank.wins || 0;
        };
        if (data && Array.isArray(data.queues)) apply(data.queues.find(q => q.queueType === 'RANKED_SOLO_5x5'));
        if (data && data.queueMap) apply(data.queueMap.RANKED_SOLO_5x5);
    }

    function jsonResponse(data, response) {
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        return new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers });
    }

    window.fetch = async function(...args) {
        const response = await originalFetch(...args);
        try {
            const req = args[0];
            const url = typeof req === 'string' ? req : (req && req.url) || String(req || '');
            if (!url || !response.ok) return response;

            const settings = getSettings();
            const ranks = getAllVirtualRanks();
            const wantsNames = settings.spoofNames && (url.includes('lol-summoner/') || url.includes('lol-chat/v1/'));
            const myRank = currentPuuid ? ranks[currentPuuid] : null;
            const wantsRank = settings.spoofBanners && myRank && currentPuuid &&
                (url.includes(`lol-ranked/v1/ranked-stats/${currentPuuid}`) || url.includes('lol-ranked/v1/current-ranked-stats'));

            if (url.includes('lol-game-data/assets/v1/generic-assets.json')) {
                const ga = await response.clone().json();
                return transformGenericAssets(ga) ? jsonResponse(ga, response) : response;
            }
            if (!wantsNames && !wantsRank) return response;

            const data = await response.clone().json();
            let modified = false;
            if (wantsNames) modified = spoofPlayerObjects(data, ranks) || modified;
            if (wantsRank) { spoofRankedStats(data, myRank); modified = true; }
            return modified ? jsonResponse(data, response) : response;
        } catch (e) {
            return response;
        }
    };

    // ---------------------------------------------------------------------
    // LEADERBOARDS AND RANKS AT THE DATA LEVEL (XMLHttpRequest)
    // The client loads its data through XMLHttpRequest (rcp-fe-common-libs dataBinding), not fetch.
    // So we edit the JSON response before the client reads it: it renders everything itself,
    // in the right order, with the right numbering, without us touching its rows.
    // ---------------------------------------------------------------------
    const RANKED_QUEUE = 'RANKED_SOLO_5x5';
    const summonerIdCache = new Map();   // puuid -> summonerId (so the client recognises injected players)
    const apexCache = {};                // tier -> real response of /lol-ranked/v1/apex-leagues/RANKED_SOLO_5x5/<tier>
    let realCutoffs = null;              // real cutoffs taken from the real top 300

    async function refreshSummonerIds() {
        for (const puuid of Object.keys(getAllVirtualRanks())) {
            if (summonerIdCache.has(puuid)) continue;
            try {
                const res = await originalFetch(`/lol-summoner/v2/summoners/puuid/${puuid}`);
                if (res.ok) {
                    const d = await res.json();
                    if (d && d.summonerId) summonerIdCache.set(puuid, d.summonerId);
                }
            } catch (e) {}
        }
    }

    async function refreshApexData() {
        for (const tier of APEX_TIERS) {
            try {
                const res = await originalFetch(`/lol-ranked/v1/apex-leagues/${RANKED_QUEUE}/${tier}`);
                if (res.ok) apexCache[tier] = await res.json();
            } catch (e) {}
        }
        // Cutoff = LP of the last player in the list (Challenger: #300, GM: the last GM)
        const minLp = (tier) => {
            const st = apexCache[tier]?.divisions?.[0]?.standings;
            if (!Array.isArray(st) || !st.length) return null;
            return Math.min(...st.map(s => Number(s.leaguePoints) || 0));
        };
        const chall = minLp('CHALLENGER');
        const gm = minLp('GRANDMASTER');
        if (chall !== null && gm !== null && gm < chall) {
            realCutoffs = { GRANDMASTER: gm, CHALLENGER: chall };
            if (getSettings().autoCutoffs) {
                apexCutoffs = { ...realCutoffs };
                onConfigChanged();
            }
            log(`Real cutoffs: GM ${gm} / Challenger ${chall}`);
        }
    }

    function clone(o) {
        return JSON.parse(JSON.stringify(o));
    }

    // Does this (virtual) account belong to this ladder division?
    function belongsTo(conf, tier, division) {
        if (!conf || !conf.tier) return false;
        const r = resolveTierAndDiv(conf.tier, conf.lp, conf.division);
        if (APEX_TIERS.includes(r.tier)) return r.tier === tier;
        return r.tier === tier && r.div === division;
    }

    function virtualStanding(template, puuid, conf, tier, division) {
        const s = clone(template || {});
        const wins = Number(conf.wins) || 0;
        Object.assign(s, {
            puuid,
            summonerId: summonerIdCache.get(puuid) || s.summonerId || 0,
            summonerName: '',
            tier,
            division,
            leaguePoints: Number(conf.lp) || 0,
            wins,
            losses: conf.losses !== undefined ? Number(conf.losses) || 0 : Math.round(wins * 0.9),
            miniseriesResults: [],
            pendingDemotion: false,
            pendingPromotion: false,
            isProvisional: false,
            provisionalGamesRemaining: 0,
            positionDelta: 0,
            previousPosition: 0,
            previousSeasonEndTier: lastSeasonOf(conf),
            previousSeasonEndDivision: lastSeasonOf(conf) ? (APEX_TIERS.includes(lastSeasonOf(conf)) ? 'NA' : 'I') : 'NA'
        });
        return s;
    }

    // Add / update / remove the plugin's accounts in a division, then re-sort and renumber
    function injectIntoDivision(div, ranks) {
        if (!div || !div.tier) return false;
        const standings = Array.isArray(div.standings) ? div.standings : [];
        const template = standings.find(s => !ranks[s.puuid]) || standings[0] || { division: div.division };
        let changed = false;
        const out = [];

        for (const s of standings) {
            const conf = ranks[s.puuid];
            if (!conf) { out.push(s); continue; }
            changed = true;
            if (belongsTo(conf, div.tier, div.division)) out.push(virtualStanding(s, s.puuid, conf, div.tier, div.division));
            // otherwise: its virtual rank is not in this division -> remove it
        }
        for (const [puuid, conf] of Object.entries(ranks)) {
            if (out.some(s => s.puuid === puuid)) continue;
            if (!belongsTo(conf, div.tier, div.division)) continue;
            out.push(virtualStanding(template, puuid, conf, div.tier, div.division));
            changed = true;
        }
        if (!changed) return false;

        out.sort((a, b) => (Number(b.leaguePoints) || 0) - (Number(a.leaguePoints) || 0) || (a.position || 9999) - (b.position || 9999));
        // The Challenger/GM top has a fixed size: the last real player drops out
        const max = APEX_TIERS.includes(div.tier) ? Number(div.maxLeagueSize || div.topNumberOfPlayers) || 0 : 0;
        while (max && out.length > max) {
            let idx = -1;
            for (let i = out.length - 1; i >= 0; i--) { if (!ranks[out[i].puuid]) { idx = i; break; } }
            if (idx < 0) break;
            out.splice(idx, 1);
        }
        out.forEach((s, i) => { s.position = i + 1; });
        div.standings = out;
        return true;
    }

    // The client only fills the Master / GM / Challenger tabs that are present in the response:
    // the others become empty tabs ("Players are still battling..."). So we fill all 3.
    function fillAllApexDivisions(obj) {
        const have = new Map((obj.divisions || []).filter(Boolean).map(d => [d.tier, d]));
        for (const t of APEX_TIERS) {
            if (!have.has(t) && apexCache[t]?.divisions?.[0]) have.set(t, clone(apexCache[t].divisions[0]));
        }
        const filled = APEX_TIERS.map(t => have.get(t)).filter(Boolean);
        if (filled.length === (obj.divisions || []).length) return false;
        obj.divisions = filled;
        return true;
    }

    // /lol-ranked/v1/league-ladders/<puuid>: a player's league (your "Ranked" page, a friend's profile...)
    function transformLeagueLadders(data, requestedPuuid, ranks) {
        if (!Array.isArray(data)) return false;
        const queue = data.find(q => q && q.queueType === RANKED_QUEUE);
        if (!queue) return false;
        let changed = false;
        const conf = requestedPuuid ? ranks[requestedPuuid] : null;

        if (conf && conf.tier) {
            const r = resolveTierAndDiv(conf.tier, conf.lp, conf.division);
            const hasDiv = (queue.divisions || []).some(d => d.tier === r.tier && (APEX_TIERS.includes(r.tier) || d.division === r.div));
            if (!hasDiv) {
                if (APEX_TIERS.includes(r.tier) && apexCache[r.tier]?.divisions?.length) {
                    // Virtual Master+ rank: show the real ladder of that tier
                    queue.divisions = clone(apexCache[r.tier].divisions);
                } else if (queue.divisions && queue.divisions[0]) {
                    // No data for that rank: relabel the real league with the virtual rank
                    const d = queue.divisions[0];
                    d.tier = r.tier;
                    d.division = APEX_TIERS.includes(r.tier) ? 'NA' : r.div;
                    (d.standings || []).forEach(s => { s.tier = d.tier; s.division = d.division; });
                    queue.divisions = [d];
                }
                queue.tier = r.tier;
                changed = true;
            }
        }

        if (APEX_TIERS.includes(queue.tier) || (queue.divisions || []).some(d => APEX_TIERS.includes(d.tier))) {
            changed = fillAllApexDivisions(queue) || changed;
        }
        for (const div of queue.divisions || []) changed = injectIntoDivision(div, ranks) || changed;

        if (conf && conf.tier) {
            const r = resolveTierAndDiv(conf.tier, conf.lp, conf.division);
            const div = (queue.divisions || []).find(d => d.tier === r.tier);
            const mine = div && (div.standings || []).find(s => s.puuid === requestedPuuid);
            if (mine) {
                queue.requestedRankedEntry = { ...clone(mine), position: 0 };
                queue.tier = r.tier;
                changed = true;
            }
        }
        return changed;
    }

    // /lol-ranked/v1/apex-leagues/RANKED_SOLO_5x5/<TIER>: Master / Grandmaster / Challenger tabs
    function transformApexLeague(data, ranks) {
        if (!data || !Array.isArray(data.divisions)) return false;
        // Keep the fresh real response in cache (before editing)
        for (const d of data.divisions) {
            if (d && APEX_TIERS.includes(d.tier) && Array.isArray(d.standings) && d.standings.length) {
                apexCache[d.tier] = { ...clone(data), divisions: [clone(d)] };
            }
        }
        let changed = fillAllApexDivisions(data);
        for (const div of data.divisions) changed = injectIntoDivision(div, ranks) || changed;
        return changed;
    }

    // /lol-social-leaderboard/v1/social-leaderboard-data: friends leaderboard
    const TIER_RANK = ['NONE', 'UNRANKED', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
    function rowScore(r) {
        const t = Math.max(0, TIER_RANK.indexOf(String(r.tier || 'NONE').toUpperCase()));
        const d = APEX_TIERS.includes(String(r.tier).toUpperCase()) ? 0 : (5 - (DIV_ORDER[r.division] || 5));
        return t * 100000 + d * 10000 + (Number(r.leaguePoints) || 0);
    }

    function transformSocialLeaderboard(data, ranks) {
        const rows = data && data.rowData;
        if (!Array.isArray(rows) || !rows.length) return false;
        let changed = false;
        for (const row of rows) {
            const conf = ranks[row.puuid];
            if (!conf || !conf.tier) continue;
            const r = resolveTierAndDiv(conf.tier, conf.lp, conf.division);
            row.tier = r.tier;
            row.division = APEX_TIERS.includes(r.tier) ? 'NA' : r.div;
            row.leaguePoints = Number(conf.lp) || 0;
            row.wins = Number(conf.wins) || 0;
            changed = true;
        }
        if (!changed) return false;
        const descending = (rows[0].leaderboardPosition || 0) > (rows[rows.length - 1].leaderboardPosition || 0);
        const ranked = [...rows].sort((a, b) => rowScore(b) - rowScore(a) || (a.leaderboardPosition || 0) - (b.leaderboardPosition || 0));
        ranked.forEach((row, i) => { row.leaderboardPosition = i + 1; });
        rows.sort((a, b) => descending ? b.leaderboardPosition - a.leaderboardPosition : a.leaderboardPosition - b.leaderboardPosition);
        return true;
    }

    // /lol-ranked/v1/ranked-stats/<puuid> and current-ranked-stats: rank shown on profiles
    function transformRankedStats(data, conf) {
        if (!data || !conf || !conf.tier) return false;
        const r = resolveTierAndDiv(conf.tier, conf.lp, conf.division);
        const apply = (q) => {
            if (!q) return;
            q.tier = r.tier;
            q.division = APEX_TIERS.includes(r.tier) ? 'NA' : r.div;
            q.leaguePoints = Number(conf.lp) || 0;
            q.wins = Number(conf.wins) || 0;
            if (conf.losses !== undefined && conf.losses !== null && 'losses' in q) q.losses = Number(conf.losses) || 0;
            q.isProvisional = false;
            q.provisionalGamesRemaining = 0;
            // Banner (leaderboard side panel, profile) = previous season end rank
            const prev = lastSeasonOf(conf);
            q.previousSeasonEndTier = prev || 'NONE';
            q.previousSeasonEndDivision = prev ? (APEX_TIERS.includes(prev) ? 'NA' : 'I') : 'NA';
            if (prev) {
                q.previousSeasonHighestTier = prev;
                q.previousSeasonHighestDivision = q.previousSeasonEndDivision;
            }
        };
        if (Array.isArray(data.queues)) apply(data.queues.find(q => q.queueType === RANKED_QUEUE));
        if (data.queueMap) apply(data.queueMap[RANKED_QUEUE]);
        // The player's "highest rank": this is what the profile crest, custom game lobbies and a few other widgets display.
        // The edited Solo/Duo entry goes there unless another queue (TFT, Flex...) is already higher, like the real client does.
        const solo = (data.queueMap && data.queueMap[RANKED_QUEUE]) || (Array.isArray(data.queues) && data.queues.find(q => q.queueType === RANKED_QUEUE));
        const virtualScore = rowScore({ tier: r.tier, division: r.div, leaguePoints: Number(conf.lp) || 0 });
        for (const k of ['highestRankedEntry', 'highestRankedEntrySR']) {
            if (k in data) {
                const base = data[k] && typeof data[k] === 'object' ? data[k] : {};
                const otherQueueHigher = base.queueType && base.queueType !== RANKED_QUEUE && rowScore(base) > virtualScore;
                if (otherQueueHigher) continue;
                data[k] = { ...base, ...(solo ? clone(solo) : {}), queueType: RANKED_QUEUE };
                apply(data[k]);
            }
        }
        if ('highestCurrentSeasonReachedTierSR' in data) {
            const cur = String(data.highestCurrentSeasonReachedTierSR || 'NONE').toUpperCase();
            if (TIER_RANK.indexOf(r.tier) >= TIER_RANK.indexOf(cur)) data.highestCurrentSeasonReachedTierSR = r.tier;
        }
        const prev = lastSeasonOf(conf);
        if (prev && 'highestPreviousSeasonEndTier' in data) {
            data.highestPreviousSeasonEndTier = prev;
            data.highestPreviousSeasonEndDivision = APEX_TIERS.includes(prev) ? 'NA' : 'I';
        }
        return true;
    }

    // generic-assets.json: the client's asset list has NO "emerald" entry for banners
    // (checked in the client: BannerSkins/emerald.png exists, but there is no "emerald" key and no Trim_Emerald.png).
    // Without the key an Emerald banner shows nothing. We add it; the trim reuses the Platinum one.
    function transformGenericAssets(data) {
        if (!data || typeof data !== 'object') return false;
        let changed = false;
        const past = data['regalia-bannerskins-pastrank'];
        if (past && typeof past === 'object' && !past.emerald) {
            past.emerald = '/lol-game-data/assets/ASSETS/Regalia/BannerSkins/emerald.png';
            changed = true;
        }
        const trims = data['regalia-banner-trims'];
        if (trims && typeof trims === 'object' && !trims.emerald && (trims.platinum || trims.diamond)) {
            trims.emerald = trims.platinum || trims.diamond;
            changed = true;
        }
        return changed;
    }

    // ---------------------------------------------------------------------
    // COPYCAT: copy another player's whole profile onto yours (client side only)
    // Copied: icon, level, profile background (skin), banner flag, crest / banner type, prestige crest,
    // challenge title / tokens / crest border / score, mastery score + top champions, Eternals, every ranked queue
    // (the profile shows the highest one, e.g. TFT), solo/duo LP, W/L, past-season banner, Riot ID (as spoofed name).
    // ---------------------------------------------------------------------
    const COPYCAT_KEY = 'pengu_virtual_copycat';
    let copycatCache;

    function getCopycat() {
        if (copycatCache === undefined) copycatCache = storeGet(COPYCAT_KEY, null);
        return copycatCache && copycatCache.snapshot ? copycatCache : null;
    }

    function setCopycat(value) {
        copycatCache = value;
        storeSet(COPYCAT_KEY, value);
    }

    async function getJson(url, method) {
        const res = await originalFetch(url, method ? { method } : undefined);
        if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
        return res.json();
    }

    const CHALLENGE_FIELDS = ['title', 'bannerId', 'crestId', 'topChallenges', 'selectedChallengesString', 'prestigeCrestBorderLevel',
        'overallChallengeLevel', 'totalChallengeScore', 'positionPercentile', 'isApex', 'apexLeaderboardPosition', 'categoryProgress', 'pointsUntilNextRank'];
    const REGALIA_FIELDS = ['bannerType', 'crestType', 'selectedPrestigeCrest', 'lastSeasonHighestRank', 'highestRankedEntry'];
    const BACKDROP_FIELDS = ['backdropAugments', 'backdropImage', 'backdropMaskColor', 'backdropType', 'backdropVideo', 'championId'];

    async function copycatFrom(riotId) {
        const [gameName, tagLine] = splitRiotId(riotId);
        if (!gameName || !tagLine) throw new Error('Use the Name#TAG format.');
        if (!currentPuuid) await fetchCurrentPuuid();

        const look = await getJson(`/lol-summoner/v1/alias/lookup?gameName=${encodeURIComponent(gameName)}&tagLine=${encodeURIComponent(tagLine)}`);
        const puuid = look && look.puuid;
        if (!puuid) throw new Error('Player not found.');
        if (puuid === currentPuuid) throw new Error('That is your own account.');

        const summ = await getJson(`/lol-summoner/v2/summoners/puuid/${puuid}`);
        const [profile, regalia, challenges, ranked, backdrop, mastery, eternals] = await Promise.all([
            getJson(`/lol-summoner/v1/summoner-profile?puuid=${puuid}`).catch(() => null),
            getJson(`/lol-regalia/v2/summoners/${summ.summonerId}/regalia`).catch(() => null),
            getJson(`/lol-challenges/v1/summary-player-data/player/${puuid}`).catch(() => null),
            getJson(`/lol-ranked/v1/ranked-stats/${puuid}`).catch(() => null),
            // Profile background actually displayed by the profile page
            getJson(`/lol-collections/v1/inventories/${summ.summonerId}/backdrop`).catch(() => null),
            // Mastery score + top 3 champions of the profile (the client asks for it with a POST)
            getJson(`/lol-champion-mastery/v1/${puuid}/champion-mastery-view/top?count=3`, 'POST').catch(() => null),
            // Eternals shown under the mastery emblem
            getJson(`/lol-statstones/v1/profile-summary/${puuid}`).catch(() => null)
        ]);

        const snapshot = {
            icon: summ.profileIconId,
            level: summ.summonerLevel,
            profile: profile ? { backgroundSkinId: profile.backgroundSkinId, backgroundSkinAugments: profile.backgroundSkinAugments || '', equippedBannerFlag: profile.equippedBannerFlag, regalia: profile.regalia } : null,
            regalia: regalia ? Object.fromEntries(REGALIA_FIELDS.filter(k => k in regalia).map(k => [k, regalia[k]])) : null,
            challenges: challenges ? Object.fromEntries(CHALLENGE_FIELDS.filter(k => k in challenges).map(k => [k, challenges[k]])) : null,
            backdrop: backdrop ? Object.fromEntries(BACKDROP_FIELDS.filter(k => k in backdrop).map(k => [k, backdrop[k]])) : null,
            mastery: mastery && Array.isArray(mastery.masteries) ? { score: mastery.score, masteries: mastery.masteries } : null,
            eternals: Array.isArray(eternals) ? eternals : null,
            // Every queue (Solo/Duo, Flex, TFT...) and the "highest rank" the profile crest uses
            ranked: ranked && typeof ranked === 'object' ? ranked : null,
            v: 2
        };
        const displayId = `${summ.gameName || gameName}#${summ.tagLine || tagLine}`;

        // Rank -> your own card (the rest of the plugin then shows it everywhere and shares it with friends)
        const ranks = { ...getAllVirtualRanks() };
        const old = ranks[currentPuuid] || null;
        const solo = ranked && ((ranked.queueMap && ranked.queueMap[RANKED_QUEUE]) || (ranked.queues || []).find(q => q.queueType === RANKED_QUEUE));
        const soloTier = solo && String(solo.tier || '').toUpperCase();
        let me = null;
        try { me = await getJson('/lol-summoner/v1/current-summoner'); } catch (e) {}
        const myName = (old && old.name) || (me && me.gameName ? `${me.gameName}#${me.tagLine}` : '');
        const prevTier = String((solo && solo.previousSeasonEndTier) || (ranked && ranked.highestPreviousSeasonEndTier) || '').toUpperCase();
        const lastSeasonTier = TIER_ORDER.includes(prevTier) ? prevTier : 'UNRANKED';
        const entry = { ...(old || {}), name: myName, spoofName: displayId, type: 'alt', lastSeasonTier, banner: bannerPath(lastSeasonTier) };
        let rankCopied = false;
        if (soloTier && TIER_ORDER.includes(soloTier)) {
            const r = resolveTierAndDiv(soloTier, Number(solo.leaguePoints) || 0, solo.division);
            Object.assign(entry, { tier: r.tier, division: r.div, lp: Number(solo.leaguePoints) || 0, wins: Number(solo.wins) || 0, losses: Number(solo.losses) || 0, text: r.text, div: r.div });
            rankCopied = true;
        }
        delete entry.shared;
        if (entry.tier) ranks[currentPuuid] = entry;

        const prev = getCopycat();
        setCopycat({ sourcePuuid: puuid, riotId: displayId, snapshot, backup: prev ? prev.backup : old, at: Date.now() });
        saveAllVirtualRanks(ranks);
        syncChatPresenceToLCU(true);
        log(`Copycat: copied ${displayId}`);
        return { displayId, rankCopied, hasProfile: !!profile, hasRegalia: !!regalia, hasChallenges: !!challenges };
    }

    function stopCopycat() {
        const cc = getCopycat();
        if (!cc) return false;
        const ranks = { ...getAllVirtualRanks() };
        if (currentPuuid) {
            if (cc.backup) ranks[currentPuuid] = cc.backup;
            else delete ranks[currentPuuid];
        }
        setCopycat(null);
        saveAllVirtualRanks(ranks);
        syncChatPresenceToLCU(true);
        log('Copycat stopped');
        return true;
    }

    // Applies the copied profile to the data the client receives about YOU
    function transformCopycat(url, data) {
        const cc = getCopycat();
        if (!cc || !currentPuuid || !data || typeof data !== 'object') return false;
        const S = cc.snapshot;
        const mySid = currentSummonerId ? String(currentSummonerId) : '';
        let changed = false;

        const isMe = (o) => o && typeof o === 'object' && (o.puuid === currentPuuid || (mySid && String(o.summonerId) === mySid));
        const patchSummoner = (o) => {
            if (!isMe(o)) return;
            if (S.icon !== undefined && 'profileIconId' in o) { o.profileIconId = S.icon; changed = true; }
            if (S.level !== undefined && 'summonerLevel' in o) { o.summonerLevel = S.level; changed = true; }
        };

        if (S.backdrop && mySid && url.includes(`lol-collections/v1/inventories/${mySid}/backdrop`)) {
            Object.assign(data, clone(S.backdrop));
            if (S.icon !== undefined && 'profileIconId' in data) data.profileIconId = S.icon;
            return true;
        }
        if (S.mastery && url.includes(`lol-champion-mastery/v1/${currentPuuid}/champion-mastery-view/top`)) {
            const count = Number((url.match(/[?&]count=(\d+)/) || [])[1]) || S.mastery.masteries.length;
            data.score = S.mastery.score;
            data.masteries = clone(S.mastery.masteries).slice(0, count).map(m => ({ ...m, puuid: currentPuuid }));
            return true;
        }
        if (S.eternals && Array.isArray(data) && url.includes(`lol-statstones/v1/profile-summary/${currentPuuid}`)) {
            data.splice(0, data.length, ...clone(S.eternals));
            return true;
        }
        if (S.ranked && (url.includes(`lol-ranked/v1/ranked-stats/${currentPuuid}`) || /lol-ranked\/v1\/current-ranked-stats/.test(url))) {
            // Whole ranked profile of the target; the Solo/Duo card (editable in the menu) is applied on top by transformRankedStats
            for (const [k, v] of Object.entries(clone(S.ranked))) if (k !== 'puuid' && k !== 'summonerId') data[k] = v;
            return true;
        }
        if (/lol-summoner\/v1\/current-summoner\/summoner-profile/.test(url) || (/lol-summoner\/v1\/summoner-profile/.test(url) && url.includes(currentPuuid))) {
            if (S.profile) {
                for (const [k, v] of Object.entries(S.profile)) if (v !== undefined) { data[k] = v; changed = true; }
            }
            return changed;
        }
        if (/lol-summoner\/v1\/current-summoner(\?|$|\/?$)/.test(url)) {
            if (S.icon !== undefined) { data.profileIconId = S.icon; changed = true; }
            if (S.level !== undefined) { data.summonerLevel = S.level; changed = true; }
            return changed;
        }
        if (/lol-summoner\//.test(url)) {
            if (Array.isArray(data)) data.forEach(patchSummoner); else patchSummoner(data);
            return changed;
        }
        if (/lol-regalia\/v2\/current-summoner\/regalia/.test(url) || (mySid && url.includes(`lol-regalia/v2/summoners/${mySid}/regalia`))) {
            if (S.regalia) {
                Object.assign(data, S.regalia);
                if ('preferredBannerType' in data && S.regalia.bannerType) data.preferredBannerType = S.regalia.bannerType;
                if ('preferredCrestType' in data && S.regalia.crestType) data.preferredCrestType = S.regalia.crestType;
            }
            if (S.icon !== undefined && 'profileIconId' in data) data.profileIconId = S.icon;
            if (S.level !== undefined && 'summonerLevel' in data) data.summonerLevel = S.level;
            return true;
        }
        if (/lol-challenges\/v1\/summary-player-data\/local-player/.test(url) || url.includes(`summary-player-data/player/${currentPuuid}`)) {
            if (S.challenges) { Object.assign(data, S.challenges); return true; }
            return false;
        }
        if (/lol-chat\/v1\/me(\?|$)/.test(url) && S.icon !== undefined && 'icon' in data) {
            data.icon = S.icon;
            return true;
        }
        return false;
    }

    // Console helper:  VirtualRanksCopycat('Name#TAG')  /  VirtualRanksCopycat(null) to stop
    window.VirtualRanksCopycat = async (riotId) => riotId ? copycatFrom(riotId) : stopCopycat();

    // Note: depending on the module, the client writes URLs with or without a leading "/" ("lol-ranked/v1/..." or "/lol-ranked/v1/...")
    function transformXhrJson(url, data) {
        const cc = transformCopycat(url, data);
        return transformMain(url, data) || cc;
    }

    function transformMain(url, data) {
        if (url.includes('lol-game-data/assets/v1/generic-assets.json')) return transformGenericAssets(data);
        const settings = getSettings();
        const ranks = getAllVirtualRanks();
        if (!Object.keys(ranks).length) return false;
        let m;
        if (settings.spoofLeaderboard && (m = url.match(/lol-ranked\/v1\/league-ladders\/([0-9a-f-]{20,})/i))) return transformLeagueLadders(data, m[1], ranks);
        if (settings.spoofLeaderboard && url.includes(`lol-ranked/v1/apex-leagues/${RANKED_QUEUE}/`)) return transformApexLeague(data, ranks);
        if (settings.spoofLeaderboard && url.includes('lol-social-leaderboard/v1/social-leaderboard-data') && url.includes(RANKED_QUEUE)) return transformSocialLeaderboard(data, ranks);
        if (settings.spoofBanners && (m = url.match(/lol-ranked\/v1\/ranked-stats\/([0-9a-f-]{20,})/i))) return transformRankedStats(data, ranks[m[1]]);
        if (settings.spoofBanners && url.includes('lol-ranked/v1/current-ranked-stats') && currentPuuid) return transformRankedStats(data, ranks[currentPuuid]);
        return false;
    }

    // WebSocket: the client also receives live updates through its socket ([8,"OnJsonApiEvent...",{uri,data}]).
    // Without this, a value could revert to the real one after a game or a status update.
    (function hookWebSocketEvents() {
        const ME = window.MessageEvent, WS = window.WebSocket;
        const desc = ME && WS && Object.getOwnPropertyDescriptor(ME.prototype, 'data');
        if (!desc || !desc.get) return;
        const WS_URI_RE = /"uri":"\/?(lol-ranked\/|lol-social-leaderboard\/|lol-summoner\/|lol-regalia\/|lol-challenges\/|lol-chat\/v1\/me"|lol-collections\/v1\/inventories\/\d+\/backdrop|lol-statstones\/v1\/profile-summary\/)/;
        const done = new WeakMap();
        Object.defineProperty(ME.prototype, 'data', {
            configurable: true,
            enumerable: desc.enumerable,
            get() {
                const raw = desc.get.call(this);
                if (typeof raw !== 'string' || !raw.startsWith('[8,') || !(this.target instanceof WS)) return raw;
                if (done.has(this)) return done.get(this);
                let out = raw;
                if (WS_URI_RE.test(raw)) {
                    try {
                        const msg = JSON.parse(raw);
                        const ev = msg && msg[2];
                        if (ev && typeof ev.uri === 'string' && ev.data && typeof ev.data === 'object' && transformXhrJson(ev.uri, ev.data)) {
                            out = JSON.stringify(msg);
                        }
                    } catch (e) {}
                }
                done.set(this, out);
                return out;
            }
        });
    })();

    (function hookXhr() {
        const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
        if (!proto) return;
        const textDesc = Object.getOwnPropertyDescriptor(proto, 'responseText');
        const respDesc = Object.getOwnPropertyDescriptor(proto, 'response');
        if (!textDesc || !textDesc.get) return;
        const origOpen = proto.open;
        // POST requests that only READ data (the profile asks for its mastery view with a POST)
        const READ_POST_RE = /lol-champion-mastery\/v1\/[^/]+\/champion-mastery-view\/top/;

        proto.open = function(method, url, ...rest) {
            this.__vrMethod = String(method || 'GET').toUpperCase();
            this.__vrUrl = String(url || '');
            return origOpen.call(this, method, url, ...rest);
        };

        const transformed = function(xhr, raw) {
            if (typeof raw !== 'string' || xhr.readyState !== 4) return raw;
            // URL: the one recorded by our open(), otherwise the response's own URL (responseURL).
            // Another plugin may replace XMLHttpRequest.open after us: responseURL still works.
            const url = xhr.__vrUrl || xhr.responseURL || '';
            if (!url || (xhr.__vrMethod && xhr.__vrMethod !== 'GET' && !READ_POST_RE.test(url))) return raw;
            if (xhr.__vrRaw === raw) return xhr.__vrOut;
            let out = raw;
            if (xhr.status === 200 && /lol-ranked\/|lol-social-leaderboard\/|generic-assets\.json|lol-summoner\/|lol-regalia\/|lol-challenges\/|lol-chat\/v1\/me|lol-collections\/v1\/inventories\/\d+\/backdrop|lol-champion-mastery\/|lol-statstones\/v1\/profile-summary/.test(url)) {
                try {
                    const data = JSON.parse(raw);
                    if (transformXhrJson(url, data)) out = JSON.stringify(data);
                } catch (e) {}
            }
            xhr.__vrRaw = raw;
            xhr.__vrOut = out;
            return out;
        };

        Object.defineProperty(proto, 'responseText', {
            configurable: true,
            enumerable: textDesc.enumerable,
            get() { return transformed(this, textDesc.get.call(this)); }
        });
        if (respDesc && respDesc.get) {
            Object.defineProperty(proto, 'response', {
                configurable: true,
                enumerable: respDesc.enumerable,
                get() {
                    const v = respDesc.get.call(this);
                    return (this.responseType === '' || this.responseType === 'text') ? transformed(this, v) : v;
                }
            });
        }
    })();

    // ---------------------------------------------------------------------
    // RANK MATH
    // ---------------------------------------------------------------------
    function resolveTierAndDiv(tier, lp, division) {
        let upperTier = String(tier || 'UNRANKED').toUpperCase();
        let div = division;
        lp = Number(lp) || 0;

        if (APEX_TIERS.includes(upperTier)) {
            if (lp >= apexCutoffs.CHALLENGER) upperTier = "CHALLENGER";
            else if (lp >= apexCutoffs.GRANDMASTER) upperTier = "GRANDMASTER";
            else upperTier = "MASTER";
            div = "NA";
        }

        const text = APEX_TIERS.includes(upperTier) ? upperTier : `${upperTier} ${div}`;
        return { tier: upperTier, div, text };
    }

    // Divisions from lowest to highest.
    const DIVISIONS = ["IV", "III", "II", "I"];
    const STANDARD_TIERS = ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"];

    function updateLp(currentRank, lpDelta) {
        const base = { ...currentRank };
        let upperTier = String(base.tier || 'IRON').toUpperCase();
        let lp = (Number(base.lp) || 0) + (Number(lpDelta) || 0);
        let division = base.division;

        const finish = (tier, div, finalLp) => {
            const resolved = resolveTierAndDiv(tier, finalLp, div);
            return { ...base, tier: resolved.tier, division: resolved.div, lp: finalLp, type: base.type || 'alt', text: resolved.text, div: resolved.div };
        };

        if (APEX_TIERS.includes(upperTier)) {
            if (lp < 0) return finish("DIAMOND", "I", 75);
            return finish("MASTER", "NA", lp);
        }

        let tierIndex = STANDARD_TIERS.indexOf(upperTier);
        if (tierIndex === -1) tierIndex = 0;
        let divIndex = DIVISIONS.indexOf(division);
        if (divIndex === -1) divIndex = 0;

        // Promotion
        while (lp >= 100) {
            lp -= 100;
            divIndex++;
            if (divIndex > 3) {
                if (tierIndex === STANDARD_TIERS.length - 1) {
                    // Diamond I -> Master
                    return finish("MASTER", "NA", lp);
                }
                tierIndex++;
                divIndex = 0;
            }
        }

        // Demotion (like in game: drop to 75 LP in the division below)
        if (lp < 0) {
            if (divIndex > 0) {
                divIndex--;
                lp = 75;
            } else if (tierIndex > 0) {
                tierIndex--;
                divIndex = 3;
                lp = 75;
            } else {
                lp = 0;
            }
        }

        return finish(STANDARD_TIERS[tierIndex], DIVISIONS[divIndex], lp);
    }

    // Banner path as the client uses it (lowercase file name: .../BannerSkins/gold.png)
    function bannerPath(tier) {
        const t = String(tier || '').toLowerCase();
        return t && t !== 'unranked' && t !== 'none' ? `/lol-game-data/assets/ASSETS/Regalia/BannerSkins/${t}.png` : '';
    }

    function lastSeasonOf(conf) {
        const t = String(conf && conf.lastSeasonTier || '').toUpperCase();
        return t && t !== 'UNRANKED' && t !== 'NONE' ? t : '';
    }

    function getTierFromBanner(url) {
        if (!url) return "UNRANKED";
        const parts = url.split('/');
        const filename = parts[parts.length - 1];
        return filename.split('.')[0].toUpperCase();
    }

    function formatTier(tier) {
        const t = String(tier || '');
        return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
    }

    // ---------------------------------------------------------------------
    // CLIENT LANGUAGE (rank names written the way the client writes them)
    // ---------------------------------------------------------------------
    const TIER_NAMES = {
        fr: {
            IRON: 'Fer', BRONZE: 'Bronze', SILVER: 'Argent', GOLD: 'Or', PLATINUM: 'Platine', EMERALD: 'Émeraude',
            DIAMOND: 'Diamant', MASTER: 'Maître', GRANDMASTER: 'Grand Maître', CHALLENGER: 'Challenger', UNRANKED: 'Non classé'
        },
        en: {
            IRON: 'Iron', BRONZE: 'Bronze', SILVER: 'Silver', GOLD: 'Gold', PLATINUM: 'Platinum', EMERALD: 'Emerald',
            DIAMOND: 'Diamond', MASTER: 'Master', GRANDMASTER: 'Grandmaster', CHALLENGER: 'Challenger', UNRANKED: 'Unranked'
        }
    };

    function clientLang() {
        const loc = (document.body?.getAttribute('data-locale') || document.documentElement?.lang || 'en').toLowerCase();
        return loc.startsWith('fr') ? 'fr' : 'en';
    }

    // Tier name only: "Gold", "Grandmaster"...
    function tierName(tierU) {
        const t = String(tierU || '').toUpperCase();
        return TIER_NAMES[clientLang()][t] || formatTier(t);
    }

    // Full rank: "Gold III", "Challenger" (no division for Master+)
    function rankLabel(tierU, div) {
        const t = String(tierU || '').toUpperCase();
        if (APEX_TIERS.includes(t) || !div || div === 'NA') return tierName(t);
        return `${tierName(t)} ${div}`;
    }

    // Replace the rank while keeping the rest of the client's text ("Past Rank: X", "X (Solo/duo)")
    function keepLabelPrefix(current, newValue) {
        const i = current.indexOf(':');
        return i >= 0 ? `${current.slice(0, i + 1).trimEnd()} ${newValue}` : newValue;
    }

    function keepQueueSuffix(current, newValue) {
        const m = current.match(/\s*\([^)]*\)\s*$/);
        return m ? `${newValue} ${m[0].trim()}` : newValue;
    }

    const SOLO_RE = /solo/i;

    let pastRankPrefix = null; // "Past Rank:" label as the client writes it, captured as soon as we see it
    function defaultPastPrefix() {
        return clientLang() === 'fr' ? 'Rang précédent :' : 'Past Rank:';
    }

    // Only change an image src when needed (avoids reloading the image in a loop)
    function setImgSrc(img, path) {
        if (!img || !path) return;
        const current = img.getAttribute('src') || '';
        if (current !== path && !(img.src || '').endsWith(path)) img.setAttribute('src', path);
    }

    function setText(el, text) {
        if (el && el.textContent !== text) el.textContent = text;
    }

    function getContextConf(el) {
        const PLAYERS_CONFIG = getAllVirtualRanks();
        if (!el) return null;

        const hoverCard = el.closest?.('.hover-card') || el.host?.closest?.('.hover-card');
        if (hoverCard) {
            const regaliaHover = hoverCard.querySelector('lol-regalia-hovercard-v2-element');
            const p = regaliaHover?.getAttribute('puuid');
            if (p && PLAYERS_CONFIG[p]) return PLAYERS_CONFIG[p];
        }

        const profileEl = el.closest?.('lol-regalia-profile-v2-element') || el.host?.closest?.('lol-regalia-profile-v2-element');
        if (profileEl) {
            const p = profileEl.getAttribute('puuid');
            if (p && PLAYERS_CONFIG[p]) return PLAYERS_CONFIG[p];
        }

        let curr = el;
        while (curr) {
            const p = curr.getAttribute?.('puuid');
            if (p && PLAYERS_CONFIG[p]) return PLAYERS_CONFIG[p];
            curr = curr.parentElement || (curr.parentNode && curr.parentNode.host);
        }
        return null;
    }

    function getPageAuth() {
        const PLAYERS_CONFIG = getAllVirtualRanks();
        const profiles = document.querySelectorAll('lol-regalia-profile-v2-element');
        if (!profiles.length) return null;
        let auth = null, foreign = false;
        for (const p of profiles) {
            const puuid = p.getAttribute('puuid');
            if (puuid && PLAYERS_CONFIG[puuid]) auth = PLAYERS_CONFIG[puuid];
            else if (p.getAttribute('is-searched') === 'true') foreign = true;
        }
        return foreign ? null : auth;
    }

    function simulateFriendsOnStartup() {
        const ranks = { ...getAllVirtualRanks() };
        let updated = false;
        const now = Date.now();
        const lastSim = Number(localStorage.getItem('pengu_last_friend_sim')) || 0;

        if (now - lastSim > 30 * 60 * 1000) {
            for (const [puuid, data] of Object.entries(ranks)) {
                if (data && data.type === 'friend' && !data.shared && puuid !== currentPuuid) {
                    const delta = Math.floor(Math.random() * 34) - 15;
                    const newRank = updateLp(data, delta);
                    if (delta > 0) newRank.wins = (newRank.wins || 0) + 1;
                    ranks[puuid] = newRank;
                    updated = true;
                }
            }
            if (updated) {
                saveAllVirtualRanks(ranks);
                localStorage.setItem('pengu_last_friend_sim', String(now));
            }
        }

        // Small cutoff drift on each launch, around the base values
        const cutoffDrift = Math.floor(Math.random() * 5) - 1;
        apexCutoffs.CHALLENGER = cutoffBase.CHALLENGER + cutoffDrift;
        apexCutoffs.GRANDMASTER = cutoffBase.GRANDMASTER + Math.max(-1, cutoffDrift - 1);
    }

    // ---------------------------------------------------------------------
    // NAME SPOOFER
    // Rule: "name#tag" -> "spoof#spooftag", "name" -> "spoof",
    // and the tag alone only when it is alone in its element (the client renders it in its own <span>).
    // A tag is never replaced in the middle of a text: otherwise "1111" would get replaced in CSS, LP, levels...
    // ---------------------------------------------------------------------
    const BIDI_CHARS = '\u200e\u200f\u202a-\u202e\u2066-\u2069';
    const BIDI_RE = new RegExp(`[${BIDI_CHARS}]`, 'g');
    const SPLIT_RE = new RegExp(`^(.*?)([\\s${BIDI_CHARS}]*#[\\s${BIDI_CHARS}]*)(.*)$`, 'su');
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'NOSCRIPT', 'TEMPLATE']);
    const NAME_ATTRS = ['title', 'aria-label', 'alt'];

    let nameRules = null;
    let spoofWritten = new WeakMap();     // text written by the plugin, so we never re-replace our own text
    let sessionRenames = [];              // old spoofs still on screen after an edit in the menu

    function splitRiotId(id) {
        const s = String(id || '').trim();
        const i = s.indexOf('#');
        if (i < 0) return [s, ''];
        return [s.slice(0, i).trim(), s.slice(i + 1).trim()];
    }

    function escapeRegExp(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function buildNameRules() {
        const pairs = [];
        for (const conf of Object.values(getAllVirtualRanks())) {
            if (conf && conf.name && conf.spoofName) pairs.push([conf.name, conf.spoofName]);
        }
        pairs.push(...sessionRenames);

        const full = new Map();   // "pseudo#tag" (minuscules) -> {sGame, sTag}
        const games = new Map();  // "pseudo" -> spoof
        const tags = new Map();   // "tag" -> spooftag
        for (const [real, spoof] of pairs) {
            const [rG, rT] = splitRiotId(real);
            const [sG, sT] = splitRiotId(spoof);
            if (!rG || !sG) continue;
            if (rT) full.set(`${rG}#${rT}`.toLowerCase(), { sG, sT: sT || rT });
            if (rG !== sG) games.set(rG.toLowerCase(), sG);
            if (rT && sT && rT !== sT) tags.set(rT.toLowerCase(), sT);
        }

        // Between the name and the "#", the client sometimes inserts spaces AND invisible
        // direction characters (U+2066 / U+2069): "<U+2066>Name<U+2069> #1111 joined the lobby"
        const SEP = `[\\s${BIDI_CHARS}]*#[\\s${BIDI_CHARS}]*`;
        const alts = [];
        for (const k of full.keys()) {
            const [g, t] = splitRiotId(k);
            alts.push(`${escapeRegExp(g)}${SEP}${escapeRegExp(t)}`);
        }
        for (const t of tags.keys()) alts.push(`#[\\s${BIDI_CHARS}]*${escapeRegExp(t)}`); // "#1111" alone, anywhere
        for (const g of games.keys()) alts.push(escapeRegExp(g));
        alts.sort((a, b) => b.length - a.length);

        let regex = null;
        if (alts.length) {
            // No letter/digit right before or after: "Al" does not touch "Alex"
            regex = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
        }
        nameRules = { full, games, tags, regex, empty: !alts.length && !tags.size };
        return nameRules;
    }

    // inTagElement = the text is inside a client "tag" element (span.player-name__tag-line)
    function spoofString(text, inTagElement = false) {
        const rules = nameRules || buildNameRules();
        if (rules.empty || !text) return text;

        // 1) Tag alone: "#1111" anywhere, or "1111" only inside a tag element
        //    (otherwise a numeric tag would replace LP, levels, prices...)
        if (rules.tags.size) {
            const bare = text.replace(BIDI_RE, '').trim();
            const hasHash = bare.startsWith('#');
            if (hasHash || inTagElement) {
                const tagOnly = (hasHash ? bare.slice(1) : bare).trim();
                const repl = tagOnly && rules.tags.get(tagOnly.toLowerCase());
                if (repl) return text.replace(tagOnly, repl);
            }
        }

        // 2) "name#tag" and "name" anywhere in the text
        if (!rules.regex) return text;
        rules.regex.lastIndex = 0;
        return text.replace(rules.regex, (m) => {
            const parts = m.match(SPLIT_RE);
            if (parts) {
                const [, left, sep, right] = parts;
                const leftName = left.replace(BIDI_RE, '').trim();
                const tag = right.replace(BIDI_RE, '').trim();
                if (!leftName) {
                    // "#1111" tout seul
                    const t = rules.tags.get(tag.toLowerCase());
                    return t ? `${left}${sep}${t}` : m;
                }
                const r = rules.full.get(`${leftName}#${tag}`.toLowerCase());
                if (r) return `${left.replace(leftName, r.sG)}${sep}${r.sT}`;
            }
            const g = rules.games.get(m.toLowerCase());
            return g !== undefined ? g : m;
        });
    }

    function spoofTextNode(node) {
        const value = node.nodeValue;
        if (!value || spoofWritten.get(node) === value) return;
        const parent = node.parentElement;
        const cls = parent && typeof parent.className === 'string' ? parent.className : '';
        const next = spoofString(value, /tag-?line|game-?tag/i.test(cls) && !/separator/i.test(cls));
        if (next !== value) {
            node.nodeValue = next;
            spoofWritten.set(node, next);
        }
    }

    function spoofAttributes(el) {
        for (const attr of NAME_ATTRS) {
            const v = el.getAttribute(attr);
            if (!v) continue;
            const key = `__vrAttr_${attr}`;
            if (el[key] === v) continue;
            const next = spoofString(v);
            if (next !== v) {
                el.setAttribute(attr, next);
                el[key] = next;
            }
        }
    }

    function onConfigChanged() {
        nameRules = null;
        spoofWritten = new WeakMap();
        schedulePatch();
    }

    // ---------------------------------------------------------------------
    // DOM WALK (document + every shadow root, in a single pass)
    // ---------------------------------------------------------------------
    const observedRoots = new WeakSet();
    const observer = new MutationObserver(() => schedulePatch());

    function observeRoot(root) {
        if (observedRoots.has(root)) return;
        observedRoots.add(root);
        try {
            observer.observe(root, {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: ['puuid', 'is-searched', 'ranked-tier', 'ranked-division', 'src', 'class', 'title', 'aria-label']
            });
        } catch (e) {}
    }

    function walk(node, ctx) {
        const type = node.nodeType;
        if (type === 3) {
            if (ctx.names) spoofTextNode(node);
            return;
        }
        if (type === 1) {
            if (SKIP_TAGS.has(node.tagName) || node.id === 'virtual-rank-modal') return;
            const ce = node.getAttribute('contenteditable');
            if (ce !== null && ce !== 'false') return; // never inside the chat input
            if (ctx.names) spoofAttributes(node);
            if (node.shadowRoot) {
                ctx.roots.push(node.shadowRoot);
                observeRoot(node.shadowRoot);
                walk(node.shadowRoot, ctx);
            }
        }
        for (let c = node.firstChild; c; c = c.nextSibling) walk(c, ctx);
    }

    // ---------------------------------------------------------------------
    // RANK PATCHING (a "root" = document or a shadow root)
    // ---------------------------------------------------------------------
    function patchRoot(root, settings, ranks, pageConfig) {
        // 1. RANK AND LEVEL-BORDER TOOLTIPS (WITH HOVER FILTER)
        if (settings.spoofBanners || settings.spoofHovercards) {
            root.querySelectorAll('.rank-identity-tooltip-component').forEach(block => {
                const blockConfig = (activeHoveredPuuid && ranks[activeHoveredPuuid]) ? ranks[activeHoveredPuuid] : getContextConf(block);
                if (!blockConfig) return;

                const resolved = resolveTierAndDiv(blockConfig.tier, blockConfig.lp, blockConfig.division);
                const tU = resolved.tier;
                const isApex = APEX_TIERS.includes(tU);
                const targetRankText = rankLabel(tU, resolved.div);

                const crestEl = block.querySelector('lol-regalia-emblem-element');
                if (crestEl && crestEl.getAttribute('ranked-tier') !== tU) {
                    crestEl.setAttribute('ranked-tier', tU);
                    crestEl.setAttribute('ranked-division', isApex ? 'NA' : (resolved.div || 'I'));
                }

                const rankTextEl = block.querySelector('.rank-identity-tooltip-rank');
                if (rankTextEl) {
                    const textNode = Array.from(rankTextEl.childNodes).find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0);
                    if (textNode && textNode.textContent.trim() !== targetRankText) textNode.textContent = targetRankText;
                }

                const lpEl = block.querySelector('.rank-identity-tooltip-rank span');
                setText(lpEl, ` - ${blockConfig.lp} LP`);

                const pastRankEl = block.querySelector('.rank-identity-tooltip-past-rank');
                if (pastRankEl) {
                    const pastTierU = (blockConfig.lastSeasonTier || "UNRANKED").toUpperCase();
                    if (pastTierU === "UNRANKED") {
                        if (pastRankEl.style.display !== 'none') pastRankEl.style.display = 'none';
                    } else {
                        if (pastRankEl.style.display) pastRankEl.style.display = '';
                        setImgSrc(pastRankEl.querySelector('.rank-identity-tooltip-past-rank-icon'), `/fe/lol-static-assets/images/ranked-mini-crests/${pastTierU.toLowerCase()}.svg`);
                        const pastTextNode = Array.from(pastRankEl.childNodes).find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0);
                        if (pastTextNode) {
                            const cur = pastTextNode.textContent.trim();
                            if (cur.includes(':')) pastRankPrefix = cur.slice(0, cur.indexOf(':') + 1);
                            const expectedPastText = `${pastRankPrefix || defaultPastPrefix()} ${tierName(pastTierU)}`;
                            if (cur !== expectedPastText) pastTextNode.textContent = ` ${expectedPastText}`;
                        }
                    }
                }
            });

            root.querySelectorAll('.prestige-identity-tooltip-component').forEach(block => {
                const blockConfig = (activeHoveredPuuid && ranks[activeHoveredPuuid]) ? ranks[activeHoveredPuuid] : getContextConf(block);
                if (!blockConfig) return;

                const resolved = resolveTierAndDiv(blockConfig.tier, blockConfig.lp, blockConfig.division);
                const tU = resolved.tier;
                const isApex = APEX_TIERS.includes(tU);
                const targetRankText = rankLabel(tU, resolved.div);
                const divAttr = isApex ? 'NA' : (resolved.div || 'I');

                const pastTierU = (blockConfig.lastSeasonTier || "UNRANKED").toUpperCase();
                const pastRankHtml = pastTierU === "UNRANKED"
                    ? ''
                    : `<div class="rank-identity-tooltip-past-rank">
                           <img src="/fe/lol-static-assets/images/ranked-mini-crests/${pastTierU.toLowerCase()}.svg" class="rank-identity-tooltip-past-rank-icon">
                           ${pastRankPrefix || defaultPastPrefix()} ${tierName(pastTierU)}
                       </div>`;

                if (!block.classList.contains('rank-identity-tooltip-component')) {
                    block.classList.remove('prestige-identity-tooltip-component');
                    block.classList.add('rank-identity-tooltip-component');
                }

                const sig = `${tU}_${divAttr}_${blockConfig.lp}_${pastTierU}`;
                if (block._lastRankedSig !== sig) {
                    block._lastRankedSig = sig;
                    block.innerHTML = `
                        <lol-regalia-emblem-element ranked-tier="${tU}" ranked-division="${divAttr}" crest-type="ranked" class="rank-identity-tooltip-rank-icon"></lol-regalia-emblem-element>
                        <div class="rank-identity-tooltip-details">
                            <div class="rank-identity-tooltip-rank">${targetRankText}<span> - ${blockConfig.lp} LP</span></div>
                            ${pastRankHtml}
                        </div>
                    `;
                }
            });
        }

        // 2. BANNERS, CRESTS AND REGALIA HOVERCARDS
        if (settings.spoofBanners) {
            root.querySelectorAll('lol-regalia-crest-v2-element, lol-regalia-hovercard-v2-element, img.regalia-banner-asset-static-image').forEach(el => {
                const c = getContextConf(el);
                if (!c) return;
                if (el.tagName === 'IMG') {
                    const path = bannerPath(lastSeasonOf(c));
                    if (path) setImgSrc(el, path);
                } else {
                    const resolved = resolveTierAndDiv(c.tier, c.lp, c.division);
                    const tU = resolved.tier;
                    const isApex = APEX_TIERS.includes(tU);
                    if (el.getAttribute('ranked-tier') !== tU) {
                        el.setAttribute('ranked-tier', tU);
                        el.setAttribute('ranked-division', isApex ? 'NA' : (resolved.div || 'I'));
                        el.setAttribute('crest-type', 'ranked');
                    }
                }
            });
        }

        // 3. HOVERCARD TEXT AND MINI-CREST IMAGE
        if (settings.spoofHovercards) {
            root.querySelectorAll('.hover-card-rank').forEach(block => {
                const blockConfig = getContextConf(block);
                if (!blockConfig) return;

                const resolved = resolveTierAndDiv(blockConfig.tier, blockConfig.lp, blockConfig.division);
                const tU = resolved.tier;
                const isApex = APEX_TIERS.includes(tU);
                const label = rankLabel(tU, resolved.div);

                setImgSrc(block.querySelector('.hover-card-rank-image'), `/fe/lol-static-assets/images/ranked-mini-crests/${tU.toLowerCase()}.svg`);

                const imgContainer = block.querySelector('.hover-card-rank-img-container');
                const textNode = Array.from(block.childNodes).find(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0);
                if (textNode) {
                    const cur = textNode.textContent.trim();
                    const targetText = keepQueueSuffix(cur, label);
                    if (cur !== targetText) textNode.textContent = ` ${targetText} `;
                } else if (imgContainer) {
                    Array.from(block.childNodes).forEach(n => { if (n !== imgContainer) n.remove(); });
                    block.appendChild(document.createTextNode(` ${label} (Solo/Duo) `));
                }

                block.querySelectorAll('lol-regalia-emblem-element, .regalia-emblem').forEach(el => {
                    if (el.getAttribute('ranked-tier') !== tU) {
                        el.setAttribute('ranked-tier', tU);
                        if (el.tagName.includes('-')) el.setAttribute('ranked-division', isApex ? 'NA' : (resolved.div || 'I'));
                    }
                });
            });
        }

        // 4/5. Leaderboards (friends + Master/GM/Challenger) are handled at the DATA level (XHR hook),
        //      not by moving rows: moving rows broke the client's rendering (overlapping numbers).

        // 6. TOOLTIPS AND PROFILES
        if (pageConfig && settings.spoofBanners) {
            root.querySelectorAll('.ranked-tooltip-queue, .style-profile-emblem-wrapper, .ranked-tooltip-last-season, lol-social-hovercard').forEach(block => {
                const blockConfig = getContextConf(block) || pageConfig;
                if (!blockConfig) return;

                const resolved = resolveTierAndDiv(blockConfig.tier, blockConfig.lp, blockConfig.division);
                const bannerTierU = getTierFromBanner(blockConfig.banner);
                const bannerTierL = bannerTierU.toLowerCase();

                // "Solo/Duo" in English, "Solo/duo" in French: no dependency on case or language
                const titleEl = block.querySelector('.style-profile-emblem-header-title, .ranked-tooltip-queue-name');
                const isSoloDuo = SOLO_RE.test(titleEl ? titleEl.textContent : block.textContent) || block.tagName === 'LOL-SOCIAL-HOVERCARD';
                const isLastSeason = block.classList.contains('ranked-tooltip-last-season');
                if (!isSoloDuo && !isLastSeason) return;

                const isApex = APEX_TIERS.includes(resolved.tier);
                const targetText = isLastSeason ? tierName(bannerTierU) : rankLabel(resolved.tier, resolved.div);
                const targetTierU = isLastSeason ? bannerTierU : resolved.tier;
                const targetTierL = isLastSeason ? bannerTierL : resolved.tier.toLowerCase();

                setText(block.querySelector('.ranked-tooltip-queue-tier, .style-profile-emblem-header-subtitle'), targetText);

                if (isSoloDuo) {
                    const lpContainer = block.querySelector('.style-profile-ranked-crest-tooltip-lp');
                    if (lpContainer) {
                        const html = `<span>${blockConfig.wins || 0}</span> Wins <span>${blockConfig.lp}</span> LP`;
                        if (lpContainer.innerHTML !== html) lpContainer.innerHTML = html;
                    }
                }

                block.querySelectorAll('lol-regalia-emblem-element, .regalia-emblem').forEach(el => {
                    const tier = el.tagName.includes('-') ? targetTierU : targetTierL;
                    if (el.getAttribute('ranked-tier') !== tier) {
                        el.setAttribute('ranked-tier', tier);
                        if (el.tagName.includes('-')) el.setAttribute('ranked-division', isApex ? 'NA' : (resolved.div || 'I'));
                    }
                });
            });
        }

        // 7. RANKED END-OF-GAME SCREEN (always YOUR progression: no profile page needed)
        //    Structure read from rcp-fe-lol-postgame:
        //    - .ranked-progression-component: emblem, .ranked-progression-update-result-status-text (= "Gold III"),
        //      .ranked-progression-total-lp-container (= total LP, with the gain if shown)
        //    - .postgame-ranked-component: .postgame-ranked-footer (= "Gold III"), emblem
        const myConf = currentPuuid ? ranks[currentPuuid] : null;
        if (settings.spoofEndGame && myConf) {
            const resolved = resolveTierAndDiv(myConf.tier, myConf.lp, myConf.division);
            const tU = resolved.tier;
            const isApex = APEX_TIERS.includes(tU);
            const label = rankLabel(tU, resolved.div);

            root.querySelectorAll('.ranked-progression-component, .postgame-ranked-component').forEach(block => {
                block.querySelectorAll('lol-regalia-emblem-element').forEach(el => {
                    if (el.getAttribute('ranked-tier') !== tU) {
                        el.setAttribute('ranked-tier', tU);
                        el.setAttribute('ranked-division', isApex ? 'NA' : (resolved.div || 'I'));
                    }
                });

                // Rank text: only replaced when it contains a rank name (not "consolation LP" / "penalty" messages...)
                block.querySelectorAll('.ranked-progression-update-result-status-text, .postgame-ranked-footer').forEach(el => {
                    if (looksLikeRank(el.textContent)) setText(el, label);
                });

                // Total LP: replace the first unsigned number, keep the "+X" gain if shown next to it
                const lpc = block.querySelector('.ranked-progression-total-lp-container');
                if (lpc) replaceFirstUnsignedNumber(lpc, myConf.lp);
            });
        }

        // 8. VIRTUAL PROMOTION: "Victory" -> "Promoted to <rank>", "+30 LP" -> "Promoted"
        if (settings.spoofEndGame && eogPromo) {
            const promoWord = clientLang() === 'fr' ? 'Promotion' : 'Promoted';
            const headerText = clientLang() === 'fr' ? `Promotion en ${eogPromo.label}` : `Promoted to ${eogPromo.label}`;

            // "+30 LP": the client renders it with animated digits -> hide them and show our text with the same style
            root.querySelectorAll('.ranked-progression-update-result-container').forEach(c => {
                let promo = Array.from(c.children).find(ch => ch.classList.contains('vr-promo-text'));
                const others = Array.from(c.children).filter(ch => ch !== promo && ch.tagName !== 'LOL-UIKIT-VIDEO');
                if (!promo) {
                    promo = document.createElement('div');
                    promo.className = 'vr-promo-text';
                    const ref = others.find(o => o.textContent.trim()) || others[0] || c;
                    try {
                        const cs = getComputedStyle(ref);
                        for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'color', 'letterSpacing', 'textTransform', 'lineHeight', 'textShadow']) promo.style[k] = cs[k];
                    } catch (e) {}
                    promo.style.textAlign = 'center';
                    c.appendChild(promo);
                }
                setText(promo, promoWord);
                others.forEach(o => { if (o.style.display !== 'none') o.style.display = 'none'; });
                Array.from(c.childNodes).forEach(n => { if (n.nodeType === 3 && n.nodeValue.trim()) n.nodeValue = ''; });
            });

            // "Victory" title of the end-of-game screen
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                if (!VICTORY_RE.test(n.nodeValue) || !inPostgame(n.parentElement)) continue;
                const next = n.nodeValue.replace(/\S.*\S|\S/s, headerText);
                if (next !== n.nodeValue) n.nodeValue = next;
            }
        }
    }

    const VICTORY_RE = /^\s*(victoire|victory)\s*$/i;

    function inPostgame(el) {
        for (let e = el, i = 0; e && i < 40; i++) {
            const cls = typeof e.className === 'string' ? e.className : '';
            if (/postgame|career|end-of-game|eog/i.test(cls) || /POSTGAME/i.test(e.tagName || '')) return true;
            e = e.parentElement || (e.getRootNode && e.getRootNode().host) || null;
        }
        return false;
    }

    // Position on the rank ladder (ignoring LP): used to detect a promotion
    function rankStep(conf) {
        const r = resolveTierAndDiv(conf.tier, conf.lp, conf.division);
        const idx = TIER_ORDER.indexOf(r.tier);
        const tierScore = (TIER_ORDER.length - (idx === -1 ? TIER_ORDER.length : idx)) * 10;
        return tierScore + (APEX_TIERS.includes(r.tier) ? 0 : (5 - (DIV_ORDER[r.div] || 4)));
    }

    function looksLikeRank(text) {
        const t = String(text || '').toLowerCase();
        if (!t.trim()) return false;
        return Object.values(TIER_NAMES).some(names => Object.values(names).some(n => t.includes(n.toLowerCase())));
    }

    function replaceFirstUnsignedNumber(el, value) {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const m = n.nodeValue.match(/(^|[^+\-\u2212\d])(\d[\d\s\u00a0\u202f.,]*\d|\d)/);
            if (!m) continue;
            const idx = m.index + m[1].length;
            const next = n.nodeValue.slice(0, idx) + String(value) + n.nodeValue.slice(idx + m[2].length);
            if (next !== n.nodeValue) n.nodeValue = next;
            return;
        }
    }

    let patching = false;
    let scheduled = false;

    function patchAll() {
        const settings = getSettings();
        const ranks = getAllVirtualRanks();
        const ctx = { names: settings.spoofNames && Object.keys(ranks).length > 0, roots: [] };

        observeRoot(document);
        walk(document, ctx);

        const roots = [document, ...ctx.roots];
        const pageConfig = getPageAuth();
        for (const root of roots) {
            try {
                patchRoot(root, settings, ranks, pageConfig);
            } catch (e) {
                console.error('[VirtualRanks] patch error', e);
            }
        }
    }

    function runPatch() {
        scheduled = false;
        if (patching) return;
        patching = true;
        try {
            patchAll();
        } catch (e) {
            console.error('[VirtualRanks]', e);
        } finally {
            observer.takeRecords(); // ignore our own changes: no infinite loop
            patching = false;
            lastRun = performance.now();
        }
    }

    let lastRun = 0;
    const MIN_PATCH_INTERVAL = 50; // ms: at most ~20 passes per second, even if the client keeps changing

    function schedulePatch() {
        if (scheduled) return;
        scheduled = true;
        const wait = MIN_PATCH_INTERVAL - (performance.now() - lastRun);
        if (wait > 0) setTimeout(() => requestAnimationFrame(runPatch), wait);
        else requestAnimationFrame(runPatch);
    }

    simulateFriendsOnStartup();
    refreshSummonerIds();
    refreshApexData();
    setTimeout(pullFriendShares, 4000);
    setInterval(pullFriendShares, 15000); // friends' presence: shared ranks
    setInterval(refreshApexData, 10 * 60 * 1000); // the top 300 moves: refresh cutoffs every 10 min
    schedulePatch();
    setInterval(schedulePatch, 250);        // safety net if a change is missed by the observer
    setInterval(() => syncChatPresenceToLCU(true), 8000);

    // ---------------------------------------------------------------------
    // CONFIGURATION MENU
    // ---------------------------------------------------------------------
    function esc(v) {
        return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function resolvedTierName(tier, lp) {
        return resolveTierAndDiv(tier, lp, "I").tier;
    }

    function cardHtml(c) {
        const tierU = String(c.tier || 'DIAMOND').toUpperCase();
        const isApex = APEX_TIERS.includes(tierU);
        const baseTier = isApex ? 'MASTER' : tierU;
        const inputStyle = 'background: #222; border: 1px solid #444; border-radius: 4px; padding: 4px; font-size: 13px; font-weight: bold; width: 28%; outline: none;';
        const selStyle = 'padding: 6px; background: #222; color: #fff; border: 1px solid #444; border-radius: 4px;';
        return `
            <div class="virtual-rank-card" data-shared="${c.shared ? '1' : ''}" style="background: #181818; border: 1px solid ${c.isConnected ? '#5c16c5' : (c.shared ? '#1e8449' : '#2c2c2c')}; border-radius: 6px; padding: 12px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px;">
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                    <input type="text" class="vr-name" value="${esc(c.name)}" placeholder="Real Name#Tag" title="Real Riot ID" style="${inputStyle} color: #f0e6d2;" />
                    <input type="text" class="vr-spoof" value="${esc(c.spoofName)}" placeholder="Spoofed Name#Tag" title="Spoofed Riot ID" style="${inputStyle} color: #ff00ff;" />
                    <select class="vr-type" style="background: #222; color: #ff00ff; border: 1px solid #444; border-radius: 4px; font-size: 11px; padding: 4px;">
                        <option value="alt" ${c.type === 'alt' ? 'selected' : ''}>Type: Alt</option>
                        <option value="friend" ${c.type === 'friend' ? 'selected' : ''}>Type: Friend</option>
                    </select>
                    ${c.shared ? '<span title="Rank sent automatically by your friend&#39;s plugin (through their presence). It updates on their next sync." style="font-size: 10px; color: #2ecc71; background: #102a1a; padding: 2px 6px; border-radius: 4px; white-space: nowrap;">Shared by friend</span>' : ''}
                    <span style="font-size: 10px; color: #888; background: #222; padding: 2px 6px; border-radius: 4px;">PUUID: <input type="text" class="vr-puuid" value="${esc(c.puuid)}" style="background: transparent; color: #aaa; border: none; font-size: 10px; width: 110px; outline: none;" /></span>
                    <button class="vr-delete" style="background: #a93226; color: #fff; border: none; padding: 4px 8px; cursor: pointer; border-radius: 4px; font-size: 11px;">Delete</button>
                </div>
                <div style="display: flex; gap: 10px; align-items: center;">
                    <div style="flex: 1; display: flex; flex-direction: column; gap: 3px;">
                        <label style="font-size: 10px; color: #888;">Tier</label>
                        <select class="vr-tier" style="${selStyle}">
                            ${['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER'].map(t => `<option value="${t}" ${baseTier === t ? 'selected' : ''}>${t === 'MASTER' ? 'Master+' : t}</option>`).join('')}
                        </select>
                    </div>
                    <div style="flex: 0.8; display: ${isApex ? 'none' : 'flex'}; flex-direction: column; gap: 3px;" class="vr-div-container">
                        <label style="font-size: 10px; color: #888;">Division</label>
                        <select class="vr-div" style="${selStyle}">
                            ${DIVISIONS.map(d => `<option value="${d}" ${c.division === d ? 'selected' : ''}>${d}</option>`).join('')}
                        </select>
                    </div>
                    <div style="flex: 0.8; display: flex; flex-direction: column; gap: 3px;">
                        <label style="font-size: 10px; color: #888;">LP ${isApex ? `(${resolvedTierName(tierU, c.lp)})` : '(Max 99)'}</label>
                        <input type="number" class="vr-lp" value="${Number(c.lp) || 0}" placeholder="LP" ${isApex ? '' : 'max="99"'} style="${selStyle}" />
                    </div>
                    <div style="flex: 0.8; display: flex; flex-direction: column; gap: 3px;">
                        <label style="font-size: 10px; color: #888;">Wins</label>
                        <input type="number" class="vr-wins" value="${Number(c.wins) || 0}" placeholder="Wins" style="${selStyle}" />
                    </div>
                    <div style="flex: 0.8; display: flex; flex-direction: column; gap: 3px;">
                        <label style="font-size: 10px; color: #888;" title="Empty = 90% of wins">Losses</label>
                        <input type="number" class="vr-losses" value="${c.losses === undefined || c.losses === null ? '' : Number(c.losses) || 0}" placeholder="auto" style="${selStyle}" />
                    </div>
                    <div style="flex: 1.2; display: flex; flex-direction: column; gap: 3px;">
                        <label style="font-size: 10px; color: #888;">Last Season (Banner)</label>
                        <select class="vr-last-tier" style="${selStyle}">
                            ${['UNRANKED', 'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'].map(t => `<option value="${t}" ${(c.lastSeasonTier || 'UNRANKED') === t ? 'selected' : ''}>${t}</option>`).join('')}
                        </select>
                    </div>
                </div>
            </div>
        `;
    }

    async function fetchRiotIdByPuuid(puuid) {
        for (const u of [`/lol-summoner/v2/summoners/puuid/${puuid}`, `/lol-summoner/v1/summoners-by-puuid-cached/${puuid}`]) {
            try {
                const res = await originalFetch(u);
                if (!res.ok) continue;
                const data = await res.json();
                if (data && data.gameName) return data.tagLine ? `${data.gameName}#${data.tagLine}` : data.gameName;
                if (data && data.displayName) return data.displayName;
            } catch (e) {}
        }
        return null;
    }

    function findSearchedProfile(root) {
        for (const p of root.querySelectorAll('lol-regalia-profile-v2-element')) {
            if (p.getAttribute('is-searched') === 'true' && p.getAttribute('puuid')) return p;
        }
        for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) {
                const found = findSearchedProfile(el.shadowRoot);
                if (found) return found;
            }
        }
        return null;
    }

    function openRankConfigModal(initialStatus) {
        if (document.getElementById('virtual-rank-modal')) return;

        const ranks = getAllVirtualRanks();
        const settings = getSettings();
        const copycat = getCopycat();
        let ranksHtml = '';
        for (const [puuid, data] of Object.entries(ranks)) {
            ranksHtml += cardHtml({
                ...data,
                puuid,
                name: data.name || "",
                type: data.type || (puuid === currentPuuid ? 'alt' : 'friend'),
                isConnected: puuid === currentPuuid
            });
        }

        const toggle = (id, checked, label) => `
            <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer;">
                <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} style="accent-color: #5c16c5;" /> ${label}
            </label>`;
        const btn = (id, color, label) => `<button id="${id}" style="background: ${color}; color: #fff; border: none; padding: 6px 10px; cursor: pointer; border-radius: 4px; font-size: 11px;">${label}</button>`;
        const numStyle = 'width: 80px; padding: 4px; background: #222; color: #fff; border: 1px solid #444; border-radius: 4px;';

        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'virtual-rank-modal';
        modalOverlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0,0,0,0.8); display: flex; justify-content: center; align-items: center; z-index: 99999;
        `;

        modalOverlay.innerHTML = `
            <div style="background: #121212; border: 1px solid #333; padding: 25px; width: 900px; border-radius: 10px; color: #fff; font-family: sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <div>
                        <h3 style="margin: 0; color: #f0e6d2; font-size: 18px;">Virtual Ranks & Plugin Settings <span style="font-size: 11px; color: #666;">v${VERSION}</span></h3>
                        <div style="font-size: 11px; color: #888; margin-top: 6px; display: flex; align-items: center; gap: 8px;">
                            Manual cutoffs &mdash; GM: <input type="number" id="vr-cut-gm" value="${cutoffBase.GRANDMASTER}" style="${numStyle}" />
                            Challenger: <input type="number" id="vr-cut-chall" value="${cutoffBase.CHALLENGER}" style="${numStyle}" />
                            <span style="color: #666;">(in use: ${apexCutoffs.GRANDMASTER} / ${apexCutoffs.CHALLENGER}${settings.autoCutoffs && realCutoffs ? ', real' : ', manual'})</span>
                        </div>
                    </div>
                    <button id="vr-close" style="background: transparent; color: #aaa; border: none; font-size: 18px; cursor: pointer;">&times;</button>
                </div>

                <div style="background: #1a1a1a; border: 1px solid #282828; border-radius: 6px; padding: 12px; margin-bottom: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                    ${toggle('toggle-banners', settings.spoofBanners, 'Enable Banners & Profiles Spoof')}
                    ${toggle('toggle-hovercards', settings.spoofHovercards, 'Enable Hovercards Spoof')}
                    ${toggle('toggle-endgame', settings.spoofEndGame, 'Spoof End of Ranked Stats & Wins')}
                    ${toggle('toggle-leaderboard', settings.spoofLeaderboard, 'Spoof Social & Top Players Leaderboards')}
                    ${toggle('toggle-names', settings.spoofNames, 'Enable Name Spoofer')}
                    ${toggle('toggle-lcu', settings.syncLcu, 'Share my rank in my chat status (visible to friends + plugin sharing)')}
                    ${toggle('toggle-sharealts', settings.shareAlts, 'Also share my Alt accounts (rank + spoofed name)')}
                    ${toggle('toggle-statuscopy', settings.shareViaStatus, 'Backup copy in my status message (invisible) &mdash; only if sharing stops working')}
                    ${toggle('toggle-receive', settings.receiveShares, 'Receive ranks shared by my friends (they need the plugin + sharing on)')}
                    ${toggle('toggle-autocut', settings.autoCutoffs, `Automatic cutoffs (real top 300) ${realCutoffs ? `&mdash; GM ${realCutoffs.GRANDMASTER} / Chall ${realCutoffs.CHALLENGER}` : '&mdash; not loaded yet'}`)}
                </div>

                <div style="background: #1a1a1a; border: 1px solid #282828; border-radius: 6px; padding: 12px; margin-bottom: 6px; display: flex; align-items: center; gap: 8px;">
                    <span style="font-size: 13px; font-weight: bold; color: #d7b7ff;">Copycat</span>
                    <input type="text" id="vr-cc-id" placeholder="Name#TAG" value="${esc(copycat ? copycat.riotId : '')}" style="flex: 1; padding: 6px; background: #222; color: #fff; border: 1px solid #444; border-radius: 4px; outline: none;" />
                    ${btn('vr-cc-go', '#8e44ad', 'Copy profile')}
                    ${copycat ? btn('vr-cc-stop', '#7f8c8d', 'Stop') : ''}
                    ${btn('vr-reload', '#34495e', 'Reload UI')}
                </div>
                <div style="font-size: 11px; color: #888; margin: 0 0 18px 2px;">
                    ${copycat
                        ? `Copying <b style="color: #d7b7ff;">${esc(copycat.riotId)}</b>: icon, level, profile background, banner, crest, title, challenge tokens, mastery score and champions, Eternals, ranks of every queue and Riot ID.`
                        : 'Copies a player\'s icon, level, profile background, banner, crest, title, challenge tokens, rank and Riot ID onto your profile (client side only).'}
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <span style="font-size: 13px; font-weight: bold; color: #bbb;">Configured Accounts (Alts & Friends)</span>
                    <div style="display: flex; gap: 8px;">
                        ${btn('vr-fetch-me', '#1f618d', '+ Connected Account')}
                        ${btn('vr-fetch-visited', '#d35400', '+ Add Visited Profile')}
                        ${btn('vr-add-manual', '#27ae60', '+ Add Blank')}
                    </div>
                </div>

                <div id="virtual-rank-list" style="max-height: 250px; overflow-y: auto; padding-right: 5px;">
                    ${ranksHtml || '<p class="vr-empty" style="color: #666; font-style: italic; text-align: center; padding: 20px;">No accounts configured yet.</p>'}
                </div>

                <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 20px; border-top: 1px solid #222; padding-top: 15px;">
                    <span id="vr-status" style="font-size: 12px; color: #aaa;"></span>
                    <button id="vr-save" style="background: #5c16c5; color: #fff; border: none; padding: 8px 18px; cursor: pointer; border-radius: 4px; font-weight: bold;">Save Changes</button>
                </div>
            </div>
        `;

        document.body.appendChild(modalOverlay);
        const $ = (sel) => modalOverlay.querySelector(sel);
        const list = $('#virtual-rank-list');

        let statusTimer = null;
        const status = (msg, color = '#aaa') => {
            const s = $('#vr-status');
            if (!s) return;
            s.textContent = msg;
            s.style.color = color;
            clearTimeout(statusTimer);
            statusTimer = setTimeout(() => { s.textContent = ''; }, 6000);
        };

        const findCardByPuuid = (puuid) => Array.from(list.querySelectorAll('.virtual-rank-card'))
            .find(card => card.querySelector('.vr-puuid').value.trim() === puuid);

        const highlight = (card) => {
            try { card.scrollIntoView({ block: 'nearest' }); } catch (e) {}
            const old = card.style.borderColor;
            card.style.borderColor = '#f1c40f';
            setTimeout(() => { card.style.borderColor = old; }, 1500);
        };

        function addCardToList(c) {
            const empty = list.querySelector('.vr-empty');
            if (empty) empty.remove();
            if (c.puuid) {
                const existing = findCardByPuuid(c.puuid);
                if (existing) {
                    highlight(existing);
                    status('This account is already in the list.', '#f1c40f');
                    return;
                }
            }
            const wrap = document.createElement('div');
            wrap.innerHTML = cardHtml({ tier: 'DIAMOND', division: 'I', lp: 0, wins: 0, lastSeasonTier: 'UNRANKED', type: 'friend', spoofName: '', ...c });
            const card = wrap.firstElementChild;
            list.appendChild(card);
            highlight(card);
        }

        $('#vr-close').onclick = () => modalOverlay.remove();
        modalOverlay.addEventListener('mousedown', (e) => { if (e.target === modalOverlay) modalOverlay.remove(); });

        modalOverlay.addEventListener('click', (e) => {
            if (e.target.classList.contains('vr-delete')) e.target.closest('.virtual-rank-card').remove();
        });

        $('#vr-fetch-me').onclick = async () => {
            const btnEl = $('#vr-fetch-me');
            btnEl.disabled = true;
            try {
                const res = await originalFetch('/lol-summoner/v1/current-summoner');
                if (!res.ok) { status('The client is not ready yet (no account logged in).', '#e74c3c'); return; }
                const data = await res.json();
                currentPuuid = data.puuid;
                const name = data.gameName ? (data.tagLine ? `${data.gameName}#${data.tagLine}` : data.gameName) : (data.displayName || "");
                addCardToList({ puuid: data.puuid, name, type: 'alt', isConnected: true });
            } catch (err) {
                status('Error while fetching the connected account.', '#e74c3c');
            } finally {
                btnEl.disabled = false;
            }
        };

        $('#vr-fetch-visited').onclick = async () => {
            const btnEl = $('#vr-fetch-visited');
            const profile = findSearchedProfile(document);
            if (!profile) {
                status('Open another player\'s profile first (no profile with is-searched = true on the page).', '#e74c3c');
                return;
            }
            const puuid = profile.getAttribute('puuid');
            btnEl.disabled = true;
            try {
                const name = await fetchRiotIdByPuuid(puuid);
                addCardToList({ puuid, name: name || "", type: 'friend' });
                if (!name) status('PUUID found, but not the name: fill it in manually.', '#f1c40f');
            } finally {
                btnEl.disabled = false;
            }
        };

        $('#vr-add-manual').onclick = () => addCardToList({ puuid: '', name: '', type: 'friend' });

        $('#vr-cc-go').onclick = async () => {
            const btnEl = $('#vr-cc-go');
            const id = $('#vr-cc-id').value.trim();
            btnEl.disabled = true;
            status('Copying profile...', '#aaa');
            try {
                const r = await copycatFrom(id);
                modalOverlay.remove();
                openRankConfigModal(`Copied ${r.displayId}${r.rankCopied ? '' : ' (unranked: rank not copied)'}. Click "Reload UI" to apply it everywhere.`);
            } catch (e) {
                status(`Copycat failed: ${e && e.message ? e.message : e}`, '#e74c3c');
                btnEl.disabled = false;
            }
        };
        if ($('#vr-cc-stop')) {
            $('#vr-cc-stop').onclick = () => {
                stopCopycat();
                modalOverlay.remove();
                openRankConfigModal('Copycat stopped, your own profile is back. Click "Reload UI" to apply it everywhere.');
            };
        }
        $('#vr-reload').onclick = () => { try { window.location.reload(); } catch (e) {} };

        if (initialStatus) {
            status(initialStatus, '#2ecc71');
            clearTimeout(statusTimer);
        }

        modalOverlay.addEventListener('change', (e) => {
            if (!e.target.classList.contains('vr-tier')) return;
            const card = e.target.closest('.virtual-rank-card');
            const lpInput = card.querySelector('.vr-lp');
            const label = lpInput.previousElementSibling;
            const isMaster = e.target.value.toUpperCase() === "MASTER";
            card.querySelector('.vr-div-container').style.display = isMaster ? 'none' : 'flex';
            if (isMaster) {
                lpInput.removeAttribute('max');
                if (label) label.textContent = `LP (${resolvedTierName('MASTER', Number(lpInput.value))})`;
            } else {
                lpInput.setAttribute('max', '99');
                if (Number(lpInput.value) > 99) lpInput.value = 99;
                if (label) label.textContent = 'LP (Max 99)';
            }
        });

        modalOverlay.addEventListener('input', (e) => {
            if (!e.target.classList.contains('vr-lp')) return;
            const card = e.target.closest('.virtual-rank-card');
            const isMaster = card.querySelector('.vr-tier').value.toUpperCase() === "MASTER";
            const label = e.target.previousElementSibling;
            if (isMaster) {
                if (label) label.textContent = `LP (${resolvedTierName('MASTER', Number(e.target.value))})`;
            } else if (Number(e.target.value) > 99) {
                e.target.value = 99;
            }
        });

        $('#vr-save').onclick = () => {
            const cards = Array.from(list.querySelectorAll('.virtual-rank-card'));
            const missing = cards.filter(card => !card.querySelector('.vr-puuid').value.trim());
            if (missing.length) {
                missing.forEach(card => { card.querySelector('.vr-puuid').parentElement.style.outline = '1px solid #e74c3c'; highlight(card); });
                status(`${missing.length} account(s) without a PUUID: fill it in or delete the card.`, '#e74c3c');
                return;
            }

            const gmIn = parseInt($('#vr-cut-gm').value, 10), challIn = parseInt($('#vr-cut-chall').value, 10);
            if (!Number.isFinite(gmIn) || !Number.isFinite(challIn) || gmIn < 0 || challIn <= gmIn) {
                status('Invalid cutoffs (GM must be lower than Challenger).', '#e74c3c');
                return;
            }

            const oldRanks = getAllVirtualRanks();
            const newRanks = {};
            cards.forEach(card => {
                const puuid = card.querySelector('.vr-puuid').value.trim();
                const tier = card.querySelector('.vr-tier').value;
                const division = card.querySelector('.vr-div') ? card.querySelector('.vr-div').value : "I";
                let lp = Number(card.querySelector('.vr-lp').value) || 0;
                if (tier !== "MASTER") lp = Math.max(0, Math.min(99, lp));

                const resolved = resolveTierAndDiv(tier, lp, tier === "MASTER" ? "NA" : division);
                const lastSeasonTier = card.querySelector('.vr-last-tier').value;
                newRanks[puuid] = {
                    name: card.querySelector('.vr-name').value.trim(),
                    spoofName: card.querySelector('.vr-spoof').value.trim(),
                    tier: resolved.tier,
                    division: resolved.div,
                    lp,
                    wins: Number(card.querySelector('.vr-wins').value) || 0,
                    ...(card.querySelector('.vr-losses').value.trim() !== '' ? { losses: Number(card.querySelector('.vr-losses').value) || 0 } : {}),
                    ...(card.dataset.shared === '1' ? { shared: true, sharedBy: (oldRanks[puuid] || {}).sharedBy } : {}),
                    lastSeasonTier,
                    banner: bannerPath(lastSeasonTier),
                    type: card.querySelector('.vr-type').value,
                    text: resolved.text,
                    div: resolved.div
                };
            });

            // If a spoof changed, the old one is already on screen: replace it too for this session.
            for (const [puuid, old] of Object.entries(oldRanks)) {
                if (!old || !old.spoofName) continue;
                const now = newRanks[puuid];
                const target = now ? (now.spoofName || now.name) : old.name;
                if (target && target !== old.spoofName) sessionRenames.push([old.spoofName, target]);
            }

            saveSettings({
                spoofBanners: $('#toggle-banners').checked,
                spoofHovercards: $('#toggle-hovercards').checked,
                spoofEndGame: $('#toggle-endgame').checked,
                spoofLeaderboard: $('#toggle-leaderboard').checked,
                spoofNames: $('#toggle-names').checked,
                syncLcu: $('#toggle-lcu').checked,
                autoCutoffs: $('#toggle-autocut').checked,
                receiveShares: $('#toggle-receive').checked,
                shareAlts: $('#toggle-sharealts').checked,
                shareViaStatus: $('#toggle-statuscopy').checked
            });
            setCutoffBase(gmIn, challIn);
            saveAllVirtualRanks(newRanks);
            refreshSummonerIds();
            modalOverlay.remove();
            syncChatPresenceToLCU(true);
        };
    }

    // ---------------------------------------------------------------------
    // COMMAND BAR
    // ---------------------------------------------------------------------
    const tryReg = () => {
        if (!window.CommandBar?.addAction) return false;
        window.CommandBar.addAction({
            name: "Configure Virtual Ranks and Profiles",
            group: "Virtual Ranks",
            perform: () => openRankConfigModal(),
        });
        return true;
    };

    if (!tryReg()) {
        const iv = setInterval(() => { if (tryReg()) clearInterval(iv); }, 500);
    }

    // ---------------------------------------------------------------------
    // RANKED END OF GAME: LP update
    // ---------------------------------------------------------------------
    function extractEogPlayers(data) {
        const byPuuid = new Map();
        const add = (p, teamWin) => {
            if (!p || !p.puuid || byPuuid.has(p.puuid)) return;
            let isWin = null;
            if (typeof p.isWin === 'boolean') isWin = p.isWin;
            else if (typeof teamWin === 'boolean') isWin = teamWin;
            else if (p.stats && (p.stats.WIN !== undefined || p.stats.LOSE !== undefined)) isWin = Number(p.stats.WIN) === 1;
            byPuuid.set(p.puuid, { puuid: p.puuid, isWin, lpChange: Number(p.lpChange) || 0 });
        };
        if (Array.isArray(data.teams)) data.teams.forEach(t => (t.players || []).forEach(p => add(p, t.isWinningTeam)));
        if (Array.isArray(data.stats)) data.stats.forEach(p => add(p));
        if (data.localPlayer) add(data.localPlayer);
        return [...byPuuid.values()];
    }

    let processedEogKey = storeGet(LAST_EOG_KEY, null);
    let eogFirstSeen = { key: null, at: 0 };

    // The real LP gain/loss shown by the client (+X LP): apply the same to the virtual rank
    async function fetchRealLpDelta() {
        try {
            const res = await originalFetch('/lol-ranked/v1/current-lp-change-notification');
            if (res.status !== 200) return null;
            const n = await res.json();
            return (n && typeof n.leaguePointsDelta === 'number') ? n.leaguePointsDelta : null;
        } catch (e) {
            return null;
        }
    }

    window.setInterval(async () => {
        if (!getSettings().spoofEndGame) return;
        try {
            const phaseRes = await originalFetch('/lol-gameflow/v1/gameflow-phase');
            const phase = await phaseRes.json();
            if (phase !== "EndOfGame") {
                if (eogPromo) { eogPromo = null; storeSet(EOG_PROMO_KEY, null); }
                return;
            }

            const statsRes = await originalFetch('/lol-end-of-game/v1/eog-stats-block');
            if (!statsRes.ok) return;
            const statsData = await statsRes.json();

            const eogKey = String(statsData.gameId || statsData.reportGameId || '');
            if (!eogKey || eogKey === processedEogKey) return;

            if (eogFirstSeen.key !== eogKey) eogFirstSeen = { key: eogKey, at: Date.now() };
            const realDelta = await fetchRealLpDelta();
            // The server takes a few seconds to send the LP change: wait for it up to 45 s
            if (realDelta === null && Date.now() - eogFirstSeen.at < 45000 && (statsData.ranked || String(statsData.queueType || '').includes('RANKED'))) return;

            const queueId = statsData.gameQueueConfigId ?? statsData.queueId ?? statsData.queue?.id;
            const queueType = String(statsData.queueType || statsData.queue?.type || '');
            const isRanked = statsData.ranked === true || queueId === 420 || queueId === 440 || queueType.includes('RANKED');

            processedEogKey = eogKey;
            storeSet(LAST_EOG_KEY, eogKey);
            if (!isRanked) return;

            if (!currentPuuid) await fetchCurrentPuuid();
            const ranks = { ...getAllVirtualRanks() };
            let changed = false;

            extractEogPlayers(statsData).forEach(player => {
                const conf = ranks[player.puuid];
                if (!conf || player.isWin === null) return;
                if (conf.type === 'alt' && player.puuid !== currentPuuid) return;
                if (conf.shared) return; // rank shared by the friend: their own plugin keeps it updated

                const lpDelta = (player.puuid === currentPuuid && realDelta !== null)
                    ? realDelta
                    : (player.lpChange || (player.isWin ? 20 : -18));
                const newRank = updateLp(conf, lpDelta);
                if (player.isWin) newRank.wins = (Number(newRank.wins) || 0) + 1;
                else newRank.losses = (newRank.losses !== undefined ? Number(newRank.losses) || 0 : Math.round((Number(conf.wins) || 0) * 0.9)) + 1;
                ranks[player.puuid] = newRank;
                if (player.puuid === currentPuuid && rankStep(newRank) > rankStep(conf)) {
                    eogPromo = { key: eogKey, label: rankLabel(newRank.tier, newRank.division) };
                    storeSet(EOG_PROMO_KEY, eogPromo);
                    log(`Virtual promotion: ${eogPromo.label}`);
                }
                changed = true;
                log(`End of game: ${conf.name || player.puuid} ${lpDelta > 0 ? '+' : ''}${lpDelta} LP -> ${newRank.text} ${newRank.lp} LP`);
            });

            if (eogPromo) schedulePatch();
            if (changed) {
                saveAllVirtualRanks(ranks);
                syncChatPresenceToLCU(true);
            }
        } catch (e) {}
    }, 2000);

    log(`v${VERSION} loaded`);
}
