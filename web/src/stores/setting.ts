import type { ApiResult } from '@/api/result'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/api'
import { getErrorMessage } from '@/api/error'
import { unwrapOk } from '@/api/result'

export interface AutomationConfig {
  farm?: boolean
  farm_push?: boolean
  land_upgrade?: boolean
  friend?: boolean
  task_plant?: boolean
  task_plant_first_harvest_radish?: boolean
  event_plant?: boolean
  sell?: boolean
  fertilizer?: string
  clear_own_weed_bug?: boolean
  friend_steal?: boolean
  friend_help?: boolean
  friend_bad?: boolean
  open_server_gift?: boolean
  // 秒收取和蹲守偷菜
  fast_harvest?: boolean
  stakeout_steal?: boolean
  // GUID索引配置
  use_visitor_gids?: boolean
  use_guid_range?: boolean
  guid_range_start?: number
  guid_range_end?: number
  guid_index_current?: number
  guid_index_completed?: boolean
  guid_index_interval?: number
}

export interface IntervalsConfig {
  farm?: number
  friend?: number
  farmMin?: number
  farmMax?: number
  friendMin?: number
  friendMax?: number
  helpMin?: number
  helpMax?: number
  stealMin?: number
  stealMax?: number
}

export interface FriendQuietHoursConfig {
  enabled?: boolean
  start?: string
  end?: string
}

export interface OfflineConfig {
  channel: string
  reloginUrlMode: string
  endpoint: string
  token: string
  title: string
  msg: string
}

export interface UIConfig {
  theme?: string
}

export interface StakeoutStealConfig {
  enabled?: boolean
  delaySec?: number
  maxAheadSec?: number
}

export interface RuntimeConfig {
  serverUrl: string
  clientVersion: string
  os: string
  osVersion: string
  networkType: string
  memory: string
  deviceId: string
}

export interface SettingsState {
  plantingStrategy: string
  preferredSeedId: number
  intervals: IntervalsConfig
  friendQuietHours: FriendQuietHoursConfig
  automation: AutomationConfig
  ui: UIConfig
  offlineReminder: OfflineConfig
  automationSyncEnabled: boolean
  stealDelaySeconds: number
  plantOrderRandom: boolean
  plantDelaySeconds: number
  // 秒收取配置
  fastHarvestAdvanceMs: number
  // 蹲守偷菜配置
  stakeoutSteal: StakeoutStealConfig
  stakeoutFriendList: number[]
}

export const useSettingStore = defineStore('setting', () => {
  const settings = ref<SettingsState>({
    plantingStrategy: 'preferred',
    preferredSeedId: 0,
    intervals: {},
    friendQuietHours: { enabled: false, start: '23:00', end: '07:00' },
    automation: {},
    ui: {},
    offlineReminder: {
      channel: 'webhook',
      reloginUrlMode: 'none',
      endpoint: '',
      token: '',
      title: '账号下线提醒',
      msg: '账号下线',
    },
    automationSyncEnabled: false,
    stealDelaySeconds: 0,
    plantOrderRandom: false,
    plantDelaySeconds: 0,
    // 秒收取默认配置
    fastHarvestAdvanceMs: 200,
    // 蹲守偷菜默认配置
    stakeoutSteal: {
      enabled: false,
      delaySec: 3,
      maxAheadSec: 4 * 3600,
    },
    stakeoutFriendList: [],
  })
  const loading = ref(false)

  async function fetchSettings(accountId: string) {
    if (!accountId)
      return
    loading.value = true
    try {
      const { data } = await api.get('/api/settings', {
        headers: { 'x-account-id': accountId },
      })
      const d = unwrapOk<any>(data as ApiResult<any>, '加载设置失败')
      settings.value.plantingStrategy = d.strategy || 'preferred'
      settings.value.preferredSeedId = d.preferredSeed || 0
      settings.value.intervals = d.intervals || {}
      settings.value.friendQuietHours = d.friendQuietHours || { enabled: false, start: '23:00', end: '07:00' }
      settings.value.automation = d.automation || {}
      settings.value.ui = d.ui || {}
      settings.value.offlineReminder = d.offlineReminder || {
        channel: 'webhook',
        reloginUrlMode: 'none',
        endpoint: '',
        token: '',
        title: '账号下线提醒',
        msg: '账号下线',
      }
      settings.value.automationSyncEnabled = d.automationSyncEnabled ?? false
      settings.value.stealDelaySeconds = d.stealDelaySeconds ?? 0
      settings.value.plantOrderRandom = d.plantOrderRandom ?? false
      settings.value.plantDelaySeconds = d.plantDelaySeconds ?? 0
      // 秒收取配置
      settings.value.fastHarvestAdvanceMs = d.fastHarvestAdvanceMs ?? 200
      // 蹲守偷菜配置
      settings.value.stakeoutSteal = d.stakeoutSteal || {
        enabled: false,
        delaySec: 3,
        maxAheadSec: 4 * 3600,
      }
      settings.value.stakeoutFriendList = d.stakeoutFriendList || []
    }
    finally {
      loading.value = false
    }
  }

  async function saveSettings(accountId: string, newSettings: any) {
    if (!accountId)
      return { ok: false, error: '未选择账号' }
    loading.value = true
    try {
      const settingsPayload = {
        plantingStrategy: newSettings.plantingStrategy,
        preferredSeedId: newSettings.preferredSeedId,
        intervals: newSettings.intervals,
        friendQuietHours: newSettings.friendQuietHours,
        stealDelaySeconds: newSettings.stealDelaySeconds ?? 0,
        plantOrderRandom: newSettings.plantOrderRandom ?? false,
        plantDelaySeconds: newSettings.plantDelaySeconds ?? 0,
        // 秒收取配置
        fastHarvestAdvanceMs: newSettings.fastHarvestAdvanceMs ?? 200,
        // 蹲守偷菜配置
        stakeoutSteal: newSettings.stakeoutSteal || {
          enabled: false,
          delaySec: 3,
          maxAheadSec: 4 * 3600,
        },
        stakeoutFriendList: newSettings.stakeoutFriendList || [],
      }

      await api.post('/api/settings/save', settingsPayload, {
        headers: { 'x-account-id': accountId },
      })

      if (newSettings.automation) {
        await api.post('/api/automation', newSettings.automation, {
          headers: { 'x-account-id': accountId },
        })
      }

      await fetchSettings(accountId)
      return { ok: true }
    }
    finally {
      loading.value = false
    }
  }

  async function saveStrategySettings(accountId: string, strategyData: any) {
    if (!accountId)
      return { ok: false, error: '未选择账号' }
    loading.value = true
    try {
      const settingsPayload = {
        plantingStrategy: strategyData.plantingStrategy,
        preferredSeedId: strategyData.preferredSeedId,
        intervals: strategyData.intervals,
        friendQuietHours: strategyData.friendQuietHours,
        stealDelaySeconds: strategyData.stealDelaySeconds ?? 0,
        plantOrderRandom: strategyData.plantOrderRandom ?? false,
        plantDelaySeconds: strategyData.plantDelaySeconds ?? 0,
      }

      const { data } = await api.post('/api/settings/save', settingsPayload, {
        headers: { 'x-account-id': accountId },
      })

      await fetchSettings(accountId)
      unwrapOk<any>(data as ApiResult<any>, '保存失败')
      return { ok: true }
    }
    catch (e) {
      return { ok: false, error: getErrorMessage(e, '保存失败') }
    }
    finally {
      loading.value = false
    }
  }

  async function saveAutomationSettings(accountId: string, automationData: any) {
    if (!accountId)
      return { ok: false, error: '未选择账号' }
    loading.value = true
    try {
      // 保存自动控制设置
      if (automationData.automation) {
        await api.post('/api/automation', automationData.automation, {
          headers: { 'x-account-id': accountId },
        })
      }

      // 保存秒收取和蹲守偷菜配置（通过 settings/save 接口）
      const extraPayload: any = {}
      if (automationData.fastHarvestAdvanceMs !== undefined) {
        extraPayload.fastHarvestAdvanceMs = automationData.fastHarvestAdvanceMs
      }
      if (automationData.stakeoutSteal) {
        extraPayload.stakeoutSteal = automationData.stakeoutSteal
      }
      if (automationData.stakeoutFriendList) {
        extraPayload.stakeoutFriendList = automationData.stakeoutFriendList
      }

      if (Object.keys(extraPayload).length > 0) {
        await api.post('/api/settings/save', extraPayload, {
          headers: { 'x-account-id': accountId },
        })
      }

      await fetchSettings(accountId)
      return { ok: true }
    }
    finally {
      loading.value = false
    }
  }

  async function saveOfflineConfig(config: OfflineConfig) {
    loading.value = true
    try {
      const { data } = await api.post('/api/settings/offline-reminder', config)
      unwrapOk<any>(data as ApiResult<any>, '保存失败')
      settings.value.offlineReminder = config
      return { ok: true }
    }
    catch (e) {
      return { ok: false, error: getErrorMessage(e, '保存失败') }
    }
    finally {
      loading.value = false
    }
  }

  async function saveRuntimeConfig(config: RuntimeConfig) {
    loading.value = true
    try {
      const { data } = await api.post('/api/settings/runtime-config', config)
      unwrapOk<any>(data as ApiResult<any>, '保存失败')
      return { ok: true }
    }
    catch (e) {
      return { ok: false, error: getErrorMessage(e, '保存失败') }
    }
    finally {
      loading.value = false
    }
  }

  async function setAutomationSyncEnabled(accountId: string, enabled: boolean) {
    if (!accountId)
      return { ok: false, error: '未选择账号' }
    try {
      const { data } = await api.post('/api/user/automation-sync', { enabled, sourceAccountId: accountId }, {
        headers: { 'x-account-id': accountId },
      })
      unwrapOk<any>(data as ApiResult<any>, '保存失败')
      settings.value.automationSyncEnabled = enabled
      return { ok: true }
    }
    catch (e) {
      return { ok: false, error: getErrorMessage(e, '保存失败') }
    }
  }

  return { settings, loading, fetchSettings, saveSettings, saveStrategySettings, saveAutomationSettings, saveOfflineConfig, saveRuntimeConfig, setAutomationSyncEnabled }
})
