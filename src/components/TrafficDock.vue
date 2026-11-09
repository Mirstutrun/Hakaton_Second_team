<script setup lang="ts">
import { useEditorStore } from "../stores/editor";
const store = useEditorStore();
function removeAll() {
  if (store.vehicleCount === 0) return;
  if (window.confirm("Убрать все машины с карты?")) store.vehicleClearRequest++;
}
</script>

<template>
  <div class="traffic-dock" aria-label="Движение машин">
    <div class="traffic-heading">
      <span class="traffic-live"></span>
      <div><strong>Движение машин</strong><small>На карте: {{ store.vehicleCount }}</small></div>
      <span class="traffic-status">{{ store.trafficRunning ? "Движутся" : "Пауза" }}</span>
    </div>
    <div class="traffic-main-actions">
      <button class="traffic-add" :disabled="!store.document"
        @click="store.vehicleAddBatchRequest++">+ 10 машин</button>
      <button :disabled="!store.document" @click="store.trafficRunning = !store.trafficRunning">
        {{ store.trafficRunning ? "⏸ Пауза" : "▶ Продолжить" }}
      </button>
    </div>
    <div class="traffic-more-actions">
      <button :disabled="!store.document" @click="store.tool = 'car'">
        + Машина кликом
      </button>
      <button :disabled="!store.selectedVehicle" @click="store.vehicleDeleteRequest++">
        Удалить выбранную
      </button>
      <button :disabled="!store.vehicleCount" @click="removeAll">Очистить</button>
    </div>
    <label class="traffic-speed"><span>Скорость движения ×{{ store.trafficSpeed.toFixed(1) }}</span>
      <input v-model.number="store.trafficSpeed" aria-label="Скорость симуляции"
        type="range" min="0.25" max="4" step="0.25" />
    </label>
  </div>
</template>
