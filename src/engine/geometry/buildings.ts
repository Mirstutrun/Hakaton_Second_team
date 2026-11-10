import { Mesh, VertexData, Color3, type Vector3, type Scene, type Material } from "@babylonjs/core";
import earcut from "earcut";
import type { Tags } from "../../core/osm/model";
export type PassageCut={a:{x:number;z:number};b:{x:number;z:number};width:number;height:number};
/** Roofs preserve inner courtyards; walls are cut only where a declared passage crosses. */
export function buildBuilding(id:string,points:Vector3[],tags:Tags,scene:Scene,material:Material,holes:Vector3[][]=[],passages:PassageCut[]=[]):Mesh|null {
  const clean=(ring:Vector3[])=>ring.length>2&&ring[0].equals(ring.at(-1)!)?ring.slice(0,-1):ring;
  const rings=[clean(points),...holes.map(clean)];if(rings[0].length<3||rings.some(r=>r.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.z))))return null;
  // Навес (building=roof) — крыша без стен: рисуется плитой наверху, под ней виден проезд.
  const roof=tags.building==="roof";
  const height=Math.max(2,Math.min(200,Number.parseFloat(tags.height)||Number(tags["building:levels"])*3.2||(roof?5:9.6))),base=Math.max(0,Math.min(height-(roof?0.4:1),Number.parseFloat(tags.min_height)||(roof?height-0.6:0)));
  const positions:number[]=[],indices:number[]=[],colors:number[]=[];
  const palette=[[.76,.77,.70],[.78,.76,.69],[.73,.77,.74],[.78,.78,.74]],hash=[...id].reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,0);
  let tint=palette[hash%palette.length];if(/^#[0-9a-f]{6}$/i.test(tags["building:colour"]||"")){const c=Color3.FromHexString(tags["building:colour"]);tint=[c.r,c.g,c.b];}
  const color=(shade:number)=>colors.push(...tint.map(c=>Math.min(1,c*shade)),1);
  const flat=rings.flat();flat.forEach(p=>{positions.push(p.x,height,p.z);color(1.08);});
  const holeStarts:number[]=[];let count=rings[0].length;for(const hole of rings.slice(1)){holeStarts.push(count);count+=hole.length;}
  const triangles=earcut(flat.flatMap(p=>[p.x,p.z]),holeStarts);
  for(let i=0;i<triangles.length;i+=3){const [a,b,c]=triangles.slice(i,i+3),cross=(flat[b].z-flat[a].z)*(flat[c].x-flat[a].x)-(flat[b].x-flat[a].x)*(flat[c].z-flat[a].z);indices.push(a,cross>=0?c:b,cross>=0?b:c);}
  for(const ring of rings)ring.forEach((p,i)=>{
    const q=ring[(i+1)%ring.length],dx=q.x-p.x,dz=q.z-p.z,len=Math.hypot(dx,dz)||1,breaks=[0,1];
    for(const passage of passages){const x=passage.b.x-passage.a.x,z=passage.b.z-passage.a.z,L=Math.hypot(x,z)||1,r=passage.width/2;
      const f0=((p.x-passage.a.x)*-z+(p.z-passage.a.z)*x)/L,fd=(dx*-z+dz*x)/L,g0=((p.x-passage.a.x)*x+(p.z-passage.a.z)*z)/L,gd=(dx*x+dz*z)/L;
      if(Math.abs(fd)>1e-9)for(const value of [-r,r]){const t=(value-f0)/fd;if(t>0&&t<1)breaks.push(t);}
      if(Math.abs(gd)>1e-9)for(const value of [-r,L+r]){const t=(value-g0)/gd;if(t>0&&t<1)breaks.push(t);}
    }
    breaks.sort((a,b)=>a-b);
    for(let j=1;j<breaks.length;j++){const a=breaks[j-1],b=breaks[j];if(b-a<1e-7)continue;const t=(a+b)/2,mid={x:p.x+dx*t,z:p.z+dz*t};let bottom=base;
      for(const passage of passages){const x=passage.b.x-passage.a.x,z=passage.b.z-passage.a.z,L=Math.hypot(x,z)||1,d=((mid.x-passage.a.x)*-z+(mid.z-passage.a.z)*x)/L,g=((mid.x-passage.a.x)*x+(mid.z-passage.a.z)*z)/L;if(Math.abs(d)<passage.width/2+1e-5&&g>=-passage.width/2&&g<=L+passage.width/2)bottom=Math.max(bottom,passage.height);}
      if(bottom>=height)continue;const start=positions.length/3;
      positions.push(p.x+dx*a,bottom,p.z+dz*a,p.x+dx*b,bottom,p.z+dz*b,p.x+dx*a,height,p.z+dz*a,p.x+dx*b,height,p.z+dz*b);
      const shade=.89+.06*Math.abs(dx/len)+.03*Math.abs(dz/len);for(let k=0;k<4;k++)color(shade);indices.push(start,start+2,start+1,start+1,start+2,start+3);
    }
  });
  const mesh=new Mesh(`building:${id}`,scene),data=new VertexData();data.positions=positions;data.indices=indices;data.colors=colors;const normals:number[]=[];VertexData.ComputeNormals(positions,indices,normals);data.normals=normals;data.applyToMesh(mesh);mesh.material=material;mesh.useVertexColors=true;mesh.isPickable=false;mesh.metadata={role:"building",type:"way",id};return mesh;
}
