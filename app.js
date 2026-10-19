'use strict';
/* SPEEDWIRE — production website: Supabase is required for all league data.
   GitHub Pages serves public files only. Supabase RLS enforces write permissions.
   NEVER place a service role/secret key in config.js. */
const cfg=window.SPEEDWIRE_CONFIG||{};
const configured=Boolean(/^https:\/\/[^/]+\.supabase\.co\/?$/.test(cfg.supabaseUrl||'') && typeof cfg.supabaseAnonKey==='string' && cfg.supabaseAnonKey.trim());
const TOURNAMENT_TYPES=['Open','Stage','Mid-Season Qualifier','Mid-Season Final','Major Qualifier','Major'];
const TYPE_DETAILS={
 'Open':'Accessible circuit tournament · earn rating and placement points',
 'Stage':'Structured league stage · regular competition and circuit points',
 'Mid-Season Qualifier':'Qualifying event · top four advance to the Mid-Season Final',
 'Mid-Season Final':'Mid-season championship · four invites plus four qualifiers',
 'Major Qualifier':'Qualifying event · top four advance to the Major',
 'Major':'Season championship · four invites plus four qualifiers'
};
const GROUP_CHOICES=[['0','No group stage / playoffs only'],['de8','Double elimination · 8 players · Groups A + B'],['de16','Double elimination · 16 players · Groups A + B'],['swiss8','Swiss stage · 8 players'],['swiss16','Swiss stage · 16 players']];
const SWISS_ROUNDS=['0:0 Swiss','1:0 Swiss','0:1 Swiss','2:0 Swiss','1:1 Swiss','0:2 Swiss','2:1 Swiss','1:2 Swiss','2:2 Swiss'];
const SWISS_RECORDS=['0:0','1:0','0:1','2:0','1:1','0:2','2:1','1:2','2:2'];
const SWISS_ROUNDS_EIGHT=['0:0 Swiss','1:0 Swiss','0:1 Swiss','1:1 Swiss'];
const SWISS_RECORDS_EIGHT=['0:0','1:0','0:1','1:1'];
function swissRoundsFor(t){return swissSize(t)===8?SWISS_ROUNDS_EIGHT:SWISS_ROUNDS;}
function swissSize(t){return [8,16].includes(Number(t?.swiss_size))?Number(t.swiss_size):0;}
function stageOption(t){return swissSize(t)?`swiss${swissSize(t)}`:groupCount(t)?`de${Number(t?.capacity)===16?16:8}`:'0';}
function stageName(t){return swissSize(t)?`Swiss stage (${swissSize(t)} players)`:groupCount(t)?`Double elimination · ${Number(t?.capacity)||8} players · Groups A + B`:'Playoffs only';}
function sectionTitle(t,section){return section==='A'&&swissSize(t)?'Swiss Stage':BRACKET_SECTIONS[section]||'Playoffs';}
function isPlacementRound(round){return /\b(third[ -]?place|3rd[ -]?place|placement match|bronze match|third[ -]?place decider)\b/i.test(String(round||''));}
const BRACKET_SECTIONS={A:'Group A',B:'Group B',playoffs:'Playoffs'};
function groupCount(t){return Math.max(0,Math.min(2,Number(t?.group_count)||0));}
function matchSection(m){
 if(['A','B','playoffs'].includes(m?.section))return m.section;
 const legacy=String(m?.round||'').match(/\b(?:group|pool)\s*([ab])\b/i);
 return legacy?legacy[1].toUpperCase():'playoffs';
}
function groupRoundRole(round){
 const r=roundKey(round);
 if(/\b(opening|opener)\b/.test(r))return 'opening';
 if(/\b(upper semis?|upper semifinals?|winners? semifinals?)\b/.test(r))return 'upperSemi';
 if(/\b(upper finals?|winners? finals?|winners? match)\b/.test(r))return 'upperFinal';
 if(/\b(lower round|losers? round)\b/.test(r))return 'lowerRound';
 if(/\b(lower semis?|lower semifinals?|losers? semifinals?)\b/.test(r))return 'lowerSemi';
 if(/\b(lower finals?|losers? finals?|elimination match)\b/.test(r))return 'lowerFinal';
 return null;
}
const LEGACY_TYPES={'Masters':'Stage','Qualifier':'Major Qualifier'};
const CHAMPIONSHIP_PATHS={
 'Mid-Season Final':{name:'Mid-Season Final',qualifier:'Mid-Season Qualifier',inviteCount:4,qualifierCount:4},
 'Major':{name:'Major',qualifier:'Major Qualifier',inviteCount:4,qualifierCount:4}
};
// No built-in sample players, local-browser league, or automatic data seeding.
let db=null, session=null, isAdmin=false, refreshTimer=null, toastTimer=null, loading=false, currentError='';

const ui={route:location.hash.slice(1)||'/overview',ranking:'rating',eventFilter:'all',typeFilter:'all',matchFilter:'all',mobile:false,playerQuery:'',search:'',adminTab:'match',editing:null,rosterTournament:'',notice:''};
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug=s=>/^[a-z0-9-]{2,40}$/.test(s);
const n=val=>Number(val)||0;
const byP=id=>data.players.find(x=>x.id===id);
const byT=id=>data.tournaments.find(x=>x.id===id);
const byM=id=>data.matches.find(x=>x.id===id);
const labelP=id=>byP(id)?.handle||'TBD';
const rankArr=()=>[...data.players].sort((a,b)=>b.rating-a.rating||a.handle.localeCompare(b.handle));
const pointsArr=()=>[...data.players].sort((a,b)=>b.points-a.points||b.rating-a.rating);

// Two independent 8-player championship paths: four Circuit Points invites and
// four top-four qualifier placements. The official event roster is always authoritative.
function qualificationSnapshot(championshipType='Major'){
 const cfg=CHAMPIONSHIP_PATHS[championshipType];
 if(!cfg)return null;
 const finalEvent=data.tournaments.find(t=>t.tier===championshipType);
 const qualifier=data.tournaments.find(t=>t.tier===cfg.qualifier);
 if(!finalEvent&&!qualifier)return null;
 // Use only circuit points from BEFORE the qualifier. Later tournament awards
 // must not retroactively alter a past championship's invited competitors.
 // Hidden starts_at is used for chronological ordering, never shown publicly.
 const ordered=[...data.tournaments].sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at));
 const cutoff=qualifier||finalEvent;
 const index=cutoff?ordered.findIndex(t=>t.id===cutoff.id):-1;
 const eligible=new Set(index>=0?ordered.slice(0,index).map(t=>t.id):ordered.filter(t=>t.tier!=='Mid-Season Qualifier'&&t.tier!=='Major Qualifier'&&t.tier!=='Mid-Season Final'&&t.tier!=='Major').map(t=>t.id));
 const scores=new Map(data.players.map(p=>[p.id,0]));
 for(const award of data.awards)if(eligible.has(award.tournament_id)&&scores.has(award.player_id))scores.set(award.player_id,scores.get(award.player_id)+Number(award.points||0));
 const direct=[...data.players].sort((a,b)=>(scores.get(b.id)||0)-(scores.get(a.id)||0)||b.rating-a.rating||a.handle.localeCompare(b.handle)).slice(0,cfg.inviteCount);
 const directIds=new Set(direct.map(p=>p.id));
 const placements=qualifier?data.awards.filter(a=>a.tournament_id===qualifier.id&&Number(a.placement)>=1&&Number(a.placement)<=cfg.qualifierCount).sort((a,b)=>Number(a.placement)-Number(b.placement)):[];
 const qualifiers=[];const qualifiedIds=new Set();
 for(const award of placements){const player=byP(award.player_id);if(player&&!directIds.has(player.id)&&!qualifiedIds.has(player.id)){
  qualifiers.push({player,placement:Number(award.placement)});qualifiedIds.add(player.id);
 }}
 return {direct,qualifiers:qualifiers.slice(0,cfg.qualifierCount),qualifier,finalEvent,eligible,scores,cfg};
}
function championshipQualificationPanel(championshipType='Major'){
 const snapshot=qualificationSnapshot(championshipType);if(!snapshot)return '';
 // A completed championship no longer needs a live qualification race.
 if(snapshot.finalEvent?.status==='completed')return '';
 const {direct,qualifiers,qualifier,cfg}=snapshot;
 const entry=(p,position,sub,empty)=>`<div class="major-spot ${p?'major-filled':'major-empty'}"><span class="major-seed">${e(String(position).padStart(2,'0'))}</span>${p?`${avatar(p,'mini')}<a href="${toPath('player',p.id)}"><strong>${e(p.handle)}</strong><small>${e(sub)}</small></a>`:`<span class="tbd-avatar">?</span><span><strong>TBD</strong><small>${e(empty)}</small></span>`}</div>`;
 const directly=Array.from({length:cfg.inviteCount},(_,i)=>entry(direct[i],i+1,'Circuit Points invite · projected','Pending ranking')).join('');
 const qSpots=Array.from({length:cfg.qualifierCount},(_,i)=>entry(qualifiers[i]?.player,i+1,qualifiers[i]?`${cfg.qualifier} · place #${qualifiers[i].placement}`:'',`Awaiting ${cfg.qualifier} results`)).join('');
 return `<section class="panel major-qual-panel"><div class="panel-head"><h2>Road to the ${e(cfg.name)} · 8 spots</h2><span class="caps">4 invites + 4 qualifiers</span></div><div class="major-qualification-grid"><div class="major-qual-section"><div class="major-qual-label"><strong>DIRECT INVITATIONS</strong><span>Top 4 eligible Circuit Points</span></div>${directly}</div><div class="major-qual-section"><div class="major-qual-label"><strong>${e(cfg.qualifier.toUpperCase())}</strong><span>Top 4 eligible finishers</span></div>${qSpots}</div></div><div class="major-qual-foot">Direct invitations are projections using Circuit Points from events before this qualifier, so later events do not rewrite past standings. Top-four qualifier placements appear after the admin records them under Circuit points (0-point placement is allowed). ${qualifier?`<a href="${toPath('tournament',qualifier.id)}">View ${e(qualifier.name)}</a>. `:''}Invitees must not also qualify through the qualifier; if a placement overlaps an invite, it is skipped instead of silently awarding an extra slot. Confirm the official eight players under Admin → Event rosters.</div></section>`;
}
// Avoid empty grid cells once one or both championships are completed.
function activeChampionshipPanels(){
 const panels=['Mid-Season Final','Major'].map(type=>championshipQualificationPanel(type)).filter(Boolean);
 return panels.length?`<div class="championship-tracker-grid top-gap">${panels.join('')}</div>`:'';
}
function tournamentQualificationSection(tier){
 if(!['Major','Major Qualifier','Mid-Season Final','Mid-Season Qualifier'].includes(tier))return '';
 const championshipType=tier.startsWith('Mid-Season')?'Mid-Season Final':'Major';
 const panel=championshipQualificationPanel(championshipType);
 return panel?`<div class="top-gap">${panel}</div>`:'';
}

const toPath=(kind,id)=>`#/${kind}/${encodeURIComponent(id)}`;
const won=m=>!isDone(m)?null:Number(m.score1)>Number(m.score2)?m.player1_id:m.player2_id;
const isDone=m=>m.score1!=null&&m.score2!=null&&Boolean(m.player1_id&&m.player2_id);
const matching=id=>data.matches.filter(m=>m.player1_id===id||m.player2_id===id);
const statusClass=s=>s==='ongoing'?'ongoing':s==='completed'?'completed':'upcoming';
const fmtDelta=x=>x>0?`+${x}`:String(x);
let data={players:[],tournaments:[],matches:[],awards:[],history:[],registrations:[]};
const participants=id=>data.registrations.filter(r=>r.tournament_id===id).map(r=>byP(r.player_id)).filter(Boolean);
const openSeats=t=>Math.max(0,(Number(t.capacity)||8)-participants(t.id).length);
const ratingMargin=(score1,score2,best)=>{
 const needed=Math.ceil(Number(best)/2),margin=Math.abs(Number(score1)-Number(score2));
 return needed===1?1:0.75+0.75*(margin-1)/(needed-1);
};
const roundAway=x=>Math.sign(x)*Math.round(Math.abs(x));
function eloChange(ra,rb,score1,score2,best){const ea=1/(1+10**((rb-ra)/400));return roundAway(32*((score1>score2?1:0)-ea)*ratingMargin(score1,score2,best));}
function rosterOptions(eventId, selected=null){const roster=participants(eventId);const pool=selected&&!roster.some(p=>p.id===selected)?[...roster,byP(selected)].filter(Boolean):roster;
 return optionList(pool,selected,x=>x.handle,'TBD — unannounced');
}
function hydrateLive(payload){
 const scores=payload.awards.reduce((acc,a)=>(acc[a.player_id]=(acc[a.player_id]||0)+Number(a.points),acc),{});
 const players=payload.players.map(p=>({...p,points:scores[p.id]||0,history:[1000,...payload.history.filter(h=>h.player_id===p.id).sort((a,b)=>new Date(a.played_at)-new Date(b.played_at)||a.match_id.localeCompare(b.match_id)).map(h=>h.rating)]}));
 for(const p of players)p.delta=p.history.length>1?p.history.at(-1)-p.history.at(-2):0;
 data={...payload,players,registrations:payload.registrations||[]};
}
async function loadScript(url){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=url;s.onload=resolve;s.onerror=()=>reject(new Error('Could not load Supabase library. Check your internet connection.'));document.head.append(s);});}
async function start(){
 if(!configured){
  currentError='The site has not been connected to a Supabase project. Set your project URL and public key in config.js; see README.md.';
  render();return;
 }
 render();
 try{
  await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
  if(!window.supabase?.createClient)throw Error('Supabase library could not initialize.');
  db=window.supabase.createClient(cfg.supabaseUrl,cfg.supabaseAnonKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  const result=await db.auth.getSession();if(result.error)throw Error(result.error.message);
  session=result.data.session;
  await adminLookup();await loadLive();
  db.auth.onAuthStateChange((_evt,next)=>{session=next;setTimeout(async()=>{await adminLookup();render();},0)});
  refreshTimer=setInterval(()=>{if(!document.hidden)loadLive(true)},30000);
  window.addEventListener('focus',()=>loadLive(true));
 }catch(err){currentError=`Live connection error: ${err.message}`;render();}
}
async function adminLookup(){isAdmin=false;if(!db||!session?.user)return;
 const res=await db.from('admins').select('user_id').eq('user_id',session.user.id).maybeSingle();isAdmin=!res.error&&!!res.data;
}
async function loadLive(quiet=false){if(!db||loading)return;loading=true;
 try{
 const tables=['players','tournaments','matches','awards','rating_history','tournament_players'];
 const rs=await Promise.all(tables.map(t=>db.from(t).select('*').limit(10000)));
 const err=rs.find(r=>r.error);if(err)throw Error(err.error.message);
 hydrateLive({players:rs[0].data||[],tournaments:rs[1].data||[],matches:rs[2].data||[],awards:rs[3].data||[],history:rs[4].data||[],registrations:rs[5].data||[]});
 currentError='';if(!quiet)ui.notice='Live data loaded successfully.';
 }catch(err){currentError=`Database error: ${err.message}`;}
 finally{loading=false;render();}
}
function toast(msg,bad=false){const old=document.getElementById('site-toast');old?.remove();const d=document.createElement('div');d.id='site-toast';d.className='toast'+(bad?' bad':'');d.textContent=msg;document.body.append(d);clearTimeout(toastTimer);toastTimer=setTimeout(()=>d.remove(),4500);}
function header(){const nav=[['overview','Overview'],['rankings','Rankings'],['tournaments','Tournaments'],['players','Players'],['matches','Matches'],['admin','Admin']];const link=([id,text],cls='nav-link')=>`<a href="#/${id}" class="${cls} ${ui.route.startsWith('/'+id)?'active':''}">${text}</a>`;
 return `<header class="site-header"><div class="header-inner"><a class="brand" href="#/overview"><div class="brand-icon"><span>SW</span></div><div><div class="brand-name">SPEED<em>WIRE</em><span style="color:#91adbb;font-size:11px">.GG</span></div><div class="brand-tag">THE SPEED CARD CIRCUIT</div></div></a><nav class="top-nav">${nav.map(x=>link(x)).join('')}</nav><div class="top-spacer"></div><div class="search-box"><span class="search-glyph">⌕</span><input id="site-search" placeholder="Search league..." autocomplete="off" aria-label="Search league" value="${e(ui.search)}"><div id="search-results"></div></div><span class="season-chip"><span style="color:#87e7b6">● LEAGUE</span> · SEASON 01</span><button id="mobile-menu" class="mobile-menu" aria-label="Toggle menu">☰</button></div></header>`;
}
function sidebar(){return `<aside class="sidebar"><div class="side-title">CIRCUIT</div><div class="side-nav">${[['overview','◈','Overview'],['rankings','▥','World Rankings'],['tournaments','▦','Tournaments'],['matches','⇄','Matches'],['players','♧','Player Directory'],['admin','⚙','Admin Center']].map(([id,ico,text])=>`<a href="#/${id}" class="side-link ${ui.route.startsWith('/'+id)?'active':''}"><span style="font-size:17px;width:18px;text-align:center">${ico}</span>${text}</a>`).join('')}</div><div class="sidebar-qualify"><div class="label">CHAMPIONSHIP RACE</div><strong>Two championship paths</strong><p>Mid-Season Final and Major each have 8 spots: 4 Circuit Points invites + 4 qualifier placements.</p><div class="mini-progress"><span style="width:${Math.min(100,data.tournaments.filter(t=>t.status==='completed').length/Math.max(1,data.tournaments.length)*100)}%"></span></div><a href="#/rankings" class="inline-link" style="font-size:11px;display:block;margin-top:12px">See qualification standings →</a></div><div class="side-note">Shared league database · Elo K = 32 · Final score margin adjusts Elo.</div></aside>`;}
function footer(){return `<footer class="footerbar"><span>© SPEEDWIRE.GG · Community Speed League · Cloud-connected</span><span><a href="#/admin">Manage league</a> · <a href="#/tournaments">Event archive</a></span></footer>`;}
function pageHead(k,title,desc,right=''){return `<div class="page-top"><div><div class="eyebrow">${e(k)}</div><h1 class="page-heading">${e(title)}</h1><p class="page-desc">${e(desc)}</p></div>${right}</div>`;}
function modeBanner(){
 if(currentError)return `<div class="state-strip error"><div><strong>Connection problem.</strong> ${e(currentError)} Existing downloaded data are not substituted for live league records.</div><button class="btn-alt" data-reload>Retry</button></div>`;
 if(!db)return `<div class="state-strip"><span>Connecting to the league database…</span></div>`;
 return '';
}
function avatar(p,size=''){return `<div class="player-avatar ${size}" style="--player:${e(p.color||'#467b97')}">${e((p.handle||'?').slice(0,1).toUpperCase())}</div>`;}
function playerInline(p){return p?`<a class="avatar-cluster" href="${toPath('player',p.id)}">${avatar(p,'mini')}<span style="font-weight:850">${e(p.handle)}</span></a>`:'—';}
function chip(text){return `<span class="chip ${statusClass(text)}">${e(text)}</span>`;}
function statRow(p,idx,what='rating'){const total=n(p.wins)+n(p.losses);return `<tr class="click-row" data-go="/player/${encodeURIComponent(p.id)}"><td class="rank-pill">#${idx+1}</td><td>${playerInline(p)}<span style="color:var(--muted);font-size:10px">${e(p.name)}</span>${what==='points'?`<span class="points-projection ${idx<4?'invite':'lcq'}">${idx<4?'DIRECT INVITE (PROJECTED)':'LCQ PATH'}</span>`:''}</td><td>${n(p.wins)}–${n(p.losses)}</td><td>${total?Math.round(100*p.wins/total):0}%</td><td style="text-align:right"><strong class="accent">${what==='points'?p.points:p.rating}</strong></td><td style="text-align:right;color:${p.delta>=0?'#76e4bc':'#ffaa9a'}">${what==='rating'?fmtDelta(p.delta):('#'+(rankArr().findIndex(x=>x.id===p.id)+1))}</td></tr>`;}
function tableTop(players,what='rating',limit=0){const shown=limit?players.slice(0,limit):players;return `<div class="table-scroll"><table class="data-table"><thead><tr><th>#</th><th>Player</th><th>W–L</th><th>Win %</th><th class="th-right">${what==='points'?'Pts':'Elo'}</th><th class="th-right">${what==='points'?'World #':'Δ'}</th></tr></thead><tbody>${shown.map((p,i)=>statRow(p,i,what)).join('')||'<tr><td colspan="6">No players yet.</td></tr>'}</tbody></table></div>`;}
function matchRow(m){const a=byP(m.player1_id),b=byP(m.player2_id),t=byT(m.tournament_id),done=isDone(m),wa=won(m);return `<a class="list-row" href="${toPath('match',m.id)}"><div><div class="secondary">${e(t?.name||'Unknown event')} · ${e(m.round)} · BO${n(m.best_of)}</div><div class="primary" style="margin-top:5px">${e(a?.handle||'TBD')} <span style="color:var(--muted);font-weight:500">vs</span> ${e(b?.handle||'TBD')}</div></div><div class="right"><div class="score ${done?'win':''}">${done?`${n(m.score1)} : ${n(m.score2)}`:'VS'}</div><div class="secondary">${done?'Final':'Pending'}</div></div></a>`;}
function eventCard(t){const ms=data.matches.filter(m=>m.tournament_id===t.id),winners=ms.filter(isDone);return `<a class="event-card" data-tier="${e(t.tier)}" href="${toPath('tournament',t.id)}"><div class="event-card-label"><span class="label-sm"><span class="tier-indicator" data-tier="${e(t.tier)}">${e(t.tier)}</span> · SEASON 01</span>${chip(t.status)}</div><h3>${e(t.name)}</h3><p>${participants(t.id).length}/${Number(t.capacity)||8} entrants · ${e(t.format||'Circuit')}</p><div class="event-card-foot"><span>${winners.length} finished · ${ms.length} fixtures</span><span>Explore event →</span></div></a>`;}
function dashboard(){const ongoing=data.tournaments.filter(t=>t.status==='ongoing');const next=[...data.matches].filter(m=>!isDone(m));const previous=[...data.matches].filter(isDone).reverse();const featured=ongoing[0]||data.tournaments.find(t=>t.status==='upcoming')||data.tournaments[0];
 return `${pageHead('Home / Season 01','The circuit starts here','Live rankings, tournament coverage and the road to the season Major.','')}${modeBanner()}<section class="hero"><div class="hero-copy"><span class="eyebrow">${featured?.status==='ongoing'?'● NOW PLAYING':'FEATURED EVENT'}</span><h2>${e(featured?.name||'Your Speed league starts here')}</h2><p>${e(featured?.description||'No events have been created yet. Once an administrator adds players and tournaments, the standings and match archive will appear here.')}</p><a class="btn" href="${featured?toPath('tournament',featured.id):'#/admin'}">${featured?'View tournament →':'Set up league →'}</a></div><div class="hero-art"><div class="big-avatar">SW</div><div class="hero-orbit"></div></div></section><div class="three-stack top-gap"><div class="metric"><div class="label">Ranked competitors</div><div class="value">${data.players.length.toString().padStart(2,'0')}</div><span class="small muted">Season One players</span></div><div class="metric"><div class="label">Completed series</div><div class="value">${previous.length.toString().padStart(2,'0')}</div><span class="small muted">Official match results</span></div><div class="metric"><div class="label">Circuit events</div><div class="value">${data.tournaments.length.toString().padStart(2,'0')}</div><span class="small muted">Past, active and upcoming</span></div></div><div class="feature-layout top-gap"><div class="stack"><section class="panel"><div class="panel-head"><h2>Active & upcoming tournaments</h2><a href="#/tournaments" class="inline-link small">All events →</a></div><div class="event-grid" style="padding:15px;gap:10px">${[...data.tournaments].filter(t=>t.status!=='completed').slice(0,4).map(eventCard).join('')||'<div class="no-results">No upcoming events.</div>'}</div></section><section class="panel"><div class="panel-head"><h2>Recent results</h2><a href="#/matches" class="inline-link small">All matches →</a></div>${previous.slice(0,6).map(matchRow).join('')||'<div class="no-results">No results yet.</div>'}</section></div><div class="stack"><section class="panel"><div class="panel-head"><h2>World rankings</h2><a href="#/rankings" class="inline-link small">Full standings →</a></div>${rankArr().slice(0,5).map((p,i)=>`<a class="list-row" href="${toPath('player',p.id)}"><div class="avatar-cluster"><span class="rank-pill">${i+1}</span>${avatar(p,'mini')}<strong>${e(p.handle)}</strong></div><div class="right"><strong class="accent">${p.rating}</strong><div class="secondary">${n(p.wins)}–${n(p.losses)}</div></div></a>`).join('')||'<div class="no-results">No players yet.</div>'}</section><section class="panel"><div class="panel-head"><h2>Next matches</h2><a href="#/matches" class="inline-link small">Fixtures →</a></div>${next.slice(0,4).map(matchRow).join('')||'<div class="no-results">No unplayed fixtures yet.</div>'}</section><section class="panel"><div class="panel-head"><h2>Championship qualification</h2><a href="#/rankings" class="inline-link small">Points table →</a></div>${pointsArr().slice(0,4).map((p,i)=>`<a class="list-row" href="${toPath('player',p.id)}"><span class="rank-pill">#${i+1}</span><strong style="flex:1">${e(p.handle)}</strong><strong>${p.points} pts</strong></a>`).join('')||'<div class="no-results">No Circuit Points awarded yet.</div>'}</section></div></div>`;}
function rankings(){const isR=ui.ranking==='rating';const ranked=isR?rankArr():pointsArr();return `${pageHead('Competition / Rankings','World rankings','Two distinct rankings: skill (Elo) and season achievement points.')}${modeBanner()}<div class="filterbar"><button data-ranking="rating" class="${isR?'active':''}">Skill rating (Elo)</button><button data-ranking="points" class="${!isR?'active':''}">Season Circuit Points</button></div><section class="panel">${tableTop(ranked,isR?'rating':'points')}</section>${activeChampionshipPanels()}<div class="result-grid top-gap"><div class="panel"><div class="panel-head"><h2>How Elo works</h2></div><div class="panel-body hint muted">Every player begins at 1,000. Ratings use K=32, adjusted by opponent strength and the final score margin. At equal ratings in BO7, 4–0 earns +24 Elo while 4–3 earns +12 Elo. A BO1 uses ordinary Elo. Correcting an earlier result rebuilds subsequent ratings.</div></div><div class="panel"><div class="panel-head"><h2>Championship qualification rules</h2></div><div class="panel-body hint muted">There are two separate eight-player championships: Mid-Season Final and Major. Each receives four projected Circuit Points invites and four qualifiers from its own qualifier event. Points never affect Elo, and later events do not retroactively alter an earlier championship's invitation cutoff.</div></div></div>`;}
function tournaments(){const ts=data.tournaments.filter(t=>(ui.eventFilter==='all'||t.status===ui.eventFilter)&&(ui.typeFilter==='all'||t.tier===ui.typeFilter)).reverse();return `${pageHead('Competition / Events','Tournaments','Six competition classifications. Mid-Season Final and Major follow the same 4-invite + 4-qualifier format.')}${modeBanner()}<section class="type-guide">${TOURNAMENT_TYPES.map(type=>`<button class="type-guide-item ${ui.typeFilter===type?'selected':''}" data-tf="${e(type)}"><span class="tier-indicator" data-tier="${e(type)}">${e(type)}</span><small>${e(TYPE_DETAILS[type])}</small></button>`).join('')}</section><div class="filterbar"><span class="filter-label">STATUS</span>${['all','ongoing','upcoming','completed'].map(x=>`<button class="${ui.eventFilter===x?'active':''}" data-ef="${x}">${x==='all'?'All':x[0].toUpperCase()+x.slice(1)}</button>`).join('')}<span class="filter-label">TYPE</span><button class="${ui.typeFilter==='all'?'active':''}" data-tf="all">All classifications</button></div><div class="event-grid">${ts.map(eventCard).join('')||'<div class="no-results">No tournaments in this classification.</div>'}</div>`;}
function playersPage(){const ps=rankArr().filter(p=>`${p.handle} ${p.name}`.toLowerCase().includes(ui.playerQuery.toLowerCase()));return `${pageHead('Community / Competitors','Player directory','Explore individual player profiles, match records and rating histories.')}${modeBanner()}<div class="filterbar"><input id="player-filter" value="${e(ui.playerQuery)}" placeholder="Filter players by name" aria-label="Filter players" style="border:1px solid var(--line);background:var(--panel);color:var(--text);padding:10px 12px;border-radius:8px;width:min(320px,100%)"></div><div class="profile-grid" id="profiles-list">${ps.map(playerTile).join('')||'<div class="no-results">No matching players.</div>'}</div>`;}
function playerTile(p){return `<a href="${toPath('player',p.id)}" class="profile-card"><div class="profile-card-top">${avatar(p,'large')}<span class="chip">World #${rankArr().findIndex(x=>x.id===p.id)+1}</span></div><h3>${e(p.handle)}</h3><div class="full">${e(p.name)} · ${e(p.title||'Competitor')}</div><div class="rating-line"><span>Rating <strong style="color:#fff;font-size:15px">${p.rating}</strong></span><span>${n(p.wins)}W / ${n(p.losses)}L</span></div></a>`;}
function matchesPage(){const all=[...data.matches].filter(m=>ui.matchFilter==='all'||(ui.matchFilter==='completed'?isDone(m):!isDone(m))).reverse();return `${pageHead('Competition / Results','Matches & results','Official series scores and upcoming fixtures.')}${modeBanner()}<div class="filterbar">${['all','completed','upcoming'].map(x=>`<button class="${ui.matchFilter===x?'active':''}" data-mf="${x}">${x==='all'?'All':x[0].toUpperCase()+x.slice(1)}</button>`).join('')}</div><section class="panel">${all.map(matchRow).join('')||'<div class="no-results">No fixtures found.</div>'}</section>`;}
function chart(p){const hist=p.history?.length?p.history:[1000],lo=Math.min(...hist,970)-25,hi=Math.max(...hist,1030)+25,w=700,h=188,pad=22,pt=hist.map((x,i)=>[pad+(w-2*pad)*i/Math.max(1,hist.length-1),h-pad-(x-lo)/(hi-lo)*(h-2*pad)]);let line=pt.map(x=>x.join(',')).join(' ');return `<div class="chart-wrap"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Rating progression from 1000 to ${p.rating}"><defs><linearGradient id="graphfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#57d4ee" stop-opacity=".25"/><stop offset="100%" stop-color="#57d4ee" stop-opacity="0"/></linearGradient></defs>${[.25,.5,.75].map(x=>`<line x1="${pad}" x2="${w-pad}" y1="${(h*x).toFixed(0)}" y2="${(h*x).toFixed(0)}" stroke="#355064" stroke-dasharray="4 5" />`).join('')}<polygon points="${pad},${h-pad} ${line} ${w-pad},${h-pad}" fill="url(#graphfill)"/><polyline points="${line}" stroke="#62d6ed" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${pt.at(-1)[0]}" cy="${pt.at(-1)[1]}" r="5" fill="#62d6ed"/></svg></div>`;}
function profile(id){const p=byP(id);if(!p)return notFound();const ms=matching(id).reverse();const prizes=data.awards.filter(a=>a.player_id===id).sort((a,b)=>a.placement-b.placement);const total=n(p.wins)+n(p.losses);return `<div class="breadcrumb2"><a href="#/players">Players</a> / ${e(p.handle)}</div><section class="panel" style="padding:24px;background:radial-gradient(circle at 90% 5%,#294b6055,transparent 55%),var(--panel)"><div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">${avatar(p,'xlarge')}<div style="flex:1;min-width:200px"><span class="eyebrow">WORLD #${rankArr().findIndex(x=>x.id===id)+1} · PLAYER PROFILE</span><h1 style="font-size:38px;letter-spacing:-1.3px;margin:4px 0">${e(p.handle)}</h1><div class="muted">${e(p.name)} · ${e(p.title||'Competitive player')}</div></div><div style="text-align:right"><div class="caps">Skill rating</div><div style="font-weight:950;font-size:42px;color:var(--accent)">${p.rating}</div><div class="small" style="color:${p.delta>=0?'var(--mint)':'var(--red)'}">${fmtDelta(p.delta)} last match</div></div></div></section><div class="profile-stats top-gap"><div class="metric"><div class="label">Series wins</div><div class="value">${n(p.wins)}</div></div><div class="metric"><div class="label">Series losses</div><div class="value">${n(p.losses)}</div></div><div class="metric"><div class="label">Win rate</div><div class="value">${total?Math.round(n(p.wins)*100/total):0}%</div></div><div class="metric"><div class="label">Circuit points</div><div class="value">${p.points}</div></div></div><div class="feature-layout top-gap"><div class="stack"><section class="panel"><div class="panel-head"><h2>Elo history</h2><span class="caps">${p.history?.length-1||0} rated appearances</span></div><div class="panel-body">${chart(p)}</div></section><section class="panel"><div class="panel-head"><h2>Match history</h2><span class="caps">${ms.length} fixtures</span></div>${ms.map(matchRow).join('')||'<div class="no-results">No matches played yet.</div>'}</section></div><div class="stack"><section class="panel"><div class="panel-head"><h2>Player statistics</h2></div><div class="panel-body"><div class="meta-grid" style="grid-template-columns:1fr 1fr"><div><div class="caps">Games won</div><strong>${n(p.round_wins)}</strong></div><div><div class="caps">Games lost</div><strong>${n(p.round_losses)}</strong></div><div><div class="caps">Game diff.</div><strong>${n(p.round_wins)-n(p.round_losses)}</strong></div><div><div class="caps">Season rank</div><strong>#${pointsArr().findIndex(x=>x.id===id)+1}</strong></div></div></div></section><section class="panel"><div class="panel-head"><h2>Tournament achievements</h2></div>${prizes.map(a=>`<a class="list-row" href="${toPath('tournament',a.tournament_id)}"><div><strong>${e(byT(a.tournament_id)?.name||'Event')}</strong><div class="secondary">Placement #${n(a.placement)}</div></div><span class="accent"><strong>+${n(a.points)} pts</strong></span></a>`).join('')||'<div class="no-results">No placement awards yet.</div>'}</section></div></div>`;}
/* V5.3 — real tournament diagrams. All connections are visual paths between
   fixtures. No fictitious result or automatic bracket advancement is written. */
function roundKey(value){return String(value||'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
function gslRole(round){const r=roundKey(round);if(/\b(opening|openers|opening round|initial match)\b/.test(r))return 'opening';if(/\b(winners match|winner match|upper match)\b/.test(r))return 'winners';if(/\b(elimination match|elimination round|losers match|loser match)\b/.test(r))return 'elimination';if(/\b(decider|deciding match|deciding round)\b/.test(r))return 'decider';return null;}
function isKnockoutRound(round){return /\b(quarterfinals?|semifinals?|grand final|finals?|playoffs?|round of \d+|upper bracket|lower bracket|winners? bracket|losers? bracket|upper round|lower round)\b/i.test(String(round||''));}
function bracketTile(m,number=1){
 const done=m&&isDone(m),winner=done?won(m):null;
 const side=(playerId,score)=>{const p=byP(playerId),wonSide=done&&winner===playerId,loss=done&&winner!==playerId;
  return `<div class="tree-side ${wonSide?'tree-won':''} ${loss?'tree-lost':''}"><span class="tree-side-accent"></span><span class="tree-player-mark" style="--mark:${e(p?.color||'#53667b')}">${e(p?.handle?.slice(0,1).toUpperCase()||'?')}</span><span class="tree-player-name">${e(p?.handle||'TBD')}</span><span class="tree-score">${done?Number(score):'–'}</span></div>`;};
 const body=`<span class="tree-card-top"><span class="tree-match-id">${m?'MATCH '+String(number).padStart(2,'0'):'UNANNOUNCED'}</span><span class="tree-bo">${m?'BO'+Number(m.best_of||5):'TBD'}</span></span>${side(m?.player1_id,m?.score1)}${side(m?.player2_id,m?.score2)}`;
 return m?`<a class="tree-match" href="${toPath('match',m.id)}" aria-label="${e(labelP(m.player1_id))} versus ${e(labelP(m.player2_id))}">${body}</a>`:`<div class="tree-match tree-placeholder">${body}</div>`;
}
function wire(d,kind='advance'){return `<path d="${d}" class="tree-wire ${kind==='drop'?'tree-wire-drop':'tree-wire-advance'}"/>`;}
function ortho(x1,y1,x2,y2,turn){const mid=turn??Math.round((x1+x2)/2);return `M${x1} ${y1} H${mid} V${y2} H${x2}`;}
function bracketDiagram({heading,caption,width,height,nodes,paths,legend=false}){
 const svg=`<svg class="tree-wires" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><defs><marker id="tree-arrow-win" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L6 3 L0 6" fill="none" stroke="#65d5e9" stroke-width="1.5"/></marker><marker id="tree-arrow-drop" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L6 3 L0 6" fill="none" stroke="#ce8f8c" stroke-width="1.5"/></marker></defs>${paths.join('')}</svg>`;
 const headers=nodes.filter(x=>x.kind==='heading').map(x=>`<div class="tree-stage-title" style="left:${x.x}px;top:${x.y}px;width:${x.w||260}px"><span class="tree-stage-index">${e(x.index||'')}</span>${e(x.label)}</div>`).join('');
 const cards=nodes.filter(x=>x.kind==='card').map(x=>`<div class="tree-node" style="left:${x.x}px;top:${x.y}px;width:264px">${bracketTile(x.match,x.number)}</div>`).join('');
 return `<section class="tree-section"><div class="tree-section-heading"><div><h3>${e(heading)}</h3>${caption?`<p>${e(caption)}</p>`:''}</div>${legend?'<span class="tree-legend"><i class="tree-line-key"></i> Winner advances <i class="tree-line-key drop"></i> Elimination path</span>':''}</div><div class="tree-scroll" tabindex="0" role="region" aria-label="${e(heading)} bracket, scroll horizontally to view all rounds"><div class="tree-canvas" style="width:${width}px;height:${height}px">${svg}${headers}${cards}</div></div></section>`;
}
function gslBracket(group,heading){const W=1086,H=582;const X=[30,397,764];const nodes=[
  {kind:'heading',x:X[0],y:24,label:'Opening round',index:'01'},
  {kind:'heading',x:X[1],y:24,label:"Winners’ match",index:'02'},
  {kind:'heading',x:X[1],y:280,label:'Elimination match',index:'03'},
  {kind:'heading',x:X[2],y:280,label:'Decider match',index:'04'},
  {kind:'card',x:X[0],y:83,match:group.opening[0],number:1},
  {kind:'card',x:X[0],y:307,match:group.opening[1],number:2},
  {kind:'card',x:X[1],y:115,match:group.winners,number:3},
  {kind:'card',x:X[1],y:355,match:group.elimination,number:4},
  {kind:'card',x:X[2],y:355,match:group.decider,number:5}
 ];
 // Winner and elimination routes are deliberately separate, as in a GSL group.
 const paths=[
  wire(ortho(294,149,397,178,337)),wire(ortho(294,373,397,178,355)),
  wire(ortho(294,162,397,404,320),'drop'),wire(ortho(294,386,397,404,361),'drop'),
  wire(ortho(661,178,764,406,708),'drop'),wire(ortho(661,418,764,435,708)),
 ];
 return bracketDiagram({heading,caption:'Opening winners meet above; opening losers play the elimination match. The remaining players meet in the decider.',width:W,height:H,nodes,paths,legend:true});
}
function roundWeight(name){const r=roundKey(name);if(/round of 32|round 1|quarter|round of 8/.test(r))return 1;if(/round of 16|round 2/.test(r))return 2;if(/semi/.test(r))return 3;if(/third place/.test(r))return 4;if(/grand final|championship match|^final$| finals$|upper final|lower final/.test(r))return 5;const nr=r.match(/(?:round|stage) (\d+)/);return nr?10+Number(nr[1]):15;}
function knockoutBracket(matches,heading='Playoff bracket'){
 const groups=new Map();for(const m of matches){const k=m.round||'Playoffs';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(m);}
 const rounds=[...groups].sort((a,b)=>roundWeight(a[0])-roundWeight(b[0]));
 // Match order is the order in which admin created the fixtures. Pair adjacent
 // feeders when the next round has exactly half as many matches.
 const CW=264,CG=103,LEFT=30,STEP=154,TOP=88,CARDH=110;
 const maxN=Math.max(...rounds.map(r=>r[1].length));const H=Math.max(380,TOP+(maxN-1)*STEP+CARDH+82),W=Math.max(720,LEFT+rounds.length*(CW+CG)+22);
 const nodes=[],paths=[],previous=[];
 for(let col=0;col<rounds.length;col++){
  const [name,ms]=rounds[col],x=LEFT+col*(CW+CG),prior=previous[col-1];
  const coordinates=[];
  for(let i=0;i<ms.length;i++){
   let y;if(col===0)y=TOP+i*STEP;
   else if(prior&&prior.length===ms.length*2){const prevA=prior[i*2],prevB=prior[i*2+1];y=(prevA.y+prevB.y)/2;}
   else y=TOP+((maxN-1)*STEP)/2-((ms.length-1)*STEP)/2+i*STEP;
   coordinates.push({x,y,match:ms[i]});nodes.push({kind:'card',x,y,match:ms[i],number:i+1});
  }
  nodes.push({kind:'heading',x,y:26,index:String(col+1).padStart(2,'0'),label:name,w:CW});
  if(prior){const dest=coordinates;
   if(prior.length===dest.length*2){for(let i=0;i<dest.length;i++)for(let j=0;j<2;j++){const start=prior[i*2+j];paths.push(wire(ortho(start.x+CW,start.y+61,dest[i].x,dest[i].y+61,start.x+CW+53)));}}
   else { // Only show identity-verified links for irregular bracket sizes.
    for(const from of prior){const winner=from.match&&won(from.match);if(!winner)continue;const target=dest.filter(to=>to.match&&(to.match.player1_id===winner||to.match.player2_id===winner));if(target.length===1)paths.push(wire(ortho(from.x+CW,from.y+61,target[0].x,target[0].y+61)));}
   }
  }
  previous.push(coordinates);
 }
 const caption='Paths show standard bracket pairings when the round size halves; irregular rounds connect only confirmed advancing winners.';
 return bracketDiagram({heading,caption,width:W,height:H,nodes,paths});
}
function doubleElimGroupBracket(fixtures,heading,perGroup){
 const large=perGroup>=8,W=large?1548:880,H=large?1010:610;
 const X=large?[30,398,766,1134]:[30,435];
 const spec=large?[
  ['opening','Opening round',X[0],[105,269,433,597]],
  ['upperSemi','Upper semis',X[1],[187,515]],
  ['upperFinal','Upper final',X[2],[351]],
  ['lowerRound','Lower round',X[1],[763,907]],
  ['lowerSemi','Lower semis',X[2],[763,907]],
  ['lowerFinal','Lower final',X[3],[835]]
 ]:[
  ['opening','Opening round',X[0],[106,342]],
  ['upperFinal','Upper final',X[1],[145]],
  ['lowerFinal','Lower final',X[1],[388]]
 ];
 const grouped={},used=new Set(),nodes=[],paths=[],pos={};
 for(const m of fixtures){const role=groupRoundRole(m.round);if(role)(grouped[role]??=[]).push(m);}
 const headerY=large?32:34;
 for(let si=0;si<spec.length;si++){
  const [role,label,x,ys]=spec[si];pos[role]=[];
  nodes.push({kind:'heading',x,y:role.startsWith('lower')?(large?704:330):headerY,w:264,label,index:String(si+1).padStart(2,'0')});
  for(let i=0;i<ys.length;i++){
   const m=grouped[role]?.[i]||null;if(m)used.add(m.id);
   const entry={x,y:ys[i],match:m};pos[role].push(entry);
   nodes.push({kind:'card',x,y:ys[i],match:m,number:i+1});
  }
 }
 const connect=(a,b,kind='advance')=>{if(a&&b)paths.push(wire(ortho(a.x+264,a.y+61,b.x,b.y+61,a.x+304),kind));};
 const linkPairs=(sources,targets,kind='advance')=>{
  if(!sources||!targets)return;
  sources.forEach((a,i)=>connect(a,targets[Math.min(targets.length-1,Math.floor(i/2))],kind));
 };
 if(large){
  linkPairs(pos.opening,pos.upperSemi);
  linkPairs(pos.opening,pos.lowerRound,'drop');
  linkPairs(pos.upperSemi,pos.upperFinal);
  pos.upperSemi.forEach((x,i)=>connect(x,pos.lowerSemi[i],'drop'));
  pos.lowerRound.forEach((x,i)=>connect(x,pos.lowerSemi[i]));
  linkPairs(pos.lowerSemi,pos.lowerFinal);
 }else{
  linkPairs(pos.opening,pos.upperFinal);
  linkPairs(pos.opening,pos.lowerFinal,'drop');
 }
 const subtitle=large
  ?'8-player group structure: Opening → Upper Semis → Upper Final; Lower Round → Lower Semis → Lower Final.'
  :'4-player group structure: Opening → Upper Final, with an elimination route to Lower Final.';
 let html=bracketDiagram({heading,caption:subtitle+' Bracket paths are visual; assign advancing competitors in Admin.',width:W,height:H,nodes,paths,legend:true}).replace('<section class="tree-section">','<section class="tree-section group-elim-section">');
 const extras=fixtures.filter(m=>!used.has(m.id));
 if(extras.length)html+=stageLanes(extras,heading+' · Additional matches','Additional or custom rounds stay visible rather than being dropped from the bracket.');
 return html;
}
function groupedDoubleElim(matches,t){
 const sections=[],count=groupCount(t),perGroup=Math.ceil((Number(t.capacity)||8)/count);
 for(const section of (count===2?['A','B']:['A'])){
  const ms=matches.filter(m=>matchSection(m)===section);
  sections.push(doubleElimGroupBracket(ms,`GROUP ${section} · DOUBLE ELIMINATION`,perGroup));
 }
 const playoffs=matches.filter(m=>matchSection(m)==='playoffs');
 if(playoffs.length){
  const knock=playoffs.filter(m=>isKnockoutRound(m.round)||isPlacementRound(m.round)),regular=playoffs.filter(m=>!isKnockoutRound(m.round)&&!isPlacementRound(m.round));
  if(knock.length)sections.push(knockoutBracket(knock,'PLAYOFFS · CHAMPIONSHIP BRACKET'));
  if(regular.length)sections.push(stageLanes(regular,'PLAYOFFS · OTHER ROUNDS','These fixtures are assigned to Playoffs but have custom round names.'));
 }else sections.push(`<section class="tree-section"><div class="tree-section-heading"><div><h3>PLAYOFFS</h3><p>No playoff matchups have been announced yet.</p></div></div></section>`);
 return `<div class="connected-brackets grouped-elimination">${sections.join('')}</div>`;
}
// V5.5 — Record-based Swiss progression. The paths show record movement, never
// make up future opponents or fixtures. Matches come from the nine admin round names.
function swissRoundRecord(round){
 const normalized=String(round||'').trim().replace(/\s+Swiss$/i,'').replace(/\s+/g,'');
 return SWISS_RECORDS.includes(normalized)?normalized:null;
}
function swissResultBuckets(fixtures,size=16){
 const small=size===8;
 const out=small?{'2:0':[],'2:1':[],'0:2':[],'1:2':[]}:{'3:0':[],'3:1':[],'3:2':[],'0:3':[],'1:3':[],'2:3':[]};
 const finalRounds=small?{'1:0':['2:0',null],'0:1':[null,'0:2'],'1:1':['2:1','1:2']}:{'2:0':['3:0',null],'0:2':[null,'0:3'],'2:1':['3:1',null],'1:2':[null,'1:3'],'2:2':['3:2','2:3']};
 for(const m of fixtures){
  const r=swissRoundRecord(m.round),keys=finalRounds[r];
  if(!keys||!isDone(m))continue;
  const winner=won(m),loser=winner===m.player1_id?m.player2_id:m.player1_id;
  if(keys[0]&&winner)out[keys[0]].push(winner);
  if(keys[1]&&loser)out[keys[1]].push(loser);
 }
 return out;
}
function swissBracket(fixtures,t){
 const size=swissSize(t),small=size===8;
 const CARDW=137,CARDH=43,W=825,H=small?605:714;
 const columns=small?[15,185,360]:[15,173,331,489,647];
 const outcomeX=small?535:489,outcomeW=small?276:317;
 const placements=small?{
  '0:0':{x:0,y:117,count:4,step:108},
  '1:0':{x:1,y:140,count:2,step:87},
  '0:1':{x:1,y:362,count:2,step:84},
  '1:1':{x:2,y:278,count:2,step:80}
 }:{
  '0:0':{x:0,y:107,count:8,step:59},
  '1:0':{x:1,y:75,count:4,step:68},'0:1':{x:1,y:351,count:4,step:60},
  '2:0':{x:2,y:70,count:2,step:57},'1:1':{x:2,y:234,count:4,step:62},'0:2':{x:2,y:506,count:2,step:58},
  '2:1':{x:3,y:165,count:3,step:57},'1:2':{x:3,y:359,count:3,step:56},'2:2':{x:4,y:285,count:3,step:52}
 };
 const greenY=small?15:11,redY=small?475:595;
 const records=small?SWISS_RECORDS_EIGHT:SWISS_RECORDS;
 const grouped=Object.fromEntries(records.map(r=>[r,[]])),other=[];
 for(const m of fixtures){const r=swissRoundRecord(m.round);if(r&&Object.hasOwn(grouped,r))grouped[r].push(m);else other.push(m);}
 const blocks=[],paths=[];
 const transitions=small?[
  ['0:0','1:0','win'],['0:0','0:1','lose'],
  ['1:0','2:0','win'],['1:0','1:1','lose'],
  ['0:1','1:1','win'],['0:1','0:2','lose'],
  ['1:1','2:1','win'],['1:1','1:2','lose']
 ]:[
  ['0:0','1:0','win'],['0:0','0:1','lose'],
  ['1:0','2:0','win'],['1:0','1:1','lose'],
  ['0:1','1:1','win'],['0:1','0:2','lose'],
  ['2:0','3:0','win'],['2:0','2:1','lose'],
  ['1:1','2:1','win'],['1:1','1:2','lose'],
  ['0:2','1:2','win'],['0:2','0:3','lose'],
  ['2:1','3:1','win'],['2:1','2:2','lose'],
  ['1:2','2:2','win'],['1:2','1:3','lose'],
  ['2:2','3:2','win'],['2:2','2:3','lose']
 ];
 const endRecords=small?{'2:0':0,'2:1':1,'0:2':0,'1:2':1}:{'3:0':0,'3:1':1,'3:2':2,'0:3':0,'1:3':1,'2:3':2};
 const pos=r=>{
  if(placements[r]){const b=placements[r];return{x:columns[b.x],y:b.y+(b.count-1)*b.step/2+CARDH/2};}
  const n=small?2:3;
  return{x:outcomeX+endRecords[r]*(outcomeW/n)+(outcomeW/(2*n)),y:(r.startsWith(small?'2:':'3:')?greenY:redY)+53};
 };
 // Aggregate record progression: colored lines do not pretend to be
 // individual-player pairings that have not been announced.
 for(const [from,to,route] of transitions){const a=pos(from),b=pos(to),x1=a.x+CARDW+3,x2=b.x-6;
  if(x2>x1+11){const mid=x1+(x2-x1)*.52;
   paths.push(`<path class="swiss-wire ${route==='win'?'swiss-win':'swiss-loss'}" d="M${x1} ${a.y} H${mid} V${b.y} H${x2}"/>`);
  }
 }
 function mark(p,loser=false){
  const color=e(p?.color||'#526b7b'),handle=String(p?.handle||'?'),letter=e(handle.length>1?(handle[0]+handle[handle.length-1]).toUpperCase():handle.toUpperCase());
  return `<span class="swiss-mark${loser?' is-loser':''}${!p?' is-pending':''}" style="--swiss-color:${color}" aria-hidden="true">${letter}</span>`;
 }
 const outcome=swissResultBuckets(fixtures,size);
 for(const r of records){const b=placements[r],ms=grouped[r],slots=Math.max(b.count,ms.length);
  const rowNodes=[];
  for(let i=0;i<slots;i++){
   const m=ms[i];let card;
   if(!m){card=`<div class="swiss-fixture swiss-fixture-empty" aria-label="Unannounced Swiss match">${mark(null)}<span class="swiss-vs">VS</span>${mark(null)}</div>`;}
   else{
    const a=byP(m.player1_id),c=byP(m.player2_id),w=won(m),done=isDone(m);
    const score=done?`${m.score1}–${m.score2}`:'Pending';
    card=`<a class="swiss-fixture" href="${toPath('match',m.id)}" title="${e(a?.handle||'TBD')} vs ${e(c?.handle||'TBD')} · ${e(r)} · ${e(score)}" aria-label="${e(r)}: ${e(a?.handle||'TBD')} versus ${e(c?.handle||'TBD')}, ${e(score)}">${mark(a,done&&w!==m.player1_id)}<span class="swiss-vs">VS</span>${mark(c,done&&w!==m.player2_id)}${done?`<span class="swiss-score-hint">${e(score)}</span>`:''}</a>`;
   }
   rowNodes.push(`<div style="position:absolute;top:${b.y+i*b.step}px;left:${columns[b.x]}px;width:${CARDW}px">${card}</div>`);
  }
  blocks.push(`<div class="swiss-stage-title" style="left:${columns[b.x]}px;top:${b.y-19}px">${e(r)}</div>${rowNodes.join('')}`);
 }
 function outcomeBand(finalRecords,qualified,y){
  return `<div class="swiss-result-band ${qualified?'is-qualified':'is-eliminated'}" style="left:${outcomeX}px;top:${y}px;width:${outcomeW}px;grid-template-columns:repeat(${finalRecords.length},minmax(0,1fr))" role="group" aria-label="${qualified?'Qualified':'Eliminated'} Swiss results">${finalRecords.map(r=>{
   const ids=[...new Set(outcome[r])];
   const icons=ids.length?ids.map(id=>`<a href="${toPath('player',id)}" title="${e(labelP(id))}" aria-label="${e(labelP(id))}">${mark(byP(id))}</a>`).join(''):`<span title="Not decided yet">${mark(null)}</span>`;
   return `<div class="swiss-result-cell"><b>${r}</b><div class="swiss-result-icons">${icons}</div></div>`;
  }).join('')}</div>`;
 }
 const svg=`<svg class="swiss-lines" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${paths.join('')}</svg>`;
 const active=fixtures.filter(m=>records.includes(swissRoundRecord(m.round))).length;
 const guidance=small?'2 wins to qualify · 2 losses to be eliminated':'3 wins to qualify · 3 losses to be eliminated';
 const wins=small?['2:0','2:1']:['3:0','3:1','3:2'];
 const losses=small?['0:2','1:2']:['0:3','1:3','2:3'];
 let html=`<section class="tree-section swiss-section"><div class="tree-section-heading"><div><h3>${size}-PLAYER SWISS STAGE</h3><p>${guidance} · ${active} fixtures · Hover over a match for names and score.</p></div><span class="swiss-legend"><i class="swiss-key win"></i> Winner route <i class="swiss-key loss"></i> Loser route</span></div><div class="tree-scroll swiss-scroll" role="region" aria-label="${size}-player Swiss bracket, scroll horizontally if needed" tabindex="0"><div class="swiss-canvas" style="width:${W}px;height:${H}px">${svg}${blocks.join('')}${outcomeBand(wins,true,greenY)}${outcomeBand(losses,false,redY)}</div></div></section>`;
 if(other.length)html+=stageLanes(other,'Swiss stage · Legacy / other rounds','These fixtures are preserved but are not part of this Swiss format. For 8 players, use 0:0, 1:0, 0:1, or 1:1 Swiss.');
 return html;
}
function swissTournamentBracket(fixtures,t){
 const sw=fixtures.filter(m=>matchSection(m)==='A'),playoffs=fixtures.filter(m=>matchSection(m)==='playoffs'||matchSection(m)==='B');
 let result=swissBracket(sw,t);
 if(playoffs.length){const bracketMs=playoffs.filter(m=>isKnockoutRound(m.round)||isPlacementRound(m.round));const custom=playoffs.filter(m=>!bracketMs.includes(m));
  if(bracketMs.length)result+=knockoutBracket(bracketMs,'PLAYOFFS · CHAMPIONSHIP BRACKET');
  if(custom.length)result+=stageLanes(custom,'PLAYOFFS · OTHER MATCHES');
 }else result+=`<section class="tree-section"><div class="tree-section-heading"><div><h3>PLAYOFFS</h3><p>Awaiting playoff match announcements.</p></div></div></section>`;
 return `<div class="connected-brackets swiss-connected">${result}</div>`;
}
function stageLanes(matches, heading='League / group rounds', description='Matches are grouped by their stage. Swiss and round-robin results have no fixed winner-to-next-match path.'){const rounds=new Map();for(const m of matches){if(!rounds.has(m.round))rounds.set(m.round,[]);rounds.get(m.round).push(m);}
 return `<section class="tree-section tree-lanes"><div class="tree-section-heading"><div><h3>${e(heading)}</h3><p>${e(description)}</p></div></div><div class="tree-lane-scroll"><div class="tree-lane-grid">${[...rounds].map(([name,fixtures],col)=>`<section class="tree-lane"><h4><span class="tree-stage-index">${String(col+1).padStart(2,'0')}</span>${e(name)}</h4>${fixtures.map((m,i)=>bracketTile(m,i+1)).join('')}</section>`).join('')}</div></div></section>`;
}
function bracket(matches,tournament=null){
 if(swissSize(tournament)>0)return swissTournamentBracket(matches,tournament);
 if(groupCount(tournament)>0)return groupedDoubleElim(matches,tournament);
 if(!matches.length)return `<div class="tree-empty"><span class="tree-empty-icon">◇</span><h3>The bracket isn't announced yet</h3><p>Registered players are visible above. As an admin adds fixtures, the bracket will build itself here.</p></div>`;
 // Use the existing hidden timestamps to keep match-slot order stable across reloads.
 const sorted=[...matches].sort((a,b)=>new Date(a.scheduled_at||a.created_at||0)-new Date(b.scheduled_at||b.created_at||0)||String(a.id).localeCompare(String(b.id)));
 const used=new Set(),sections=[];
 const gslGroups=new Map();
 for(const m of sorted){
  const role=gslRole(m.round);if(!role)continue;
  const tag=String(m.round||'').match(/\b(?:group|pool)\s*([a-z0-9]+)\b/i);
  const key=tag?tag[1].toUpperCase():'default';
  if(!gslGroups.has(key))gslGroups.set(key,{opening:[],winners:[],elimination:[],decider:[]});
  gslGroups.get(key)[role].push(m);
 }
 const gslConfigured=/\bgsl\b/i.test(tournament?.format||'');
 for(const [key,buckets] of gslGroups){
  const hasGslRounds=buckets.opening.length>0&&(buckets.winners.length>0||buckets.elimination.length>0||buckets.decider.length>0);
  const count=(gslConfigured||hasGslRounds)?Math.max(1,Math.ceil(buckets.opening.length/2),buckets.winners.length,buckets.elimination.length,buckets.decider.length):0;
  for(let i=0;i<count;i++){
   const group={opening:buckets.opening.slice(2*i,2*i+2),winners:buckets.winners[i],elimination:buckets.elimination[i],decider:buckets.decider[i]};
   [...group.opening,group.winners,group.elimination,group.decider].filter(Boolean).forEach(m=>used.add(m.id));
   const title=key!=='default'?`Group ${key}${count>1?` · Bracket ${i+1}`:''}`:count>1?`Group ${i+1} · GSL bracket`:'GSL group · connected bracket';
   sections.push(gslBracket(group,title));
  }
 }
 const leftovers=sorted.filter(m=>!used.has(m.id));
 const formatKnockout=/\b(playoff|knockout|single.elimination|double.elimination|bracket)\b/i.test(tournament?.format||'');
 const isBracketFixture=m=>isKnockoutRound(m.round)||(formatKnockout&&/^(round|r)\s*\d+$/i.test(String(m.round||'').trim()));
 const placement=leftovers.filter(m=>isPlacementRound(m.round));
 const knockout=leftovers.filter(m=>isBracketFixture(m)&&!placement.includes(m)),regular=leftovers.filter(m=>!isBracketFixture(m)&&!placement.includes(m));
 if(knockout.length){
  const upper=knockout.filter(m=>/\b(upper|winners? bracket)\b/i.test(m.round)),lower=knockout.filter(m=>/\b(lower|losers? bracket)\b/i.test(m.round));
  const other=knockout.filter(m=>!upper.includes(m)&&!lower.includes(m));
  if(upper.length&&lower.length){sections.push(knockoutBracket(upper,'Upper bracket'));sections.push(knockoutBracket(lower,'Lower bracket'));if(other.length)sections.push(knockoutBracket(other,'Finals & placement matches'));}
  else sections.push(knockoutBracket([...knockout,...placement]));
 }
 if(placement.length&&!knockout.length)sections.push(stageLanes(placement,'Placement matches','Placement fixtures are shown here until a playoff bracket exists.'));
 if(regular.length)sections.push(stageLanes(regular));
 return `<div class="connected-brackets">${sections.join('')}</div>`;
}
function rosterBlock(t){
 const roster=participants(t.id),open=openSeats(t);
 const names=roster.map((p,i)=>`<a class="roster-slot filled" href="${toPath('player',p.id)}"><span class="roster-index">${String(i+1).padStart(2,'0')}</span>${avatar(p,'mini')}<span class="roster-handle">${e(p.handle)}<small>${e(p.name)}</small></span><span class="roster-tag">CONFIRMED</span></a>`);
 for(let i=0;i<open;i++)names.push(`<div class="roster-slot vacant"><span class="roster-index">${String(roster.length+i+1).padStart(2,'0')}</span><span class="tbd-avatar">?</span><span class="roster-handle">TBD<small>Open slot</small></span><span class="roster-tag">AVAILABLE</span></div>`);
 return `<section class="panel roster-panel"><div class="panel-head"><h2>Registered players</h2><span class="caps">${roster.length}/${Number(t.capacity)||8} confirmed · ${open} open</span></div><div class="roster-grid">${names.join('')||'<div class="no-results">No slots configured.</div>'}</div>${isAdmin?`<div class="roster-footer"><a class="inline-link" href="#/admin" data-roster-manage="${e(t.id)}">Manage tournament roster →</a></div>`:''}</section>`;
}
function tournamentPage(id){const t=byT(id);if(!t)return notFound();const ms=data.matches.filter(m=>m.tournament_id===id);const awards=data.awards.filter(a=>a.tournament_id===id).sort((a,b)=>a.placement-b.placement);
return `<div class="breadcrumb2"><a href="#/tournaments">Tournaments</a> / ${e(t.name)}</div><section class="hero" style="min-height:215px"><div class="hero-copy"><div class="eyebrow">${e(t.tier.toUpperCase())} · ${e(t.status.toUpperCase())}</div><h2>${e(t.name)}</h2><p>${e(t.description||'Competitive Speed card event')}</p></div><div class="hero-art"><div class="big-avatar">${t.tier==='Major'?'M':t.tier==='Mid-Season Final'?'MS':'SW'}</div></div></section><div class="meta-grid top-gap"><div><span class="caps">Entrants</span><strong>${participants(t.id).length} / ${Number(t.capacity)||8}</strong></div><div><span class="caps">Format</span><strong>${e(t.format||'Open')}</strong></div><div><span class="caps">Status</span><strong>${e(t.status)}</strong></div><div><span class="caps">Fixtures</span><strong>${ms.length}</strong></div></div><div class="top-gap">${rosterBlock(t)}</div>${tournamentQualificationSection(t.tier)}<section class="panel top-gap bracket-main-panel"><div class="panel-head"><div><h2>Interactive tournament bracket</h2><p class="bracket-subhead">${(groupCount(t)||swissSize(t))?stageName(t)+' + playoffs':'Follow the matches, paths and results from round to round'}</p></div><span class="caps">${ms.filter(isDone).length} / ${ms.length} finished</span></div>${bracket(ms,t)}</section><div class="feature-layout top-gap"><div class="stack"><section class="panel"><div class="panel-head"><h2>All event matches</h2></div>${ms.map(matchRow).join('')||'<div class="no-results">Matchups have not been announced. Registered players appear above.</div>'}</section></div><div class="stack"><section class="panel"><div class="panel-head"><h2>Placements & points</h2></div>${awards.map(a=>`<div class="list-row"><span class="rank-pill">#${n(a.placement)}</span><div style="flex:1">${playerInline(byP(a.player_id))}</div><strong class="accent">+${n(a.points)} pts</strong></div>`).join('')||'<div class="no-results">Points have not been awarded yet.</div>'}</section><section class="panel"><div class="panel-head"><h2>Other tournaments</h2></div>${[...data.tournaments].filter(x=>x.id!==id).slice(0,5).map(x=>`<a class="list-row" href="${toPath('tournament',x.id)}"><div class="primary">${e(x.name)}</div>${chip(x.status)}</a>`).join('')}</section></div></div>`;
}

function matchPage(id){const m=byM(id);if(!m)return notFound();const a=byP(m.player1_id),b=byP(m.player2_id),t=byT(m.tournament_id);const hs=data.matches.filter(x=>isDone(x)&&m.player1_id&&m.player2_id&&[x.player1_id,x.player2_id].includes(m.player1_id)&&[x.player1_id,x.player2_id].includes(m.player2_id));
 const side=p=>p?`<a href="${toPath('player',p.id)}">${avatar(p,'xlarge')}<h2>${e(p.handle)}</h2></a>`:`<div class="tbd-side"><span class="tbd-avatar large">?</span><h2>TBD</h2></div>`;
 return `<div class="breadcrumb2"><a href="#/matches">Matches</a> / <a href="${toPath('tournament',m.tournament_id)}">${e(t?.name)}</a> / ${e(m.round)}</div>${pageHead(e(t?.name||'Event'),m.round,`BO${m.best_of} · ${isDone(m)?'Final result':'Matchup pending'}`)}<section class="panel" style="padding:24px"><div style="display:flex;align-items:center;justify-content:space-around;text-align:center;gap:16px;flex-wrap:wrap">${side(a)}<div><div class="caps">${isDone(m)?'FINAL RESULT':'AWAITING RESULT'}</div><div style="font-size:46px;font-weight:950;letter-spacing:-1px">${isDone(m)?`${m.score1} : ${m.score2}`:'VS'}</div><span class="chip">BO${m.best_of}</span></div>${side(b)}</div><hr class="divider-light"/><div class="meta-grid"><div><span class="caps">Winner</span><strong>${won(m)?e(labelP(won(m))):'TBD'}</strong></div><div><span class="caps">Round</span><strong>${e(m.round)}</strong></div><div><span class="caps">Tournament</span><strong>${e(t?.name||'Event')}</strong></div><div><span class="caps">Status</span><strong>${isDone(m)?'Final':'Pending'}</strong></div></div></section><div class="panel top-gap"><div class="panel-head"><h2>Head-to-head history</h2></div><div class="panel-body"><div class="meta-grid" style="grid-template-columns:1fr 1fr"><div><div class="caps">${e(a?.handle||'TBD')} wins</div><strong>${hs.filter(x=>won(x)===m.player1_id).length}</strong></div><div><div class="caps">${e(b?.handle||'TBD')} wins</div><strong>${hs.filter(x=>won(x)===m.player2_id).length}</strong></div></div></div></div>`;
}

function notFound(){return `${pageHead('Error / 404','Not found','This record was not found in the league database.')}<a class="btn" href="#/overview">Back to overview</a>`;}
function optionList(items,sel,lab,empty='Choose one…'){return `<option value="">${e(empty)}</option>${items.map(item=>`<option value="${e(item.id)}" ${String(sel)===String(item.id)?'selected':''}>${e(lab(item))}</option>`).join('')}`;}
const formField=(id,label,val='',type='text',extra='')=>`<div class="field"><label for="${id}">${e(label)}</label><input id="${id}" name="${id}" type="${type}" value="${e(val)}" ${extra}></div>`;
function recordDependents(kind,id){
 return {
  matches:data.matches.filter(m=>kind==='player'?(m.player1_id===id||m.player2_id===id):m.tournament_id===id).length,
  awards:data.awards.filter(a=>kind==='player'?a.player_id===id:a.tournament_id===id).length,
  registrations:data.registrations.filter(r=>kind==='player'?r.player_id===id:r.tournament_id===id).length
 };
}
function deleteButton(kind,id,label){
 return `<button type="button" class="btn-danger" data-delete="${kind}" data-id="${e(id)}" aria-label="Delete ${e(kind)} ${e(label)}">Delete</button>`;
}
function playerForm(){
 const p=ui.editing?.type==='player'?byP(ui.editing.id):null;
 return `<section class="panel"><div class="panel-head"><h2>${p?'Edit player':'Add competitor'}</h2>${p?'<button class="btn-alt" data-cancel-edit>Cancel edit</button>':''}</div><div class="panel-body"><form id="player-form" class="form-grid">${formField('p_id','Player ID (URL slug)',p?.id||'','text',p?'readonly required':'required pattern="[a-z0-9-]{2,40}" placeholder="e.g. leo"')}${formField('p_handle','Handle',p?.handle||'','text','required maxlength="24"')}${formField('p_name','Display name',p?.name||'','text','required maxlength="60"')}${formField('p_title','Player title',p?.title||'','text','maxlength="70"')}${formField('p_color','Avatar color',p?.color||'#4b9fbc','color','required')}<div class="field full"><div class="button-row"><button type="submit" class="btn">${p?'Update player':'Create player'}</button>${p?deleteButton('player',p.id,p.handle):''}</div></div></form></div></section><section class="panel top-gap"><div class="panel-head"><h2>Player registry</h2><span class="caps">${data.players.length} players</span></div><div class="panel-body"><div class="notice">Deleting a player permanently removes their matches and placement awards. All remaining ratings, records, and circuit points are recalculated. Export a backup first.</div></div>${rankArr().map(p=>{const d=recordDependents('player',p.id);return `<div class="list-row admin-record-row"><div class="avatar-cluster admin-record-info">${avatar(p,'mini')}<div><strong>${e(p.handle)}</strong><div class="secondary">${e(p.name)} · ${p.rating} Elo · ${d.matches} matches · ${d.awards} awards</div></div></div><div class="button-row"><button type="button" class="btn-alt" data-edit="player" data-id="${e(p.id)}">Edit</button>${deleteButton('player',p.id,p.handle)}</div></div>`;}).join('')||'<div class="no-results">No players added.</div>'}</section>`;
}
function tournamentForm(){
 const t=ui.editing?.type==='tournament'?byT(ui.editing.id):null;
 return `<section class="panel"><div class="panel-head"><h2>${t?'Edit tournament':'Create tournament'}</h2>${t?'<button class="btn-alt" data-cancel-edit>Cancel edit</button>':''}</div><div class="panel-body"><div class="notice">Open and Stage build the circuit. Each championship has its own Qualifier + Final path, with 4 direct invites and 4 qualifying players. Classifications do not automatically change Elo or points; those still come from matches and recorded placements.</div><form id="tournament-form" class="form-grid">${formField('t_id','Tournament ID (slug)',t?.id||'','text',t?'readonly required':'required pattern="[a-z0-9-]{2,40}" placeholder="spring-open"')}${formField('t_name','Event name',t?.name||'','text','required maxlength="100"')}<div class="field"><label for="t_status">Status</label><select id="t_status" name="t_status">${['upcoming','ongoing','completed'].map(x=>`<option ${t?.status===x?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label for="t_tier">Tournament classification</label><select id="t_tier" name="t_tier">${TOURNAMENT_TYPES.map(x=>`<option ${t?.tier===x?'selected':''}>${x}</option>`).join('')}</select></div>${formField('t_capacity','Player slots',t?.capacity||8,'number','required min="2" max="64"')}<div class="field"><label for="t_groups">Group stage format</label><select id="t_groups" name="t_groups">${GROUP_CHOICES.map(([val,label])=>`<option value="${val}" ${stageOption(t)===val?'selected':''}>${e(label)}</option>`).join('')}</select><p class="hint muted">Double elimination always has TWO groups: 8 players = 4 in Group A + 4 in Group B; 16 players = 8 in each group. Swiss 8 ends at two wins/losses; Swiss 16 ends at three. Playoffs remain separate.</p></div>${formField('t_format' ,'Format',t?.format||'Swiss + playoffs','text','required maxlength="70"')}<div class="field full"><label for="t_description">Description</label><textarea id="t_description" name="t_description" maxlength="400">${e(t?.description||'')}</textarea></div><div class="field full"><div class="button-row"><button class="btn" type="submit">${t?'Save tournament':'Create tournament'}</button>${t?deleteButton('tournament',t.id,t.name):''}</div></div></form></div></section><section class="panel top-gap"><div class="panel-head"><h2>Event registry</h2><span class="caps">${data.tournaments.length} tournaments</span></div><div class="panel-body"><div class="notice">Rosters are managed under Event rosters. Deleting an event removes its registrations, matches, and points and rebuilds ratings.</div></div>${[...data.tournaments].map(t=>{const d=recordDependents('tournament',t.id);return `<div class="list-row admin-record-row"><div class="admin-record-info"><strong>${e(t.name)}</strong><div class="secondary">${e(t.tier)} · ${e(t.status)} · ${participants(t.id).length}/${Number(t.capacity)||8} entered · ${d.matches} matches · ${groupCount(t)?groupCount(t)+" group(s) · ":""}${d.awards} awards</div></div><div class="button-row"><button type="button" class="btn-alt" data-edit="tournament" data-id="${e(t.id)}">Edit</button>${deleteButton('tournament',t.id,t.name)}</div></div>`;}).join('')||'<div class="no-results">No tournaments added.</div>'}</section>`;
}

function matchForm(){const m=ui.editing?.type==='match'?byM(ui.editing.id):null, eventId=m?.tournament_id||data.tournaments[0]?.id||'';
 return `<section class="panel"><div class="panel-head"><h2>${m?'Edit match result':'Create fixture / enter result'}</h2>${m?'<button class="btn-alt" data-cancel-edit>New match</button>':''}</div><div class="panel-body"><div class="notice">TBD is allowed for one or both competitors until pairings are announced. Only registered entrants can be selected. To enter an official result, both competitors and both scores must be set. A BO7 winner reaches four games.</div><form id="match-form" class="form-grid"><div class="field"><label for="m_tournament">Tournament</label><select id="m_tournament" name="m_tournament" required>${optionList(data.tournaments,eventId,x=>x.name)}</select></div><div class="field"><label for="m_section">Match section</label><select id="m_section" name="m_section">${[['A',swissSize(byT(eventId))?'Swiss Stage':'Group A'],['B','Group B'],['playoffs','Playoffs']].map(([val,label])=>`<option value="${val}" ${((m?matchSection(m):(groupCount(byT(eventId))||swissSize(byT(eventId))?'A':'playoffs'))===val)?'selected':''} ${val==='B'&&groupCount(byT(eventId))<2?'disabled':''} ${val==='A'&&!groupCount(byT(eventId))&&!swissSize(byT(eventId))?'disabled':''}>${label}</option>`).join('')}</select><p class="hint muted">Group options follow the selected tournament's group count. Playoffs is always available.</p></div><div class="field"><label for="m_round">Stage / round</label><input id="m_round" name="m_round" list="bracket-round-presets" value="${e(m?.round||(swissSize(byT(eventId))?'0:0 Swiss':groupCount(byT(eventId))?'Opening round':'Quarterfinal'))}" required maxlength="60"><datalist id="bracket-round-presets">${['Opening round','Upper Semis','Upper Final','Lower Round','Lower Semis','Lower Final','Quarterfinal','Semifinal','Grand Final','Third place decider',...swissRoundsFor(byT(eventId)),'Group round 1','Group round 2'].map(x=>`<option value="${x}"></option>`).join('')}</datalist></div><div class="field"><label for="m_p1">Player one</label><select id="m_p1" name="m_p1">${rosterOptions(eventId,m?.player1_id)}</select></div><div class="field"><label for="m_p2">Player two</label><select id="m_p2" name="m_p2">${rosterOptions(eventId,m?.player2_id)}</select></div><div class="field"><label for="m_bestof">Series length</label><select id="m_bestof" name="m_bestof">${[1,3,5,7,9].map(x=>`<option value="${x}" ${x===(m?.best_of||5)?'selected':''}>Best of ${x}</option>`).join('')}</select></div>${formField('m_score1','Player one games won',m?.score1??'','number','min="0" max="9" placeholder="Blank until finished"')}${formField('m_score2','Player two games won',m?.score2??'','number','min="0" max="9" placeholder="Blank until finished"')}<div class="field full"><div class="button-row"><button class="btn" type="submit">${m?'Update fixture / result':'Create fixture / result'}</button>${m?`<button type="button" class="btn-danger" data-delete="match" data-id="${e(m.id)}">Delete match</button>`:''}</div></div></form></div></section><section class="panel top-gap"><div class="panel-head"><h2>Current fixtures & results</h2></div>${[...data.matches].reverse().map(m=>`<div class="list-row"><div><strong>${e(labelP(m.player1_id))} ${isDone(m)?`${m.score1}–${m.score2}`:'vs'} ${e(labelP(m.player2_id))}</strong><div class="secondary">${e(byT(m.tournament_id)?.name||'Event')} · ${e(sectionTitle(byT(m.tournament_id),matchSection(m)))} · ${e(m.round)}</div></div><button class="btn-alt" data-edit="match" data-id="${e(m.id)}">Edit</button></div>`).join('')||'<div class="no-results">No matches added yet.</div>'}</section>`;
}

function rosterForm(){
 const chosen=byT(ui.rosterTournament)||data.tournaments[0],t=chosen||null;
 if(!t)return `<section class="panel"><div class="panel-body">Create a tournament first, then assign confirmed competitors.</div></section>`;
 const roster=participants(t.id),available=data.players.filter(p=>!roster.some(x=>x.id===p.id));
 return `<section class="panel"><div class="panel-head"><h2>Event rosters & TBD slots</h2></div><div class="panel-body"><p class="muted hint">Add players here before announcing any pairings. Empty capacity shows as public TBD / Open slots. Remove an entrant without deleting their overall player profile.</p><div class="field" style="max-width:440px"><label for="roster-event">Tournament</label><select id="roster-event">${optionList(data.tournaments,t.id,x=>x.name)}</select></div><div class="roster-admin-summary"><strong>${roster.length}/${Number(t.capacity)||8} confirmed</strong><span>${openSeats(t)} open slots</span><a class="inline-link" href="${toPath('tournament',t.id)}">View public event page →</a></div><form id="roster-form" class="form-grid"><input type="hidden" name="r_tournament" value="${e(t.id)}"/><div class="field"><label for="r_player">Add registered player</label><select id="r_player" name="r_player" required ${!available.length||!openSeats(t)?'disabled':''}>${optionList(available,null,x=>x.handle)}</select></div><div class="field" style="justify-content:flex-end"><button class="btn" type="submit" ${!available.length||!openSeats(t)?'disabled':''}>Add to roster</button></div></form></div></section><div class="top-gap">${rosterBlock(t)}</div><section class="panel top-gap"><div class="panel-head"><h2>Confirmed entrants</h2></div>${roster.map(p=>`<div class="list-row"><div class="avatar-cluster">${avatar(p,'mini')}<strong>${e(p.handle)}</strong></div><button class="btn-danger" data-unregister="${e(p.id)}" data-event="${e(t.id)}">Remove from roster</button></div>`).join('')||'<div class="no-results">No entrants yet. All slots are TBD.</div>'}</section>`;
}
function awardForm(){const aw=ui.editing?.type==='award'?data.awards.find(a=>a.id===ui.editing.id):null;return `<section class="panel"><div class="panel-head"><h2>Set tournament placement points</h2></div><div class="panel-body"><div class="notice">Circuit points are independent from Elo. For Mid-Season Qualifier and Major Qualifier, record placements #1–#4 (0 points is fine) to fill the correct championship qualification tracker. Confirm official championship entrants separately in Event rosters.</div><form id="award-form" class="form-grid"><div class="field"><label for="a_tournament">Tournament</label><select id="a_tournament" name="a_tournament" required>${optionList(data.tournaments,aw?.tournament_id,x=>x.name)}</select></div><div class="field"><label for="a_player">Player</label><select id="a_player" name="a_player" required>${optionList(data.players,aw?.player_id,x=>x.handle)}</select></div>${formField('a_placement','Placement (#)',aw?.placement||1,'number','required min="1" max="128"')}${formField('a_points','Circuit points awarded',aw?.points??10,'number','required min="0" max="10000"')}<div class="field full"><button class="btn" type="submit">Save placement points</button></div></form></div></section><section class="panel top-gap"><div class="panel-head"><h2>Recorded placements</h2></div>${data.awards.map(a=>`<div class="list-row"><div><strong>${e(labelP(a.player_id))} · ${e(byT(a.tournament_id)?.name||'Event')}</strong><div class="secondary">Place #${n(a.placement)} · +${n(a.points)} pts</div></div><div class="button-row"><button class="btn-alt" data-edit="award" data-id="${e(a.id)}">Edit</button><button class="btn-danger" data-delete="award" data-id="${e(a.id)}">Remove</button></div></div>`).join('')||'<div class="no-results">No points recorded yet.</div>'}</section>`;}
function toolsPage(){return `<section class="panel"><div class="panel-head"><h2>Live league setup</h2></div><div class="panel-body"><div class="stack"><div><h3 class="tight" style="font-size:14px">Connected data</h3><p class="muted hint">This production release reads and writes actual league records in Supabase. There are no demo accounts, fake results, or example-data import controls. Add your first players and events using the Admin tabs.</p><p class="muted hint">Back up real data regularly through Supabase Dashboard → Database backups or an appropriate database export. Deletions are permanent.</p></div><hr class="divider-light"/><div><h3 class="tight" style="font-size:14px">Hosting</h3><p class="muted hint">GitHub Pages hosts the public HTML, CSS and JavaScript. Supabase stores the shared player profiles, tournament rosters, match results, and Elo history. Configuration and initial schema instructions are in README.md.</p><p class="muted hint">Only the Supabase public/publishable key belongs in config.js. Never publish your service_role key, secret key, or admin password.</p></div></div></div></section>`;}
function admin(){const tab=ui.adminTab;
 if(!db)return `${pageHead('League / Administration','Admin center','Private management workspace')}${modeBanner()}<div class="panel"><div class="panel-body">The connection must be configured and available before live administration can begin.</div></div>`;
 if(!session)return `${pageHead('League / Administration','Admin sign in','Only authorized league administrators can edit results.')}${modeBanner()}<section class="panel" style="max-width:480px"><div class="panel-head"><h2>Administrator account</h2></div><div class="panel-body"><form id="login-form" class="stack"><div class="field"><label for="login-email">Email</label><input id="login-email" type="email" name="login-email" autocomplete="username" required></div><div class="field"><label for="login-password">Password</label><input id="login-password" type="password" name="login-password" autocomplete="current-password" required></div><button type="submit" class="btn">Sign in</button><p class="hint muted tight">Create your admin account through Supabase Auth, then approve your account in the <code>admins</code> table using the SQL editor. See README.md.</p></form></div></section>`;
 if(!isAdmin)return `${pageHead('League / Administration','No admin access','Your account is signed in, but it is not on the league administrator list.')}${modeBanner()}<div class="panel"><div class="panel-body"><p class="muted">Signed in as <strong>${e(session.user.email)}</strong>. Contact the league owner to grant admin access in Supabase.</p><button class="btn-alt" id="sign-out">Sign out</button></div></div>`;
 return `${pageHead('League / Control center','Admin dashboard','Manage players, tournaments, fixtures, scores and championship points.',`<button class="btn-alt" id="sign-out">Sign out</button>`)}${modeBanner()}<div class="three-stack" style="margin-bottom:17px"><div class="metric"><div class="label">Competitors</div><div class="value">${data.players.length}</div></div><div class="metric"><div class="label">Tournaments</div><div class="value">${data.tournaments.length}</div></div><div class="metric"><div class="label">Official results</div><div class="value">${data.matches.filter(isDone).length}</div></div></div><div class="admin-tabs">${[['match','Matches & results'],['player','Players'],['tournament','Tournaments'],['roster','Event rosters'],['award','Circuit points'],['tools','Data & setup']].map(([id,txt])=>`<button data-tab="${id}" class="${tab===id?'active':''}">${txt}</button>`).join('')}</div>${tab==='player'?playerForm():tab==='tournament'?tournamentForm():tab==='roster'?rosterForm():tab==='award'?awardForm():tab==='tools'?toolsPage():matchForm()}`;
}
function currentContent(){const parts=ui.route.split('/').filter(Boolean);switch(parts[0]){case 'overview':return dashboard();case 'rankings':return rankings();case 'tournaments':return tournaments();case 'tournament':return tournamentPage(decodeURIComponent(parts[1]||''));case 'players':return playersPage();case 'player':return profile(decodeURIComponent(parts[1]||''));case 'matches':return matchesPage();case 'match':return matchPage(decodeURIComponent(parts[1]||''));case 'admin':return admin();default:return notFound();}}
function render(){const el=document.getElementById('app');document.title=`${ui.route.slice(1).split('/')[0]||'Home'} — SPEEDWIRE.GG`;el.innerHTML=header()+(ui.mobile?`<nav class="mobile-drawer">${[['overview','Overview'],['rankings','Rankings'],['tournaments','Tournaments'],['players','Players'],['matches','Matches'],['admin','Admin']].map(([id,t])=>`<a href="#/${id}">${t}</a>`).join('')}</nav>`:'')+`<div class="layout">${sidebar()}<main class="page">${currentContent()}${footer()}</main></div>`;
 const search=document.getElementById('site-search');if(search){search.addEventListener('input',()=>{ui.search=search.value;searchResults()});search.addEventListener('focus',searchResults);}
}
function searchResults(){const el=document.getElementById('search-results');if(!el)return;const q=ui.search.trim().toLowerCase();if(!q){el.innerHTML='';return;}const ps=data.players.filter(p=>`${p.handle} ${p.name}`.toLowerCase().includes(q)).slice(0,4),ts=data.tournaments.filter(t=>t.name.toLowerCase().includes(q)).slice(0,4);el.innerHTML=`<div class="search-results">${ps.length?'<div class="search-caption">Players</div>':''}${ps.map(p=>`<a class="search-result" href="${toPath('player',p.id)}">${avatar(p,'mini')}<strong>${e(p.handle)}</strong></a>`).join('')}${ts.length?'<div class="search-caption">Events</div>':''}${ts.map(t=>`<a class="search-result" href="${toPath('tournament',t.id)}">◷ <strong>${e(t.name)}</strong></a>`).join('')}${!ps.length&&!ts.length?'<div class="no-results">No results found.</div>':''}</div>`;}
async function persist(table,row,{conflict='id'}={}){
 if(!db||!isAdmin)throw Error('Only an authorized administrator can save league records.');
 const action=table==='tournament_players'?db.from(table).insert(row):db.from(table).upsert(row,{onConflict:conflict});
 const {error}=await action;if(error)throw Error(error.message);
 await loadLive(true);
}
async function erase(table,id){
 if(!db||!isAdmin)throw Error('Not authorized.');
 const {error}=await db.from(table).delete().eq('id',id);
 if(error)throw Error(error.message);
 await loadLive(true);
}
async function deleteLeagueEntity(kind,id){
 if(!db||!isAdmin)throw Error('Not authorized.');
 if(!['player','tournament'].includes(kind))throw Error('Unknown record type.');
 const exists=kind==='player'?byP(id):byT(id);
 if(!exists)throw Error('This record no longer exists. Refresh the page.');
 const rpc=kind==='player'?'delete_league_player':'delete_league_tournament';
 const {error}=await db.rpc(rpc,{p_id:id});
 if(error){if(error.code==='PGRST202'||error.code==='42883')throw Error('The database deletion functions are missing; follow README.md.');throw Error(error.message);}
 await loadLive(true);
}
function confirmLeagueDelete(kind,id){
 const item=kind==='player'?byP(id):byT(id);
 if(!item)return false;
 const label=kind==='player'?item.handle:item.name;
 const {matches,awards,registrations}=recordDependents(kind,id);
 const line=kind==='player'?'All matches involving this player will be erased.':'All matches at this tournament will be erased.';
 return confirm(`PERMANENTLY DELETE ${kind.toUpperCase()}: ${label}?\n\n${line}\n• ${matches} related match${matches===1?'':'es'}\n• ${awards} placement award${awards===1?'':'s'}\n• ${registrations} tournament registration${registrations===1?'':'s'}\n\nRemaining Elo ratings, match records and Circuit Points will be recalculated. This cannot be undone. Export a backup first if you need the history.\n\nPress OK to permanently delete.`);
}
async function submitForm(form){if(form.id!=='login-form'&&!isAdmin)throw Error('Not authorized.');const f=new FormData(form),get=k=>String(f.get(k)||'').trim();
 if(form.id==='player-form'){
  const id=get('p_id');if(!slug(id))throw Error('Player IDs must be 2–40 lowercase letters, digits or hyphens.');
  const row={id,handle:get('p_handle'),name:get('p_name'),title:get('p_title'),color:get('p_color')};if(!row.name||!row.handle)throw Error('Player handle and display name are required.');
  await persist('players',row);ui.editing=null;ui.adminTab='player';toast('Player saved.');return;
 }
 if(form.id==='tournament-form'){
  const id=get('t_id'),capacity=Number(get('t_capacity'));if(!slug(id))throw Error('Enter a valid event ID.');if(!Number.isInteger(capacity)||capacity<2||capacity>64)throw Error('Slots must be 2–64.');if(capacity<participants(id).length)throw Error('Cannot set fewer slots than confirmed entrants.');
  if(!TOURNAMENT_TYPES.includes(get('t_tier')))throw Error('Select one of the six tournament classifications.');
  const stageChoice=get('t_groups'),isSwissStage=stageChoice==='swiss8'||stageChoice==='swiss16',isDoubleStage=stageChoice==='de8'||stageChoice==='de16';
  if(!GROUP_CHOICES.some(([key])=>key===stageChoice))throw Error('Choose a valid group stage format.');
  const nextGroups=isDoubleStage?2:0,nextSwiss=isSwissStage?Number(stageChoice.slice(5)):0;
  if(isDoubleStage&&capacity!==Number(stageChoice.slice(2)))throw Error(`${stageChoice==='de8'?8:16}-player double elimination needs exactly ${stageChoice==='de8'?8:16} slots (two equal groups).`);
  if(nextGroups<2&&data.matches.some(m=>m.tournament_id===id&&matchSection(m)==='B'))throw Error('Move or delete Group B matches before changing to this format.');
  if(nextGroups===0&&nextSwiss===0&&data.matches.some(m=>m.tournament_id===id&&matchSection(m)==='A'))throw Error('Move Group A / Swiss matches to Playoffs before disabling the group stage.');
  if(nextSwiss&&capacity!==nextSwiss)throw Error(`A ${nextSwiss}-player Swiss event must have exactly ${nextSwiss} player slots.`);
  const prior=byT(id);await persist('tournaments',{id,name:get('t_name'),starts_at:prior?.starts_at||new Date().toISOString(),status:get('t_status'),tier:get('t_tier'),format:get('t_format'),venue:prior?.venue||'Circuit',description:get('t_description'),capacity,group_count:nextGroups,swiss_size:nextSwiss});ui.editing=null;ui.adminTab='tournament';toast('Tournament saved.');return;
 }
 if(form.id==='roster-form'){
  const eventId=get('r_tournament'),playerId=get('r_player'),t=byT(eventId);if(!t||!byP(playerId))throw Error('Choose a valid tournament and player.');
  if(participants(eventId).some(p=>p.id===playerId))throw Error('This player is already registered.');
  if(!openSeats(t))throw Error('All tournament slots are filled.');
  await persist('tournament_players',{tournament_id:eventId,player_id:playerId},{conflict:'tournament_id,player_id'});
  ui.rosterTournament=eventId;toast('Player registered. Roster updated.');return;
 }
 if(form.id==='match-form'){
  const a=get('m_p1')||null,b=get('m_p2')||null,best=Number(get('m_bestof')),sa=get('m_score1'),sb=get('m_score2'),eventId=get('m_tournament');
  if(!byT(eventId))throw Error('Select a tournament.');
  const section=get('m_section'),numberOfGroups=groupCount(byT(eventId)),swissEnabled=swissSize(byT(eventId))>0;
  if(!['A','B','playoffs'].includes(section))throw Error('Choose Group A, Group B, or Playoffs.');
  if(section==='A'&&numberOfGroups<1&&!swissEnabled||section==='B'&&numberOfGroups<2)throw Error('Enable this group in the tournament settings first.');
  if(swissEnabled&&section==='A'&&!swissRoundsFor(byT(eventId)).includes(get('m_round').trim()))throw Error('Allowed Swiss rounds: '+swissRoundsFor(byT(eventId)).join(', '));
  if(a&&b&&a===b)throw Error('Choose two different competitors.');
  const roster=participants(eventId).map(p=>p.id);
  if((a&&!roster.includes(a))||(b&&!roster.includes(b)))throw Error('Register players for this tournament before adding them to matchups.');
  if((sa==='')!==(sb===''))throw Error('Enter BOTH scores or leave BOTH blank.');
  if(sa!==''&&sb!==''){
   if(!a||!b)throw Error('You must announce both players before entering an official result.');
   const v1=Number(sa),v2=Number(sb),needed=Math.ceil(best/2);
   if(v1===v2||Math.max(v1,v2)!==needed||Math.min(v1,v2)>=needed||v1<0||v2<0)throw Error(`Invalid BO${best} result. Winner must reach exactly ${needed} games.`);
  }
  const prior=ui.editing?.type==='match'?byM(ui.editing.id):null;
  const now=new Date().toISOString();
  const row={id:prior?.id||`m-${typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+'-'+Math.floor(Math.random()*1e6)}`,tournament_id:eventId,section,round:get('m_round'),player1_id:a,player2_id:b,best_of:best,scheduled_at:prior?.scheduled_at||now,score1:sa===''?null:Number(sa),score2:sb===''?null:Number(sb),played_at:sa===''?null:(prior?.played_at&&isDone(prior)?prior.played_at:now)};
  await persist('matches',row);ui.editing=null;ui.adminTab='match';toast('Match saved. Rating recalculated using score margin.');return;
 }
 if(form.id==='award-form'){
  const eventId=get('a_tournament'),playerId=get('a_player');
  const row={tournament_id:eventId,player_id:playerId,placement:Number(get('a_placement')),points:Number(get('a_points'))};if(!eventId||!playerId)throw Error('Select a tournament and player.');
  await persist('awards',row,{conflict:'tournament_id,player_id'});ui.editing=null;ui.adminTab='award';toast('Circuit points updated.');return;
 }
 if(form.id==='login-form'){
  if(!db)throw Error('Supabase is not connected.');const {error}=await db.auth.signInWithPassword({email:get('login-email'),password:get('login-password')});if(error)throw Error(error.message);session=(await db.auth.getSession()).data.session;await adminLookup();render();toast(isAdmin?'Signed in as admin.':'Signed in, but you are not an approved admin.');return;
 }
}
window.addEventListener('hashchange',()=>{ui.route=location.hash.slice(1)||'/overview';ui.mobile=false;ui.search='';render();window.scrollTo({top:0,behavior:'instant'});});
document.addEventListener('click',async ev=>{
 const target=ev.target.closest('button,[data-go],[data-roster-manage]');if(!target){if(!ev.target.closest('.search-box'))document.getElementById('search-results')?.replaceChildren();return;}
 try{
  if(target.hasAttribute('data-go')){location.hash='#'+target.dataset.go;return}
  if(target.dataset.ranking){ui.ranking=target.dataset.ranking;render();return}
  if(target.dataset.ef){ui.eventFilter=target.dataset.ef;render();return}
  if(target.dataset.tf){ui.typeFilter=target.dataset.tf;render();return}
  if(target.dataset.mf){ui.matchFilter=target.dataset.mf;render();return}
  if(target.dataset.tab){ui.adminTab=target.dataset.tab;ui.editing=null;render();return}
  if(target.dataset.rosterManage){ui.rosterTournament=target.dataset.rosterManage;ui.adminTab='roster';ui.editing=null;return}
  if(target.dataset.unregister){
   if(!isAdmin)throw Error('Not authorized.');
   const eventId=target.dataset.event,playerId=target.dataset.unregister;
   if(!confirm(`Remove ${labelP(playerId)} from the ${byT(eventId)?.name||'event'} roster? Player profile and prior results will remain.`))return;
   const{error}=await db.from('tournament_players').delete().eq('tournament_id',eventId).eq('player_id',playerId);if(error)throw Error(error.message);await loadLive(true);
   toast('Tournament entrant removed.');return;
  }
  if(target.dataset.edit){ui.editing={type:target.dataset.edit,id:target.dataset.id};ui.adminTab=ui.editing.type;render();window.scrollTo({top:0});return}
  if(target.dataset.cancelEdit!==undefined){ui.editing=null;render();return}
  if(target.dataset.delete){
   const kind=target.dataset.delete,id=target.dataset.id;
   if(kind==='player'||kind==='tournament'){
    if(!confirmLeagueDelete(kind,id))return;
    target.disabled=true;
    await deleteLeagueEntity(kind,id);
    ui.editing=null;
    toast(`${kind==='player'?'Player':'Tournament'} and related records permanently deleted.`);
   }else{
    if(!confirm('Delete this record? Ratings and points will be recalculated.'))return;
    target.disabled=true;
    await erase(kind==='award'?'awards':'matches',id);
    ui.editing=null;
    toast('Record deleted.');
   }
   return;
  }
  if(target.id==='mobile-menu'){ui.mobile=!ui.mobile;render();return}
  if(target.dataset.reload!==undefined){if(!db){await start();}else await loadLive();return}
  if(target.id==='sign-out'){await db.auth.signOut();session=null;isAdmin=false;render();toast('Signed out.');return}
 }catch(error){toast(error.message,true);target.disabled=false;}
});
document.addEventListener('submit',async ev=>{if(!['player-form','tournament-form','match-form','roster-form','award-form','login-form'].includes(ev.target.id))return;ev.preventDefault();const form=ev.target,button=form.querySelector('[type="submit"]');if(button)button.disabled=true;try{await submitForm(form)}catch(error){toast(error.message,true)}finally{if(button)button.disabled=false;}});
document.addEventListener('change',ev=>{
 if(ev.target.id==='t_groups'){const selected=ev.target.value,capacity=document.getElementById('t_capacity');if(capacity&&['de8','de16','swiss8','swiss16'].includes(selected))capacity.value=selected.endsWith('16')?'16':'8';}
 if(ev.target.id==='roster-event'){ui.rosterTournament=ev.target.value;render();}if(ev.target.id==='m_tournament'){const list=participants(ev.target.value);for(const id of ['m_p1','m_p2']){const sel=document.getElementById(id);if(sel)sel.innerHTML=optionList(list,null,x=>x.handle,'TBD — unannounced');}const currentTournament=byT(ev.target.value),count=groupCount(currentTournament),ss=swissSize(currentTournament),sel=document.getElementById('m_section');if(sel){for(const op of sel.options){op.disabled=(op.value==='A'&&count<1&&!ss)||(op.value==='B'&&count<2);if(op.value==='A')op.textContent=ss?'Swiss Stage':'Group A';}if(sel.selectedOptions[0]?.disabled||!ui.editing)sel.value=count||ss?'A':'playoffs';}const roundInput=document.getElementById('m_round');if(roundInput&&!ui.editing)roundInput.value=ss?'0:0 Swiss':count?'Opening round':'Quarterfinal';
 const presets=document.getElementById('bracket-round-presets');
 if(presets)presets.innerHTML=['Opening round','Upper Semis','Upper Final','Lower Round','Lower Semis','Lower Final','Quarterfinal','Semifinal','Grand Final','Third place decider',...swissRoundsFor(currentTournament),'Group round 1','Group round 2'].map(x=>`<option value="${e(x)}"></option>`).join('');}});
document.addEventListener('input',ev=>{if(ev.target.id==='player-filter'){ui.playerQuery=ev.target.value;const ps=rankArr().filter(p=>`${p.handle} ${p.name}`.toLowerCase().includes(ui.playerQuery.toLowerCase()));const el=document.getElementById('profiles-list');if(el)el.innerHTML=ps.map(playerTile).join('')||'<div class="no-results">No matching players.</div>';}});
document.addEventListener('keydown',ev=>{if(ev.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){ev.preventDefault();document.getElementById('site-search')?.focus();}if(ev.key==='Escape'){document.getElementById('search-results')?.replaceChildren()}});
start();
