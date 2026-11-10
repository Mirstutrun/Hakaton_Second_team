import { childElements, tagsOf, type OsmDocument } from "./model";
import type { TurnEdge } from "./turnRestrictions";
export function parseConnectivity(value:string) {
  const result:{from:number;to:number}[]=[];
  for(const entry of value.split("|")) {
    const [from,to]=entry.split(":");if(!/^\d+$/.test(from||""))continue;
    for(const target of (to||"").split(",")) {
      const lane=Number(target.replace(/[()]/g,""));if(Number(from)>0&&Number.isInteger(lane)&&lane>0)result.push({from:Number(from),to:lane});
    }
  }
  return result;
}
export function formatConnectivity(pairs:{from:number;to:number}[]) {
  const grouped=new Map<number,Set<number>>();for(const p of pairs){if(!grouped.has(p.from))grouped.set(p.from,new Set());grouped.get(p.from)!.add(p.to);}
  return [...grouped].sort((a,b)=>a[0]-b[0]).map(([from,to])=>`${from}:${[...to].sort((a,b)=>a-b).join(",")}`).join("|");
}
export function laneConnections(document:OsmDocument) {
  return [...document.relations].flatMap(([id,r])=>{
    if(tagsOf(r).type!=="connectivity")return [];
    const members=childElements(r),ref=(role:string,type:string)=>members.find(m=>m.tagName==="member"&&m.getAttribute("role")===role&&m.getAttribute("type")===type)?.getAttribute("ref");
    const fromWay=ref("from","way"),toWay=ref("to","way"),via=ref("via","node");
    if(!fromWay||!toWay||!via)return [];
    return parseConnectivity(tagsOf(r).connectivity||"").map(p=>({id,fromWay,toWay,via,...p}));
  });
}
export class LaneConnections {
  readonly entries:ReturnType<typeof laneConnections>;
  constructor(document:OsmDocument){this.entries=laneConnections(document);}
  targets(incoming:TurnEdge,next:TurnEdge,source:number):number[]|null {
    const configured=this.entries.filter(c=>c.fromWay===incoming.wayId&&c.via===incoming.to&&c.from===source);
    return configured.length?configured.filter(c=>c.toWay===next.wayId).map(c=>c.to):null;
  }
}
