<script setup lang="ts">
import { useEditorStore } from "../stores/editor";
const store = useEditorStore();
function addOne() { store.vehicleAddRequest++; }
function addTen() { store.vehicleAddBatchRequest++; }
function eraseSelected() { if (store.selectedVehicle) store.vehicleDeleteRequest++; }
function clearAll() {
  if (store.vehicleCount && window.confirm("Удалить все машины из предварительной симуляции?"))
    store.vehicleClearRequest++;
}
</script>

<template>
  <div class="traffic-dock" aria-label="Симуляция движения">
    <div class="traffic-title"><span class="traffic-led"></span> Машины
      <strong>{{ store.vehicleCount }}</strong>
    </div>
    <div class="traffic-buttons">
      <button title="Добавить автомобиль (C)" :disabled="!store.document" @click="addOne">+1</button>
      <button title="Добавить десять автомобилей (Shift+C)" :disabled="!store.document" @click="addTen">+10</button>
      <button :disabled="!store.document" @click="store.trafficRunning = !store.trafficRunning">
        {{ store.trafficRunning ? "Пауза" : "Пуск" }}
      </button>
      <button title="Удалить выбранную машину (Delete)"
        :disabled="!store.selectedVehicle" @click="eraseSelected">−1</button>
      <button title="Удалить все машины" :disabled="!store.vehicleCount" @click="clearAll">Очистить</button>
    </div>
    <div class="traffic-speed">
      <span>Скорость ×{{ store.trafficSpeed.toFixed(1) }}</span>
      <input v-model.number="store.trafficSpeed" aria-label="Скорость симуляции" type="range"
        min="0.25" max="4" step="0.25" />
    </div>
    <small>Предпросмотр по OSM, не SUMO. В экспорт карты машины не входят.</small>
  </div>
</template>
