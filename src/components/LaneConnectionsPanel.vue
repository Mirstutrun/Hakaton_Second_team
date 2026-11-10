<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useEditorStore } from "../stores/editor";
import { refsOf, tagsOf } from "../core/osm/model";
import { laneConnections } from "../core/osm/laneConnectivity";
import { drivingLanes, laneTagInfo } from "../engine/trafficRules";
import { roadStyle } from "../engine/geometry/roads";
const store=useEditorStore(),via=ref(""),target=ref(""),toLane=ref(0);
const source=computed(()=>{store.revision;return store.selection?.type==="way"?store.document?.ways.get(store.selection.id):undefined;});
const layout=computed(()=>{store.revision;return source.value?drivingLanes(tagsOf(source.value),roadStyle(tagsOf(source.value)).lanes,store.drivingSide):{forward:[],backward:[]};});
const forward=computed(()=>layout.value.forward.includes(store.selectedLane??-1));
const junctions=computed(()=>{
  if(!source.value||store.selectedLane===null)return [];
  const refs=refsOf(source.value);
  return [...new Set(refs)].filter((id)=>{const i=refs.indexOf(id);return !!refs[i+(forward.value?-1:1)]&&[...store.document!.ways].some(([wayId,w])=>wayId!==store.selection!.id&&tagsOf(w).highway&&refsOf(w).includes(id));});
});
const exits=computed(()=>{
  store.revision;if(!via.value||!store.document)return [];
  return [...store.document.ways].flatMap(([id,w])=>{
    const t=tagsOf(w);if(!t.highway)return [];
    const refs=refsOf(w),at=refs.indexOf(via.value);if(at<0)return [];
    const l=drivingLanes(t,roadStyle(t).lanes,store.drivingSide);
    return [refs[at-1],refs[at+1]].filter((n):n is string=>!!n).flatMap(node=>{
      const lanes=refs.indexOf(node)>at?l.forward:l.backward;
      return lanes.length?[{id,node,lanes,key:JSON.stringify([id,node]),label:`${t.name||'Дорога '+id} · ${refs.indexOf(node)>at?'по направлению':'обратно'}`}]:[];
    });
  });
});
const chosen=computed(()=>exits.value.find(e=>e.key===target.value));
const saved=computed(()=>{
  store.revision;const way=source.value,physical=store.selectedLane;if(!way||physical===null||!store.document)return [];
  const info=laneTagInfo(tagsOf(way),roadStyle(tagsOf(way)).lanes,physical,store.drivingSide);
  return laneConnections(store.document).filter(c=>c.fromWay===store.selection!.id&&c.from===(info?.index??-2)+1);
});
watch(junctions,()=>{if(!junctions.value.includes(via.value))via.value=junctions.value[0]||"";},{immediate:true});
watch(exits,()=>{if(!exits.value.some(e=>e.key===target.value))target.value=exits.value[0]?.key||"";},{immediate:true});
watch(chosen,()=>{if(!chosen.value?.lanes.includes(toLane.value))toLane.value=chosen.value?.lanes[0]??0;},{immediate:true});
function connect(){if(!source.value||store.selectedLane===null||!chosen.value)return;const refs=refsOf(source.value),at=refs.indexOf(via.value);store.execute({type:"connect-lanes",fromWay:store.selection!.id,via:via.value,fromNode:refs[at+(forward.value?-1:1)],toWay:chosen.value.id,toNode:chosen.value.node,fromLane:store.selectedLane,toLane:toLane.value,drivingSide:store.drivingSide});}
</script>
<template>
  <details class="turn-panel" open><summary>Соединить с конкретной полосой</summary>
    <p class="field-hint">Выбрана полоса {{(store.selectedLane??0)+1}} на карте. Фиолетовая линия показывает её переход на другую дорогу. Для этой полосы машины используют заданные связи.</p>
    <template v-if="junctions.length">
      <label>В каком перекрёстке<select v-model="via"><option v-for="id in junctions" :key="id" :value="id">Узел {{id}}</option></select></label>
      <label>На какую дорогу<select v-model="target"><option v-for="e in exits" :key="e.key" :value="e.key">{{e.label}}</option></select></label>
      <label>В какую полосу<select v-model.number="toLane"><option v-for="lane in chosen?.lanes||[]" :key="lane" :value="lane">Полоса {{lane+1}} на карте</option></select></label>
      <button class="primary full-width" :disabled="!chosen" @click="connect">Прикрепить полосу</button>
    </template>
    <p v-else class="field-hint">В выбранном направлении нет общего перекрёстка. Сначала соедините дороги.</p>
    <article v-for="c in saved" :key="c.id+':'+c.from+':'+c.to" class="restriction-row"><span>Полоса {{c.from}} → полоса {{c.to}}<small>По ходу движения · дорога {{c.toWay}}</small></span><button @click="store.execute({type:'disconnect-lanes',id:c.id,from:c.from,to:c.to})">Убрать</button></article>
  </details>
</template>
