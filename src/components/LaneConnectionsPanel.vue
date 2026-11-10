<script setup lang="ts">
import { computed } from "vue";
import { useEditorStore } from "../stores/editor";
import { tagsOf } from "../core/osm/model";
import { laneConnections } from "../core/osm/laneConnectivity";

// Соединение создаётся вручную горячей клавишей J (см. store.startLaneLink).
const store = useEditorStore();
const saved = computed(() => {
  store.revision;
  if (!store.document || store.selection?.type !== "way") return [];
  return laneConnections(store.document)
    .filter((c) => c.fromWay === store.selection!.id)
    .map((c) => {
      const target = store.document!.ways.get(c.toWay);
      return { ...c, label: (target && tagsOf(target).name) || `дорога ${c.toWay}` };
    });
});
</script>

<template>
  <section class="turn-panel lane-links">
    <div class="section-label">СОЕДИНЕНИЕ С ДРУГОЙ ДОРОГОЙ</div>
    <p class="field-hint">
      Выберите полосу на карте, нажмите <kbd>J</kbd> и затем другую дорогу.
      Если у дорог есть общий перекрёсток, свяжутся полосы (фиолетовая линия).
      Если дороги не соединены, конец выбранной дороги присоединится к другой.
    </p>
    <button type="button" class="full-width" @click="store.startLaneLink()">
      Соединить с другой дорогой (J)
    </button>
    <p v-if="saved.length" class="field-hint">
      Связи полос. Номера — по ходу движения, слева направо (как в OSM).
    </p>
    <article
      v-for="c in saved"
      :key="c.id + ':' + c.from + ':' + c.to"
      class="restriction-row"
    >
      <span
        >Полоса {{ c.from }} → полоса {{ c.to }}<small>{{ c.label }}</small></span
      ><button
        @click="
          store.execute({ type: 'disconnect-lanes', id: c.id, from: c.from, to: c.to })
        "
      >
        Убрать
      </button>
    </article>
  </section>
</template>
