<script setup lang="ts">
import type { ApiResult } from '@/api/result'
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import api from '@/api'
import { getErrorMessage } from '@/api/error'
import { unwrapOk } from '@/api/result'
import ConfirmModal from '@/components/ConfirmModal.vue'
import LandGrid from '@/components/LandGrid.vue'
import { useAccountStore } from '@/stores/account'
import { useFriendStore } from '@/stores/friend'
import { useStatusStore } from '@/stores/status'
import { useToastStore } from '@/stores/toast'

const accountStore = useAccountStore()
const friendStore = useFriendStore()
const statusStore = useStatusStore()
const toast = useToastStore()
const { currentAccountId, currentAccount } = storeToRefs(accountStore)
const { friends, loading, friendLands, friendLandsLoading, blacklist, interactRecords, interactLoading, interactError } = storeToRefs(friendStore)
const { status, loading: statusLoading, realtimeConnected, logs: realtimeLogs } = storeToRefs(statusStore)

const showConfirm = ref(false)
const confirmMessage = ref('')
const confirmLoading = ref(false)
const pendingAction = ref<(() => Promise<void>) | null>(null)
const avatarErrorKeys = ref<Set<string>>(new Set())
const searchKeyword = ref('')
const interactFilter = ref('all')
const stakeoutFriendList = ref<number[]>([])
const interactFilters = [
  { key: 'all', label: '全部' },
  { key: 'steal', label: '偷菜' },
  { key: 'help', label: '帮忙' },
  { key: 'bad', label: '捣乱' },
]

const batchLoading = ref(false)
const activeSidebarTab = ref('friends')
const visibleGids = ref<Set<number>>(new Set())
const manualGid = ref('')
const manualHex = ref('')

// 导入黑名单
const importBlacklist = ref<number[]>([])
const importBlacklistLoading = ref(false)
const lastAutoBlacklistSyncAt = ref(0)
const removedFriendsCache = ref<Map<number, any>>(new Map())
const selectedFriendGids = ref<Set<number>>(new Set())
const selectedBlacklistGids = ref<Set<number>>(new Set())
const selectedImportBlacklistGids = ref<Set<number>>(new Set())

function toggleGidVisibility(gid: number) {
  if (visibleGids.value.has(gid)) {
    visibleGids.value.delete(gid)
  }
  else {
    visibleGids.value.add(gid)
  }
}

function maskGid(gid: number | string) {
  const gidStr = String(gid || '')
  if (gidStr.length <= 4) {
    return '*'.repeat(gidStr.length)
  }
  return gidStr.slice(0, 2) + '*'.repeat(gidStr.length - 4) + gidStr.slice(-2)
}

function getDisplayGid(gid: number) {
  if (visibleGids.value.has(gid)) {
    return String(gid)
  }
  return maskGid(gid)
}

function confirmAction(msg: string, action: () => Promise<void>) {
  confirmMessage.value = msg
  pendingAction.value = action
  showConfirm.value = true
}

async function onConfirm() {
  if (pendingAction.value) {
    try {
      confirmLoading.value = true
      await pendingAction.value()
      pendingAction.value = null
      showConfirm.value = false
    }
    finally {
      confirmLoading.value = false
    }
  }
  else {
    showConfirm.value = false
  }
}

const expandedFriends = ref<Set<string>>(new Set())
const visibleFriends = computed(() => {
  return friends.value.filter((friend: any) => {
    const gidNum = Number(friend?.gid || 0)
    return !(gidNum > 0 && importBlacklist.value.includes(gidNum))
  })
})

const filteredFriends = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()
  if (!keyword)
    return visibleFriends.value

  return visibleFriends.value.filter((friend: any) => {
    const name = String(friend?.name || '').toLowerCase()
    const gid = String(friend?.gid || '')
    const uin = String(friend?.uin || '')
    return name.includes(keyword) || gid.includes(keyword) || uin.includes(keyword)
  })
})

const filteredFriendGids = computed(() => {
  return filteredFriends.value
    .map((friend: any) => Number(friend?.gid))
    .filter(gid => Number.isFinite(gid) && gid > 0)
})

const selectedFilteredFriendGids = computed(() => {
  return filteredFriendGids.value.filter(gid => selectedFriendGids.value.has(gid))
})

const allFilteredFriendsSelected = computed(() => {
  return filteredFriendGids.value.length > 0
    && selectedFilteredFriendGids.value.length === filteredFriendGids.value.length
})

const selectedVisibleBlacklistGids = computed(() => {
  return blacklist.value.filter(gid => selectedBlacklistGids.value.has(gid))
})

const allBlacklistSelected = computed(() => {
  return blacklist.value.length > 0
    && selectedVisibleBlacklistGids.value.length === blacklist.value.length
})

const selectedVisibleImportBlacklistGids = computed(() => {
  return importBlacklist.value.filter(gid => selectedImportBlacklistGids.value.has(gid))
})

const allImportBlacklistSelected = computed(() => {
  return importBlacklist.value.length > 0
    && selectedVisibleImportBlacklistGids.value.length === importBlacklist.value.length
})

async function loadFriends() {
  if (currentAccountId.value) {
    const acc = currentAccount.value
    if (!acc)
      return

    if (!realtimeConnected.value) {
      await statusStore.fetchStatus(currentAccountId.value)
    }

    if (acc.running && status.value?.connection?.connected) {
      avatarErrorKeys.value.clear()
      friendStore.fetchFriends(currentAccountId.value)
      friendStore.fetchBlacklist(currentAccountId.value)
      friendStore.fetchInteractRecords(currentAccountId.value)
      // 加载蹲守列表
      loadStakeoutFriends()
      // 加载导入黑名单
      fetchImportBlacklist()
    }
  }
}

// 获取导入黑名单
async function fetchImportBlacklist() {
  if (!currentAccountId.value)
    return
  importBlacklistLoading.value = true
  try {
    const { data } = await api.get('/api/import-blacklist', {
      headers: { 'x-account-id': currentAccountId.value },
    })
    importBlacklist.value = unwrapOk<number[]>(data as ApiResult<number[]>, '加载导入黑名单失败') || []
  }
  catch (e) {
    console.error('加载导入黑名单失败:', e)
    toast.error(`加载导入黑名单失败: ${getErrorMessage(e, '请求失败')}`)
  }
  finally {
    importBlacklistLoading.value = false
  }
}

async function refreshFriendsWithRetry(accountId: string, retry = 0, delayMs = 300) {
  await friendStore.fetchFriends(accountId)
  for (let i = 0; i < retry; i++) {
    await new Promise(resolve => setTimeout(resolve, delayMs))
    await friendStore.fetchFriends(accountId)
  }
}

async function syncBlacklistAndFriendsNow() {
  if (!currentAccountId.value)
    return
  await Promise.all([
    friendStore.fetchFriends(currentAccountId.value),
    friendStore.fetchBlacklist(currentAccountId.value),
    fetchImportBlacklist(),
  ])
}

// 将好友移除到导入黑名单
async function removeFriendToBlacklist(gid: number, shouldRefresh = true, showToast = true) {
  if (!currentAccountId.value)
    return false
  try {
    const removedFriend = friends.value.find((f: any) => Number(f?.gid) === gid)
    if (removedFriend) {
      removedFriendsCache.value.set(gid, removedFriend)
    }
    const { data } = await api.post('/api/friends/remove-to-blacklist', { gid }, {
      headers: { 'x-account-id': currentAccountId.value },
    })
    if (data?.ok) {
      importBlacklist.value = data.data.blacklist || []
      friends.value = friends.value.filter((f: any) => Number(f?.gid) !== gid)
      if (showToast) {
        toast.success('已移除到导入黑名单')
      }
      if (shouldRefresh) {
        await refreshFriendsWithRetry(currentAccountId.value)
      }
      return true
    }
    else {
      if (showToast) {
        toast.error(data?.error || '操作失败')
      }
      return false
    }
  }
  catch (e: any) {
    if (showToast) {
      toast.error(e?.response?.data?.error || '操作失败')
    }
    return false
  }
}

// 从导入黑名单恢复好友
async function restoreFromBlacklist(gid: number, shouldRefresh = true, showToast = true) {
  if (!currentAccountId.value)
    return false
  try {
    const { data } = await api.post('/api/import-blacklist/restore', { gid }, {
      headers: { 'x-account-id': currentAccountId.value },
    })
    if (data?.ok) {
      importBlacklist.value = data.data.blacklist || []
      if (!friends.value.some((f: any) => Number(f?.gid) === gid)) {
        const cached = removedFriendsCache.value.get(gid)
        if (cached)
          friends.value = [cached, ...friends.value]
      }
      if (showToast) {
        toast.success('已恢复到好友列表')
      }
      if (shouldRefresh) {
        await refreshFriendsWithRetry(currentAccountId.value)
      }
      return true
    }
    else {
      if (showToast) {
        toast.error(data?.error || '操作失败')
      }
      return false
    }
  }
  catch (e: any) {
    if (showToast) {
      toast.error(e?.response?.data?.error || '操作失败')
    }
    return false
  }
}

useIntervalFn(() => {
  for (const gid in friendLands.value) {
    if (friendLands.value[gid]) {
      friendLands.value[gid] = friendLands.value[gid].map((l: any) =>
        l.matureInSec > 0 ? { ...l, matureInSec: l.matureInSec - 1 } : l,
      )
    }
  }
}, 1000)

useIntervalFn(async () => {
  if (!currentAccountId.value)
    return
  if (!currentAccount.value?.running || !status.value?.connection?.connected)
    return
  // 在好友列表页不自动刷新，避免滚动位置被重置
  if (activeSidebarTab.value === 'friends')
    return

  await Promise.all([
    friendStore.fetchFriends(currentAccountId.value),
    friendStore.fetchBlacklist(currentAccountId.value),
    fetchImportBlacklist(),
  ])
}, 8000)

onMounted(() => {
  loadFriends()
})

watch(currentAccountId, () => {
  expandedFriends.value.clear()
  selectedFriendGids.value.clear()
  selectedBlacklistGids.value.clear()
  selectedImportBlacklistGids.value.clear()
  loadFriends()
})

watch(() => realtimeLogs.value.length, async () => {
  if (!currentAccountId.value)
    return
  if (!currentAccount.value?.running || !status.value?.connection?.connected)
    return
  // 在好友列表页不自动刷新，避免滚动位置被重置
  if (activeSidebarTab.value === 'friends')
    return

  const last = realtimeLogs.value[realtimeLogs.value.length - 1]
  if (!last)
    return

  const event = String(last?.meta?.event || '')
  const msg = String(last?.msg || '')
  const shouldSync = event === '自动移除非好友'
    || event === '自动加入黑名单'
    || msg.includes('已自动加入好友黑名单')
    || msg.includes('已自动移除并加入导入黑名单')

  if (!shouldSync)
    return

  const now = Date.now()
  if (now - lastAutoBlacklistSyncAt.value < 600)
    return
  lastAutoBlacklistSyncAt.value = now

  await syncBlacklistAndFriendsNow()
})

function toggleFriend(friendId: string) {
  if (expandedFriends.value.has(friendId)) {
    expandedFriends.value.delete(friendId)
  }
  else {
    expandedFriends.value.clear()
    expandedFriends.value.add(friendId)
    if (currentAccountId.value && currentAccount.value?.running && status.value?.connection?.connected) {
      friendStore.fetchFriendLands(currentAccountId.value, friendId)
    }
  }
}

async function handleOp(friendId: string, type: string, e: Event) {
  e.stopPropagation()
  if (!currentAccountId.value)
    return

  confirmAction('确定执行此操作吗?', async () => {
    if (type === 'help') {
      await friendStore.operate(currentAccountId.value!, friendId, 'water')
      await friendStore.operate(currentAccountId.value!, friendId, 'weed')
      await friendStore.operate(currentAccountId.value!, friendId, 'bug')
      return
    }
    await friendStore.operate(currentAccountId.value!, friendId, type)
  })
}

async function handleToggleBlacklist(friend: any, e: Event) {
  e.stopPropagation()
  if (!currentAccountId.value)
    return
  await friendStore.toggleBlacklist(currentAccountId.value, Number(friend.gid))
}

function toggleFriendSelection(gid: number, e: Event) {
  e.stopPropagation()
  if (selectedFriendGids.value.has(gid)) {
    selectedFriendGids.value.delete(gid)
  }
  else {
    selectedFriendGids.value.add(gid)
  }
}

function toggleAllFilteredFriendsSelection() {
  if (allFilteredFriendsSelected.value) {
    filteredFriendGids.value.forEach(gid => selectedFriendGids.value.delete(gid))
    return
  }
  filteredFriendGids.value.forEach(gid => selectedFriendGids.value.add(gid))
}

function toggleBlacklistSelection(gid: number) {
  if (selectedBlacklistGids.value.has(gid)) {
    selectedBlacklistGids.value.delete(gid)
  }
  else {
    selectedBlacklistGids.value.add(gid)
  }
}

function toggleAllBlacklistSelection() {
  if (allBlacklistSelected.value) {
    blacklist.value.forEach(gid => selectedBlacklistGids.value.delete(gid))
    return
  }
  blacklist.value.forEach(gid => selectedBlacklistGids.value.add(gid))
}

function toggleImportBlacklistSelection(gid: number) {
  if (selectedImportBlacklistGids.value.has(gid)) {
    selectedImportBlacklistGids.value.delete(gid)
  }
  else {
    selectedImportBlacklistGids.value.add(gid)
  }
}

function toggleAllImportBlacklistSelection() {
  if (allImportBlacklistSelected.value) {
    importBlacklist.value.forEach(gid => selectedImportBlacklistGids.value.delete(gid))
    return
  }
  importBlacklist.value.forEach(gid => selectedImportBlacklistGids.value.add(gid))
}

function isStakeoutFriend(gid: number) {
  return stakeoutFriendList.value.includes(gid)
}

async function handleToggleStakeout(friend: any, e: Event) {
  e.stopPropagation()
  if (!currentAccountId.value)
    return

  const gid = Number(friend.gid)
  const isCurrentlyStakeout = isStakeoutFriend(gid)

  try {
    if (isCurrentlyStakeout) {
      // 取消蹲守
      const { data } = await api.post('/api/stakeout/friends/remove', {
        friendGid: gid,
      }, {
        headers: { 'x-account-id': currentAccountId.value },
      })
      if (data?.ok) {
        stakeoutFriendList.value = stakeoutFriendList.value.filter(id => id !== gid)
        toast.success(`已将 ${friend.name} 移出蹲守列表`)
      }
    }
    else {
      // 添加蹲守
      const { data } = await api.post('/api/stakeout/friends/add', {
        friendGid: gid,
      }, {
        headers: { 'x-account-id': currentAccountId.value },
      })
      if (data?.ok) {
        stakeoutFriendList.value.push(gid)
        toast.success(`已将 ${friend.name} 加入蹲守列表`)
      }
    }
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || '操作失败')
  }
}

async function loadStakeoutFriends() {
  if (!currentAccountId.value)
    return
  try {
    const { data } = await api.get('/api/stakeout/friends', {
      headers: { 'x-account-id': currentAccountId.value },
    })
    if (data?.ok && data?.data) {
      stakeoutFriendList.value = data.data.friendList || []
    }
  }
  catch (e) {
    console.error('加载蹲守列表失败:', e)
  }
}

function getFriendStatusText(friend: any) {
  const p = friend.plant || {}
  const info = []
  if (p.stealNum)
    info.push(`偷${p.stealNum}`)
  if (p.dryNum)
    info.push(`水${p.dryNum}`)
  if (p.weedNum)
    info.push(`草${p.weedNum}`)
  if (p.insectNum)
    info.push(`虫${p.insectNum}`)
  return info.length ? info.join(' ') : '无操作'
}

function getFriendAvatar(friend: any) {
  const direct = String(friend?.avatarUrl || friend?.avatar_url || '').trim()
  if (direct)
    return direct
  const uin = String(friend?.uin || '').trim()
  if (uin)
    return `https://q1.qlogo.cn/g?b=qq&nk=${uin}&s=100`
  return ''
}

function getFriendAvatarKey(friend: any) {
  const key = String(friend?.gid || friend?.uin || '').trim()
  return key || String(friend?.name || '').trim()
}

function canShowFriendAvatar(friend: any) {
  const key = getFriendAvatarKey(friend)
  if (!key)
    return false
  return !!getFriendAvatar(friend) && !avatarErrorKeys.value.has(key)
}

function handleFriendAvatarError(friend: any) {
  const key = getFriendAvatarKey(friend)
  if (!key)
    return
  avatarErrorKeys.value.add(key)
}

function getFriendNameByGid(gid: number) {
  const friend = friends.value.find((f: any) => Number(f.gid) === gid)
  return friend?.name || `GID:${gid}`
}

function getImportBlacklistProfileByGid(gid: number) {
  const fromFriends = friends.value.find((f: any) => Number(f?.gid) === gid)
  if (fromFriends) {
    return {
      name: String(fromFriends?.name || `GID:${gid}`),
      avatarUrl: getFriendAvatar(fromFriends),
    }
  }

  const fromCache = removedFriendsCache.value.get(gid)
  if (fromCache) {
    return {
      name: String(fromCache?.name || `GID:${gid}`),
      avatarUrl: getFriendAvatar(fromCache),
    }
  }

  const fromInteract = interactRecords.value.find((record: any) => Number(record?.visitorGid) === gid)
  if (fromInteract) {
    return {
      name: String(fromInteract?.nick || `GID:${gid}`),
      avatarUrl: String(fromInteract?.avatarUrl || '').trim(),
    }
  }

  return {
    name: `GID:${gid}`,
    avatarUrl: '',
  }
}

async function handleRemoveFromBlacklist(gid: number) {
  if (!currentAccountId.value)
    return
  await friendStore.toggleBlacklist(currentAccountId.value, gid)
}

async function handleBatchFriendAction(action: 'steal' | 'help' | 'bad' | 'stakeout' | 'blacklist' | 'remove') {
  if (!currentAccountId.value || batchLoading.value)
    return

  const gids = [...selectedFilteredFriendGids.value]
  if (gids.length === 0) {
    toast.error('请先选择好友')
    return
  }

  const actionTextMap: Record<string, string> = {
    steal: '批量偷取',
    help: '批量帮助',
    bad: '批量捣乱',
    stakeout: '批量蹲守',
    blacklist: '批量加黑',
    remove: '批量移除',
  }

  const actionRunnerMap: Record<string, (gid: number) => Promise<void>> = {
    steal: gid => friendStore.operate(currentAccountId.value!, String(gid), 'steal'),
    help: async (gid) => {
      await friendStore.operate(currentAccountId.value!, String(gid), 'water')
      await friendStore.operate(currentAccountId.value!, String(gid), 'weed')
      await friendStore.operate(currentAccountId.value!, String(gid), 'bug')
    },
    bad: gid => friendStore.operate(currentAccountId.value!, String(gid), 'bad'),
    stakeout: async (gid) => {
      if (isStakeoutFriend(gid))
        return
      await api.post('/api/stakeout/friends/add', {
        friendGid: gid,
      }, {
        headers: { 'x-account-id': currentAccountId.value },
      })
      if (!stakeoutFriendList.value.includes(gid)) {
        stakeoutFriendList.value.push(gid)
      }
    },
    blacklist: async (gid) => {
      if (blacklist.value.includes(gid))
        return
      await friendStore.toggleBlacklist(currentAccountId.value!, gid)
    },
    remove: async (gid) => {
      const ok = await removeFriendToBlacklist(gid, false, false)
      if (!ok)
        throw new Error('remove failed')
    },
  }

  const batchAction = async () => {
    batchLoading.value = true
    let successCount = 0
    let failedCount = 0
    try {
      const runner = actionRunnerMap[action]!
      for (const gid of gids) {
        try {
          await runner(gid)
          successCount++
        }
        catch {
          failedCount++
        }
      }
      if (action === 'remove') {
        await refreshFriendsWithRetry(currentAccountId.value!)
      }
      else if (action === 'blacklist') {
        await friendStore.fetchBlacklist(currentAccountId.value!)
      }
      else if (action === 'stakeout') {
        await loadStakeoutFriends()
      }
      else {
        await friendStore.fetchFriends(currentAccountId.value!)
      }
      selectedFriendGids.value.clear()
    }
    finally {
      batchLoading.value = false
    }

    if (failedCount === 0) {
      toast.success(`${actionTextMap[action]}完成，共 ${successCount} 个`)
    }
    else if (successCount > 0) {
      toast.success(`${actionTextMap[action]}完成，成功 ${successCount} 个，失败 ${failedCount} 个`)
    }
    else {
      toast.error(`${actionTextMap[action]}失败`)
    }
  }

  confirmAction(`确定执行${actionTextMap[action]}吗？已选 ${gids.length} 个好友`, batchAction)
}

async function handleBatchRemoveFromBlacklist() {
  if (!currentAccountId.value || batchLoading.value)
    return
  const gids = [...selectedVisibleBlacklistGids.value]
  if (gids.length === 0) {
    toast.error('请先选择黑名单好友')
    return
  }

  const batchAction = async () => {
    batchLoading.value = true
    let successCount = 0
    let failedCount = 0
    try {
      for (const gid of gids) {
        try {
          if (blacklist.value.includes(gid)) {
            await friendStore.toggleBlacklist(currentAccountId.value!, gid)
          }
          successCount++
        }
        catch {
          failedCount++
        }
      }
      await friendStore.fetchBlacklist(currentAccountId.value!)
      selectedBlacklistGids.value.clear()
    }
    finally {
      batchLoading.value = false
    }

    if (failedCount === 0) {
      toast.success(`批量移出黑名单完成，共 ${successCount} 个`)
    }
    else if (successCount > 0) {
      toast.success(`批量移出黑名单完成，成功 ${successCount} 个，失败 ${failedCount} 个`)
    }
    else {
      toast.error('批量移出黑名单失败')
    }
  }

  confirmAction(`确定批量移出黑名单吗？已选 ${gids.length} 个`, batchAction)
}

async function handleBatchRestoreFromImportBlacklist() {
  if (!currentAccountId.value || batchLoading.value)
    return
  const gids = [...selectedVisibleImportBlacklistGids.value]
  if (gids.length === 0) {
    toast.error('请先选择导入黑名单好友')
    return
  }

  const batchAction = async () => {
    batchLoading.value = true
    let successCount = 0
    let failedCount = 0
    try {
      for (const gid of gids) {
        const ok = await restoreFromBlacklist(gid, false, false)
        if (ok)
          successCount++
        else
          failedCount++
      }
      await refreshFriendsWithRetry(currentAccountId.value!)
      selectedImportBlacklistGids.value.clear()
    }
    finally {
      batchLoading.value = false
    }

    if (failedCount === 0) {
      toast.success(`批量恢复完成，共 ${successCount} 个`)
    }
    else if (successCount > 0) {
      toast.success(`批量恢复完成，成功 ${successCount} 个，失败 ${failedCount} 个`)
    }
    else {
      toast.error('批量恢复失败')
    }
  }

  confirmAction(`确定批量恢复吗？已选 ${gids.length} 个`, batchAction)
}

const filteredInteractRecords = computed(() => {
  if (interactFilter.value === 'all')
    return interactRecords.value

  const actionTypeMap: Record<string, number> = {
    steal: 1,
    help: 2,
    bad: 3,
  }
  const targetActionType = actionTypeMap[interactFilter.value] || 0
  return interactRecords.value.filter((record: any) => Number(record?.actionType) === targetActionType)
})

const visibleInteractRecords = computed(() => filteredInteractRecords.value.slice(0, 30))

async function refreshInteractRecords() {
  if (!currentAccountId.value)
    return
  await friendStore.fetchInteractRecords(currentAccountId.value)
}

function getInteractAvatar(record: any) {
  return String(record?.avatarUrl || '').trim()
}

function getInteractAvatarKey(record: any) {
  const key = String(record?.visitorGid || record?.key || record?.nick || '').trim()
  return key ? `interact:${key}` : ''
}

function canShowInteractAvatar(record: any) {
  const key = getInteractAvatarKey(record)
  if (!key)
    return false
  return !!getInteractAvatar(record) && !avatarErrorKeys.value.has(key)
}

function handleInteractAvatarError(record: any) {
  const key = getInteractAvatarKey(record)
  if (!key)
    return
  avatarErrorKeys.value.add(key)
}

function getInteractBadgeClass(actionType: number) {
  if (Number(actionType) === 1)
    return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
  if (Number(actionType) === 2)
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
  if (Number(actionType) === 3)
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
}

function formatInteractTime(timestamp: number) {
  const ts = Number(timestamp) || 0
  if (!ts)
    return '--'

  const date = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const minute = 60 * 1000
  const hour = 60 * minute

  if (diff >= 0 && diff < minute)
    return '刚刚'
  if (diff >= minute && diff < hour)
    return `${Math.floor(diff / minute)} 分钟前`

  const sameDay = now.getFullYear() === date.getFullYear()
    && now.getMonth() === date.getMonth()
    && now.getDate() === date.getDate()

  if (sameDay) {
    return `今天 ${date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })}`
  }

  if (now.getFullYear() === date.getFullYear()) {
    return `${date.getMonth() + 1}-${date.getDate()} ${date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })}`
  }

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

// 解析批量GID输入，支持中英文逗号、空格、换行分隔
function parseBatchGids(input: string): number[] {
  // 统一替换分隔符为英文逗号，支持中英文逗号、空格、换行
  const normalized = input
    .replace(/[，,]/g, ',') // 中英文逗号统一为英文逗号
    .replace(/\s+/g, ',') // 空格、换行等空白字符替换为逗号
    .replace(/,+/g, ',') // 多个连续逗号合并为一个

  const parts = normalized.split(',').filter(s => s.trim())
  const gids: number[] = []

  for (const part of parts) {
    const num = Number(part.trim())
    if (!Number.isNaN(num) && num > 0) {
      // 跳过导入黑名单中的GID
      if (!importBlacklist.value.includes(num)) {
        gids.push(num)
      }
    }
  }

  // 去重
  return [...new Set(gids)]
}

async function handleAddManualGid() {
  if (!currentAccountId.value) {
    toast.error('请选择账号')
    return
  }

  const gidStr = manualGid.value.trim()
  if (!gidStr) {
    toast.error('请输入GID')
    return
  }

  const gids = parseBatchGids(gidStr)
  if (gids.length === 0) {
    toast.error('请输入有效的GID')
    return
  }

  batchLoading.value = true
  try {
    const { data } = await api.post('/api/friends/add', {
      gids,
    }, {
      headers: { 'x-account-id': currentAccountId.value },
    })

    if (data?.ok) {
      const { success = [], failed = [] } = data.results || {}
      if (success.length > 0 && failed.length === 0) {
        toast.success(`成功添加 ${success.length} 个好友`)
      }
      else if (success.length > 0 && failed.length > 0) {
        toast.success(`成功添加 ${success.length} 个，失败 ${failed.length} 个`)
      }
      else {
        toast.error('添加失败')
      }
      manualGid.value = ''
      await friendStore.fetchFriends(currentAccountId.value!)
    }
    else {
      toast.error(data?.error || '添加失败')
    }
  }
  catch (e: any) {
    const status = Number(e?.response?.status || 0)
    if (status === 413) {
      toast.error('Hex内容过大（请求体超限），请精简后重试')
    }
    else {
      toast.error(e?.response?.data?.error || '操作失败')
    }
  }
  finally {
    batchLoading.value = false
  }
}

async function handleAddManualHex() {
  if (!currentAccountId.value) {
    toast.error('请选择账号')
    return
  }

  const hex = manualHex.value.trim()
  if (!hex) {
    toast.error('请输入Hex')
    return
  }

  batchLoading.value = true
  try {
    const { data } = await api.post('/api/friends/add-hex', {
      hex,
    }, {
      headers: { 'x-account-id': currentAccountId.value },
    })

    if (data?.ok) {
      const { success = [], failed = [] } = data.results || {}
      if (success.length > 0 && failed.length === 0) {
        toast.success(`Hex添加成功 ${success.length} 个`)
      }
      else if (success.length > 0 && failed.length > 0) {
        toast.success(`Hex添加成功 ${success.length} 个，失败 ${failed.length} 个`)
      }
      else {
        toast.error(data?.error || 'Hex添加失败')
      }
      manualHex.value = ''
      await friendStore.fetchFriends(currentAccountId.value!)
    }
    else {
      toast.error(data?.error || 'Hex添加失败')
    }
  }
  catch (e: any) {
    toast.error(e?.response?.data?.error || '操作失败')
  }
  finally {
    batchLoading.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap border-b border-gray-200 dark:border-gray-700">
      <button
        class="flex-1 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors"
        :class="activeSidebarTab === 'friends'
          ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeSidebarTab = 'friends'"
      >
        <div class="flex flex-col items-center justify-center space-y-1 sm:flex-row sm:space-x-2 sm:space-y-0">
          <div class="i-carbon-user-multiple text-xl" />
          <span class="whitespace-normal text-center">好友</span>
        </div>
      </button>
      <button
        class="flex-1 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors"
        :class="activeSidebarTab === 'blacklist'
          ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeSidebarTab = 'blacklist'"
      >
        <div class="flex flex-col items-center justify-center space-y-1 sm:flex-row sm:space-x-2 sm:space-y-0">
          <div class="i-carbon-subtract-alt text-xl" />
          <div class="flex items-center">
            <span class="whitespace-normal text-center">黑名单</span>
            <span v-if="blacklist.length" class="ml-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] text-red-700 dark:bg-red-900/50 dark:text-red-300">
              {{ blacklist.length }}
            </span>
          </div>
        </div>
      </button>
      <button
        class="flex-1 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors"
        :class="activeSidebarTab === 'visitors'
          ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeSidebarTab = 'visitors'"
      >
        <div class="flex flex-col items-center justify-center space-y-1 sm:flex-row sm:space-x-2 sm:space-y-0">
          <div class="i-carbon-view text-xl" />
          <div class="flex items-center">
            <span class="whitespace-normal text-center">访客</span>
            <span v-if="interactRecords.length" class="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
              {{ interactRecords.length }}
            </span>
          </div>
        </div>
      </button>
      <button
        class="flex-1 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors"
        :class="activeSidebarTab === 'importBlacklist'
          ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeSidebarTab = 'importBlacklist'"
      >
        <div class="flex flex-col items-center justify-center space-y-1 sm:flex-row sm:space-x-2 sm:space-y-0">
          <div class="i-carbon-download text-xl" />
          <div class="flex items-center">
            <span class="whitespace-normal text-center">导入黑名单</span>
            <span v-if="importBlacklist.length" class="ml-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] text-red-700 dark:bg-red-900/50 dark:text-red-300">
              {{ importBlacklist.length }}
            </span>
          </div>
        </div>
      </button>
    </div>

    <div>
      <!-- 好友列表 -->
      <div v-if="activeSidebarTab === 'friends'">
        <div class="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-center sm:justify-between">
          <h3 class="text-xl text-gray-900 font-bold dark:text-white">
            好友列表
          </h3>
          <div class="w-full flex flex-col gap-2 sm:w-auto sm:flex-row sm:items-center sm:gap-3">
            <div class="relative w-full sm:w-auto">
              <div class="i-carbon-search absolute left-3 top-1/2 text-sm text-gray-400 -translate-y-1/2 dark:text-gray-500" />
              <input
                v-model="searchKeyword"
                type="text"
                placeholder="搜索好友..."
                class="w-full border border-gray-300 rounded-lg bg-white py-2 pl-10 pr-4 text-sm sm:w-64 dark:border-gray-600 focus:border-blue-500 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
            </div>
            <div v-if="visibleFriends.length" class="text-xs text-gray-500 sm:text-sm dark:text-gray-400">
              共 {{ filteredFriends.length }}/{{ visibleFriends.length }} 名好友
            </div>
          </div>
        </div>

        <div v-if="status?.connection?.connected && currentAccountId" class="mb-5 sm:mb-6">
          <div class="flex flex-wrap gap-2 rounded-xl bg-white p-3.5 shadow dark:bg-gray-800">
            <span class="w-full flex items-center text-xs text-gray-500 sm:w-auto sm:text-sm dark:text-gray-400">批量操作：</span>
            <button
              class="h-10 min-w-[calc(50%-0.25rem)] flex-1 rounded bg-gray-100 px-3 py-2 text-sm text-gray-700 transition sm:h-auto sm:min-w-0 sm:flex-none disabled:cursor-not-allowed dark:bg-gray-700 hover:bg-gray-200 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-600"
              :disabled="batchLoading || filteredFriendGids.length === 0"
              @click="toggleAllFilteredFriendsSelection"
            >
              <div v-if="batchLoading" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
              {{ allFilteredFriendsSelected ? '取消全选' : '全选' }}
            </button>
            <button
              class="h-10 min-w-[calc(50%-0.25rem)] flex-1 rounded bg-blue-100 px-3 py-2 text-sm text-blue-700 transition sm:h-auto sm:min-w-0 sm:flex-none dark:bg-blue-900/30 hover:bg-blue-200 dark:text-blue-400 disabled:opacity-50 dark:hover:bg-blue-900/50"
              :disabled="batchLoading || selectedFilteredFriendGids.length === 0"
              @click="handleBatchFriendAction('steal')"
            >
              <div v-if="batchLoading" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
              批量偷取
            </button>
            <button
              class="h-10 min-w-[calc(50%-0.25rem)] flex-1 rounded bg-green-100 px-3 py-2 text-sm text-green-700 transition sm:h-auto sm:min-w-0 sm:flex-none dark:bg-green-900/30 hover:bg-green-200 dark:text-green-400 disabled:opacity-50 dark:hover:bg-green-900/50"
              :disabled="batchLoading || selectedFilteredFriendGids.length === 0"
              @click="handleBatchFriendAction('help')"
            >
              <div v-if="batchLoading" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
              批量帮助
            </button>
            <button
              class="h-10 min-w-[calc(50%-0.25rem)] flex-1 rounded bg-red-100 px-3 py-2 text-sm text-red-700 transition sm:h-auto sm:min-w-0 sm:flex-none dark:bg-red-900/30 hover:bg-red-200 dark:text-red-400 disabled:opacity-50 dark:hover:bg-red-900/50"
              :disabled="batchLoading || selectedFilteredFriendGids.length === 0"
              @click="handleBatchFriendAction('bad')"
            >
              <div v-if="batchLoading" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
              批量捣乱
            </button>
            <button
              class="h-10 min-w-[calc(50%-0.25rem)] flex-1 rounded bg-purple-100 px-3 py-2 text-sm text-purple-700 transition sm:h-auto sm:min-w-0 sm:flex-none dark:bg-purple-900/30 hover:bg-purple-200 dark:text-purple-400 disabled:opacity-50 dark:hover:bg-purple-900/50"
              :disabled="batchLoading || selectedFilteredFriendGids.length === 0"
              @click="handleBatchFriendAction('stakeout')"
            >
              <div v-if="batchLoading" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
              批量蹲守
            </button>
            <button
              class="h-10 min-w-[calc(50%-0.25rem)] flex-1 rounded bg-gray-100 px-3 py-2 text-sm text-gray-700 transition sm:h-auto sm:min-w-0 sm:flex-none dark:bg-gray-700/50 hover:bg-gray-200 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-700"
              :disabled="batchLoading || selectedFilteredFriendGids.length === 0"
              @click="handleBatchFriendAction('blacklist')"
            >
              <div v-if="batchLoading" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
              批量加黑
            </button>
            <button
              class="h-10 min-w-[calc(50%-0.25rem)] flex-1 rounded bg-red-100 px-3 py-2 text-sm text-red-700 transition sm:h-auto sm:min-w-0 sm:flex-none dark:bg-red-900/30 hover:bg-red-200 dark:text-red-400 disabled:opacity-50 dark:hover:bg-red-900/50"
              :disabled="batchLoading || selectedFilteredFriendGids.length === 0"
              @click="handleBatchFriendAction('remove')"
            >
              <div v-if="batchLoading" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
              批量移除
            </button>
            <span class="w-full self-center text-xs text-gray-400 sm:w-auto">
              已选 {{ selectedFilteredFriendGids.length }}/{{ filteredFriendGids.length }}
            </span>
          </div>
          <div class="mt-3 flex flex-wrap gap-2 rounded-xl bg-white p-3.5 shadow dark:bg-gray-800">
            <span class="w-full flex items-center text-xs text-gray-500 sm:w-auto sm:text-sm dark:text-gray-400">手动添加：</span>
            <textarea
              v-model="manualGid"
              placeholder="输入好友GID，支持批量（用逗号、空格或换行分隔）"
              rows="2"
              class="w-full resize-none border border-gray-300 rounded-lg bg-white px-4 py-2 text-sm sm:w-64 dark:border-gray-600 focus:border-blue-500 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              :disabled="batchLoading"
              class="h-10 w-full rounded bg-purple-100 px-3 py-2 text-sm text-purple-700 transition sm:h-auto sm:w-auto disabled:cursor-not-allowed dark:bg-purple-900/30 hover:bg-purple-200 dark:text-purple-400 disabled:opacity-50 dark:hover:bg-purple-900/50"
              @click="handleAddManualGid"
            >
              {{ batchLoading ? '添加中...' : '添加好友' }}
            </button>
            <span class="mt-1 w-full flex items-center text-xs text-gray-500 sm:mt-0 sm:w-auto sm:text-sm dark:text-gray-400">Hex添加：</span>
            <textarea
              v-model="manualHex"
              placeholder="粘贴好友Protobuf Hex，自动解析gid/头像/昵称并导入"
              rows="2"
              class="w-full resize-none border border-gray-300 rounded-lg bg-white px-4 py-2 text-sm sm:w-96 dark:border-gray-600 focus:border-blue-500 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              :disabled="batchLoading"
              class="h-10 w-full rounded bg-amber-100 px-3 py-2 text-sm text-amber-700 transition sm:h-auto sm:w-auto disabled:cursor-not-allowed dark:bg-amber-900/30 hover:bg-amber-200 dark:text-amber-400 disabled:opacity-50 dark:hover:bg-amber-900/50"
              @click="handleAddManualHex"
            >
              {{ batchLoading ? '添加中...' : 'Hex添加' }}
            </button>
          </div>
        </div>

        <div v-if="loading || statusLoading" class="flex justify-center py-12">
          <div class="i-carbon-circle-dash animate-spin text-4xl text-blue-500" />
        </div>

        <div v-else-if="!currentAccountId" class="rounded-lg bg-white p-8 text-center text-gray-500 shadow dark:bg-gray-800">
          请选择账号后查看好友
        </div>

        <div v-else-if="!status?.connection?.connected" class="flex flex-col items-center justify-center gap-4 rounded-lg bg-white p-12 text-center text-gray-500 shadow dark:bg-gray-800">
          <div class="i-carbon-plug text-4xl text-gray-400" />
          <div>
            <div class="text-lg text-gray-700 font-medium dark:text-gray-300">
              账号未登录
            </div>
            <div class="mt-1 text-sm text-gray-400">
              请先运行账号或检查网络连接
            </div>
          </div>
        </div>

        <div v-else-if="friends.length === 0" class="rounded-lg bg-white p-8 text-center text-gray-500 shadow dark:bg-gray-800">
          暂无好友或数据加载失败
        </div>

        <div v-else class="space-y-4">
          <div
            v-for="friend in filteredFriends"
            :key="friend.gid"
            class="overflow-hidden rounded-xl bg-white shadow dark:bg-gray-800"
          >
            <div
              class="flex flex-col cursor-pointer justify-between gap-3 p-3 transition sm:flex-row sm:items-center sm:gap-4 hover:bg-gray-50 sm:p-4 dark:hover:bg-gray-700/50"
              :class="blacklist.includes(Number(friend.gid)) ? 'opacity-50' : ''"
              @click="toggleFriend(friend.gid)"
            >
              <div class="min-w-0 flex items-center gap-3">
                <input
                  type="checkbox"
                  class="h-4 w-4 cursor-pointer border-gray-300 rounded text-blue-600 focus:ring-blue-500"
                  :checked="selectedFriendGids.has(Number(friend.gid))"
                  @click.stop
                  @change="toggleFriendSelection(Number(friend.gid), $event)"
                >
                <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-1 ring-gray-100 dark:bg-gray-600 dark:ring-gray-700">
                  <img
                    v-if="canShowFriendAvatar(friend)"
                    :src="getFriendAvatar(friend)"
                    class="h-full w-full object-cover"
                    loading="lazy"
                    @error="handleFriendAvatarError(friend)"
                  >
                  <div v-else class="text-gray-400">
                    <div class="i-carbon-user-avatar text-lg" />
                  </div>
                </div>
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2 text-sm font-bold sm:text-base">
                    <span class="max-w-[10rem] truncate sm:max-w-none">{{ friend.name }}</span>
                    <span class="text-gray-500">({{ friend.gid }})</span>
                    <span v-if="blacklist.includes(Number(friend.gid))" class="rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">已屏蔽</span>
                  </div>
                  <div class="text-sm" :class="getFriendStatusText(friend) !== '无操作' ? 'text-green-500 font-medium' : 'text-gray-400'">
                    {{ getFriendStatusText(friend) }}
                  </div>
                </div>
              </div>

              <div class="grid grid-cols-3 w-full gap-2 sm:w-auto sm:flex sm:flex-wrap">
                <button
                  class="h-9 w-full rounded bg-blue-100 px-3 py-2 text-[13px] text-blue-700 transition sm:h-auto sm:w-auto dark:bg-blue-900/30 hover:bg-blue-200 sm:text-sm dark:text-blue-400 dark:hover:bg-blue-900/50"
                  @click="handleOp(friend.gid, 'steal', $event)"
                >
                  偷取
                </button>
                <button
                  class="h-9 w-full rounded bg-green-100 px-3 py-2 text-[13px] text-green-700 transition sm:h-auto sm:w-auto dark:bg-green-900/30 hover:bg-green-200 sm:text-sm dark:text-green-400 dark:hover:bg-green-900/50"
                  @click="handleOp(friend.gid, 'help', $event)"
                >
                  帮助
                </button>
                <button
                  class="h-9 w-full rounded bg-red-100 px-3 py-2 text-[13px] text-red-700 transition sm:h-auto sm:w-auto dark:bg-red-900/30 hover:bg-red-200 sm:text-sm dark:text-red-400 dark:hover:bg-red-900/50"
                  @click="handleOp(friend.gid, 'bad', $event)"
                >
                  捣乱
                </button>
                <button
                  class="h-9 w-full rounded bg-purple-100 px-3 py-2 text-[13px] text-purple-700 transition sm:h-auto sm:w-auto dark:bg-purple-900/30 hover:bg-purple-200 sm:text-sm dark:text-purple-400 dark:hover:bg-purple-900/50"
                  @click="handleToggleStakeout(friend, $event)"
                >
                  {{ isStakeoutFriend(Number(friend.gid)) ? '取消蹲守' : '蹲守' }}
                </button>
                <button
                  class="h-9 w-full rounded px-3 py-2 text-[13px] transition sm:h-auto sm:w-auto sm:text-sm"
                  :class="blacklist.includes(Number(friend.gid))
                    ? 'bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-700/50 dark:text-gray-400 dark:hover:bg-gray-700'"
                  @click="handleToggleBlacklist(friend, $event)"
                >
                  {{ blacklist.includes(Number(friend.gid)) ? '移出黑名单' : '加入黑名单' }}
                </button>
                <button
                  class="h-9 w-full rounded bg-red-100 px-3 py-2 text-[13px] text-red-700 transition sm:h-auto sm:w-auto dark:bg-red-900/30 hover:bg-red-200 sm:text-sm dark:text-red-400 dark:hover:bg-red-900/50"
                  @click="removeFriendToBlacklist(Number(friend.gid))"
                >
                  移除
                </button>
              </div>
            </div>

            <div v-if="expandedFriends.has(friend.gid)" class="border-t bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
              <div v-if="friendLandsLoading[friend.gid]" class="flex justify-center py-4">
                <div class="i-svg-spinners-90-ring-with-bg text-2xl text-blue-500" />
              </div>
              <div v-else-if="!friendLands[friend.gid] || friendLands[friend.gid]?.length === 0" class="py-4 text-center text-gray-500">
                无土地数据
              </div>
              <div v-else class="p-2">
                <LandGrid :lands="friendLands[friend.gid] || []" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 黑名单管理 -->
      <div v-if="activeSidebarTab === 'blacklist'">
        <div class="mb-6">
          <h3 class="text-xl text-gray-900 font-bold dark:text-white">
            好友黑名单
          </h3>
          <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
            加入黑名单的好友在自动偷菜和帮助时会被跳过。
          </p>
        </div>

        <div class="rounded-xl bg-white p-4 shadow dark:bg-gray-800 sm:p-6">
          <div class="mb-4 flex flex-wrap items-center gap-2">
            <button
              class="min-w-[calc(50%-0.25rem)] flex-1 rounded bg-gray-100 px-3 py-2 text-sm text-gray-700 transition sm:min-w-0 sm:flex-none disabled:cursor-not-allowed dark:bg-gray-700 hover:bg-gray-200 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-600"
              :disabled="batchLoading || blacklist.length === 0"
              @click="toggleAllBlacklistSelection"
            >
              {{ allBlacklistSelected ? '取消全选' : '全选' }}
            </button>
            <button
              class="min-w-[calc(50%-0.25rem)] flex-1 rounded bg-red-100 px-3 py-2 text-sm text-red-700 transition sm:min-w-0 sm:flex-none disabled:cursor-not-allowed dark:bg-red-900/30 hover:bg-red-200 dark:text-red-400 disabled:opacity-50 dark:hover:bg-red-900/50"
              :disabled="batchLoading || selectedVisibleBlacklistGids.length === 0"
              @click="handleBatchRemoveFromBlacklist"
            >
              <div v-if="batchLoading" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
              批量移出黑名单
            </button>
            <span class="w-full text-xs text-gray-400 sm:w-auto">
              已选 {{ selectedVisibleBlacklistGids.length }}/{{ blacklist.length }}
            </span>
          </div>
          <div v-if="blacklist.length === 0" class="py-8 text-center text-gray-500 dark:text-gray-400">
            暂无黑名单好友
          </div>
          <div v-else class="space-y-4">
            <div
              v-for="gid in blacklist"
              :key="gid"
              class="flex cursor-pointer items-center justify-between gap-3 border border-gray-100 rounded-lg p-3 transition sm:gap-4 dark:border-gray-700 hover:bg-gray-50 sm:p-4 dark:hover:bg-gray-700/50"
            >
              <div class="min-w-0 flex items-center gap-3">
                <input
                  type="checkbox"
                  class="h-4 w-4 cursor-pointer border-gray-300 rounded text-blue-600 focus:ring-blue-500"
                  :checked="selectedBlacklistGids.has(gid)"
                  @click.stop="toggleBlacklistSelection(gid)"
                >
                <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-1 ring-gray-100 dark:bg-gray-600 dark:ring-gray-700">
                  <img
                    v-if="canShowFriendAvatar(friends.find(f => Number(f.gid) === gid))"
                    :src="getFriendAvatar(friends.find(f => Number(f.gid) === gid))"
                    class="h-full w-full object-cover"
                    loading="lazy"
                    @error="handleFriendAvatarError(friends.find(f => Number(f.gid) === gid))"
                  >
                  <div v-else class="text-gray-400">
                    <div class="i-carbon-user-avatar text-lg" />
                  </div>
                </div>
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2 font-bold">
                    {{ getFriendNameByGid(gid) }}
                    <span class="rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">已屏蔽</span>
                  </div>
                  <div class="text-sm text-gray-400">
                    GID: {{ gid }}
                  </div>
                </div>
              </div>

              <button
                class="h-9 shrink-0 rounded bg-red-100 px-3 py-2 text-sm text-red-700 transition dark:bg-red-900/30 hover:bg-red-200 dark:text-red-400 dark:hover:bg-red-900/50"
                @click="handleRemoveFromBlacklist(gid)"
              >
                移出黑名单
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- 最近访客 -->
      <div v-if="activeSidebarTab === 'visitors'">
        <div class="mb-6">
          <h3 class="text-xl text-gray-900 font-bold dark:text-white">
            最近访客
          </h3>
        </div>

        <div class="rounded-xl bg-white p-4 shadow dark:bg-gray-800 sm:p-6">
          <div class="mb-4 flex flex-wrap items-center gap-2">
            <button
              v-for="item in interactFilters"
              :key="item.key"
              class="rounded-full px-3 py-1 text-xs transition"
              :class="interactFilter === item.key
                ? 'bg-amber-500 text-white'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'"
              @click="interactFilter = item.key"
            >
              {{ item.label }}
            </button>
            <button
              class="rounded bg-gray-100 px-3 py-1.5 text-xs text-gray-600 transition disabled:cursor-not-allowed dark:bg-gray-700 hover:bg-gray-200 dark:text-gray-300 disabled:opacity-60 dark:hover:bg-gray-600"
              :disabled="interactLoading"
              @click="refreshInteractRecords"
            >
              {{ interactLoading ? '刷新中...' : '刷新' }}
            </button>
          </div>

          <div v-if="interactLoading" class="flex justify-center py-6">
            <div class="i-svg-spinners-90-ring-with-bg text-2xl text-amber-500" />
          </div>
          <div v-else-if="!!interactError" class="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-300">
            {{ interactError }}
          </div>
          <div v-else-if="visibleInteractRecords.length === 0" class="py-8 text-center text-gray-500 dark:text-gray-400">
            暂无访客记录
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="record in visibleInteractRecords"
              :key="record.key"
              class="flex items-start gap-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40"
            >
              <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-1 ring-gray-100 dark:bg-gray-700 dark:ring-gray-600">
                <img
                  v-if="canShowInteractAvatar(record)"
                  :src="getInteractAvatar(record)"
                  class="h-full w-full object-cover"
                  loading="lazy"
                  @error="handleInteractAvatarError(record)"
                >
                <div v-else class="text-gray-400">
                  <div class="i-carbon-user-avatar text-lg" />
                </div>
              </div>
              <div class="min-w-0 flex-1">
                <div class="mb-1 flex flex-wrap items-center gap-2">
                  <span class="max-w-full truncate text-sm text-gray-800 font-medium dark:text-gray-100">
                    {{ record.nick || `GID:${record.visitorGid}` }}
                  </span>
                  <span
                    class="rounded-full px-2 py-0.5 text-xs font-medium"
                    :class="getInteractBadgeClass(record.actionType)"
                  >
                    {{ record.actionLabel }}
                  </span>
                  <span v-if="record.level" class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                    Lv.{{ record.level }}
                  </span>
                  <span v-if="record.visitorGid" class="text-xs text-gray-400">
                    GID {{ getDisplayGid(record.visitorGid) }}
                    <button
                      class="ml-1 cursor-pointer opacity-60 hover:opacity-100"
                      @click.stop="toggleGidVisibility(record.visitorGid)"
                    >
                      <span v-if="visibleGids.has(record.visitorGid)" class="i-carbon-view inline-block align-middle" />
                      <span v-else class="i-carbon-view-off inline-block align-middle" />
                    </button>
                  </span>
                </div>
                <div class="text-sm text-gray-600 dark:text-gray-300">
                  {{ record.actionDetail || record.actionLabel }}
                </div>
              </div>
              <div class="shrink-0 text-right text-xs text-gray-400">
                {{ formatInteractTime(record.serverTimeMs) }}
              </div>
            </div>

            <div v-if="filteredInteractRecords.length > visibleInteractRecords.length" class="text-center text-xs text-gray-400">
              仅展示最近 {{ visibleInteractRecords.length }} 条
            </div>
          </div>
        </div>
      </div>

      <!-- 导入黑名单 -->
      <div v-if="activeSidebarTab === 'importBlacklist'">
        <div class="mb-6">
          <h3 class="text-xl text-gray-900 font-bold dark:text-white">
            导入黑名单
          </h3>
          <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
            在导入黑名单中的GID将被跳过，不会添加到好友列表。删除后可恢复。
          </p>
        </div>

        <div class="rounded-xl bg-white p-4 shadow dark:bg-gray-800 sm:p-6">
          <div class="mb-4 flex flex-wrap items-center gap-2">
            <button
              class="min-w-[calc(50%-0.25rem)] flex-1 rounded bg-gray-100 px-3 py-2 text-sm text-gray-700 transition sm:min-w-0 sm:flex-none disabled:cursor-not-allowed dark:bg-gray-700 hover:bg-gray-200 dark:text-gray-300 disabled:opacity-50 dark:hover:bg-gray-600"
              :disabled="batchLoading || importBlacklist.length === 0"
              @click="toggleAllImportBlacklistSelection"
            >
              {{ allImportBlacklistSelected ? '取消全选' : '全选' }}
            </button>
            <button
              class="min-w-[calc(50%-0.25rem)] flex-1 rounded bg-green-100 px-3 py-2 text-sm text-green-700 transition sm:min-w-0 sm:flex-none disabled:cursor-not-allowed dark:bg-green-900/30 hover:bg-green-200 dark:text-green-400 disabled:opacity-50 dark:hover:bg-green-900/50"
              :disabled="batchLoading || selectedVisibleImportBlacklistGids.length === 0"
              @click="handleBatchRestoreFromImportBlacklist"
            >
              <div v-if="batchLoading" class="i-svg-spinners-90-ring-with-bg mr-1 inline-block align-text-bottom" />
              批量恢复
            </button>
            <span class="w-full text-xs text-gray-400 sm:w-auto">
              已选 {{ selectedVisibleImportBlacklistGids.length }}/{{ importBlacklist.length }}
            </span>
          </div>
          <div v-if="importBlacklistLoading" class="flex justify-center py-8">
            <div class="i-carbon-circle-dash animate-spin text-4xl text-blue-500" />
          </div>
          <div v-else-if="importBlacklist.length === 0" class="py-8 text-center text-gray-500 dark:text-gray-400">
            暂无导入黑名单
          </div>
          <div v-else class="space-y-4">
            <div
              v-for="gid in importBlacklist"
              :key="gid"
              class="flex cursor-pointer items-center justify-between gap-3 border border-gray-100 rounded-lg p-3 transition sm:gap-4 dark:border-gray-700 hover:bg-gray-50 sm:p-4 dark:hover:bg-gray-700/50"
            >
              <div class="min-w-0 flex items-center gap-3">
                <input
                  type="checkbox"
                  class="h-4 w-4 cursor-pointer border-gray-300 rounded text-blue-600 focus:ring-blue-500"
                  :checked="selectedImportBlacklistGids.has(gid)"
                  @click.stop="toggleImportBlacklistSelection(gid)"
                >
                <div class="h-10 w-10 flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-200 ring-1 ring-gray-100 dark:bg-gray-600 dark:ring-gray-700">
                  <img
                    v-if="getImportBlacklistProfileByGid(gid).avatarUrl"
                    :src="getImportBlacklistProfileByGid(gid).avatarUrl"
                    class="h-full w-full object-cover"
                    loading="lazy"
                  >
                  <span v-else class="i-carbon-user-avatar text-lg text-gray-400" />
                </div>
                <div class="min-w-0">
                  <div class="text-base text-gray-900 font-medium dark:text-white">
                    {{ getImportBlacklistProfileByGid(gid).name }}
                  </div>
                  <div class="text-sm text-gray-400">
                    GID: {{ getDisplayGid(gid) }}
                    <button
                      class="ml-1 cursor-pointer opacity-60 hover:opacity-100"
                      @click.stop="toggleGidVisibility(gid)"
                    >
                      <span v-if="visibleGids.has(gid)" class="i-carbon-view inline-block align-middle" />
                      <span v-else class="i-carbon-view-off inline-block align-middle" />
                    </button>
                  </div>
                </div>
              </div>
              <div class="ml-auto flex items-center gap-2">
                <button
                  class="h-9 shrink-0 rounded bg-green-100 px-3 py-1.5 text-sm text-green-700 transition dark:bg-green-900/30 hover:bg-green-200 dark:text-green-400 dark:hover:bg-green-900/50"
                  @click.stop="restoreFromBlacklist(gid)"
                >
                  恢复
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <ConfirmModal
      :show="showConfirm"
      :loading="confirmLoading"
      title="确认操作"
      :message="confirmMessage"
      @confirm="onConfirm"
      @cancel="!confirmLoading && (showConfirm = false)"
    />
  </div>
</template>
