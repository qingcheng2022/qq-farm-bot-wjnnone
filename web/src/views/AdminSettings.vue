<script setup lang="ts">
import type { Card } from '@/stores/user'
import { computed, onMounted, ref } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseSwitch from '@/components/ui/BaseSwitch.vue'
import { useToastStore } from '@/stores/toast'
import { useUserStore } from '@/stores/user'
import { copyTextToClipboard } from '@/utils'

const userStore = useUserStore()
const toast = useToastStore()

// 当前激活的标签页
const activeTab = ref<'cards' | 'users' | 'oauth' | 'wx'>('cards')

// ============ 卡密管理 ============
const cards = ref<Card[]>([])
const cardsLoading = ref(false)
const showCreateModal = ref(false)

const newCard = ref({
  description: '',
  type: 'days' as 'days' | 'quota',
  days: 30,
  quota: 1,
  count: 1,
})

const selectedCards = ref<Set<string>>(new Set())
const selectAll = ref(false)
const cardTypeFilter = ref<'all' | 'days' | 'quota'>('all')
const searchQuery = ref('')
const filterStatus = ref<'all' | 'used' | 'unused' | 'enabled' | 'disabled'>('all')

const filteredCards = computed(() => {
  let result = cards.value
  if (cardTypeFilter.value !== 'all') {
    result = result.filter(card => (card.type || 'days') === cardTypeFilter.value)
  }
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    result = result.filter(card =>
      card.code.toLowerCase().includes(query)
      || card.description.toLowerCase().includes(query)
      || (card.usedBy && card.usedBy.toLowerCase().includes(query)),
    )
  }
  switch (filterStatus.value) {
    case 'used':
      result = result.filter(card => card.usedBy)
      break
    case 'unused':
      result = result.filter(card => !card.usedBy)
      break
    case 'enabled':
      result = result.filter(card => card.enabled)
      break
    case 'disabled':
      result = result.filter(card => !card.enabled)
      break
  }
  return result
})

// ============ 用户管理 ============
interface UserRow {
  username: string
  password: string
  role: string
  card: any | null
}

const users = ref<UserRow[]>([])
const usersLoading = ref(false)
const showEditModal = ref(false)
const selectedUser = ref<UserRow | null>(null)
const editExpiresAt = ref<number | null>(null)
const editQuota = ref<number>(3)
const editExpiresAtInput = ref<string>('')

// ============ 聚合登录配置 ============
const oauthConfig = ref({
  enabled: false,
  apiUrl: '',
  appId: '',
  appKey: '',
})
const oauthSaving = ref(false)

const oauthUserDefault = ref({
  days: 30,
  quota: 0,
})

const cardRegisterDefault = ref({
  quota: 3,
})

// ============ 微信全局配置 ============
const wxConfig = ref({
  showWxConfigTab: true,
  showWxLoginTab: true,
  apiBase: 'http://127.0.0.1:8059/api',
  apiKey: '',
  proxyApiUrl: 'https://api.aineishe.com/api/wxnc',
})
const wxSaving = ref(false)

// ============ 通用函数 ============
function formatDate(timestamp: number | null) {
  if (!timestamp)
    return '-'
  return new Date(timestamp).toLocaleString('zh-CN')
}

function formatDateForFile(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`
}

function formatDateTimeLocal(timestamp: number | null): string {
  if (!timestamp)
    return ''
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function parseDateTimeLocal(str: string): number | null {
  if (!str || !str.trim())
    return null
  const trimmed = str.trim()
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime()))
    return null
  return date.getTime()
}

function getDaysLabel(days: number) {
  if (days === -1)
    return '永久'
  return `${days}天`
}

function getQuotaLabel(quota: number | undefined | null) {
  if (quota === undefined || quota === null)
    return '3个'
  if (quota === -1)
    return '不限量'
  return `${quota}个`
}

function getCardTypeLabel(card: Card) {
  if (card.type === 'quota') {
    return `配额卡 (${getQuotaLabel(card.quota || 0)})`
  }
  return `天数卡 (${getDaysLabel(card.days)})`
}

function isExpired(card: any | null) {
  if (!card?.expiresAt)
    return false
  return Date.now() > card.expiresAt
}

// ============ 卡密管理函数 ============
async function fetchCards() {
  cardsLoading.value = true
  try {
    const result = await userStore.getAllCards()
    if (result.ok) {
      cards.value = result.data
    }
    else {
      toast.error(result.error || '获取卡密列表失败')
    }
  }
  catch (e: any) {
    toast.error(e.message || '获取卡密列表失败')
  }
  finally {
    cardsLoading.value = false
  }
}

async function createCard() {
  if (!newCard.value.description) {
    toast.warning('请输入卡密描述')
    return
  }

  const count = Math.min(Math.max(Number.parseInt(String(newCard.value.count), 10) || 1, 1), 100)

  try {
    const result = await userStore.createCard(
      newCard.value.description,
      newCard.value.days,
      count > 1 ? count : undefined,
      newCard.value.type,
      newCard.value.quota,
    )
    if (result.ok) {
      if (result.batch) {
        toast.success(`成功创建 ${result.count} 个卡密`)
        exportCardsToFile(result.data, `卡密批量导出_${newCard.value.description}_${formatDateForFile(Date.now())}.txt`)
      }
      else {
        toast.success('卡密创建成功')
      }
      showCreateModal.value = false
      newCard.value = { description: '', type: 'days', days: 30, quota: 1, count: 1 }
      await fetchCards()
    }
    else {
      toast.error(result.error || '创建卡密失败')
    }
  }
  catch (e: any) {
    toast.error(e.message || '创建卡密失败')
  }
}

async function toggleCardStatus(card: Card) {
  try {
    const result = await userStore.updateCard(card.code, { enabled: !card.enabled })
    if (result.ok) {
      toast.success(card.enabled ? '卡密已禁用' : '卡密已启用')
      await fetchCards()
    }
    else {
      toast.error(result.error || '操作失败')
    }
  }
  catch (e: any) {
    toast.error(e.message || '操作失败')
  }
}

async function deleteCard(card: Card) {
  if (!confirm(`确定要删除卡密 ${card.code} 吗？`))
    return

  try {
    const result = await userStore.deleteCard(card.code)
    if (result.ok) {
      toast.success('卡密删除成功')
      await fetchCards()
    }
    else {
      toast.error(result.error || '删除卡密失败')
    }
  }
  catch (e: any) {
    toast.error(e.message || '删除卡密失败')
  }
}

async function deleteSelectedCards() {
  const selectedCodes = Array.from(selectedCards.value)
  if (selectedCodes.length === 0) {
    toast.warning('请先选择要删除的卡密')
    return
  }

  if (!confirm(`确定要删除选中的 ${selectedCodes.length} 个卡密吗？此操作不可恢复！`))
    return

  try {
    const result = await userStore.deleteCardsBatch(selectedCodes)
    if (result.ok) {
      toast.success(`成功删除 ${result.deletedCount} 个卡密`)
      selectedCards.value.clear()
      selectAll.value = false
      await fetchCards()
    }
    else {
      toast.error(result.error || '批量删除卡密失败')
    }
  }
  catch (e: any) {
    toast.error(e.message || '批量删除卡密失败')
  }
}

async function copyCode(code: string) {
  const ok = await copyTextToClipboard(code)
  if (ok)
    toast.success('卡密已复制到剪贴板')
  else
    toast.error('复制失败')
}

function exportCardsToFile(cardsToExport: Card[], filename?: string) {
  if (!cardsToExport || cardsToExport.length === 0) {
    toast.warning('没有可导出的卡密')
    return
  }

  const content = cardsToExport.map(card =>
    `卡密: ${card.code}\n描述: ${card.description}\n时长: ${getDaysLabel(card.days)}\n状态: ${card.enabled ? '启用' : '禁用'}\n${card.usedBy ? `使用者: ${card.usedBy}\n使用时间: ${formatDate(card.usedAt)}` : '未使用'}\n创建时间: ${formatDate(card.createdAt)}\n${'='.repeat(40)}`,
  ).join('\n\n')

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename || `卡密导出_${formatDateForFile(Date.now())}.txt`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
  toast.success(`已导出 ${cardsToExport.length} 个卡密到文件`)
}

function toggleSelectAll() {
  if (selectAll.value) {
    filteredCards.value.forEach(card => selectedCards.value.add(card.code))
  }
  else {
    filteredCards.value.forEach(card => selectedCards.value.delete(card.code))
  }
}

function toggleSelectCard(code: string) {
  if (selectedCards.value.has(code)) {
    selectedCards.value.delete(code)
    selectAll.value = false
  }
  else {
    selectedCards.value.add(code)
    if (filteredCards.value.every(card => selectedCards.value.has(card.code))) {
      selectAll.value = true
    }
  }
}

// ============ 用户管理函数 ============
async function fetchUsers() {
  usersLoading.value = true
  try {
    const result = await userStore.getAllUsersWithPassword()
    if (result.ok) {
      users.value = result.data
    }
    else {
      toast.error(result.error || '获取用户列表失败')
    }
  }
  catch (e: any) {
    toast.error(e.message || '获取用户列表失败')
  }
  finally {
    usersLoading.value = false
  }
}

async function toggleUserStatus(user: UserRow) {
  try {
    const result = await userStore.updateUser(user.username, { enabled: !(user.card?.enabled !== false) })
    if (result.ok) {
      toast.success(user.card?.enabled !== false ? '用户已禁用' : '用户已启用')
      await fetchUsers()
    }
    else {
      toast.error(result.error || '操作失败')
    }
  }
  catch (e: any) {
    toast.error(e.message || '操作失败')
  }
}

async function deleteUser(user: UserRow) {
  if (!confirm(`确定要删除用户 ${user.username} 吗？`))
    return

  try {
    const result = await userStore.deleteUser(user.username)
    if (result.ok) {
      toast.success('用户删除成功')
      await fetchUsers()
    }
    else {
      toast.error(result.error || '删除用户失败')
    }
  }
  catch (e: any) {
    toast.error(e.message || '删除用户失败')
  }
}

function openEditModal(user: UserRow) {
  selectedUser.value = user
  editExpiresAt.value = user.card?.expiresAt || null
  editQuota.value = user.card?.quota || 3
  editExpiresAtInput.value = formatDateTimeLocal(editExpiresAt.value)
  showEditModal.value = true
}

async function saveUserEdit() {
  if (!selectedUser.value)
    return

  try {
    const result = await userStore.updateUser(selectedUser.value.username, {
      expiresAt: editExpiresAt.value,
      quota: editQuota.value,
    })
    if (result.ok) {
      toast.success('修改成功')
      showEditModal.value = false
      await fetchUsers()
    }
    else {
      toast.error(result.error || '修改失败')
    }
  }
  catch (e: any) {
    toast.error(e.message || '修改失败')
  }
}

// ============ OAuth配置函数 ============
async function loadOAuthConfig() {
  try {
    const res = await api.get('/api/admin/oauth')
    if (res.data.ok) {
      oauthConfig.value = res.data.data
    }
  }
  catch {
    // ignore
  }
}

async function loadOAuthUserDefault() {
  try {
    const res = await api.get('/api/admin/oauth-user-default')
    if (res.data.ok) {
      oauthUserDefault.value = res.data.data
    }
  }
  catch {
    // ignore
  }
}

async function loadCardRegisterDefault() {
  try {
    const res = await api.get('/api/admin/card-register-default')
    if (res.data.ok) {
      cardRegisterDefault.value = res.data.data
    }
  }
  catch {
    // ignore
  }
}

async function handleSaveOAuth() {
  oauthSaving.value = true
  try {
    const res = await api.post('/api/admin/oauth', oauthConfig.value)
    if (res.data.ok) {
      toast.success('OAuth配置已保存')
    }
    else {
      toast.error(res.data.error || '保存失败')
    }
  }
  catch (e: any) {
    toast.error(e.message || '保存失败')
  }
  finally {
    oauthSaving.value = false
  }
}

async function handleSaveOAuthUserDefault() {
  try {
    const res = await api.post('/api/admin/oauth-user-default', oauthUserDefault.value)
    if (res.data.ok) {
      toast.success('QQ登录用户默认配置已保存')
    }
    else {
      toast.error(res.data.error || '保存失败')
    }
  }
  catch (e: any) {
    toast.error(e.message || '保存失败')
  }
}

async function handleSaveCardRegisterDefault() {
  try {
    const res = await api.post('/api/admin/card-register-default', cardRegisterDefault.value)
    if (res.data.ok) {
      toast.success('卡密注册默认配置已保存')
    }
    else {
      toast.error(res.data.error || '保存失败')
    }
  }
  catch (e: any) {
    toast.error(e.message || '保存失败')
  }
}

// ============ 微信配置函数 ============
async function loadWxConfig() {
  try {
    const { data } = await api.get('/api/admin/wx-config')
    if (data?.ok && data.data) {
      wxConfig.value = { ...wxConfig.value, ...data.data }
    }
  }
  catch (e) {
    console.error('加载微信配置失败:', e)
  }
}

async function handleSaveWxConfig() {
  wxSaving.value = true
  try {
    const { data } = await api.post('/api/admin/wx-config', wxConfig.value)
    if (data?.ok) {
      toast.success('微信配置已保存')
    }
    else {
      toast.error(`保存失败: ${data?.error || '未知错误'}`)
    }
  }
  catch (e: any) {
    toast.error(e.message || '保存失败')
  }
  finally {
    wxSaving.value = false
  }
}

// ============ 初始化 ============
onMounted(() => {
  fetchCards()
  fetchUsers()
  loadOAuthConfig()
  loadOAuthUserDefault()
  loadCardRegisterDefault()
  loadWxConfig()
})
</script>

<template>
  <div class="space-y-4">
    <!-- 标签页导航 -->
    <div class="flex flex-wrap border-b border-gray-200 dark:border-gray-700">
      <button
        class="flex-1 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors"
        :class="activeTab === 'cards'
          ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeTab = 'cards'"
      >
        <div class="flex flex-col items-center justify-center space-y-1 sm:flex-row sm:space-x-2 sm:space-y-0">
          <div class="i-carbon-ticket text-xl" />
          <span class="whitespace-normal text-center">卡密</span>
        </div>
      </button>
      <button
        class="flex-1 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors"
        :class="activeTab === 'users'
          ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeTab = 'users'"
      >
        <div class="flex flex-col items-center justify-center space-y-1 sm:flex-row sm:space-x-2 sm:space-y-0">
          <div class="i-carbon-user-admin text-xl" />
          <span class="whitespace-normal text-center">用户</span>
        </div>
      </button>
      <button
        class="flex-1 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors"
        :class="activeTab === 'oauth'
          ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeTab = 'oauth'"
      >
        <div class="flex flex-col items-center justify-center space-y-1 sm:flex-row sm:space-x-2 sm:space-y-0">
          <div class="i-carbon-plug text-xl" />
          <span class="whitespace-normal text-center">聚合</span>
        </div>
      </button>
      <button
        class="flex-1 border-b-2 px-2 py-2.5 text-sm font-medium transition-colors"
        :class="activeTab === 'wx'
          ? 'border-blue-500 text-blue-600 dark:border-blue-400 dark:text-blue-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'"
        @click="activeTab = 'wx'"
      >
        <div class="flex flex-col items-center justify-center space-y-1 sm:flex-row sm:space-x-2 sm:space-y-0">
          <div class="i-carbon-logo-wechat text-xl" />
          <span class="whitespace-normal text-center">微信</span>
        </div>
      </button>
    </div>

    <!-- 卡密管理标签页 -->
    <div v-if="activeTab === 'cards'" class="space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg text-gray-800 font-semibold dark:text-gray-200">
          卡密管理
        </h2>
        <div class="flex gap-2">
          <BaseButton variant="secondary" size="sm" @click="fetchCards">
            刷新
          </BaseButton>
          <BaseButton variant="primary" size="sm" @click="showCreateModal = true">
            创建卡密
          </BaseButton>
        </div>
      </div>

      <!-- 卡密类型切换 -->
      <div class="flex gap-2">
        <button
          class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
          :class="cardTypeFilter === 'all'
            ? 'bg-blue-500 text-white'
            : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
          @click="cardTypeFilter = 'all'"
        >
          全部
        </button>
        <button
          class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
          :class="cardTypeFilter === 'days'
            ? 'bg-blue-500 text-white'
            : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
          @click="cardTypeFilter = 'days'"
        >
          时间卡密
        </button>
        <button
          class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
          :class="cardTypeFilter === 'quota'
            ? 'bg-purple-500 text-white'
            : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'"
          @click="cardTypeFilter = 'quota'"
        >
          配额卡密
        </button>
      </div>

      <!-- 搜索和过滤 -->
      <div class="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 shadow dark:bg-gray-800">
        <input
          v-model="searchQuery"
          placeholder="搜索卡密、描述或使用者..."
          class="h-8 w-64 border border-gray-300 rounded-lg bg-white px-3 text-sm text-gray-900 outline-none transition-all dark:border-gray-600 focus:border-green-500 dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-green-500/20"
        >
        <select
          v-model="filterStatus"
          class="h-8 border border-gray-300 rounded-lg bg-white px-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
        >
          <option value="all">
            全部状态
          </option>
          <option value="unused">
            未使用
          </option>
          <option value="used">
            已使用
          </option>
          <option value="enabled">
            已启用
          </option>
          <option value="disabled">
            已禁用
          </option>
        </select>
      </div>

      <!-- 批量操作栏 -->
      <div v-if="selectedCards.size > 0" class="flex items-center gap-3 rounded-lg bg-blue-50 p-3 dark:bg-blue-900/20">
        <span class="text-sm text-blue-700 dark:text-blue-300">
          已选择 {{ selectedCards.size }} 个卡密
        </span>
        <BaseButton variant="danger" size="sm" @click="deleteSelectedCards">
          批量删除
        </BaseButton>
        <button
          class="ml-auto text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700"
          @click="selectedCards.clear(); selectAll = false"
        >
          清除选择
        </button>
      </div>

      <!-- 卡密列表 -->
      <div class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="bg-gray-50 dark:bg-gray-700">
              <tr>
                <th class="px-3 py-2 text-left">
                  <input
                    v-model="selectAll"
                    type="checkbox"
                    class="border-gray-300 rounded"
                    @change="toggleSelectAll"
                  >
                </th>
                <th class="px-4 py-2 text-left text-xs text-gray-500 font-medium dark:text-gray-300">
                  卡密
                </th>
                <th class="px-4 py-2 text-left text-xs text-gray-500 font-medium dark:text-gray-300">
                  描述
                </th>
                <th class="px-4 py-2 text-left text-xs text-gray-500 font-medium dark:text-gray-300">
                  类型
                </th>
                <th class="px-4 py-2 text-left text-xs text-gray-500 font-medium dark:text-gray-300">
                  状态
                </th>
                <th class="px-4 py-2 text-left text-xs text-gray-500 font-medium dark:text-gray-300">
                  使用者
                </th>
                <th class="px-4 py-2 text-right text-xs text-gray-500 font-medium dark:text-gray-300">
                  操作
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr v-for="card in filteredCards" :key="card.code" class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="px-3 py-2">
                  <input
                    :checked="selectedCards.has(card.code)"
                    type="checkbox"
                    class="border-gray-300 rounded"
                    @change="toggleSelectCard(card.code)"
                  >
                </td>
                <td class="whitespace-nowrap px-4 py-2">
                  <code class="rounded bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-700">{{ card.code }}</code>
                </td>
                <td class="whitespace-nowrap px-4 py-2 text-sm text-gray-900 dark:text-white">
                  {{ card.description }}
                </td>
                <td class="whitespace-nowrap px-4 py-2">
                  <span
                    class="inline-flex rounded-full px-2 py-0.5 text-xs"
                    :class="card.type === 'quota' ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200' : 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'"
                  >
                    {{ getCardTypeLabel(card) }}
                  </span>
                </td>
                <td class="whitespace-nowrap px-4 py-2">
                  <span
                    class="inline-flex rounded-full px-2 py-0.5 text-xs"
                    :class="card.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'"
                  >
                    {{ card.enabled ? '启用' : '禁用' }}
                  </span>
                </td>
                <td class="whitespace-nowrap px-4 py-2 text-sm text-gray-500 dark:text-gray-400">
                  {{ card.usedBy || '-' }}
                </td>
                <td class="whitespace-nowrap px-4 py-2 text-right text-sm">
                  <button class="mr-2 text-blue-600 dark:text-blue-400 hover:text-blue-900" @click="copyCode(card.code)">
                    复制
                  </button>
                  <button class="mr-2 text-blue-600 dark:text-blue-400 hover:text-blue-900" @click="toggleCardStatus(card)">
                    {{ card.enabled ? '禁用' : '启用' }}
                  </button>
                  <button class="text-red-600 dark:text-red-400 hover:text-red-900" @click="deleteCard(card)">
                    删除
                  </button>
                </td>
              </tr>
              <tr v-if="filteredCards.length === 0">
                <td colspan="7" class="px-4 py-4 text-center text-gray-500 dark:text-gray-400">
                  暂无卡密
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 用户管理标签页 -->
    <div v-if="activeTab === 'users'" class="space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg text-gray-800 font-semibold dark:text-gray-200">
          用户管理
        </h2>
        <BaseButton variant="primary" size="sm" @click="fetchUsers">
          刷新
        </BaseButton>
      </div>

      <!-- 用户列表 -->
      <div class="overflow-hidden rounded-lg bg-white shadow dark:bg-gray-800">
        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead class="bg-gray-50 dark:bg-gray-700">
              <tr>
                <th class="px-4 py-2 text-left text-xs text-gray-500 font-medium dark:text-gray-300">
                  用户名
                </th>
                <th class="px-4 py-2 text-left text-xs text-gray-500 font-medium dark:text-gray-300">
                  密码
                </th>
                <th class="px-4 py-2 text-left text-xs text-gray-500 font-medium dark:text-gray-300">
                  角色
                </th>
                <th class="px-4 py-2 text-left text-xs text-gray-500 font-medium dark:text-gray-300">
                  过期时间
                </th>
                <th class="px-4 py-2 text-left text-xs text-gray-500 font-medium dark:text-gray-300">
                  配额
                </th>
                <th class="px-4 py-2 text-left text-xs text-gray-500 font-medium dark:text-gray-300">
                  状态
                </th>
                <th class="px-4 py-2 text-right text-xs text-gray-500 font-medium dark:text-gray-300">
                  操作
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
              <tr v-for="user in users" :key="user.username" class="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                <td class="whitespace-nowrap px-4 py-2 text-sm text-gray-900 font-medium dark:text-white">
                  {{ user.username }}
                </td>
                <td class="whitespace-nowrap px-4 py-2 text-sm text-gray-900 dark:text-white">
                  <span class="font-mono">{{ user.password }}</span>
                </td>
                <td class="whitespace-nowrap px-4 py-2">
                  <span
                    class="inline-flex rounded-full px-2 py-0.5 text-xs"
                    :class="user.role === 'admin' ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200' : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'"
                  >
                    {{ user.role === 'admin' ? '管理员' : '用户' }}
                  </span>
                </td>
                <td class="whitespace-nowrap px-4 py-2 text-sm" :class="isExpired(user.card) ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'">
                  {{ formatDate(user.card?.expiresAt || null) }}
                </td>
                <td class="whitespace-nowrap px-4 py-2">
                  <span class="inline-flex rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                    {{ getQuotaLabel(user.card?.quota) }}
                  </span>
                </td>
                <td class="whitespace-nowrap px-4 py-2">
                  <span
                    class="inline-flex rounded-full px-2 py-0.5 text-xs"
                    :class="user.card?.enabled !== false ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'"
                  >
                    {{ user.card?.enabled !== false ? '正常' : '禁用' }}
                  </span>
                </td>
                <td class="whitespace-nowrap px-4 py-2 text-right text-sm">
                  <button class="mr-2 text-blue-600 dark:text-blue-400 hover:text-blue-900" @click="openEditModal(user)">
                    编辑
                  </button>
                  <button class="mr-2 text-blue-600 dark:text-blue-400 hover:text-blue-900" @click="toggleUserStatus(user)">
                    {{ user.card?.enabled !== false ? '禁用' : '启用' }}
                  </button>
                  <button class="text-red-600 dark:text-red-400 hover:text-red-900" @click="deleteUser(user)">
                    删除
                  </button>
                </td>
              </tr>
              <tr v-if="users.length === 0">
                <td colspan="7" class="px-4 py-4 text-center text-gray-500 dark:text-gray-400">
                  暂无用户
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 聚合登录配置标签页 -->
    <div v-if="activeTab === 'oauth'" class="space-y-4">
      <h2 class="text-lg text-gray-800 font-semibold dark:text-gray-200">
        QQ聚合登录配置
      </h2>

      <div class="rounded-lg bg-white p-4 shadow space-y-4 dark:bg-gray-800">
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-4 md:grid-cols-2">
          <div class="flex items-center">
            <BaseSwitch v-model="oauthConfig.enabled" label="启用QQ登录" />
          </div>
          <BaseInput v-model="oauthConfig.apiUrl" label="接口地址" placeholder="如 https://u.daib.cn/" />
          <BaseInput v-model="oauthConfig.appId" label="App ID" placeholder="应用ID" />
          <BaseInput v-model="oauthConfig.appKey" label="App Key" type="password" placeholder="应用密钥" />
        </div>
        <div class="flex items-center justify-between">
          <p class="text-xs text-gray-500 dark:text-gray-400">
            接口地址需要以 / 结尾，请前往 <a href="https://u.daib.cn/" target="_blank" class="text-blue-500 hover:underline">u.daib.cn</a> 获取配置
          </p>
          <BaseButton variant="primary" size="sm" :loading="oauthSaving" @click="handleSaveOAuth">
            保存配置
          </BaseButton>
        </div>
      </div>

      <!-- QQ登录用户默认配置 -->
      <div class="rounded-lg bg-white p-4 shadow space-y-4 dark:bg-gray-800">
        <h3 class="text-base text-gray-800 font-semibold dark:text-gray-200">
          QQ登录用户默认配置
        </h3>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <BaseInput v-model.number="oauthUserDefault.days" label="默认天数" type="number" placeholder="30" />
          <BaseInput v-model.number="oauthUserDefault.quota" label="默认配额" type="number" placeholder="0" />
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          天数设为0表示永久有效，配额设为0表示不限制账号数量
        </p>
        <div class="flex justify-end">
          <BaseButton variant="primary" size="sm" @click="handleSaveOAuthUserDefault">
            保存QQ登录默认配置
          </BaseButton>
        </div>
      </div>

      <!-- 卡密注册默认配置 -->
      <div class="rounded-lg bg-white p-4 shadow space-y-4 dark:bg-gray-800">
        <h3 class="text-base text-gray-800 font-semibold dark:text-gray-200">
          时间卡密注册默认配置
        </h3>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <BaseInput v-model.number="cardRegisterDefault.quota" label="默认配额" type="number" placeholder="3" />
        </div>
        <p class="text-xs text-gray-500 dark:text-gray-400">
          使用时间卡密注册时，新用户的默认账号配额数量
        </p>
        <div class="flex justify-end">
          <BaseButton variant="primary" size="sm" @click="handleSaveCardRegisterDefault">
            保存卡密注册默认配置
          </BaseButton>
        </div>
      </div>
    </div>

    <!-- 微信全局配置标签页 -->
    <div v-if="activeTab === 'wx'" class="space-y-4">
      <h2 class="text-lg text-gray-800 font-semibold dark:text-gray-200">
        微信全局管理设置
      </h2>

      <div class="rounded-lg bg-white p-4 shadow space-y-4 dark:bg-gray-800">
        <div class="rounded bg-blue-50 p-3 text-sm dark:bg-blue-900/20">
          <p class="text-gray-700 dark:text-gray-300">
            此设置仅管理员可见。关闭微信配置标签但打开微信扫码登录标签时，所有用户将使用管理员设置的微信配置。
          </p>
        </div>

        <div class="grid grid-cols-2 gap-4">
          <BaseSwitch v-model="wxConfig.showWxConfigTab" label="显示微信配置标签" />
          <BaseSwitch v-model="wxConfig.showWxLoginTab" label="显示微信扫码登录标签" />
        </div>

        <div class="border-t pt-4 space-y-3 dark:border-gray-700">
          <h4 class="text-sm text-gray-700 font-medium dark:text-gray-300">
            微信配置（关闭微信配置标签时生效）
          </h4>
          <BaseInput v-model="wxConfig.apiBase" label="后端API地址" placeholder="http://127.0.0.1:8059/api" />
          <BaseInput v-model="wxConfig.apiKey" label="API Key（可选）" placeholder="第三方API密钥" />
          <BaseInput v-model="wxConfig.proxyApiUrl" label="第三方API地址" placeholder="https://api.aineishe.com/api/wxnc" />
        </div>

        <div class="flex justify-end">
          <BaseButton variant="primary" size="sm" :loading="wxSaving" @click="handleSaveWxConfig">
            保存微信配置
          </BaseButton>
        </div>
      </div>
    </div>

    <!-- 创建卡密弹窗 -->
    <div
      v-if="showCreateModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
      @click.self="showCreateModal = false"
    >
      <div class="max-w-md w-full rounded-lg bg-white p-6 dark:bg-gray-800">
        <h2 class="mb-4 text-xl text-gray-900 font-bold dark:text-white">
          创建卡密
        </h2>
        <div class="space-y-4">
          <div>
            <label class="mb-1 block text-sm text-gray-700 font-medium dark:text-gray-300">描述</label>
            <BaseInput v-model="newCard.description" placeholder="例如：月卡-2024" />
          </div>
          <div>
            <label class="mb-1 block text-sm text-gray-700 font-medium dark:text-gray-300">卡密类型</label>
            <select
              v-model="newCard.type"
              class="w-full border border-gray-300 rounded-lg bg-white px-3 py-2 text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            >
              <option value="days">
                天数卡密
              </option>
              <option value="quota">
                配额卡密
              </option>
            </select>
          </div>
          <div v-if="newCard.type === 'days'">
            <label class="mb-1 block text-sm text-gray-700 font-medium dark:text-gray-300">天数</label>
            <BaseInput v-model.number="newCard.days" type="number" placeholder="天数" />
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              输入-1表示永久，其他数字表示天数
            </p>
          </div>
          <div v-if="newCard.type === 'quota'">
            <label class="mb-1 block text-sm text-gray-700 font-medium dark:text-gray-300">配额数量</label>
            <BaseInput v-model.number="newCard.quota" type="number" placeholder="配额数量" />
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              输入-1表示不限量，其他数字表示可添加的账号数量
            </p>
          </div>
          <div>
            <label class="mb-1 block text-sm text-gray-700 font-medium dark:text-gray-300">数量</label>
            <BaseInput v-model.number="newCard.count" type="number" min="1" max="100" placeholder="数量" />
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              批量创建数量（1-100），批量创建后会自动导出文件
            </p>
          </div>
        </div>
        <div class="mt-6 flex justify-end space-x-3">
          <BaseButton variant="secondary" @click="showCreateModal = false">
            取消
          </BaseButton>
          <BaseButton variant="primary" @click="createCard">
            创建
          </BaseButton>
        </div>
      </div>
    </div>

    <!-- 编辑用户弹窗 -->
    <div
      v-if="showEditModal"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
      @click.self="showEditModal = false"
    >
      <div class="max-w-md w-full rounded-lg bg-white p-6 dark:bg-gray-800">
        <h2 class="mb-4 text-xl text-gray-900 font-bold dark:text-white">
          编辑用户
        </h2>
        <div class="space-y-4">
          <div>
            <label class="mb-1 block text-sm text-gray-700 font-medium dark:text-gray-300">用户名</label>
            <BaseInput :model-value="selectedUser?.username" disabled />
          </div>
          <div>
            <label class="mb-1 block text-sm text-gray-700 font-medium dark:text-gray-300">过期时间</label>
            <input
              v-model="editExpiresAtInput"
              type="datetime-local"
              class="w-full border border-gray-300 rounded-lg bg-white px-3 py-2 text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              @blur="editExpiresAt = parseDateTimeLocal(editExpiresAtInput)"
            >
          </div>
          <div>
            <label class="mb-1 block text-sm text-gray-700 font-medium dark:text-gray-300">配额</label>
            <BaseInput v-model.number="editQuota" type="number" placeholder="3" />
          </div>
        </div>
        <div class="mt-6 flex justify-end space-x-3">
          <BaseButton variant="secondary" @click="showEditModal = false">
            取消
          </BaseButton>
          <BaseButton variant="primary" @click="saveUserEdit">
            保存
          </BaseButton>
        </div>
      </div>
    </div>
  </div>
</template>
