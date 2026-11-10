<script setup lang="ts">
import {computed,reactive,ref,watch} from "vue";
import {useEditorStore} from "../stores/editor";
import {buildingOwner,buildingShapes} from "../core/osm/buildingShapes";
import {refsOf,tagsOf} from "../core/osm/model";
const store=useEditorStore(),form=reactive<Record<string,string>>({}),east=ref(0),north=ref(0),confirmDelete=ref(false);
const block=computed(()=>store.selection?.type==="node");
const owner=computed(()=>{store.revision;return store.selection?.type==="way"&&store.document?buildingOwner(store.document,store.selection.id):{id:store.selection?.id||"",type:"node" as const,element:store.selected!};});
const tag=computed(()=>owner.value.element?tagsOf(owner.value.element):{});
const shapes=computed(()=>store.document?buildingShapes(store.document).filter(s=>s.id===owner.value.id):[]);
const contours=computed(()=>[...new Set(shapes.value.flatMap(s=>s.wayIds))]);
const refs=computed(()=>store.selection?.type==="way"&&store.selected?[...new Set(refsOf(store.selected))]:[]);
const keys=["name","height","min_height","building","building:part","building:levels","building:colour","building:material","width","length"];
watch(()=>[store.selection,store.revision],()=>{for(const key of keys)form[key]=tag.value[key]||"";confirmDelete.value=false;},{deep:true,immediate:true});
function save(){const updates=Object.fromEntries(keys.filter(key=>form[key]!== (tag.value[key]||"")).map(key=>[key,form[key]||null]));store.execute({type:"set-area-tags",elementType:owner.value.type,id:owner.value.id,tags:updates});}
function courtyard(){store.view="2d";store.courtyardOwner=store.selection!.id;store.draft=[];store.tool="courtyard";store.inspectorOpen=false;}
function remove(){const result=block.value?store.execute({type:"delete-block",id:store.selection!.id}):store.execute({type:"delete-building",wayId:store.selection!.id});if(result)store.selectOsmElement(null);}
function selectContour(event:Event){store.selectOsmElement({type:"way",id:(event.target as HTMLSelectElement).value});store.tool="move";}
</script>
<template>
  <h2>{{form.name||(block?'Блок / препятствие':tag['building:part']?'Часть здания':'Здание')}}</h2>
  <p class="object-id">{{block?'Блок':'Контур'}} № {{store.selection?.id}}</p>
  <form class="properties-form" @submit.prevent="save">
    <label>Название<input v-model="form.name" placeholder="Необязательно" /></label>
    <label v-if="!block">Тип здания<select v-model="form.building"><option value="">Часть здания / по данным карты</option><option value="yes">Здание</option><option value="apartments">Жилой дом</option><option value="house">Частный дом</option><option value="commercial">Коммерческое</option><option value="industrial">Промышленное</option><option value="garage">Гараж</option></select></label>
    <div class="field-row"><label>Высота, м<input v-model="form.height" type="number" min="0.2" max="200" step="0.1" placeholder="По этажности" /></label><label v-if="!block">Этажей<input v-model="form['building:levels']" type="number" min="1" max="60" /></label><label v-else>Ширина, м<input v-model="form.width" type="number" min="0.3" max="30" step="0.1" /></label></div>
    <label v-if="block">Длина, м<input v-model="form.length" type="number" min="0.3" max="30" step="0.1" /></label>
    <template v-else><label>Низ здания над землёй, м<input v-model="form.min_height" type="number" min="0" max="190" step="0.1" placeholder="0" /></label>
      <label>Цвет фасада<input :value="form['building:colour']||'#c4c5b5'" type="color" @input="form['building:colour']=($event.target as HTMLInputElement).value" /></label>
      <label>Материал<select v-model="form['building:material']"><option value="">Не указан</option><option value="brick">Кирпич</option><option value="concrete">Бетон</option><option value="wood">Дерево</option><option value="glass">Стекло</option></select></label>
    </template>
    <button class="primary full-width">Применить свойства</button>
  </form>
  <div class="geometry-details"><h3>Положение и контур</h3>
    <button class="full-width" @click="store.view='2d';store.tool='move'">{{block?'Перетащить блок на карте':'Перемещать вершины контура'}}</button>
    <template v-if="!block">
      <button class="full-width" @click="store.view='2d';store.tool='insert'">Добавить вершину на стене</button>
      <label v-if="contours.length>1">Редактируемый контур<select :value="store.selection?.id" @change="selectContour"><option v-for="id in contours" :key="id" :value="id">{{shapes.some(s=>s.outerWay===id)?'Внешний контур':'Двор / часть контура'}} · {{id}}</option></select></label>
      <label>Выбранная вершина<select v-model="store.selectedVertex"><option :value="null">Выберите маркер на карте</option><option v-for="(id,i) in refs" :key="id" :value="id">Вершина {{i+1}}</option></select></label>
      <button class="full-width" :disabled="!store.selectedVertex" @click="store.execute({type:'remove-vertex',wayId:store.selection!.id,index:refsOf(store.selected!).indexOf(store.selectedVertex!)})">Убрать выбранную вершину</button>
      <div class="field-row"><label>Сдвиг на восток, м<input v-model.number="east" type="number" min="-500" max="500" /></label><label>На север, м<input v-model.number="north" type="number" min="-500" max="500" /></label></div>
      <button class="full-width" :disabled="!east&&!north" @click="store.execute({type:'move-area',wayId:store.selection!.id,east,north})">Сдвинуть здание целиком</button>
      <button class="full-width" @click="courtyard">Нарисовать открытый двор внутри</button>
      <p class="field-hint">Двор вырезается из крыши и стен, а не просто скрывается на экране. Проезд по нему не считается дорогой через здание.</p>
    </template>
  </div>
  <button v-if="!confirmDelete" class="danger full-width" @click="confirmDelete=true">{{block?'Удалить блок':'Удалить здание'}}</button>
  <div v-else class="confirm-delete"><p>Удалить объект? Действие можно отменить.</p><button class="danger" @click="remove">Подтвердить удаление</button><button @click="confirmDelete=false">Отмена</button></div>
</template>
