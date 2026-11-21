import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import type { FasthelperApi, FeatureId, FeatureStatus, ModelAction, ModelId, SettingsSnapshot } from '../../shared/contracts'

declare global {
  interface Window { fasthelper: FasthelperApi }
}

export const useSettings = defineStore('settings', () => {
  const snapshot = shallowRef<SettingsSnapshot | null>(null)
  const error = ref('')
  const busyFeature = ref<FeatureId | null>(null)
  const busyModel = ref(false)
  let revision = 0

  function connect(): () => void {
    const startRevision = revision
    const unsubscribe = window.fasthelper.onSettings((value) => {
      revision += 1
      snapshot.value = value
    })
    void window.fasthelper.settings().then((value) => {
      if (revision === startRevision) snapshot.value = value
    }).catch(() => { error.value = '无法读取设置。请关闭后重新打开。' })
    return unsubscribe
  }

  async function setFeature(id: FeatureId, status: FeatureStatus): Promise<void> {
    if (busyFeature.value) return
    busyFeature.value = id
    error.value = ''
    try {
      await window.fasthelper.setFeature(id, status)
    } catch {
      error.value = '设置保存失败。请检查磁盘空间后重试。'
    } finally {
      busyFeature.value = null
    }
  }

  async function manageModel(id: ModelId, action: ModelAction): Promise<void> {
    if (busyModel.value) return
    busyModel.value = true
    error.value = ''
    try {
      await window.fasthelper.manageModel(id, action)
    } catch {
      error.value = '模型操作未完成。请稍后重试。'
    } finally {
      busyModel.value = false
    }
  }

  return { snapshot, error, busyFeature, busyModel, connect, setFeature, manageModel }
})
