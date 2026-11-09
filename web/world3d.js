// Lightweight world: a stylised F1 circuit in Three.js (no map tiles), same interface the game uses for world.js.
// Tracks are generated from a seed, so chat can vote between several circuits without downloading anything.
import * as THREE from 'three';

export const ROAD_W = 20;
export const LANES = [-6.4, -3.2, 0, 3.2, 6.4];
const SEG = 1600;

export const MAPS = [
	{id: 'bosphorus', city: 'MATH GP', name: 'BOĞAZ CIRCUIT', seed: 11, sky: '#2c6cff', grass: '#3f8f2c'},
	{id: 'anatolia', city: 'MATH GP', name: 'ANADOLU PARK', seed: 23, sky: '#4a7fe0', grass: '#7a9a3a'},
	{id: 'sunset', city: 'MATH GP', name: 'SUNSET RING', seed: 37, sky: '#ff7a45', grass: '#4d7a2a'},
	{id: 'desert', city: 'MATH GP', name: 'DESERT GP', seed: 41, sky: '#3f8fe0', grass: '#c9a86a'},
	{id: 'snow', city: 'MATH GP', name: 'KAR PİSTİ', seed: 53, sky: '#8fb6e8', grass: '#e9eef3'},
	{id: 'night', city: 'MATH GP', name: 'GECE YARIŞI', seed: 67, sky: '#0b1430', grass: '#1f3a1c', night: true},
	{id: 'coast', city: 'MATH GP', name: 'SAHİL YOLU', seed: 79, sky: '#3d9cff', grass: '#58a34a'},
];

export const world = {L: 1, frames: [], current: null, ready: false};
let renderer, trackGroup, LOW = true;

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function canvasTex(w, h, draw, ru = 1, rv = 1) {
	const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
	const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(ru, rv);
	t.colorSpace = THREE.SRGBColorSpace; return t;
}

// Scene objects exist from module load so the game can create cars before the renderer starts
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9cc6ff, 180, 620);
const camera = new THREE.PerspectiveCamera(62, 1080 / 1920, 0.5, 2000);
const sky = new THREE.Mesh(new THREE.SphereGeometry(1200, 24, 12), new THREE.MeshBasicMaterial({side: THREE.BackSide, fog: false}));
scene.add(sky);
const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x2f5a22, 0.9); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, {left: -60, right: 60, top: 60, bottom: -60, near: 10, far: 400});
scene.add(sun, sun.target);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshStandardMaterial({roughness: 1}));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; ground.receiveShadow = true; scene.add(ground);

export async function initWorld(canvasId, low) {
	LOW = low;
	renderer = new THREE.WebGLRenderer({canvas: document.getElementById(canvasId), antialias: !low, powerPreference: 'high-performance'});
	renderer.setPixelRatio(low ? 0.75 : 1);
	renderer.setSize(1080, 1920, false);
	renderer.shadowMap.enabled = !low;
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	sun.castShadow = !low;
	world.ready = true;
}

export function at(d) {
	const {frames, L} = world;
	const u = (((d / L) % 1) + 1) % 1;
	const f = u * SEG, i = Math.min(SEG - 1, Math.floor(f)), k = f - i, a = frames[i], b = frames[i + 1];
	return {p: a.p.clone().lerp(b.p, k), t: a.t.clone().lerp(b.t, k).normalize(), n: a.n.clone().lerp(b.n, k).normalize()};
}
export const bearingOf = (t) => (Math.atan2(t.x, -t.z) * 180) / Math.PI;

function ribbon(group, o1, o2, y, mat, vScale) {
	const pos = [], uv = [], idx = [];
	for (let i = 0; i <= SEG; i++) {
		const {p, n} = world.frames[i];
		pos.push(p.x + n.x * o1, y, p.z + n.z * o1, p.x + n.x * o2, y, p.z + n.z * o2);
		const v = ((i / SEG) * world.L) / vScale; uv.push(0, v, 1, v);
		if (i < SEG) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
	g.setIndex(idx); g.computeVertexNormals();
	mat.side = THREE.DoubleSide;
	const m = new THREE.Mesh(g, mat); m.receiveShadow = true; group.add(m);
}

/** A closed circuit from a seed: a wobbly loop with a couple of hairpins, about 1.3-1.8 km. */
function circuit(seed) {
	const r = rng(seed), n = 14, pts = [];
	for (let i = 0; i < n; i++) {
		const a = (i / n) * Math.PI * 2;
		const rad = 190 + r() * 120 * (i % 3 === 0 ? 1.4 : 1);
		pts.push(new THREE.Vector3(Math.cos(a) * rad * 1.15, 0, Math.sin(a) * rad * 0.85));
	}
	return pts;
}

export async function loadMap(m) {
	m = m || MAPS[0];
	if (trackGroup) { scene.remove(trackGroup); trackGroup.traverse((o) => o.geometry?.dispose()); }
	const curve = new THREE.CatmullRomCurve3(circuit(m.seed), true, 'centripetal');
	world.L = curve.getLength();
	world.frames = [];
	for (let i = 0; i <= SEG; i++) {
		const u = (i / SEG) % 1, p = curve.getPointAt(u), t = curve.getTangentAt(u);
		world.frames.push({p, t, n: new THREE.Vector3(-t.z, 0, t.x).normalize()});
	}
	// sky, grass and light for this track's mood
	const skyTex = canvasTex(4, 256, (x) => { const g = x.createLinearGradient(0, 0, 0, 256); g.addColorStop(0, m.sky); g.addColorStop(0.5, m.night ? '#1b2650' : '#bcd6ff'); g.addColorStop(1, m.night ? '#1b2650' : '#d6e7ff'); x.fillStyle = g; x.fillRect(0, 0, 4, 256); });
	sky.material.map = skyTex; sky.material.needsUpdate = true;
	scene.fog.color.set(m.night ? 0x0f1a3a : 0xb8d3f2);
	ground.material.color.set(m.grass);
	hemi.intensity = m.night ? 0.35 : 0.9;
	sun.intensity = m.night ? 0.6 : 2.2;

	const g = new THREE.Group();
	const asphalt = canvasTex(256, 256, (x, w, h) => {
		x.fillStyle = '#34363d'; x.fillRect(0, 0, w, h);
		for (let i = 0; i < 4000; i++) { const v = 40 + Math.random() * 40; x.fillStyle = `rgba(${v},${v},${v + 6},0.5)`; x.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5); }
		x.fillStyle = 'rgba(255,255,255,0.55)'; for (const lx of [0.2, 0.4, 0.6, 0.8]) x.fillRect(lx * w - 2, 0, 4, h * 0.45);
	});
	const kerb = canvasTex(64, 64, (x, w, h) => { x.fillStyle = '#e10600'; x.fillRect(0, 0, w, h / 2); x.fillStyle = '#fff'; x.fillRect(0, h / 2, w, h / 2); });
	ribbon(g, -ROAD_W / 2 - 7, ROAD_W / 2 + 7, 0.0, new THREE.MeshStandardMaterial({color: m.id === 'snow' ? 0xc9d3dc : 0x9b8d74, roughness: 1}), 10);
	ribbon(g, -ROAD_W / 2, ROAD_W / 2, 0.02, new THREE.MeshStandardMaterial({map: asphalt, roughness: 0.92}), 8);
	for (const s of [-1, 1]) {
		ribbon(g, s * ROAD_W / 2, s * (ROAD_W / 2 + 1.6), 0.04, new THREE.MeshStandardMaterial({map: kerb, roughness: 0.7}), 3);
		ribbon(g, s * (ROAD_W / 2 - 0.25), s * (ROAD_W / 2 - 0.05), 0.05, new THREE.MeshBasicMaterial({color: 0xffffff}), 4);
	}
	const {p, t} = at(0);
	const chk = canvasTex(128, 32, (x) => { for (let i = 0; i < 16; i++) for (let j = 0; j < 4; j++) { x.fillStyle = (i + j) % 2 ? '#111' : '#fff'; x.fillRect(i * 8, j * 8, 8, 8); } });
	const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W, 2), new THREE.MeshStandardMaterial({map: chk}));
	line.position.copy(p).setY(0.06); line.rotation.x = -Math.PI / 2; line.rotation.z = Math.atan2(t.x, t.z); g.add(line);
	const steel = new THREE.MeshStandardMaterial({color: 0x1b1b22, metalness: 0.6, roughness: 0.4});
	const gantry = new THREE.Group();
	for (const s of [-1, 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(1, 11, 1), steel); post.position.set(s * (ROAD_W / 2 + 2), 5.5, 0); gantry.add(post); }
	const beam = new THREE.Mesh(new THREE.BoxGeometry(ROAD_W + 6, 2.2, 1.2), steel); beam.position.y = 11; gantry.add(beam);
	const banner = canvasTex(512, 48, (x, w) => { x.fillStyle = '#e10600'; x.fillRect(0, 0, w, 48); x.fillStyle = '#fff'; x.font = 'italic 900 34px sans-serif'; x.textAlign = 'center'; x.fillText(`MATH GP · ${m.name}`, w / 2, 36); });
	for (const z of [-0.65, 0.65]) { const b = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_W + 4, 2), new THREE.MeshBasicMaterial({map: banner})); b.position.set(0, 11, z); if (z < 0) b.rotation.y = Math.PI; gantry.add(b); }
	gantry.position.copy(p); gantry.lookAt(p.clone().add(t)); g.add(gantry);
	// grandstands at the start and on a few corners
	const crowd = canvasTex(256, 128, (x, w, h) => {
		x.fillStyle = '#2b2f45'; x.fillRect(0, 0, w, h);
		const cols = ['#e10600', '#ffc800', '#1e6bff', '#ffffff', '#00d26a', '#ff7a00', '#f2c9a0'];
		for (let i = 0; i < 2200; i++) { x.fillStyle = cols[Math.floor(Math.random() * cols.length)]; x.fillRect(Math.random() * w, Math.random() * h, 3, 3); }
	}, 4, 1);
	const grey = new THREE.MeshStandardMaterial({color: 0x3a3f55}), crowdMat = new THREE.MeshStandardMaterial({map: crowd});
	for (const [u, side, len] of [[0, 1, 70], [0, -1, 70], [0.3, 1, 50], [0.55, -1, 60], [0.8, 1, 50]]) {
		const f = at(u * world.L);
		const st = new THREE.Group();
		const box = new THREE.Mesh(new THREE.BoxGeometry(len, 9, 10), [grey, grey, grey, grey, crowdMat, grey]);
		box.position.y = 4.5; box.rotation.x = -0.35; st.add(box);
		const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 2, 0.6, 12), new THREE.MeshStandardMaterial({color: 0xeeeeee})); roof.position.set(0, 11, -1); st.add(roof);
		st.position.copy(f.p).addScaledVector(f.n, side * (ROAD_W / 2 + 22)); st.lookAt(f.p.x, 0, f.p.z);
		g.add(st);
	}
	// ad boards and trees (instanced: cheap to draw)
	const ad = canvasTex(512, 64, (x, w, h) => {
		[['#e10600', 'MATH GP'], ['#111', 'ZEYN MEDYA'], ['#1e6bff', 'YORUM YAZ'], ['#ffc800', 'HIZ = PUAN']].forEach(([c, s], i) => { x.fillStyle = c; x.fillRect((i * w) / 4, 0, w / 4, h); x.fillStyle = c === '#ffc800' ? '#111' : '#fff'; x.font = 'italic 900 26px sans-serif'; x.textAlign = 'center'; x.fillText(s, ((i + 0.5) * w) / 4, 42); });
	}, 6, 1);
	const black = new THREE.MeshStandardMaterial({color: 0x222222}), adMat = new THREE.MeshBasicMaterial({map: ad});
	for (let d = 0; d < world.L; d += LOW ? 40 : 20) {
		const f = at(d), s = (Math.floor(d / 20) % 2) * 2 - 1;
		const b = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.2, 12), [black, black, black, black, adMat, adMat]);
		b.position.copy(f.p).addScaledVector(f.n, s * (ROAD_W / 2 + 8)).setY(0.6); b.lookAt(b.position.clone().add(f.t)); b.rotateY(Math.PI / 2); g.add(b);
	}
	const r = rng(m.seed + 1), treeN = LOW ? 120 : 260;
	const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.4, 0.6, 3, 6), new THREE.MeshStandardMaterial({color: 0x5b3a1e}), treeN);
	const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(3, 7, 7), new THREE.MeshStandardMaterial({color: m.id === 'snow' ? 0xdfe9ef : m.id === 'desert' ? 0x6f8f3a : 0x2f7d32, roughness: 1}), treeN);
	const M = new THREE.Matrix4(), v = new THREE.Vector3();
	let placed = 0;
	for (let i = 0; i < treeN * 4 && placed < treeN; i++) {
		v.set((r() - 0.5) * 1100, 0, (r() - 0.5) * 900);
		let near = false;
		for (let j = 0; j < SEG; j += 25) if (world.frames[j].p.distanceTo(v) < ROAD_W + 35) { near = true; break; }
		if (near) continue;
		const s = 0.8 + r() * 0.9;
		M.makeScale(s, s, s).setPosition(v.x, 1.5 * s, v.z); trunks.setMatrixAt(placed, M);
		M.makeScale(s, s, s).setPosition(v.x, 6 * s, v.z); crowns.setMatrixAt(placed, M);
		placed++;
	}
	trunks.count = crowns.count = placed;
	g.add(trunks, crowns);
	g.traverse((o) => { if (o.isMesh) o.castShadow = !LOW; });
	trackGroup = g; scene.add(g);
	world.current = m;
	console.log(`[map] ${m.name}: ${Math.round(world.L)} m`);
}

// ---------- cars ----------
export function makeCar(team) {
	const car = new THREE.Group();
	const paint = new THREE.MeshStandardMaterial({color: team.color, metalness: 0.45, roughness: 0.3});
	const dark = new THREE.MeshStandardMaterial({color: 0x15161c, metalness: 0.3, roughness: 0.5});
	const white = new THREE.MeshStandardMaterial({color: 0xf2f2f2, metalness: 0.2, roughness: 0.4});
	const add = (geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; m.castShadow = !LOW; car.add(m); return m; };
	add(new THREE.BoxGeometry(0.9, 0.45, 3.2), paint, 0, 0.55, 0.1);
	add(new THREE.CylinderGeometry(0.12, 0.42, 2.0, 8), paint, 0, 0.5, 2.6, Math.PI / 2);
	add(new THREE.BoxGeometry(2.3, 0.07, 0.55), dark, 0, 0.22, 3.45);
	add(new THREE.BoxGeometry(2.3, 0.18, 0.06), paint, 0, 0.3, 3.7);
	for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.06, 0.4, 0.7), dark, s * 1.15, 0.35, 3.45);
	for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.55, 0.42, 1.8), paint, s * 0.68, 0.5, -0.2);
	add(new THREE.BoxGeometry(0.5, 0.55, 1.6), paint, 0, 0.85, -0.9, -0.15);
	add(new THREE.BoxGeometry(0.06, 0.55, 1.4), white, 0, 1.1, -1.0);
	add(new THREE.BoxGeometry(1.7, 0.08, 0.5), dark, 0, 1.25, -1.95);
	add(new THREE.BoxGeometry(1.7, 0.22, 0.06), paint, 0, 1.36, -2.15);
	for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.06, 0.8, 0.6), dark, s * 0.86, 0.9, -1.95);
	add(new THREE.SphereGeometry(0.26, 12, 8), white, 0, 0.98, 0.35);
	add(new THREE.SphereGeometry(0.27, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2.6), paint, 0, 0.99, 0.35);
	const halo = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.045, 6, 14, Math.PI), dark);
	halo.position.set(0, 0.95, 0.55); halo.rotation.set(-Math.PI / 2, 0, Math.PI); car.add(halo);
	car.userData.wheels = [];
	const tyre = new THREE.CylinderGeometry(0.42, 0.42, 0.42, 12), rim = new THREE.CylinderGeometry(0.24, 0.24, 0.44, 8);
	const tyreMat = new THREE.MeshStandardMaterial({color: 0x101010, roughness: 0.85}), rimMat = new THREE.MeshStandardMaterial({color: team.color, metalness: 0.7, roughness: 0.3});
	for (const [x, z, sc] of [[-0.98, 1.95, 0.92], [0.98, 1.95, 0.92], [-0.98, -1.55, 1.05], [0.98, -1.55, 1.05]]) {
		const spin = new THREE.Group();
		const t = new THREE.Mesh(tyre, tyreMat); t.rotation.z = Math.PI / 2;
		const r = new THREE.Mesh(rim, rimMat); r.rotation.z = Math.PI / 2;
		spin.add(t, r);
		const w = new THREE.Group(); w.add(spin); w.position.set(x, 0.42 * sc, z); w.scale.setScalar(sc); car.add(w); car.userData.wheels.push(spin);
	}
	const flame = new THREE.Mesh(new THREE.ConeGeometry(0.18, 1.3, 10, 1, true), new THREE.MeshBasicMaterial({color: 0xffa21f, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false}));
	flame.rotation.x = -Math.PI / 2; flame.position.set(0, 0.5, -3.1); car.add(flame); car.userData.flame = flame;
	scene.add(car);
	return car;
}
export function tagSprite() {
	const c = document.createElement('canvas'); c.width = 512; c.height = 96;
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
	const s = new THREE.Sprite(new THREE.SpriteMaterial({map: t, transparent: true, depthTest: false}));
	s.scale.set(4.2, 0.8, 1); s.visible = false; scene.add(s);
	s.userData.draw = (text, color) => {
		const x = c.getContext('2d'); x.clearRect(0, 0, 512, 96);
		x.font = '900 52px sans-serif'; const w = Math.min(500, x.measureText(text).width + 40);
		x.fillStyle = color; x.beginPath(); x.roundRect(256 - w / 2, 10, w, 76, 38); x.fill();
		x.fillStyle = '#111'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 256, 50); t.needsUpdate = true;
	};
	return s;
}

// ---------- camera: same call shape as the map version (centre, bearing, pitch, zoom) ----------
export function placeCamera(pos, bearing, pitch, zoom) {
	const d = 11 * Math.pow(2, 19.8 - zoom);
	const b = (bearing * Math.PI) / 180, p = (pitch * Math.PI) / 180;
	const fwd = new THREE.Vector3(Math.sin(b), 0, -Math.cos(b));
	camera.position.copy(pos).addScaledVector(fwd, -d * Math.sin(p)).setY(Math.max(1.6, d * Math.cos(p)));
	camera.lookAt(pos.x, 1, pos.z);
	sun.position.copy(pos).add(new THREE.Vector3(60, 140, 40)); sun.target.position.copy(pos);
}
export function repaint() { renderer.render(scene, camera); }
