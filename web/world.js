// The city and everything in it: MapLibre GL draws the real city (OpenFreeMap vector tiles, 3D buildings at their
// mapped heights, streamed for whatever the camera looks at), the race line is a GeoJSON layer on real streets
// routed by OSRM, and the F1 cars are Three.js meshes in a MapLibre custom layer. Local coordinates are metres
// around the track origin: x east, y up, z south.
import * as THREE from 'three';

const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const ROUTERS = ['https://router.project-osrm.org/route/v1/driving/', 'https://routing.openstreetmap.de/routed-car/route/v1/driving/'];
export const ROAD_W = 13;
export const LANES = [-4.8, -2.4, 0, 2.4, 4.8];
const SEG = 2000;

export const MAPS = [
	{id: 'taksim', city: 'İSTANBUL', name: 'TAKSİM', lat: 41.0369, lon: 28.9851, r: 420},
	{id: 'sultanahmet', city: 'İSTANBUL', name: 'SULTANAHMET', lat: 41.0058, lon: 28.9768, r: 380},
	{id: 'levent', city: 'İSTANBUL', name: 'LEVENT', lat: 41.0786, lon: 29.0110, r: 480},
	{id: 'kadikoy', city: 'İSTANBUL', name: 'KADIKÖY', lat: 40.9905, lon: 29.0290, r: 380},
	{id: 'kizilay', city: 'ANKARA', name: 'KIZILAY', lat: 39.9208, lon: 32.8541, r: 420},
	{id: 'anitkabir', city: 'ANKARA', name: 'ANITKABİR', lat: 39.9250, lon: 32.8369, r: 520},
	{id: 'alsancak', city: 'İZMİR', name: 'ALSANCAK', lat: 38.4370, lon: 27.1440, r: 400},
];

let map, origin, kx, kz, lat0, lon0;
const three = {scene: new THREE.Scene(), camera: new THREE.Camera(), renderer: null};
export const world = {L: 1, frames: [], current: null, ready: false};

// ---------- projection between lng/lat and local metres ----------
function setOrigin(lat, lon) {
	lat0 = lat; lon0 = lon;
	kx = Math.cos((lat * Math.PI) / 180) * 111320; kz = 110540;
	origin = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
}
const toLocal = (lng, lat) => new THREE.Vector3((lng - lon0) * kx, 0, -(lat - lat0) * kz);
const toLngLat = (v) => [lon0 + v.x / kx, lat0 - v.z / kz];

// ---------- route: a closed loop on real streets around the landmark ----------
async function fetchJson(urls, timeoutMs = 20000) {
	let last;
	for (const url of urls) {
		try {
			const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
			const r = await fetch(url, {signal: ctl.signal}); clearTimeout(t);
			if (r.ok) return await r.json();
			last = new Error(`${r.status} ${url}`);
		} catch (e) { last = e; }
	}
	throw last;
}
function collapseLoops(pts) {
	const out = [];
	for (let i = 0; i < pts.length; i++) {
		out.push(pts[i]);
		let arc = 0;
		for (let j = i + 1; j < Math.min(pts.length, i + 120); j++) {
			arc += pts[j].distanceTo(pts[j - 1]);
			if (arc > 50 && pts[j].distanceTo(pts[i]) < 12) { i = j; break; }
		}
	}
	return out;
}
function resample(pts, step) {
	const out = [pts[0].clone()];
	let carry = 0;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1], b = pts[i], d = a.distanceTo(b);
		let s = step - carry;
		while (s <= d) { out.push(a.clone().lerp(b, s / d)); s += step; }
		carry = d - (s - step);
	}
	return out;
}
function smooth(pts, passes, win) {
	let cur = pts;
	for (let p = 0; p < passes; p++) cur = cur.map((_, i) => {
		const acc = new THREE.Vector3();
		for (let k = -win; k <= win; k++) acc.add(cur[(i + k + cur.length) % cur.length]);
		return acc.divideScalar(win * 2 + 1);
	});
	return cur;
}
async function routeLoop(m) {
	const pts4 = [45, 135, 225, 315, 45].map((deg) => {
		const a = (deg * Math.PI) / 180;
		return [m.lon + (m.r * Math.cos(a)) / kx, m.lat + (m.r * Math.sin(a)) / kz];
	});
	const coords = pts4.map(([lo, la]) => `${lo.toFixed(6)},${la.toFixed(6)}`).join(';');
	try {
		const res = await fetchJson(ROUTERS.map((u) => `${u}${coords}?overview=full&geometries=geojson&continue_straight=true`));
		const line = res.routes?.[0]?.geometry?.coordinates;
		if (!line || line.length < 10) throw new Error('no route');
		let pts = resample(line.map(([lo, la]) => toLocal(lo, la)), 4);
		pts = collapseLoops(pts);
		return resample(smooth(resample(pts, 6), 4, 2), 16);
	} catch (e) {
		console.warn('[route] router unreachable, using a ring road', e);
		return Array.from({length: 48}, (_, i) => { const a = (i / 48) * Math.PI * 2; return new THREE.Vector3(Math.cos(a) * m.r * 0.8, 0, Math.sin(a) * m.r * 0.8); });
	}
}

// ---------- track geometry -> GeoJSON layers under the 3D buildings ----------
export function at(d) {
	const {frames, L} = world;
	const u = (((d / L) % 1) + 1) % 1;
	const f = u * SEG, i = Math.min(SEG - 1, Math.floor(f)), k = f - i, a = frames[i], b = frames[i + 1];
	return {p: a.p.clone().lerp(b.p, k), t: a.t.clone().lerp(b.t, k).normalize(), n: a.n.clone().lerp(b.n, k).normalize()};
}
function strip(o1, o2, step, props) {
	const feats = [];
	for (let d = 0; d < world.L; d += step) {
		const a = at(d), b = at(Math.min(d + step, world.L));
		const ring = [a.p.clone().addScaledVector(a.n, o1), a.p.clone().addScaledVector(a.n, o2), b.p.clone().addScaledVector(b.n, o2), b.p.clone().addScaledVector(b.n, o1)].map(toLngLat);
		ring.push(ring[0]);
		feats.push({type: 'Feature', properties: props(Math.round(d / step)), geometry: {type: 'Polygon', coordinates: [ring]}});
	}
	return feats;
}
function buildTrack(points) {
	const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
	world.L = curve.getLength();
	world.frames = [];
	for (let i = 0; i <= SEG; i++) {
		const u = (i / SEG) % 1, p = curve.getPointAt(u), t = curve.getTangentAt(u);
		world.frames.push({p, t, n: new THREE.Vector3(-t.z, 0, t.x).normalize()});
	}
	const W = ROAD_W / 2;
	const road = strip(-W, W, 6, () => ({c: '#2f3137'}));
	const kerbs = [...strip(W, W + 1.4, 3, (i) => ({c: i % 2 ? '#ffffff' : '#e10600'})), ...strip(-W - 1.4, -W, 3, (i) => ({c: i % 2 ? '#ffffff' : '#e10600'}))];
	const lines = [-2.4 * 1.5, -1.2, 1.2, 2.4 * 1.5].flatMap((o) => strip(o - 0.12, o + 0.12, 12, () => ({c: 'rgba(255,255,255,0.55)'}))).filter((_, i) => i % 2 === 0);
	const start = at(0);
	const chk = [];
	for (let i = 0; i < 10; i++) for (let j = 0; j < 2; j++) {
		const o = -W + (i * ROAD_W) / 10, d = j * 1.3;
		const c = [[o, d], [o + ROAD_W / 10, d], [o + ROAD_W / 10, d + 1.3], [o, d + 1.3]].map(([oo, dd]) => toLngLat(start.p.clone().addScaledVector(start.n, oo).addScaledVector(start.t, dd)));
		c.push(c[0]);
		chk.push({type: 'Feature', properties: {c: (i + j) % 2 ? '#111111' : '#ffffff'}, geometry: {type: 'Polygon', coordinates: [c]}});
	}
	map.getSource('track').setData({type: 'FeatureCollection', features: [...road, ...kerbs, ...lines, ...chk]});
}

// ---------- cars ----------
export function makeCar(team) {
	const car = new THREE.Group();
	const paint = new THREE.MeshStandardMaterial({color: team.color, metalness: 0.45, roughness: 0.3});
	const dark = new THREE.MeshStandardMaterial({color: 0x15161c, metalness: 0.3, roughness: 0.5});
	const white = new THREE.MeshStandardMaterial({color: 0xf2f2f2, metalness: 0.2, roughness: 0.4});
	const add = (geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; car.add(m); return m; };
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
	add(new THREE.SphereGeometry(0.26, 14, 10), white, 0, 0.98, 0.35);
	add(new THREE.SphereGeometry(0.27, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2.6), paint, 0, 0.99, 0.35);
	const halo = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.045, 8, 16, Math.PI), dark);
	halo.position.set(0, 0.95, 0.55); halo.rotation.set(-Math.PI / 2, 0, Math.PI); car.add(halo);
	car.userData.wheels = [];
	const tyre = new THREE.CylinderGeometry(0.42, 0.42, 0.42, 14), rim = new THREE.CylinderGeometry(0.24, 0.24, 0.44, 10);
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
	three.scene.add(car);
	return car;
}
export function tagSprite() {
	const c = document.createElement('canvas'); c.width = 512; c.height = 96;
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
	const s = new THREE.Sprite(new THREE.SpriteMaterial({map: t, transparent: true, depthTest: false}));
	s.scale.set(4.2, 0.8, 1); s.visible = false; three.scene.add(s);
	s.userData.draw = (text, color) => {
		const x = c.getContext('2d'); x.clearRect(0, 0, 512, 96);
		x.font = '900 52px sans-serif'; const w = Math.min(500, x.measureText(text).width + 40);
		x.fillStyle = color; x.beginPath(); x.roundRect(256 - w / 2, 10, w, 76, 38); x.fill();
		x.fillStyle = '#111'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 256, 50); t.needsUpdate = true;
	};
	return s;
}

// ---------- map + custom three layer ----------
export async function initWorld(container, low) {
	map = new maplibregl.Map({
		container, style: STYLE, center: [28.98, 41.03], zoom: 15, pitch: 60, maxPitch: 85, interactive: false, attributionControl: {compact: true},
		pixelRatio: low ? 0.6 : 1, fadeDuration: 0, antialias: !low,
	});
	await new Promise((r) => map.once('load', r));
	// warmer daylight and brighter buildings than the stock style
	const layers = map.getStyle().layers;
	for (const l of layers) if (l.type === 'fill-extrusion') { map.setPaintProperty(l.id, 'fill-extrusion-color', ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 10], 0, '#e7dccb', 40, '#d6c9b5', 120, '#9fb7cc']); map.setPaintProperty(l.id, 'fill-extrusion-opacity', 0.95); }
	const firstExtrusion = layers.find((l) => l.type === 'fill-extrusion')?.id;
	map.addSource('track', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
	map.addLayer({id: 'track', type: 'fill', source: 'track', paint: {'fill-color': ['get', 'c'], 'fill-antialias': false}}, firstExtrusion);
	map.addLayer({
		id: 'cars', type: 'custom', renderingMode: '3d',
		onAdd(m, gl) {
			three.renderer = new THREE.WebGLRenderer({canvas: m.getCanvas(), context: gl, antialias: !low});
			three.renderer.autoClear = false;
			three.scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
			const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(50, 120, 40); three.scene.add(sun);
		},
		render(gl, args) {
			const s = origin.meterInMercatorCoordinateUnits();
			const mt = new THREE.Matrix4().makeTranslation(origin.x, origin.y, origin.z).scale(new THREE.Vector3(s, -s, s)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
			const proj = args?.defaultProjectionData?.mainMatrix || args;
			three.camera.projectionMatrix = new THREE.Matrix4().fromArray(proj).multiply(mt);
			three.renderer.resetState();
			three.renderer.render(three.scene, three.camera);
		},
	});
	world.ready = true;
}

export async function loadMap(m) {
	setOrigin(m.lat, m.lon);
	const pts = await routeLoop(m);
	buildTrack(pts);
	world.current = m;
	map.jumpTo({center: [m.lon, m.lat], zoom: 15.6, pitch: 60, bearing: Math.random() * 360});
	await Promise.race([new Promise((r) => map.once('idle', r)), new Promise((r) => setTimeout(r, 9000))]);
	console.log(`[map] ${m.name}: ${Math.round(world.L)} m loop`);
}

// ---------- camera director (drives the MapLibre camera) ----------
const bearingOf = (t) => (Math.atan2(t.x, -t.z) * 180) / Math.PI;
export function placeCamera(pos, bearing, pitch, zoom) {
	map.jumpTo({center: toLngLat(pos), bearing, pitch, zoom});
}
export function repaint() { map?.triggerRepaint(); }
export function mapCenterLocal() { return new THREE.Vector3(0, 0, 0); }
export {bearingOf, toLngLat};
