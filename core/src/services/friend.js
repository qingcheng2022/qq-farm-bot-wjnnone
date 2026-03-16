/**
 * 好友农场操作 - 进入/离开/帮忙/偷菜/巡查
 */

const { CONFIG, PlantPhase, PHASE_NAMES } = require('../config/config');
const { getPlantName, getPlantById, getSeedImageBySeedId } = require('../config/gameConfig');
const { isAutomationOn, getAutomation, getFriendQuietHours, getFriendBlacklist, setFriendBlacklist, getVisitorBlacklist, setVisitorBlacklist, getPlantBlacklist, getStealDelaySeconds, getStakeoutStealConfig, setStakeoutFriendList, getVisitors, setVisitors, batchUpdateVisitorsAndBlacklist, addToImportBlacklist, getImportBlacklist } = require('../models/store');
const { sendMsgAsync, getUserState, networkEvents } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, toTimeSec, getServerTimeSec, log, logWarn, sleep } = require('../utils/utils');
const { getCurrentPhase, setOperationLimitsCallback, buildLandMap, buildSlaveToMasterMap, getDisplayLandContext } = require('./farm');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');
const { sellAllFruits } = require('./warehouse');
const { getInteractRecords } = require('./interact');

// ============ 内部状态 ============
let isCheckingFriends = false;
let friendLoopRunning = false;
let externalSchedulerMode = false;
let lastResetDate = '';  // 上次重置日期 (YYYY-MM-DD)
const friendScheduler = createScheduler('friend');

// ============ 蹲守偷菜状态 ============
// 存储蹲守任务: Map<taskKey, { taskId, matureTime, landIds, friendName, allMatures }>
const stakeoutTasks = new Map();
// 蹲守任务ID计数器
let stakeoutTaskIdCounter = 0;
// 正在蹲守的任务键值集合（防止重复预约同一组）
const activeStakeoutTaskKeys = new Set();

// 操作限制状态 (从服务器响应中更新)
// 操作类型ID (根据游戏代码):
// 10001 = 收获, 10002 = 铲除, 10003 = 放草, 10004 = 放虫
// 10005 = 除草(帮好友), 10006 = 除虫(帮好友), 10007 = 浇水(帮好友), 10008 = 偷菜
const operationLimits = new Map();

// 操作类型名称映射
const OP_NAMES = {
    10001: '收获',
    10002: '铲除',
    10003: '放草',
    10004: '放虫',
    10005: '除草',
    10006: '除虫',
    10007: '浇水',
    10008: '偷菜',
};

let canGetHelpExp = true;
let helpAutoDisabledByLimit = false;
const HAHA_PUMPKIN_SEED_ID = 29998;
const PROTOBUF_MAX_RECURSION_DEPTH = 5;

function parseTimeToMinutes(timeStr) {
    const m = String(timeStr || '').match(/^(\d{1,2}):(\d{1,2})$/);
    if (!m) return null;
    const h = Number.parseInt(m[1], 10);
    const min = Number.parseInt(m[2], 10);
    if (Number.isNaN(h) || Number.isNaN(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
}

function inFriendQuietHours(now = new Date()) {
    const cfg = getFriendQuietHours();
    if (!cfg || !cfg.enabled) return false;

    const start = parseTimeToMinutes(cfg.start);
    const end = parseTimeToMinutes(cfg.end);
    if (start === null || end === null) return false;

    const cur = now.getHours() * 60 + now.getMinutes();
    if (start === end) return true; // 起止相同视为全天静默
    if (start < end) return cur >= start && cur < end;
    return cur >= start || cur < end; // 跨天时段
}

// ============ 好友 API ============

async function getAllFriends() {
    if (CONFIG.platform === 'wx') {
        const body = types.GetAllFriendsRequest.encode(types.GetAllFriendsRequest.create({})).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetAll', body);
        return types.GetAllFriendsReply.decode(replyBody);
    } else {
        const body = types.SyncAllRequest.encode(types.SyncAllRequest.create({ open_ids: [] })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'SyncAll', body);
        return types.SyncAllReply.decode(replyBody);
    }
}

const GET_GAME_FRIENDS_BATCH_SIZE = 35;

async function fetchFriendProfilesByGids(gids) {
    if (!types.GetGameFriendsRequest || !types.GetAllFriendsReply) {
        return [];
    }
    const validGids = (Array.isArray(gids) ? gids : []).map(g => toNum(g)).filter(g => g > 0);
    if (validGids.length === 0) return [];
    const allFriends = [];
    for (let i = 0; i < validGids.length; i += GET_GAME_FRIENDS_BATCH_SIZE) {
        const batch = validGids.slice(i, i + GET_GAME_FRIENDS_BATCH_SIZE);
        try {
            const body = types.GetGameFriendsRequest.encode(types.GetGameFriendsRequest.create({
                gids: batch.map(g => toLong(g)),
            })).finish();
            const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetGameFriends', body);
            if (replyBody && replyBody.length > 0) {
                const reply = types.GetAllFriendsReply.decode(replyBody);
                const friends = reply.game_friends || reply.friends || [];
                allFriends.push(...friends);
            }
        } catch {}
        if (i + GET_GAME_FRIENDS_BATCH_SIZE < validGids.length) {
            await sleep(100);
        }
    }
    return allFriends;
}

// ============ 好友申请 API (微信同玩) ============

async function getApplications() {
    const body = types.GetApplicationsRequest.encode(types.GetApplicationsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'GetApplications', body);
    return types.GetApplicationsReply.decode(replyBody);
}

async function acceptFriends(gids) {
    const body = types.AcceptFriendsRequest.encode(types.AcceptFriendsRequest.create({
        friend_gids: gids.map(g => toLong(g)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.friendpb.FriendService', 'AcceptFriends', body);
    return types.AcceptFriendsReply.decode(replyBody);
}

async function enterFriendFarm(friendGid, options = {}) {
    const body = types.VisitEnterRequest.encode(types.VisitEnterRequest.create({
        host_gid: toLong(friendGid),
        reason: 2,  // ENTER_REASON_FRIEND
    })).finish();
    try {
        const { body: replyBody } = await sendMsgAsync('gamepb.visitpb.VisitService', 'Enter', body, 10000, options);
        return types.VisitEnterReply.decode(replyBody);
    } catch (e) {
        // 检查是否是"不是好友无法拜访"错误
        const errorMsg = e?.message || '';
        if (errorMsg.includes('1002002') || errorMsg.includes('不是好友') || errorMsg.includes('无法拜访')) {
            const state = getUserState() || {};
            const accountId = state.accountId || process.env.FARM_ACCOUNT_ID || '';
            if (accountId) {
                // 1. 从访客列表中移除
                const visitors = getVisitors(accountId);
                const updatedVisitors = visitors.filter(v => v.gid !== friendGid);
                setVisitors(accountId, updatedVisitors);

                // 2. 添加到导入黑名单
                addToImportBlacklist(accountId, friendGid);

                log('好友', `GID:${friendGid} 不是好友，已自动移除并加入导入黑名单`, {
                    module: 'friend',
                    event: '自动移除非好友',
                    gid: friendGid,
                });
            }
        }
        throw e;
    }
}

async function leaveFriendFarm(friendGid, options = {}) {
    const body = types.VisitLeaveRequest.encode(types.VisitLeaveRequest.create({
        host_gid: toLong(friendGid),
    })).finish();
    try {
        await sendMsgAsync('gamepb.visitpb.VisitService', 'Leave', body, 10000, options);
    } catch { /* 离开失败不影响主流程 */ }
}

/**
 * 检查是否需要重置每日限制 (0点刷新)
 */
function checkDailyReset() {
    // 使用服务器时间（北京时间 UTC+8）计算当前日期，避免时区偏差
    const nowSec = getServerTimeSec();
    const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
    const bjOffset = 8 * 3600 * 1000;
    const bjDate = new Date(nowMs + bjOffset);
    const y = bjDate.getUTCFullYear();
    const m = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(bjDate.getUTCDate()).padStart(2, '0');
    const today = `${y}-${m}-${d}`;  // 北京时间日期 YYYY-MM-DD
    if (lastResetDate !== today) {
        if (lastResetDate !== '') {
            log('系统', '跨日重置，清空操作限制缓存');
        }
        operationLimits.clear();
        canGetHelpExp = true;
        if (helpAutoDisabledByLimit) {
            helpAutoDisabledByLimit = false;
            log('好友', '新的一天已开始，自动恢复帮忙操作功能', {
                module: 'friend',
                event: '好友巡查循环',
                result: 'ok',
            });
        }
        lastResetDate = today;
    }
}

function autoDisableHelpByExpLimit() {
    if (!canGetHelpExp) return;
    canGetHelpExp = false;
    helpAutoDisabledByLimit = true;
    log('好友', '今日帮助经验已达上限，自动停止帮忙', {
        module: 'friend',
        event: '好友巡查循环',
        result: 'ok',
    });
}

/**
 * 更新操作限制状态
 */
function updateOperationLimits(limits) {
    if (!limits || limits.length === 0) return;
    checkDailyReset();
    for (const limit of limits) {
        const id = toNum(limit.id);
        if (id > 0) {
            const data = {
                dayTimes: toNum(limit.day_times),
                dayTimesLimit: toNum(limit.day_times_lt),
                dayExpTimes: toNum(limit.day_exp_times),
                dayExpTimesLimit: toNum(limit.day_ex_times_lt), // 协议字段名为 day_ex_times_lt
            };
            operationLimits.set(id, data);
        }
    }
}

function canGetExpByCandidates(opIds = []) {
    const ids = Array.isArray(opIds) ? opIds : [opIds];
    for (const id of ids) {
        if (canGetExp(toNum(id))) return true;
    }
    return false;
}

/**
 * 检查某操作是否还能获得经验
 */
function canGetExp(opId) {
    const limit = operationLimits.get(opId);
    if (!limit) return false;  // 没有限制信息，保守起见不帮助（等待限制数据）
    if (limit.dayExpTimesLimit <= 0) return true;  // 没有经验上限
    return limit.dayExpTimes < limit.dayExpTimesLimit;
}

/**
 * 检查某操作是否还有次数
 */
function canOperate(opId) {
    const limit = operationLimits.get(opId);
    if (!limit) return true;
    if (limit.dayTimesLimit <= 0) return true;
    return limit.dayTimes < limit.dayTimesLimit;
}

/**
 * 获取某操作剩余次数
 */
function getRemainingTimes(opId) {
    const limit = operationLimits.get(opId);
    if (!limit || limit.dayTimesLimit <= 0) return 999;
    return Math.max(0, limit.dayTimesLimit - limit.dayTimes);
}

/**
 * 获取操作限制详情 (供管理面板使用)
 */
function getOperationLimits() {
    const result = {};
    for (const id of [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008]) {
        const limit = operationLimits.get(id);
        if (limit) {
            result[id] = {
                name: OP_NAMES[id] || `#${id}`,
                ...limit,
                remaining: getRemainingTimes(id),
            };
        }
    }
    return result;
}

async function helpWater(friendGid, landIds, stopWhenExpLimit = false) {
    const beforeExp = toNum((getUserState() || {}).exp);
    const body = types.WaterLandRequest.encode(types.WaterLandRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WaterLand', body);
    const reply = types.WaterLandReply.decode(replyBody);
    updateOperationLimits(reply.operation_limits);
    if (stopWhenExpLimit) {
        await sleep(200);
        const afterExp = toNum((getUserState() || {}).exp);
        if (afterExp <= beforeExp) autoDisableHelpByExpLimit();
    }
    return reply;
}

async function helpWeed(friendGid, landIds, stopWhenExpLimit = false) {
    const beforeExp = toNum((getUserState() || {}).exp);
    const body = types.WeedOutRequest.encode(types.WeedOutRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'WeedOut', body);
    const reply = types.WeedOutReply.decode(replyBody);
    updateOperationLimits(reply.operation_limits);
    if (stopWhenExpLimit) {
        await sleep(200);
        const afterExp = toNum((getUserState() || {}).exp);
        if (afterExp <= beforeExp) autoDisableHelpByExpLimit();
    }
    return reply;
}

async function helpInsecticide(friendGid, landIds, stopWhenExpLimit = false) {
    const beforeExp = toNum((getUserState() || {}).exp);
    const body = types.InsecticideRequest.encode(types.InsecticideRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Insecticide', body);
    const reply = types.InsecticideReply.decode(replyBody);
    updateOperationLimits(reply.operation_limits);
    if (stopWhenExpLimit) {
        await sleep(200);
        const afterExp = toNum((getUserState() || {}).exp);
        if (afterExp <= beforeExp) autoDisableHelpByExpLimit();
    }
    return reply;
}

async function stealHarvest(friendGid, landIds, options = {}) {
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(friendGid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body, 10000, options);
    const reply = types.HarvestReply.decode(replyBody);
    updateOperationLimits(reply.operation_limits);
    return reply;
}

async function putPlantItems(friendGid, landIds, RequestType, ReplyType, method) {
    let ok = 0;
    const ids = Array.isArray(landIds) ? landIds : [];
    for (const landId of ids) {
        try {
            const body = RequestType.encode(RequestType.create({
                land_ids: [toLong(landId)],
                host_gid: toLong(friendGid),
            })).finish();
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body);
            const reply = ReplyType.decode(replyBody);
            updateOperationLimits(reply.operation_limits);
            ok++;
        } catch (e) {
            if (e.message && e.message.includes('1001046')) {
                log('好友', `放虫/放草次数已达上限，停止执行`, { module: 'friend', event: '放虫放草次数上限' });
                const err = new Error('LIMIT_REACHED');
                err.code = 'LIMIT_REACHED';
                throw err;
            }
            log('好友', `放虫/放草失败: landId=${landId}, 错误: ${e.message}`, { module: 'friend', event: '放虫放草失败', landId, error: e.message });
        }
        await sleep(100);
    }
    return ok;
}

async function putPlantItemsDetailed(friendGid, landIds, RequestType, ReplyType, method) {
    let ok = 0;
    const failed = [];
    const ids = Array.isArray(landIds) ? landIds : [];
    for (const landId of ids) {
        try {
            const body = RequestType.encode(RequestType.create({
                land_ids: [toLong(landId)],
                host_gid: toLong(friendGid),
            })).finish();
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body);
            const reply = ReplyType.decode(replyBody);
            updateOperationLimits(reply.operation_limits);
            ok++;
        } catch (e) {
            failed.push({ landId, reason: e && e.message ? e.message : '未知错误' });
        }
        await sleep(100);
    }
    return { ok, failed };
}

async function putInsects(friendGid, landIds) {
    return putPlantItems(friendGid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
}

async function putWeeds(friendGid, landIds) {
    return putPlantItems(friendGid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
}

async function putInsectsDetailed(friendGid, landIds) {
    return putPlantItemsDetailed(friendGid, landIds, types.PutInsectsRequest, types.PutInsectsReply, 'PutInsects');
}

async function putWeedsDetailed(friendGid, landIds) {
    return putPlantItemsDetailed(friendGid, landIds, types.PutWeedsRequest, types.PutWeedsReply, 'PutWeeds');
}

async function checkCanOperateRemote(friendGid, operationId, options = {}) {
    if (!types.CheckCanOperateRequest || !types.CheckCanOperateReply) {
        return { canOperate: true, canStealNum: 0 };
    }
    try {
        const body = types.CheckCanOperateRequest.encode(types.CheckCanOperateRequest.create({
            host_gid: toLong(friendGid),
            operation_id: toLong(operationId),
        })).finish();
        const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'CheckCanOperate', body, 10000, options);
        const reply = types.CheckCanOperateReply.decode(replyBody);
        return {
            canOperate: !!reply.can_operate,
            canStealNum: toNum(reply.can_steal_num),
        };
    } catch {
        // 预检查失败时降级为不拦截，避免因协议抖动导致完全不操作
        return { canOperate: true, canStealNum: 0 };
    }
}

// ============ 好友土地分析 ============

function analyzeFriendLands(lands, myGid, friendName = '', options = {}) {
    const { plantBlacklist = null, stealDelaySeconds = 0 } = options;
    const result = {
        stealable: [],   // 可偷
        stealableInfo: [],  // 可偷植物信息 { landId, plantId, name }
        needWater: [],   // 需要浇水
        needWeed: [],    // 需要除草
        needBug: [],     // 需要除虫
        canPutWeed: [],  // 可以放草
        canPutBug: [],   // 可以放虫
    };

    const nowSec = getServerTimeSec();

    for (const land of lands) {
        const id = toNum(land.id);
        const plant = land.plant;

        if (!plant || !plant.phases || plant.phases.length === 0) {
            continue;
        }

        const currentPhase = getCurrentPhase(plant.phases, false, `[${friendName}]土地#${id}`);
        if (!currentPhase) {
            continue;
        }
        const phaseVal = currentPhase.phase;

        if (phaseVal === PlantPhase.MATURE) {
            if (plant.stealable) {
                const plantId = toNum(plant.id);
                const plantName = getPlantName(plantId) || plant.name || '未知';

                // 获取种子ID用于黑名单检查（前端黑名单使用seedId）
                const plantCfg = getPlantById(plantId);
                const seedId = plantCfg ? toNum(plantCfg.seed_id) : 0;

                // 蔬菜黑名单过滤 - 使用seedId检查
                if (plantBlacklist && seedId > 0 && plantBlacklist.includes(seedId)) {
                    continue;
                }

                // 偷菜延迟检查 - 检查作物是否已经成熟超过指定的延迟时间
                if (stealDelaySeconds > 0) {
                    const maturePhase = plant.phases.find(p => toNum(p.phase) === PlantPhase.MATURE);
                    if (maturePhase) {
                        const matureBeginTime = toTimeSec(maturePhase.begin_time);
                        if (matureBeginTime > 0) {
                            const maturedSeconds = nowSec - matureBeginTime;
                            if (maturedSeconds < stealDelaySeconds) {
                                continue;
                            }
                        }
                    }
                }

                result.stealable.push(id);
                result.stealableInfo.push({ landId: id, plantId, name: plantName });
            }
            continue;
        }

        if (phaseVal === PlantPhase.DEAD) continue;

        // 帮助操作
        if (toNum(plant.dry_num) > 0) result.needWater.push(id);
        if (plant.weed_owners && plant.weed_owners.length > 0) result.needWeed.push(id);
        if (plant.insect_owners && plant.insect_owners.length > 0) result.needBug.push(id);

        if (phaseVal !== PlantPhase.MATURE) {
            const weedOwners = plant.weed_owners || [];
            const insectOwners = plant.insect_owners || [];
            const iAlreadyPutWeed = weedOwners.some(gid => toNum(gid) === myGid);
            const iAlreadyPutBug = insectOwners.some(gid => toNum(gid) === myGid);
            if (weedOwners.length === 0 && insectOwners.length === 0 && !iAlreadyPutWeed) {
                result.canPutWeed.push(id);
            }
            if (weedOwners.length === 0 && insectOwners.length === 0 && !iAlreadyPutBug) {
                result.canPutBug.push(id);
            }
        }
    }
    return result;
}

/**
 * 获取好友列表 (供面板)
 */
async function getFriendsList() {
    try {
        const state = getUserState();
        const importBlacklist = getImportBlacklist(state.accountId);

        // 微信方式：直接获取好友列表，不使用访客列表
        if (CONFIG.platform === 'wx') {
            try {
                const reply = await getAllFriends();
                const friends = reply.game_friends || reply.friends || [];
                return friends
                    .filter(f => toNum(f.gid) !== state.gid && f.name !== '小小农夫' && f.remark !== '小小农夫')
                    .map(f => ({
                        gid: toNum(f.gid),
                        name: f.remark || f.name || `GID:${toNum(f.gid)}`,
                        avatarUrl: String(f.avatar_url || '').trim(),
                        plant: f.plant ? {
                            stealNum: toNum(f.plant.steal_plant_num),
                            dryNum: toNum(f.plant.dry_num),
                            weedNum: toNum(f.plant.weed_num),
                            insectNum: toNum(f.plant.insect_num),
                        } : null,
                    }))
                    .sort((a, b) => {
                        const an = String(a.name || '');
                        const bn = String(b.name || '');
                        const byName = an.localeCompare(bn, 'zh-CN');
                        if (byName !== 0) return byName;
                        return Number(a.gid || 0) - Number(b.gid || 0);
                    });
            } catch (e) {
                logWarn('好友', `获取好友列表失败: ${e.message}`, { module: 'friend', event: '获取好友列表失败', error: e.message });
                return [];
            }
        }

        // QQ方式：使用访客列表作为备用方案
        const useVisitorGids = isAutomationOn('use_visitor_gids', state.accountId);
        const useGuidRange = isAutomationOn('use_guid_range', state.accountId);
        const guidIndexCompleted = !!getAutomation(state.accountId).guid_index_completed;
        let visitors = getVisitors(state.accountId);
        let friends = [];

        // 无论是否使用GUID范围索引，都检查访客记录并更新
        try {
            const interactRecords = await getInteractRecords();
            const visitorMap = new Map();
            const visitorBlacklist = getVisitorBlacklist(state.accountId);

            for (const visitor of visitors) {
                visitorMap.set(visitor.gid, visitor);
            }

            let newVisitors = 0;

            for (const record of interactRecords) {
                if (record.visitorGid && record.visitorGid > 0) {
                    if (!visitorBlacklist.includes(record.visitorGid) && !importBlacklist.includes(record.visitorGid)) {
                        if (!visitorMap.has(record.visitorGid)) {
                            visitorMap.set(record.visitorGid, {
                                gid: record.visitorGid,
                                name: record.nick || `GID:${record.visitorGid}`,
                                avatarUrl: record.avatarUrl || '',
                                lastSeen: Date.now(),
                            });
                            newVisitors++;
                        }
                    }
                }
            }

            if (newVisitors > 0) {
                const updatedVisitors = Array.from(visitorMap.values());
                setVisitors(state.accountId, updatedVisitors);
                visitors = updatedVisitors;
                log('好友', `从访客列表获取到 ${newVisitors} 个新的访客`, { module: 'friend', event: '更新访客列表', newVisitors, totalVisitors: updatedVisitors.length });
            }
        } catch (e) {
            logWarn('好友', `获取访客记录失败: ${e.message}`, { module: 'friend', event: '获取访客记录失败', error: e.message });
        }

        if (useGuidRange && !guidIndexCompleted) {
            const visitorBlacklist = getVisitorBlacklist(state.accountId);
            friends = visitors
                .filter(visitor => !visitorBlacklist.includes(visitor.gid) && !importBlacklist.includes(visitor.gid))
                .map(visitor => ({
                    gid: visitor.gid,
                    name: visitor.name,
                    avatar_url: visitor.avatarUrl,
                    plant: null,
                }));
        } else if (useVisitorGids && visitors.length > 0) {
            const visitorBlacklist = getVisitorBlacklist(state.accountId);
            friends = visitors
                .filter(visitor => !visitorBlacklist.includes(visitor.gid))
                .map(visitor => ({
                    gid: visitor.gid,
                    name: visitor.name,
                    avatar_url: visitor.avatarUrl,
                    plant: null,
                }));
        } else {
            try {
                const reply = await getAllFriends();
                friends = reply.game_friends || reply.friends || [];
            } catch (e) {
                logWarn('好友', `获取好友列表失败，使用访客列表: ${e.message}`, { module: 'friend', event: '获取好友列表失败', error: e.message });
                const visitorBlacklist = getVisitorBlacklist(state.accountId);
                friends = visitors
                    .filter(visitor => !visitorBlacklist.includes(visitor.gid) && !importBlacklist.includes(visitor.gid))
                    .map(visitor => ({
                        gid: visitor.gid,
                        name: visitor.name,
                        avatar_url: visitor.avatarUrl,
                        plant: null,
                    }));
            }
        }

        return friends
            .filter(f => toNum(f.gid) !== state.gid && f.name !== '小小农夫' && f.remark !== '小小农夫' && !importBlacklist.includes(toNum(f.gid)))
            .map(f => ({
                gid: toNum(f.gid),
                name: f.remark || f.name || `GID:${toNum(f.gid)}`,
                avatarUrl: String(f.avatar_url || '').trim(),
                plant: f.plant ? {
                    stealNum: toNum(f.plant.steal_plant_num),
                    dryNum: toNum(f.plant.dry_num),
                    weedNum: toNum(f.plant.weed_num),
                    insectNum: toNum(f.plant.insect_num),
                } : null,
            }))
            .sort((a, b) => {
                const an = String(a.name || '');
                const bn = String(b.name || '');
                const byName = an.localeCompare(bn, 'zh-CN');
                if (byName !== 0) return byName;
                return Number(a.gid || 0) - Number(b.gid || 0);
            });
    } catch (e) {
        logWarn('好友', `获取好友列表异常: ${e.message}`, { module: 'friend', event: '获取好友列表异常', error: e.message });
        return [];
    }
}

/**
 * 获取指定好友的农田详情 (进入-获取-离开)
 */
async function getFriendLandsDetail(friendGid) {
    try {
        const enterReply = await enterFriendFarm(friendGid);
        const lands = enterReply.lands || [];
        const state = getUserState();
        const plantBlacklist = getPlantBlacklist(state.accountId);
        const analyzed = analyzeFriendLands(lands, state.gid, '', { plantBlacklist });
        await leaveFriendFarm(friendGid);

        const landsList = [];
        const nowSec = getServerTimeSec();
        const landsMap = buildLandMap(lands);
        const slaveToMasterMap = buildSlaveToMasterMap(lands);

        for (const land of lands) {
            const id = toNum(land.id);
            const level = toNum(land.level);
            const unlocked = !!land.unlocked;
            
            const {
                sourceLand,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
            } = getDisplayLandContext(land, landsMap, slaveToMasterMap);

            if (!unlocked) {
                landsList.push({
                    id,
                    unlocked: false,
                    status: 'locked',
                    plantName: '',
                    phaseName: '未解锁',
                    level,
                    needWater: false,
                    needWeed: false,
                    needBug: false,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster: false,
                    masterLandId: 0,
                    occupiedLandIds: [],
                    plantSize: 1,
                });
                continue;
            }

            const plant = sourceLand && sourceLand.plant;
            if (!plant || !plant.phases || plant.phases.length === 0) {
                landsList.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '空地',
                    level,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster,
                    masterLandId,
                    occupiedLandIds,
                    plantSize: 1,
                });
                continue;
            }
            const currentPhase = getCurrentPhase(plant.phases, false, '');
            if (!currentPhase) {
                landsList.push({
                    id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '',
                    level,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster,
                    masterLandId,
                    occupiedLandIds,
                    plantSize: 1,
                });
                continue;
            }
            const phaseVal = currentPhase.phase;
            const plantId = toNum(plant.id);
            const plantName = getPlantName(plantId) || plant.name || '未知';
            const plantCfg = getPlantById(plantId);
            const seedId = toNum(plantCfg && plantCfg.seed_id);
            const seedImage = seedId > 0 ? getSeedImageBySeedId(seedId) : '';
            const phaseName = PHASE_NAMES[phaseVal] || '';
            const maturePhase = Array.isArray(plant.phases)
                ? plant.phases.find((p) => p && toNum(p.phase) === PlantPhase.MATURE)
                : null;
            const matureBegin = maturePhase ? toTimeSec(maturePhase.begin_time) : 0;
            const matureInSec = matureBegin > nowSec ? (matureBegin - nowSec) : 0;
            let landStatus = 'growing';
            if (phaseVal === PlantPhase.MATURE) landStatus = plant.stealable ? 'stealable' : 'harvested';
            else if (phaseVal === PlantPhase.DEAD) landStatus = 'dead';

            const plantSize = Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
            const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
            const currentSeasonRaw = toNum(plant && plant.season);
            const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;

            landsList.push({
                id,
                unlocked: true,
                status: landStatus,
                plantName,
                seedId,
                seedImage,
                phaseName,
                level,
                matureInSec,
                needWater: toNum(plant.dry_num) > 0,
                needWeed: (plant.weed_owners && plant.weed_owners.length > 0),
                needBug: (plant.insect_owners && plant.insect_owners.length > 0),
                currentSeason,
                totalSeason,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
                plantSize,
            });
        }

        return {
            lands: landsList,
            summary: analyzed,
        };
    } catch {
        return { lands: [], summary: {} };
    }
}

async function runBatchWithFallback(ids, batchFn, singleFn) {
    const target = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (target.length === 0) return 0;
    try {
        await batchFn(target);
        return target.length;
    } catch {
        let ok = 0;
        for (const landId of target) {
            try {
                await singleFn([landId]);
                ok++;
            } catch { /* ignore */ }
            await sleep(100);
        }
        return ok;
    }
}

/**
 * 面板手动好友操作（单个好友）
 * opType: 'steal' | 'water' | 'weed' | 'bug' | 'bad'
 */
async function doFriendOperation(friendGid, opType) {
    const gid = toNum(friendGid);
    if (!gid) return { ok: false, message: '无效好友ID', opType };

    let enterReply;
    try {
        enterReply = await enterFriendFarm(gid);
    } catch (e) {
        return { ok: false, message: `进入好友农场失败: ${e.message}`, opType };
    }

    try {
        const lands = enterReply.lands || [];
        const state = getUserState();
        if (hasHahaPumpkinInLands(lands)) {
            moveFriendToImportBlacklistByHaha(state.accountId, gid, `GID:${gid}`, '手动操作');
            return { ok: false, opType, count: 0, message: '检测到哈哈南瓜，已自动移除并加入导入黑名单' };
        }
        const plantBlacklist = getPlantBlacklist(state.accountId);
        const status = analyzeFriendLands(lands, state.gid, '', { plantBlacklist });
        let count = 0;

        if (opType === 'steal') {
            if (!status.stealable.length) return { ok: true, opType, count: 0, message: '没有可偷取土地' };
            const precheck = await checkCanOperateRemote(gid, 10008);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '今日偷菜次数已用完' };
            const maxNum = precheck.canStealNum > 0 ? precheck.canStealNum : status.stealable.length;
            const target = status.stealable.slice(0, maxNum);
            count = await runBatchWithFallback(target, (ids) => stealHarvest(gid, ids), (ids) => stealHarvest(gid, ids));
            if (count > 0) {
                recordOperation('steal', count);
                // 手动偷取成功后立即尝试出售一次果实
                try {
                    await sellAllFruits();
                } catch (e) {
                    logWarn('仓库', `手动偷取后自动出售失败: ${e.message}`, {
                        module: 'warehouse',
                        event: '偷菜后出售',
                        result: 'error',
                        mode: 'manual',
                    });
                }
            }
            return { ok: true, opType, count, message: `偷取完成 ${count} 块` };
        }

        if (opType === 'water') {
            if (!status.needWater.length) return { ok: true, opType, count: 0, message: '没有可浇水土地' };
            const precheck = await checkCanOperateRemote(gid, 10007);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '今日浇水次数已用完' };
            count = await runBatchWithFallback(status.needWater, (ids) => helpWater(gid, ids), (ids) => helpWater(gid, ids));
            if (count > 0) recordOperation('helpWater', count);
            return { ok: true, opType, count, message: `浇水完成 ${count} 块` };
        }

        if (opType === 'weed') {
            if (!status.needWeed.length) return { ok: true, opType, count: 0, message: '没有可除草土地' };
            const precheck = await checkCanOperateRemote(gid, 10005);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '今日除草次数已用完' };
            count = await runBatchWithFallback(status.needWeed, (ids) => helpWeed(gid, ids), (ids) => helpWeed(gid, ids));
            if (count > 0) recordOperation('helpWeed', count);
            return { ok: true, opType, count, message: `除草完成 ${count} 块` };
        }

        if (opType === 'bug') {
            if (!status.needBug.length) return { ok: true, opType, count: 0, message: '没有可除虫土地' };
            const precheck = await checkCanOperateRemote(gid, 10006);
            if (!precheck.canOperate) return { ok: true, opType, count: 0, message: '今日除虫次数已用完' };
            count = await runBatchWithFallback(status.needBug, (ids) => helpInsecticide(gid, ids), (ids) => helpInsecticide(gid, ids));
            if (count > 0) recordOperation('helpBug', count);
            return { ok: true, opType, count, message: `除虫完成 ${count} 块` };
        }

        if (opType === 'bad') {
            let bugCount = 0;
            let weedCount = 0;
            if (!status.canPutBug.length && !status.canPutWeed.length) {
                return { ok: true, opType, count: 0, bugCount: 0, weedCount: 0, message: '没有可捣乱土地' };
            }

            // 手动捣乱不依赖预检查，逐块执行（与 terminal-farm-main 保持一致）
            let failDetails = [];
            if (status.canPutBug.length) {
                const bugRet = await putInsectsDetailed(gid, status.canPutBug);
                bugCount = bugRet.ok;
                failDetails = failDetails.concat((bugRet.failed || []).map(f => `放虫#${f.landId}:${f.reason}`));
                if (bugCount > 0) recordOperation('bug', bugCount);
            }
            if (status.canPutWeed.length) {
                const weedRet = await putWeedsDetailed(gid, status.canPutWeed);
                weedCount = weedRet.ok;
                failDetails = failDetails.concat((weedRet.failed || []).map(f => `放草#${f.landId}:${f.reason}`));
                if (weedCount > 0) recordOperation('weed', weedCount);
            }
            count = bugCount + weedCount;
            if (count <= 0) {
                const reasonPreview = failDetails.slice(0, 2).join(' | ');
                return {
                    ok: true,
                    opType,
                    count: 0,
                    bugCount,
                    weedCount,
                    message: reasonPreview ? `捣乱失败: ${reasonPreview}` : '捣乱失败或今日次数已用完'
                };
            }
            return { ok: true, opType, count, bugCount, weedCount, message: `捣乱完成 虫${bugCount}/草${weedCount}` };
        }

        return { ok: false, opType, count: 0, message: '未知操作类型' };
    } catch (e) {
        return { ok: false, opType, count: 0, message: e.message || '操作失败' };
    } finally {
        try { await leaveFriendFarm(gid); } catch { /* ignore */ }
    }
}

// ============ 拜访好友 ============

async function handleBannedFriend(gid, name, accountId) {
    logWarn('好友', `${name} 已被封禁，自动加入黑名单`, {
        module: 'friend', event: '自动加入黑名单', friendName: name, friendGid: gid
    });
    const currentBlacklist = getFriendBlacklist(accountId);
    if (!currentBlacklist.includes(gid)) {
        currentBlacklist.push(gid);
        setFriendBlacklist(accountId, currentBlacklist);
        log('好友', `${name} 已自动加入好友黑名单`, {
            module: 'friend', event: '已加入黑名单', friendName: name, friendGid: gid
        });
    }
}

function hasHahaPumpkinInLands(lands) {
    const list = Array.isArray(lands) ? lands : [];
    for (const land of list) {
        const plant = land && land.plant;
        if (!plant) continue;
        const plantId = toNum(plant.id);
        if (!plantId) continue;
        const plantCfg = getPlantById(plantId);
        const seedId = toNum(plantCfg && plantCfg.seed_id);
        if (seedId === HAHA_PUMPKIN_SEED_ID) {
            return true;
        }
    }
    return false;
}

function moveFriendToImportBlacklistByHaha(accountId, gid, name, source = '') {
    const friendGid = toNum(gid);
    if (!accountId || !friendGid) return;

    const existedInImportBlacklist = getImportBlacklist(accountId).includes(friendGid);
    if (!existedInImportBlacklist) {
        addToImportBlacklist(accountId, friendGid);
    }

    const visitors = getVisitors(accountId);
    const updatedVisitors = visitors.filter(v => toNum(v.gid) !== friendGid);
    if (updatedVisitors.length !== visitors.length) {
        setVisitors(accountId, updatedVisitors);
    }

    const stakeoutConfig = getStakeoutStealConfig(accountId);
    const stakeoutFriendList = Array.isArray(stakeoutConfig && stakeoutConfig.friendList) ? stakeoutConfig.friendList : [];
    if (stakeoutFriendList.includes(friendGid)) {
        const nextFriendList = stakeoutFriendList.filter(id => toNum(id) !== friendGid);
        setStakeoutFriendList(accountId, nextFriendList);
    }

    logWarn('好友', `${name || `GID:${friendGid}`} 检测到哈哈南瓜，已自动移除并加入导入黑名单`, {
        module: 'friend',
        event: '自动移除哈哈南瓜好友',
        friendName: name,
        friendGid,
        source,
    });
}

function isPrintableProtoString(str) {
    return /^[\x20-\x7E\u4E00-\u9FFF]+$/u.test(str)
        || str.startsWith('http')
        || /^[A-F0-9]{32,}$/i.test(str);
}

function readVarintFromBuffer(buf, offset) {
    let result = 0n;
    let shift = 0n;
    let i = offset;
    while (i < buf.length) {
        const b = BigInt(buf[i++]);
        result |= (b & 0x7Fn) << shift;
        if ((b & 0x80n) === 0n) break;
        shift += 7n;
        if (shift > 70n) break;
    }
    return { value: result, bytesRead: i - offset };
}

function normalizeHexInput(input) {
    return String(input || '').replace(/[^0-9a-f]/gi, '');
}

function hexToBytes(hexRaw) {
    const cleaned = normalizeHexInput(hexRaw);
    if (!cleaned) throw new Error('Hex 为空');
    if (cleaned.length % 2 !== 0) throw new Error('Hex 长度无效');
    const list = [];
    for (let i = 0; i < cleaned.length; i += 2) {
        const value = Number.parseInt(cleaned.slice(i, i + 2), 16);
        if (Number.isNaN(value)) throw new Error('Hex 格式无效');
        list.push(value);
    }
    return Uint8Array.from(list);
}

function decodeGenericProtobuf(buf, depth = 0) {
    const result = {};
    if (!buf || !buf.length || depth > PROTOBUF_MAX_RECURSION_DEPTH) return result;

    let i = 0;
    while (i < buf.length) {
        const tagRes = readVarintFromBuffer(buf, i);
        const tag = Number(tagRes.value);
        i += tagRes.bytesRead;

        const fieldNumber = tag >> 3;
        const wireType = tag & 0x07;
        if (!fieldNumber || wireType > 5) break;

        let value = null;

        if (wireType === 0) {
            const varintRes = readVarintFromBuffer(buf, i);
            const v = varintRes.value;
            value = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
            i += varintRes.bytesRead;
        } else if (wireType === 1) {
            if (i + 8 <= buf.length) {
                value = Array.from(buf.slice(i, i + 8)).map(b => b.toString(16).padStart(2, '0')).join('');
                i += 8;
            } else {
                break;
            }
        } else if (wireType === 2) {
            const lenRes = readVarintFromBuffer(buf, i);
            const lenBig = lenRes.value;
            i += lenRes.bytesRead;
            if (lenBig > BigInt(Number.MAX_SAFE_INTEGER)) break;
            const len = Number(lenBig);
            if (len < 0 || i + len > buf.length) break;
            const data = buf.slice(i, i + len);
            i += len;
            const text = Buffer.from(data).toString('utf8');
            if (isPrintableProtoString(text)) {
                value = text;
            } else {
                const nested = decodeGenericProtobuf(data, depth + 1);
                value = Object.keys(nested).length > 0
                    ? nested
                    : Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('');
            }
        } else if (wireType === 5) {
            if (i + 4 <= buf.length) {
                const view = new DataView(buf.buffer, buf.byteOffset + i, 4);
                value = view.getUint32(0, true);
                i += 4;
            } else {
                break;
            }
        } else {
            break;
        }

        if (value !== null) {
            const key = `field_${fieldNumber}`;
            if (result[key] === undefined) {
                result[key] = value;
            } else if (Array.isArray(result[key])) {
                result[key].push(value);
            } else {
                result[key] = [result[key], value];
            }
        }
    }

    return result;
}

function extractFriendsFromDecodedHex(decoded) {
    const root = decoded && typeof decoded === 'object' ? decoded : {};
    const level2 = root.field_2;
    if (!level2 || typeof level2 !== 'object') return [];
    const rawFriends = level2.field_1;
    const list = Array.isArray(rawFriends) ? rawFriends : (rawFriends ? [rawFriends] : []);
    const result = [];
    const seen = new Set();
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const gid = toNum(item.field_1);
        if (!gid) continue;
        if (seen.has(gid)) continue;
        seen.add(gid);
        result.push(gid);
    }
    return result;
}

async function upsertVisitorsByGids(accountId, gids) {
    const visitors = getVisitors(accountId);
    const visitorBlacklist = getVisitorBlacklist(accountId);
    const success = [];
    const failed = [];
    const now = Date.now();
    const profileMap = new Map();
    const profileCandidates = await fetchFriendProfilesByGids(gids);
    for (const f of profileCandidates) {
        const gid = toNum(f && f.gid);
        if (!gid) continue;
        profileMap.set(gid, {
            name: String(f.remark || f.name || '').trim() || `GID:${gid}`,
            avatarUrl: String(f.avatar_url || '').trim(),
        });
    }

    for (const rawGid of (Array.isArray(gids) ? gids : [])) {
        const gid = toNum(rawGid);
        if (!gid) continue;
        const profile = profileMap.get(gid) || null;

        const blacklistIndex = visitorBlacklist.indexOf(gid);
        if (blacklistIndex !== -1) {
            visitorBlacklist.splice(blacklistIndex, 1);
        }

        const existingIndex = visitors.findIndex(v => toNum(v.gid) === gid);
        if (existingIndex === -1) {
            visitors.push({
                gid,
                name: (profile && profile.name) ? profile.name : `GID:${gid}`,
                avatarUrl: (profile && profile.avatarUrl) ? profile.avatarUrl : '',
                lastSeen: now,
            });
            success.push({ gid, message: (profile && (profile.name || profile.avatarUrl)) ? '添加成功并写入资料' : '添加成功' });
        } else {
            const current = visitors[existingIndex] || {};
            const currentName = String(current.name || '').trim();
            const currentAvatar = String(current.avatarUrl || '').trim();
            const shouldOverrideName = !currentName || /^GID:\d+$/i.test(currentName);
            const mergedName = (profile && profile.name && shouldOverrideName) ? profile.name : (currentName || `GID:${gid}`);
            const mergedAvatar = (profile && profile.avatarUrl) ? profile.avatarUrl : currentAvatar;
            visitors[existingIndex] = {
                ...current,
                name: mergedName,
                avatarUrl: mergedAvatar,
                lastSeen: now,
            };
            success.push({ gid, message: (profile && (profile.name || profile.avatarUrl)) ? '资料已更新' : '已更新' });
        }
    }

    batchUpdateVisitorsAndBlacklist(accountId, visitors, visitorBlacklist);

    return {
        ok: success.length > 0,
        results: {
            success,
            failed,
            total: success.length + failed.length,
            successCount: success.length,
            failedCount: failed.length,
        },
    };
}

async function upsertVisitorsByHexProfiles(accountId, gids) {
    return await upsertVisitorsByGids(accountId, gids);
}

async function addManualFriendsByHex(hexInput) {
    const state = getUserState();
    const bytes = hexToBytes(hexInput);
    const decoded = decodeGenericProtobuf(bytes);
    const extractedGids = extractFriendsFromDecodedHex(decoded);
    if (extractedGids.length === 0) {
        return {
            ok: false,
            error: 'Hex 未解析到有效好友数据',
            results: {
                success: [],
                failed: [],
                total: 0,
                successCount: 0,
                failedCount: 0,
            },
        };
    }
    return await upsertVisitorsByHexProfiles(state.accountId, extractedGids);
}

async function enterFriendFarmSafe(gid, name, accountId) {
    try {
        return await enterFriendFarm(gid);
    } catch (e) {
        logWarn('好友', `进入 ${name} 农场失败: ${e.message}`, {
            module: 'friend', event: '进入农场失败', result: 'error', friendName: name, friendGid: gid
        });
        if (e.message && e.message.includes('1002003')) {
            await handleBannedFriend(gid, name, accountId);
        }
        return null;
    }
}

async function executeSteal(gid, targetLands, _stealableInfo, options = {}) {
    let ok = 0;
    try {
        await stealHarvest(gid, targetLands, options);
        ok = targetLands.length;
    } catch {
        for (const landId of targetLands) {
            try {
                await stealHarvest(gid, [landId], options);
                ok++;
            } catch { }
            await sleep(100);
        }
    }
    return ok;
}

async function visitFriend(friend, totalActions, myGid, accountId) {
    const { gid, name } = friend;

    log('好友', `开始巡查: ${name}`, {
        module: 'friend', event: '开始巡查好友', friendName: name, friendGid: gid
    });

    const friendBlacklist = getFriendBlacklist(accountId);
    const friendId = toNum(gid);
    if (friendBlacklist && friendBlacklist.includes(friendId)) {
        return;
    }

    const enterReply = await enterFriendFarmSafe(gid, name, accountId);
    if (!enterReply) return;

    const lands = enterReply.lands || [];
    if (lands.length === 0) {
        await leaveFriendFarm(gid);
        return;
    }
    if (hasHahaPumpkinInLands(lands)) {
        moveFriendToImportBlacklistByHaha(accountId, gid, name, '巡查');
        await leaveFriendFarm(gid);
        return;
    }

    const plantBlacklist = getPlantBlacklist(accountId);
    const stealDelaySeconds = getStealDelaySeconds(accountId);
    const status = analyzeFriendLands(lands, myGid, name, { plantBlacklist, stealDelaySeconds });

    const actions = [];

    const helpEnabled = !!isAutomationOn('friend_help');
    const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit');
    if (!stopWhenExpLimit) canGetHelpExp = true;
    
    if (helpEnabled && !(stopWhenExpLimit && !canGetHelpExp)) {
        const helpOps = [
            { id: 10005, expIds: [10005, 10003], list: status.needWeed, fn: helpWeed, key: 'weed', name: '草', record: 'helpWeed' },
            { id: 10006, expIds: [10006, 10002], list: status.needBug, fn: helpInsecticide, key: 'bug', name: '虫', record: 'helpBug' },
            { id: 10007, expIds: [10007, 10001], list: status.needWater, fn: helpWater, key: 'water', name: '水', record: 'helpWater' }
        ];

        for (const op of helpOps) {
            const allowByExp = (!stopWhenExpLimit) || (canGetExpByCandidates(op.expIds) && canGetHelpExp);
            if (op.list.length > 0 && allowByExp) {
                const precheck = await checkCanOperateRemote(gid, op.id);
                if (precheck.canOperate) {
                    const count = await runBatchWithFallback(
                        op.list,
                        (ids) => op.fn(gid, ids, stopWhenExpLimit),
                        (ids) => op.fn(gid, ids, stopWhenExpLimit)
                    );
                    if (count > 0) {
                        actions.push(`${op.name}${count}`);
                        totalActions[op.key] += count;
                        recordOperation(op.record, count);
                    }
                }
            }
        }
    }

    if (isAutomationOn('friend_steal') && status.stealable.length > 0) {
        const precheck = await checkCanOperateRemote(gid, 10008);
        if (precheck.canOperate) {
            const canStealNum = precheck.canStealNum > 0 ? precheck.canStealNum : status.stealable.length;
            const targetLands = status.stealable.slice(0, canStealNum);
            
            const ok = await executeSteal(gid, targetLands, status.stealableInfo);
            if (ok > 0) {
                const plantNames = [...new Set(status.stealableInfo.filter(x => targetLands.includes(x.landId)).map(x => x.name))].join('/');
                actions.push(`偷${ok}${plantNames ? `(${plantNames})` : ''}`);
                totalActions.steal += ok;
                recordOperation('steal', ok);
            }
        }
    }

    const autoBad = isAutomationOn('friend_bad');
    if (autoBad) {
        const bugCheck = await checkCanOperateRemote(gid, 10004);
        const weedCheck = await checkCanOperateRemote(gid, 10003);
        
        if (status.canPutBug.length > 0 && bugCheck.canOperate) {
            const remaining = getRemainingTimes(10004);
            const toProcess = status.canPutBug.slice(0, remaining);
            try {
                const ok = await putInsects(gid, toProcess);
                if (ok > 0) { actions.push(`放虫${ok}`); totalActions.putBug += ok; }
            } catch (e) {
                await leaveFriendFarm(gid);
                throw e;
            }
        }
    
        if (status.canPutWeed.length > 0 && weedCheck.canOperate) {
            const remaining = getRemainingTimes(10003);
            const toProcess = status.canPutWeed.slice(0, remaining);
            try {
                const ok = await putWeeds(gid, toProcess);
                if (ok > 0) { actions.push(`放草${ok}`); totalActions.putWeed += ok; }
            } catch (e) {
                await leaveFriendFarm(gid);
                throw e;
            }
        }
    }

    if (actions.length > 0) {
        log('好友', `${name}: ${actions.join('/')}`, {
            module: 'friend', event: '巡查好友完成', result: 'ok', friendName: name, friendGid: gid, actions
        });
    }

    await leaveFriendFarm(gid);
}

// ============ 仅偷菜 ============

async function visitFriendForSteal(friend, totalActions, myGid, accountId) {
    const { gid, name } = friend;

    const enterReply = await enterFriendFarmSafe(gid, name, accountId);
    if (!enterReply) return;

    const lands = enterReply.lands || [];
    if (lands.length === 0) {
        await leaveFriendFarm(gid);
        return;
    }
    if (hasHahaPumpkinInLands(lands)) {
        moveFriendToImportBlacklistByHaha(accountId, gid, name, '偷菜巡查');
        await leaveFriendFarm(gid);
        return;
    }

    const plantBlacklist = getPlantBlacklist(accountId);
    const stealDelaySeconds = getStealDelaySeconds(accountId);
    const status = analyzeFriendLands(lands, myGid, name, { plantBlacklist, stealDelaySeconds });

    const hasStealableBeforeFilter = lands.some(land => {
        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) return false;
        const currentPhase = getCurrentPhase(land.plant.phases, false);
        if (!currentPhase || currentPhase.phase !== PlantPhase.MATURE) return false;
        if (!plant.stealable) return false;
        const stealInfo = plant.steal_player;
        if (!stealInfo || stealInfo.length === 0) return true;
        const mySteal = stealInfo.find(s => toNum(s.gid) === myGid);
        const stealCount = mySteal ? toNum(mySteal.num) : 0;
        const maxSteal = toNum(plant.steal_num, 2);
        return stealCount < maxSteal;
    });

    if (hasStealableBeforeFilter && status.stealable.length === 0) {
        await leaveFriendFarm(gid);
        return;
    }

    const actions = [];

    if (status.stealable.length > 0) {
        const precheck = await checkCanOperateRemote(gid, 10008);
        if (precheck.canOperate) {
            const canStealNum = precheck.canStealNum > 0 ? precheck.canStealNum : status.stealable.length;
            const targetLands = status.stealable.slice(0, canStealNum);

            const ok = await executeSteal(gid, targetLands, status.stealableInfo);
            if (ok > 0) {
                const plantNames = [...new Set(status.stealableInfo.filter(x => targetLands.includes(x.landId)).map(x => x.name))].join('/');
                actions.push(`偷${ok}${plantNames ? `(${plantNames})` : ''}`);
                totalActions.steal += ok;
                recordOperation('steal', ok);
            }
        }
    }

    if (actions.length > 0) {
        log('好友', `${name}: ${actions.join('/')}`, {
            module: 'friend', event: '偷菜好友完成', result: 'ok', friendName: name, friendGid: gid, actions
        });
    }

    await leaveFriendFarm(gid);
}

// ============ 仅帮助 ============

async function visitFriendForHelp(friend, totalActions, myGid, accountId, ignoreExpLimit = false) {
    const { gid, name } = friend;

    const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
    if (!stopWhenExpLimit) canGetHelpExp = true;
    if (stopWhenExpLimit && !canGetHelpExp) return;

    const enterReply = await enterFriendFarmSafe(gid, name, accountId);
    if (!enterReply) return;

    const lands = enterReply.lands || [];
    if (lands.length === 0) {
        await leaveFriendFarm(gid);
        return;
    }
    if (hasHahaPumpkinInLands(lands)) {
        moveFriendToImportBlacklistByHaha(accountId, gid, name, '帮助巡查');
        await leaveFriendFarm(gid);
        return;
    }

    const status = analyzeFriendLands(lands, myGid, name, {});
    const actions = [];

    const helpOps = [
        { id: 10005, expIds: [10005, 10003], list: status.needWeed, fn: helpWeed, key: 'weed', name: '草', record: 'helpWeed' },
        { id: 10006, expIds: [10006, 10002], list: status.needBug, fn: helpInsecticide, key: 'bug', name: '虫', record: 'helpBug' },
        { id: 10007, expIds: [10007, 10001], list: status.needWater, fn: helpWater, key: 'water', name: '水', record: 'helpWater' }
    ];

    for (const op of helpOps) {
        const allowByExp = (!stopWhenExpLimit) || (canGetExpByCandidates(op.expIds) && canGetHelpExp);
        if (op.list.length > 0 && allowByExp) {
            const precheck = await checkCanOperateRemote(gid, op.id);
            if (precheck.canOperate) {
                const count = await runBatchWithFallback(
                    op.list,
                    (ids) => op.fn(gid, ids, stopWhenExpLimit),
                    (ids) => op.fn(gid, ids, stopWhenExpLimit)
                );
                if (count > 0) {
                    actions.push(`${op.name}${count}`);
                    totalActions[op.key] += count;
                    recordOperation(op.record, count);
                }
            }
        }
    }

    if (actions.length > 0) {
        log('好友', `${name}: ${actions.join('/')}`, {
            module: 'friend', event: '帮助好友完成', result: 'ok', friendName: name, friendGid: gid, actions
        });
    }

    log('好友', `${name}: 准备离开农场`, { module: 'friend', event: '准备离开农场', friendName: name, friendGid: gid });
    await leaveFriendFarm(gid);
    log('好友', `${name}: 已离开农场`, { module: 'friend', event: '已离开农场', friendName: name, friendGid: gid });
}

// ============ 好友巡查主循环 ============

async function checkFriends(options = {}) {
    const state = getUserState();
    // 首先检查主开关，如果未开启则直接返回
    if (!isAutomationOn('friend')) return false;

    const helpEnabled = !!isAutomationOn('friend_help');
    const stealEnabled = !!isAutomationOn('friend_steal');
    const badEnabled = !!isAutomationOn('friend_bad');
    
    // 如果指定了只执行特定操作，则覆盖配置
    const onlyHelp = options.onlyHelp || false;
    const onlySteal = options.onlySteal || false;
    const onlyBad = options.onlyBad || false;
    const ignoreExpLimit = options.ignoreExpLimit || false;
    
    const effectiveHelpEnabled = onlyHelp ? true : (onlySteal || onlyBad ? false : helpEnabled);
    const effectiveStealEnabled = onlySteal ? true : (onlyHelp || onlyBad ? false : stealEnabled);
    const effectiveBadEnabled = onlyBad ? true : (onlyHelp || onlySteal ? false : badEnabled);
    
    const hasAnyFriendOp = effectiveHelpEnabled || effectiveStealEnabled || effectiveBadEnabled;
    if (isCheckingFriends || !state.gid || !hasAnyFriendOp) return false;
    if (inFriendQuietHours()) return false;

    isCheckingFriends = true;
    checkDailyReset();

    try {
        const friends = await getFriendsList();
        if (friends.length === 0) {
            log('好友', '没有好友', { module: 'friend', event: '扫描好友', result: 'empty' });
            return false;
        }

        const blacklist = new Set(getFriendBlacklist(state.accountId));

        const stealFriends = [];      // 有可偷的好友
        const helpFriends = [];       // 有需要帮助的好友
        const visitedGids = new Set();

        // 第一阶段：扫描所有好友，分类整理
        for (const f of friends) {
            const gid = toNum(f.gid);
            if (gid === state.gid) continue;
            if (visitedGids.has(gid)) continue;
            if (blacklist.has(gid)) continue;

            const name = f.remark || f.name || `GID:${gid}`;
            const p = f.plant;
            const stealNum = p ? toNum(p.stealNum || p.steal_plant_num) : 0;
            const dryNum = p ? toNum(p.dryNum || p.dry_num) : 0;
            const weedNum = p ? toNum(p.weedNum || p.weed_num) : 0;
            const insectNum = p ? toNum(p.insectNum || p.insect_num) : 0;

            if (effectiveStealEnabled && (stealNum > 0 || !p)) {
                stealFriends.push({ gid, name, stealNum: stealNum > 0 ? stealNum : 1 });
            }

            if (effectiveHelpEnabled && ((dryNum > 0 || weedNum > 0 || insectNum > 0) || !p)) {
                helpFriends.push({
                    gid,
                    name,
                    dryNum: dryNum > 0 ? dryNum : 1,
                    weedNum: weedNum > 0 ? weedNum : 1,
                    insectNum: insectNum > 0 ? insectNum : 1,
                });
            }

            visitedGids.add(gid);
        }

        // 排序：偷菜多的优先
        stealFriends.sort((a, b) => b.stealNum - a.stealNum);
        // 排序：帮助需求多的优先
        helpFriends.sort((a, b) => {
            const helpA = a.dryNum + a.weedNum + a.insectNum;
            const helpB = b.dryNum + b.weedNum + b.insectNum;
            return helpB - helpA;
        });

        const totalActions = { steal: 0, water: 0, weed: 0, bug: 0 };

        // 第二阶段：批量偷菜
        if (stealFriends.length > 0 && effectiveStealEnabled) {
            for (const friend of stealFriends) {
                if (!canOperate(10008)) break; // 偷菜次数用完

                try {
                    await visitFriendForSteal(friend, totalActions, state.gid, state.accountId);
                } catch {
                    // 单个好友失败不影响整体
                }
                await sleep(200);
            }
        }

        // 偷菜后自动出售
        if (totalActions.steal > 0) {
            try {
                await sellAllFruits();
            } catch {
                // ignore
            }
        }

        // 第三阶段：批量帮助
        if (helpFriends.length > 0 && effectiveHelpEnabled) {
            log('好友', `开始批量帮助，共 ${helpFriends.length} 个好友需要帮助`, {
                module: 'friend', event: '开始批量帮助', count: helpFriends.length
            });

            for (let i = 0; i < helpFriends.length; i++) {
                const friend = helpFriends[i];
                log('好友', `批量帮助第 ${i + 1}/${helpFriends.length} 个好友: ${friend.name}`, { module: 'friend', event: '批量帮助开始', index: i + 1, total: helpFriends.length, friendName: friend.name });

                // 检查是否还能获得帮助经验
                const stopWhenExpLimit = !!isAutomationOn('friend_help_exp_limit') && !ignoreExpLimit;
                if (stopWhenExpLimit && !canGetHelpExp) {
                    log('好友', `批量帮助中断：经验已达上限`, { module: 'friend', event: '批量帮助中断', reason: 'exp_limit' });
                    break;
                }

                try {
                    await visitFriendForHelp(friend, totalActions, state.gid, state.accountId, ignoreExpLimit);
                    log('好友', `批量帮助第 ${i + 1} 个好友完成: ${friend.name}`, { module: 'friend', event: '批量帮助完成', index: i + 1, friendName: friend.name });
                } catch (e) {
                    log('好友', `批量帮助第 ${i + 1} 个好友失败: ${friend.name}, 错误: ${e.message}`, { module: 'friend', event: '批量帮助失败', index: i + 1, friendName: friend.name, error: e.message });
                }
                await sleep(200);
            }
            log('好友', '批量帮助循环结束', { module: 'friend', event: '批量帮助结束' });
        }

        // 生成总结日志
        const summary = [];
        if (totalActions.steal > 0) summary.push(`偷${totalActions.steal}`);
        if (totalActions.weed > 0) summary.push(`除草${totalActions.weed}`);
        if (totalActions.bug > 0) summary.push(`除虫${totalActions.bug}`);
        if (totalActions.water > 0) summary.push(`浇水${totalActions.water}`);

        const totalVisited = stealFriends.length + helpFriends.length;
        if (summary.length > 0) {
            log('好友', `巡查完成 → ${summary.join('/')}`, {
                module: 'friend', event: '好友巡查循环', result: 'ok', visited: totalVisited, summary
            });
        }
        return summary.length > 0;

    } catch (err) {
        logWarn('好友', `巡查异常: ${err.message}`);
        return false;
    } finally {
        isCheckingFriends = false;
    }
}

/**
 * 批量好友操作（一键帮助/一键偷取/一键捣乱）
 * @param {string} opType - 操作类型: 'help' | 'steal' | 'bad'
 */
async function doBatchFriendOp(opType) {
    const state = getUserState();
    if (!state.gid) {
        return { ok: false, error: '未登录' };
    }

    const validTypes = ['help', 'steal', 'bad'];
    if (!validTypes.includes(opType)) {
        return { ok: false, error: `无效的操作类型: ${opType}` };
    }

    const typeLabels = { help: '帮助', steal: '偷取', bad: '捣乱' };
    log('好友', `开始一键${typeLabels[opType]}`, { module: 'friend', event: `一键${typeLabels[opType]}开始`, opType });

    try {
        if (opType === 'bad') {
            // 捣乱操作使用单独的逻辑
            badExecutedOnStartup = false; // 重置标记允许再次执行
            await runBadOnceOnStartup();
            return { ok: true };
        } else {
            const result = await checkFriends({
                onlyHelp: opType === 'help',
                onlySteal: opType === 'steal',
                ignoreExpLimit: opType === 'help',
            });
            return { ok: true, result };
        }
    } catch (e) {
        logWarn('好友', `一键${typeLabels[opType]}失败: ${e.message}`);
        return { ok: false, error: e.message };
    }
}

/**
 * 好友巡查循环 - 本次完成后等待指定秒数再开始下次
 */
async function friendCheckLoop() {
    if (externalSchedulerMode) return;
    if (!friendLoopRunning) return;
    await checkFriends();
    if (!friendLoopRunning) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, CONFIG.friendCheckInterval), () => friendCheckLoop());
}

/**
 * 蹲守任务扫描循环
 */
async function stakeoutCheckLoop() {
    if (externalSchedulerMode) return;
    if (!friendLoopRunning) return;

    const state = getUserState();
    if (state.gid) {
        const config = getStakeoutStealConfig(state.accountId);
        if (config.enabled) {
            try {
                await syncStakeoutTasks();
            } catch (e) {
                logWarn('蹲守', `扫描任务失败: ${e.message}`);
            }
        }
    }

    if (!friendLoopRunning) return;
    // 每30秒扫描一次蹲守任务
    friendScheduler.setTimeoutTask('stakeout_check_loop', 30000, () => stakeoutCheckLoop());
}

function startFriendCheckLoop(options = {}) {
    if (friendLoopRunning) return;
    externalSchedulerMode = !!options.externalScheduler;
    friendLoopRunning = true;

    // 注册操作限制更新回调，从农场检查中获取限制信息
    setOperationLimitsCallback(updateOperationLimits);

    // 监听好友申请推送 (微信同玩)
    networkEvents.on('friendApplicationReceived', onFriendApplicationReceived);

    if (!externalSchedulerMode) {
        // 延迟 5 秒后启动循环，等待登录和首次农场检查完成
        friendScheduler.setTimeoutTask('friend_check_loop', 5000, () => friendCheckLoop());
        // 延迟 10 秒后启动蹲守扫描循环
        friendScheduler.setTimeoutTask('stakeout_check_loop', 10000, () => stakeoutCheckLoop());
    }

    // 启动时检查一次待处理的好友申请
    friendScheduler.setTimeoutTask('friend_check_bootstrap_applications', 3000, () => checkAndAcceptApplications());
}

function stopFriendCheckLoop() {
    friendLoopRunning = false;
    externalSchedulerMode = false;
    networkEvents.off('friendApplicationReceived', onFriendApplicationReceived);
    friendScheduler.clearAll();
}

function refreshFriendCheckLoop(delayMs = 200) {
    if (!friendLoopRunning || externalSchedulerMode) return;
    friendScheduler.setTimeoutTask('friend_check_loop', Math.max(0, delayMs), () => friendCheckLoop());
}

// ============ 自动同意好友申请 (微信同玩) ============

/**
 * 处理服务器推送的好友申请
 */
function onFriendApplicationReceived(applications) {
    const names = applications.map(a => a.name || `GID:${toNum(a.gid)}`).join(', ');
    log('申请', `收到 ${applications.length} 个好友申请: ${names}`);

    // 自动同意
    const gids = applications.map(a => toNum(a.gid));
    acceptFriendsWithRetry(gids);
}

/**
 * 检查并同意所有待处理的好友申请
 */
async function checkAndAcceptApplications() {
    try {
        const reply = await getApplications();
        const applications = reply.applications || [];
        if (applications.length === 0) return;

        const names = applications.map(a => a.name || `GID:${toNum(a.gid)}`).join(', ');
        log('申请', `发现 ${applications.length} 个待处理申请: ${names}`);

        const gids = applications.map(a => toNum(a.gid));
        await acceptFriendsWithRetry(gids);
    } catch {
        // 静默失败，可能是 QQ 平台不支持
    }
}

/**
 * 同意好友申请 (带重试)
 */
async function acceptFriendsWithRetry(gids) {
    if (gids.length === 0) return;
    try {
        const reply = await acceptFriends(gids);
        const friends = reply.friends || [];
        if (friends.length > 0) {
            const names = friends.map(f => f.name || f.remark || `GID:${toNum(f.gid)}`).join(', ');
            log('申请', `已同意 ${friends.length} 人: ${names}`);
        }
    } catch (e) {
        logWarn('申请', `同意失败: ${e.message}`);
    }
}

// ============ 启动时执行一次放虫放草 ============

let badExecutedOnStartup = false;

async function runBadOnceOnStartup() {
    if (badExecutedOnStartup) {
        return;
    }

    const autoBadEnabled = isAutomationOn('friend_bad');
    if (!autoBadEnabled) {
        return;
    }

    const state = getUserState();
    if (!state.gid) {
        log('好友', '用户未登录，无法执行放虫放草', { module: 'friend', event: '放虫放草未登录' });
        return;
    }

    log('好友', '========== 启动时放虫放草开始 ==========', { module: 'friend', event: '启动放虫放草开始' });

    try {
        const friends = await getFriendsList();
        if (friends.length === 0) {
            log('好友', '没有好友，放虫放草结束', { module: 'friend', event: '放虫放草无好友' });
            return;
        }

        const blacklist = new Set(getFriendBlacklist());
        const badFriends = [];
        const visitedGids = new Set();
        const skipStats = { self: 0, duplicate: 0, blacklist: 0 };

        for (const f of friends) {
            const gid = toNum(f.gid);
            if (gid === state.gid) { skipStats.self++; continue; }
            if (visitedGids.has(gid)) { skipStats.duplicate++; continue; }
            if (blacklist.has(gid)) { skipStats.blacklist++; continue; }

            const name = f.name || `GID:${gid}`;
            badFriends.push({ gid, name });

            visitedGids.add(gid);
        }

        log('好友', `放虫放草好友列表共 ${friends.length} 人，过滤后 ${badFriends.length} 人，按好友列表默认顺序依次处理`, { module: 'friend', event: '放虫放草好友列表', totalCount: friends.length, validCount: badFriends.length, skippedSelf: skipStats.self, skippedDuplicate: skipStats.duplicate, skippedBlacklist: skipStats.blacklist });

        const totalActions = { steal: 0, water: 0, weed: 0, bug: 0, putBug: 0, putWeed: 0 };
        let processedCount = 0;

        for (let i = 0; i < badFriends.length; i++) {
            const friend = badFriends[i];

            const canPutBug = canOperate(10004);
            const canPutWeed = canOperate(10003);
            if (!canPutBug && !canPutWeed) {
                log('好友', `放虫放草次数已用完，停止执行。已处理 ${processedCount} 个好友`, { module: 'friend', event: '放虫放草次数用完', processedCount });
                break;
            }

            log('好友', `启动时放虫放草 ${i + 1}/${badFriends.length}: ${friend.name}`, { module: 'friend', event: '放虫放草处理好友', index: i + 1, total: badFriends.length, friendName: friend.name });

            try {
                const beforeExp = toNum((getUserState() || {}).exp);
                const beforeBadCount = totalActions.putBug + totalActions.putWeed;
                await visitFriend(friend, totalActions, state.gid, state.accountId);
                processedCount++;
                const afterBadCount = totalActions.putBug + totalActions.putWeed;
                if (afterBadCount > beforeBadCount) {
                    await sleep(200);
                    const afterExp = toNum((getUserState() || {}).exp);
                    if (afterExp <= beforeExp) {
                        log('好友', `放虫放草经验未增长，立即停止后续处理。已处理 ${processedCount} 个好友`, { module: 'friend', event: '放虫放草经验停止', processedCount, beforeExp, afterExp });
                        break;
                    }
                }
            } catch (e) {
                if (e.code === 'LIMIT_REACHED' || (e.message && e.message.includes('LIMIT_REACHED'))) {
                    log('好友', `放虫放草次数已达上限，停止后续处理。已处理 ${processedCount} 个好友`, { module: 'friend', event: '放虫放草次数上限停止', processedCount });
                    break;
                }
                log('好友', `放虫放草失败: ${friend.name}, 错误: ${e.message}`, { module: 'friend', event: '放虫放草失败', friendName: friend.name, error: e.message });
            }

            await sleep(500);
        }

        badExecutedOnStartup = true;

        const summary = [];
        if (totalActions.putBug > 0) summary.push(`放虫${totalActions.putBug}`);
        if (totalActions.putWeed > 0) summary.push(`放草${totalActions.putWeed}`);

        log('好友', `========== 启动时放虫放草结束 ========== 处理${processedCount}人${summary.length > 0 ? ` → ${  summary.join('/')}` : ''}`, { module: 'friend', event: '启动放虫放草结束', processedCount, summary });

    } catch (err) {
        logWarn('好友', `启动时放虫放草异常: ${err.message}`);
    }
}

// 检查帮助经验是否已达上限（用于外部判断是否需要执行帮助巡查）
function isHelpExpLimitReached() {
    return helpAutoDisabledByLimit;
}

// ============ 蹲守偷菜功能 ============

/**
 * 生成蹲守任务ID
 */
function getStakeoutTaskId() {
    stakeoutTaskIdCounter++;
    return `stakeout_steal_${stakeoutTaskIdCounter}`;
}

/**
 * 分析好友土地，找出即将成熟的作物
 * @returns {Array<{landId, matureTime, plantId, plantName}>} 即将成熟的地块列表
 */
function analyzeUpcomingMatures(lands, maxAheadSec) {
    const nowSec = getServerTimeSec();
    const upcoming = [];

    for (const land of lands) {
        const landId = toNum(land.id);
        if (!landId || !land.unlocked) continue;

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) continue;

        const currentPhase = getCurrentPhase(plant.phases);
        if (!currentPhase) continue;
        if (currentPhase.phase === PlantPhase.DEAD) continue;
        if (currentPhase.phase === PlantPhase.MATURE) continue;

        // 查找成熟阶段
        const maturePhase = plant.phases.find(p => toNum(p.phase) === PlantPhase.MATURE);
        if (!maturePhase) continue;

        const matureBeginTime = toTimeSec(maturePhase.begin_time);
        if (matureBeginTime <= 0) continue;

        const timeToMature = matureBeginTime - nowSec;

        // 只处理在蹲守时间窗口内的作物
        if (timeToMature > 0 && timeToMature <= maxAheadSec) {
            const plantId = toNum(plant.id);
            const plantName = getPlantName(plantId) || plant.name || '未知';
            upcoming.push({
                landId,
                matureTime: matureBeginTime,
                plantId,
                plantName,
                waitSeconds: timeToMature,
            });
        }
    }

    return upcoming.sort((a, b) => a.matureTime - b.matureTime);
}

/**
 * 执行蹲守偷菜任务
 */
async function executeStakeoutSteal(friendGid, friendName, landIds, delaySec, taskKey) {
    const state = getUserState();
    if (!state.gid) return 0;

    // 紧急请求选项
    const urgentOptions = { bypassRateLimit: true, priority: 10 };

    // 检查是否处于静默时段
    if (inFriendQuietHours()) {
        log('蹲守', `${friendName}: 当前处于静默时段，已跳过本次蹲守`, {
            module: 'friend',
            event: 'stakeout_skipped_by_quiet',
            friendName,
            friendGid,
            landIds,
        });
        return 0;
    }

    // 检查是否还能偷菜
    if (!canOperate(10008)) {
        log('蹲守', `${friendName} 今日偷菜次数已用完，取消蹲守`, { module: 'friend', event: '蹲守取消', reason: 'limit_reached' });
        return 0;
    }

    log('蹲守', `触发 ${friendName}: 准备进入农场抢收 ${landIds.length} 块地`, {
        module: 'friend', event: 'stakeout_trigger',
        friendName, friendGid, landIds,
    });

    let stolenCount = 0;
    try {
        // 进入好友农场 (使用紧急请求)
        let enterReply = await enterFriendFarm(friendGid, urgentOptions);
        let lands = enterReply.lands || [];

        // 重新分析可偷地块
        const plantBlacklist = getPlantBlacklist(state.accountId);
        let status = analyzeFriendLands(lands, state.gid, friendName, { plantBlacklist });

        // 确定最终目标：优先偷目标地块中已成熟的，同时也带走其他已成熟的
        const targetSet = new Set(landIds);
        const stealNow = status.stealable.filter(id => targetSet.has(id));
        const bonusSteal = status.stealable.filter(id => !targetSet.has(id));
        let allSteal = [...stealNow, ...bonusSteal];

        // 如果尚未成熟，等待延迟后再检查一次
        if (allSteal.length === 0 && delaySec > 0) {
            log('蹲守', `${friendName}: 目标尚未成熟，等待 ${delaySec} 秒后重试...`, {
                module: 'friend', event: 'stakeout_wait',
                friendName, friendGid, delaySec,
            });
            await sleep(delaySec * 1000);

            try { await leaveFriendFarm(friendGid, urgentOptions); } catch { /* ignore */ }
            try {
                enterReply = await enterFriendFarm(friendGid, urgentOptions);
                lands = enterReply.lands || [];
                status = analyzeFriendLands(lands, state.gid, friendName, { plantBlacklist });
                if (status.stealable.length > 0) {
                    allSteal = status.stealable;
                }
            } catch (reEnterErr) {
                logWarn('蹲守', `重新进入 ${friendName} 农场失败: ${reEnterErr.message}`);
                return 0;
            }
        }

        if (allSteal.length > 0) {
            const precheck = await checkCanOperateRemote(friendGid, 10008, urgentOptions);
            if (precheck.canOperate) {
                const canStealNum = precheck.canStealNum > 0 ? precheck.canStealNum : allSteal.length;
                const finalTargets = allSteal.slice(0, canStealNum);

                stolenCount = await executeSteal(friendGid, finalTargets, status.stealableInfo, urgentOptions);
                if (stolenCount > 0) {
                    const plantNames = [...new Set(status.stealableInfo
                        .filter(x => finalTargets.includes(x.landId))
                        .map(x => x.name))].join('/');
                    log('蹲守', `✅ ${friendName}: 成功偷取 ${stolenCount} 块${plantNames ? `(${plantNames})` : ''}`, {
                        module: 'friend',
                        event: 'stakeout_steal_success',
                        friendName,
                        friendGid,
                        count: stolenCount,
                        plantNames,
                    });
                    recordOperation('steal', stolenCount);

                    // 偷菜后自动出售
                    try {
                        await sellAllFruits();
                    } catch {
                        // ignore
                    }
                }
            }
        } else {
            log('蹲守', `${friendName}: 无可偷地块，可能已被抢先或尚未成熟`, {
                module: 'friend', event: 'stakeout_miss',
                friendName, friendGid,
            });
        }

        await leaveFriendFarm(friendGid, urgentOptions);
    } catch (e) {
        logWarn('蹲守', `${friendName} 蹲守偷菜失败: ${e.message}`);
    } finally {
        // 从活跃蹲守集合中移除
        activeStakeoutTaskKeys.delete(taskKey);
        stakeoutTasks.delete(taskKey);
    }

    return stolenCount;
}

/**
 * 安排蹲守任务
 */
async function scheduleStakeout(friend, upcomingMatures, config) {
    const { gid, name } = friend;

    if (upcomingMatures.length === 0) return;
    
    // 1. 分组逻辑: 将成熟时间相近的（如10秒内）归为一组
    const groups = [];
    let currentGroup = [upcomingMatures[0]];
    for (let i = 1; i < upcomingMatures.length; i++) {
        const diff = upcomingMatures[i].matureTime - currentGroup[0].matureTime;
        if (diff <= 10) {
            currentGroup.push(upcomingMatures[i]);
        } else {
            groups.push(currentGroup);
            currentGroup = [upcomingMatures[i]];
        }
    }
    groups.push(currentGroup);

    // 2. 为每组建立定时任务
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const landIds = group.map(m => m.landId);
        const earliestMatureTime = group[0].matureTime;
        const nowSec = getServerTimeSec();
        
        // 这里的 taskKey 结合了 gid 和地块标识，确保唯一性
        const taskKey = `stake_${gid}_${landIds.join('_')}`;
        
        // 如果该组已经预约，则跳过
        if (activeStakeoutTaskKeys.has(taskKey)) continue;

        // 提前 3 秒进入农场，下限 1 秒，并考虑用户设置的延迟秒数
        const delaySec = config.delaySec || 0;
        const waitTimeMs = Math.max(1000, (earliestMatureTime - nowSec - 3) * 1000);
        
        const taskId = getStakeoutTaskId();

        log('蹲守', `预约 ${name}: ${group.map(m => m.plantName).join('/')} ×${landIds.length}块, 约 ${Math.round((earliestMatureTime - nowSec) / 60)} 分钟后执行`, {
            module: 'friend', event: 'stakeout_schedule',
            friendName: name, friendGid: gid, landIds, waitSeconds: Math.round(waitTimeMs / 1000), delaySec,
        });

        activeStakeoutTaskKeys.add(taskKey);

        friendScheduler.setTimeoutTask(taskId, waitTimeMs, async () => {
            await executeStakeoutSteal(gid, name, landIds, delaySec, taskKey);
        });

        stakeoutTasks.set(taskKey, {
            taskId,
            matureTime: earliestMatureTime,
            landIds,
            friendName: name,
            allMatures: group,
        });
    }
}

/**
 * 同步蹲守任务
 * 扫描好友列表，为即将成熟的作物创建蹲守任务
 */
async function syncStakeoutTasks() {
    const state = getUserState();
    if (!state.gid) return;

    const config = getStakeoutStealConfig(state.accountId);
    if (!config.enabled) {
        // 如果蹲守被禁用，清除所有待执行任务
        if (stakeoutTasks.size > 0) {
            for (const [taskKey, taskInfo] of stakeoutTasks) {
                friendScheduler.clear(taskInfo.taskId);
            }
            stakeoutTasks.clear();
            activeStakeoutTaskKeys.clear();
        }
        return;
    }

    try {
        const friendsReply = await getAllFriends();
        const friends = friendsReply.game_friends || friendsReply.friends || [];
        if (friends.length === 0) return;

        const blacklist = new Set(getFriendBlacklist());
        const importBlacklist = new Set(getImportBlacklist(state.accountId));
        const stakeoutFriendList = config.friendList || [];

        // 清理已不应继续蹲守的任务
        for (const [taskKey, taskInfo] of stakeoutTasks) {
            const gid = toNum(taskKey.split('_')[1]);
            if (
                blacklist.has(gid)
                || importBlacklist.has(gid)
                || (stakeoutFriendList.length > 0 && !stakeoutFriendList.includes(gid))
            ) {
                friendScheduler.clear(taskInfo.taskId);
                stakeoutTasks.delete(taskKey);
                activeStakeoutTaskKeys.delete(taskKey);
            }
        }

        for (const f of friends) {
            const gid = toNum(f.gid);
            if (gid === state.gid) continue;
            if (blacklist.has(gid)) continue;
            if (importBlacklist.has(gid)) continue;

            // 如果指定了蹲守好友列表，只蹲守列表中的好友
            if (stakeoutFriendList.length > 0 && !stakeoutFriendList.includes(gid)) continue;

            const name = f.remark || f.name || `GID:${gid}`;

            try {
                // 进入好友农场获取详细信息
                const enterReply = await enterFriendFarm(gid);
                const lands = enterReply.lands || [];
                if (hasHahaPumpkinInLands(lands)) {
                    moveFriendToImportBlacklistByHaha(state.accountId, gid, name, '蹲守扫描');
                    await leaveFriendFarm(gid);
                    await sleep(200);
                    continue;
                }

                // 分析即将成熟的作物
                const upcomingMatures = analyzeUpcomingMatures(lands, config.maxAheadSec);

                if (upcomingMatures.length > 0) {
                    await scheduleStakeout({ gid, name }, upcomingMatures, config);
                }

                await leaveFriendFarm(gid);

                // 每次扫描间隔，避免请求过快
                await sleep(200);
            } catch (e) {
                // 单个好友失败不影响整体
                logWarn('蹲守', `扫描好友 ${name} 失败: ${e.message}`);
            }
        }
    } catch (e) {
        logWarn('蹲守', `同步蹲守任务失败: ${e.message}`);
    }
}

/**
 * 获取当前活跃的蹲守任务列表
 */
function getActiveStakeouts() {
    const tasks = [];
    const nowSec = getServerTimeSec();
    for (const [taskKey, taskInfo] of stakeoutTasks) {
        tasks.push({
            taskKey,
            friendGid: toNum(taskKey.split('_')[1]),
            friendName: taskInfo.friendName,
            matureTime: taskInfo.matureTime,
            waitSeconds: Math.max(0, taskInfo.matureTime - nowSec),
            landCount: taskInfo.landIds.length,
        });
    }
    return tasks.sort((a, b) => a.matureTime - b.matureTime);
}

/**
 * 清除所有蹲守任务
 */
function clearAllStakeouts() {
    for (const [, taskInfo] of stakeoutTasks) {
        friendScheduler.clear(taskInfo.taskId);
    }
    stakeoutTasks.clear();
    activeStakeoutTaskKeys.clear();
    log('蹲守', '已清除所有蹲守任务', { module: 'friend', event: '蹲守清除' });
}

/**
 * 添加好友到蹲守列表
 */
function addStakeoutFriend(accountId, friendGid) {
    const config = getStakeoutStealConfig(accountId);
    const currentList = config.friendList || [];
    if (!currentList.includes(friendGid)) {
        currentList.push(friendGid);
        setStakeoutFriendList(accountId, currentList);
        return true;
    }
    return false;
}

/**
 * 从蹲守列表移除好友
 */
function removeStakeoutFriend(accountId, friendGid) {
    const config = getStakeoutStealConfig(accountId);
    const currentList = config.friendList || [];
    const index = currentList.indexOf(friendGid);
    if (index > -1) {
        currentList.splice(index, 1);
        setStakeoutFriendList(accountId, currentList);
        return true;
    }
    return false;
}

async function addManualFriend(gid) {
    try {
        const state = getUserState();
        let visitors = getVisitors(state.accountId);
        const visitorBlacklist = getVisitorBlacklist(state.accountId);

        const enterReply = await enterFriendFarm(gid);
        const lands = enterReply && enterReply.lands ? enterReply.lands : [];
        if (hasHahaPumpkinInLands(lands)) {
            moveFriendToImportBlacklistByHaha(state.accountId, gid, `GID:${gid}`, '手动添加校验');
            await leaveFriendFarm(gid);
            return { ok: false, error: '检测到哈哈南瓜，已自动移除并加入导入黑名单' };
        }
        if (enterReply && enterReply.lands && enterReply.lands.length > 0) {
            const profileFriends = await fetchFriendProfilesByGids([gid]);
            let profileName = '';
            let profileAvatarUrl = '';
            if (Array.isArray(profileFriends) && profileFriends[0]) {
                const pf = profileFriends[0];
                profileName = String(pf.remark || pf.name || '').trim();
                profileAvatarUrl = String(pf.avatar_url || '').trim();
            }
            const existingIndex = visitors.findIndex(v => v.gid === gid);
            if (existingIndex === -1) {
                const updatedVisitors = [...visitors, {
                    gid,
                    name: profileName || `GID:${gid}`,
                    avatarUrl: profileAvatarUrl || '',
                    lastSeen: Date.now(),
                }];
                setVisitors(state.accountId, updatedVisitors);
                visitors = updatedVisitors;
            } else {
                const updatedVisitors = [...visitors];
                const current = updatedVisitors[existingIndex] || {};
                const currentName = String(current.name || '').trim();
                const shouldOverrideName = !currentName || /^GID:\d+$/i.test(currentName);
                updatedVisitors[existingIndex] = {
                    ...current,
                    name: (profileName && shouldOverrideName) ? profileName : currentName,
                    avatarUrl: profileAvatarUrl || String(current.avatarUrl || ''),
                    lastSeen: Date.now(),
                };
                setVisitors(state.accountId, updatedVisitors);
                visitors = updatedVisitors;
            }

            const blacklistIndex = visitorBlacklist.indexOf(gid);
            if (blacklistIndex !== -1) {
                visitorBlacklist.splice(blacklistIndex, 1);
                setVisitorBlacklist(state.accountId, visitorBlacklist);
            }

            await leaveFriendFarm(gid);
            return { ok: true, message: existingIndex === -1 ? '添加成功' : '重新检测成功，该GID有效' };
        }

        if (!visitorBlacklist.includes(gid)) {
            visitorBlacklist.push(gid);
            setVisitorBlacklist(state.accountId, visitorBlacklist);
        }

        const existingIndex = visitors.findIndex(v => v.gid === gid);
        if (existingIndex !== -1) {
            const updatedVisitors = [...visitors];
            updatedVisitors.splice(existingIndex, 1);
            setVisitors(state.accountId, updatedVisitors);
        }

        await leaveFriendFarm(gid);
        return { ok: false, error: '无法获取土地数据' };
    } catch (e) {
        try {
            await leaveFriendFarm(gid);
        } catch {}
        return { ok: false, error: e.message };
    }
}

// 批量添加好友（不验证，直接添加）
async function addManualFriends(gids) {
    const state = getUserState();
    return await upsertVisitorsByGids(state.accountId, gids);
}

module.exports = {
    checkFriends, startFriendCheckLoop, stopFriendCheckLoop,
    refreshFriendCheckLoop,
    checkAndAcceptApplications,
    runBadOnceOnStartup,
    isHelpExpLimitReached,
    getOperationLimits,
    getFriendsList,
    getFriendLandsDetail,
    doFriendOperation,
    doBatchFriendOp,
    addManualFriend,
    addManualFriends,
    addManualFriendsByHex,
    // 蹲守偷菜功能导出
    syncStakeoutTasks,
    getActiveStakeouts,
    clearAllStakeouts,
    addStakeoutFriend,
    removeStakeoutFriend,
};
