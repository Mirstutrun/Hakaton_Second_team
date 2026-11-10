<script setup lang="ts">
import { useEditorStore } from "../stores/editor";
const store = useEditorStore();
function removeAll() {
  if (store.vehicleCount === 0) return;
  if (window.confirm("Убрать весь транспорт с карты?")) store.vehicleClearRequest++;
}
function removeRoute() {
  if (!store.selectedBusRoute || !window.confirm("Удалить выбранный автобусный маршрут?")) return;
  if (store.execute({ type: "delete-bus-route", id: store.selectedBusRoute })) store.selectedBusRoute = "";
}
</script>

<template>
  <div class="traffic-dock" aria-label="Движение транспорта">
    <div class="traffic-heading">
      <span class="traffic-live"></span>
      <div><strong>Движение транспорта</strong><small>Машин: {{ store.vehicleCount - store.busCount }} · Автобусов: {{ store.busCount }}</small></div>
      <span class="traffic-status">{{ store.trafficRunning ? "Движутся" : "Пауза" }}</span>
    </div>
    <label class="traffic-side">Сторона движения
      <select v-model="store.drivingSide" aria-label="Сторона движения">
        <option value="left">Левостороннее</option>
        <option value="right">Правостороннее</option>
      </select>
    </label>
    <div class="traffic-metrics" aria-live="off">
      <span><b>{{ store.trafficMetrics.moving }}</b> в движении</span>
      <span><b>{{ store.trafficMetrics.stopped }}</b> ожидают</span>
      <span><b>{{ store.trafficMetrics.averageKmh.toFixed(0) }}</b> км/ч в среднем</span>
    </div>
    <small class="traffic-note">Локальный предпросмотр · сторона движения не меняет OSM. При переключении транспорт создаётся заново.</small>
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
    <details class="bus-panel">
      <summary>Автобусы и маршруты · {{ store.routes.length }}</summary>
      <p>Поставьте остановки инструментом «Остановка». Выберите их по порядку для нового маршрута.</p>
      <button :disabled="!store.document" @click="store.tool = 'bus-route'">+ Новый маршрут</button>
      <div v-if="store.tool === 'bus-route'" class="bus-stop-list">
        <button v-for="stop in store.stops" :key="stop.id"
          :disabled="store.routeDraft.includes(stop.id)"
          @click="store.addRouteStop(stop.id)">+ {{ stop.name }}</button>
      </div>
      <label>Действующий маршрут
        <select v-model="store.selectedBusRoute" aria-label="Автобусный маршрут">
          <option value="">Выберите маршрут</option>
          <option v-for="route in store.routes" :key="route.id" :value="route.id">
            {{ route.name }} · {{ route.stops.length }} остановки
          </option>
        </select>
      </label>
      <div class="bus-actions">
        <button class="traffic-add" :disabled="!store.selectedBusRoute" @click="store.busAddRequest++">+ Автобус</button>
        <button :disabled="!store.selectedBusRoute" @click="removeRoute">Удалить маршрут</button>
      </div>
    </details>
    <label class="traffic-speed"><span>Скорость движения ×{{ store.trafficSpeed.toFixed(1) }}</span>
      <input v-model.number="store.trafficSpeed" aria-label="Скорость симуляции"
        type="range" min="0.25" max="4" step="0.25" />
    </label>
  </div>
</template>
