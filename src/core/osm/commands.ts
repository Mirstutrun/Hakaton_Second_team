import { buildingShapes, buildingOwner, shapeContains, segmentCrossing } from "./buildingShapes";
import { formatConnectivity, parseConnectivity } from "./laneConnectivity";
import { drivingLanes, laneTagInfo, type DrivingSide } from "../../engine/trafficRules";
import { roadStyle } from "../../engine/geometry/roads";
import { oneWayDirection } from "../../engine/trafficRules";
import { assertRoadEditSafe } from "./roadSafety";
import { restrictionNames, TurnRules } from "./turnRestrictions";
import { childElements } from "./model";
import { createProjection } from "../geo/projection";
import {
  coordinateOf,
  elements,
  insertElement,
  refsOf,
  requireElement,
  tagsOf,
} from "./model";
import type {
  Coordinate,
  EditPatch,
  ElementType,
  OsmDocument,
  RoadPoint,
  Selection,
  Tags,
} from "./model";

export type EditCommand =
 | {type:"move-block";id:string;point:RoadPoint}
 | {type:"delete-building";wayId:string}
 | {type:"create-building";points:Coordinate[];tags:Tags}
 | {type:"create-block";point:RoadPoint}
 | {type:"delete-block";id:string}
 | {type:"set-area-tags";id:string;elementType:"node"|"way"|"relation";tags:Record<string,string|null>}
 | {type:"move-area";wayId:string;east:number;north:number}
 | {type:"add-courtyard";wayId:string;points:Coordinate[]}
 | {type:"mark-building-passage";wayId:string;buildingId:string;width:number;height:number}
 | {type:"connect-lanes";fromWay:string;toWay:string;via:string;fromNode:string;toNode:string;fromLane:number;toLane:number;drivingSide:DrivingSide}
 | {type:"disconnect-lanes";id:string;from:number;to:number}
  | {
      type: "set-turn-restriction";
      fromWay: string;
      via: string;
      fromNode: string;
      toWay: string;
      toNode: string;
      restriction: string;
    }
  | { type: "delete-turn-restriction"; id: string }
  | { type: "set-tags"; target: Selection; tags: Record<string, string | null> }
  | { type: "create-road"; points: RoadPoint[]; tags: Tags }
  | { type: "merge-endpoint"; wayId: string; nodeId: string; target: RoadPoint }
  | { type: "move-node"; id: string; coordinate: Coordinate }
  | { type: "insert-node"; wayId: string; index: number; point: RoadPoint }
  | { type: "remove-vertex"; wayId: string; index: number }
  | { type: "delete-way"; id: string }
  | { type: "add-signal"; wayId: string; index: number; point: RoadPoint }
  | { type: "add-bus-stop"; wayId: string; index: number; point: RoadPoint }
  | { type: "remove-bus-stop"; id: string }
  | { type: "create-bus-route"; name: string; stops: string[]; ways?: string[] }
  | { type: "delete-bus-route"; id: string }
  | { type: "remove-signal"; id: string }
  | { type: "smooth-road"; wayId: string; radius?: number }
  | {
      type: "connect-crossing";
      wayA: string;
      indexA: number;
      wayB: string;
      indexB: number;
      coordinate: Coordinate;
    }
  | {
      type: "attach-endpoint";
      nodeId: string;
      targetWayId: string;
      targetIndex: number;
      coordinate: Coordinate;
    };

export function applyPatch(
  document: OsmDocument,
  patch: EditPatch,
  direction: "before" | "after",
): void {
  for (const change of patch.changes) {
    const collection = elements(document, change.type);
    const existing = collection.get(change.id);
    const replacement = change[direction]?.cloneNode(true) as
      Element | undefined;
    if (replacement) {
      if (existing) existing.replaceWith(replacement);
      else insertElement(document, replacement);
      collection.set(change.id, replacement);
    } else {
      existing?.remove();
      collection.delete(change.id);
    }
  }
}

function checkCoordinate({ lat, lon }: Coordinate): void {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    throw new Error("Некорректные координаты узла");
}

function checkTags(tags: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(tags)) {
    if (value === null || value === "") continue;
    if (
      /^lanes(?::forward|:backward)?$/.test(key) &&
      (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 20)
    )
      throw new Error("Число полос должно быть целым от 1 до 20");
    if (
      key === "oneway" &&
      !["yes", "no", "-1", "reversible", "alternating"].includes(value)
    )
      throw new Error("Некорректное направление дороги");
    if (key === "layer" && !/^-?\d+$/.test(value))
      throw new Error("Уровень должен быть целым числом");
    if (
      key === "width" &&
      (!Number.isFinite(Number(value)) || Number(value) <= 0)
    )
      throw new Error("Ширина должна быть положительным числом в метрах");
  }
}

export function applyEdit(
  document: OsmDocument,
  command: EditCommand,
): EditPatch {
  const patch: EditPatch = { label: command.type, changes: [] };
  const touched = new Map<
    string,
    { type: ElementType; id: string; before: Element | null }
  >();
  const touch = (type: ElementType, id: string) => {
    const key = `${type}/${id}`;
    if (!touched.has(key))
      touched.set(key, {
        type,
        id,
        before:
          (elements(document, type).get(id)?.cloneNode(true) as Element) ??
          null,
      });
  };
  const setTags = (
    type: ElementType,
    id: string,
    updates: Record<string, string | null>,
  ) => {
    checkTags(updates);
    touch(type, id);
    const element = requireElement(document, type, id);
    for (const [key, value] of Object.entries(updates)) {
      const existing = childElements(element).find(
        (child) => child.tagName === "tag" && child.getAttribute("k") === key,
      );
      if (value === null || value === "") existing?.remove();
      else {
        const tag = existing ?? document.xml.createElement("tag");
        tag.setAttribute("k", key);
        tag.setAttribute("v", value);
        if (!existing) element.appendChild(tag);
      }
    }
  };
  const newElement = (type: "node" | "way" | "relation") => {
    const id = (document.nextId++).toString();
    touch(type, id);
    const element = document.xml.createElement(type);
    element.setAttribute("id", id);
    element.setAttribute("version", "1");
    insertElement(document, element);
    elements(document, type).set(id, element);
    return element;
  };
  const pointId = (point: RoadPoint): string => {
    if ("nodeId" in point) {
      requireElement(document, "node", point.nodeId);
      return point.nodeId;
    }
    if ("wayId" in point) {
      const way = requireElement(document, "way", point.wayId);
      const tags = tagsOf(way);
      if (
        !tags.highway ||
        (tags.bridge && tags.bridge !== "no") ||
        (tags.tunnel && tags.tunnel !== "no") ||
        tags.covered === "yes" ||
        Number(tags.layer || 0) !== 0
      )
        throw new Error("Привязка возможна только к наземной дороге");
      const refs = refsOf(way);
      checkCoordinate(point.coordinate);
      const projection = createProjection(point.coordinate);
      const p = projection.project(point.coordinate);
      let index = -1,
        best = Infinity;
      let start = { x: 0, z: 0 },
        end = { x: 0, z: 0 };
      for (let j = 1; j < refs.length; j++) {
        const a = projection.project(
          coordinateOf(requireElement(document, "node", refs[j - 1])),
        );
        const b = projection.project(
          coordinateOf(requireElement(document, "node", refs[j])),
        );
        const dx = b.x - a.x,
          dz = b.z - a.z;
        const t =
          ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1);
        const distance = Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
        if (t >= 0 && t <= 1 && distance < best) {
          index = j;
          best = distance;
          start = a;
          end = b;
        }
      }
      if (index < 0 || best > 0.5)
        throw new Error("Точка привязки вышла за пределы сегмента");
      if (Math.hypot(p.x - start.x, p.z - start.z) < 1) return refs[index - 1];
      if (Math.hypot(p.x - end.x, p.z - end.z) < 1) return refs[index];
      return insert(point.wayId, index, point.coordinate);
    }
    checkCoordinate(point);
    const node = newElement("node");
    node.setAttribute("lat", point.lat.toFixed(9));
    node.setAttribute("lon", point.lon.toFixed(9));
    return node.getAttribute("id")!;
  };
  const insert = (wayId: string, index: number, point: RoadPoint) => {
    const way = requireElement(document, "way", wayId);
    const refs = childElements(way).filter((child) => child.tagName === "nd");
    if (!Number.isInteger(index) || index < 1 || index >= refs.length)
      throw new Error("Выберите существующий сегмент дороги");
    const id = pointId(point);
    if (
      refs[index - 1].getAttribute("ref") === id ||
      refs[index].getAttribute("ref") === id
    )
      throw new Error("Узел уже находится на этом сегменте");
    touch("way", wayId);
    const nd = document.xml.createElement("nd");
    nd.setAttribute("ref", id);
    way.insertBefore(nd, refs[index]);
    return id;
  };
        const splitWay = (wayId:string,via:string,pieces=new Map<string,string[]>()) => {
          const way = requireElement(document, "way", wayId),
            refs = refsOf(way),
            at = refs.indexOf(via);
          if (at < 1 || at === refs.length - 1) return;
          if (refs.lastIndexOf(via) !== at || refs[0] === refs[refs.length - 1])
            throw Error(
              "Сначала разделите замкнутую дорогу на обычные участки",
            );
          const relations = Array.from(document.relations.values()).filter(
            (rel) =>
              childElements(rel).some(
                (m) =>
                  m.tagName === "member" &&
                  m.getAttribute("type") === "way" &&
                  m.getAttribute("ref") === wayId,
              ),
          );
          for (const rel of relations) {
            const t = tagsOf(rel);
            if (!["route", "restriction", "connectivity"].includes(t.type))
              throw Error(
                "Разделение дороги затронет сложное OSM-отношение. Выберите уже разделённый подъезд",
              );
            if (
              ["restriction","connectivity"].includes(t.type) &&
              childElements(rel).some(
                (m) =>
                  m.getAttribute("role") === "via" &&
                  m.getAttribute("type") === "way" &&
                  m.getAttribute("ref") === wayId,
              )
            )
              throw Error(
                "Дорога уже является via-way ограничения. Выберите другой подъезд",
              );
            if (
              ["restriction","connectivity"].includes(t.type) &&
              childElements(rel).some(
                (m) =>
                  m.getAttribute("role") === "via" &&
                  m.getAttribute("ref") === via,
              )
            )
              throw Error(
                "На этом подъезде уже есть неоднозначное ограничение; сначала удалите его",
              );
          }
          const fresh = newElement("way"),
            newId = fresh.getAttribute("id")!;
          pieces.set(wayId, [wayId, newId]);
          for (const child of childElements(way).filter(
            (c) => c.tagName !== "nd",
          ))
            fresh.appendChild(child.cloneNode(true));
          const write = (element: Element, ids: string[]) => {
            for (const n of childElements(element).filter(
              (c) => c.tagName === "nd",
            ))
              n.remove();
            const before = element.firstElementChild;
            for (const ref of ids) {
              const nd = document.xml.createElement("nd");
              nd.setAttribute("ref", ref);
              element.insertBefore(nd, before);
            }
          };
          touch("way", wayId);
          write(way, refs.slice(0, at + 1));
          write(fresh, refs.slice(at));
          for (const rel of relations) {
            touch("relation", rel.getAttribute("id")!);
            const members = childElements(rel).filter(
              (m) => m.tagName === "member",
            );
            for (const member of members.filter(
              (m) =>
                m.getAttribute("type") === "way" &&
                m.getAttribute("ref") === wayId,
            )) {
              if (["restriction","connectivity"].includes(tagsOf(rel).type)) {
                const viaId = members
                  .find(
                    (m) =>
                      m.getAttribute("role") === "via" &&
                      m.getAttribute("type") === "node",
                  )
                  ?.getAttribute("ref");
                if (!viaId)
                  throw Error(
                    "Не удалось безопасно обновить существующее ограничение поворота",
                  );
                if (refs.slice(at + 1).includes(viaId))
                  member.setAttribute("ref", newId);
              } else {
                const clone = member.cloneNode(true) as Element;
                clone.setAttribute("ref", newId);
                const before = members
                  .slice(0, members.indexOf(member))
                  .reverse()
                  .find((m) => m.getAttribute("type") === "way");
                const prevRefs = before
                  ? refsOf(
                      document.ways.get(before.getAttribute("ref")!) ??
                        document.xml.createElement("way"),
                    )
                  : [];
                const backwards =
                  member.getAttribute("role") === "backward" ||
                  prevRefs.includes(refs[refs.length - 1]);
                rel.insertBefore(
                  clone,
                  backwards ? member : member.nextSibling,
                );
              }
            }
          }
        };

  try {
    switch (command.type) {
      case "delete-building": {
        const owner=buildingOwner(document,command.wayId),shapes=buildingShapes(document).filter(s=>s.id===owner.id);if(!shapes.length)throw Error("Выберите здание");
        const ways=[...new Set(shapes.flatMap(s=>s.wayIds))];
        if([...document.relations].some(([id,r])=>(owner.type!=="relation"||id!==owner.id)&&childElements(r).some(m=>(m.getAttribute("type")==="way"&&ways.includes(m.getAttribute("ref")!)||owner.type==="relation"&&m.getAttribute("type")==="relation"&&m.getAttribute("ref")===owner.id))))throw Error("Контур используется в другом OSM-отношении. Удаление заблокировано");
        if(owner.type==="relation"){touch("relation",owner.id);owner.element.remove();document.relations.delete(owner.id);}
        for(const id of ways){touch("way",id);document.ways.get(id)?.remove();document.ways.delete(id);}break;
      }
      case "move-block": {
        const source=requireElement(document,"node",command.id),tags=tagsOf(source);if(tags.barrier!=="block")throw Error("Выберите блок");
        const target=pointId(command.point);if(target===command.id)break;
        const node=requireElement(document,"node",target),t=tagsOf(node);if(t.highway||t.public_transport||t.barrier)throw Error("Целевая точка уже занята объектом карты");
        setTags("node",target,{barrier:"block",width:tags.width||"1.5",length:tags.length||"1.5",height:tags.height||"1.2",name:tags.name||null});
        setTags("node",command.id,{barrier:null,width:null,length:null,height:null,name:null});
        if(![...document.ways.values()].some(w=>refsOf(w).includes(command.id))&&![...document.relations.values()].some(r=>childElements(r).some(m=>m.getAttribute("type")==="node"&&m.getAttribute("ref")===command.id))){touch("node",command.id);source.remove();document.nodes.delete(command.id);}
        patch.selection={type:"node",id:target};break;
      }
      case "create-block": {
        const id=pointId(command.point),existing=tagsOf(requireElement(document,"node",id));
        if(existing.highway||existing.public_transport||existing.barrier&&existing.barrier!=="block")throw Error("Здесь уже есть объект карты. Поставьте блок рядом");
        setTags("node",id,{barrier:"block",width:"1.5",length:"1.5",height:"1.2"});patch.selection={type:"node",id};break;
      }
      case "delete-block": {
        const node=requireElement(document,"node",command.id);if(tagsOf(node).barrier!=="block")throw Error("Это не блок");
        if([...document.ways.values()].some(w=>refsOf(w).includes(command.id))||[...document.relations.values()].some(r=>childElements(r).some(m=>m.getAttribute("type")==="node"&&m.getAttribute("ref")===command.id)))setTags("node",command.id,{barrier:null,width:null,length:null,height:null});
        else {touch("node",command.id);node.remove();document.nodes.delete(command.id);}break;
      }
      case "set-area-tags": {
        const element=requireElement(document,command.elementType,command.id),combined={...tagsOf(element),...command.tags};
        for(const key of ["height","min_height","building:levels","width","length"]){const value=combined[key];if(value&&(!Number.isFinite(Number(value))||Number(value)<0||key!=="min_height"&&Number(value)===0))throw Error("Высота, этажность и размеры должны быть положительными числами");}
        const height=Number(combined.height)||Number(combined["building:levels"])*3.2||9.6;
        if(Number(combined.min_height||0)>=height)throw Error("Низ здания должен быть ниже крыши");
        setTags(command.elementType,command.id,command.tags);break;
      }
      case "move-area": {
        if(!Number.isFinite(command.east)||!Number.isFinite(command.north)||Math.hypot(command.east,command.north)>500)throw Error("Перемещайте здание не более чем на 500 м за один шаг");
        const owner=buildingOwner(document,command.wayId),shapes=buildingShapes(document).filter(s=>s.id===owner.id),ids=[...new Set(shapes.flatMap(s=>[...s.outerRefs,...s.holeRefs.flat()]))];
        if(!ids.length)throw Error("Выберите здание");
        const members=new Set(shapes.flatMap(s=>s.wayIds));
        if([...document.ways].some(([id,w])=>!members.has(id)&&refsOf(w).some(ref=>ids.includes(ref))))throw Error("Контур имеет общие узлы с другим объектом. Перемещайте нужные вершины отдельно");
        const projection=createProjection(coordinateOf(requireElement(document,"node",ids[0])));
        for(const id of ids){const node=requireElement(document,"node",id),p=projection.project(coordinateOf(node)),c=projection.unproject({x:p.x+command.east,z:p.z+command.north});touch("node",id);node.setAttribute("lat",c.lat.toFixed(9));node.setAttribute("lon",c.lon.toFixed(9));}patch.selection={type:"way",id:command.wayId};break;
      }
      case "create-building":
      case "add-courtyard": {
        if(command.points.length<3)throw Error("Для контура нужны минимум три точки");
        const points=command.points.map(p=>{checkCoordinate(p);return p;});
        if(new Set(points.map(p=>`${p.lat}/${p.lon}`)).size<3)throw Error("Нужны три разные вершины");
        let owner:ReturnType<typeof buildingOwner>|undefined;
        if(command.type==="add-courtyard") {
          owner=buildingOwner(document,command.wayId);const projection=createProjection(points[0]),shape=buildingShapes(document,projection).find(s=>s.id===owner!.id);
          if(!shape||points.some(p=>!shapeContains(shape,projection.project(p))))throw Error("Двор должен находиться внутри выбранного здания и не пересекать другой двор");
          const ring=points.map(p=>projection.project(p));for(let i=0;i<ring.length;i++)for(const boundary of [shape.outer,...shape.holes])for(let j=0;j<boundary.length;j++)if(segmentCrossing(ring[i],ring[(i+1)%ring.length],boundary[j],boundary[(j+1)%boundary.length])!==null)throw Error("Контур двора не должен пересекать стены здания или другого двора");
        }
        const refs=points.map(p=>pointId(p));refs.push(refs[0]);const way=newElement("way"),id=way.getAttribute("id")!;
        for(const ref of refs){const nd=document.xml.createElement("nd");nd.setAttribute("ref",ref);way.appendChild(nd);}
        if(command.type==="create-building"){setTags("way",id,{building:"yes",height:"9.6",...command.tags});patch.selection={type:"way",id};}
        else {
          let relation=owner!.type==="relation"?owner!.element:newElement("relation");
          if(owner!.type==="way") {
            const tags=tagsOf(owner!.element),updates:Record<string,string|null>={};for(const [key,value] of Object.entries(tags))if(key==="building"||key.startsWith("building:")||["name","height","min_height","roof:shape","roof:height"].includes(key))updates[key]=value;
            setTags("relation",relation.getAttribute("id")!,{...updates,type:"multipolygon"});setTags("way",owner!.id,Object.fromEntries(Object.keys(updates).map(k=>[k,null])));
            const outer=document.xml.createElement("member");outer.setAttribute("type","way");outer.setAttribute("ref",owner!.id);outer.setAttribute("role","outer");relation.appendChild(outer);
          } else touch("relation",owner!.id);
          const inner=document.xml.createElement("member");inner.setAttribute("type","way");inner.setAttribute("ref",id);inner.setAttribute("role","inner");relation.appendChild(inner);patch.selection={type:"way",id:command.wayId};
        }break;
      }
      case "mark-building-passage": {
        const {width,height}=command;if(!Number.isFinite(width)||!Number.isFinite(height)||width<2||height<2.2||width>30||height>15)throw Error("Укажите реальную ширину от 2 м и высоту от 2,2 м");
        const source=requireElement(document,"way",command.wayId),tags=tagsOf(source);if(!tags.highway)throw Error("Выберите дорогу через здание");
        const refs=refsOf(source),projection=createProjection(coordinateOf(requireElement(document,"node",refs[0]))),shape=buildingShapes(document,projection).find(s=>s.id===command.buildingId);
        if(!shape)throw Error("Контур здания не найден");
        const buildingHeight=Number.parseFloat(shape.tags.height)||Number(shape.tags["building:levels"])*3.2||9.6;
        if(height>=buildingHeight)throw Error("Высота арки должна быть ниже крыши здания. Если контура на самом деле нет, исправьте здание или нарисуйте двор");
        const expanded=[refs[0]],cutNodes=new Set<string>();let intersects=false;
        for(let i=1;i<refs.length;i++){
          const a=projection.project(coordinateOf(requireElement(document,"node",refs[i-1]))),b=projection.project(coordinateOf(requireElement(document,"node",refs[i])));
          const cuts=[0,1];for(const ring of [shape.outer,...shape.holes])for(let j=0;j<ring.length;j++){const t=segmentCrossing(a,b,ring[j],ring[(j+1)%ring.length]);if(t!==null){cuts.push(t);if(t<1e-7)cutNodes.add(refs[i-1]);if(t>1-1e-7)cutNodes.add(refs[i]);}}
          const sorted=[...new Set(cuts.map(t=>Math.round(t*1e8)/1e8))].sort((a,b)=>a-b);
          for(let j=1;j<sorted.length;j++){
            const t=sorted[j],prev=sorted[j-1],mid=(t+prev)/2,inside=shapeContains(shape,{x:a.x+(b.x-a.x)*mid,z:a.z+(b.z-a.z)*mid});if(inside)intersects=true;
            let id=refs[i];if(t<1-1e-7){const c=projection.unproject({x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t});id=pointId(c);cutNodes.add(id);}expanded.push(id);
          }
        }
        if(!intersects)throw Error("Выбранная дорога не проходит через стены этого здания. Для двора используйте внутренний контур");
        touch("way",command.wayId);for(const nd of childElements(source).filter(c=>c.tagName==="nd"))nd.remove();const before=source.firstElementChild;
        for(const ref of expanded){const nd=document.xml.createElement("nd");nd.setAttribute("ref",ref);source.insertBefore(nd,before);}
        let parts=[command.wayId];for(const node of cutNodes){const part=parts.find(id=>{const refs=refsOf(requireElement(document,"way",id));return refs.indexOf(node)>0&&refs.indexOf(node)<refs.length-1;});if(!part)continue;const pieces=new Map<string,string[]>();splitWay(part,node,pieces);parts=parts.flatMap(id=>id===part?pieces.get(part)??[part]:[id]);}
        for(const id of parts){const w=requireElement(document,"way",id),ids=refsOf(w);let inside=false;for(let i=1;i<ids.length;i++){const a=projection.project(coordinateOf(requireElement(document,"node",ids[i-1]))),b=projection.project(coordinateOf(requireElement(document,"node",ids[i])));if(shapeContains(shape,{x:(a.x+b.x)/2,z:(a.z+b.z)/2}))inside=true;}
          if(inside){setTags("way",id,{tunnel:"building_passage",covered:"yes",layer:"0",width:String(width),maxwidth:String(width),maxheight:String(height),maxspeed:"20",...(width<5?{lanes:"1","lanes:forward":null,"lanes:backward":null,"lanes:both_ways":null}:{} )});patch.selection={type:"way",id};}
        }break;
      }
      case "disconnect-lanes": {
        const relation=requireElement(document,"relation",command.id);if(tagsOf(relation).type!=="connectivity")throw Error("Это не связь полос");
        const remaining=parseConnectivity(tagsOf(relation).connectivity||"").filter(p=>p.from!==command.from||p.to!==command.to);
        if(remaining.length)setTags("relation",command.id,{connectivity:formatConnectivity(remaining)});
        else {touch("relation",command.id);relation.remove();document.relations.delete(command.id);}break;
      }
      case "delete-turn-restriction": {
        const relation = requireElement(document, "relation", command.id);
        if (tagsOf(relation).type !== "restriction")
          throw Error("Это не ограничение поворота");
        touch("relation", command.id);
        relation.remove();
        document.relations.delete(command.id);
        break;
      }
      case "connect-lanes":
      case "set-turn-restriction": {
        const { fromWay, toWay, via, fromNode, toNode } = command;
        const restriction=command.type === "set-turn-restriction"?command.restriction:"";
        if (restriction && !restrictionNames[restriction])
          throw Error("Выберите тип запрещающего или предписывающего знака");
        const from = requireElement(document, "way", fromWay),
          to = requireElement(document, "way", toWay);
        const adjacent = (way: Element, node: string) => {
          const refs = refsOf(way),
            index = refs.indexOf(via);
          return (
            index >= 0 && (refs[index - 1] === node || refs[index + 1] === node)
          );
        };
        if (
          !tagsOf(from).highway ||
          !tagsOf(to).highway ||
          !adjacent(from, fromNode) ||
          !adjacent(to, toNode)
        )
          throw Error(
            "Подъезд и выезд должны соединяться выбранным узлом перекрёстка",
          );
        const canTravel = (w: Element, a: string, b: string) => {
          const refs = refsOf(w),
            direction = oneWayDirection(tagsOf(w));
          return (
            direction === 0 ||
            (direction === 1 && refs.indexOf(a) < refs.indexOf(b)) ||
            (direction === -1 && refs.indexOf(a) > refs.indexOf(b))
          );
        };
        if (!canTravel(from, fromNode, via) || !canTravel(to, via, toNode))
          throw Error("Подъезд или выезд противоречит одностороннему движению");
        if (Number(tagsOf(from).layer || 0) !== Number(tagsOf(to).layer || 0))
          throw Error(
            "Ограничение нельзя поставить между дорогами разных уровней",
          );
        const origin = coordinateOf(requireElement(document, "node", via)),
          projection = createProjection(origin);
        const a = projection.project(
            coordinateOf(requireElement(document, "node", fromNode)),
          ),
          b = projection.project(
            coordinateOf(requireElement(document, "node", toNode)),
          );
        const angle =
          (Math.atan2(-a.x * b.z - -a.z * b.x, -a.x * b.x + -a.z * b.z) * 180) /
          Math.PI;
        const move =
          Math.abs(angle) > 150
            ? "u_turn"
            : Math.abs(angle) < 35
              ? "straight_on"
              : angle > 0
                ? "left_turn"
                : "right_turn";
        if (restriction && !restriction.endsWith(move))
          throw Error(
            "Выбранный выезд не соответствует знаку. Выберите правильное направление на перекрёстке",
          );
        const pieces = new Map<string, string[]>();
        splitWay(fromWay,via,pieces);
        if (toWay !== fromWay) splitWay(toWay,via,pieces);
        const segment = (original: string, neighbor: string) =>
          Array.from(document.ways).find(([id, w]) => {
            if (!(pieces.get(original) ?? [original]).includes(id))
              return false;
            const refs = refsOf(w);
            return (
              (refs[0] === via && refs[1] === neighbor) ||
              (refs[refs.length - 1] === via &&
                refs[refs.length - 2] === neighbor)
            );
          })?.[0];
        const fromId = segment(fromWay, fromNode),
          toId = segment(toWay, toNode);
        if (!fromId || !toId)
          throw Error("Не удалось определить подъезд после разделения дороги");
        if(command.type === "connect-lanes") {
          const fromTags=tagsOf(requireElement(document,"way",fromId)),toTags=tagsOf(requireElement(document,"way",toId));
          const fromRefs=refsOf(requireElement(document,"way",fromId)),toRefs=refsOf(requireElement(document,"way",toId));
          const fromLayout=drivingLanes(fromTags,roadStyle(fromTags).lanes,command.drivingSide),toLayout=drivingLanes(toTags,roadStyle(toTags).lanes,command.drivingSide);
          const incoming=fromRefs.indexOf(fromNode)<fromRefs.indexOf(via)?fromLayout.forward:fromLayout.backward;
          const outgoing=toRefs.indexOf(toNode)>toRefs.indexOf(via)?toLayout.forward:toLayout.backward;
          if(!incoming.includes(command.fromLane)||!outgoing.includes(command.toLane))throw Error("Выбранная полоса направлена против движения. Выберите полосу правильного направления");
          const a=laneTagInfo(fromTags,roadStyle(fromTags).lanes,command.fromLane,command.drivingSide)!,b=laneTagInfo(toTags,roadStyle(toTags).lanes,command.toLane,command.drivingSide)!;
          if(!new TurnRules(document).allowed({wayId:fromId,from:fromNode,to:via},{wayId:toId,from:via,to:toNode},[fromId]))throw Error("Соединение полос противоречит установленному запрету поворота");
          let relation=[...document.relations.values()].find(rel=>tagsOf(rel).type==="connectivity"&&[["from",fromId],["via",via],["to",toId]].every(([role,ref])=>childElements(rel).some(m=>m.getAttribute("role")===role&&m.getAttribute("ref")===ref)));
          if(!relation){relation=newElement("relation");for(const [role,type,ref] of [["from","way",fromId],["via","node",via],["to","way",toId]]){const m=document.xml.createElement("member");m.setAttribute("role",role);m.setAttribute("type",type);m.setAttribute("ref",ref);relation.appendChild(m);}}
          setTags("relation",relation.getAttribute("id")!,{type:"connectivity",connectivity:formatConnectivity([...parseConnectivity(tagsOf(relation).connectivity||""),{from:a.index+1,to:b.index+1}])});
          patch.selection={type:"way",id:fromId};break;
        }
        for (const rel of document.relations.values()) {
          if (tagsOf(rel).type !== "restriction") continue;
          const members = childElements(rel);
          if (
            tagsOf(rel).restriction === restriction &&
            members.some(
              (m) =>
                m.getAttribute("role") === "via" &&
                m.getAttribute("ref") === via,
            ) &&
            members.some(
              (m) =>
                m.getAttribute("role") === "from" &&
                m.getAttribute("ref") === fromId,
            ) &&
            members.some(
              (m) =>
                m.getAttribute("role") === "to" &&
                m.getAttribute("ref") === toId,
            )
          )
            throw Error("Такой знак уже установлен");
        }
        const relation = newElement("relation"),
          id = relation.getAttribute("id")!;
        for (const [role, type, ref] of [
          ["from", "way", fromId],
          ["via", "node", via],
          ["to", "way", toId],
        ]) {
          const member = document.xml.createElement("member");
          member.setAttribute("role", role);
          member.setAttribute("type", type);
          member.setAttribute("ref", ref);
          relation.appendChild(member);
        }
        setTags("relation", id, { type: "restriction", restriction });
        const rules = new TurnRules(document),
          incoming = { wayId: fromId, from: fromNode, to: via };
        const exits = Array.from(document.ways).flatMap(([wayId, w]) => {
          if (!tagsOf(w).highway) return [];
          const refs = refsOf(w),
            at = refs.indexOf(via);
          if (at < 0) return [];
          return [refs[at - 1], refs[at + 1]]
            .filter((n): n is string => !!n && canTravel(w, via, n))
            .map((n) => ({ wayId, from: via, to: n }));
        });
        if (
          !exits.some((next) => rules.allowed(incoming, next, [fromId], "car"))
        )
          throw Error(
            "Знак вместе с существующими ограничениями запрещает все выезды с этого подъезда. Уберите противоречащее ограничение",
          );
        patch.selection = { type: "way", id: fromId };
        break;
      }
      case "set-tags": {
        const target = requireElement(
          document,
          command.target.type,
          command.target.id,
        );
        const combined = { ...tagsOf(target), ...command.tags };
        const total = Number(combined.lanes);
        const forward = Number(combined["lanes:forward"] || 0);
        const backward = Number(combined["lanes:backward"] || 0);
        if (total && forward + backward > total)
          throw new Error("Сумма полос по направлениям превышает общее число");
        if (combined.oneway === "yes" && backward > 0)
          throw new Error("Для oneway=yes нельзя указывать встречные полосы");
        if (combined.oneway === "-1" && forward > 0)
          throw new Error("Для oneway=-1 нельзя указывать прямые полосы");
        if (
          combined.bridge &&
          combined.bridge !== "no" &&
          combined.tunnel &&
          combined.tunnel !== "no"
        )
          throw new Error(
            "Объект не может быть одновременно мостом и тоннелем",
          );
        setTags(command.target.type, command.target.id, command.tags);
        break;
      }
      case "create-road": {
        if (command.points.length < 2)
          throw new Error("Для дороги нужны минимум две точки");
        checkTags(command.tags);
        const ids = command.points.map(pointId);
        const positions = ids.map((id) =>
          coordinateOf(requireElement(document, "node", id)),
        );
        if (
          new Set(positions.map((p) => `${p.lat}/${p.lon}`)).size < 2 ||
          ids.some((id, index) => index > 0 && id === ids[index - 1])
        )
          throw new Error("Дорога должна содержать разные точки");
        // Connect every at-grade crossing to the OSM graph, including crossings
        // between clicks. Keep the original ways and their relation references.
        const projection = createProjection(positions[0]);
        const xy = positions.map((coordinate) =>
          projection.project(coordinate),
        );
        const onNew = new Map<number, { t: number; id: string }[]>();
        const onOld = new Map<
          string,
          Map<number, { t: number; id: string }[]>
        >();
        const made: { x: number; z: number; id: string }[] = [];
        const atGround = (tags: Tags) =>
          tags.highway &&
          ![
            "footway",
            "path",
            "steps",
            "pedestrian",
            "cycleway",
            "construction",
            "proposed",
          ].includes(tags.highway) &&
          (!tags.bridge || tags.bridge === "no") &&
          (!tags.tunnel || tags.tunnel === "no") &&
          tags.covered !== "yes" &&
          Number(tags.layer || 0) === Number(command.tags.layer || 0);
        if (atGround({ highway: "residential", ...command.tags })) {
          for (const [wayId, other] of document.ways) {
            if (!atGround(tagsOf(other))) continue;
            const refs = refsOf(other);
            for (let j = 1; j < refs.length; j++) {
              const a = projection.project(
                coordinateOf(requireElement(document, "node", refs[j - 1])),
              );
              const b = projection.project(
                coordinateOf(requireElement(document, "node", refs[j])),
              );
              const bx = b.x - a.x,
                bz = b.z - a.z;
              for (let i = 1; i < xy.length; i++) {
                const p = xy[i - 1],
                  q = xy[i];
                if (
                  Math.max(p.x, q.x) < Math.min(a.x, b.x) ||
                  Math.min(p.x, q.x) > Math.max(a.x, b.x) ||
                  Math.max(p.z, q.z) < Math.min(a.z, b.z) ||
                  Math.min(p.z, q.z) > Math.max(a.z, b.z)
                )
                  continue;
                const dx = q.x - p.x,
                  dz = q.z - p.z;
                const cross = dx * bz - dz * bx;
                if (Math.abs(cross) < 0.0001) continue;
                const rx = a.x - p.x,
                  rz = a.z - p.z;
                const t = (rx * bz - rz * bx) / cross;
                const u = (rx * dz - rz * dx) / cross;
                if (t < 0 || t > 1 || u < 0 || u > 1) continue;
                const x = p.x + t * dx,
                  z = p.z + t * dz;
                const newStart = Math.hypot(x - p.x, z - p.z) < 0.75;
                const newEnd = Math.hypot(x - q.x, z - q.z) < 0.75;
                const oldStart = Math.hypot(x - a.x, z - a.z) < 0.75;
                const oldEnd = Math.hypot(x - b.x, z - b.z) < 0.75;
                const known = made.find(
                  (candidate) =>
                    Math.hypot(candidate.x - x, candidate.z - z) < 0.75,
                );
                const id = oldStart
                  ? refs[j - 1]
                  : oldEnd
                    ? refs[j]
                    : newStart
                      ? ids[i - 1]
                      : newEnd
                        ? ids[i]
                        : (known?.id ??
                          (() => {
                            const node = newElement("node");
                            const coordinate = projection.unproject({ x, z });
                            node.setAttribute("lat", coordinate.lat.toFixed(9));
                            node.setAttribute("lon", coordinate.lon.toFixed(9));
                            return node.getAttribute("id")!;
                          })());
                made.push({ x, z, id });
                if (
                  !newStart &&
                  !newEnd &&
                  id !== ids[i - 1] &&
                  id !== ids[i]
                ) {
                  const list = onNew.get(i) ?? [];
                  if (!list.some((entry) => entry.id === id))
                    list.push({ t, id });
                  onNew.set(i, list);
                }
                if (
                  !oldStart &&
                  !oldEnd &&
                  id !== refs[j - 1] &&
                  id !== refs[j]
                ) {
                  const segments =
                    onOld.get(wayId) ??
                    new Map<number, { t: number; id: string }[]>();
                  const list = segments.get(j) ?? [];
                  if (!list.some((entry) => entry.id === id))
                    list.push({ t: u, id });
                  segments.set(j, list);
                  onOld.set(wayId, segments);
                }
              }
            }
          }
        }
        for (const [wayId, segments] of onOld) {
          const other = requireElement(document, "way", wayId);
          touch("way", wayId);
          const refs = refsOf(other);
          const nextRefs = [refs[0]];
          for (let j = 1; j < refs.length; j++) {
            nextRefs.push(
              ...(segments.get(j) ?? [])
                .sort((a, b) => a.t - b.t)
                .map((entry) => entry.id),
              refs[j],
            );
          }
          for (const nd of childElements(other).filter(
            (child) => child.tagName === "nd",
          ))
            nd.remove();
          const beforeTags =
            childElements(other).find((child) => child.tagName === "tag") ??
            null;
          for (const ref of nextRefs) {
            const nd = document.xml.createElement("nd");
            nd.setAttribute("ref", ref);
            other.insertBefore(nd, beforeTags);
          }
        }
        const way = newElement("way");
        const id = way.getAttribute("id")!;
        const connected = [ids[0]];
        for (let i = 1; i < ids.length; i++)
          connected.push(
            ...(onNew.get(i) ?? [])
              .sort((a, b) => a.t - b.t)
              .map((entry) => entry.id),
            ids[i],
          );
        for (const ref of connected.filter(
          (ref, index) => index === 0 || ref !== connected[index - 1],
        )) {
          const nd = document.xml.createElement("nd");
          nd.setAttribute("ref", ref);
          way.appendChild(nd);
        }
        setTags("way", id, { highway: "residential", ...command.tags });
        patch.selection = { type: "way", id };
        break;
      }
      case "merge-endpoint": {
        const source = requireElement(document, "way", command.wayId);
        const sourceTags = tagsOf(source);
        const refs = refsOf(source);
        if (
          !sourceTags.highway ||
          (refs[0] !== command.nodeId &&
            refs[refs.length - 1] !== command.nodeId)
        )
          throw new Error("Выберите свободный конец дороги");
        const node = requireElement(document, "node", command.nodeId);
        const owners = Array.from(document.ways.values()).filter(
          (way) => tagsOf(way).highway && refsOf(way).includes(command.nodeId),
        );
        if (owners.length !== 1 || owners[0] !== source)
          throw new Error("Конец уже соединён с другой дорогой");
        if (
          Object.keys(tagsOf(node)).length ||
          Array.from(document.relations.values()).some((relation) =>
            childElements(relation).some(
              (member) =>
                member.tagName === "member" &&
                member.getAttribute("type") === "node" &&
                member.getAttribute("ref") === command.nodeId,
            ),
          )
        )
          throw new Error(
            "Конечный узел имеет теги или входит в OSM-отношение",
          );
        const sourceGround =
          (!sourceTags.bridge || sourceTags.bridge === "no") &&
          (!sourceTags.tunnel || sourceTags.tunnel === "no") &&
          sourceTags.covered !== "yes" &&
          Number(sourceTags.layer || 0) === 0;
        if (!sourceGround)
          throw new Error("Соединять можно наземные дороги одного уровня");
        const targetNodeId =
          "nodeId" in command.target ? command.target.nodeId : null;
        const targetWayId =
          "wayId" in command.target
            ? command.target.wayId
            : targetNodeId
              ? Array.from(document.ways, ([id, way]) =>
                  tagsOf(way).highway && refsOf(way).includes(targetNodeId)
                    ? id
                    : "",
                ).find(Boolean)
              : "";
        if (!targetWayId || targetWayId === command.wayId)
          throw new Error("Выберите другую дорогу");
        const targetWay = requireElement(document, "way", targetWayId);
        const targetTags = tagsOf(targetWay);
        if (
          !targetTags.highway ||
          (targetTags.bridge && targetTags.bridge !== "no") ||
          (targetTags.tunnel && targetTags.tunnel !== "no") ||
          targetTags.covered === "yes" ||
          Number(targetTags.layer || 0) !== 0
        )
          throw new Error(
            "Целевая дорога должна быть наземной и на том же уровне",
          );
        const targetId = pointId(command.target);
        if (targetId === command.nodeId || refs.includes(targetId))
          throw new Error("Дорога уже использует этот узел");
        touch("way", command.wayId);
        const nds = childElements(source).filter(
          (child) => child.tagName === "nd",
        );
        (refs[0] === command.nodeId
          ? nds[0]
          : nds[nds.length - 1]
        ).setAttribute("ref", targetId);
        if (
          !Array.from(document.ways.values()).some((way) =>
            refsOf(way).includes(command.nodeId),
          )
        ) {
          touch("node", command.nodeId);
          node.remove();
          document.nodes.delete(command.nodeId);
        }
        patch.selection = { type: "way", id: command.wayId };
        break;
      }
      case "add-bus-stop": {
        const way = requireElement(document, "way", command.wayId);
        if (!tagsOf(way).highway)
          throw new Error("Остановка должна находиться на дороге");
        const id =
          "nodeId" in command.point &&
          refsOf(way).includes(command.point.nodeId)
            ? command.point.nodeId
            : insert(command.wayId, command.index, command.point);
        const node = requireElement(document, "node", id);
        if (tagsOf(node).highway === "traffic_signals")
          throw new Error("Выберите место без светофора");
        setTags("node", id, { public_transport: "stop_position", bus: "yes" });
        patch.selection = { type: "node", id };
        break;
      }
      case "remove-bus-stop": {
        const node = requireElement(document, "node", command.id);
        if (
          tagsOf(node).public_transport !== "stop_position" ||
          tagsOf(node).bus !== "yes"
        )
          throw new Error("Выбранный узел не является автобусной остановкой");
        if (
          Array.from(document.relations.values()).some(
            (relation) =>
              tagsOf(relation).route === "bus" &&
              childElements(relation).some(
                (member) =>
                  member.tagName === "member" &&
                  member.getAttribute("type") === "node" &&
                  member.getAttribute("ref") === command.id,
              ),
          )
        )
          throw new Error(
            "Остановка входит в автобусный маршрут. Сначала удалите маршрут.",
          );
        setTags("node", command.id, {
          public_transport: null,
          bus: null,
          name: null,
        });
        break;
      }
      case "create-bus-route": {
        const name = command.name.trim();
        if (
          !name ||
          command.stops.length < 2 ||
          new Set(command.stops).size !== command.stops.length
        )
          throw new Error("Укажите название и минимум две разные остановки");
        for (const id of command.stops) {
          const tags = tagsOf(requireElement(document, "node", id));
          if (tags.public_transport !== "stop_position" || tags.bus !== "yes")
            throw new Error(`Узел ${id} не является автобусной остановкой`);
        }
        for (const id of command.ways ?? []) {
          if (!tagsOf(requireElement(document, "way", id)).highway)
            throw new Error(`Участок ${id} не является дорогой`);
        }
        const relation = newElement("relation");
        for (const id of command.ways ?? []) {
          const member = document.xml.createElement("member");
          member.setAttribute("type", "way");
          member.setAttribute("ref", id);
          member.setAttribute("role", "");
          relation.appendChild(member);
        }
        for (const id of command.stops) {
          const member = document.xml.createElement("member");
          member.setAttribute("type", "node");
          member.setAttribute("ref", id);
          member.setAttribute("role", "stop");
          relation.appendChild(member);
        }
        setTags("relation", relation.getAttribute("id")!, {
          type: "route",
          route: "bus",
          name,
        });
        break;
      }
      case "delete-bus-route": {
        const relation = requireElement(document, "relation", command.id);
        if (tagsOf(relation).route !== "bus")
          throw new Error("Это не автобусный маршрут");
        touch("relation", command.id);
        relation.remove();
        document.relations.delete(command.id);
        break;
      }
      case "move-node": {
        checkCoordinate(command.coordinate);
        const node = requireElement(document, "node", command.id);
        touch("node", command.id);
        node.setAttribute("lat", command.coordinate.lat.toFixed(9));
        node.setAttribute("lon", command.coordinate.lon.toFixed(9));
        break;
      }
      case "insert-node": {
        insert(command.wayId, command.index, command.point);
        patch.selection = { type: "way", id:command.wayId };
        break;
      }
      case "remove-vertex": {
        const way = requireElement(document, "way", command.wayId);
        const refs = refsOf(way);
        if (
          !Number.isInteger(command.index) ||
          command.index < 0 ||
          command.index >= refs.length
        )
          throw new Error("Вершина не найдена");
        const closed=refs[0]===refs[refs.length-1];
        if(closed&&refs.length<=4)throw Error("В замкнутом контуре должны остаться минимум три вершины");
        if (refs.length <= 2)
          throw new Error("В дороге должны остаться минимум две вершины");
        const id = refs[command.index];
        if (
          tagsOf(requireElement(document, "node", id)).highway ===
          "traffic_signals"
        )
          throw new Error("Сначала удалите светофор с этой вершины");
        if (
          Array.from(document.ways.values()).some(
            (other) => other !== way && refsOf(other).includes(id),
          )
        )
          throw new Error(
            "Общий узел соединяет дороги: удаление вершины заблокировано",
          );
        if (
          Array.from(document.relations.values()).some((rel) =>
            childElements(rel).some(
              (m) =>
                m.getAttribute("type") === "node" &&
                m.getAttribute("ref") === id,
            ),
          )
        )
          throw new Error("Узел используется в отношении");
        touch("way", command.wayId);
        const nds=childElements(way).filter(child=>child.tagName==="nd");
        if(closed&&(command.index===0||command.index===refs.length-1)){nds[0].remove();nds[nds.length-1].setAttribute("ref",refs[1]);}
        else nds[command.index].remove();
        break;
      }
      case "delete-way": {
        const way = requireElement(document, "way", command.id);
        if (
          Array.from(document.relations.values()).some((rel) =>
            childElements(rel).some(
              (m) =>
                m.tagName === "member" &&
                m.getAttribute("type") === "way" &&
                m.getAttribute("ref") === command.id,
            ),
          )
        )
          throw new Error(
            "Дорога входит в отношение OSM. Удаление заблокировано для сохранения связей.",
          );
        touch("way", command.id);
        way.remove();
        document.ways.delete(command.id);
        break;
      }
      case "add-signal": {
        const way = requireElement(document, "way", command.wayId);
        if (!tagsOf(way).highway)
          throw new Error("Светофор должен принадлежать дороге");
        const id =
          "nodeId" in command.point &&
          refsOf(way).includes(command.point.nodeId)
            ? command.point.nodeId
            : insert(command.wayId, command.index, command.point);
        const highway = tagsOf(requireElement(document, "node", id)).highway;
        if (highway && highway !== "traffic_signals")
          throw new Error(
            "Узел уже содержит highway. Выберите свободный участок рядом.",
          );
        setTags("node", id, { highway: "traffic_signals" });
        patch.selection = { type: "node", id };
        break;
      }
      case "smooth-road": {
        const way = requireElement(document, "way", command.wayId);
        const refs = refsOf(way);
        if (
          !tagsOf(way).highway ||
          refs.length < 3 ||
          refs[0] === refs[refs.length - 1]
        )
          throw new Error(
            "Для сглаживания выберите незамкнутую дорогу с изгибами",
          );
        const radius = Math.max(1, Math.min(command.radius ?? 8, 30));
        const projection = createProjection(
          coordinateOf(
            requireElement(document, "node", refs[Math.floor(refs.length / 2)]),
          ),
        );
        const projected = refs.map((id) =>
          projection.project(
            coordinateOf(requireElement(document, "node", id)),
          ),
        );
        const occurrences = new Map<string, number>();
        for (const candidate of document.ways.values())
          for (const id of new Set(refsOf(candidate)))
            occurrences.set(id, (occurrences.get(id) ?? 0) + 1);
        const relationRefs = new Set<string>();
        for (const relation of document.relations.values())
          for (const member of childElements(relation))
            if (
              member.tagName === "member" &&
              member.getAttribute("type") === "node"
            )
              relationRefs.add(member.getAttribute("ref")!);
        const result: string[] = [refs[0]];
        let corners = 0;
        for (let i = 1; i < refs.length - 1; i++) {
          const id = refs[i];
          const node = requireElement(document, "node", id);
          const point = projected[i],
            before = projected[i - 1],
            after = projected[i + 1];
          const ax = point.x - before.x,
            az = point.z - before.z;
          const bx = after.x - point.x,
            bz = after.z - point.z;
          const la = Math.hypot(ax, az),
            lb = Math.hypot(bx, bz);
          const dot = (ax * bx + az * bz) / (la * lb || 1);
          const protectedNode =
            (occurrences.get(id) ?? 0) > 1 ||
            refs.indexOf(id) !== refs.lastIndexOf(id) ||
            relationRefs.has(id) ||
            Object.keys(tagsOf(node)).length > 0;
          const trim = Math.min(radius, la * 0.32, lb * 0.32);
          if (
            protectedNode ||
            dot > 0.96 ||
            dot < -0.98 ||
            trim < 0.5 ||
            !Number.isFinite(trim)
          ) {
            result.push(id);
            continue;
          }
          if (corners >= 80)
            throw new Error(
              "Слишком много изгибов в одном действии. Разделите дорогу на участки.",
            );
          corners++;
          const p0 = {
            x: point.x - (ax / la) * trim,
            z: point.z - (az / la) * trim,
          };
          const p2 = {
            x: point.x + (bx / lb) * trim,
            z: point.z + (bz / lb) * trim,
          };
          for (let step = 0; step <= 6; step++) {
            const t = step / 6,
              s = 1 - t;
            const coordinate = projection.unproject({
              x: p0.x * s * s + point.x * 2 * s * t + p2.x * t * t,
              z: p0.z * s * s + point.z * 2 * s * t + p2.z * t * t,
            });
            const fresh = newElement("node");
            fresh.setAttribute("lat", coordinate.lat.toFixed(9));
            fresh.setAttribute("lon", coordinate.lon.toFixed(9));
            result.push(fresh.getAttribute("id")!);
          }
        }
        if (!corners)
          throw new Error(
            "Нет сглаживаемых поворотов. Общие перекрёстки и значимые узлы защищены.",
          );
        result.push(refs[refs.length - 1]);
        touch("way", command.wayId);
        for (const nd of childElements(way).filter(
          (item) => item.tagName === "nd",
        ))
          nd.remove();
        const beforeTags =
          childElements(way).find((item) => item.tagName === "tag") ?? null;
        for (const id of result) {
          const nd = document.xml.createElement("nd");
          nd.setAttribute("ref", id);
          way.insertBefore(nd, beforeTags);
        }
        patch.selection = { type: "way", id: command.wayId };
        break;
      }
      case "connect-crossing": {
        const { wayA, wayB, indexA, indexB, coordinate } = command;
        if (wayA === wayB) throw new Error("Нужны две разные дороги");
        checkCoordinate(coordinate);
        const first = requireElement(document, "way", wayA);
        const second = requireElement(document, "way", wayB);
        const firstTags = tagsOf(first);
        const secondTags = tagsOf(second);
        if (!firstTags.highway || !secondTags.highway)
          throw new Error("Соединять можно только дороги");
        const surface = (tags: Tags) =>
          !(
            (tags.bridge && tags.bridge !== "no") ||
            (tags.tunnel && tags.tunnel !== "no") ||
            tags.covered === "yes" ||
            tags.indoor === "yes"
          );
        if (
          !surface(firstTags) ||
          !surface(secondTags) ||
          Number(firstTags.layer || 0) !== Number(secondTags.layer || 0)
        )
          throw new Error("Нельзя соединять разные уровни или мосты/тоннели");
        const projection = (point: Coordinate) => {
          const scale = 111319.49079327358;
          return {
            x: point.lon * scale * Math.cos((coordinate.lat * Math.PI) / 180),
            y: point.lat * scale,
          };
        };
        const near = (a: Coordinate, b: Coordinate) => {
          const p = projection(a),
            q = projection(b);
          return Math.hypot(p.x - q.x, p.y - q.y);
        };
        const segment = (way: Element, index: number) => {
          const refs = refsOf(way);
          if (!Number.isInteger(index) || index < 1 || index >= refs.length)
            throw new Error("Сегмент изменился. Запустите проверку повторно");
          const a = coordinateOf(
            requireElement(document, "node", refs[index - 1]),
          );
          const b = coordinateOf(requireElement(document, "node", refs[index]));
          if (near(a, coordinate) < 0.75 || near(b, coordinate) < 0.75)
            throw new Error(
              "Пересечение у конца сегмента: соедините узлы вручную",
            );
          const p = projection(coordinate),
            u = projection(a),
            v = projection(b);
          const dx = v.x - u.x,
            dy = v.y - u.y;
          const t =
            ((p.x - u.x) * dx + (p.y - u.y) * dy) / (dx * dx + dy * dy || 1);
          const distance = Math.hypot(
            p.x - (u.x + t * dx),
            p.y - (u.y + t * dy),
          );
          if (t <= 0 || t >= 1 || distance > 0.35)
            throw new Error("Пересечение больше не лежит на сегменте");
          return refs;
        };
        const refsA = segment(first, indexA);
        const refsB = segment(second, indexB);
        if (refsA.some((id) => refsB.includes(id)))
          throw new Error("Дороги уже соединены общим узлом");
        const node = newElement("node");
        node.setAttribute("lat", coordinate.lat.toFixed(9));
        node.setAttribute("lon", coordinate.lon.toFixed(9));
        const id = node.getAttribute("id")!;
        for (const [way, index] of [
          [first, indexA],
          [second, indexB],
        ] as const) {
          touch("way", way.getAttribute("id")!);
          const refs = childElements(way).filter(
            (element) => element.tagName === "nd",
          );
          const nd = document.xml.createElement("nd");
          nd.setAttribute("ref", id);
          way.insertBefore(nd, refs[index]);
        }
        patch.selection = { type: "node", id };
        break;
      }
      case "attach-endpoint": {
        const { nodeId, targetWayId, targetIndex, coordinate } = command;
        checkCoordinate(coordinate);
        const node = requireElement(document, "node", nodeId);
        const target = requireElement(document, "way", targetWayId);
        const tags = tagsOf(target);
        if (
          !tags.highway ||
          (tags.bridge && tags.bridge !== "no") ||
          (tags.tunnel && tags.tunnel !== "no") ||
          tags.covered === "yes"
        )
          throw new Error(
            "Стыковка допускается только на дороге на одном уровне",
          );
        if (refsOf(target).includes(nodeId))
          throw new Error("Этот узел уже принадлежит целевой дороге");
        const owners = Array.from(document.ways.values()).filter(
          (way) => tagsOf(way).highway && refsOf(way).includes(nodeId),
        );
        if (owners.length !== 1)
          throw new Error(
            "Узел должен быть свободным концом ровно одной дороги",
          );
        const owner = owners[0];
        const ownerRefs = refsOf(owner);
        if (
          ownerRefs[0] !== nodeId &&
          ownerRefs[ownerRefs.length - 1] !== nodeId
        )
          throw new Error("Узел не является концом дороги");
        const ownerTags = tagsOf(owner);
        if (
          (ownerTags.bridge && ownerTags.bridge !== "no") ||
          (ownerTags.tunnel && ownerTags.tunnel !== "no") ||
          ownerTags.covered === "yes" ||
          Number(ownerTags.layer || 0) !== Number(tags.layer || 0)
        )
          throw new Error("Нельзя соединять дороги на разных уровнях");
        if (
          Array.from(document.relations.values()).some((rel) =>
            childElements(rel).some(
              (member) =>
                member.tagName === "member" &&
                member.getAttribute("type") === "node" &&
                member.getAttribute("ref") === nodeId,
            ),
          )
        )
          throw new Error(
            "Этот узел входит в OSM-отношение; проверьте его вручную",
          );
        const refs = refsOf(target);
        if (
          !Number.isInteger(targetIndex) ||
          targetIndex < 1 ||
          targetIndex >= refs.length
        )
          throw new Error("Целевой сегмент больше не существует");
        const a = coordinateOf(
          requireElement(document, "node", refs[targetIndex - 1]),
        );
        const b = coordinateOf(
          requireElement(document, "node", refs[targetIndex]),
        );
        const meters = (p: Coordinate) => {
          const scale = 111319.49079327358;
          return {
            x: p.lon * scale * Math.cos((coordinate.lat * Math.PI) / 180),
            y: p.lat * scale,
          };
        };
        const p = meters(coordinate),
          u = meters(a),
          v = meters(b);
        const dx = v.x - u.x,
          dy = v.y - u.y;
        const length2 = dx * dx + dy * dy;
        const t = ((p.x - u.x) * dx + (p.y - u.y) * dy) / (length2 || 1);
        if (
          t <= 0 ||
          t >= 1 ||
          Math.sqrt(length2) * Math.min(t, 1 - t) < 0.75 ||
          Math.hypot(p.x - (u.x + t * dx), p.y - (u.y + t * dy)) > 0.35
        )
          throw new Error("Точка привязки не находится внутри сегмента");
        const original = coordinateOf(node);
        const old = meters(original);
        if (Math.hypot(old.x - p.x, old.y - p.y) > 4)
          throw new Error("Разрыв больше 4 м: проверьте дорогу вручную");
        touch("node", nodeId);
        touch("way", targetWayId);
        node.setAttribute("lat", coordinate.lat.toFixed(9));
        node.setAttribute("lon", coordinate.lon.toFixed(9));
        const nds = childElements(target).filter(
          (element) => element.tagName === "nd",
        );
        const nd = document.xml.createElement("nd");
        nd.setAttribute("ref", nodeId);
        target.insertBefore(nd, nds[targetIndex]);
        patch.selection = { type: "node", id: nodeId };
        break;
      }
      case "remove-signal": {
        const node = requireElement(document, "node", command.id);
        if (tagsOf(node).highway !== "traffic_signals")
          throw new Error("Выбранный узел не является светофором");
        setTags(
          "node",
          command.id,
          Object.fromEntries(
            Object.keys(tagsOf(node))
              .filter(
                (key) => key === "highway" || key.startsWith("traffic_signals"),
              )
              .map((key) => [key, null]),
          ),
        );
        break;
      }
    }
    patch.changes = Array.from(touched.values(), (change) => ({
      ...change,
      after:
        (elements(document, change.type)
          .get(change.id)
          ?.cloneNode(true) as Element) ?? null,
    }));
    assertRoadEditSafe(document, patch);
    return patch;
  } catch (error) {
    applyPatch(
      document,
      {
        label: command.type,
        changes: Array.from(touched.values(), (change) => ({
          ...change,
          after: null,
        })),
      },
      "before",
    );
    throw error;
  }
}
