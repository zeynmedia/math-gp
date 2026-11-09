// Math GP site: serves the game (web/) and two small APIs the page polls.
//   GET  /api/chat?c=<continuation>  YouTube live chat without API quota (the same feed the web player reads)
//   GET  /api/board, POST /api/board  all-time leaderboard + bans, kept in KV between sessions
const CHANNEL = 'https://www.youtube.com/@nukieer/live';
const HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
	Cookie: 'CONSENT=YES+1; SOCS=CAI',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});

async function startChat(channel) {
	const page = await (await fetch(channel, {headers: HEADERS})).text();
	const vid = page.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1] || page.match(/"videoId":"([\w-]{11})"/)?.[1];
	if (!vid) return {live: false};
	const chat = await (await fetch(`https://www.youtube.com/live_chat?is_popout=1&v=${vid}`, {headers: HEADERS})).text();
	const key = chat.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];
	const ver = chat.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1] || '2.20241101.00.00';
	const c = chat.match(/"continuation":"([^"]+)"/)?.[1];
	if (!key || !c) return {live: false, video: vid};
	return {live: true, video: vid, c: `${key}|${ver}|${c}`, messages: [], wait: 1000};
}

async function pollChat(token) {
	const [key, ver, c] = token.split('|');
	const r = await fetch(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${key}&prettyPrint=false`, {
		method: 'POST', headers: {...HEADERS, 'content-type': 'application/json'},
		body: JSON.stringify({context: {client: {clientName: 'WEB', clientVersion: ver}}, continuation: c}),
	});
	if (!r.ok) return {live: false, status: r.status};
	const d = await r.json();
	const cont = d.continuationContents?.liveChatContinuation;
	if (!cont) return {live: false};
	const messages = [];
	for (const a of cont.actions || []) {
		const it = a.addChatItemAction?.item?.liveChatTextMessageRenderer;
		if (!it) continue;
		messages.push({
			author: it.authorName?.simpleText || 'someone',
			text: (it.message?.runs || []).map((r) => r.text ?? r.emoji?.shortcuts?.[0] ?? '').join(''),
			ts: Number(it.timestampUsec) / 1000,
		});
	}
	const next = cont.continuations?.[0] || {};
	const n = next.invalidationContinuationData || next.timedContinuationData || next.reloadContinuationData || {};
	return {live: !!n.continuation, c: n.continuation ? `${key}|${ver}|${n.continuation}` : null, messages, wait: Math.max(800, Math.min(n.timeoutMs || 1500, 5000))};
}

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === '/api/chat') {
			try {
				const c = url.searchParams.get('c');
				return json(c ? await pollChat(c) : await startChat(url.searchParams.get('channel') || env.CHANNEL || CHANNEL));
			} catch (e) {
				return json({live: false, error: String(e).slice(0, 200)});
			}
		}
		if (url.pathname === '/api/board') {
			if (req.method === 'POST') {
				if (req.headers.get('x-board-key') !== env.BOARD_KEY) return json({error: 'forbidden'}, 403);
				await env.KV.put('board', await req.text());
				return json({ok: true});
			}
			return new Response((await env.KV.get('board')) || '{"users":{},"bans":{}}', {headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
		}
		return env.ASSETS.fetch(req);
	},
};
