/**
 * 自己的农场操作 - 收获/浇水/除草/除虫/铲除/种植/商店/巡田
 */

const protobuf = require('protobufjs');
const { CONFIG, PlantPhase, PHASE_NAMES } = require('../config/config');
const { getPlantNameBySeedId, getPlantName, getPlantExp, formatGrowTime, getPlantGrowTime, getAllSeeds, getPlantById, getPlantBySeedId, getSeedImageBySeedId } = require('../config/gameConfig');
const { isAutomationOn, getPreferredSeed, getAutomation, getPlantingStrategy, getPlantDelaySeconds, getFertilizeLandLevel, getFastHarvestConfig } = require('../models/store');
const { sendMsgAsync, getUserState, networkEvents, getWsErrorState } = require('../utils/network');
const { types } = require('../utils/proto');
const { toLong, toNum, getServerTimeSec, toTimeSec, log, logWarn, sleep } = require('../utils/utils');
const { getPlantRankings } = require('./analytics');
const { createScheduler } = require('./scheduler');
const { recordOperation } = require('./stats');
const { getDataFile, ensureDataDir } = require('../config/runtime-paths');
const { readJsonFile, writeJsonFileAtomic } = require('./json-db');

// ============ 内部状态 ============
let isCheckingFarm = false;
let isFirstFarmCheck = true;
let farmLoopRunning = false;
let externalSchedulerMode = false;
const farmScheduler = createScheduler('farm');

// ============ 秒收取状态 ============
// 存储即将成熟的作物定时任务: Map<landId, { taskId, matureTime, timeoutId }>
const fastHarvestTasks = new Map();
// 秒收取时间窗口（秒）：在此时间范围内的作物才会被秒收
// 注意：这个时间应该大于 advanceMs，否则提前收获不会生效
const FAST_HARVEST_WINDOW_SEC = 300; // 5分钟窗口，给 advanceMs 足够空间
// 秒收取任务ID计数器
let fastHarvestTaskIdCounter = 0;

// 每日收获状态
let lastHarvestDate = '';
let dailyHarvestCount = 0;
const RADISH_TARGET_COUNT = 600;

function getHarvestAccountId() {
    const state = getUserState();
    return String(state.accountId || 'default');
}

function getDailyHarvestFile() {
    return getDataFile('daily_harvest.json');
}

function getBeijingDateKey() {
    const nowSec = getServerTimeSec();
    const nowMs = nowSec > 0 ? nowSec * 1000 : Date.now();
    const bjOffset = 8 * 3600 * 1000;
    const bjDate = new Date(nowMs + bjOffset);
    const y = bjDate.getUTCFullYear();
    const m = String(bjDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(bjDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function loadDailyHarvestState() {
    const file = getDailyHarvestFile();
    const allData = readJsonFile(file, () => ({}));
    const accountId = getHarvestAccountId();
    const today = getBeijingDateKey();

    const accountData = allData[accountId] || { date: '', count: 0 };

    if (accountData.date === today) {
        dailyHarvestCount = Number(accountData.count) || 0;
        lastHarvestDate = today;
    } else {
        dailyHarvestCount = 0;
        lastHarvestDate = today;
    }
    return dailyHarvestCount;
}

function saveDailyHarvestState() {
    const file = getDailyHarvestFile();
    ensureDataDir();
    const allData = readJsonFile(file, () => ({}));
    const accountId = getHarvestAccountId();
    
    allData[accountId] = {
        date: lastHarvestDate,
        count: dailyHarvestCount
    };
    
    writeJsonFileAtomic(file, allData);
}

function addHarvestCount(count) {
    const today = getBeijingDateKey();
    if (lastHarvestDate !== today) {
        lastHarvestDate = today;
        dailyHarvestCount = 0;
    }
    dailyHarvestCount += count;
    saveDailyHarvestState();
}

function getDailyHarvestCount() {
    const today = getBeijingDateKey();
    if (lastHarvestDate !== today) {
        loadDailyHarvestState();
    }
    return dailyHarvestCount;
}

// ============ 农场 API ============

// 操作限制更新回调 (由 friend.js 设置)
let onOperationLimitsUpdate = null;
function setOperationLimitsCallback(callback) {
    onOperationLimitsUpdate = callback;
}

/**
 * 通用植物操作请求
 */
async function sendPlantRequest(RequestType, ReplyType, method, landIds, hostGid) {
    const body = RequestType.encode(RequestType.create({
        land_ids: landIds,
        host_gid: toLong(hostGid),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', method, body);
    return ReplyType.decode(replyBody);
}

async function getAllLands() {
    const body = types.AllLandsRequest.encode(types.AllLandsRequest.create({})).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'AllLands', body);
    const reply = types.AllLandsReply.decode(replyBody);
    // 更新操作限制
    if (reply.operation_limits && onOperationLimitsUpdate) {
        onOperationLimitsUpdate(reply.operation_limits);
    }
    return reply;
}

async function harvest(landIds) {
    const state = getUserState();
    const body = types.HarvestRequest.encode(types.HarvestRequest.create({
        land_ids: landIds,
        host_gid: toLong(state.gid),
        is_all: true,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Harvest', body);
    return types.HarvestReply.decode(replyBody);
}

async function waterLand(landIds) {
    const state = getUserState();
    return sendPlantRequest(types.WaterLandRequest, types.WaterLandReply, 'WaterLand', landIds, state.gid);
}

async function weedOut(landIds) {
    const state = getUserState();
    return sendPlantRequest(types.WeedOutRequest, types.WeedOutReply, 'WeedOut', landIds, state.gid);
}

async function insecticide(landIds) {
    const state = getUserState();
    return sendPlantRequest(types.InsecticideRequest, types.InsecticideReply, 'Insecticide', landIds, state.gid);
}

// 普通肥料 ID
const NORMAL_FERTILIZER_ID = 1011;
// 有机肥料 ID
const ORGANIC_FERTILIZER_ID = 1012;

/**
 * 施肥 - 必须逐块进行，服务器不支持批量
 * 游戏中拖动施肥间隔很短，这里用 50ms
 */
async function fertilize(landIds, fertilizerId = NORMAL_FERTILIZER_ID) {
    let successCount = 0;
    for (const landId of landIds) {
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(fertilizerId),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        } catch {
            // 施肥失败（可能肥料不足），停止继续
            break;
        }
        if (landIds.length > 1) await sleep(50);  // 50ms 间隔
    }
    return successCount;
}

/**
 * 有机肥循环施肥:
 * 按地块顺序 1-2-3-...-1 持续施肥，直到出现失败即停止。
 */
async function fertilizeOrganicLoop(landIds) {
    const ids = (Array.isArray(landIds) ? landIds : []).filter(Boolean);
    if (ids.length === 0) return 0;

    let successCount = 0;
    let idx = 0;

    while (true) {
        const landId = ids[idx];
        try {
            const body = types.FertilizeRequest.encode(types.FertilizeRequest.create({
                land_ids: [toLong(landId)],
                fertilizer_id: toLong(ORGANIC_FERTILIZER_ID),
            })).finish();
            await sendMsgAsync('gamepb.plantpb.PlantService', 'Fertilize', body);
            successCount++;
        } catch {
            // 常见是有机肥耗尽，按需求直接停止
            break;
        }

        idx = (idx + 1) % ids.length;
        await sleep(1000);
    }

    return successCount;
}

function getOrganicFertilizerTargetsFromLands(lands) {
    const list = Array.isArray(lands) ? lands : [];
    const targets = [];
    const minLandLevel = getFertilizeLandLevel();
    for (const land of list) {
        if (!land || !land.unlocked) continue;
        const landId = toNum(land.id);
        if (!landId) continue;

        const landLevel = toNum(land.level);
        if (minLandLevel > 0 && landLevel < minLandLevel) continue;

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) continue;
        const currentPhase = getCurrentPhase(plant.phases);
        if (!currentPhase) continue;
        if (currentPhase.phase === PlantPhase.DEAD) continue;

        // 服务端有该字段时，<=0 说明该地当前不能再施有机肥
        if (Object.prototype.hasOwnProperty.call(plant, 'left_inorc_fert_times')) {
            const leftTimes = toNum(plant.left_inorc_fert_times);
            if (leftTimes <= 0) continue;
        }

        targets.push(landId);
    }
    return targets;
}

function getSlaveLandIds(land) {
    const ids = Array.isArray(land && land.slave_land_ids) ? land.slave_land_ids : [];
    return [...new Set(ids.map(id => toNum(id)).filter(Boolean))];
}

function hasPlantData(land) {
    const plant = land && land.plant;
    return !!(plant && Array.isArray(plant.phases) && plant.phases.length > 0);
}

function getLinkedMasterLand(land, landsMap) {
    const landId = toNum(land && land.id);
    const masterLandId = toNum(land && land.master_land_id);
    if (!masterLandId || masterLandId === landId) return null;

    const masterLand = landsMap.get(masterLandId);
    if (!masterLand) return null;

    const slaveIds = getSlaveLandIds(masterLand);
    if (slaveIds.length > 0 && !slaveIds.includes(landId)) return null;

    return masterLand;
}

function buildSlaveToMasterMap(lands) {
    const map = new Map();
    for (const land of (Array.isArray(lands) ? lands : [])) {
        const slaveIds = getSlaveLandIds(land);
        const masterId = toNum(land && land.id);
        if (slaveIds.length > 0 && masterId > 0) {
            for (const slaveId of slaveIds) {
                if (slaveId > 0 && slaveId !== masterId) {
                    map.set(slaveId, masterId);
                }
            }
        }
    }
    return map;
}

function getDisplayLandContext(land, landsMap, slaveToMasterMap) {
    const landId = toNum(land && land.id);
    
    const masterLand = getLinkedMasterLand(land, landsMap);
    if (masterLand && hasPlantData(masterLand)) {
        const occupiedLandIds = [toNum(masterLand.id), ...getSlaveLandIds(masterLand)].filter(Boolean);
        return {
            sourceLand: masterLand,
            occupiedByMaster: true,
            masterLandId: toNum(masterLand.id),
            occupiedLandIds: occupiedLandIds.length > 0 ? occupiedLandIds : [toNum(masterLand.id)].filter(Boolean),
        };
    }

    if (slaveToMasterMap) {
        const masterIdFromMap = slaveToMasterMap.get(landId);
        if (masterIdFromMap) {
            const masterFromMap = landsMap.get(masterIdFromMap);
            if (masterFromMap && hasPlantData(masterFromMap)) {
                const occupiedLandIds = [toNum(masterFromMap.id), ...getSlaveLandIds(masterFromMap)].filter(Boolean);
                return {
                    sourceLand: masterFromMap,
                    occupiedByMaster: true,
                    masterLandId: toNum(masterFromMap.id),
                    occupiedLandIds: occupiedLandIds.length > 0 ? occupiedLandIds : [toNum(masterFromMap.id)].filter(Boolean),
                };
            }
        }
    }

    const selfId = toNum(land && land.id);
    return {
        sourceLand: land,
        occupiedByMaster: false,
        masterLandId: selfId,
        occupiedLandIds: [selfId].filter(Boolean),
    };
}

function isOccupiedSlaveLand(land, landsMap, slaveToMasterMap) {
    return !!getDisplayLandContext(land, landsMap, slaveToMasterMap).occupiedByMaster;
}

function getFastMatureLands(lands) {
    const list = Array.isArray(lands) ? lands : [];
    const targets = [];
    const nowSec = getServerTimeSec();
    const FIVE_MINUTES_SEC = 5 * 60;
    const minLandLevel = getFertilizeLandLevel();

    for (const land of list) {
        if (!land || !land.unlocked) continue;
        const landId = toNum(land.id);
        if (!landId) continue;

        const landLevel = toNum(land.level);
        if (minLandLevel > 0 && landLevel < minLandLevel) continue;

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) continue;
        const currentPhase = getCurrentPhase(plant.phases);
        if (!currentPhase) continue;
        if (currentPhase.phase === PlantPhase.DEAD) continue;
        if (currentPhase.phase === PlantPhase.MATURE) continue;

        const maturePhase = plant.phases.find(p => toNum(p.phase) === PlantPhase.MATURE);
        if (!maturePhase) continue;

        const matureBeginTime = toTimeSec(maturePhase.begin_time);
        if (matureBeginTime <= 0) continue;

        const timeToMature = matureBeginTime - nowSec;

        if (timeToMature <= FIVE_MINUTES_SEC && timeToMature >= 0) {
            if (Object.prototype.hasOwnProperty.call(plant, 'left_inorc_fert_times')) {
                const leftTimes = toNum(plant.left_inorc_fert_times);
                if (leftTimes <= 0) continue;
            }
            targets.push(landId);
        }
    }
    return targets;
}

async function runFertilizerByConfig(plantedLands = [], options = {}) {
    const fertilizerConfig = getAutomation().fertilizer || 'both';
    const planted = (Array.isArray(plantedLands) ? plantedLands : []).filter(Boolean);
    const { skipNormal = false, reason = 'normal' } = options;
    const minLandLevel = getFertilizeLandLevel();
    const isMultiSeason = String(reason).trim().toLowerCase() === 'multi_season';
    const reasonLabel = isMultiSeason ? '多季补肥' : '常规施肥';
    const eventName = isMultiSeason ? '多季补肥' : '施肥';

    if (planted.length === 0 && fertilizerConfig !== 'organic' && fertilizerConfig !== 'both' && fertilizerConfig !== 'smart') {
        return { normal: 0, organic: 0 };
    }

    let fertilizedNormal = 0;
    let fertilizedOrganic = 0;

    if (!skipNormal && (fertilizerConfig === 'normal' || fertilizerConfig === 'both' || fertilizerConfig === 'smart') && planted.length > 0) {
        let normalTargets = planted;
        if (minLandLevel > 0) {
            try {
                const latest = await getAllLands();
                const landsMap = new Map();
                for (const land of (latest && latest.lands || [])) {
                    const id = toNum(land && land.id);
                    if (id > 0) landsMap.set(id, land);
                }
                normalTargets = planted.filter(landId => {
                    const land = landsMap.get(landId);
                    if (!land) return false;
                    const landLevel = toNum(land.level);
                    return landLevel >= minLandLevel;
                });
            } catch (e) {
                logWarn('施肥', `获取农场地块等级失败: ${e.message}`);
            }
        }
        if (normalTargets.length > 0) {
            fertilizedNormal = await fertilize(normalTargets, NORMAL_FERTILIZER_ID);
            if (fertilizedNormal > 0) {
                log('施肥', `${reasonLabel}：已为 ${fertilizedNormal}/${normalTargets.length} 块地施无机化肥`, {
                module: 'farm',
                event: eventName,
                result: 'ok',
                type: 'normal',
                count: fertilizedNormal,
                minLandLevel,
            });
                recordOperation('fertilize', fertilizedNormal);
            }
        }
    }

    if (fertilizerConfig === 'organic' || fertilizerConfig === 'both') {
        let organicTargets = planted;
        try {
            const latest = await getAllLands();
            organicTargets = getOrganicFertilizerTargetsFromLands(latest && latest.lands);
        } catch (e) {
            logWarn('施肥', `获取全农场地块失败，回退已种地块: ${e.message}`);
        }

        fertilizedOrganic = await fertilizeOrganicLoop(organicTargets);
        if (fertilizedOrganic > 0) {
            log('施肥', `${reasonLabel}：有机化肥循环施肥完成，共施 ${fertilizedOrganic} 次`, {
                module: 'farm',
                event: eventName,
                result: 'ok',
                type: 'organic',
                count: fertilizedOrganic,
                minLandLevel,
            });
            recordOperation('fertilize', fertilizedOrganic);
        }
    }
    else if (fertilizerConfig === 'smart') {
        let organicTargets = [];
        try {
            const latest = await getAllLands();
            organicTargets = getFastMatureLands(latest && latest.lands);
        } catch (e) {
            logWarn('施肥', `获取全农场地块失败: ${e.message}`);
        }

        if (organicTargets.length > 0) {
            fertilizedOrganic = await fertilizeOrganicLoop(organicTargets);
            if (fertilizedOrganic > 0) {
                log('施肥', `${reasonLabel}：有机化肥循环施肥完成，共施 ${fertilizedOrganic} 次`, {
                    module: 'farm',
                    event: eventName,
                    result: 'ok',
                    type: 'organic',
                    count: fertilizedOrganic,
                    minLandLevel,
                });
                recordOperation('fertilize', fertilizedOrganic);
            }
        }
    }

    return { normal: fertilizedNormal, organic: fertilizedOrganic };
}

async function removePlant(landIds) {
    const body = types.RemovePlantRequest.encode(types.RemovePlantRequest.create({
        land_ids: landIds.map(id => toLong(id)),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'RemovePlant', body);
    return types.RemovePlantReply.decode(replyBody);
}

async function upgradeLand(landId) {
    const body = types.UpgradeLandRequest.encode(types.UpgradeLandRequest.create({
        land_id: toLong(landId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UpgradeLand', body);
    return types.UpgradeLandReply.decode(replyBody);
}

async function unlockLand(landId, doShared = false) {
    const body = types.UnlockLandRequest.encode(types.UnlockLandRequest.create({
        land_id: toLong(landId),
        do_shared: !!doShared,
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'UnlockLand', body);
    return types.UnlockLandReply.decode(replyBody);
}

// ============ 商店 API ============

async function getShopInfo(shopId) {
    const body = types.ShopInfoRequest.encode(types.ShopInfoRequest.create({
        shop_id: toLong(shopId),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'ShopInfo', body);
    return types.ShopInfoReply.decode(replyBody);
}

async function buyGoods(goodsId, num, price) {
    const body = types.BuyGoodsRequest.encode(types.BuyGoodsRequest.create({
        goods_id: toLong(goodsId),
        num: toLong(num),
        price: toLong(price),
    })).finish();
    const { body: replyBody } = await sendMsgAsync('gamepb.shoppb.ShopService', 'BuyGoods', body);
    return types.BuyGoodsReply.decode(replyBody);
}

// ============ 种植 ============

function encodePlantRequest(seedId, landIds) {
    const writer = protobuf.Writer.create();
    const itemWriter = writer.uint32(18).fork();
    itemWriter.uint32(8).int64(seedId);
    const idsWriter = itemWriter.uint32(18).fork();
    for (const id of landIds) {
        idsWriter.int64(id);
    }
    idsWriter.ldelim();
    itemWriter.ldelim();
    return writer.finish();
}

function getPlantSizeBySeedId(seedId) {
    const plantCfg = getPlantBySeedId(toNum(seedId));
    return Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
}

/**
 * 种植 - 游戏中拖动种植间隔很短，默认 50ms，可通过 plantDelaySeconds 配置
 */
async function plantSeeds(seedId, landIds, options = {}) {
    const delaySec = getPlantDelaySeconds();
    const delayMs = delaySec > 0 ? delaySec * 1000 : 50;
    let successCount = 0;
    const plantedLandIds = [];
    const occupiedLandIds = new Set();
    const maxPlantCount = Math.max(0, toNum(options.maxPlantCount) || 0) || Number.POSITIVE_INFINITY;
    const pendingLandIds = new Set((Array.isArray(landIds) ? landIds : []).map(id => toNum(id)).filter(Boolean));

    for (const rawLandId of landIds) {
        const landId = toNum(rawLandId);
        if (!landId || !pendingLandIds.has(landId)) continue;
        if (successCount >= maxPlantCount) break;

        try {
            const body = encodePlantRequest(seedId, [landId]);
            const { body: replyBody } = await sendMsgAsync('gamepb.plantpb.PlantService', 'Plant', body);
            const reply = types.PlantReply.decode(replyBody);
            const changedLands = Array.isArray(reply && reply.land) ? reply.land : [];
            const changedMap = buildLandMap(changedLands);
            const changedSlaveToMasterMap = buildSlaveToMasterMap(changedLands);
            const selfLand = changedMap.get(landId);
            const displayContext = getDisplayLandContext(selfLand || { id: landId }, changedMap, changedSlaveToMasterMap);
            const occupiedIds = displayContext.occupiedLandIds.length > 0
                ? displayContext.occupiedLandIds
                : [landId];

            successCount++;
            plantedLandIds.push(displayContext.masterLandId || landId);
            for (const occupiedId of occupiedIds) {
                occupiedLandIds.add(occupiedId);
                pendingLandIds.delete(occupiedId);
            }
        } catch (e) {
            logWarn('种植', `土地#${landId} 失败: ${e.message}`);
        }
        await sleep(delayMs);
    }
    return {
        planted: successCount,
        plantedLandIds,
        occupiedLandIds: [...occupiedLandIds],
    };
}

async function findBestSeed() {
    const SEED_SHOP_ID = 2;
    const shopReply = await getShopInfo(SEED_SHOP_ID);
    if (!shopReply.goods_list || shopReply.goods_list.length === 0) {
        logWarn('商店', '种子商店无商品');
        return null;
    }

    const state = getUserState();
    const available = [];
    for (const goods of shopReply.goods_list) {
        if (!goods.unlocked) continue;

        let meetsConditions = true;
        let requiredLevel = 0;
        const conds = goods.conds || [];
        for (const cond of conds) {
            if (toNum(cond.type) === 1) {
                requiredLevel = toNum(cond.param);
                if (state.level < requiredLevel) {
                    meetsConditions = false;
                    break;
                }
            }
        }
        if (!meetsConditions) continue;

        const limitCount = toNum(goods.limit_count);
        const boughtNum = toNum(goods.bought_num);
        if (limitCount > 0 && boughtNum >= limitCount) continue;

        available.push({
            goods,
            goodsId: toNum(goods.id),
            seedId: toNum(goods.item_id),
            price: toNum(goods.price),
            requiredLevel,
        });
    }

    if (available.length === 0) {
        logWarn('商店', '没有可购买的种子');
        return null;
    }

    const strategy = getPlantingStrategy();

    if (isAutomationOn('task_plant')) {
        try {
            const { getTaskInfo } = require('./task');
            const reply = await getTaskInfo();
            const taskInfo = reply.task_info || {};
            const allTasks = [
                ...(taskInfo.tasks || []),
                ...(taskInfo.growth_tasks || []),
                ...(taskInfo.daily_tasks || [])
            ];
            
            // 优先级1: 收获任务 - 种白萝卜（成熟快）
            for (const task of allTasks) {
                if (!task.is_unlocked || task.is_claimed) continue;
                const desc = task.desc || '';
                const progress = toNum(task.progress);
                const totalProgress = toNum(task.total_progress);
                if (progress >= totalProgress) continue;
                if (desc.match(/完成\d+次收获/)) {
                    const radishSeed = available.find(a => a.seedId === 20002);
                    if (radishSeed) {
                        log('商店', `任务种植：选择 白萝卜 种子 (完成收获任务)`, {
                            module: 'warehouse',
                            event: '选择种子',
                            mode: 'task_plant',
                            seedId: 20002
                        });
                        return radishSeed;
                    }
                }
            }
            
            // 优先级2: 种植/购买指定作物任务
            for (const task of allTasks) {
                if (!task.is_unlocked || task.is_claimed) continue;
                const desc = task.desc || '';
                const progress = toNum(task.progress);
                const totalProgress = toNum(task.total_progress);
                
                if (progress >= totalProgress) continue;
                
                let plantNameMatch = desc.match(/种植\d+株(.+)/);
                if (!plantNameMatch) {
                    plantNameMatch = desc.match(/购买\d+个(.+)种子/);
                }
                if (plantNameMatch && plantNameMatch[1]) {
                    const targetPlantName = plantNameMatch[1].trim();
                    const found = available.find(a => {
                        const plantName = getPlantNameBySeedId(a.seedId);
                        return plantName && plantName.includes(targetPlantName);
                    });
                    if (found) {
                        log('商店', `任务种植：选择 ${getPlantNameBySeedId(found.seedId)} 种子`, {
                            module: 'warehouse',
                            event: '选择种子',
                            mode: 'task_plant',
                            seedId: found.seedId
                        });
                        return found;
                    }
                }
            }
        } catch (e) {
            logWarn('商店', `任务种植获取任务失败: ${e.message}`);
        }
    }
    
    // 优先级3: 每日萝卜600经验（当日收获数量未达到目标时种萝卜）
    if (isAutomationOn('task_plant_first_harvest_radish')) {
        const currentCount = getDailyHarvestCount();
        if (currentCount < RADISH_TARGET_COUNT) {
            const radishSeed = available.find(a => a.seedId === 20002);
            if (radishSeed) {
                log('商店', `萝卜600经验：选择 白萝卜 种子 (${currentCount}/${RADISH_TARGET_COUNT})`, {
                    module: 'warehouse',
                    event: '选择种子',
                    mode: 'radish_600_exp',
                    seedId: 20002,
                    currentCount,
                    target: RADISH_TARGET_COUNT
                });
                return radishSeed;
            }
        } else {
            log('商店', `萝卜600经验已完成 (${currentCount}/${RADISH_TARGET_COUNT})，使用账号策略`, {
                module: 'warehouse',
                event: '萝卜600完成',
                currentCount,
                target: RADISH_TARGET_COUNT
            });
        }
    }

    // 优先级4: 活动种植（只检查背包中的活动种子）
    if (isAutomationOn('event_plant')) {
        const EVENT_SEEDS = [
            { seedId: 20224, name: '昙花' },
            { seedId: 20249, name: '荷包牡丹' },
            { seedId: 20025, name: '银杏树苗' },
            { seedId: 20109, name: '蝴蝶兰' },
            { seedId: 20112, name: '风信子' },
            { seedId: 20121, name: '蔷薇' },
        ];
        
        try {
            const { getBag } = require('./warehouse');
            const bagReply = await getBag();
            const bagItems = bagReply && bagReply.item_bag && bagReply.item_bag.items 
                ? bagReply.item_bag.items 
                : (bagReply && bagReply.items ? bagReply.items : []);
            
            for (const eventSeed of EVENT_SEEDS) {
                const bagItem = bagItems.find(item => toNum(item.id) === eventSeed.seedId && toNum(item.count) > 0);
                if (bagItem) {
                    log('商店', `活动种植：背包已有 ${eventSeed.name} 种子 x${toNum(bagItem.count)}`, {
                        module: 'warehouse',
                        event: '选择种子',
                        mode: 'event_plant',
                        seedId: eventSeed.seedId,
                        name: eventSeed.name,
                        bagCount: toNum(bagItem.count),
                    });
                    return {
                        goods: null,
                        goodsId: 0,
                        seedId: eventSeed.seedId,
                        price: 0,
                        requiredLevel: 0,
                        fromBag: true,
                    };
                }
            }
        } catch (e) {
            logWarn('商店', `活动种植检查背包失败: ${e.message}`);
        }
        
        log('商店', '活动种植：背包中未找到活动作物种子，使用账号策略', {
            module: 'warehouse',
            event: '活动种植回退',
        });
    }

    // 优先级5: 按账号设定的种植策略
    if (isAutomationOn('task_plant')) {
        log('商店', '任务种植未找到需要种植的作物，使用账号策略', {
            module: 'warehouse',
            event: '回退策略',
            strategy
        });
    }
    
    const analyticsSortByMap = {
        max_exp: 'exp',
        max_fert_exp: 'fert',
        max_profit: 'profit',
        max_fert_profit: 'fert_profit',
    };
    const analyticsSortBy = analyticsSortByMap[strategy];
    if (analyticsSortBy) {
        try {
            const rankings = getPlantRankings(analyticsSortBy);
            const availableBySeedId = new Map(available.map(a => [a.seedId, a]));
            for (const row of rankings) {
                const seedId = Number(row && row.seedId) || 0;
                if (seedId <= 0) continue;
                const lv = Number(row && row.level);
                if (Number.isFinite(lv) && lv > state.level) continue;
                const found = availableBySeedId.get(seedId);
                if (found) return found;
            }
            logWarn('商店', `策略 ${strategy} 未找到可购买作物，回退最高等级`);
        } catch (e) {
            logWarn('商店', `策略 ${strategy} 计算失败: ${e.message}，回退最高等级`);
        }
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
        return available[0];
    }
    
    if (strategy === 'preferred') {
        const preferred = getPreferredSeed();
        if (preferred > 0) {
            const found = available.find(a => a.seedId === preferred);
            if (found) return found;
            logWarn('商店', `优先种子 ${preferred} 当前不可购买，回退自动选择`);
        }
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
    }
    else if (strategy === 'level') {
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
    } 
    else {
        available.sort((a, b) => b.requiredLevel - a.requiredLevel);
    }

    return available[0];
}

async function getAvailableSeeds() {
    const SEED_SHOP_ID = 2;
    const state = getUserState();
    let list = [];
    
    try {
        const shopReply = await getShopInfo(SEED_SHOP_ID);
        if (shopReply.goods_list) {
            for (const goods of shopReply.goods_list) {
                // 不再过滤不可用的种子，而是返回给前端展示状态
                let requiredLevel = 0;
                for (const cond of goods.conds || []) {
                    if (toNum(cond.type) === 1) requiredLevel = toNum(cond.param);
                }
                
                const limitCount = toNum(goods.limit_count);
                const boughtNum = toNum(goods.bought_num);
                const isSoldOut = limitCount > 0 && boughtNum >= limitCount;
    
                list.push({
                    seedId: toNum(goods.item_id),
                    goodsId: toNum(goods.id),
                    name: getPlantNameBySeedId(toNum(goods.item_id)),
                    price: toNum(goods.price),
                    requiredLevel,
                    locked: !goods.unlocked || state.level < requiredLevel,
                    soldOut: isSoldOut,
                });
            }
        }
    } catch (e) {
        const wsErr = getWsErrorState();
        if (!wsErr || Number(wsErr.code) !== 400) {
            logWarn('商店', `获取商店失败: ${e.message}，使用本地备选列表`);
        }
    }

    // 如果商店请求失败或为空，使用本地配置
    if (list.length === 0) {
        const allSeeds = getAllSeeds();
        list = allSeeds.map(s => ({
            ...s,
            goodsId: 0,
            price: null, // 未知价格
            requiredLevel: null, // 未知等级
            unknownMeta: true,
            locked: false,
            soldOut: false,
        }));
    }
    return list.sort((a, b) => {
        const av = (a.requiredLevel === null || a.requiredLevel === undefined) ? 9999 : a.requiredLevel;
        const bv = (b.requiredLevel === null || b.requiredLevel === undefined) ? 9999 : b.requiredLevel;
        return av - bv;
    });
}

async function getLandsDetail() {
    try {
        const landsReply = await getAllLands();
        if (!landsReply.lands) return { lands: [], summary: {} };
        const nowSec = getServerTimeSec();
        const landsMap = buildLandMap(landsReply.lands);
        const slaveToMasterMap = buildSlaveToMasterMap(landsReply.lands);
        const lands = [];

        for (const land of landsReply.lands) {
            const basic = getLandBasicInfo(land);
            const {
                sourceLand,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
            } = getDisplayLandContext(land, landsMap, slaveToMasterMap);
            
            if (!basic.unlocked) {
                lands.push({
                    id: basic.id,
                    unlocked: false,
                    status: 'locked',
                    plantName: '',
                    phaseName: '',
                    level: basic.level,
                    maxLevel: basic.maxLevel,
                    landsLevel: basic.landsLevel,
                    landSize: basic.landSize,
                    couldUnlock: basic.couldUnlock,
                    couldUpgrade: basic.couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster: false,
                    masterLandId: 0,
                    occupiedLandIds: [],
                    plantSize: 1,
                });
                continue;
            }
            
            const plantInfo = getPlantInfo(sourceLand, nowSec);
            if (!plantInfo) {
                lands.push({
                    id: basic.id,
                    unlocked: true,
                    status: 'empty',
                    plantName: '',
                    phaseName: '空地',
                    level: basic.level,
                    maxLevel: basic.maxLevel,
                    landsLevel: basic.landsLevel,
                    landSize: basic.landSize,
                    couldUnlock: basic.couldUnlock,
                    couldUpgrade: basic.couldUpgrade,
                    currentSeason: 0,
                    totalSeason: 0,
                    occupiedByMaster,
                    masterLandId,
                    occupiedLandIds,
                    plantSize: 1,
                });
                continue;
            }

            const plantId = toNum(sourceLand && sourceLand.plant && sourceLand.plant.id);
            const plantCfg = getPlantById(plantId);
            const plantSize = Math.max(1, toNum(plantCfg && plantCfg.size) || 1);
            const totalSeason = Math.max(1, toNum(plantCfg && plantCfg.seasons) || 1);
            const currentSeasonRaw = toNum(sourceLand && sourceLand.plant && sourceLand.plant.season);
            const currentSeason = currentSeasonRaw > 0 ? Math.min(currentSeasonRaw, totalSeason) : 1;

            lands.push({
                id: basic.id,
                unlocked: true,
                status: plantInfo.status,
                plantName: plantInfo.plantName,
                seedId: plantInfo.seedId,
                seedImage: plantInfo.seedImage,
                phaseName: plantInfo.phaseName,
                currentSeason,
                totalSeason,
                matureInSec: plantInfo.matureInSec,
                needWater: plantInfo.needWater,
                needWeed: plantInfo.needWeed,
                needBug: plantInfo.needBug,
                stealable: plantInfo.stealable,
                level: basic.level,
                maxLevel: basic.maxLevel,
                landsLevel: basic.landsLevel,
                landSize: basic.landSize,
                couldUnlock: basic.couldUnlock,
                couldUpgrade: basic.couldUpgrade,
                occupiedByMaster,
                masterLandId,
                occupiedLandIds,
                plantSize,
            });
        }

        const status = summarizeLandDetails(lands);
        return {
            lands,
            summary: status,
        };
    } catch {
        return { lands: [], summary: {} };
    }
}

function summarizeLandDetails(lands) {
    const summary = {
        harvestable: 0,
        growing: 0,
        empty: 0,
        dead: 0,
        needWater: 0,
        needWeed: 0,
        needBug: 0,
    };

    for (const land of Array.isArray(lands) ? lands : []) {
        if (!land || !land.unlocked) continue;

        const status = String(land.status || '');
        if (status === 'harvestable') summary.harvestable++;
        else if (status === 'dead') summary.dead++;
        else if (status === 'empty') summary.empty++;
        else if (status === 'growing' || status === 'stealable' || status === 'harvested') summary.growing++;

        if (land.needWater) summary.needWater++;
        if (land.needWeed) summary.needWeed++;
        if (land.needBug) summary.needBug++;
    }

    return summary;
}

async function autoPlantEmptyLands(deadLandIds, emptyLandIds) {
    const landsToPlant = [...emptyLandIds];
    const state = getUserState();

    // 1. 铲除枯死/收获残留植物（一键操作）
    if (deadLandIds.length > 0) {
        try {
            await removePlant(deadLandIds);
            log('铲除', `已铲除 ${deadLandIds.length} 块 (${deadLandIds.join(',')})`, {
                module: 'farm', event: '铲除植物', result: 'ok', count: deadLandIds.length
            });
            landsToPlant.push(...deadLandIds);
        } catch (e) {
            logWarn('铲除', `批量铲除失败: ${e.message}`, {
                module: 'farm', event: '铲除植物', result: 'error'
            });
            // 失败时仍然尝试种植
            landsToPlant.push(...deadLandIds);
        }
    }

    if (landsToPlant.length === 0) return;

    // 2. 查询种子商店
    let bestSeed;
    try {
        bestSeed = await findBestSeed();
    } catch (e) {
        logWarn('商店', `查询失败: ${e.message}`);
        return;
    }
    if (!bestSeed) return;

    const seedName = getPlantNameBySeedId(bestSeed.seedId);
    const growTime = getPlantGrowTime(1020000 + (bestSeed.seedId - 20000));  // 转换为植物ID
    const growTimeStr = growTime > 0 ? ` 生长${formatGrowTime(growTime)}` : '';
    const plantSize = getPlantSizeBySeedId(bestSeed.seedId);
    const landFootprint = plantSize * plantSize;
    log('商店', `最佳种子: ${seedName} (${bestSeed.seedId}) 价格=${bestSeed.price}金币${growTimeStr}`, {
        module: 'warehouse', event: '选择种子', seedId: bestSeed.seedId, price: bestSeed.price
    });

    // 3. 购买（如果种子来自背包则跳过购买）
    let needCount = landsToPlant.length;
    if (landFootprint > 1) {
        needCount = Math.floor(landsToPlant.length / landFootprint);
        if (needCount <= 0) {
            log('种植', `${seedName} 需要至少 ${landFootprint} 块空地才能合并种植，当前仅 ${landsToPlant.length} 块可用，已跳过`, {
                module: 'farm',
                event: '种植种子',
                result: 'skip',
                seedId: bestSeed.seedId,
                landFootprint,
                emptyCount: landsToPlant.length,
            });
            return;
        }
    }
    
    let actualSeedId = bestSeed.seedId;
    
    if (bestSeed.fromBag) {
        // 种子来自背包，无需购买
        log('种植', `使用背包中的 ${seedName} 种子进行种植`, {
            module: 'warehouse',
            event: '使用背包种子',
            result: 'ok',
            seedId: actualSeedId,
        });
    } else {
        // 需要从商店购买
        const totalCost = bestSeed.price * needCount;
        if (totalCost > state.gold) {
            logWarn('商店', `金币不足! 需要 ${totalCost} 金币, 当前 ${state.gold} 金币`, {
                module: 'farm', event: '购买种子跳过', result: 'insufficient_gold', need: totalCost, current: state.gold
            });
            const canBuy = Math.floor(state.gold / bestSeed.price);
            if (canBuy <= 0) return;
            needCount = canBuy;
            log('商店', plantSize > 1 ? `金币有限，只尝试种植 ${canBuy} 组 ${plantSize}x${plantSize} 作物` : `金币有限，只种 ${canBuy} 块地`);
        }

        try {
            const buyReply = await buyGoods(bestSeed.goodsId, needCount, bestSeed.price);
            if (buyReply.get_items && buyReply.get_items.length > 0) {
                const gotItem = buyReply.get_items[0];
                const gotId = toNum(gotItem.id);
                if (gotId > 0) actualSeedId = gotId;
            }
            if (buyReply.cost_items) {
                for (const item of buyReply.cost_items) {
                    state.gold -= toNum(item.count);
                }
            }
            const boughtName = getPlantNameBySeedId(actualSeedId);
            log('购买', `已购买 ${boughtName}种子 x${needCount}, 花费 ${bestSeed.price * needCount} 金币`, {
                module: 'warehouse',
                event: '购买种子',
                result: 'ok',
                seedId: actualSeedId,
                count: needCount,
                cost: bestSeed.price * needCount,
            });
        } catch (e) {
            logWarn('购买', e.message);
            return;
        }
    }

    // 4. 种植（逐块拖动，间隔50ms）
    let plantedLands = [];
    try {
        const { planted, plantedLandIds, occupiedLandIds } = await plantSeeds(actualSeedId, landsToPlant, { maxPlantCount: needCount });
        const occupiedCount = occupiedLandIds.length > 0 ? occupiedLandIds.length : planted;
        log('种植', plantSize > 1
            ? `已种植 ${planted} 组 ${plantSize}x${plantSize} 作物，占用 ${occupiedCount} 块地 (${occupiedLandIds.join(',')})`
            : `已在 ${planted} 块地种植 (${landsToPlant.slice(0, planted).join(',')})`, {
            module: 'farm',
            event: '种植种子',
            result: 'ok',
            seedId: actualSeedId,
            count: planted,
            occupiedCount,
        });
        if (planted > 0) {
            plantedLands = plantedLandIds;
        }
    } catch (e) {
        logWarn('种植', e.message);
    }

    // 5. 施肥
    await runFertilizerByConfig(plantedLands);
}

function getCurrentPhase(phases, debug, landLabel) {
    if (!phases || phases.length === 0) return null;

    const nowSec = getServerTimeSec();

    if (debug) {
        console.warn(`    ${landLabel} 服务器时间=${nowSec} (${new Date(nowSec * 1000).toLocaleTimeString()})`);
        for (let i = 0; i < phases.length; i++) {
            const p = phases[i];
            const bt = toTimeSec(p.begin_time);
            const phaseName = PHASE_NAMES[p.phase] || `阶段${p.phase}`;
            const diff = bt > 0 ? (bt - nowSec) : 0;
            const diffStr = diff > 0 ? `(未来 ${diff}s)` : diff < 0 ? `(已过 ${-diff}s)` : '';
            console.warn(`    ${landLabel}   [${i}] ${phaseName}(${p.phase}) begin=${bt} ${diffStr} dry=${toTimeSec(p.dry_time)} weed=${toTimeSec(p.weeds_time)} insect=${toTimeSec(p.insect_time)}`);
        }
    }

    for (let i = phases.length - 1; i >= 0; i--) {
        const beginTime = toTimeSec(phases[i].begin_time);
        if (beginTime > 0 && beginTime <= nowSec) {
            if (debug) {
                console.warn(`    ${landLabel}   → 当前阶段: ${PHASE_NAMES[phases[i].phase] || phases[i].phase}`);
            }
            return phases[i];
        }
    }

    if (debug) {
        console.warn(`    ${landLabel}   → 所有阶段都在未来，使用第一个: ${PHASE_NAMES[phases[0].phase] || phases[0].phase}`);
    }
    return phases[0];
}

function getLandBasicInfo(land) {
    const id = toNum(land.id);
    const level = toNum(land.level);
    const maxLevel = toNum(land.max_level);
    const landsLevel = toNum(land.lands_level);
    const landSize = toNum(land.land_size);
    const couldUnlock = !!land.could_unlock;
    const couldUpgrade = !!land.could_upgrade;
    const unlocked = !!land.unlocked;
    return { id, level, maxLevel, landsLevel, landSize, couldUnlock, couldUpgrade, unlocked };
}

function getPlantInfo(land, nowSec) {
    const plant = land.plant;
    if (!plant || !plant.phases || plant.phases.length === 0) {
        return null;
    }
    const currentPhase = getCurrentPhase(plant.phases, false, '');
    if (!currentPhase) return null;

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
    const needWater = (toNum(plant.dry_num) > 0) || (toTimeSec(currentPhase.dry_time) > 0 && toTimeSec(currentPhase.dry_time) <= nowSec);
    const needWeed = (plant.weed_owners && plant.weed_owners.length > 0) || (toTimeSec(currentPhase.weeds_time) > 0 && toTimeSec(currentPhase.weeds_time) <= nowSec);
    const needBug = (plant.insect_owners && plant.insect_owners.length > 0) || (toTimeSec(currentPhase.insect_time) > 0 && toTimeSec(currentPhase.insect_time) <= nowSec);

    let status = 'growing';
    if (phaseVal === PlantPhase.MATURE) status = 'harvestable';
    else if (phaseVal === PlantPhase.DEAD) status = 'dead';
    else if (phaseVal === PlantPhase.UNKNOWN || !plant.phases.length) status = 'empty';

    return {
        plantId,
        plantName,
        seedId,
        seedImage,
        phaseName,
        phaseVal,
        matureInSec,
        needWater,
        needWeed,
        needBug,
        status,
        stealable: !!plant.stealable,
    };
}

function analyzeLands(lands) {
    const result = {
        harvestable: [], needWater: [], needWeed: [], needBug: [],
        growing: [], empty: [], dead: [], unlockable: [], upgradable: [],
        harvestableInfo: [],
    };

    const nowSec = getServerTimeSec();
    const debug = isFirstFarmCheck;
    const landsMap = buildLandMap(lands);
    const slaveToMasterMap = buildSlaveToMasterMap(lands);

    for (const land of lands) {
        const id = toNum(land.id);
        const basic = getLandBasicInfo(land);
        
        if (!basic.unlocked) {
            if (basic.couldUnlock) result.unlockable.push(id);
            continue;
        }
        if (basic.couldUpgrade) result.upgradable.push(id);

        // 跳过被主地块占用的副地块
        if (isOccupiedSlaveLand(land, landsMap, slaveToMasterMap)) {
            continue;
        }

        const plant = land.plant;
        if (!plant || !plant.phases || plant.phases.length === 0) {
            result.empty.push(id);
            continue;
        }

        const plantName = plant.name || '未知作物';
        const landLabel = `土地#${id}(${plantName})`;

        const currentPhase = getCurrentPhase(plant.phases, debug, landLabel);
        if (!currentPhase) {
            result.empty.push(id);
            continue;
        }
        const phaseVal = currentPhase.phase;

        if (phaseVal === PlantPhase.DEAD) {
            result.dead.push(id);
            continue;
        }

        if (phaseVal === PlantPhase.MATURE) {
            result.harvestable.push(id);
            const plantId = toNum(plant.id);
            const plantNameFromConfig = getPlantName(plantId);
            const plantExp = getPlantExp(plantId);
            result.harvestableInfo.push({
                landId: id,
                plantId,
                name: plantNameFromConfig || plantName,
                exp: plantExp,
            });
            continue;
        }

        const dryNum = toNum(plant.dry_num);
        const dryTime = toTimeSec(currentPhase.dry_time);
        if (dryNum > 0 || (dryTime > 0 && dryTime <= nowSec)) {
            result.needWater.push(id);
        }

        const weedsTime = toTimeSec(currentPhase.weeds_time);
        const hasWeeds = (plant.weed_owners && plant.weed_owners.length > 0) || (weedsTime > 0 && weedsTime <= nowSec);
        if (hasWeeds) result.needWeed.push(id);

        const insectTime = toTimeSec(currentPhase.insect_time);
        const hasBugs = (plant.insect_owners && plant.insect_owners.length > 0) || (insectTime > 0 && insectTime <= nowSec);
        if (hasBugs) result.needBug.push(id);

        result.growing.push(id);
    }

    return result;
}

function buildLandMap(lands) {
    const map = new Map();
    const list = Array.isArray(lands) ? lands : [];
    for (const land of list) {
        const id = toNum(land && land.id);
        if (id > 0) map.set(id, land);
    }
    return map;
}

function getLandLifecycleState(land) {
    if (!land) return 'unknown';
    const plant = land.plant;
    if (!plant || !Array.isArray(plant.phases) || plant.phases.length === 0) {
        return 'empty';
    }

    const currentPhase = getCurrentPhase(plant.phases, false, '');
    if (!currentPhase) return 'empty';

    const phaseVal = toNum(currentPhase.phase);
    if (phaseVal === PlantPhase.DEAD) return 'dead';
    if (phaseVal === PlantPhase.UNKNOWN) return 'empty';
    if (phaseVal >= PlantPhase.SEED && phaseVal <= PlantPhase.MATURE) return 'growing';
    return 'unknown';
}

function classifyHarvestedLandsByMap(landIds, landsMap) {
    const removable = [];
    const growing = [];
    const unknown = [];
    for (const id of landIds) {
        const land = landsMap.get(id);
        if (!land) {
            unknown.push(id);
            continue;
        }
        const state = getLandLifecycleState(land);
        if (state === 'dead' || state === 'empty') {
            removable.push(id);
            continue;
        }
        if (state === 'growing') {
            growing.push(id);
            continue;
        }
        unknown.push(id);
    }
    return { removable, growing, unknown };
}

async function resolveRemovableHarvestedLands(harvestedLandIds, _harvestReply) {
    const ids = Array.isArray(harvestedLandIds) ? harvestedLandIds.filter(Boolean) : [];
    if (ids.length === 0) {
        return { removable: [], growing: [], fallbackRemoved: 0 };
    }

    const removable = [];
    const growing = [];

    try {
        const latestLandsReply = await getAllLands();
        const latestMap = buildLandMap(latestLandsReply && latestLandsReply.lands);
        const classified = classifyHarvestedLandsByMap(ids, latestMap);
        removable.push(...classified.removable);
        growing.push(...classified.growing);

        if (classified.growing.length > 0) {
            log('农场', `检测到 ${classified.growing.length} 块两季作物仍在生长，跳过铲除`, {
                module: 'farm',
                event: '两季作物检测',
                result: 'ok',
                growingLands: classified.growing,
            });
        }
    } catch (e) {
        logWarn('农场', `收获后刷新土地状态失败: ${e.message}，跳过收获地块的后续处理`, {
            module: 'farm',
            event: '收获后状态刷新',
            result: 'error',
        });
    }

    return {
        removable: [...new Set(removable)],
        growing: [...new Set(growing)],
        fallbackRemoved: 0,
    };
}

async function checkFarm() {
    const state = getUserState();
    if (isCheckingFarm || !state.gid || !isAutomationOn('farm')) return false;
    isCheckingFarm = true;

    try {
        // 复用手动操作逻辑
        const result = await runFarmOperation('all');
        isFirstFarmCheck = false;

        // 同步秒收取任务（如果启用）
        const fastHarvestConfig = getFastHarvestConfig(state.accountId);
        if (fastHarvestConfig.enabled) {
            try {
                const landsReply = await getAllLands();
                if (landsReply && landsReply.lands) {
                    await syncFastHarvestTasks(landsReply.lands);
                }
            } catch (e) {
                logWarn('秒收取', `同步秒收任务失败: ${e.message}`);
            }
        }

        return !!(result && result.hadWork);
    } catch (err) {
        logWarn('巡田', `检查失败: ${err.message}`);
        return false;
    } finally {
        isCheckingFarm = false;
    }
}

async function runFastHarvestStandalone() {
    const state = getUserState();
    if (!state.gid) return false;
    const fastHarvestConfig = getFastHarvestConfig(state.accountId);

    let hadWork = false;
    try {
        const harvestResult = await runFarmOperation('harvest');
        hadWork = !!(harvestResult && harvestResult.hadWork);
    } catch (e) {
        logWarn('秒收取', `独立收取失败: ${e.message}`);
    }

    if (fastHarvestConfig.enabled) {
        try {
            const landsReply = await getAllLands();
            if (landsReply && landsReply.lands) {
                await syncFastHarvestTasks(landsReply.lands);
            }
        } catch (e) {
            logWarn('秒收取', `独立同步任务失败: ${e.message}`);
        }
    }

    return hadWork;
}

/**
 * 手动/自动执行农场操作
 * @param {string} opType - 'all', 'harvest', 'clear', 'plant', 'upgrade', 'maintain'
 */
async function runFarmOperation(opType) {
    const landsReply = await getAllLands();
    if (!landsReply.lands || landsReply.lands.length === 0) {
        if (opType !== 'all') {
            log('农场', '没有土地数据');
        }
        return { hadWork: false, actions: [] };
    }

    const lands = landsReply.lands;
    const status = analyzeLands(lands);

    // 摘要
    const statusParts = [];
    if (status.harvestable.length) statusParts.push(`收:${status.harvestable.length}`);
    if (status.needWeed.length) statusParts.push(`草:${status.needWeed.length}`);
    if (status.needBug.length) statusParts.push(`虫:${status.needBug.length}`);
    if (status.needWater.length) statusParts.push(`水:${status.needWater.length}`);
    if (status.dead.length) statusParts.push(`枯:${status.dead.length}`);
    if (status.empty.length) statusParts.push(`空:${status.empty.length}`);
    if (status.unlockable.length) statusParts.push(`解:${status.unlockable.length}`);
    if (status.upgradable.length) statusParts.push(`升:${status.upgradable.length}`);
    statusParts.push(`长:${status.growing.length}`);

    const actions = [];
    const batchOps = [];

    // 优先执行收获（避免被偷）
    let harvestedLandIds = [];
    let harvestReply = null;
    if (opType === 'all' || opType === 'harvest') {
        if (status.harvestable.length > 0) {
            try {
                harvestReply = await harvest(status.harvestable);
                log('收获', `收获完成 ${status.harvestable.length} 块土地`, {
                    module: 'farm',
                    event: '收获作物',
                    result: 'ok',
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                });
                actions.push(`收获${status.harvestable.length}`);
                recordOperation('harvest', status.harvestable.length);
                harvestedLandIds = [...status.harvestable];
                addHarvestCount(status.harvestable.length);
                networkEvents.emit('farmHarvested', {
                    count: status.harvestable.length,
                    landIds: [...status.harvestable],
                    opType,
                });
                
                const currentCount = getDailyHarvestCount();
                log('收获', `今日已收获 ${currentCount}/${RADISH_TARGET_COUNT}`, {
                    module: 'farm',
                    event: '每日收获进度',
                    count: currentCount,
                    target: RADISH_TARGET_COUNT,
                });
            } catch (e) {
                logWarn('收获', e.message, {
                    module: 'farm',
                    event: '收获作物',
                    result: 'error',
                });
            }
        }
    }

    // 执行除草/虫/水
    if (opType === 'all' || opType === 'clear' || opType === 'maintain') {
        const shouldClearOwnWeedBug = opType === 'clear' ? true : isAutomationOn('clear_own_weed_bug');
        if (status.needWeed.length > 0 && shouldClearOwnWeedBug) {
            batchOps.push(weedOut(status.needWeed).then(() => { actions.push(`除草${status.needWeed.length}`); recordOperation('weed', status.needWeed.length); }).catch(e => logWarn('除草', e.message)));
        }
        if (status.needBug.length > 0 && shouldClearOwnWeedBug) {
            batchOps.push(insecticide(status.needBug).then(() => { actions.push(`除虫${status.needBug.length}`); recordOperation('bug', status.needBug.length); }).catch(e => logWarn('除虫', e.message)));
        }
        if (status.needWater.length > 0) {
            batchOps.push(waterLand(status.needWater).then(() => { actions.push(`浇水${status.needWater.length}`); recordOperation('water', status.needWater.length); }).catch(e => logWarn('浇水', e.message)));
        }
        if (batchOps.length > 0) await Promise.all(batchOps);
    }

    // 执行种植
    if (opType === 'all' || opType === 'plant') {
        const allEmptyLands = [...new Set(status.empty)];
        let allDeadLands = [...new Set(status.dead)];

        if (opType === 'all' && harvestedLandIds.length > 0) {
            const postHarvest = await resolveRemovableHarvestedLands(harvestedLandIds, harvestReply);
            allDeadLands = [...new Set([...allDeadLands, ...postHarvest.removable])];
        }
        // 注意：如果是单纯点"一键种植"，harvestedLandIds 为空，只种当前的空地/死地
        if (allDeadLands.length > 0 || allEmptyLands.length > 0) {
            try {
                const plantCount = allDeadLands.length + allEmptyLands.length;
                await autoPlantEmptyLands(allDeadLands, allEmptyLands);
                actions.push(`种植${plantCount}`);
                recordOperation('plant', plantCount);
            } catch (e) { logWarn('种植', e.message); }
        }
    }

    // 执行土地解锁/升级（手动 upgrade 总是执行；自动 all 受开关控制）
    const shouldAutoUpgrade = opType === 'all' && isAutomationOn('land_upgrade');
    if (shouldAutoUpgrade || opType === 'upgrade') {
        if (status.unlockable.length > 0) {
            let unlocked = 0;
            for (const landId of status.unlockable) {
                try {
                    await unlockLand(landId, false);
                    log('解锁', `土地#${landId} 解锁成功`, {
                        module: 'farm', event: '解锁土地', result: 'ok', landId
                    });
                    unlocked++;
                } catch (e) {
                    logWarn('解锁', `土地#${landId} 解锁失败: ${e.message}`, {
                        module: 'farm', event: '解锁土地', result: 'error', landId
                    });
                }
                await sleep(200);
            }
            if (unlocked > 0) {
                actions.push(`解锁${unlocked}`);
            }
        }

        if (status.upgradable.length > 0) {
            let upgraded = 0;
            for (const landId of status.upgradable) {
                try {
                    const reply = await upgradeLand(landId);
                    const newLevel = reply.land ? toNum(reply.land.level) : '?';
                    log('升级', `土地#${landId} 升级成功 → 等级${newLevel}`, {
                        module: 'farm', event: '升级土地', result: 'ok', landId, level: newLevel
                    });
                    upgraded++;
                } catch (e) {
                    log('升级', `土地#${landId} 升级失败: ${e.message}`, {
                        module: 'farm', event: '升级土地', result: 'error', landId
                    });
                }
                await sleep(200);
            }
            if (upgraded > 0) {
                actions.push(`升级${upgraded}`);
                recordOperation('upgrade', upgraded);
            }
        }
    }

    if (opType === 'all') {
        const fertilizerConfig = getAutomation().fertilizer || 'none';
        if (fertilizerConfig === 'smart') {
            try {
                const result = await runFertilizerByConfig([], { skipNormal: true });
                if (result.organic > 0) {
                    actions.push(`有机肥${result.organic}`);
                }
            } catch (e) {
                logWarn('施肥', `巡田时施肥失败: ${e.message}`);
            }
        }

        if (isAutomationOn('fertilizer_multi_season') && harvestedLandIds.length > 0) {
            const postHarvest = await resolveRemovableHarvestedLands(harvestedLandIds, harvestReply);
            if (postHarvest.growing && postHarvest.growing.length > 0) {
                const multiSeasonTargets = [...new Set(postHarvest.growing.map(v => toNum(v)).filter(Boolean))];
                if (multiSeasonTargets.length > 0) {
                    try {
                        const result = await runFertilizerByConfig(multiSeasonTargets, { reason: 'multi_season' });
                        if (result.normal > 0 || result.organic > 0) {
                            actions.push(`多季补肥${result.normal + result.organic}`);
                        }
                    } catch (e) {
                        logWarn('施肥', `多季补肥执行失败: ${e.message}`, {
                            module: 'farm',
                            event: '多季补肥',
                            result: 'error',
                        });
                    }
                }
            }
        }
    }

    // 日志
    const actionStr = actions.length > 0 ? ` → ${actions.join('/')}` : '';
    if (actions.length > 0) {
         log('农场', `[${statusParts.join(' ')}]${actionStr}`, {
             module: 'farm', event: '农场循环', opType, actions
         });
    }
    return { hadWork: actions.length > 0, actions };
}

function scheduleNextFarmCheck(delayMs = CONFIG.farmCheckInterval) {
    if (externalSchedulerMode) return;
    if (!farmLoopRunning) return;
    farmScheduler.setTimeoutTask('farm_check_loop', Math.max(0, delayMs), async () => {
        if (!farmLoopRunning) return;
        await checkFarm();
        if (!farmLoopRunning) return;
        scheduleNextFarmCheck(CONFIG.farmCheckInterval);
    });
}

/**
 * 秒收取任务同步循环
 * 独立运行，确保即使农场检查关闭，秒收取也能工作
 */
async function fastHarvestSyncLoop() {
    if (externalSchedulerMode) return;
    if (!farmLoopRunning) return;

    const state = getUserState();
    if (state.gid) {
        const config = getFastHarvestConfig(state.accountId);
        if (config.enabled) {
            try {
                const landsReply = await getAllLands();
                if (landsReply && landsReply.lands) {
                    await syncFastHarvestTasks(landsReply.lands);
                }
            } catch (e) {
                logWarn('秒收取', `同步任务失败: ${e.message}`);
            }
        }
    }

    if (!farmLoopRunning) return;
    // 每20秒同步一次秒收取任务
    farmScheduler.setTimeoutTask('fast_harvest_sync_loop', 20000, () => fastHarvestSyncLoop());
}

function startFarmCheckLoop(options = {}) {
    if (farmLoopRunning) return;
    externalSchedulerMode = !!options.externalScheduler;
    farmLoopRunning = true;
    networkEvents.on('landsChanged', onLandsChangedPush);
    if (!externalSchedulerMode) {
        scheduleNextFarmCheck(2000);
        // 启动秒收取同步循环
        farmScheduler.setTimeoutTask('fast_harvest_sync_loop', 5000, () => fastHarvestSyncLoop());
    }
}

let lastPushTime = 0;
function onLandsChangedPush(lands) {
    if (!isAutomationOn('farm_push')) {
        return;
    }
    if (isCheckingFarm) return;
    const now = Date.now();
    if (now - lastPushTime < 500) return;
    lastPushTime = now;
    log('农场', `收到推送: ${lands.length}块土地变化，检查中...`, {
        module: 'farm', event: '土地推送通知', result: 'trigger_check', count: lands.length
    });
    farmScheduler.setTimeoutTask('farm_push_check', 100, async () => {
        if (!isCheckingFarm) await checkFarm();
    });
}

function stopFarmCheckLoop() {
    farmLoopRunning = false;
    externalSchedulerMode = false;
    farmScheduler.clearAll();
    networkEvents.removeListener('landsChanged', onLandsChangedPush);
}

function refreshFarmCheckLoop(delayMs = 200) {
    if (!farmLoopRunning) return;
    scheduleNextFarmCheck(delayMs);
}

// ============ 秒收取功能 ============

/**
 * 生成秒收取任务ID
 */
function getFastHarvestTaskId() {
    fastHarvestTaskIdCounter++;
    return `fast_harvest_${fastHarvestTaskIdCounter}`;
}

/**
 * 执行秒收取任务
 * 在作物理论成熟时间前提前发起收获请求
 */
async function executeFastHarvest(landId, matureTimeSec) {
    const state = getUserState();
    if (!state.gid) return;

    const config = getFastHarvestConfig(state.accountId);
    if (!config.enabled) return;

    const nowSec = getServerTimeSec();
    // 提前量 (ms)
    const advanceMs = config.advanceMs || 0;
    const waitTimeMs = (matureTimeSec - nowSec) * 1000 - advanceMs;

    // 如果已经过成熟时间（或提前时间已过），立即收获
    if (waitTimeMs <= 0) {
        try {
            await harvest([landId]);
            log('秒收取', `土地#${landId} 已立即收获`, {
                module: 'farm',
                event: '秒收取',
                result: 'ok',
                landId,
                mode: 'immediate',
            });
            recordOperation('harvest', 1);
            addHarvestCount(1);
        } catch (e) {
            logWarn('秒收取', `土地#${landId} 立即收获失败: ${e.message}`);
        }
        return;
    }

    // 创建定时任务，在成熟前提前执行
    const taskId = getFastHarvestTaskId();
    const waitSec = Math.max(0, waitTimeMs / 1000);
    log('秒收取', `土地#${landId} 将在 ${waitSec.toFixed(1)} 秒后执行秒收 (提前 ${advanceMs}ms)`, {
        module: 'farm',
        event: '秒收取调度',
        landId,
        waitSec,
        advanceMs,
    });

    farmScheduler.setTimeoutTask(taskId, waitTimeMs, async () => {
        try {
            // 执行收获前的小延迟，确保已经过成熟点 (如果 advanceMs > 0)
            // 这里我们直接执行，因为 advanceMs 就是为了抢先
            
            let retryCount = 0;
            const maxRetries = 2;
            
            while (retryCount <= maxRetries) {
                // 再次检查是否已收获
                const landsReply = await getAllLands();
                const landsMap = buildLandMap(landsReply.lands);
                const land = landsMap.get(landId);

                if (!land || !land.plant) {
                    log('秒收取', `土地#${landId} 已为空，跳过`, { module: 'farm', event: '秒收取跳过', landId });
                    break;
                }

                const currentPhase = getCurrentPhase(land.plant.phases);
                if (currentPhase && currentPhase.phase === PlantPhase.MATURE) {
                    await harvest([landId]);
                    log('秒收取', `✅ 土地#${landId} 秒收成功`, {
                        module: 'farm',
                        event: '秒收取',
                        result: 'ok',
                        landId,
                        mode: 'scheduled',
                    });
                    recordOperation('harvest', 1);
                    addHarvestCount(1);
                    break;
                } else {
                    // 尚未成熟，稍微等一下再试
                    if (retryCount < maxRetries) {
                        const retryDelay = 500 + (retryCount * 500);
                        log('秒收取', `土地#${landId} 尚未成熟，${retryDelay}ms 后重试 (${retryCount + 1}/${maxRetries})`);
                        await sleep(retryDelay);
                        retryCount++;
                    } else {
                        log('秒收取', `土地#${landId} 达到最大重试次数仍未成熟，跳过`, { module: 'farm', event: '秒收取跳过', landId });
                        break;
                    }
                }
            }
        } catch (e) {
            logWarn('秒收取', `土地#${landId} 秒收失败: ${e.message}`);
        }
    });

    // 记录任务
    fastHarvestTasks.set(landId, {
        taskId,
        matureTime: matureTimeSec,
        timeoutId: null, // farmScheduler 内部管理
    });
}

/**
 * 同步秒收取任务
 * 分析当前土地状态，为即将成熟的作物创建秒收任务
 */
async function syncFastHarvestTasks(lands) {
    const state = getUserState();
    if (!state.gid) return;

    const config = getFastHarvestConfig(state.accountId);
    if (!config.enabled) {
        // 如果秒收取被禁用，清除所有待执行任务
        if (fastHarvestTasks.size > 0) {
            for (const [, taskInfo] of fastHarvestTasks) {
                farmScheduler.clear(taskInfo.taskId);
            }
            fastHarvestTasks.clear();
        }
        return;
    }

    const nowSec = getServerTimeSec();
    const landsMap = buildLandMap(lands);

    // 清理已过期的任务
    for (const [landId, taskInfo] of fastHarvestTasks) {
        const land = landsMap.get(landId);
        if (!land || !land.plant) {
            // 土地已空，取消任务
            farmScheduler.clear(taskInfo.taskId);
            fastHarvestTasks.delete(landId);
            continue;
        }

        const currentPhase = getCurrentPhase(land.plant.phases);
        if (!currentPhase || currentPhase.phase === PlantPhase.MATURE || currentPhase.phase === PlantPhase.DEAD) {
            // 已成熟或已枯萎，取消任务
            farmScheduler.clear(taskInfo.taskId);
            fastHarvestTasks.delete(landId);
        }
    }

    // 为新的即将成熟的作物创建任务
    // 先构建 slaveToMasterMap 一次，避免循环内重复构建
    const slaveToMasterMap = buildSlaveToMasterMap(lands);

    for (const land of lands) {
        const landId = toNum(land.id);
        if (!landId || !land.unlocked) continue;

        // 跳过被主地块占用的副地块
        if (isOccupiedSlaveLand(land, landsMap, slaveToMasterMap)) continue;

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

        // 获取配置，检查 advanceMs 是否合理
        const config = getFastHarvestConfig(state.accountId);
        const advanceSec = (config.advanceMs || 0) / 1000;

        // 只处理在秒收时间窗口内的作物
        // 时间窗口需要大于提前收获时间，否则提前收获不会生效
        const effectiveWindow = Math.max(FAST_HARVEST_WINDOW_SEC, advanceSec + 60);

        if (timeToMature <= effectiveWindow && timeToMature > 0) {
            // 检查是否已有任务
            if (fastHarvestTasks.has(landId)) {
                const existingTask = fastHarvestTasks.get(landId);
                // 如果成熟时间变化超过5秒，重新调度
                if (Math.abs(existingTask.matureTime - matureBeginTime) > 5) {
                    farmScheduler.clear(existingTask.taskId);
                    fastHarvestTasks.delete(landId);
                    await executeFastHarvest(landId, matureBeginTime);
                }
            } else {
                await executeFastHarvest(landId, matureBeginTime);
            }
        }
    }
}

/**
 * 获取当前活跃的秒收取任务列表
 */
function getActiveFastHarvestTasks() {
    const tasks = [];
    const nowSec = getServerTimeSec();
    for (const [landId, taskInfo] of fastHarvestTasks) {
        tasks.push({
            landId,
            matureTime: taskInfo.matureTime,
            waitSeconds: Math.max(0, taskInfo.matureTime - nowSec),
        });
    }
    return tasks.sort((a, b) => a.matureTime - b.matureTime);
}

/**
 * 清除所有秒收取任务
 */
function clearAllFastHarvestTasks() {
    for (const [, taskInfo] of fastHarvestTasks) {
        farmScheduler.clear(taskInfo.taskId);
    }
    fastHarvestTasks.clear();
    log('秒收取', '已清除所有秒收任务', { module: 'farm', event: '秒收取清除' });
}

module.exports = {
    checkFarm, startFarmCheckLoop, stopFarmCheckLoop,
    refreshFarmCheckLoop,
    getCurrentPhase,
    setOperationLimitsCallback,
    getAllLands,
    getLandsDetail,
    getAvailableSeeds,
    runFarmOperation, // 导出新函数
    runFastHarvestStandalone,
    runFertilizerByConfig,
    buildLandMap,
    buildSlaveToMasterMap,
    getDisplayLandContext,
    isOccupiedSlaveLand,
    loadDailyHarvestState,
    getDailyHarvestCount,
    addHarvestCount,
    // 秒收取功能导出
    syncFastHarvestTasks,
    getActiveFastHarvestTasks,
    clearAllFastHarvestTasks,
};
