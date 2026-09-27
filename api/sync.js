// LEXICON 同期 API。同期コードごとに一つの文書を非公開の Blob に置き、端末から届いた差分と併合して返す。
// ・コードそのものは保存しない（sha256 を取った値を置き場所の名にする）
// ・新しい同期先を作れるのは管理鍵を持つ者だけ（公開ページから勝手に保存領域を増やされないため）
// ・書き込みは ETag が一致したときだけ行い、同時に二台が送っても一方の記録を上書きで失わない
import { get, put, del, BlobPreconditionFailedError } from '@vercel/blob';
import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_BYTES = 3 * 1024 * 1024;
const CODE_LEN = 24;

// 同期の併合。端末とサーバで同じ関数を使う。可換・結合的・冪等なので、どの順で何度合わせても同じ結果に収まる。
// 語ごとに「新しい方」を採る（t=最終更新時刻、同時刻なら復習回数・期日の大きい方）。消した語は墓標（del）で覚え、
// 墓標より後に触れた語だけが生き返る。設定は最後に書いた端末が勝つ。読速の記録は両方を合わせて新しい 20 件を残す。
export function syncMerge(a,b){
  a=a||{};b=b||{};
  function newer(x,y){
    if(!x)return y;if(!y)return x;
    var k=['t','rep','due','iv','s','lap'];
    for(var i=0;i<k.length;i++){var p=+x[k[i]]||0,q=+y[k[i]]||0;if(p!==q)return p>q?x:y}
    return JSON.stringify(x)>=JSON.stringify(y)?x:y;
  }
  function cards(ca,da,cb,db){
    ca=ca||{};da=da||{};cb=cb||{};db=db||{};
    var oc={},od={},ids={},id;
    [ca,da,cb,db].forEach(function(m){for(var k in m)ids[k]=1});
    for(id in ids){
      var d=Math.max(+da[id]||0,+db[id]||0),c=newer(ca[id],cb[id]);
      if(c&&(!d||(+c.t||0)>d))oc[id]=c;else if(d)od[id]=d;
    }
    return[oc,od];
  }
  function later(x,y){
    if(!x)return y||null;if(!y)return x;
    var p=+x.t||0,q=+y.t||0;
    if(p!==q)return p>q?x:y;
    return JSON.stringify(x)>=JSON.stringify(y)?x:y;
  }
  var v=cards(a.cards,a.del,b.cards,b.del),g=cards(a.gcards,a.gdel,b.gcards,b.gdel);
  var reads={},ra=a.reads||{},rb=b.reads||{};
  Object.keys(ra).concat(Object.keys(rb)).forEach(function(pid){
    if(reads[pid])return;
    var m={};
    (ra[pid]||[]).concat(rb[pid]||[]).forEach(function(x){if(x&&x.ts&&(!m[x.ts]||JSON.stringify(x)>JSON.stringify(m[x.ts])))m[x.ts]=x});
    reads[pid]=Object.keys(m).map(Number).sort(function(p,q){return p-q}).slice(-20).map(function(ts){return m[ts]});
  });
  return{v:1,cards:v[0],del:v[1],gcards:g[0],gdel:g[1],set:later(a.set,b.set),reads:reads};
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
function normCode(s) { return String(s || '').toUpperCase().replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B').replace(/[^A-Z2-7]/g, ''); }
function pathOf(code) { return 'sync/' + createHash('sha256').update('lexicon-sync:' + code).digest('hex') + '.json'; }
function isAdmin(key) {
  const a = Buffer.from(String(key || '')), b = Buffer.from(process.env.SYNC_ADMIN_KEY || '');
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
function obj(x) { return x && typeof x === 'object' && !Array.isArray(x) ? x : {}; }
// 届いた文書の形だけを整える（値の中身は併合が扱う）
function clean(d) {
  d = obj(d);
  const reads = {};
  for (const [k, v] of Object.entries(obj(d.reads))) if (Array.isArray(v)) reads[k] = v.filter(x => x && typeof x === 'object');
  const set = d.set && typeof d.set === 'object' && !Array.isArray(d.set) ? d.set : null;
  return { v: 1, cards: obj(d.cards), del: obj(d.del), gcards: obj(d.gcards), gdel: obj(d.gdel), set, reads };
}
async function load(path) {
  const r = await get(path, { access: 'private', useCache: false });
  if (!r) return null;
  return { doc: JSON.parse(await new Response(r.stream).text()), etag: r.blob.etag };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 版の不一致（412）と、別の書き込みが進行中の衝突（409）はどちらも再試行してよい
function isConflict(e) {
  return e instanceof BlobPreconditionFailedError || /conditional request|conflicting operation/i.test(String(e && e.message));
}
const OPTS = { access: 'private', addRandomSuffix: false, contentType: 'application/json' };

export async function POST(request) {
  try { return await handle(request); }
  catch (e) { console.error(e); return json({ error: 'server' }, 500); }
}

async function handle(request) {
  if ((+request.headers.get('content-length') || 0) > MAX_BYTES) return json({ error: 'too large' }, 413);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }
  const code = normCode(body && body.code);
  if (code.length !== CODE_LEN) return json({ error: 'bad code' }, 400);
  const path = pathOf(code);

  if (body.op === 'create' || body.op === 'delete') {
    if (!isAdmin(body.admin)) return json({ error: 'forbidden' }, 403);
    if (body.op === 'delete') { await del(path); return json({ ok: true }); }
    if (await load(path)) return json({ error: 'exists' }, 409);
    await put(path, JSON.stringify(syncMerge({}, {})), { ...OPTS, allowOverwrite: false });
    return json({ ok: true });
  }

  const incoming = clean(body.doc);
  // 同時に来た書き込みとぶつかったら、少し間を置いて読み直す（間隔は伸ばし、揺らぎを入れて再衝突を避ける）
  for (let i = 0; i < 8; i++) {
    if (i) await sleep(Math.min(1500, 120 * 2 ** (i - 1)) * (0.5 + Math.random()));
    const cur = await load(path);
    if (!cur) return json({ error: 'not found' }, 404);
    const merged = syncMerge(cur.doc, incoming);
    const text = JSON.stringify(merged);
    if (text === JSON.stringify(cur.doc)) return json({ doc: merged });
    try {
      await put(path, text, { ...OPTS, allowOverwrite: true, ifMatch: cur.etag });
      return json({ doc: merged });
    } catch (e) {
      if (isConflict(e)) { console.warn('sync-conflict', i, cur.etag, e.name, String(e.message).slice(0, 120)); continue; }
      throw e;
    }
  }
  return json({ error: 'busy' }, 409);
}
