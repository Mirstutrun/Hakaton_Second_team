import {coordinateOf,tagsOf,type OsmDocument} from "./model";
import type {createProjection,LocalPoint} from "../geo/projection";
export function obstacleFilter(document:OsmDocument,projection:ReturnType<typeof createProjection>){
 const blocks=[...document.nodes.values()].filter(n=>tagsOf(n).barrier==="block").map(n=>{const t=tagsOf(n),p=projection.project(coordinateOf(n));return {x:p.x,z:p.z,w:Math.max(.3,Number(t.width)||1.5)/2+.9,h:Math.max(.3,Number(t.length)||1.5)/2+.9};});
 return (a:LocalPoint,b:LocalPoint)=>blocks.some(o=>{let low=0,high=1;for(const [value,delta,min,max] of [[a.x,b.x-a.x,o.x-o.w,o.x+o.w],[a.z,b.z-a.z,o.z-o.h,o.z+o.h]]){if(Math.abs(delta)<1e-9){if(value<min||value>max)return false;}else{let u=(min-value)/delta,v=(max-value)/delta;if(u>v)[u,v]=[v,u];low=Math.max(low,u);high=Math.min(high,v);if(low>high)return false;}}return true;});
}
