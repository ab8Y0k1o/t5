import * as THREE from "https://unpkg.com/three@0.169.0/build/three.module.js";

const $ = (id) => document.getElementById(id);
const map = L.map("map", { zoomControl: true }).setView([35.6812, 139.7671], 13);
L.tileLayer("/api/cache/osm/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

let selection = null, meshLayer = null, centerMarker = null, sim = null;
const GRID = 33, SPAN = 1000, HALF = SPAN / 2;
const mapStatus = $("area-status");
const scene = $("scene");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize($("three-root").clientWidth, $("three-root").clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
$("three-root").appendChild(renderer.domElement);
const world = new THREE.Scene();
world.fog = new THREE.Fog(0x172c36, 1900, 4500);
const camera = new THREE.PerspectiveCamera(42, 1, 1, 8000);
const ambient = new THREE.HemisphereLight(0xd9eee6, 0x52634e, 2.0);
world.add(ambient);
const sun = new THREE.DirectionalLight(0xffe7bd, 2.1);
sun.position.set(-750, 1100, 600); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); world.add(sun);
let target = new THREE.Vector3(0, 0, 0), yaw = -.72, pitch = .72, distance = 1700;
let drag = null, elapsed = 0, running = false, lastFrame = performance.now();
const root = new THREE.Group(); world.add(root);

function updateCamera() {
  const p = pitch, d = distance;
  camera.position.set(target.x + d * Math.sin(yaw) * Math.cos(p), target.y + d * Math.sin(p), target.z + d * Math.cos(yaw) * Math.cos(p));
  camera.lookAt(target);
}
function resetCamera() { yaw = -.72; pitch = .72; distance = 1700; target.set(0, 0, 0); updateCamera(); }
$("reset-view").addEventListener("click", resetCamera);
renderer.domElement.addEventListener("pointerdown", e => { drag = { x:e.clientX, y:e.clientY, yaw, pitch }; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener("pointermove", e => {
  if (!drag) return;
  yaw = drag.yaw - (e.clientX - drag.x) * .006;
  pitch = THREE.MathUtils.clamp(drag.pitch + (e.clientY - drag.y) * .005, .16, 1.35);
  updateCamera();
});
renderer.domElement.addEventListener("pointerup", () => drag = null);
renderer.domElement.addEventListener("wheel", e => { e.preventDefault(); distance = THREE.MathUtils.clamp(distance * Math.exp(e.deltaY * .001), 850, 3200); updateCamera(); }, { passive:false });

function resize() {
  const box = $("three-root").getBoundingClientRect();
  if (!box.width || !box.height) return;
  renderer.setSize(box.width, box.height);
  camera.aspect = box.width / box.height; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe($("three-root"));

function boundsFor(lat, lon) {
  const dLat = HALF / 111320;
  const dLon = HALF / (111320 * Math.cos(lat * Math.PI / 180));
  return { south:lat-dLat, north:lat+dLat, west:lon-dLon, east:lon+dLon, dLat, dLon };
}
function choosePoint(latlng) {
  selection = { lat:latlng.lat, lon:latlng.lng, bounds:boundsFor(latlng.lat, latlng.lng) };
  const b = selection.bounds;
  if (meshLayer) map.removeLayer(meshLayer);
  if (centerMarker) map.removeLayer(centerMarker);
  meshLayer = L.rectangle([[b.south,b.west],[b.north,b.east]], { className:"mesh-rect", color:"#167b70", weight:2, fillColor:"#61b6a3", fillOpacity:.22 }).addTo(map);
  centerMarker = L.marker(latlng, { icon:L.divIcon({ className:"", html:'<div class="mesh-center"></div>', iconSize:[14,14], iconAnchor:[7,7] }) }).addTo(map);
  $("area-label").textContent = latlng.lat.toFixed(4) + ", " + latlng.lng.toFixed(4);
  mapStatus.textContent = "準備完了"; mapStatus.classList.add("ready");
  $("start-button").disabled = false;
  $("load-message").textContent = "";
}
map.on("click", e => choosePoint(e.latlng));
$("search-form").addEventListener("submit", async e => {
  e.preventDefault();
  const q = $("place-search").value.trim(); if (!q) return;
  $("load-message").textContent = "場所を検索中…";
  try {
    const data = await fetch("/api/cache/search?q="+encodeURIComponent(q)).then(r=>{if(!r.ok)throw new Error("場所検索APIに接続できません。");return r.json();});
    if (!data.length) throw new Error("場所が見つかりませんでした。");
    const p = L.latLng(+data[0].lat, +data[0].lon); map.setView(p, 15); choosePoint(p); $("load-message").textContent="";
  } catch(err) { $("load-message").textContent = err.message || "場所を検索できませんでした。"; }
});

function lonLatAt(x, z, b) {
  return { lat:b.north - (z / SPAN) * (b.north-b.south), lon:b.west + (x / SPAN) * (b.east-b.west) };
}
async function loadGsiElevations(coords) {
  const z=15, n=2**z, tiles=new Map();
  const points=coords.map(p=>{
    const latRad=p.lat*Math.PI/180;
    const xf=(p.lon+180)/360*n;
    const yf=(1-Math.asinh(Math.tan(latRad))/Math.PI)/2*n;
    const tx=Math.floor(xf),ty=Math.floor(yf);
    return {tx,ty,px:Math.min(255,Math.floor((xf-tx)*256)),py:Math.min(255,Math.floor((yf-ty)*256))};
  });
  let remaining=coords.map((_,i)=>i), used=[];
  for(const source of ["dem5a_png","dem5b_png","dem5c_png","dem_png"]) {
    const keys=[...new Set(remaining.map(i=>`${points[i].tx}/${points[i].ty}`))];
    await Promise.all(keys.map(async key=>{
      const [x,y]=key.split("/");
      try {
        const response=await fetch("/api/cache/gsi/"+source+"/"+z+"/"+x+"/"+y+".png");
        if(!response.ok) return;
        const bitmap=await createImageBitmap(await response.blob());
        const canvas=document.createElement("canvas");canvas.width=256;canvas.height=256;
        const context=canvas.getContext("2d",{willReadFrequently:true});context.drawImage(bitmap,0,0);bitmap.close();
        tiles.set(`${source}/${key}`,context.getImageData(0,0,256,256).data);
      } catch {}
    }));
    const next=[];
    for(const index of remaining) {
      const p=points[index], pixels=tiles.get(`${source}/${p.tx}/${p.ty}`);
      if(!pixels){next.push(index);continue;}
      const offset=(p.py*256+p.px)*4, r=pixels[offset],g=pixels[offset+1],b=pixels[offset+2];
      const encoded=r*65536+g*256+b;
      if(encoded===8388608){next.push(index);continue;}
      coords[index].elevation=(encoded<8388608?encoded:encoded-16777216)*.01;
      if(!used.includes(source))used.push(source);
    }
    remaining=next;
    if(!remaining.length) break;
  }
  return {values:coords.map(p=>p.elevation ?? null),remaining,source:used.join(" / ")};
}
async function loadOpenMeteoPoints(coords) {
  const values=new Array(coords.length);
  for(let start=0;start<coords.length;start+=50) {
    const batch=coords.slice(start,start+50);
    const lat=batch.map(p=>p.lat.toFixed(5)).join(","),lon=batch.map(p=>p.lon.toFixed(5)).join(",");
    const url="/api/cache/elevation?"+new URLSearchParams({latitude:lat,longitude:lon});
    let success=false;
    for(let attempt=0;attempt<3&&!success;attempt++) {
      try {
        const response=await fetch(url);
        if(!response.ok) throw new Error("HTTP "+response.status);
        const data=await response.json();
        if(!data.elevation||data.elevation.length!==batch.length)throw new Error("invalid elevation response");
        data.elevation.forEach((v,i)=>values[start+i]=v);success=true;
      } catch { if(attempt<2) await new Promise(resolve=>setTimeout(resolve,600*(attempt+1))); }
    }
    if(!success) throw new Error("Open-MeteoへのHTTPS接続に失敗しました");
    $("load-message").textContent=`標高データを取得中… ${Math.min(start+batch.length,coords.length)}/${coords.length}`;
  }
  return values;
}
async function loadElevations(b) {
  const coords=[];
  for(let j=0;j<GRID;j++) for(let i=0;i<GRID;i++) coords.push(lonLatAt(i/(GRID-1)*SPAN,j/(GRID-1)*SPAN,b));
  if(b.north>=20&&b.south<=46&&b.east>=122&&b.west<=154) {
    try {
      const gsi=await loadGsiElevations(coords);
      if(gsi.remaining.length===0) return {values:gsi.values,source:"国土地理院 "+gsi.source.replaceAll("_png","")};
      if(gsi.remaining.length<coords.length) {
        let completed=false;
        if(gsi.remaining.length<=100) {
          try {
            const fallback=await loadOpenMeteoPoints(gsi.remaining.map(i=>coords[i]));
            gsi.remaining.forEach((index,i)=>gsi.values[index]=fallback[i]);completed=true;
          } catch {}
        }
        if(!completed) {
          const valid=gsi.values.map((value,index)=>value==null?-1:index).filter(index=>index>=0);
          for(const index of gsi.remaining) {
            const x=index%GRID,y=Math.floor(index/GRID);
            let nearest=valid[0],best=Infinity;
            for(const candidate of valid) {
              const dx=candidate%GRID-x,dy=Math.floor(candidate/GRID)-y,d=dx*dx+dy*dy;
              if(d<best){best=d;nearest=candidate;}
            }
            gsi.values[index]=gsi.values[nearest];
          }
        }
        return {values:gsi.values,source:"国土地理院DEM"+(completed?" + Open-Meteo":"（欠測を近傍補間）")};
      }
    } catch {}
  }
  const values=await loadOpenMeteoPoints(coords);
  return {values,source:"Open-Meteo / Copernicus DEM"};
}
async function loadBuildings(b) {
  const query="[out:json][timeout:45];(way[\"building\"]("+b.south+","+b.west+","+b.north+","+b.east+");relation[\"building\"]("+b.south+","+b.west+","+b.north+","+b.east+"););out body;>;out skel qt;";
  const response=await fetch("/api/cache/overpass",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},body:new URLSearchParams({data:query})});
  if(!response.ok) throw new Error("建物データAPI（Overpass）が応答しません。ローカルサーバーのログを確認してください。");
  const json=await response.json();
  const nodes=new Map(json.elements.filter(e=>e.type==="node").map(n=>[n.id,[n.lon,n.lat]]));
  const ways=json.elements.filter(e=>e.type==="way"&&e.tags?.building);
  return ways.map(w=>({tags:w.tags,points:w.nodes.map(id=>nodes.get(id)).filter(Boolean)})).filter(w=>w.points.length>=3);
}
function clearRoot() {
  while(root.children.length) {
    const obj=root.children[0]; root.remove(obj);
    obj.traverse?.(child=>{child.geometry?.dispose?.(); if(child.material){ for(const m of (Array.isArray(child.material)?child.material:[child.material])) m.dispose?.(); }});
  }
}
function toLocal(lon,lat,b) { return {x:(lon-b.west)/(b.east-b.west)*SPAN-HALF,z:(b.north-lat)/(b.north-b.south)*SPAN-HALF}; }
function gridGround(i,j,heights,minH,scale) { return (heights[j*GRID+i]-minH)*scale; }
function buildTerrain(heights,b) {
  const minH=Math.min(...heights), maxH=Math.max(...heights), verticalScale=2.3;
  const vertices=[], colors=[], indices=[];
  const low=new THREE.Color("#71826b"), high=new THREE.Color("#c1c49c");
  for(let j=0;j<GRID;j++) for(let i=0;i<GRID;i++) {
    const x=i/(GRID-1)*SPAN-HALF, z=j/(GRID-1)*SPAN-HALF, y=gridGround(i,j,heights,minH,verticalScale);
    vertices.push(x,y,z);
    const color=low.clone().lerp(high,(heights[j*GRID+i]-minH)/Math.max(1,maxH-minH)); colors.push(color.r,color.g,color.b);
    if(i<GRID-1&&j<GRID-1){const a=j*GRID+i,c=a+GRID;indices.push(a,c,a+1,a+1,c,c+1);}
  }
  const geo=new THREE.BufferGeometry(); geo.setAttribute("position",new THREE.Float32BufferAttribute(vertices,3)); geo.setAttribute("color",new THREE.Float32BufferAttribute(colors,3)); geo.setIndex(indices); geo.computeVertexNormals();
  const mesh=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({vertexColors:true,roughness:.95,side:THREE.DoubleSide})); mesh.receiveShadow=true; root.add(mesh);
  const base=new THREE.Mesh(new THREE.BoxGeometry(SPAN,18,SPAN),new THREE.MeshStandardMaterial({color:0x283a38,roughness:1})); base.position.y=-17; base.receiveShadow=true; root.add(base);
  return {minH,maxH,verticalScale};
}
function buildBuildings(buildings,b,heights,minH,scale,blocked) {
  const group=new THREE.Group();
  for(const building of buildings) {
    const pts=building.points.map(([lon,lat])=>toLocal(lon,lat,b));
    if(pts.length<3) continue;
    const shape=new THREE.Shape(); shape.moveTo(pts[0].x, -pts[0].z); for(let i=1;i<pts.length;i++) shape.lineTo(pts[i].x,-pts[i].z); shape.closePath();
    const raw=Number(building.tags.height?.replace?.("m","")) || (Number(building.tags["building:levels"])*3) || 9;
    const geom=new THREE.ExtrudeGeometry(shape,{depth:Math.min(Math.max(raw,3),45)*scale,bevelEnabled:false});
    geom.rotateX(-Math.PI/2);
    const mid=pts.reduce((a,p)=>({x:a.x+p.x/pts.length,z:a.z+p.z/pts.length}),{x:0,z:0});
    const i=THREE.MathUtils.clamp(Math.round((mid.x+HALF)/SPAN*(GRID-1)),0,GRID-1), j=THREE.MathUtils.clamp(Math.round((mid.z+HALF)/SPAN*(GRID-1)),0,GRID-1);
    geom.translate(0,gridGround(i,j,heights,minH,scale),0);
    const mesh=new THREE.Mesh(geom,new THREE.MeshStandardMaterial({color:0xd3b582,roughness:.78})); mesh.castShadow=true; mesh.receiveShadow=true; group.add(mesh);
    // Mask all terrain cells whose centers fall inside this footprint.
    const minX=Math.min(...pts.map(p=>p.x)),maxX=Math.max(...pts.map(p=>p.x)),minZ=Math.min(...pts.map(p=>p.z)),maxZ=Math.max(...pts.map(p=>p.z));
    for(let j0=0;j0<GRID-1;j0++) for(let i0=0;i0<GRID-1;i0++) {
      const x=i0*SPAN/(GRID-1)-HALF+SPAN/(2*(GRID-1)),z=j0*SPAN/(GRID-1)-HALF+SPAN/(2*(GRID-1));
      if(x>=minX&&x<=maxX&&z>=minZ&&z<=maxZ&&inside(x,z,pts)) blocked[j0*(GRID-1)+i0]=1;
    }
  }
  root.add(group);
}
function inside(x,z,poly) { let yes=false; for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if(((a.z>z)!==(b.z>z))&&(x<(b.x-a.x)*(z-a.z)/(b.z-a.z)+a.x))yes=!yes;}return yes; }
function createWater(heights,minH,scale,blocked) {
  const n=GRID-1, verts=[],colors=[],indices=[],cells=[];
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const x=i*SPAN/n-HALF+SPAN/(2*n),z=j*SPAN/n-HALF+SPAN/(2*n);
    const gi=Math.min(i,GRID-1),gj=Math.min(j,GRID-1), y=gridGround(gi,gj,heights,minH,scale);
    const id=cells.length;cells.push({i,j,x,z,y,depth:0,blocked:!!blocked[j*n+i]});
    for(const [dx,dz] of [[-1,-1],[1,-1],[1,1],[-1,1]]) verts.push(x+dx*SPAN/n/2,y,z+dz*SPAN/n/2);
    const base=id*4;indices.push(base,base+1,base+2,base,base+2,base+3);
    for(let k=0;k<4;k++)colors.push(.05,.5,.65);
  }
  const geo=new THREE.BufferGeometry();geo.setAttribute("position",new THREE.Float32BufferAttribute(verts,3));geo.setAttribute("color",new THREE.Float32BufferAttribute(colors,3));geo.setIndex(indices);
  const mesh=new THREE.Mesh(geo,new THREE.MeshBasicMaterial({vertexColors:true,transparent:true,opacity:.66,side:THREE.DoubleSide,depthWrite:false}));root.add(mesh);
  return {cells,mesh,heights,minH,scale,n};
}
function updateWater(water,rain,dt) {
  const {cells,n,heights,minH,scale}=water, add=rain/3600000*dt*18;
  const delta=new Float32Array(cells.length);
  for(let idx=0;idx<cells.length;idx++){
    const c=cells[idx]; if(c.blocked)continue;
    const h=gridGround(c.i,c.j,heights,minH,scale)+c.depth*18;
    let best=-1,drop=0;
    for(const [di,dj] of [[0,-1],[1,0],[0,1],[-1,0]]){
      const ni=c.i+di,nj=c.j+dj;if(ni<0||nj<0||ni>=n||nj>=n)continue;
      const ni2=Math.min(ni,GRID-1),nj2=Math.min(nj,GRID-1),nh=gridGround(ni2,nj2,heights,minH,scale)+cells[nj*n+ni].depth*18;
      if(!cells[nj*n+ni].blocked&&h-nh>drop){drop=h-nh;best=nj*n+ni;}
    }
    c.depth=Math.min(.24,Math.max(0,c.depth+add));
    if(best>=0&&drop>.02){const moved=Math.min(c.depth*.16,drop*.008*dt);delta[idx]-=moved;delta[best]+=moved;}
  }
  for(let i=0;i<cells.length;i++) if(!cells[i].blocked) cells[i].depth=Math.max(0,Math.min(.24,cells[i].depth+delta[i]));
  const pos=water.mesh.geometry.attributes.position, col=water.mesh.geometry.attributes.color;
  cells.forEach((c,i)=>{
    const d=c.blocked?0:c.depth, y=c.y+(d>.001?.7+d*18:-8);
    for(let k=0;k<4;k++){pos.setY(i*4+k,y);col.setXYZ(i*4+k,.04+Math.min(d*1.3,.13),.36+Math.min(d*2.4,.47),.48+Math.min(d*2.1,.45));}
  });pos.needsUpdate=true;col.needsUpdate=true;water.mesh.geometry.computeVertexNormals();
}
function createRain(count) {
  const pos=new Float32Array(count*3), speeds=new Float32Array(count);
  for(let i=0;i<count;i++){pos[i*3]=(Math.random()-.5)*SPAN;pos[i*3+1]=280+Math.random()*500;pos[i*3+2]=(Math.random()-.5)*SPAN;speeds[i]=250+Math.random()*320;}
  const geo=new THREE.BufferGeometry();geo.setAttribute("position",new THREE.BufferAttribute(pos,3));
  const pts=new THREE.Points(geo,new THREE.PointsMaterial({color:0xabe8ee,size:5,sizeAttenuation:true,transparent:true,opacity:.8}));
  root.add(pts);return {pts,speeds,count};
}
function createFlow(water, rainCount) {
  const cells=water.cells, visibleCells=[];
  cells.forEach((cell,index)=>{if(!cell.blocked)visibleCells.push(index);});
  const count=visibleCells.length?Math.max(48,Math.floor(rainCount*.22)):0,particles=[];
  for(let i=0;i<count;i++) particles.push({current:visibleCells[0],next:visibleCells[0],progress:0,active:false,previousX:0,previousZ:0});
  const positions=new Float32Array(count*3),trails=new Float32Array(count*6);
  for(let i=0;i<count;i++){positions[i*3+1]=-1000;trails[i*6+1]=-1000;trails[i*6+4]=-1000;}
  const pointGeometry=new THREE.BufferGeometry();pointGeometry.setAttribute("position",new THREE.BufferAttribute(positions,3));
  const points=new THREE.Points(pointGeometry,new THREE.PointsMaterial({color:0x9beaf0,size:7,sizeAttenuation:true,transparent:true,opacity:.98}));
  points.visible=false;root.add(points);
  const trailGeometry=new THREE.BufferGeometry();trailGeometry.setAttribute("position",new THREE.BufferAttribute(trails,3));
  const lines=new THREE.LineSegments(trailGeometry,new THREE.LineBasicMaterial({color:0x56c7d9,transparent:true,opacity:.58}));
  lines.visible=false;root.add(lines);
  return {particles,points,lines,water,count,cursor:0};
}
function spawnFlow(flow,index) {
  if(!flow.count)return;
  const cell=flow.water.cells[index];if(!cell||cell.blocked)return;
  const slot=flow.cursor++%flow.count,particle=flow.particles[slot];
  particle.current=index;particle.next=index;particle.progress=0;particle.active=true;
  particle.previousX=cell.x;particle.previousZ=cell.z;
  const points=flow.points.geometry.attributes.position,trails=flow.lines.geometry.attributes.position,y=cell.y+.9;
  points.setXYZ(slot,cell.x,y,cell.z);trails.setXYZ(slot*2,cell.x,y,cell.z);trails.setXYZ(slot*2+1,cell.x,y,cell.z);
  points.needsUpdate=true;trails.needsUpdate=true;
}
function resetFlow(flow) {
  flow.particles.forEach(p=>{p.active=false;p.progress=0;p.next=p.current;});
  const points=flow.points.geometry.attributes.position,trails=flow.lines.geometry.attributes.position;
  for(let i=0;i<flow.count;i++){points.setXYZ(i,0,-1000,0);trails.setXYZ(i*2,0,-1000,0);trails.setXYZ(i*2+1,0,-1000,0);}
  points.needsUpdate=true;trails.needsUpdate=true;flow.cursor=0;
}
function disposeFlow(flow) {
  if(!flow)return;
  root.remove(flow.points,flow.lines);
  flow.points.geometry.dispose();flow.points.material.dispose();
  flow.lines.geometry.dispose();flow.lines.material.dispose();
}
function flowTarget(water,index) {
  const {cells,n,heights,minH,scale}=water,cell=cells[index];
  const currentHeight=gridGround(cell.i,cell.j,heights,minH,scale)+cell.depth*18;
  let best=index,lowest=currentHeight-.015;
  for(const [di,dj] of [[0,-1],[1,0],[0,1],[-1,0]]) {
    const i=cell.i+di,j=cell.j+dj;if(i<0||j<0||i>=n||j>=n)continue;
    const neighbor=cells[j*n+i];if(neighbor.blocked)continue;
    const h=gridGround(neighbor.i,neighbor.j,heights,minH,scale)+neighbor.depth*18;
    if(h<lowest){lowest=h;best=j*n+i;}
  }
  return best;
}
function updateFlow(flow,dt) {
  const {particles,water}=flow,cells=water.cells,step=SPAN/water.n;
  const points=flow.points.geometry.attributes.position,trails=flow.lines.geometry.attributes.position;
  particles.forEach((particle,index)=>{
    if(!particle.active)return;
    if(particle.next===particle.current)particle.next=flowTarget(water,particle.current);
    if(particle.next!==particle.current) {
      const from=cells[particle.current],to=cells[particle.next];
      const fromHeight=gridGround(from.i,from.j,water.heights,water.minH,water.scale)+from.depth*18;
      const toHeight=gridGround(to.i,to.j,water.heights,water.minH,water.scale)+to.depth*18;
      particle.progress+=(18+Math.min(22,Math.max(0,fromHeight-toHeight)*1.2))*dt/step;
      if(particle.progress>=1){particle.current=particle.next;particle.next=particle.current;particle.progress=0;}
    }
    const a=cells[particle.current],b=cells[particle.next],t=particle.progress;
    const x=THREE.MathUtils.lerp(a.x,b.x,t),z=THREE.MathUtils.lerp(a.z,b.z,t);
    const depth=THREE.MathUtils.lerp(a.depth,b.depth,t);
    const y=THREE.MathUtils.lerp(a.y,b.y,t)+(depth>.001?.8+depth*18:.75);
    points.setXYZ(index,x,y,z);trails.setXYZ(index*2,particle.previousX,y,particle.previousZ);trails.setXYZ(index*2+1,x,y,z);
    particle.previousX=x;particle.previousZ=z;
  });
  points.needsUpdate=true;trails.needsUpdate=true;
}
function renderFrame(now) {
  requestAnimationFrame(renderFrame);
  const dt=Math.min((now-lastFrame)/1000,.05);lastFrame=now;
  if(running&&sim){elapsed+=dt*10;updateWater(sim.water,+$("rain-slider").value,dt);updateFlow(sim.flow,dt);animateRain(sim,dt);}
  renderer.render(world,camera);
  if(running) {$("elapsed-value").innerHTML="<b>"+formatTime(elapsed)+"</b>";}
}
function animateRain(sim,dt) {
  const rain=sim.rain,water=sim.water,p=rain.pts.geometry.attributes.position;
  for(let i=0;i<rain.count;i++){
    const x=p.getX(i),z=p.getZ(i);
    const ci=THREE.MathUtils.clamp(Math.floor((x+HALF)/SPAN*water.n),0,water.n-1);
    const cj=THREE.MathUtils.clamp(Math.floor((z+HALF)/SPAN*water.n),0,water.n-1);
    const index=cj*water.n+ci,cell=water.cells[index];
    const contactY=cell.y+(cell.blocked?18*water.scale:0)+.35;
    let y=p.getY(i)-rain.speeds[i]*dt;
    if(y<=contactY){if(!cell.blocked)spawnFlow(sim.flow,index);y=230+Math.random()*500;p.setX(i,(Math.random()-.5)*SPAN);p.setZ(i,(Math.random()-.5)*SPAN);}
    p.setY(i,y);
  }
  p.needsUpdate=true;
}
function formatTime(seconds){const s=Math.floor(seconds);return String(Math.floor(s/60)).padStart(2,"0")+":"+String(s%60).padStart(2,"0");}
async function enterMesh() {
  if(!selection)return;
  running=false;elapsed=0;
  $("start-button").disabled=true;$("scene-loading").classList.remove("hidden");$("scene-error").classList.add("hidden");$("load-message").textContent="データの取得を開始…";mapStatus.textContent="読込中";
  try {
    const elevation=await loadElevations(selection.bounds); const heights=elevation.values; const buildings=await loadBuildings(selection.bounds);
    clearRoot();const blocked=new Uint8Array((GRID-1)*(GRID-1));
    const {minH,maxH,verticalScale}=buildTerrain(heights,selection.bounds);
    buildBuildings(buildings,selection.bounds,heights,minH,verticalScale,blocked);
    const water=createWater(heights,minH,verticalScale,blocked),rain=createRain(+$("particle-slider").value),flow=createFlow(water,+$("particle-slider").value);
    sim={heights,buildings,blocked,water,rain,flow};
    target.set(0,Math.max(35,(maxH-minH)*verticalScale*.25),0);distance=1700;updateCamera();
    $("empty-state").classList.add("hidden");$("scene-location").textContent=selection.lat.toFixed(4)+"°, "+selection.lon.toFixed(4)+"°";
    $("scene-state").textContent="READY";
    scene.querySelector(".scene-chip").classList.remove("active");
    $("play-button").disabled=false;$("load-message").textContent=buildings.length+"棟の建物を表示";$("terrain-source").textContent=elevation.source;
    mapStatus.textContent="読込完了";
  } catch(e) {
    $("scene-error").textContent=(e.message||"データを読み込めませんでした")+"。地図で別の場所を選ぶか、時間をおいて再試行してください。";
    $("scene-error").classList.remove("hidden");$("load-message").textContent="読み込みに失敗しました";mapStatus.textContent="失敗";
  } finally { $("start-button").disabled=false;$("scene-loading").classList.add("hidden"); }
}
$("start-button").addEventListener("click",enterMesh);
$("rain-slider").addEventListener("input",e=>$("rain-value").textContent=e.target.value);
$("particle-slider").addEventListener("input",e=>{
  $("particle-value").textContent=(+e.target.value).toLocaleString();
  if(sim){root.remove(sim.rain.pts);sim.rain.pts.geometry.dispose();sim.rain.pts.material.dispose();sim.rain=createRain(+e.target.value);disposeFlow(sim.flow);sim.flow=createFlow(sim.water,+e.target.value);if(running){sim.flow.points.visible=true;sim.flow.lines.visible=true;}}
});
$("play-button").addEventListener("click",()=>{
  if(!sim)return;running=!running;
  $("play-button").innerHTML=running?"<span>Ⅱ</span> 一時停止":"<span>▶</span> 再開";if(running&&sim.flow){sim.flow.points.visible=true;sim.flow.lines.visible=true;}
  $("flow-label").textContent=running?"流下中":"一時停止";
  $("scene-state").textContent=running?"RUNNING":"PAUSED";
  scene.querySelector(".scene-chip").classList.toggle("active",running);
});
$("restart-button").addEventListener("click",()=>{
  if(!sim)return;sim.water.cells.forEach(c=>c.depth=0);updateWater(sim.water,0,0);
  elapsed=0;running=false;sim.flow.points.visible=false;sim.flow.lines.visible=false;resetFlow(sim.flow);$("elapsed-value").innerHTML="<b>00:00</b>";
  $("play-button").innerHTML="<span>▶</span> シミュレーション開始";$("flow-label").textContent="停止中";$("scene-state").textContent="READY";scene.querySelector(".scene-chip").classList.remove("active");
});
resetCamera();requestAnimationFrame(renderFrame);










