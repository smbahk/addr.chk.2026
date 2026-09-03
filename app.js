/* ============================================================
   app.js — 공통 데이터 레이어 + UI 헬퍼
   업체별 주간 실적 병합 구조 지원
   ============================================================ */

// ---- GitHub PAT 자동 커밋 ----
const LS_PAT = 'kaba_gh_pat';
const GH_OWNER = 'dggis';
const GH_REPO  = 'addr.chk.2026';
const GH_BRANCH = 'main';

const GitHubCommit = {
  getPAT() { return localStorage.getItem(LS_PAT) || ''; },
  setPAT(token) { localStorage.setItem(LS_PAT, token); },
  clearPAT() { localStorage.removeItem(LS_PAT); },
  hasPAT() { return !!this.getPAT(); },

  async _getFileSHA(path) {
    const res = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`, {
      headers: { Authorization: `Bearer ${this.getPAT()}`, Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.sha || null;
  },

  async getFile(path) {
    const res = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`, {
      headers: { Authorization: `Bearer ${this.getPAT()}`, Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = JSON.parse(atob(data.content.replace(/\n/g, '')));
    return { content, sha: data.sha };
  },

  async putFile(path, jsonObj, msg) {
    const sha = await this._getFileSHA(path);
    const body = {
      message: msg,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(jsonObj, null, 2)))),
      branch: GH_BRANCH,
    };
    if (sha) body.sha = sha;
    const res = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${this.getPAT()}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(()=>({}));
      throw new Error(err.message || `GitHub 오류 (${res.status})`);
    }
    return true;
  },

  async commitWeek(date, master) {
    // GitHub 기존 index.json과 로컬 목록을 합쳐서 누락 없이 저장
    let ghWeeks = [];
    try {
      const existing = await this.getFile('data/index.json');
      if (existing?.content?.weeks) ghWeeks = existing.content.weeks;
    } catch(e) {}
    const localWeeks = LocalStore.listWeeks();
    const merged = [...new Set([...ghWeeks, ...localWeeks, date])].sort();
    await this.putFile(`data/weekly/${date}.json`, master, `chore: ${date} 주차 데이터 업로드`);
    await this.putFile('data/index.json', { weeks: merged }, `chore: index.json 갱신 (${date} 추가)`);
  }
};

// ---- LocalStore ----
const LS_MASTER_PREFIX = 'kaba_master_';
const LS_WEEKS = 'kaba_weeks';

const LocalStore = {
  listWeeks() { try { return JSON.parse(localStorage.getItem(LS_WEEKS)||'[]'); } catch { return []; } },
  _saveIndex(date) {
    const weeks = new Set(this.listWeeks()); weeks.add(date);
    localStorage.setItem(LS_WEEKS, JSON.stringify([...weeks].sort()));
  },
  saveMasterWeek(date, master) {
    this._saveIndex(date);
    try { localStorage.setItem(LS_MASTER_PREFIX+date, JSON.stringify(master)); } catch(e) { console.warn('localStorage 용량 부족:', e); }
  },
  getMasterWeek(date) { try { return JSON.parse(localStorage.getItem(LS_MASTER_PREFIX+date)||'null'); } catch { return null; } },
  deleteWeek(date) {
    const weeks = this.listWeeks().filter(d=>d!==date);
    localStorage.setItem(LS_WEEKS, JSON.stringify(weeks));
    localStorage.removeItem(LS_MASTER_PREFIX+date);
  },
  // fetch from GitHub — 업체별 새형식 우선, 구형식 fallback
  async fetchRemoteWeek(date) {
    // 새형식: 업체별 파일 병렬 로드
    const SLUGS = ['nega','dggis','thefirst','saehan','ways1'];
    const SLUG_NAME = {nega:'내가시스템',dggis:'대국지아이에스',thefirst:'더퍼스트아이씨티',saehan:'새한항업',ways1:'웨이즈원',dkgs:'대한지리학회'};
    try {
      const files = await Promise.all(
        SLUGS.map(slug =>
          fetch(`data/weekly/${slug}/${date}.json`, {cache:'no-store'})
            .then(r => r.ok ? r.json() : null).catch(()=>null)
        )
      );
      const found = files.filter(Boolean);
      if (found.length > 0) {
        // 업체별 파일 병합
        const master = {
          baseDate: date, weekStart: found[0].weekStart||'', weekEnd: date,
          uploadedAt: new Date().toISOString(), companyUploads: {}, regions: [], rollbackHistory: {}
        };
        const regionMap = {};
        found.forEach(cf => {
          if (!cf.company) return;
          master.companyUploads[cf.company] = { uploadedAt:cf.uploadedAt, reportText:cf.reportText||{}, regions:cf.regions };
          (cf.regions||[]).forEach(r => { regionMap[r.sido+'|'+r.sigungu] = {...r, vendor:cf.company}; });
        });
        master.regions = Object.values(regionMap);
        return master;
      }
    } catch {}
    // 구형식 fallback
    try {
      const res = await fetch(`data/weekly/${date}.json`, {cache:'no-store'});
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  },
  async fetchRemoteIndex() {
    try {
      const res = await fetch('data/index.json', {cache:'no-store'});
      if (!res.ok) return [];
      const j = await res.json();
      return Array.isArray(j.weeks) ? j.weeks : [];
    } catch { return []; }
  },
};

// ---- DataLayer ----
const DataLayer = (() => {
  let remoteIdx = null;
  const weekCache = {}; // 누적 계산 완료된 캐시

  async function listAllWeeks() {
    if (!remoteIdx) remoteIdx = await LocalStore.fetchRemoteIndex();
    const local = LocalStore.listWeeks();
    const map = new Map();
    remoteIdx.forEach(d=>map.set(d,'remote'));
    local.forEach(d=>map.set(d, map.has(d)?'both':'local'));
    return [...map.entries()].map(([date,src])=>({date,src})).sort((a,b)=>a.date.localeCompare(b.date));
  }

  // 원시 데이터(thisWeek만) 로드 — localStorage 우선, 없으면 GitHub
  async function fetchRaw(date) {
    const local = LocalStore.getMasterWeek(date);
    if (local) return local;
    return await LocalStore.fetchRemoteWeek(date);
  }

  // 누적 계산 포함 — 항상 이전 주차 합산으로 계산
  async function getWeek(date) {
    if (weekCache[date]) return weekCache[date];

    const raw = await fetchRaw(date);
    if (!raw) return null;

    // 이전 주차 목록
    const allWeeks = await listAllWeeks();
    const prevDates = allWeeks.map(w=>w.date).filter(d=>d<date).sort();

    // 이전 주차 thisWeek 합산 → 누적맵
    const cumulativeMap = {};
    if (prevDates.length > 0) {
      const prevRaws = await Promise.all(prevDates.map(d => fetchRaw(d)));
      prevRaws.filter(Boolean).forEach(ps => {
        (ps.regions||[]).forEach(r => {
          const key = r.sido + '|' + r.sigungu;
          cumulativeMap[key] = (cumulativeMap[key]||0) + (r.thisWeek||0);
        });
      });
    }

    // 현재 주차 regions에 누적 반영
    const regions = (raw.regions||[]).map(r => {
      const key = r.sido + '|' + r.sigungu;
      const prev = cumulativeMap[key] || 0;
      const cumulative = prev + (r.thisWeek||0);
      return {
        ...r,
        prevWeek:  prev,
        cumulative,
        remain:    (r.target||0) - cumulative,
        progress:  r.target ? cumulative / r.target : 0
      };
    });

    const result = { ...raw, regions };
    weekCache[date] = result;
    return result;
  }

  async function getLatestWeek() {
    const weeks = await listAllWeeks();
    if (!weeks.length) return null;
    return await getWeek(weeks[weeks.length-1].date);
  }

  return { listAllWeeks, getWeek, getLatestWeek };
})();

// ---- 집계 ----
function totals(regions=[]) {
  const t = {target:0, prevWeek:0, thisWeek:0, cumulative:0, remain:0, normal:0, damage:0, lost:0, count:regions.length};
  regions.forEach(r=>{
    t.target+=r.target; t.prevWeek+=r.prevWeek||0; t.thisWeek+=r.thisWeek||0; t.cumulative+=r.cumulative||0;
    t.remain+=r.remain||0; t.normal+=r.normal||0; t.damage+=r.damage||0; t.lost+=r.lost||0;
  });
  t.progress = t.target? t.cumulative/t.target : 0;
  return t;
}
function bySido(regions=[]) {
  const map = {};
  regions.forEach(r=>{
    const k = r.sido||'기타';
    if (!map[k]) map[k]={sido:k,count:0,target:0,cumulative:0,thisWeek:0,normal:0,damage:0,lost:0};
    const m=map[k]; m.count++; m.target+=r.target; m.cumulative+=r.cumulative||0; m.thisWeek+=r.thisWeek||0;
    m.normal+=r.normal||0; m.damage+=r.damage||0; m.lost+=r.lost||0;
  });
  return Object.values(map).map(m=>({...m,progress:m.target?m.cumulative/m.target:0})).sort((a,b)=>b.target-a.target);
}
function byVendor(regions=[]) {
  const map = {};
  regions.forEach(r=>{
    const k=r.vendor||'미배정';
    if (!map[k]) map[k]={name:k,count:0,target:0,cumulative:0,thisWeek:0};
    const m=map[k]; m.count++; m.target+=r.target; m.cumulative+=r.cumulative||0; m.thisWeek+=r.thisWeek||0;
  });
  return Object.values(map).map(m=>({...m,progress:m.target?m.cumulative/m.target:0})).sort((a,b)=>b.target-a.target);
}

// ---- 공통 UI ----
const $ = (s,el=document)=>el.querySelector(s);
const $$ = (s,el=document)=>Array.from(el.querySelectorAll(s));
const num = v=>(typeof v==='number'&&isFinite(v))?v:(parseFloat(v)||0);
const fmt = v=>Math.round(num(v)).toLocaleString('ko-KR');
const pct = v=>(num(v)*100).toFixed(1)+'%';
const pctNum = v=>num(v)*100;

function kpiCard(label, value, cls='') {
  return `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div></div>`;
}
function barRow(name, fraction, valueText) {
  return `<div class="bar-row">
    <div class="nm">${name}</div>
    <div class="track"><div class="fill" style="width:${Math.min(pctNum(fraction),100).toFixed(1)}%"></div></div>
    <div class="pct">${valueText!=null?valueText:pct(fraction)}</div>
  </div>`;
}
function statusBadge(r) {
  if ((r.progress||0)>=1) return '<span class="badge ok">완료</span>';
  if ((r.thisWeek||0)>0) return '<span class="badge ok">진행중</span>';
  if ((r.cumulative||0)===0) return '<span class="badge danger">미착수</span>';
  return '<span class="badge warn">지연</span>';
}
function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj,null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ---- 주차 선택 드롭다운 ----
async function buildWeekSelector(selectEl, onChange) {
  const weeks = await DataLayer.listAllWeeks();
  if (!weeks.length) {
    selectEl.innerHTML=`<option>데이터 없음</option>`; selectEl.disabled=true;
    return {weeks, current:null};
  }
  selectEl.disabled=false;
  selectEl.innerHTML=weeks.map(w=>`<option value="${w.date}">${w.date}${w.src==='local'?' ●':''}</option>`).join('');
  const def=weeks[weeks.length-1].date; selectEl.value=def;
  selectEl.addEventListener('change',()=>onChange(selectEl.value));
  return {weeks, current:def};
}

// ---- 하단 탭 내비게이션 ----
function renderNav(active) {
  const items=[
    {id:'view',  href:'index.html',  label:'요약',  icon:'<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>'},
    {id:'report',href:'report.html', label:'보고',  icon:'<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'},
    {id:'stats', href:'stats.html',  label:'통계',  icon:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>'},
    {id:'upload',href:'upload.html', label:'업로드',icon:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'},
  ];
  const el=document.getElementById('tabbar'); if(!el) return;
  el.innerHTML=items.map(it=>`
    <a href="${it.href}" class="${it.id===active?'active':''}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${it.icon}</svg>
      <span>${it.label}</span>
    </a>`).join('');
}
