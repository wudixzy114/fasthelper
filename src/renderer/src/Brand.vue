<script setup lang="ts">
import { Zap } from '@lucide/vue'
defineProps<{ subtitle?: string }>()
</script>

<template>
  <div class="brand">
    <div class="brand-icon" aria-hidden="true"><Zap :size="20" :stroke-width="2.5" /></div>
    <div><span class="brand-name">fasthelper</span><span v-if="subtitle" class="brand-subtitle">{{ subtitle }}</span></div>
  </div>
</template>
