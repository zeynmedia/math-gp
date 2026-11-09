import * as THREE from 'three';
import {MAPS, LANES, at, bearingOf, initWorld, loadMap as loadWorldMap, makeCar, placeCamera, repaint, tagSprite, world} from './world.js';

// ---------- config (URL params) ----------
const params = new URLSearchParams(location.search);
const LOW = params.get('quality') === 'low';           // no GPU (CI runners): smaller render, no shadows
const LAPS = Number(params.get('laps') || 4);
const BASE_LAP_S = 72;                                   // a lap with nobody answering; the race never stands still
const Q_TIME = Number(params.get('qtime') || 14);        // answer window as the viewer sees it
const LATENCY = Number(params.get('latency') ?? 4) * 1000; // stream delay: viewers see each question this much later
const GRACE = 2500;                                      // chat delivery slack after the viewer's buzzer
const FIRST_BONUS = 300;
const LAP_PER_1000 = 0.045;                              // 1000 points = 4.5% of a lap
const ACTIVE_S = 180;
const VOTE_S = Number(params.get('vote') || 22);
const BOT_TARGET = Number(params.get('bots') ?? 8);
const TEAMS = [
	{id: 'stars', name: 'STARS', short: 'STR', color: 0xffc800, css: '#ffc800', num: 1},
	{id: 'zore', name: 'ZORE', short: 'ZOR', color: 0xe10600, css: '#ff2a1f', num: 2},
	{id: 'thunder', name: 'THUNDER', short: 'THU', color: 0x1e6bff, css: '#3d8bff', num: 3},
	{id: 'venom', name: 'VENOM', short: 'VEN', color: 0x00d26a, css: '#22e07e', num: 4},
	{id: 'blaze', name: 'BLAZE', short: 'BLZ', color: 0xff7a00, css: '#ff8a1f', num: 5},
];
const T = {
	easy: 'KOLAY', hard: 'ZOR ×2', join: 'Yorum yaz, takıma katıl', hint: 'Yorum yaz, takıma katıl · <span>hızlı cevap = çok puan 🔥</span>',
	first: 'İLK!', correct: (n) => `${n} DOĞRU`, nobody: 'KİMSE BİLEMEDİ 😱', waiting: 'CEVAPLAR TOPLANIYOR…', joined: 'katıldı',
	vote: 'SIRADAKİ PİST?', voteHint: 'Yoruma A, B ya da C yaz 👇', loading: 'PİST YÜKLENİYOR', winner: 'YARIŞIN KAZANANI', race: 'BU YARIŞ', alltime: 'TÜM ZAMANLAR',
	next: 'Sıradaki pist oylaması başlıyor', final: 'SON', lap: 'TUR', fastest: 'en hızlı cevap', leader: 'LİDER',
};

// ---------- state ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const state = {
	phase: 'boot', race: 0,
	cars: TEAMS.map((team, i) => ({team, lane: LANES[i], dist: 0, v: 0, burst: 0, burstLeft: 0, points: 0, mesh: makeCar(team), tag: tagSprite(), lastAt: -1e9, lastName: '', lastPts: 0})),
	members: new Map(), qs: [], vote: null,
};

// ---------- persistent all-time board + anti-cheat (saved by the streamer between runs) ----------
const board = {users: {}, bans: {}};
const SUSPECT_MS = 650;      // a correct sum typed this soon after the viewer could see it is not human
const BAN_FLAGS = 5;
function boardUser(u) { return (board.users[u] ||= {points: 0, races: 0, wins: 0, correct: 0, flags: 0, fast: [], best: null}); }
window.loadBoard = (b) => { Object.assign(board.users, b?.users || {}); Object.assign(board.bans, b?.bans || {}); };
window.exportBoard = () => JSON.parse(JSON.stringify(board));
const banned = (u) => !!board.bans[u];
function flag(user, why) {
	const b = boardUser(user);
	b.flags++;
	console.log(`[cheat] ${user}: ${why} (flags ${b.flags})`);
	if (b.flags >= BAN_FLAGS && !board.bans[user]) board.bans[user] = {at: new Date().toISOString(), why};
}

function teamSizes(now) {
	const sizes = Object.fromEntries(TEAMS.map((t) => [t.id, 0]));
	for (const m of state.members.values()) if (now - m.lastSeen < ACTIVE_S * 1000) sizes[m.team.id]++;
	return sizes;
}
/** New commenters join the team with the fewest active members, so teams stay even however many people come. */
function assign(user, now, bot) {
	const sizes = teamSizes(now), min = Math.min(...Object.values(sizes));
	const pool = TEAMS.filter((t) => sizes[t.id] === min), team = pool[Math.floor(Math.random() * pool.length)];
	const m = {team, lastSeen: now, points: 0, streak: 0, best: Infinity, correct: 0, bot};
	state.members.set(user, m);
	feed(`<em style="color:${team.css}">${esc(user)}</em> ${team.name} ${T.joined} 🏎️`);
	return m;
}

// ---------- questions: one easy, one hard (x2) at the same time ----------
function rand(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function newQuestions() {
	const lvl = Math.min(2, Math.floor((leadDist() / world.L) / Math.max(1, LAPS / 3)));
	const e1 = rand(1, 9), e2 = rand(1, 9);
	let h1, h2;
	do { h1 = rand(12 + lvl * 8, 49 + lvl * 20); h2 = rand(12 + lvl * 8, 49 + lvl * 20); } while (h1 + h2 < 30);
	const shownAt = Date.now();
	state.qs = [
		{kind: 'easy', a: e1, b: e2, answer: e1 + e2, mult: 1},
		{kind: 'hard', a: h1, b: h2, answer: h1 + h2, mult: 2},
	].map((q) => ({...q, shownAt, solvedBy: null, answered: new Set(), correct: [], closed: false}));
	$('qeasy').textContent = `${e1} + ${e2}`;
	$('qhard').textContent = `${h1} + ${h2}`;
	$('qbox').classList.remove('solved', 'waiting');
	$('qlabel').textContent = '';
}
function points(ms, streak, mult) {
	const base = Math.round(1000 * (1 - 0.5 * Math.min(1, Math.max(0, ms) / (Q_TIME * 1000))));
	return Math.round(base * mult * (1 + 0.1 * Math.min(5, streak - 1)));
}

/**
 * Every chat message lands here. ts = the time YouTube says it was sent (epoch ms); reaction time is measured
 * from when the question reached that viewer (shown + stream latency), so laggy viewers aren't punished.
 */
window.chatMessage = (user, text, bot = false, ts = null) => {
	const now = performance.now();
	if (banned(user)) return null;
	const m = state.members.get(user) || assign(user, now, bot);
	m.lastSeen = now;
	if (state.phase === 'vote') return castVote(user, text);
	if (state.phase !== 'race') return null;
	const n = parseInt(String(text).replace(/[^\d-]/g, ''), 10);
	if (Number.isNaN(n)) return null;
	const q = state.qs.find((x) => x.answer === n && !x.closed && !x.answered.has(user));
	const sent = ts || Date.now();
	if (!q) {
		for (const x of state.qs) if (!x.closed && !x.answered.has(user) && x.kind === 'easy') { x.answered.add(user); m.streak = 0; }
		return null;
	}
	q.answered.add(user);
	const ms = sent - (q.shownAt + (bot ? 0 : LATENCY));
	if (ms > (Q_TIME * 1000) + GRACE) return null;
	if (!bot && ms < SUSPECT_MS) flag(user, `${ms}ms on ${q.a}+${q.b}`);
	const car = state.cars.find((c) => c.team === m.team);
	const first = !q.solvedBy;
	m.streak++;
	const pts = points(ms, m.streak, q.mult) + (first ? FIRST_BONUS : 0);
	m.points += pts; m.correct++; m.best = Math.min(m.best, Math.max(0, ms));
	car.points += pts; car.lastName = user; car.lastPts = pts; car.lastAt = now;
	car.burst += (pts / 1000) * LAP_PER_1000 * world.L;
	car.burstLeft = Math.max(car.burstLeft, first ? 3.2 : 2);
	q.correct.push({user, ms, pts, team: m.team});
	if (!bot) {
		const b = boardUser(user);
		b.points += pts; b.correct++; b.best = b.best == null ? ms : Math.min(b.best, ms);
		b.fast.push(Math.max(0, Math.round(ms))); if (b.fast.length > 60) b.fast.shift();
	}
	const streak = m.streak >= 2 ? ` 🔥x${m.streak}` : '';
	const tagTxt = q.kind === 'hard' ? ' ×2' : '';
	if (first) {
		q.solvedBy = user;
		director.cut(car, 3.2, 'ONBOARD · ' + car.team.name);
		beep(880, 0.12); setTimeout(() => beep(1320, 0.2), 90);
		$('solver').innerHTML = `⚡ ${T.first} <span style="color:${m.team.css}">${esc(user)}</span> · ${(Math.max(0, ms) / 1000).toFixed(1)}s · +${pts}${tagTxt}`;
		$('solver').style.opacity = 1;
		$('qbox').classList.add('solved');
		feed(`⚡ <em style="color:${m.team.css}">${esc(user)}</em> +${pts}${tagTxt}${streak}`);
	} else {
		beep(660, 0.05);
		feed(`✓ <em style="color:${m.team.css}">${esc(user)}</em> +${pts}${tagTxt}${streak}`);
	}
	return q.kind;
};

function questionTick() {
	if (state.phase !== 'race' || !state.qs.length) return;
	const now = Date.now(), q0 = state.qs[0];
	const left = 1 - (now - q0.shownAt) / (Q_TIME * 1000);
	$('qtimer').style.width = Math.max(0, left) * 100 + '%';
	if (left <= 0 && !q0.closed && !$('qbox').classList.contains('waiting')) {
		$('qbox').classList.add('waiting');
		$('qlabel').textContent = T.waiting;
	}
	// answers keep counting until the viewer's buzzer (+ latency + chat delivery)
	if (now > q0.shownAt + Q_TIME * 1000 + LATENCY + GRACE && !q0.closed) closeQuestions();
}
function closeQuestions() {
	for (const q of state.qs) q.closed = true;
	for (const [u, m] of state.members) if (!state.qs.some((q) => q.answered.has(u))) m.streak = 0;
	const all = state.qs.flatMap((q) => q.correct).sort((a, b) => a.ms - b.ms);
	const top = all.slice(0, 3).map((c, i) => `${['🥇', '🥈', '🥉'][i]} <span style="color:${c.team.css}">${esc(c.user)}</span> ${(Math.max(0, c.ms) / 1000).toFixed(1)}s`).join('  ');
	$('qeasy').textContent = `= ${state.qs[0].answer}`;
	$('qhard').textContent = `= ${state.qs[1].answer}`;
	$('qbox').classList.remove('waiting');
	$('qlabel').textContent = all.length ? T.correct(all.length) : T.nobody;
	$('solver').innerHTML = top; $('solver').style.opacity = top ? 1 : 0;
	setTimeout(() => { $('solver').style.opacity = 0; if (state.phase === 'race') newQuestions(); }, 2600);
}

// ---------- map vote: chat picks the next track while the camera tours the city ----------
function startVote() {
	state.phase = 'vote';
	const pool = MAPS.filter((m) => m.id !== world.current?.id).sort(() => Math.random() - 0.5).slice(0, 3);
	state.vote = {choices: pool, votes: {}, voters: new Set(), ends: Date.now() + VOTE_S * 1000};
	$('vote').innerHTML = `<h3>${T.vote}</h3>` + pool.map((m, i) => `<div class="vcard" id="v-${m.id}"><b>${'ABC'[i]}</b><div class="vn">${m.name}<small>${m.city}</small></div><span class="vc">0</span><i class="vf"></i></div>`).join('') + `<p>${T.voteHint}</p>`;
	$('vote').classList.add('show');
	director.scenic(VOTE_S + 15);
}
function castVote(user, text) {
	const v = state.vote, w = String(text).trim().toLowerCase();
	if (!v || v.voters.has(user)) return null;
	let i = ['a', 'b', 'c'].indexOf(w.split(/\s+/)[0]);
	if (i < 0) i = v.choices.findIndex((m) => w.includes(m.name.toLowerCase()) || w.includes(m.id));
	if (i < 0) return null;
	v.voters.add(user);
	const id = v.choices[i].id;
	v.votes[id] = (v.votes[id] || 0) + 1;
	const max = Math.max(1, ...Object.values(v.votes));
	for (const m of v.choices) {
		const el = $('v-' + m.id); const n = v.votes[m.id] || 0;
		el.querySelector('.vc').textContent = n; el.querySelector('.vf').style.width = (100 * n) / max + '%';
	}
	feed(`🗳️ <em>${esc(user)}</em> → ${v.choices[i].name}`);
	return id;
}
async function endVote() {
	const v = state.vote;
	const max = Math.max(0, ...v.choices.map((m) => v.votes[m.id] || 0));
	const top = v.choices.filter((m) => (v.votes[m.id] || 0) === max);
	const pick = top[Math.floor(Math.random() * top.length)];
	state.phase = 'loading';
	$('vote').classList.remove('show');
	$('banner').innerHTML = `${T.loading}<b>${pick.city} · ${pick.name}</b>`; $('banner').classList.add('show');
	try { await loadWorldMap(pick); } catch (e) { console.warn('[map] load failed', e); }
	$('banner').classList.remove('show');
	showPlace();
	startLights();
}
function showPlace() {
	$('place').innerHTML = world.current ? `📍 ${world.current.city} · ${world.current.name}` : '📍 MATH GP CIRCUIT';
}

// ---------- race flow ----------
function leadDist() { return Math.max(...state.cars.map((c) => c.dist)); }
function startLights() {
	state.phase = 'lights';
	state.race++;
	state.cars.forEach((c) => Object.assign(c, {dist: 0, v: 0, burst: 0, burstLeft: 0, points: 0, lastAt: -1e9}));
	for (const m of state.members.values()) Object.assign(m, {points: 0, streak: 0, best: Infinity, correct: 0});
	state.qs = [];
	$('qeasy').textContent = '…'; $('qhard').textContent = '…'; $('qlabel').textContent = T.join.toUpperCase();
	director.cut(state.cars[2], 6, 'GRID');
	const box = $('lights'); box.innerHTML = '<div class="light"><i></i><i></i></div>'.repeat(5); box.classList.add('show');
	[...box.children].forEach((el, i) => setTimeout(() => { el.classList.add('on'); beep(440, 0.18); }, 700 + i * 800));
	setTimeout(() => {
		box.classList.remove('show'); $('go').style.display = 'block'; beep(1046, 0.4);
		setTimeout(() => ($('go').style.display = 'none'), 900);
		state.phase = 'race'; newQuestions();
	}, 700 + 5 * 800 + 400 + Math.random() * 600);
}
function finish(winner) {
	state.phase = 'podium';
	director.cut(winner, 16, 'WINNER · ' + winner.team.name);
	const humans = [...state.members.entries()].filter(([u, m]) => !m.bot && !banned(u));
	for (const [u, m] of humans) { if (m.points > 0) { const b = boardUser(u); b.races++; if (m.team === winner.team) b.wins++; } }
	const raceTop = [...state.members.entries()].filter(([u, m]) => m.points > 0 && !banned(u)).sort((a, b) => b[1].points - a[1].points).slice(0, 5);
	const allTop = Object.entries(board.users).filter(([u]) => !banned(u)).sort((a, b) => b[1].points - a[1].points).slice(0, 5);
	const row = (u, pts, i, extra = '') => `<div class="lb"><span>${i + 1}</span><span class="nm">${esc(u)}${extra}</span><span class="ct">${pts.toLocaleString('en')}</span></div>`;
	$('podium').innerHTML = `<div class="chk"></div><h2>${T.winner}</h2><h1 style="color:${winner.team.css}">TEAM ${winner.team.name}</h1>
		<div class="boards"><div class="col"><h4>${T.race}</h4>${raceTop.map(([u, m], i) => row(u, m.points, i, ` <i style="background:${m.team.css}"></i>`)).join('')}</div>
		<div class="col"><h4>${T.alltime} 🏆</h4>${allTop.map(([u, b], i) => row(u, b.points, i)).join('') || '<p>—</p>'}</div></div>
		<div id="next">${T.next}</div><div class="chk"></div>`;
	$('podium').classList.add('show');
	[0, 150, 300].forEach((d) => setTimeout(() => beep(660 + d, 0.25), d));
	// grinders: answering nearly everything for hours straight with uniform speed looks scripted
	for (const [u, b] of Object.entries(board.users)) {
		if (b.fast.length >= 60) {
			const sorted = [...b.fast].sort((x, y) => x - y), med = sorted[30], spread = sorted[50] - sorted[10];
			if (med < 1200 && spread < 400) { flag(u, `robotic timing med ${med}ms spread ${spread}ms`); b.fast = []; }
		}
	}
	setTimeout(() => { $('podium').classList.remove('show'); startVote(); }, 14000);
}

// ---------- feed / sound / tower ----------
function feed(html) {
	const el = $('feed'), d = document.createElement('div'); d.className = 'fi'; d.innerHTML = html; el.prepend(d);
	[...el.children].forEach((c, i) => { c.style.top = i * 38 + 'px'; c.style.opacity = i > 4 ? 0 : 1 - i * 0.18; });
	while (el.children.length > 6) el.lastChild.remove();
}
let audio;
function beep(f, d) {
	try {
		audio = audio || new AudioContext();
		const o = audio.createOscillator(), v = audio.createGain();
		o.type = 'square'; o.frequency.value = f; v.gain.value = 0.05;
		o.connect(v).connect(audio.destination); o.start(); v.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + d); o.stop(audio.currentTime + d);
	} catch {}
}
TEAMS.forEach((t) => {
	const r = document.createElement('div'); r.className = 'trow'; r.id = 't-' + t.id;
	r.innerHTML = `<div class="p"></div><div class="c" style="background:${t.css}"></div><div class="n">${t.short}</div><div class="g"></div>`;
	$('tower').appendChild(r);
});
function renderTower() {
	const order = [...state.cars].sort((a, b) => b.dist - a.dist), sizes = teamSizes(performance.now()), speed = world.L / BASE_LAP_S;
	order.forEach((c, i) => {
		const r = $('t-' + c.team.id);
		r.style.top = i * 66 + 'px';
		r.classList.toggle('lead', i === 0);
		r.querySelector('.p').textContent = i + 1;
		r.querySelector('.g').innerHTML = (i === 0 ? T.leader : `+${((order[0].dist - c.dist) / speed).toFixed(1)}s`) + `<br>👥${sizes[c.team.id]} · ${c.points.toLocaleString('en')}`;
	});
	const lap = Math.min(LAPS, Math.floor(order[0].dist / world.L) + 1);
	$('lap').innerHTML = lap === LAPS ? `<b>${T.final}</b> ${T.lap}` : `${T.lap} <b>${lap}</b>/${LAPS}`;
}

// ---------- TV director: drives the MapLibre camera ----------
const director = {
	mode: 'chase', target: null, until: 0, label: '', snap: true, orbit: 0, bear: 0,
	cut(car, seconds, label) { Object.assign(this, {mode: 'chase', target: car, until: performance.now() + seconds * 1000, label}); },
	scenic(seconds) { Object.assign(this, {mode: 'scenic', until: performance.now() + seconds * 1000, orbit: Math.random() * 360}); },
	pick(now) {
		const order = [...state.cars].sort((a, b) => b.dist - a.dist);
		const r = Math.random();
		if (r < 0.4) this.cut(order[0], 7, 'LEADER · ' + order[0].team.name);
		else if (r < 0.62) this.cut(order[1 + Math.floor(Math.random() * 3)], 6, 'BATTLE');
		else if (r < 0.8) Object.assign(this, {mode: 'tv', target: order[0], until: now + 6000, label: 'TRACKSIDE', tvAt: order[0].dist + 60});
		else Object.assign(this, {mode: 'heli', target: order[0], until: now + 7000, label: placeName()});
	},
	update(now, dt) {
		if (this.mode === 'scenic') {
			this.orbit += dt * 6;
			placeCamera(new THREE.Vector3(Math.sin(now / 9000) * 120, 0, Math.cos(now / 9000) * 120), this.orbit, 62, 16.2);
			$('camtag').textContent = '● ' + placeName();
			if (now > this.until && state.phase === 'race') this.pick(now);
			return;
		}
		if (now > this.until || !this.target) this.pick(now);
		const c = at(this.target.dist);
		const pos = c.p.clone().addScaledVector(c.n, this.target.lane);
		const heading = bearingOf(c.t);
		// smooth the bearing so corners swing the camera instead of snapping it
		let diff = ((heading - this.bear + 540) % 360) - 180;
		this.bear += diff * Math.min(1, dt * 3);
		if (this.mode === 'chase') {
			const boost = this.target.burstLeft > 0;
			placeCamera(pos.clone().addScaledVector(c.t, 6), this.bear, boost ? 74 : 70, boost ? 19.4 : 19.8);
		} else if (this.mode === 'tv') {
			const spot = at(this.tvAt);
			const side = spot.p.clone().addScaledVector(spot.n, 22);
			const look = pos.clone().sub(side);
			placeCamera(pos, bearingOf(look), 72, 19.2);
		} else {
			this.bear += dt * 4;
			placeCamera(pos, this.bear, 55, 17.2);
		}
		$('camtag').textContent = '● ' + this.label;
	},
};
const placeName = () => (world.current ? `${world.current.city} · ${world.current.name}` : 'MATH GP');

// ---------- CPU drivers (labelled 🤖): fill the grid when few people watch, step aside as viewers join ----------
const BOT_NAMES = ['Mehmet', 'Ayşe', 'Emre', 'Zeynep', 'Burak', 'Elif', 'Can', 'Deniz', 'Kerem', 'Selin', 'Mert', 'Ece', 'Ahmet', 'Büşra',
	'Onur', 'İrem', 'Yusuf', 'Merve', 'Kaan', 'Sude', 'Barış', 'Defne', 'Arda', 'Nazlı'];
const bots = new Map();
function manageBots(now) {
	let humans = 0;
	for (const m of state.members.values()) if (!m.bot && now - m.lastSeen < ACTIVE_S * 1000) humans++;
	const want = Math.max(0, BOT_TARGET - humans * 2);
	while (bots.size < want) {
		const free = BOT_NAMES.filter((n) => !bots.has('🤖 ' + n));
		if (!free.length) break;
		const name = '🤖 ' + free[Math.floor(Math.random() * free.length)];
		bots.set(name, 0.45 + Math.random() * 0.5);
		if (!state.members.has(name)) assign(name, now, true);
	}
	while (bots.size > want) { const name = [...bots.keys()][Math.floor(Math.random() * bots.size)]; bots.delete(name); state.members.delete(name); }
}
let botRound = null;
setInterval(() => {
	const now = performance.now();
	manageBots(now);
	for (const name of bots.keys()) { const m = state.members.get(name); if (m) m.lastSeen = now; }
	if (state.phase === 'vote' && state.vote && botRound !== state.vote) {
		botRound = state.vote;
		for (const name of bots.keys()) if (Math.random() < 0.5) setTimeout(() => window.chatMessage(name, 'abc'[Math.floor(Math.random() * 3)], true), 2000 + Math.random() * 12000);
	}
	if (state.phase !== 'race' || !state.qs.length || botRound === state.qs) return;
	botRound = state.qs;
	const qs = state.qs;
	for (const [name, skill] of bots) {
		const q = Math.random() < 0.65 ? qs[0] : qs[1];
		if (Math.random() > skill) continue;
		const ok = Math.random() < (q.kind === 'easy' ? 0.92 : 0.78);
		const delay = (q.kind === 'easy' ? 1500 : 3500) + Math.random() * 8000 * (1.15 - skill);
		setTimeout(() => window.chatMessage(name, String(ok ? q.answer : q.answer + 1), true), delay);
	}
}, 500);

// ---------- main loop ----------
let last = performance.now(), fpsFrames = 0;
setInterval(() => { window.fps = fpsFrames / 5; fpsFrames = 0; }, 5000);
function frame(now) {
	const dt = Math.min(0.05, (now - last) / 1000); last = now;
	const base = world.L / BASE_LAP_S;
	if (state.phase === 'race' || state.phase === 'podium') {
		const lead = leadDist();
		for (const c of state.cars) {
			const gap = lead - c.dist;
			const behind = Math.min(1, gap / (0.06 * world.L));
			const second = Math.max(...state.cars.filter((o) => o !== c).map((o) => o.dist));
			const runaway = c.dist === lead && c.dist - second > 0.03 * world.L ? 0.8 : 1;
			let v = state.phase === 'podium' ? base * 0.6 : base * (1 + 0.9 * behind) * runaway;
			if (c.burstLeft > 0) { const take = Math.min(c.burst, (c.burst / c.burstLeft) * dt); v += take / dt; c.burst -= take; c.burstLeft -= dt; }
			c.v = v;
			c.dist = Math.max(c.dist + v * dt, lead - 0.1 * world.L);
			if (state.phase === 'race' && c.dist >= LAPS * world.L) { finish(c); break; }
		}
		questionTick();
	}
	if (state.phase === 'vote' && Date.now() > state.vote.ends) endVote();
	if (state.phase === 'vote') $('timer').textContent = `${Math.max(0, Math.ceil((state.vote.ends - Date.now()) / 1000))}`;
	for (const c of state.cars) {
		const {p, t, n} = at(c.dist);
		const m = c.mesh;
		m.position.copy(p).add(n.clone().multiplyScalar(c.lane)).setY(0.02);
		m.lookAt(m.position.clone().add(t));
		for (const w of m.userData.wheels) w.rotation.x += (c.v * dt) / 0.42;
		const boost = Math.max(0, Math.min(1, c.burstLeft));
		m.userData.flame.material.opacity = boost * (0.6 + 0.4 * Math.random());
		m.userData.flame.scale.set(1, 0.7 + boost * 0.8 + Math.random() * 0.3, 1);
		const show = now - c.lastAt < 2600;
		c.tag.visible = show;
		if (show) {
			const key = c.lastName + c.lastPts;
			if (c.tag.userData.key !== key) { c.tag.userData.draw(`${c.lastName.slice(0, 14)} +${c.lastPts}`, c.team.css); c.tag.userData.key = key; }
			c.tag.position.copy(m.position).setY(2.6);
		}
	}
	director.update(now, dt);
	renderTower();
	repaint();
	fpsFrames++;
	requestAnimationFrame(frame);
}

function fit() { $('stage').style.transform = `translate(-50%, -50%) scale(${Math.min(innerWidth / 1080, innerHeight / 1920)})`; }
addEventListener('resize', fit); fit();
$('hint').innerHTML = T.hint;
$('lbleasy').textContent = T.easy; $('lblhard').textContent = T.hard;

// music: CC0 tracks on loop (?music=0 when the streamer mixes audio itself)
if (params.get('music') !== '0') {
	const tracks = [1, 2, 3, 4, 5, 6].map((i) => `assets/music/track_${i}.mp3`).sort(() => Math.random() - 0.5);
	const player = new Audio(); player.volume = Number(params.get('volume') || 0.35);
	let i = 0;
	const play = () => { player.src = tracks[i++ % tracks.length]; player.play().catch(() => {}); };
	player.addEventListener('ended', play); play();
	addEventListener('pointerdown', () => player.paused && player.play().catch(() => {}), {once: true});
}

(async () => {
	const first = params.get('map') ? MAPS.find((m) => m.id === params.get('map')) : MAPS[Math.floor(Math.random() * MAPS.length)];
	await initWorld('map', LOW);
	try { await loadWorldMap(first); } catch (e) { console.warn('[map] first load failed', e); }
	showPlace();
	requestAnimationFrame(frame);
	startLights();
	window.gameReady = true;
})();

// ---------- site mode (?chat=1): live chat and the all-time board come from the Cloudflare worker ----------
if (params.get('chat')) {
	const status = (t) => { $('camtag').dataset.chat = t; };
	(async function chatLoop() {
		let c = null;
		for (;;) {
			try {
				const r = await (await fetch('/api/chat' + (c ? `?c=${encodeURIComponent(c)}` : (params.get('channel') ? `?channel=${encodeURIComponent(params.get('channel'))}` : '')))).json();
				for (const m of r.messages || []) window.chatMessage(m.author, m.text, false, m.ts || null);
				c = r.live ? r.c : null;
				status(r.live ? 'live' : 'waiting');
				await new Promise((ok) => setTimeout(ok, r.live ? r.wait || 1500 : 20000));
			} catch (e) {
				c = null; status('error');
				await new Promise((ok) => setTimeout(ok, 15000));
			}
		}
	})();
	fetch('/api/board').then((r) => r.json()).then((b) => window.loadBoard(b)).catch(() => {});
	const key = params.get('key');
	if (key) setInterval(() => fetch('/api/board', {method: 'POST', headers: {'x-board-key': key}, body: JSON.stringify(window.exportBoard())}).catch(() => {}), 5 * 60 * 1000);
}
