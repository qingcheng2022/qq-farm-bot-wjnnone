<script setup lang="ts">
import type { ApiResult } from '@/api/result'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch, watchEffect } from 'vue'
import api from '@/api'
import { getErrorMessage } from '@/api/error'
import { unwrapOk } from '@/api/result'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useAccountStore } from '@/stores/account'
import { useFarmStore } from '@/stores/farm'
import { useSettingStore } from '@/stores/setting'
import { useUserStore } from '@/stores/user'
import AccountsView from '@/views/Accounts.vue'

const settingStore = useSettingStore()
const accountStore = useAccountStore()
const farmStore = useFarmStore()
const userStore = useUserStore()

const { settings, loading } = storeToRefs(settingStore)
const { currentAccountId, accounts } = storeToRefs(accountStore)
const { seeds } = storeToRefs(farmStore)

const savingStrategy = ref(false)
const savingAutomation = ref(false)
const passwordSaving = ref(false)
const offlineSaving = ref(false)
const offlineTesting = ref(false)

// 当前激活的标签页
const activeTab = ref<'account' | 'user' | 'strategy' | 'automation'>('account')

const modalVisible = ref(false)
const modalConfig = ref({
  title: '',
  message: '',
  type: 'primary' as 'primary' | 'danger',
  isAlert: true,
})

function showAlert(message: string, type: 'primary' | 'danger' = 'primary') {
  modalConfig.value = {
    title: type === 'danger' ? '错误' : '提示',
    message,
    type,
    isAlert: true,
  }
  modalVisible.value = true
}

const currentAccountName = computed(() => {
  const acc = accounts.value.find((a: any) => a.id === currentAccountId.value)
  return acc ? (acc.name || acc.nick || acc.id) : null
})

const localSettings = ref({
  plantingStrategy: 'preferred',
  preferredSeedId: 0,
  stealDelaySeconds: 0,
  plantOrderRandom: false,
  plantDelaySeconds: 0,
  intervals: { farmMin: 2, farmMax: 2, helpMin: 10, helpMax: 10, stealMin: 10, stealMax: 10 },
  friendQuietHours: { enabled: false, start: '23:00', end: '07:00' },
  automation: {
    farm: false,
    task_plant: false,
    task_plant_first_harvest_radish: false,
    event_plant: false,
    sell: false,
    friend: false,
    farm_push: false,
    land_upgrade: false,
    friend_steal: false,
    friend_help: false,
    friend_bad: false,
    friend_help_exp_limit: false,
    fertilizer_gift: false,
    fertilizer_buy: false,
    fertilizer: 'none',
    fertilizerBuyType: 'organic',
    fertilizeLandLevel: 1,
    fertilizer_multi_season: false,
    clear_own_weed_bug: true,
    // 秒收取和蹲守偷菜
    fast_harvest: false,
    stakeout_steal: false,
    // GUID索引配置
    use_visitor_gids: false,
    use_guid_range: false,
    guid_range_start: 100000000,
    guid_range_end: 119000000,
    guid_index_current: 100000000,
    guid_index_completed: false,
    guid_index_interval: 3,
  },
  // 秒收取配置
  fastHarvestAdvanceMs: 200,
  // 蹲守偷菜配置
  stakeoutSteal: {
    enabled: false,
    delaySec: 3,
    maxAheadSec: 4 * 3600,
  },
  stakeoutFriendList: [] as number[],
})

const automationBooleanKeys = [
  'farm',
  'task_plant',
  'task_plant_first_harvest_radish',
  'event_plant',
  'sell',
  'friend',
  'farm_push',
  'land_upgrade',
  'friend_steal',
  'friend_help',
  'friend_bad',
  'friend_help_exp_limit',
  'fertilizer_gift',
  'fertilizer_buy',
  'clear_own_weed_bug',
  // 秒收取和蹲守偷菜
  'fast_harvest',
  'stakeout_steal',
] as const

const automationMasterSwitch = computed({
  get() {
    return automationBooleanKeys.every(key => localSettings.value.automation[key] === true)
  },
  set(newVal: boolean) {
    for (const key of automationBooleanKeys) {
      localSettings.value.automation[key] = newVal
    }
  },
})

const automationSyncSwitch = computed({
  get() {
    return !!settings.value.automationSyncEnabled
  },
  async set(newVal: boolean) {
    if (!currentAccountId.value)
      return
    const prev = !!settings.value.automationSyncEnabled
    settings.value.automationSyncEnabled = newVal
    const res = await settingStore.setAutomationSyncEnabled(currentAccountId.value, newVal)
    if (!res.ok) {
      settings.value.automationSyncEnabled = prev
      showAlert(`保存失败: ${res.error}`, 'danger')
      return
    }
    showAlert(newVal ? '自动控制同步已开启' : '自动控制同步已关闭')
    await loadData()
  },
})

const localOffline = ref({
  channel: 'webhook',
  reloginUrlMode: 'none',
  endpoint: '',
  token: '',
  title: '',
  msg: '',
})

const passwordForm = ref({
  old: '',
  new: '',
  confirm: '',
})

// 运行时连接配置
const runtimeConfigSaving = ref(false)
const localRuntimeConfig = ref({
  serverUrl: 'wss://gate-obt.nqf.qq.com/prod/ws',
  clientVersion: '1.7.0.6_20260313',
  os: 'iOS',
  osVersion: 'iOS 26.2.1',
  networkType: 'wifi',
  memory: '7672',
  deviceId: 'iPhone X<iPhone18,3>',
})

function syncLocalSettings() {
  if (settings.value) {
    localSettings.value = JSON.parse(JSON.stringify({
      plantingStrategy: settings.value.plantingStrategy,
      preferredSeedId: settings.value.preferredSeedId,
      stealDelaySeconds: settings.value.stealDelaySeconds ?? 0,
      plantOrderRandom: !!settings.value.plantOrderRandom,
      plantDelaySeconds: settings.value.plantDelaySeconds ?? 0,
      intervals: settings.value.intervals,
      friendQuietHours: settings.value.friendQuietHours,
      automation: settings.value.automation,
      // 秒收取配置
      fastHarvestAdvanceMs: settings.value.fastHarvestAdvanceMs ?? 200,
      // 蹲守偷菜配置
      stakeoutSteal: settings.value.stakeoutSteal ?? { enabled: false, delaySec: 3, maxAheadSec: 4 * 3600 },
      stakeoutFriendList: settings.value.stakeoutFriendList ?? [],
    }))

    if (!localSettings.value.automation) {
      localSettings.value.automation = {
        farm: false,
        task_plant: false,
        task_plant_first_harvest_radish: false,
        event_plant: false,
        sell: false,
        friend: false,
        farm_push: false,
        land_upgrade: false,
        friend_steal: false,
        friend_help: false,
        friend_bad: false,
        friend_help_exp_limit: false,
        fertilizer_gift: false,
        fertilizer_buy: false,
        fertilizer: 'none',
        fertilizerBuyType: 'organic',
        fertilizeLandLevel: 1,
        fertilizer_multi_season: false,
        clear_own_weed_bug: true,
        fast_harvest: false,
        stakeout_steal: false,
        use_visitor_gids: false,
        use_guid_range: false,
        guid_range_start: 100000000,
        guid_range_end: 119000000,
        guid_index_current: 100000000,
        guid_index_completed: false,
        guid_index_interval: 3,
      }
    }
    else {
      const defaults = {
        farm: false,
        task_plant: false,
        task_plant_first_harvest_radish: false,
        event_plant: false,
        sell: false,
        friend: false,
        farm_push: false,
        land_upgrade: false,
        friend_steal: false,
        friend_help: false,
        friend_bad: false,
        friend_help_exp_limit: false,
        fertilizer_gift: false,
        fertilizer_buy: false,
        fertilizer: 'none',
        fertilizerBuyType: 'organic',
        fertilizeLandLevel: 1,
        fertilizer_multi_season: false,
        clear_own_weed_bug: true,
        fast_harvest: false,
        stakeout_steal: false,
        use_visitor_gids: false,
        use_guid_range: false,
        guid_range_start: 100000000,
        guid_range_end: 119000000,
        guid_index_current: 100000000,
        guid_index_completed: false,
        guid_index_interval: 3,
      }
      localSettings.value.automation = {
        ...defaults,
        ...localSettings.value.automation,
      }
    }

    if (settings.value.offlineReminder) {
      localOffline.value = JSON.parse(JSON.stringify(settings.value.offlineReminder))
    }
  }
}

async function loadData() {
  if (currentAccountId.value) {
    await settingStore.fetchSettings(currentAccountId.value)
    syncLocalSettings()
    await farmStore.fetchSeeds(currentAccountId.value)
  }
  // 加载运行时连接配置
  await loadRuntimeConfig()
}

async function loadRuntimeConfig() {
  try {
    const { data } = await api.get('/api/settings/runtime-config')
    if (data.ok && data.data) {
      localRuntimeConfig.value = { ...localRuntimeConfig.value, ...data.data }
    }
  }
  catch (e) {
    console.error('加载运行时配置失败:', e)
  }
}

onMounted(() => {
  loadData()
})

watch(currentAccountId, () => {
  loadData()
})

const fertilizerOptions = [
  { label: '普通 + 有机', value: 'both' },
  { label: '普通 + 快成熟有机', value: 'smart' },
  { label: '仅普通化肥', value: 'normal' },
  { label: '仅有机化肥', value: 'organic' },
  { label: '不施肥', value: 'none' },
]

const fertilizerBuyTypeOptions = [
  { label: '有机化肥', value: 'organic' },
  { label: '普通化肥', value: 'normal' },
]

const fertilizeLandLevelOptions = [
  { label: '黄土地及以上', value: 1 },
  { label: '红土地及以上', value: 2 },
  { label: '黑土地及以上', value: 3 },
  { label: '仅金土地', value: 4 },
]

const plantingStrategyOptions = [
  { label: '优先种植种子', value: 'preferred' },
  { label: '最高等级作物', value: 'level' },
  { label: '最大经验/时', value: 'max_exp' },
  { label: '最大普通肥经验/时', value: 'max_fert_exp' },
  { label: '最大净利润/时', value: 'max_profit' },
  { label: '最大普通肥净利润/时', value: 'max_fert_profit' },
]

const channelOptions = [
  { label: 'Webhook(自定义接口)', value: 'webhook' },
  { label: 'Qmsg 酱', value: 'qmsg' },
  { label: 'Server 酱', value: 'serverchan' },
  { label: 'Push Plus', value: 'pushplus' },
  { label: 'Push Plus Hxtrip', value: 'pushplushxtrip' },
  { label: '钉钉', value: 'dingtalk' },
  { label: '企业微信', value: 'wecom' },
  { label: 'Bark', value: 'bark' },
  { label: 'Go-cqhttp', value: 'gocqhttp' },
  { label: 'OneBot', value: 'onebot' },
  { label: 'Atri', value: 'atri' },
  { label: 'PushDeer', value: 'pushdeer' },
  { label: 'iGot', value: 'igot' },
  { label: 'Telegram', value: 'telegram' },
  { label: '飞书', value: 'feishu' },
  { label: 'IFTTT', value: 'ifttt' },
  { label: '企业微信群机器人', value: 'wecombot' },
  { label: 'Discord', value: 'discord' },
  { label: 'WxPusher', value: 'wxpusher' },
]

const CHANNEL_DOCS: Record<string, string> = {
  webhook: '',
  qmsg: 'https://qmsg.zendee.cn/',
  serverchan: 'https://sct.ftqq.com/',
  pushplus: 'https://www.pushplus.plus/',
  pushplushxtrip: 'https://pushplus.hxtrip.com/',
  dingtalk: 'https://open.dingtalk.com/document/group/custom-robot-access',
  wecom: 'https://guole.fun/posts/626/',
  wecombot: 'https://developer.work.weixin.qq.com/document/path/91770',
  bark: 'https://github.com/Finb/Bark',
  gocqhttp: 'https://docs.go-cqhttp.org/api/',
  onebot: 'https://docs.go-cqhttp.org/api/',
  atri: 'https://blog.tianli0.top/',
  pushdeer: 'https://www.pushdeer.com/',
  igot: 'https://push.hellyw.com/',
  telegram: 'https://core.telegram.org/bots',
  feishu: 'https://www.feishu.cn/hc/zh-CN/articles/360024984973',
  ifttt: 'https://ifttt.com/maker_webhooks',
  discord: 'https://discord.com/developers/docs/resources/webhook#execute-webhook',
  wxpusher: 'https://wxpusher.zjiecode.com/docs/#/',
}

const reloginUrlModeOptions = [
  { label: '不需要', value: 'none' },
  { label: 'QQ直链', value: 'qq_link' },
  { label: '二维码链接', value: 'qr_link' },
]

const currentChannelDocUrl = computed(() => {
  const key = String(localOffline.value.channel || '').trim().toLowerCase()
  return CHANNEL_DOCS[key] || ''
})

function openChannelDocs() {
  const url = currentChannelDocUrl.value
  if (!url)
    return
  window.open(url, '_blank', 'noopener,noreferrer')
}

const preferredSeedOptions = computed(() => {
  const options = [{ label: '自动选择', value: 0 }]
  if (seeds.value) {
    options.push(...seeds.value.map(seed => ({
      label: `${seed.requiredLevel}级 ${seed.name} (${seed.price}金)`,
      value: seed.seedId,
      disabled: seed.locked || seed.soldOut,
    })))
  }
  return options
})

const analyticsSortByMap: Record<string, string> = {
  max_exp: 'exp',
  max_fert_exp: 'fert',
  max_profit: 'profit',
  max_fert_profit: 'fert_profit',
}

const strategyPreviewLabel = ref<string | null>(null)

watchEffect(async () => {
  const strategy = localSettings.value.plantingStrategy
  if (strategy === 'preferred') {
    strategyPreviewLabel.value = null
    return
  }
  if (!seeds.value || seeds.value.length === 0) {
    strategyPreviewLabel.value = null
    return
  }
  const available = seeds.value.filter(s => !s.locked && !s.soldOut)
  if (available.length === 0) {
    strategyPreviewLabel.value = '暂无可用种子'
    return
  }
  if (strategy === 'level') {
    const best = [...available].sort((a, b) => (b.requiredLevel ?? 0) - (a.requiredLevel ?? 0))[0]
    strategyPreviewLabel.value = best ? `${best.requiredLevel ?? 0}级 ${best.name}` : null
    return
  }
  const sortBy = analyticsSortByMap[strategy]
  if (sortBy) {
    try {
      const res = await api.get(`/api/analytics?sort=${sortBy}`)
      const rankings: any[] = res.data.ok ? (res.data.data || []) : []
      const availableIds = new Set(available.map(s => s.seedId))
      const match = rankings.find(r => availableIds.has(Number(r.seedId)))
      if (match) {
        const seed = available.find(s => s.seedId === Number(match.seedId))
        strategyPreviewLabel.value = seed ? `${seed.requiredLevel}级 ${seed.name}` : null
      }
      else {
        strategyPreviewLabel.value = '暂无匹配种子'
      }
    }
    catch {
      strategyPreviewLabel.value = null
    }
  }
})

async function saveStrategySettings() {
  if (!currentAccountId.value)
    return
  savingStrategy.value = true
  try {
    const strategyData = {
      plantingStrategy: localSettings.value.plantingStrategy,
      preferredSeedId: localSettings.value.preferredSeedId,
      stealDelaySeconds: localSettings.value.stealDelaySeconds,
      plantOrderRandom: localSettings.value.plantOrderRandom,
      plantDelaySeconds: localSettings.value.plantDelaySeconds,
      intervals: localSettings.value.intervals,
      friendQuietHours: localSettings.value.friendQuietHours,
    }
    const res = await settingStore.saveStrategySettings(currentAccountId.value, strategyData)
    if (res.ok) {
      showAlert('策略设置已保存')
    }
    else {
      showAlert(`保存失败: ${res.error}`, 'danger')
    }
  }
  finally {
    savingStrategy.value = false
  }
}

async function saveAutomationSettings() {
  if (!currentAccountId.value)
    return
  savingAutomation.value = true
  try {
    const automationData = {
      automation: localSettings.value.automation,
      fastHarvestAdvanceMs: localSettings.value.fastHarvestAdvanceMs,
      stakeoutSteal: localSettings.value.stakeoutSteal,
      stakeoutFriendList: localSettings.value.stakeoutFriendList,
    }
    const res = await settingStore.saveAutomationSettings(currentAccountId.value, automationData)
    if (res.ok) {
      showAlert('自动控制设置已保存')
    }
    else {
      showAlert(`保存失败: ${res.error}`, 'danger')
    }
  }
  finally {
    savingAutomation.value = false
  }
}

async function handleChangePassword() {
  if (!passwordForm.value.old || !passwordForm.value.new) {
    showAlert('请填写完整', 'danger')
    return
  }
  if (passwordForm.value.new !== passwordForm.value.confirm) {
    showAlert('两次密码输入不一致', 'danger')
    return
  }
  if (passwordForm.value.new.length < 4) {
    showAlert('密码长度至少4位', 'danger')
    return
  }

  passwordSaving.value = true
  try {
    const res = await userStore.changePassword(passwordForm.value.old, passwordForm.value.new)

    if (res.ok) {
      showAlert('密码修改成功')
      passwordForm.value = { old: '', new: '', confirm: '' }
    }
    else {
      showAlert(`修改失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    passwordSaving.value = false
  }
}

async function handleSaveOffline() {
  offlineSaving.value = true
  try {
    const res = await settingStore.saveOfflineConfig(localOffline.value)

    if (res.ok) {
      showAlert('下线提醒设置已保存')
    }
    else {
      showAlert(`保存失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    offlineSaving.value = false
  }
}

async function handleSaveRuntimeConfig() {
  runtimeConfigSaving.value = true
  try {
    const res = await settingStore.saveRuntimeConfig(localRuntimeConfig.value)

    if (res.ok) {
      showAlert('运行时连接配置已保存，运行中的账号会自动重连以生效。')
    }
    else {
      showAlert(`保存失败: ${res.error || '未知错误'}`, 'danger')
    }
  }
  finally {
    runtimeConfigSaving.value = false
  }
}

async function copyToken() {
  if (!userStore.token) {
    showAlert('请先登录', 'danger')
    return
  }
  try {
    await navigator.clipboard.writeText(userStore.token)
    showAlert('Token 已复制到剪贴板')
  }
  catch (e) {
    showAlert('复制失败，请手动复制', 'danger')
  }
}

async function handleTestOffline() {
  offlineTesting.value = true
  try {
    const { data } = await api.post('/api/settings/offline-reminder/test', localOffline.value)
    unwrapOk<any>(data as ApiResult<any>, '测试失败')
    showAlert('测试消息发送成功')
  }
  catch (e: any) {
    showAlert(`测试失败: ${getErrorMessage(e, '请求失败')}`, 'danger')
  }
  finally {
    offlineTesting.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="loading" class="py-4 text-center text-gray-500">
      <div class="i-svg-spinners-ring-resize mx-auto mb-2 text-2xl" />
      <p>加载中...</p>
    </div>

    <div v-else class="space-y-4">
      <!-- 标签页导航 -->
      <div class="flex flex-wrap border-b border-gray-200 dark:border-gray-700">
        <button
          class="flex-1 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors"
          :class="activeTab === 'account'
            ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
            : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
          @click="activeTab = 'account'"
        >
          <div class="flex flex-col items-center justify-center space-y-1 sm:flex-row sm:space-x-2 sm:space-y-0">
            <div class="i-carbon-user-multiple text-xl" />
            <span class="whitespace-normal text-center">账号</span>
          </div>
        </button>
        <button
          class="flex-1 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors"
          :class="activeTab === 'user'
            ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
            : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
          @click="activeTab = 'user'"
        >
          <div class="flex flex-col items-center justify-center space-y-1 sm:flex-row sm:space-x-2 sm:space-y-0">
            <div class="i-carbon-user text-xl" />
            <span class="whitespace-normal text-center">本用户</span>
          </div>
        </button>
        <button
          class="flex-1 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors"
          :class="activeTab === 'strategy'
            ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
            : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
          @click="activeTab = 'strategy'"
        >
          <div class="flex flex-col items-center justify-center space-y-1 sm:flex-row sm:space-x-2 sm:space-y-0">
            <div class="i-fas-cogs text-xl" />
            <span class="whitespace-normal text-center">策略</span>
          </div>
        </button>
        <button
          class="flex-1 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors"
          :class="activeTab === 'automation'
            ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
            : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
          @click="activeTab = 'automation'"
        >
          <div class="flex flex-col items-center justify-center space-y-1 sm:flex-row sm:space-x-2 sm:space-y-0">
            <div class="i-fas-toggle-on text-xl" />
            <span class="whitespace-normal text-center">控制</span>
          </div>
        </button>
      </div>

      <div>
        <div v-if="activeTab === 'account'" class="card h-full flex flex-col rounded-lg bg-white shadow dark:bg-gray-800">
          <AccountsView />
        </div>

        <!-- 本用户标签页 -->
        <div v-if="activeTab === 'user'" class="card h-full flex flex-col rounded-lg bg-white shadow dark:bg-gray-800">
          <div class="border-b bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
            <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
              <div class="i-carbon-password" />
              修改用户密码
            </h3>
          </div>

          <div class="p-4 space-y-3">
            <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
              <BaseInput
                v-model="passwordForm.old"
                label="当前密码"
                type="password"
                placeholder="当前用户密码"
              />
              <BaseInput
                v-model="passwordForm.new"
                label="新密码"
                type="password"
                placeholder="至少 4 位"
              />
              <BaseInput
                v-model="passwordForm.confirm"
                label="确认新密码"
                type="password"
                placeholder="再次输入新密码"
              />
            </div>

            <div class="flex items-center justify-end pt-1">
              <BaseButton
                variant="primary"
                size="sm"
                :loading="passwordSaving"
                @click="handleChangePassword"
              >
                修改用户密码
              </BaseButton>
            </div>
          </div>

          <!-- 运行时连接配置 -->
          <div class="border-b border-t bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
            <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
              <div class="i-carbon-wifi" />
              运行时连接配置
            </h3>
          </div>

          <div class="p-4 space-y-3">
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <BaseInput
                v-model="localRuntimeConfig.serverUrl"
                label="服务器 WS 地址"
                type="text"
                placeholder="wss://gate-obt.nqf.qq.com/prod/ws"
              />
              <BaseInput
                v-model="localRuntimeConfig.clientVersion"
                label="游戏版本号"
                type="text"
                placeholder="1.7.0.6_20260313"
              />
            </div>

            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <BaseSelect
                v-model="localRuntimeConfig.os"
                label="系统 (os)"
                :options="[
                  { label: 'iOS', value: 'iOS' },
                  { label: 'Android', value: 'Android' },
                ]"
              />
              <BaseInput
                v-model="localRuntimeConfig.osVersion"
                label="系统版本号"
                type="text"
                placeholder="iOS 26.2.1"
              />
            </div>

            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <BaseInput
                v-model="localRuntimeConfig.memory"
                label="内存大小（单位MB）"
                type="text"
                placeholder="7672"
              />
              <BaseInput
                v-model="localRuntimeConfig.networkType"
                label="网络类型"
                type="text"
                placeholder="wifi"
              />
            </div>

            <BaseInput
              v-model="localRuntimeConfig.deviceId"
              label="设备ID"
              type="text"
              placeholder="iPhone X<iPhone18,3>"
            />

            <p class="text-xs text-gray-500 dark:text-gray-400">
              保存后，运行中的账号会自动重连以生效。
            </p>

            <div class="flex items-center justify-end pt-1">
              <BaseButton
                variant="primary"
                size="sm"
                :loading="runtimeConfigSaving"
                @click="handleSaveRuntimeConfig"
              >
                保存运行时连接配置
              </BaseButton>
            </div>
          </div>

          <!-- 请求参数信息 -->
          <div class="border-b border-t bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
            <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
              <div class="i-carbon-code" />
              请求参数信息
            </h3>
          </div>

          <div class="p-4 space-y-3">
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-2">
                <div class="flex-1">
                  <BaseInput
                    :model-value="userStore.token"
                    label="x-admin-token"
                    type="text"
                    readonly
                    placeholder="请先登录"
                  />
                </div>
                <div class="pt-5">
                  <BaseButton
                    variant="secondary"
                    size="sm"
                    :disabled="!userStore.token"
                    @click="copyToken"
                  >
                    <div class="i-carbon-copy mr-1" />
                    复制
                  </BaseButton>
                </div>
              </div>
              <p class="text-xs text-gray-500 dark:text-gray-400">
                x-admin-token 用于API请求认证，复制后可用于第三方工具调用接口。
              </p>
            </div>
          </div>

          <div class="border-b border-t bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
            <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
              <div class="i-carbon-notification" />
              下线提醒
            </h3>
          </div>

          <div class="flex-1 p-4 space-y-3">
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div class="flex flex-col gap-1.5">
                <div class="flex items-center justify-between">
                  <span class="text-sm text-gray-700 font-medium dark:text-gray-300">推送渠道</span>
                  <BaseButton
                    variant="text"
                    size="sm"
                    :disabled="!currentChannelDocUrl"
                    @click="openChannelDocs"
                  >
                    官网
                  </BaseButton>
                </div>
                <BaseSelect
                  v-model="localOffline.channel"
                  :options="channelOptions"
                />
              </div>
              <BaseSelect
                v-model="localOffline.reloginUrlMode"
                label="重登录链接"
                :options="reloginUrlModeOptions"
              />
            </div>

            <BaseInput
              v-model="localOffline.endpoint"
              label="接口地址"
              type="text"
              :disabled="localOffline.channel !== 'webhook'"
            />

            <BaseInput
              v-model="localOffline.token"
              label="Token"
              type="text"
              placeholder="接收端 token"
            />

            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <BaseInput
                v-model="localOffline.title"
                label="标题"
                type="text"
                placeholder="提醒标题"
              />
            </div>

            <BaseInput
              v-model="localOffline.msg"
              label="内容"
              type="text"
              placeholder="提醒内容"
            />
          </div>

          <div class="mt-auto flex justify-end gap-2 border-t bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/50">
            <BaseButton
              variant="secondary"
              size="sm"
              :loading="offlineTesting"
              :disabled="offlineSaving"
              @click="handleTestOffline"
            >
              测试通知
            </BaseButton>
            <BaseButton
              variant="primary"
              size="sm"
              :loading="offlineSaving"
              :disabled="offlineTesting"
              @click="handleSaveOffline"
            >
              保存下线提醒设置
            </BaseButton>
          </div>
        </div>

        <!-- 策略设置标签页 -->
        <div v-if="activeTab === 'strategy'" class="card h-full flex flex-col rounded-lg bg-white shadow dark:bg-gray-800">
          <div class="border-b bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
            <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
              <div class="i-fas-cogs" />
              策略设置
              <span v-if="currentAccountName" class="ml-2 text-sm text-gray-500 font-normal dark:text-gray-400">
                ({{ currentAccountName }})
              </span>
            </h3>
          </div>

          <div class="flex-1 p-4 space-y-3">
            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <BaseSelect
                v-model="localSettings.plantingStrategy"
                label="种植策略"
                :options="plantingStrategyOptions"
              />
              <BaseSelect
                v-if="localSettings.plantingStrategy === 'preferred'"
                v-model="localSettings.preferredSeedId"
                label="优先种植种子"
                :options="preferredSeedOptions"
              />
              <div v-else class="flex flex-col gap-1.5">
                <label class="text-sm text-gray-700 font-medium dark:text-gray-300">策略选种预览</label>
                <div
                  class="w-full flex items-center justify-between border border-gray-200 rounded-lg bg-gray-50 px-3 py-2 text-gray-500 dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400"
                >
                  <span class="truncate">{{ strategyPreviewLabel ?? '加载中...' }}</span>
                  <div class="i-carbon-chevron-down shrink-0 text-lg text-gray-400" />
                </div>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
              <BaseInput
                v-model.number="localSettings.intervals.farmMin"
                label="农场巡查最小 (秒)"
                type="number"
                min="1"
              />
              <BaseInput
                v-model.number="localSettings.intervals.farmMax"
                label="农场巡查最大 (秒)"
                type="number"
                min="1"
              />
            </div>

            <div class="grid grid-cols-2 mt-3 gap-3 md:grid-cols-2">
              <BaseInput
                v-model.number="localSettings.intervals.helpMin"
                label="帮助巡查最小 (秒)"
                type="number"
                min="1"
              />
              <BaseInput
                v-model.number="localSettings.intervals.helpMax"
                label="帮助巡查最大 (秒)"
                type="number"
                min="1"
              />
            </div>

            <div class="grid grid-cols-2 mt-3 gap-3 md:grid-cols-2">
              <BaseInput
                v-model.number="localSettings.intervals.stealMin"
                label="偷菜巡查最小 (秒)"
                type="number"
                min="1"
              />
              <BaseInput
                v-model.number="localSettings.intervals.stealMax"
                label="偷菜巡查最大 (秒)"
                type="number"
                min="1"
              />
            </div>

            <div class="mt-4 flex flex-wrap items-center gap-4 border-t pt-3 dark:border-gray-700">
              <BaseSwitch
                v-model="localSettings.friendQuietHours.enabled"
                label="启用静默时段"
              />
              <div class="flex items-center gap-2">
                <BaseInput
                  v-model="localSettings.friendQuietHours.start"
                  type="time"
                  class="w-24"
                  :disabled="!localSettings.friendQuietHours.enabled"
                />
                <span class="text-gray-500">-</span>
                <BaseInput
                  v-model="localSettings.friendQuietHours.end"
                  type="time"
                  class="w-24"
                  :disabled="!localSettings.friendQuietHours.enabled"
                />
              </div>
            </div>

            <div class="mt-4 border-t pt-3 space-y-3 dark:border-gray-700">
              <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">
                种植与偷菜延迟设置
              </h4>
              <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                <BaseSwitch
                  v-model="localSettings.plantOrderRandom"
                  label="种植顺序随机"
                />
                <BaseInput
                  v-model.number="localSettings.plantDelaySeconds"
                  label="种植延迟 (秒)"
                  type="number"
                  min="0"
                />
                <BaseInput
                  v-model.number="localSettings.stealDelaySeconds"
                  label="偷菜延迟 (秒)"
                  type="number"
                  min="0"
                />
              </div>
            </div>
          </div>

          <div class="mt-auto flex justify-end border-t bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/50">
            <BaseButton
              variant="primary"
              size="sm"
              :loading="savingStrategy"
              @click="saveStrategySettings"
            >
              保存策略
            </BaseButton>
          </div>
        </div>

        <!-- 自动控制标签页 -->
        <div v-if="activeTab === 'automation'" class="card h-full flex flex-col rounded-lg bg-white shadow dark:bg-gray-800">
          <div class="border-b bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
            <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
              <div class="i-fas-toggle-on" />
              自动控制
              <span v-if="currentAccountName" class="ml-2 text-sm text-gray-500 font-normal dark:text-gray-400">
                ({{ currentAccountName }})
              </span>
            </h3>
          </div>

          <div class="flex-1 p-4 space-y-4">
            <div class="flex items-center gap-4 rounded-lg bg-blue-50 p-3 dark:bg-blue-900/20">
              <BaseSwitch v-model="automationMasterSwitch" label="总控开关" />
              <span class="text-xs text-gray-500 dark:text-gray-400">开启后自动打开所有自动控制开关</span>
            </div>
            <div class="flex items-center gap-4 rounded-lg bg-blue-50 p-3 dark:bg-blue-900/20">
              <BaseSwitch v-model="automationSyncSwitch" label="同步到所有账号" />
              <span class="text-xs text-gray-500 dark:text-gray-400">开启后，此用户所有账号共用同一套自动控制设置</span>
            </div>

            <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
              <BaseSwitch v-model="localSettings.automation.farm" label="自动种植收获" />
              <BaseSwitch v-model="localSettings.automation.task_plant" label="按照任务种植" />
              <BaseSwitch v-model="localSettings.automation.task_plant_first_harvest_radish" label="每日萝卜600经验" />
              <BaseSwitch v-model="localSettings.automation.event_plant" label="活动种植" />
              <BaseSwitch v-model="localSettings.automation.sell" label="自动卖果实" />
              <BaseSwitch v-model="localSettings.automation.friend" label="自动好友互动" />
              <BaseSwitch v-model="localSettings.automation.farm_push" label="推送触发巡田" />
              <BaseSwitch v-model="localSettings.automation.land_upgrade" label="自动升级土地" />
              <BaseSwitch v-model="localSettings.automation.fertilizer_gift" label="自动填充化肥" />
              <BaseSwitch v-model="localSettings.automation.fertilizer_buy" label="自动购买化肥" />
              <BaseSwitch v-model="localSettings.automation.clear_own_weed_bug" label="除自己草虫" />
            </div>

            <div v-if="localSettings.automation.friend" class="flex flex-wrap gap-4 rounded bg-blue-50 p-2 text-sm dark:bg-blue-900/20">
              <BaseSwitch v-model="localSettings.automation.friend_steal" label="自动偷菜" />
              <BaseSwitch v-model="localSettings.automation.friend_help" label="自动帮忙" />
              <BaseSwitch v-model="localSettings.automation.friend_bad" label="自动捣乱" />
              <BaseSwitch v-model="localSettings.automation.friend_help_exp_limit" label="经验满不帮忙" />
            </div>

            <div>
              <BaseSelect
                v-model="localSettings.automation.fertilizer"
                label="施肥策略"
                class="w-full md:w-1/2"
                :options="fertilizerOptions"
              />
            </div>

            <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
              <BaseSelect
                v-model="localSettings.automation.fertilizerBuyType"
                label="购买化肥类型"
                class="w-full"
                :options="fertilizerBuyTypeOptions"
              />
              <BaseSelect
                v-model="localSettings.automation.fertilizeLandLevel"
                label="施肥土地等级"
                class="w-full"
                :options="fertilizeLandLevelOptions"
              />
            </div>

            <div class="flex flex-wrap items-center gap-4 rounded bg-amber-50 p-3 dark:bg-amber-900/20">
              <BaseSwitch v-model="localSettings.automation.fertilizer_multi_season" label="多季补肥" />
              <span class="text-xs text-gray-500 dark:text-gray-400">收获多季作物后自动为仍在生长的地块施肥</span>
            </div>

            <!-- 秒收取配置 -->
            <div class="border-t pt-4 space-y-3 dark:border-gray-700">
              <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">
                秒收取设置
              </h4>
              <div class="flex flex-wrap items-center gap-4 rounded bg-green-50 p-3 dark:bg-green-900/20">
                <BaseSwitch v-model="localSettings.automation.fast_harvest" label="启用秒收取" />
                <span class="text-xs text-gray-500 dark:text-gray-400">作物成熟前提前发起收获请求，具备自动重试机制</span>
              </div>
              <div v-if="localSettings.automation.fast_harvest" class="grid grid-cols-1 gap-3 md:grid-cols-2">
                <BaseInput
                  v-model.number="localSettings.fastHarvestAdvanceMs"
                  label="提前时间 (毫秒)"
                  type="number"
                  min="50"
                  max="1000"
                  placeholder="200"
                />
                <div class="flex items-center text-xs text-gray-500 dark:text-gray-400">
                  <span>建议值：200ms，范围 50-1000ms</span>
                </div>
              </div>
            </div>

            <!-- 蹲守偷菜配置 -->
            <div class="border-t pt-4 space-y-3 dark:border-gray-700">
              <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">
                蹲守偷菜设置
              </h4>
              <div class="flex flex-wrap items-center gap-4 rounded bg-purple-50 p-3 dark:bg-purple-900/20">
                <BaseSwitch v-model="localSettings.automation.stakeout_steal" label="启用蹲守偷菜" />
                <span class="text-xs text-gray-500 dark:text-gray-400">预判成熟时间并自动分组，支持提前蹲点、延迟重试及自动出售</span>
              </div>
              <div v-if="localSettings.automation.stakeout_steal" class="grid grid-cols-1 gap-3 md:grid-cols-3">
                <BaseInput
                  v-model.number="localSettings.stakeoutSteal.delaySec"
                  label="偷取延迟 (秒)"
                  type="number"
                  min="0"
                  max="60"
                  placeholder="3"
                />
                <BaseInput
                  v-model.number="localSettings.stakeoutSteal.maxAheadSec"
                  label="最大提前蹲守 (秒)"
                  type="number"
                  min="60"
                  placeholder="14400"
                />
                <div class="flex items-center text-xs text-gray-500 dark:text-gray-400">
                  <span>延迟建议 3-5 秒，最大提前建议 4 小时</span>
                </div>
              </div>
            </div>

            <div class="border-t pt-4 space-y-3 dark:border-gray-700">
              <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">
                GUID索引设置
              </h4>
              <div class="flex flex-wrap items-center gap-4 rounded bg-cyan-50 p-3 dark:bg-cyan-900/20">
                <BaseSwitch v-model="localSettings.automation.use_visitor_gids" label="从访客列表获取GUID" />
                <span class="text-xs text-gray-500 dark:text-gray-400">从最近访客列表保存GUID并用于好友列表</span>
              </div>
              <div class="flex flex-wrap items-center gap-4 rounded bg-cyan-50 p-3 dark:bg-cyan-900/20">
                <BaseSwitch v-model="localSettings.automation.use_guid_range" label="自动索引GUID范围" />
                <span class="text-xs text-gray-500 dark:text-gray-400">自动索引指定范围内的GUID（实验功能）</span>
              </div>
              <div v-if="localSettings.automation.use_guid_range" class="grid grid-cols-1 gap-3 md:grid-cols-2">
                <BaseInput
                  v-model.number="localSettings.automation.guid_range_start"
                  label="GUID范围起始"
                  type="number"
                  min="100000000"
                  max="999999999"
                  placeholder="100000000"
                />
                <BaseInput
                  v-model.number="localSettings.automation.guid_range_end"
                  label="GUID范围结束"
                  type="number"
                  min="100000000"
                  max="999999999"
                  placeholder="119000000"
                />
                <BaseInput
                  v-model.number="localSettings.automation.guid_index_current"
                  label="当前索引进度"
                  type="number"
                  min="100000000"
                  max="999999999"
                  placeholder="100000000"
                />
                <BaseInput
                  v-model.number="localSettings.automation.guid_index_interval"
                  label="索引间隔 (秒)"
                  type="number"
                  min="1"
                  max="10"
                  placeholder="3"
                />
              </div>
            </div>
          </div>

          <div class="mt-auto flex justify-end border-t bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/50">
            <BaseButton
              variant="primary"
              size="sm"
              :loading="savingAutomation"
              @click="saveAutomationSettings"
            >
              保存自动控制
            </BaseButton>
          </div>
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="modalVisible"
      :title="modalConfig.title"
      :message="modalConfig.message"
      :type="modalConfig.type"
      :is-alert="modalConfig.isAlert"
      confirm-text="知道了"
      @confirm="modalVisible = false"
      @cancel="modalVisible = false"
    />
  </div>
</template>

<style scoped lang="postcss">
</style>
