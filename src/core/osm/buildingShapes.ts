import { coordinateOf,refsOf,tagsOf,childElements,type OsmDocument,type Tags } from "./model";
import {createProjection,documentOrigin} from "../geo/projection";
export type Point={x:number;z:number};
export function pointInRing(p:Point,ring:Point[]){let result=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a.z>p.z)!==(b.z>p.z)&&p.x<(b.x-a.x)*(p.z-a.z)/(b.z-a.z)+a.x)result=!result;}return result;}
export function segmentCrossing(a:Point,b:Point,c:Point,d:Point){const x=b.x-a.x,z=b.z-a.z,u=d.x-c.x,v=d.z-c.z,den=x*v-z*u;if(Math.abs(den)<1e-9)return null;const t=((c.x-a.x)*v-(c.z-a.z)*u)/den,q=((c.x-a.x)*z-(c.z-a.z)*x)/den;return t>=-1e-8&&t<=1+1e-8&&q>=-1e-8&&q<=1+1e-8?Math.max(0,Math.min(1,t)):null;}
function joinRings(document:OsmDocument,ids:string[]){const pending=ids.map(id=>({refs:refsOf(document.ways.get(id)??document.xml.createElement("way")),ids:[id]})).filter(p=>p.refs.length>1),result:typeof pending=[];
while(pending.length){const ring=pending.pop()!;while(ring.refs[0]!==ring.refs.at(-1)){const end=ring.refs.at(-1),i=pending.findIndex(p=>p.refs[0]===end||p.refs.at(-1)===end);if(i<0)break;const p=pending.splice(i,1)[0];if(p.refs[0]!==end)p.refs.reverse();ring.refs.push(...p.refs.slice(1));ring.ids.push(...p.ids);}if(ring.refs.length>=4&&ring.refs[0]===ring.refs.at(-1))result.push(ring);}return result;}
export type BuildingShape={id:string;type:"way"|"relation";tags:Tags;outer:Point[];holes:Point[][];outerRefs:string[];holeRefs:string[][];wayIds:string[];outerWay:string};
export function buildingShapes(document:OsmDocument,projection=createProjection(documentOrigin(document))){
 const result:BuildingShape[]=[],members=new Set<string>();const points=(refs:string[])=>refs.slice(0,-1).map(id=>document.nodes.get(id)).filter((n):n is Element=>!!n).map(n=>projection.project(coordinateOf(n)));
 for(const [id,r] of document.relations){const tags=tagsOf(r);if(tags.type!=="multipolygon"||!(tags.building&&tags.building!=="no"||tags["building:part"]&&tags["building:part"]!=="no"))continue;
 const ms=childElements(r).filter(m=>m.tagName==="member"&&m.getAttribute("type")==="way"),outers=joinRings(document,ms.filter(m=>m.getAttribute("role")!=="inner").map(m=>m.getAttribute("ref")!)),inners=joinRings(document,ms.filter(m=>m.getAttribute("role")==="inner").map(m=>m.getAttribute("ref")!));
 for(const m of ms)members.add(m.getAttribute("ref")!);
 for(const outer of outers){const ring=points(outer.refs),holes=inners.filter(h=>{const p=points(h.refs)[0];return p&&pointInRing(p,ring);});result.push({id,type:"relation",tags,outer:ring,holes:holes.map(h=>points(h.refs)),outerRefs:outer.refs,holeRefs:holes.map(h=>h.refs),wayIds:[...outer.ids,...holes.flatMap(h=>h.ids)],outerWay:outer.ids[0]});}
 }
 for(const [id,w] of document.ways){const tags=tagsOf(w),refs=refsOf(w);if(!members.has(id)&&(tags.building&&tags.building!=="no"||tags["building:part"]&&tags["building:part"]!=="no")&&refs.length>=4&&refs[0]===refs.at(-1))result.push({id,type:"way",tags,outer:points(refs),holes:[],outerRefs:refs,holeRefs:[],wayIds:[id],outerWay:id});}return result;
}
export function buildingOwner(document:OsmDocument,wayId:string){const relation=[...document.relations].find(([,r])=>tagsOf(r).type==="multipolygon"&&(tagsOf(r).building||tagsOf(r)["building:part"])&&childElements(r).some(m=>m.tagName==="member"&&m.getAttribute("type")==="way"&&m.getAttribute("ref")===wayId));return relation?{id:relation[0],type:"relation" as const,element:relation[1]}:{id:wayId,type:"way" as const,element:document.ways.get(wayId)!};}
export function shapeContains(shape:BuildingShape,p:Point){return pointInRing(p,shape.outer)&&!shape.holes.some(h=>pointInRing(p,h));}
export function passageClearance(tags:Tags){return Number.parseFloat(tags.maxheight)||0;}
