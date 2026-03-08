<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch, watchEffect } from 'vue'
import api from '@/api'
import ConfirmModal from '@/components/ConfirmModal.vue'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSelect from '@/components/ui/BaseSelect.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useAccountStore } from '@/stores/account'
import { useFarmStore } from '@/stores/farm'
import { useSettingStore } from '@/stores/setting'
import { useUserStore } from '@/stores/user'

const settingStore = useSettingStore()
const accountStore = useAccountStore()
const farmStore = useFarmStore()
const userStore = useUserStore()

const { settings, loading } = storeToRefs(settingStore)
const { currentAccountId, accounts } = storeToRefs(accountStore)
const { seeds } = storeToRefs(farmStore)

const saving = ref(false)
const passwordSaving = ref(false)
const offlineSaving = ref(false)
const offlineTesting = ref(false)
const adminWxSaving = ref(false)

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
    task: false,
    task_plant: false,
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
    skip_own_weed_bug: false,
  },
})

const automationMasterSwitch = ref(false)

const automationBooleanKeys = [
  'farm',
  'task',
  'task_plant',
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
  'skip_own_weed_bug',
] as const

watch(automationMasterSwitch, (newVal) => {
  for (const key of automationBooleanKeys) {
    localSettings.value.automation[key] = newVal
  }
})

const localOffline = ref({
  channel: 'webhook',
  reloginUrlMode: 'none',
  endpoint: '',
  token: '',
  title: '',
  msg: '',
})

const localAdminWxConfig = ref({
  showWxConfigTab: true,
  showWxLoginTab: true,
  apiBase: 'http://127.0.0.1:8059/api',
  apiKey: '',
  proxyApiUrl: 'https://api.aineishe.com/api/wxnc',
})

const passwordForm = ref({
  old: '',
  new: '',
  confirm: '',
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
    }))

    if (!localSettings.value.automation) {
      localSettings.value.automation = {
        farm: false,
        task: false,
        task_plant: false,
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
        skip_own_weed_bug: false,
      }
    }
    else {
      const defaults = {
        farm: false,
        task: false,
        task_plant: false,
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
        skip_own_weed_bug: false,
      }
      localSettings.value.automation = {
        ...defaults,
        ...localSettings.value.automation,
      }
    }

    automationMasterSwitch.value = automationBooleanKeys.every(
      key => localSettings.value.automation[key] === true,
    )

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
  if (userStore.isAdmin) {
    await loadAdminWxConfig()
  }
}

async function loadAdminWxConfig() {
  try {
    const { data } = await api.get('/api/admin/wx-config')
    if (data?.ok && data?.data) {
      localAdminWxConfig.value = { ...localAdminWxConfig.value, ...data.data }
    }
  }
  catch (e) {
    console.error('加载管理员微信配置失败:', e)
  }
}

async function handleSaveAdminWxConfig() {
  adminWxSaving.value = true
  try {
    const { data } = await api.post('/api/admin/wx-config', localAdminWxConfig.value)
    if (data?.ok) {
      showAlert('管理设置已保存')
    }
    else {
      showAlert(`保存失败: ${data?.error || '未知错误'}`, 'danger')
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '请求失败'
    showAlert(`保存失败: ${msg}`, 'danger')
  }
  finally {
    adminWxSaving.value = false
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
    const best = [...available].sort((a, b) => b.requiredLevel - a.requiredLevel)[0]
    strategyPreviewLabel.value = best ? `${best.requiredLevel}级 ${best.name}` : null
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

async function saveAccountSettings() {
  if (!currentAccountId.value)
    return
  saving.value = true
  try {
    const res = await settingStore.saveSettings(currentAccountId.value, localSettings.value)
    if (res.ok) {
      showAlert('账号设置已保存')
    }
    else {
      showAlert(`保存失败: ${res.error}`, 'danger')
    }
  }
  finally {
    saving.value = false
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

async function handleTestOffline() {
  offlineTesting.value = true
  try {
    const { data } = await api.post('/api/settings/offline-reminder/test', localOffline.value)
    if (data?.ok) {
      showAlert('测试消息发送成功')
    }
    else {
      showAlert(`测试失败: ${data?.error || '未知错误'}`, 'danger')
    }
  }
  catch (e: any) {
    const msg = e?.response?.data?.error || e?.message || '请求失败'
    showAlert(`测试失败: ${msg}`, 'danger')
  }
  finally {
    offlineTesting.value = false
  }
}
</script>

<template>
  <div class="settings-page">
    <div v-if="loading" class="py-4 text-center text-gray-500">
      <div class="i-svg-spinners-ring-resize mx-auto mb-2 text-2xl" />
      <p>加载中...</p>
    </div>

    <div v-else class="grid grid-cols-1 mt-12 gap-4 text-sm lg:grid-cols-2">
      <div v-if="currentAccountId" class="card h-full flex flex-col rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="border-b bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
          <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
            <div class="i-fas-cogs" />
            策略设置
            <span v-if="currentAccountName" class="ml-2 text-sm text-gray-500 font-normal dark:text-gray-400">
              ({{ currentAccountName }})
            </span>
          </h3>
        </div>

        <div class="p-4 space-y-3">
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

        <div class="border-b border-t bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
          <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
            <div class="i-fas-toggle-on" />
            自动控制
          </h3>
        </div>

        <div class="flex-1 p-4 space-y-4">
          <div class="flex items-center gap-4 rounded-lg bg-blue-50 p-3 dark:bg-blue-900/20">
            <BaseSwitch v-model="automationMasterSwitch" label="总控开关" />
            <span class="text-xs text-gray-500 dark:text-gray-400">开启后自动打开所有自动控制开关</span>
          </div>

          <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
            <BaseSwitch v-model="localSettings.automation.farm" label="自动种植收获" />
            <BaseSwitch v-model="localSettings.automation.task" label="自动做任务" />
            <BaseSwitch v-model="localSettings.automation.task_plant" label="按照任务种值" />
            <BaseSwitch v-model="localSettings.automation.sell" label="自动卖果实" />
            <BaseSwitch v-model="localSettings.automation.friend" label="自动好友互动" />
            <BaseSwitch v-model="localSettings.automation.farm_push" label="推送触发巡田" />
            <BaseSwitch v-model="localSettings.automation.land_upgrade" label="自动升级土地" />
            <BaseSwitch v-model="localSettings.automation.fertilizer_gift" label="自动填充化肥" />
            <BaseSwitch v-model="localSettings.automation.fertilizer_buy" label="自动购买化肥" />
            <BaseSwitch v-model="localSettings.automation.skip_own_weed_bug" label="不除自己草虫" />
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
        </div>

        <div class="mt-auto flex justify-end border-t bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/50">
          <BaseButton
            variant="primary"
            size="sm"
            :loading="saving"
            @click="saveAccountSettings"
          >
            保存策略与自动控制
          </BaseButton>
        </div>
      </div>

      <div v-else class="card flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center shadow dark:bg-gray-800">
        <div class="rounded-full bg-gray-50 p-4 dark:bg-gray-700/50">
          <div class="i-carbon-settings-adjust text-4xl text-gray-400 dark:text-gray-500" />
        </div>
        <div class="max-w-xs">
          <h3 class="text-lg text-gray-900 font-medium dark:text-gray-100">
            需要登录账号
          </h3>
          <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
            请先登录账号以配置策略和自动化选项。
          </p>
        </div>
      </div>

      <div class="card h-full flex flex-col rounded-lg bg-white shadow dark:bg-gray-800">
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

      <!-- 管理设置（仅管理员可见） -->
      <div v-if="userStore.isAdmin" class="card h-full flex flex-col rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="border-b bg-gray-50/50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/50">
          <h3 class="flex items-center gap-2 text-base text-gray-900 font-bold dark:text-gray-100">
            <div class="i-carbon-settings" />
            管理设置
          </h3>
        </div>

        <div class="flex-1 p-4 space-y-3">
          <div class="rounded bg-blue-50 p-3 text-sm dark:bg-blue-900/20">
            <p class="text-gray-700 dark:text-gray-300">
              此设置仅管理员可见。关闭微信配置标签但打开微信扫码登录标签时，所有用户将使用管理员设置的微信配置。
            </p>
          </div>

          <div class="grid grid-cols-2 gap-4">
            <BaseSwitch
              v-model="localAdminWxConfig.showWxConfigTab"
              label="显示微信配置标签"
            />
            <BaseSwitch
              v-model="localAdminWxConfig.showWxLoginTab"
              label="显示微信扫码登录标签"
            />
          </div>

          <div class="border-t pt-3 mt-3 space-y-3 dark:border-gray-700">
            <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">
              微信配置（关闭微信配置标签时生效）
            </h4>
            <BaseInput
              v-model="localAdminWxConfig.apiBase"
              label="后端API地址"
              type="text"
              placeholder="http://127.0.0.1:8059/api"
            />
            <BaseInput
              v-model="localAdminWxConfig.apiKey"
              label="API Key（可选）"
              type="text"
              placeholder="第三方API密钥"
            />
            <BaseInput
              v-model="localAdminWxConfig.proxyApiUrl"
              label="第三方API地址"
              type="text"
              placeholder="https://api.aineishe.com/api/wxnc"
            />
            <p class="text-xs text-gray-500 dark:text-gray-400">
              当前使用代理模式，请求将通过后端转发到第三方API。
            </p>
          </div>
        </div>

        <div class="mt-auto flex justify-end border-t bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/50">
          <BaseButton
            variant="primary"
            size="sm"
            :loading="adminWxSaving"
            @click="handleSaveAdminWxConfig"
          >
            保存管理设置
          </BaseButton>
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
