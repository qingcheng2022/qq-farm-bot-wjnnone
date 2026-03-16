const process = require('node:process');
/**
 * 运行时存储 - 自动化开关、种子偏好、账号管理
 */

const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readTextFile, readJsonFile, writeJsonFileAtomic } = require('../services/json-db');

const STORE_FILE = getDataFile('store.json');
const ACCOUNTS_FILE = getDataFile('accounts.json');
const ALLOWED_PLANTING_STRATEGIES = ['preferred', 'level', 'max_exp', 'max_fert_exp', 'max_profit', 'max_fert_profit'];
const PUSHOO_CHANNELS = new Set([
    'webhook', 'qmsg', 'serverchan', 'pushplus', 'pushplushxtrip',
    'dingtalk', 'wecom', 'bark', 'gocqhttp', 'onebot', 'atri',
    'pushdeer', 'igot', 'telegram', 'feishu', 'ifttt', 'wecombot',
    'discord', 'wxpusher',
]);
const DEFAULT_OFFLINE_REMINDER = {
    channel: 'webhook',
    reloginUrlMode: 'none',
    endpoint: '',
    token: '',
    title: '账号下线提醒',
    msg: '账号下线',
};
// ============ 全局配置 ============
const DEFAULT_ACCOUNT_CONFIG = {
    automation: {
        farm: false,
        farm_push: false,
        land_upgrade: false,
        friend: false,
        friend_help_exp_limit: false,
        friend_steal: false,
        friend_help: false,
        friend_bad: false,
        task_plant: false,
        task_plant_first_harvest_radish: false,
        event_plant: false,
        fertilizer_gift: false,
        fertilizer_buy: false,
        sell: false,
        fertilizer: 'none',
        fertilizerBuyType: 'organic',
        fertilizeLandLevel: 1,
        fertilizer_multi_season: false,
        clear_own_weed_bug: false,
        // 秒收取：作物成熟瞬间自动收获
        fast_harvest: false,
        // 蹲守偷菜：预判好友作物成熟时间提前蹲点
        stakeout_steal: false,
        // 使用访客GUID列表：当好友列表获取失败时使用
        use_visitor_gids: true,
        // 使用直接索引GUID范围：直接生成指定范围内的GUID作为好友
        use_guid_range: false,
        // GUID范围起始值
        guid_range_start: 100000000,
        // GUID范围结束值
        guid_range_end: 119000000,
        // GUID索引进度：当前索引到的位置
        guid_index_current: 100000000,
        // GUID索引是否完成
        guid_index_completed: false,
        // 索引间隔时间（秒）
        guid_index_interval: 3,
    },
    plantingStrategy: 'preferred',
    preferredSeedId: 0,
    intervals: {
        farm: 2,
        farmMin: 2,
        farmMax: 2,
        // 好友巡查：帮助和偷菜各自独立的间隔
        helpMin: 10,
        helpMax: 10,
        stealMin: 10,
        stealMax: 10,
    },
    friendQuietHours: {
        enabled: false,
        start: '23:00',
        end: '07:00',
    },
    friendBlacklist: [],
    // 访客黑名单（无法获取土地数据的访客）
    visitorBlacklist: [],
    // 导入黑名单（手动导入时跳过的GID列表）
    importBlacklist: [],
    // 蔬菜黑名单（偷菜时不偷的作物 seedId 列表）
    plantBlacklist: [],
    // 好友作物成熟后延迟多少秒再偷取（0=不延迟）
    stealDelaySeconds: 0,
    // 自己农田种植时是否随机地块顺序
    plantOrderRandom: false,
    // 自己农田种植时每块地间隔秒数（0=使用默认50ms）
    plantDelaySeconds: 0,
    // 秒收取提前时间（毫秒），默认提前200ms发起请求
    fastHarvestAdvanceMs: 200,
    // 蹲守偷菜配置
    stakeoutSteal: {
        enabled: false,
        // 蹲守延迟秒数（作物成熟后再等几秒偷，避免被检测）
        delaySec: 3,
        // 最大提前蹲守时间（秒），默认4小时
        maxAheadSec: 4 * 3600,
    },
    // 蹲守好友列表（指定要蹲守的好友GID列表，为空则蹲守所有好友）
    stakeoutFriendList: [],
    // 访客列表（从访客记录中获取并持久化，包含头像和名字）
    visitors: [],
};
const ALLOWED_AUTOMATION_KEYS = new Set(Object.keys(DEFAULT_ACCOUNT_CONFIG.automation));

let accountFallbackConfig = {
    ...DEFAULT_ACCOUNT_CONFIG,
    automation: { ...DEFAULT_ACCOUNT_CONFIG.automation },
    intervals: { ...DEFAULT_ACCOUNT_CONFIG.intervals },
    friendQuietHours: { ...DEFAULT_ACCOUNT_CONFIG.friendQuietHours },
};

const globalConfig = {
    accountConfigs: {},
    defaultAccountConfig: cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG),
    ui: {
        theme: 'dark',
    },
    offlineReminder: { ...DEFAULT_OFFLINE_REMINDER },
    // 用户隔离的下线提醒配置: { [username]: config }
    userOfflineReminders: {},
    // 用户隔离的自动控制同步: { [username]: { enabled: boolean, snapshot: { automation, fastHarvestAdvanceMs, stakeoutSteal, stakeoutFriendList } } }
    userAutomationSync: {},
    adminPasswordHash: '',
    oauth: {
        enabled: false,
        apiUrl: '',
        appId: '',
        appKey: '',
    },
    oauthUserDefault: {
        days: 30,
        quota: 0,
    },
    cardRegisterDefault: {
        quota: 3,
    },
    // 管理员微信配置设置
    adminWxConfig: {
        showWxConfigTab: true,
        showWxLoginTab: true,
        apiBase: 'http://127.0.0.1:8059/api',
        apiKey: '',
        proxyApiUrl: 'https://api.aineishe.com/api/wxnc',
    },
};

function normalizeOfflineReminder(input) {
    const src = (input && typeof input === 'object') ? input : {};
    const rawChannel = (src.channel !== undefined && src.channel !== null)
        ? String(src.channel).trim().toLowerCase()
        : '';
    const endpoint = (src.endpoint !== undefined && src.endpoint !== null)
        ? String(src.endpoint).trim()
        : DEFAULT_OFFLINE_REMINDER.endpoint;
    const migratedChannel = rawChannel
        || (PUSHOO_CHANNELS.has(String(endpoint || '').trim().toLowerCase())
            ? String(endpoint || '').trim().toLowerCase()
            : DEFAULT_OFFLINE_REMINDER.channel);
    const channel = PUSHOO_CHANNELS.has(migratedChannel)
        ? migratedChannel
        : DEFAULT_OFFLINE_REMINDER.channel;
    const rawReloginUrlMode = (src.reloginUrlMode !== undefined && src.reloginUrlMode !== null)
        ? String(src.reloginUrlMode).trim().toLowerCase()
        : DEFAULT_OFFLINE_REMINDER.reloginUrlMode;
    const reloginUrlMode = new Set(['none', 'qq_link', 'qr_link']).has(rawReloginUrlMode)
        ? rawReloginUrlMode
        : DEFAULT_OFFLINE_REMINDER.reloginUrlMode;
    const token = (src.token !== undefined && src.token !== null)
        ? String(src.token).trim()
        : DEFAULT_OFFLINE_REMINDER.token;
    const title = (src.title !== undefined && src.title !== null)
        ? String(src.title).trim()
        : DEFAULT_OFFLINE_REMINDER.title;
    const msg = (src.msg !== undefined && src.msg !== null)
        ? String(src.msg).trim()
        : DEFAULT_OFFLINE_REMINDER.msg;
    return {
        channel,
        reloginUrlMode,
        endpoint,
        token,
        title,
        msg,
    };
}

function normalizeAutomationValue(key, value, fallback) {
    if (fallback === undefined) return undefined;
    if (key === 'fertilizer') {
        const allowed = ['both', 'normal', 'organic', 'none', 'smart'];
        return allowed.includes(value) ? value : fallback;
    }
    if (key === 'fertilizerBuyType') {
        const allowed = ['normal', 'organic'];
        return allowed.includes(value) ? value : fallback;
    }
    if (key === 'fertilizeLandLevel') {
        const allowed = [1, 2, 3, 4];
        return allowed.includes(Number(value)) ? Number(value) : fallback;
    }
    if (key === 'guid_range_start' || key === 'guid_range_end' || key === 'guid_index_current' || key === 'guid_index_interval') {
        const numVal = Number(value);
        return Number.isFinite(numVal) ? numVal : fallback;
    }
    if (key === 'guid_index_completed') {
        return !!value;
    }
    return !!value;
}

function normalizeUserAutomationSyncEntry(input) {
    const src = (input && typeof input === 'object') ? input : {};
    const enabled = !!src.enabled;
    const snapshot = (src.snapshot && typeof src.snapshot === 'object') ? src.snapshot : {};
    const next = {
        enabled,
        snapshot: {
            automation: {},
            fastHarvestAdvanceMs: undefined,
            stakeoutSteal: undefined,
            stakeoutFriendList: undefined,
        },
    };

    const snapAuto = (snapshot.automation && typeof snapshot.automation === 'object') ? snapshot.automation : {};
    const base = DEFAULT_ACCOUNT_CONFIG.automation;
    const outAuto = {};
    for (const key of Object.keys(base)) {
        if (snapAuto[key] === undefined) continue;
        const normalized = normalizeAutomationValue(key, snapAuto[key], base[key]);
        if (normalized !== undefined) outAuto[key] = normalized;
    }
    if (snapAuto.clear_own_weed_bug === undefined && snapAuto.skip_own_weed_bug !== undefined) {
        outAuto.clear_own_weed_bug = !snapAuto.skip_own_weed_bug;
    }
    next.snapshot.automation = outAuto;

    if (snapshot.fastHarvestAdvanceMs !== undefined && snapshot.fastHarvestAdvanceMs !== null) {
        next.snapshot.fastHarvestAdvanceMs = Math.max(50, Math.min(1000, Number(snapshot.fastHarvestAdvanceMs) || 200));
    }
    if (snapshot.stakeoutSteal && typeof snapshot.stakeoutSteal === 'object') {
        const delaySec = Math.max(0, Math.min(60, Number(snapshot.stakeoutSteal.delaySec) || 3));
        const maxAheadSec = Math.max(60, Number(snapshot.stakeoutSteal.maxAheadSec) || 4 * 3600);
        next.snapshot.stakeoutSteal = {
            enabled: snapshot.stakeoutSteal.enabled !== undefined ? !!snapshot.stakeoutSteal.enabled : false,
            delaySec,
            maxAheadSec,
        };
    }
    if (Array.isArray(snapshot.stakeoutFriendList)) {
        next.snapshot.stakeoutFriendList = snapshot.stakeoutFriendList.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }
    return next;
}

function cloneAccountConfig(base = DEFAULT_ACCOUNT_CONFIG) {
    const srcAutomation = (base && base.automation && typeof base.automation === 'object')
        ? base.automation
        : {};
    const automation = { ...DEFAULT_ACCOUNT_CONFIG.automation };
    for (const key of Object.keys(automation)) {
        if (srcAutomation[key] !== undefined) automation[key] = srcAutomation[key];
    }
    if (srcAutomation.clear_own_weed_bug === undefined && srcAutomation.skip_own_weed_bug !== undefined) {
        automation.clear_own_weed_bug = !srcAutomation.skip_own_weed_bug;
    }

    const rawBlacklist = Array.isArray(base.friendBlacklist) ? base.friendBlacklist : [];

    // 访客黑名单
    const rawVisitorBlacklist = Array.isArray(base.visitorBlacklist) ? base.visitorBlacklist : [];

    // 导入黑名单
    const rawImportBlacklist = Array.isArray(base.importBlacklist) ? base.importBlacklist : [];

    // 蔬菜黑名单
    const rawPlantBlacklist = Array.isArray(base.plantBlacklist) ? base.plantBlacklist : [];

    // 蹲守好友列表
    const rawStakeoutFriendList = Array.isArray(base.stakeoutFriendList) ? base.stakeoutFriendList : [];

    // 访客列表
    const rawVisitors = Array.isArray(base.visitors) ? base.visitors : [];

    // 蹲守配置
    const srcStakeoutSteal = (base && base.stakeoutSteal && typeof base.stakeoutSteal === 'object')
        ? base.stakeoutSteal
        : {};
    const stakeoutSteal = {
        ...DEFAULT_ACCOUNT_CONFIG.stakeoutSteal,
        enabled: srcStakeoutSteal.enabled !== undefined ? !!srcStakeoutSteal.enabled : DEFAULT_ACCOUNT_CONFIG.stakeoutSteal.enabled,
        delaySec: Math.max(0, Math.min(60, Number(srcStakeoutSteal.delaySec) || DEFAULT_ACCOUNT_CONFIG.stakeoutSteal.delaySec)),
        maxAheadSec: Math.max(60, Number(srcStakeoutSteal.maxAheadSec) || DEFAULT_ACCOUNT_CONFIG.stakeoutSteal.maxAheadSec),
    };

    return {
        ...base,
        automation,
        intervals: { ...(base.intervals || DEFAULT_ACCOUNT_CONFIG.intervals) },
        friendQuietHours: { ...(base.friendQuietHours || DEFAULT_ACCOUNT_CONFIG.friendQuietHours) },
        friendBlacklist: rawBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        // 访客黑名单
        visitorBlacklist: rawVisitorBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        // 导入黑名单
        importBlacklist: rawImportBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        plantingStrategy: ALLOWED_PLANTING_STRATEGIES.includes(String(base.plantingStrategy || ''))
            ? String(base.plantingStrategy)
            : DEFAULT_ACCOUNT_CONFIG.plantingStrategy,
        preferredSeedId: Math.max(0, Number.parseInt(base.preferredSeedId, 10) || 0),
        plantBlacklist: rawPlantBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0),
        stealDelaySeconds: Math.max(0, Math.min(300, Number(base.stealDelaySeconds) || 0)),
        plantOrderRandom: !!(base.plantOrderRandom),
        plantDelaySeconds: Math.max(0, Math.min(60, Number(base.plantDelaySeconds) || 0)),
        // 秒收取配置
        fastHarvestAdvanceMs: Math.max(50, Math.min(1000, Number(base.fastHarvestAdvanceMs) || 200)),
        // 蹲守配置
        stakeoutSteal,
        stakeoutFriendList: rawStakeoutFriendList.map(Number).filter(n => Number.isFinite(n) && n > 0),
        // 访客列表
        visitors: rawVisitors.filter(v => v && v.gid && v.gid > 0),
    };
}

function resolveAccountId(accountId) {
    const direct = (accountId !== undefined && accountId !== null) ? String(accountId).trim() : '';
    if (direct) return direct;
    const envId = String(process.env.FARM_ACCOUNT_ID || '').trim();
    return envId;
}

function normalizeAccountConfig(input, fallback = accountFallbackConfig) {
    const src = (input && typeof input === 'object') ? input : {};
    const cfg = cloneAccountConfig(fallback || DEFAULT_ACCOUNT_CONFIG);

    if (src.automation && typeof src.automation === 'object') {
        if (src.automation.clear_own_weed_bug === undefined && src.automation.skip_own_weed_bug !== undefined) {
            cfg.automation.clear_own_weed_bug = !src.automation.skip_own_weed_bug;
        }
        for (const [k, v] of Object.entries(src.automation)) {
            if (!ALLOWED_AUTOMATION_KEYS.has(k)) continue;
            if (k === 'fertilizer') {
                const allowed = ['both', 'normal', 'organic', 'none', 'smart'];
                cfg.automation[k] = allowed.includes(v) ? v : cfg.automation[k];
            } else if (k === 'fertilizerBuyType') {
                const allowed = ['normal', 'organic'];
                cfg.automation[k] = allowed.includes(v) ? v : cfg.automation[k];
            } else if (k === 'fertilizeLandLevel') {
                const allowed = [1, 2, 3, 4];
                cfg.automation[k] = allowed.includes(Number(v)) ? Number(v) : cfg.automation[k];
            } else if (k === 'guid_range_start' || k === 'guid_range_end' || k === 'guid_index_current' || k === 'guid_index_interval') {
                cfg.automation[k] = Number(v) || cfg.automation[k];
            } else if (k === 'guid_index_completed') {
                cfg.automation[k] = !!v;
            } else {
                cfg.automation[k] = !!v;
            }
        }
    }

    if (src.plantingStrategy && ALLOWED_PLANTING_STRATEGIES.includes(src.plantingStrategy)) {
        cfg.plantingStrategy = src.plantingStrategy;
    }

    if (src.preferredSeedId !== undefined && src.preferredSeedId !== null) {
        cfg.preferredSeedId = Math.max(0, Number.parseInt(src.preferredSeedId, 10) || 0);
    }

    if (src.intervals && typeof src.intervals === 'object') {
        for (const [type, sec] of Object.entries(src.intervals)) {
            if (cfg.intervals[type] === undefined) continue;
            cfg.intervals[type] = Math.max(1, Number.parseInt(sec, 10) || cfg.intervals[type] || 1);
        }
        cfg.intervals = normalizeIntervals(cfg.intervals);
    } else {
        cfg.intervals = normalizeIntervals(cfg.intervals);
    }

    if (src.friendQuietHours && typeof src.friendQuietHours === 'object') {
        const old = cfg.friendQuietHours || {};
        cfg.friendQuietHours = {
            enabled: src.friendQuietHours.enabled !== undefined ? !!src.friendQuietHours.enabled : !!old.enabled,
            start: normalizeTimeString(src.friendQuietHours.start, old.start || '23:00'),
            end: normalizeTimeString(src.friendQuietHours.end, old.end || '07:00'),
        };
    }

    if (Array.isArray(src.friendBlacklist)) {
        cfg.friendBlacklist = src.friendBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 访客黑名单
    if (Array.isArray(src.visitorBlacklist)) {
        cfg.visitorBlacklist = src.visitorBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 导入黑名单
    if (Array.isArray(src.importBlacklist)) {
        cfg.importBlacklist = src.importBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 蔬菜黑名单
    if (Array.isArray(src.plantBlacklist)) {
        cfg.plantBlacklist = src.plantBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 偷取延迟
    if (src.stealDelaySeconds !== undefined && src.stealDelaySeconds !== null) {
        cfg.stealDelaySeconds = Math.max(0, Math.min(300, Number.parseInt(src.stealDelaySeconds, 10) || 0));
    }

    // 种植顺序随机
    if (src.plantOrderRandom !== undefined && src.plantOrderRandom !== null) {
        cfg.plantOrderRandom = !!src.plantOrderRandom;
    }

    // 种植延迟
    if (src.plantDelaySeconds !== undefined && src.plantDelaySeconds !== null) {
        cfg.plantDelaySeconds = Math.max(0, Math.min(60, Number(src.plantDelaySeconds) || 0));
    }

    // 秒收取提前时间
    if (src.fastHarvestAdvanceMs !== undefined && src.fastHarvestAdvanceMs !== null) {
        cfg.fastHarvestAdvanceMs = Math.max(50, Math.min(1000, Number(src.fastHarvestAdvanceMs) || 200));
    }

    // 蹲守配置
    if (src.stakeoutSteal && typeof src.stakeoutSteal === 'object') {
        cfg.stakeoutSteal = {
            ...cfg.stakeoutSteal,
            enabled: src.stakeoutSteal.enabled !== undefined ? !!src.stakeoutSteal.enabled : cfg.stakeoutSteal.enabled,
            delaySec: Math.max(0, Math.min(60, Number(src.stakeoutSteal.delaySec) || cfg.stakeoutSteal.delaySec)),
            maxAheadSec: Math.max(60, Number(src.stakeoutSteal.maxAheadSec) || cfg.stakeoutSteal.maxAheadSec),
        };
    }

    // 蹲守好友列表
    if (Array.isArray(src.stakeoutFriendList)) {
        cfg.stakeoutFriendList = src.stakeoutFriendList.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 访客列表
    if (Array.isArray(src.visitors)) {
        cfg.visitors = src.visitors.filter(v => v && v.gid && v.gid > 0);
    }

    return cfg;
}

function getAccountConfigSnapshot(accountId) {
    const id = resolveAccountId(accountId);
    if (!id) return cloneAccountConfig(accountFallbackConfig);
    return normalizeAccountConfig(globalConfig.accountConfigs[id], accountFallbackConfig);
}

function setAccountConfigSnapshot(accountId, nextConfig, persist = true) {
    const id = resolveAccountId(accountId);
    if (!id) {
        accountFallbackConfig = normalizeAccountConfig(nextConfig, accountFallbackConfig);
        globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);
        if (persist) saveGlobalConfig();
        return cloneAccountConfig(accountFallbackConfig);
    }
    globalConfig.accountConfigs[id] = normalizeAccountConfig(nextConfig, accountFallbackConfig);
    if (persist) saveGlobalConfig();
    return cloneAccountConfig(globalConfig.accountConfigs[id]);
}

function removeAccountConfig(accountId) {
    const id = resolveAccountId(accountId);
    if (!id) return;
    if (globalConfig.accountConfigs[id]) {
        delete globalConfig.accountConfigs[id];
        saveGlobalConfig();
    }
}

function ensureAccountConfig(accountId, options = {}) {
    const id = resolveAccountId(accountId);
    if (!id) return null;
    if (globalConfig.accountConfigs[id]) {
        return cloneAccountConfig(globalConfig.accountConfigs[id]);
    }
    globalConfig.accountConfigs[id] = normalizeAccountConfig(globalConfig.defaultAccountConfig, accountFallbackConfig);
    // 新账号默认不施肥（不受历史 defaultAccountConfig 旧值影响）
    if (globalConfig.accountConfigs[id] && globalConfig.accountConfigs[id].automation) {
        globalConfig.accountConfigs[id].automation.fertilizer = 'none';
    }
    if (options.persist !== false) saveGlobalConfig();
    return cloneAccountConfig(globalConfig.accountConfigs[id]);
}

// 加载全局配置
function loadGlobalConfig() {
    ensureDataDir();
    try {
        const data = readJsonFile(STORE_FILE, () => ({}));
        if (data && typeof data === 'object') {
            if (data.defaultAccountConfig && typeof data.defaultAccountConfig === 'object') {
                accountFallbackConfig = normalizeAccountConfig(data.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG);
            } else {
                accountFallbackConfig = cloneAccountConfig(DEFAULT_ACCOUNT_CONFIG);
            }
            globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);

            const cfgMap = (data.accountConfigs && typeof data.accountConfigs === 'object')
                ? data.accountConfigs
                : {};
            globalConfig.accountConfigs = {};
            for (const [id, cfg] of Object.entries(cfgMap)) {
                const sid = String(id || '').trim();
                if (!sid) continue;
                globalConfig.accountConfigs[sid] = normalizeAccountConfig(cfg, accountFallbackConfig);
            }
            // 统一规范化，确保内存中不残留旧字段（如 automation.friend）
            globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);
            for (const [id, cfg] of Object.entries(globalConfig.accountConfigs)) {
                globalConfig.accountConfigs[id] = normalizeAccountConfig(cfg, accountFallbackConfig);
            }
            globalConfig.ui = { ...globalConfig.ui, ...(data.ui || {}) };
            const theme = String(globalConfig.ui.theme || '').toLowerCase();
            globalConfig.ui.theme = theme === 'light' ? 'light' : 'dark';
            globalConfig.offlineReminder = normalizeOfflineReminder(data.offlineReminder);

            // 加载用户隔离的下线提醒配置
            if (data.userOfflineReminders && typeof data.userOfflineReminders === 'object') {
                globalConfig.userOfflineReminders = {};
                for (const [username, cfg] of Object.entries(data.userOfflineReminders)) {
                    if (username && cfg) {
                        globalConfig.userOfflineReminders[username] = normalizeOfflineReminder(cfg);
                    }
                }
            }
            // 兼容旧版本：将全局 offlineReminder 迁移到 admin 用户（如果存在）
            if (data.offlineReminder && typeof data.offlineReminder === 'object') {
                const legacyCfg = normalizeOfflineReminder(data.offlineReminder);
                // 只有当 admin 用户没有配置时才迁移
                if (!globalConfig.userOfflineReminders.admin) {
                    globalConfig.userOfflineReminders.admin = legacyCfg;
                }
            }

            if (data.userAutomationSync && typeof data.userAutomationSync === 'object') {
                globalConfig.userAutomationSync = {};
                for (const [username, cfg] of Object.entries(data.userAutomationSync)) {
                    const u = String(username || '').trim();
                    if (!u) continue;
                    globalConfig.userAutomationSync[u] = normalizeUserAutomationSyncEntry(cfg);
                }
            }

            if (typeof data.adminPasswordHash === 'string') {
                globalConfig.adminPasswordHash = data.adminPasswordHash;
            }

            if (data.oauth && typeof data.oauth === 'object') {
                globalConfig.oauth = {
                    enabled: !!data.oauth.enabled,
                    apiUrl: String(data.oauth.apiUrl || '').trim(),
                    appId: String(data.oauth.appId || '').trim(),
                    appKey: String(data.oauth.appKey || '').trim(),
                };
            }

            if (data.oauthUserDefault && typeof data.oauthUserDefault === 'object') {
                const days = Number.parseInt(data.oauthUserDefault.days, 10);
                const quota = Number.parseInt(data.oauthUserDefault.quota, 10);
                globalConfig.oauthUserDefault = {
                    days: Math.max(0, Number.isFinite(days) ? days : 30),
                    quota: Math.max(0, Number.isFinite(quota) ? quota : 0),
                };
            }

            if (data.cardRegisterDefault && typeof data.cardRegisterDefault === 'object') {
                const quota = Number.parseInt(data.cardRegisterDefault.quota, 10);
                globalConfig.cardRegisterDefault = {
                    quota: Number.isFinite(quota) && quota >= 0 ? quota : 3,
                };
            }

            if (data.adminWxConfig && typeof data.adminWxConfig === 'object') {
                globalConfig.adminWxConfig = {
                    showWxConfigTab: data.adminWxConfig.showWxConfigTab !== false,
                    showWxLoginTab: data.adminWxConfig.showWxLoginTab !== false,
                    apiBase: String(data.adminWxConfig.apiBase || 'http://127.0.0.1:8059/api').trim(),
                    apiKey: String(data.adminWxConfig.apiKey || '').trim(),
                    proxyApiUrl: String(data.adminWxConfig.proxyApiUrl || 'https://api.aineishe.com/api/wxnc').trim(),
                };
            }
        }
    } catch (e) {
        console.error('加载配置失败:', e.message);
    }
}

function sanitizeGlobalConfigBeforeSave() {
    // default 配置统一白名单净化
    accountFallbackConfig = normalizeAccountConfig(globalConfig.defaultAccountConfig, DEFAULT_ACCOUNT_CONFIG);
    globalConfig.defaultAccountConfig = cloneAccountConfig(accountFallbackConfig);

    // 每个账号配置也统一净化
    const map = (globalConfig.accountConfigs && typeof globalConfig.accountConfigs === 'object')
        ? globalConfig.accountConfigs
        : {};
    const nextMap = {};
    for (const [id, cfg] of Object.entries(map)) {
        const sid = String(id || '').trim();
        if (!sid) continue;
        nextMap[sid] = normalizeAccountConfig(cfg, accountFallbackConfig);
    }
    globalConfig.accountConfigs = nextMap;

    // 净化用户隔离的下线提醒配置
    const userReminders = (globalConfig.userOfflineReminders && typeof globalConfig.userOfflineReminders === 'object')
        ? globalConfig.userOfflineReminders
        : {};
    const nextReminders = {};
    for (const [username, cfg] of Object.entries(userReminders)) {
        const u = String(username || '').trim();
        if (!u) continue;
        nextReminders[u] = normalizeOfflineReminder(cfg);
    }
    globalConfig.userOfflineReminders = nextReminders;

    const userAutomationSync = (globalConfig.userAutomationSync && typeof globalConfig.userAutomationSync === 'object')
        ? globalConfig.userAutomationSync
        : {};
    const nextUserAutomationSync = {};
    for (const [username, cfg] of Object.entries(userAutomationSync)) {
        const u = String(username || '').trim();
        if (!u) continue;
        nextUserAutomationSync[u] = normalizeUserAutomationSyncEntry(cfg);
    }
    globalConfig.userAutomationSync = nextUserAutomationSync;
}

// 保存全局配置
function saveGlobalConfig() {
    ensureDataDir();
    try {
        const oldJson = readTextFile(STORE_FILE, '');

        sanitizeGlobalConfigBeforeSave();
        const newJson = JSON.stringify(globalConfig, null, 2);

        if (oldJson !== newJson) {
            console.warn('[系统] 正在保存配置到:', STORE_FILE);
            writeJsonFileAtomic(STORE_FILE, globalConfig);
        }
    } catch (e) {
        console.error('保存配置失败:', e.message);
    }
}

function getAdminPasswordHash() {
    return String(globalConfig.adminPasswordHash || '');
}

function setAdminPasswordHash(hash) {
    globalConfig.adminPasswordHash = String(hash || '');
    saveGlobalConfig();
    return globalConfig.adminPasswordHash;
}

function reloadGlobalConfig() {
    loadGlobalConfig();
}

// 初始化加载
loadGlobalConfig();

function getAutomation(accountId) {
    return { ...getAccountConfigSnapshot(accountId).automation };
}

function getConfigSnapshot(accountId) {
    const cfg = getAccountConfigSnapshot(accountId);
    return {
        automation: { ...cfg.automation },
        plantingStrategy: cfg.plantingStrategy,
        preferredSeedId: cfg.preferredSeedId,
        intervals: { ...cfg.intervals },
        friendQuietHours: { ...cfg.friendQuietHours },
        friendBlacklist: [...(cfg.friendBlacklist || [])],
        // 访客黑名单
        visitorBlacklist: [...(cfg.visitorBlacklist || [])],
        // 导入黑名单
        importBlacklist: [...(cfg.importBlacklist || [])],
        plantBlacklist: [...(cfg.plantBlacklist || [])],
        stealDelaySeconds: Math.max(0, Math.min(300, Number(cfg.stealDelaySeconds) || 0)),
        plantOrderRandom: !!cfg.plantOrderRandom,
        plantDelaySeconds: Math.max(0, Math.min(60, Number(cfg.plantDelaySeconds) || 0)),
        ui: { ...globalConfig.ui },
        // 秒收取配置
        fastHarvestAdvanceMs: Math.max(50, Math.min(1000, Number(cfg.fastHarvestAdvanceMs) || 200)),
        // 蹲守配置
        stakeoutSteal: { ...(cfg.stakeoutSteal || DEFAULT_ACCOUNT_CONFIG.stakeoutSteal) },
        stakeoutFriendList: [...(cfg.stakeoutFriendList || [])],
        // 访客列表
        visitors: [...(cfg.visitors || [])],
    };
}

function applyConfigSnapshot(snapshot, options = {}) {
    const cfg = snapshot || {};
    const persist = options.persist !== false;
    const accountId = options.accountId;

    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);

    if (cfg.automation && typeof cfg.automation === 'object') {
        for (const [k, v] of Object.entries(cfg.automation)) {
            if (next.automation[k] === undefined) continue;
            if (k === 'fertilizer') {
                const allowed = ['both', 'normal', 'organic', 'none', 'smart'];
                next.automation[k] = allowed.includes(v) ? v : next.automation[k];
            } else if (k === 'fertilizerBuyType') {
                const allowed = ['normal', 'organic'];
                next.automation[k] = allowed.includes(v) ? v : next.automation[k];
            } else if (k === 'fertilizeLandLevel') {
                const allowed = [1, 2, 3, 4];
                next.automation[k] = allowed.includes(Number(v)) ? Number(v) : next.automation[k];
            } else if (k === 'guid_index_current' || k === 'guid_range_start' || k === 'guid_range_end' || k === 'guid_index_interval') {
                const numVal = Number(v);
                next.automation[k] = Number.isFinite(numVal) ? numVal : next.automation[k];
            } else if (k === 'guid_index_completed') {
                next.automation[k] = !!v;
            } else {
                next.automation[k] = !!v;
            }
        }
    }

    if (cfg.plantingStrategy && ALLOWED_PLANTING_STRATEGIES.includes(cfg.plantingStrategy)) {
        next.plantingStrategy = cfg.plantingStrategy;
    }

    if (cfg.preferredSeedId !== undefined && cfg.preferredSeedId !== null) {
        next.preferredSeedId = Math.max(0, Number.parseInt(cfg.preferredSeedId, 10) || 0);
    }

    if (cfg.intervals && typeof cfg.intervals === 'object') {
        for (const [type, sec] of Object.entries(cfg.intervals)) {
            if (next.intervals[type] === undefined) continue;
            next.intervals[type] = Math.max(1, Number.parseInt(sec, 10) || next.intervals[type] || 1);
        }
        next.intervals = normalizeIntervals(next.intervals);
    }

    if (cfg.friendQuietHours && typeof cfg.friendQuietHours === 'object') {
        const old = next.friendQuietHours || {};
        next.friendQuietHours = {
            enabled: cfg.friendQuietHours.enabled !== undefined ? !!cfg.friendQuietHours.enabled : !!old.enabled,
            start: normalizeTimeString(cfg.friendQuietHours.start, old.start || '23:00'),
            end: normalizeTimeString(cfg.friendQuietHours.end, old.end || '07:00'),
        };
    }

    if (Array.isArray(cfg.friendBlacklist)) {
        next.friendBlacklist = cfg.friendBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 访客黑名单
    if (Array.isArray(cfg.visitorBlacklist)) {
        next.visitorBlacklist = cfg.visitorBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 导入黑名单
    if (Array.isArray(cfg.importBlacklist)) {
        next.importBlacklist = cfg.importBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 蔬菜黑名单
    if (Array.isArray(cfg.plantBlacklist)) {
        next.plantBlacklist = cfg.plantBlacklist.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 偷取延迟
    if (cfg.stealDelaySeconds !== undefined && cfg.stealDelaySeconds !== null) {
        next.stealDelaySeconds = Math.max(0, Math.min(300, Number(cfg.stealDelaySeconds) || 0));
    }

    // 种植顺序随机
    if (cfg.plantOrderRandom !== undefined && cfg.plantOrderRandom !== null) {
        next.plantOrderRandom = !!cfg.plantOrderRandom;
    }

    // 种植延迟
    if (cfg.plantDelaySeconds !== undefined && cfg.plantDelaySeconds !== null) {
        next.plantDelaySeconds = Math.max(0, Math.min(60, Number(cfg.plantDelaySeconds) || 0));
    }

    // 秒收取提前时间
    if (cfg.fastHarvestAdvanceMs !== undefined && cfg.fastHarvestAdvanceMs !== null) {
        next.fastHarvestAdvanceMs = Math.max(50, Math.min(1000, Number(cfg.fastHarvestAdvanceMs) || 200));
    }

    // 蹲守配置
    if (cfg.stakeoutSteal && typeof cfg.stakeoutSteal === 'object') {
        next.stakeoutSteal = {
            ...next.stakeoutSteal,
            enabled: cfg.stakeoutSteal.enabled !== undefined ? !!cfg.stakeoutSteal.enabled : next.stakeoutSteal.enabled,
            delaySec: Math.max(0, Math.min(60, Number(cfg.stakeoutSteal.delaySec) || next.stakeoutSteal.delaySec)),
            maxAheadSec: Math.max(60, Number(cfg.stakeoutSteal.maxAheadSec) || next.stakeoutSteal.maxAheadSec),
        };
    }

    // 蹲守好友列表
    if (Array.isArray(cfg.stakeoutFriendList)) {
        next.stakeoutFriendList = cfg.stakeoutFriendList.map(Number).filter(n => Number.isFinite(n) && n > 0);
    }

    // 访客列表
    if (Array.isArray(cfg.visitors)) {
        next.visitors = cfg.visitors.filter(v => v && v.gid && v.gid > 0);
    }

    if (cfg.ui && typeof cfg.ui === 'object') {
        const theme = String(cfg.ui.theme || '').toLowerCase();
        if (theme === 'dark' || theme === 'light') {
            globalConfig.ui.theme = theme;
        }
    }

    setAccountConfigSnapshot(accountId, next, false);
    if (persist) saveGlobalConfig();
    return getConfigSnapshot(accountId);
}

function setAutomation(key, value, accountId) {
    return applyConfigSnapshot({ automation: { [key]: value } }, { accountId });
}

function isAutomationOn(key, accountId) {
    return !!getAccountConfigSnapshot(accountId).automation[key];
}

function getPreferredSeed(accountId) {
    return getAccountConfigSnapshot(accountId).preferredSeedId;
}

function getPlantingStrategy(accountId) {
    return getAccountConfigSnapshot(accountId).plantingStrategy;
}

function getIntervals(accountId) {
    return { ...getAccountConfigSnapshot(accountId).intervals };
}

function normalizeIntervals(intervals) {
    const src = (intervals && typeof intervals === 'object') ? intervals : {};
    const toSec = (v, d) => Math.max(1, Number.parseInt(v, 10) || d);
    const farm = toSec(src.farm, 2);

    let farmMin = toSec(src.farmMin, farm);
    let farmMax = toSec(src.farmMax, farm);
    if (farmMin > farmMax) [farmMin, farmMax] = [farmMax, farmMin];

    // 帮助和偷菜的独立间隔，默认使用 10 秒
    let helpMin = toSec(src.helpMin, 10);
    let helpMax = toSec(src.helpMax, 10);
    if (helpMin > helpMax) [helpMin, helpMax] = [helpMax, helpMin];

    let stealMin = toSec(src.stealMin, 10);
    let stealMax = toSec(src.stealMax, 10);
    if (stealMin > stealMax) [stealMin, stealMax] = [stealMax, stealMin];

    return {
        ...src,
        farm,
        farmMin,
        farmMax,
        helpMin,
        helpMax,
        stealMin,
        stealMax,
    };
}

function normalizeTimeString(v, fallback) {
    const s = String(v || '').trim();
    const m = s.match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return fallback;
    const hh = Math.max(0, Math.min(23, Number.parseInt(m[1], 10)));
    const mm = Math.max(0, Math.min(59, Number.parseInt(m[2], 10)));
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function getFriendQuietHours(accountId) {
    return { ...getAccountConfigSnapshot(accountId).friendQuietHours };
}

function getFriendBlacklist(accountId) {
    return [...(getAccountConfigSnapshot(accountId).friendBlacklist || [])];
}

function setFriendBlacklist(accountId, list) {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);
    next.friendBlacklist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
    setAccountConfigSnapshot(accountId, next);
    return [...next.friendBlacklist];
}

// ============ 偷取延迟 ============
function getStealDelaySeconds(accountId) {
    return Math.max(0, Math.min(300, Number(getAccountConfigSnapshot(accountId).stealDelaySeconds) || 0));
}

// ============ 种植顺序随机 ============
function getPlantOrderRandom(accountId) {
    return !!getAccountConfigSnapshot(accountId).plantOrderRandom;
}

// ============ 种植延迟 ============
function getPlantDelaySeconds(accountId) {
    return Math.max(0, Math.min(60, Number(getAccountConfigSnapshot(accountId).plantDelaySeconds) || 0));
}

// ============ 蔬菜黑名单 ============
function getPlantBlacklist(accountId) {
    return [...(getAccountConfigSnapshot(accountId).plantBlacklist || [])];
}

function setPlantBlacklist(accountId, list) {
    const current = getAccountConfigSnapshot(accountId);
    const next = normalizeAccountConfig(current, accountFallbackConfig);
    next.plantBlacklist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
    setAccountConfigSnapshot(accountId, next);
    return [...next.plantBlacklist];
}

function getUI() {
    return { ...globalConfig.ui };
}

function setUITheme(theme) {
    const t = String(theme || '').toLowerCase();
    const next = (t === 'light') ? 'light' : 'dark';
    return applyConfigSnapshot({ ui: { theme: next } });
}

// ============ 用户隔离的下线提醒配置 ============
function getOfflineReminder(username) {
    // 必须指定用户名，按用户隔离
    if (!username) {
        return normalizeOfflineReminder(globalConfig.offlineReminder);
    }
    const userCfg = globalConfig.userOfflineReminders && globalConfig.userOfflineReminders[username];
    if (userCfg) {
        return normalizeOfflineReminder(userCfg);
    }
    // 用户未设置时返回默认配置（但不保存到全局）
    return normalizeOfflineReminder({});
}

function setOfflineReminder(cfg, username) {
    // 必须指定用户名，按用户隔离
    if (!username) {
        // 兼容旧版本：如果没有指定用户名，保存到全局配置
        const current = normalizeOfflineReminder(globalConfig.offlineReminder);
        globalConfig.offlineReminder = normalizeOfflineReminder({ ...current, ...(cfg || {}) });
        saveGlobalConfig();
        return getOfflineReminder();
    }
    if (!globalConfig.userOfflineReminders) {
        globalConfig.userOfflineReminders = {};
    }
    const current = normalizeOfflineReminder(globalConfig.userOfflineReminders[username] || {});
    globalConfig.userOfflineReminders[username] = normalizeOfflineReminder({ ...current, ...(cfg || {}) });
    saveGlobalConfig();
    return getOfflineReminder(username);
}

function deleteUserOfflineReminder(username) {
    if (globalConfig.userOfflineReminders && globalConfig.userOfflineReminders[username]) {
        delete globalConfig.userOfflineReminders[username];
        saveGlobalConfig();
    }
}

// ============ 用户隔离的运行时连接配置 ============
const DEFAULT_RUNTIME_CONFIG = {
    serverUrl: 'wss://gate-obt.nqf.qq.com/prod/ws',
    clientVersion: '1.7.0.6_20260313',
    os: 'iOS',
    osVersion: 'iOS 26.2.1',
    networkType: 'wifi',
    memory: '7672',
    deviceId: 'iPhone X<iPhone18,3>',
};

function normalizeRuntimeConfig(cfg) {
    const c = cfg || {};
    return {
        serverUrl: String(c.serverUrl || DEFAULT_RUNTIME_CONFIG.serverUrl).trim(),
        clientVersion: String(c.clientVersion || DEFAULT_RUNTIME_CONFIG.clientVersion).trim(),
        os: String(c.os || DEFAULT_RUNTIME_CONFIG.os).trim(),
        osVersion: String(c.osVersion || DEFAULT_RUNTIME_CONFIG.osVersion).trim(),
        networkType: String(c.networkType || DEFAULT_RUNTIME_CONFIG.networkType).trim(),
        memory: String(c.memory || DEFAULT_RUNTIME_CONFIG.memory).trim(),
        deviceId: String(c.deviceId || DEFAULT_RUNTIME_CONFIG.deviceId).trim(),
    };
}

function getRuntimeConfig(username) {
    // 必须指定用户名，按用户隔离
    if (!username) {
        return normalizeRuntimeConfig(globalConfig.runtimeConfig);
    }
    const userCfg = globalConfig.userRuntimeConfigs && globalConfig.userRuntimeConfigs[username];
    if (userCfg) {
        return normalizeRuntimeConfig(userCfg);
    }
    // 用户未设置时返回默认配置（但不保存到全局）
    return normalizeRuntimeConfig({});
}

function setRuntimeConfig(cfg, username) {
    // 必须指定用户名，按用户隔离
    if (!username) {
        // 兼容旧版本：如果没有指定用户名，保存到全局配置
        const current = normalizeRuntimeConfig(globalConfig.runtimeConfig);
        globalConfig.runtimeConfig = normalizeRuntimeConfig({ ...current, ...(cfg || {}) });
        saveGlobalConfig();
        return getRuntimeConfig();
    }
    if (!globalConfig.userRuntimeConfigs) {
        globalConfig.userRuntimeConfigs = {};
    }
    const current = normalizeRuntimeConfig(globalConfig.userRuntimeConfigs[username] || {});
    globalConfig.userRuntimeConfigs[username] = normalizeRuntimeConfig({ ...current, ...(cfg || {}) });
    saveGlobalConfig();
    return getRuntimeConfig(username);
}

function deleteUserRuntimeConfig(username) {
    if (globalConfig.userRuntimeConfigs && globalConfig.userRuntimeConfigs[username]) {
        delete globalConfig.userRuntimeConfigs[username];
        saveGlobalConfig();
    }
}

function getUserAutomationSync(username) {
    const u = String(username || '').trim();
    if (!u) return { enabled: false, snapshot: {} };
    const cfg = globalConfig.userAutomationSync && globalConfig.userAutomationSync[u];
    if (cfg) return normalizeUserAutomationSyncEntry(cfg);
    return { enabled: false, snapshot: {} };
}

function setUserAutomationSync(username, enabled, snapshot) {
    const u = String(username || '').trim();
    if (!u) return { enabled: false, snapshot: {} };
    if (!globalConfig.userAutomationSync) globalConfig.userAutomationSync = {};
    const current = getUserAutomationSync(u);
    const next = normalizeUserAutomationSyncEntry({
        enabled: enabled !== undefined ? !!enabled : current.enabled,
        snapshot: snapshot !== undefined ? snapshot : (current.snapshot || {}),
    });
    globalConfig.userAutomationSync[u] = next;
    saveGlobalConfig();
    return getUserAutomationSync(u);
}

function setUserAutomationSyncSnapshot(username, snapshot) {
    const u = String(username || '').trim();
    if (!u) return { enabled: false, snapshot: {} };
    const current = getUserAutomationSync(u);
    const merged = {
        ...(current.snapshot || {}),
        ...(snapshot && typeof snapshot === 'object' ? snapshot : {}),
        automation: {
            ...((current.snapshot && current.snapshot.automation) ? current.snapshot.automation : {}),
            ...((snapshot && snapshot.automation && typeof snapshot.automation === 'object') ? snapshot.automation : {}),
        },
    };
    return setUserAutomationSync(u, current.enabled, merged);
}

// ============ 账号管理 ============
function loadAccounts() {
    ensureDataDir();
    const data = readJsonFile(ACCOUNTS_FILE, () => ({ accounts: [], nextId: 1 }));
    return normalizeAccountsData(data);
}

function saveAccounts(data) {
    ensureDataDir();
    writeJsonFileAtomic(ACCOUNTS_FILE, normalizeAccountsData(data));
}

function getAccounts() {
    return loadAccounts();
}

function normalizeAccountsData(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const maxId = accounts.reduce((m, a) => Math.max(m, Number.parseInt(a && a.id, 10) || 0), 0);
    let nextId = Number.parseInt(data.nextId, 10);
    if (!Number.isFinite(nextId) || nextId <= 0) nextId = maxId + 1;
    if (accounts.length === 0) nextId = 1;
    if (nextId <= maxId) nextId = maxId + 1;
    return { accounts, nextId };
}

function addOrUpdateAccount(acc) {
    const data = normalizeAccountsData(loadAccounts());
    let touchedAccountId = '';
    if (acc.id) {
        const idx = data.accounts.findIndex(a => a.id === acc.id);
        if (idx >= 0) {
            data.accounts[idx] = { ...data.accounts[idx], ...acc, name: acc.name !== undefined ? acc.name : data.accounts[idx].name, updatedAt: Date.now() };
            touchedAccountId = String(data.accounts[idx].id || '');
        }
    } else {
        const id = data.nextId++;
        touchedAccountId = String(id);
        const defaultName = String(
            acc.name
            || acc.nick
            || (acc.gid ? `GID:${acc.gid}` : '')
            || '',
        ).trim() || `账号${id}`;
        data.accounts.push({
            id: touchedAccountId,
            name: defaultName,
            code: acc.code || '',
            platform: acc.platform || 'qq',
            gid: acc.gid ? String(acc.gid) : '',
            openId: acc.openId ? String(acc.openId) : '',
            nick: acc.nick ? String(acc.nick) : '',
            uin: acc.uin ? String(acc.uin) : '',
            qq: acc.qq ? String(acc.qq) : (acc.uin ? String(acc.uin) : ''),
            avatar: acc.avatar || acc.avatarUrl || '',
            username: acc.username || '', // 保存用户名字段
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
    }
    saveAccounts(data);
    if (touchedAccountId) {
        ensureAccountConfig(touchedAccountId);
    }
    return data;
}

function deleteAccount(id) {
    const data = normalizeAccountsData(loadAccounts());
    data.accounts = data.accounts.filter(a => a.id !== String(id));
    if (data.accounts.length === 0) {
        data.nextId = 1;
    }
    saveAccounts(data);
    removeAccountConfig(id);
    return data;
}

// ============ 用户隔离支持 ============
function getAccountsByUser(username) {
    const allAccounts = loadAccounts();
    if (!username) return allAccounts;
    return {
        accounts: allAccounts.accounts.filter(a => a.username === username),
        nextId: allAccounts.nextId
    };
}

function deleteAccountsByUser(username) {
    const data = loadAccounts();
    const deletedIds = [];
    data.accounts = data.accounts.filter(a => {
        if (a.username === username) {
            deletedIds.push(a.id);
            return false;
        }
        return true;
    });
    if (data.accounts.length === 0) {
        data.nextId = 1;
    }
    saveAccounts(data);
    // 清理被删除账号的配置
    deletedIds.forEach(id => removeAccountConfig(id));
    return { deletedCount: deletedIds.length, deletedIds };
}

function deleteUserConfig(username) {
    // 删除用户特定的配置
    deleteUserOfflineReminder(username);
}

function getOAuthConfig() {
    return { ...globalConfig.oauth };
}

function setOAuthConfig(cfg) {
    if (cfg && typeof cfg === 'object') {
        globalConfig.oauth = {
            enabled: !!cfg.enabled,
            apiUrl: String(cfg.apiUrl || '').trim(),
            appId: String(cfg.appId || '').trim(),
            appKey: String(cfg.appKey || '').trim(),
        };
        saveGlobalConfig();
    }
    return getOAuthConfig();
}

function getOAuthUserDefault() {
    return { ...globalConfig.oauthUserDefault };
}

function setOAuthUserDefault(cfg) {
    if (cfg && typeof cfg === 'object') {
        const days = Number.parseInt(cfg.days, 10);
        const quota = Number.parseInt(cfg.quota, 10);
        globalConfig.oauthUserDefault = {
            days: Math.max(0, Number.isFinite(days) ? days : 30),
            quota: Math.max(0, Number.isFinite(quota) ? quota : 0),
        };
        saveGlobalConfig();
    }
    return getOAuthUserDefault();
}

function getCardRegisterDefault() {
    return { ...globalConfig.cardRegisterDefault };
}

function setCardRegisterDefault(cfg) {
    if (cfg && typeof cfg === 'object') {
        const quota = Number.parseInt(cfg.quota, 10);
        globalConfig.cardRegisterDefault = {
            quota: Number.isFinite(quota) && quota >= 0 ? quota : 3,
        };
        saveGlobalConfig();
    }
    return getCardRegisterDefault();
}

function getFertilizerBuyType(accountId) {
    const cfg = getAccountConfigSnapshot(accountId);
    const val = cfg && cfg.automation && cfg.automation.fertilizerBuyType;
    return val === 'normal' ? 'normal' : 'organic';
}

function getFertilizeLandLevel(accountId) {
    const cfg = getAccountConfigSnapshot(accountId);
    const val = cfg && cfg.automation && cfg.automation.fertilizeLandLevel;
    const allowed = [1, 2, 3, 4];
    return allowed.includes(Number(val)) ? Number(val) : 1;
}

function getAdminWxConfig() {
    return { ...globalConfig.adminWxConfig };
}

function setAdminWxConfig(cfg) {
    if (cfg && typeof cfg === 'object') {
        globalConfig.adminWxConfig = {
            showWxConfigTab: cfg.showWxConfigTab !== false,
            showWxLoginTab: cfg.showWxLoginTab !== false,
            apiBase: String(cfg.apiBase || 'http://127.0.0.1:8059/api').trim(),
            apiKey: String(cfg.apiKey || '').trim(),
            proxyApiUrl: String(cfg.proxyApiUrl || 'https://api.aineishe.com/api/wxnc').trim(),
        };
        saveGlobalConfig();
    }
    return getAdminWxConfig();
}

module.exports = {
    reloadGlobalConfig,
    getConfigSnapshot,
    applyConfigSnapshot,
    getAutomation,
    setAutomation,
    isAutomationOn,
    getPreferredSeed,
    getPlantingStrategy,
    getIntervals,
    getFriendQuietHours,
    getFriendBlacklist,
    setFriendBlacklist,
    getStealDelaySeconds,
    getPlantOrderRandom,
    getPlantDelaySeconds,
    getUI,
    setUITheme,
    getOfflineReminder,
    setOfflineReminder,
    deleteUserOfflineReminder,
    // 运行时连接配置
    getRuntimeConfig,
    setRuntimeConfig,
    deleteUserRuntimeConfig,
    getUserAutomationSync,
    setUserAutomationSync,
    setUserAutomationSyncSnapshot,
    getAccounts,
    addOrUpdateAccount,
    deleteAccount,
    getAdminPasswordHash,
    setAdminPasswordHash,
    // 用户隔离支持
    getAccountsByUser,
    deleteAccountsByUser,
    deleteUserConfig,
    // 蔬菜黑名单
    getPlantBlacklist,
    setPlantBlacklist,
    // OAuth配置
    getOAuthConfig,
    setOAuthConfig,
    // OAuth用户默认配置
    getOAuthUserDefault,
    setOAuthUserDefault,
    // 卡密注册默认配置
    getCardRegisterDefault,
    setCardRegisterDefault,
    // 化肥相关配置
    getFertilizerBuyType,
    getFertilizeLandLevel,
    // 管理员微信配置
    getAdminWxConfig,
    setAdminWxConfig,
    // 秒收取和蹲守配置
    getFastHarvestConfig: (accountId) => {
        const cfg = getAccountConfigSnapshot(accountId);
        return {
            enabled: !!(cfg.automation && cfg.automation.fast_harvest),
            advanceMs: Math.max(50, Math.min(1000, Number(cfg.fastHarvestAdvanceMs) || 200)),
        };
    },
    getStakeoutStealConfig: (accountId) => {
        const cfg = getAccountConfigSnapshot(accountId);
        return {
            enabled: !!(cfg.automation && cfg.automation.stakeout_steal),
            delaySec: Math.max(0, Math.min(60, Number(cfg.stakeoutSteal && cfg.stakeoutSteal.delaySec) || 3)),
            maxAheadSec: Math.max(60, Number(cfg.stakeoutSteal && cfg.stakeoutSteal.maxAheadSec) || 4 * 3600),
            friendList: [...(cfg.stakeoutFriendList || [])],
        };
    },
    setStakeoutFriendList: (accountId, list) => {
        const current = getAccountConfigSnapshot(accountId);
        const next = cloneAccountConfig(current);
        next.stakeoutFriendList = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
        setAccountConfigSnapshot(accountId, next);
        return [...next.stakeoutFriendList];
    },
    // 访客列表相关函数
    getVisitors: (accountId) => {
        return [...(getAccountConfigSnapshot(accountId).visitors || [])];
    },
    setVisitors: (accountId, list) => {
        const current = getAccountConfigSnapshot(accountId);
        const next = cloneAccountConfig(current);
        next.visitors = Array.isArray(list) ? list.filter(v => v && v.gid && v.gid > 0) : [];
        setAccountConfigSnapshot(accountId, next);
        return [...next.visitors];
    },
    // 访客黑名单相关函数
    getVisitorBlacklist: (accountId) => {
        return [...(getAccountConfigSnapshot(accountId).visitorBlacklist || [])];
    },
    setVisitorBlacklist: (accountId, list) => {
        const current = getAccountConfigSnapshot(accountId);
        const next = cloneAccountConfig(current);
        next.visitorBlacklist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
        setAccountConfigSnapshot(accountId, next);
        return [...next.visitorBlacklist];
    },
    getVisitorGids: (accountId) => {
        const visitors = getAccountConfigSnapshot(accountId).visitors || [];
        return visitors.map(v => v.gid).filter(gid => gid && gid > 0);
    },
    // 导入黑名单相关函数
    getImportBlacklist: (accountId) => {
        return [...(getAccountConfigSnapshot(accountId).importBlacklist || [])];
    },
    setImportBlacklist: (accountId, list) => {
        const current = getAccountConfigSnapshot(accountId);
        const next = cloneAccountConfig(current);
        next.importBlacklist = Array.isArray(list) ? list.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
        setAccountConfigSnapshot(accountId, next);
        return [...next.importBlacklist];
    },
    addToImportBlacklist: (accountId, gid) => {
        const current = getAccountConfigSnapshot(accountId);
        const next = cloneAccountConfig(current);
        const list = [...(next.importBlacklist || [])];
        if (!list.includes(gid)) {
            list.push(gid);
            next.importBlacklist = list;
            setAccountConfigSnapshot(accountId, next);
        }
        return [...next.importBlacklist];
    },
    removeFromImportBlacklist: (accountId, gid) => {
        const current = getAccountConfigSnapshot(accountId);
        const next = cloneAccountConfig(current);
        const list = [...(next.importBlacklist || [])].filter(id => id !== gid);
        next.importBlacklist = list;
        setAccountConfigSnapshot(accountId, next);
        return [...next.importBlacklist];
    },
    // 批量更新访客和黑名单（只保存一次）
    batchUpdateVisitorsAndBlacklist: (accountId, visitors, blacklist) => {
        const current = getAccountConfigSnapshot(accountId);
        const next = cloneAccountConfig(current);
        if (visitors !== undefined) {
            next.visitors = Array.isArray(visitors) ? visitors.filter(v => v && v.gid && v.gid > 0) : [];
        }
        if (blacklist !== undefined) {
            next.visitorBlacklist = Array.isArray(blacklist) ? blacklist.map(Number).filter(n => Number.isFinite(n) && n > 0) : [];
        }
        setAccountConfigSnapshot(accountId, next);
        return {
            visitors: [...(next.visitors || [])],
            blacklist: [...(next.visitorBlacklist || [])]
        };
    },
};
