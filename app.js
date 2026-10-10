'use strict';

// ===== 언어 목록 — 한 줄 추가로 언어 확장 (stt: 음성인식 코드, web: 온라인 번역 코드가 다를 때만) =====
const LANGS = [
  { id: 'ko', name: '한국어', stt: 'ko-KR' },
  { id: 'en', name: 'English', stt: 'en-US' },
  { id: 'ja', name: '日本語', stt: 'ja-JP' },
  { id: 'zh', name: '中文', stt: 'zh-CN', web: 'zh-CN' },
  { id: 'es', name: 'Español', stt: 'es-ES' },
  { id: 'fr', name: 'Français', stt: 'fr-FR' },
  { id: 'de', name: 'Deutsch', stt: 'de-DE' },
  { id: 'vi', name: 'Tiếng Việt', stt: 'vi-VN' },
  { id: 'th', name: 'ไทย', stt: 'th-TH' },
  { id: 'ru', name: 'Русский', stt: 'ru-RU' },
  { id: 'id', name: 'Bahasa Indonesia', stt: 'id-ID' },
  { id: 'pt', name: 'Português', stt: 'pt-BR' },
  { id: 'it', name: 'Italiano', stt: 'it-IT' },
];
const LANG = Object.fromEntries(LANGS.map(l => [l.id, l]));

const MODES = {
  call: '통화 (PC 소리 + 내 마이크)',
  listen: '듣기 (발표·영상)',
  talk: '대화 (마주 보고)',
};

// 음성인식 엔진: 자동 감지(Whisper, 기기 안에서 무료) / 언어 고정(크롬 음성인식)
const ENGINES = {
  'auto-base': '자동 감지 · 빠름',
  'auto-small': '자동 감지 · 정확',
  chrome: '언어 고정 · 크롬',
};
const WHISPER_MODEL = {
  'auto-base': 'onnx-community/whisper-base',
  'auto-small': 'onnx-community/whisper-small',
};

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const UA = navigator.userAgent;
const IS_IOS = /iPhone|iPad|iPod/.test(UA) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(UA));
const IS_ANDROID = /Android/i.test(UA);
const IS_MOBILE = IS_IOS || IS_ANDROID;
// 아이폰 크롬·앱 안 브라우저는 애플 정책상 음성인식이 안 됨 (사파리만 됨)
const IOS_NOT_SAFARI = IS_IOS && (/CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|KAKAOTALK|NAVER|Line\/|Instagram|FBAN|FBAV|Whale|DaumApps/.test(UA) || !/Safari\//.test(UA));
// 사파리(WebKit) 음성인식: 문장이 끝나도 확정이 안 오고 글자가 계속 이어 붙음 → 잠깐 조용하면 직접 끊어서 확정
const WEBKIT_SPEECH = IS_IOS || (/Safari\//.test(UA) && !/Chrome|Chromium|Edg\//.test(UA));
const PAUSE_MS = 900;
const CAN_CAPTURE_PC = !IS_MOBILE && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
const CHROME_VER = parseInt((navigator.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '0', 10);
const TRACK_INPUT_OK = CHROME_VER >= 139; // 음성인식에 PC 소리 트랙을 넣는 기능 (최신 크롬)
const DEMO = new URLSearchParams(location.search).has('demo');
const MAX_LINES = 200;
const INTERIM_DELAY = 800; // 말하는 중 미리 번역 간격(ms)

// ===== 설정 (브라우저에 저장) =====
const DEFAULTS = {
  engine: 'auto-base', // 측정: 빠름 ≈ 문장당 1초, 정확 ≈ 2~3초
  mode: 'call', source: 'mic', their: 'en', mine: 'ko', fontSize: IS_MOBILE ? 24 : 36, showSrc: true,
};
const S = loadSettings();

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('lt-settings') || '{}') || {}; } catch {}
  const s = { ...DEFAULTS, ...saved };
  if (!LANG[s.their]) s.their = DEFAULTS.their;
  if (!LANG[s.mine]) s.mine = DEFAULTS.mine;
  if (!MODES[s.mode]) s.mode = DEFAULTS.mode;
  if (!ENGINES[s.engine]) s.engine = DEFAULTS.engine;
  if (!CAN_CAPTURE_PC) {
    if (s.mode === 'call') s.mode = 'listen';
    s.source = 'mic';
  }
  return s;
}

function saveSettings() {
  try { localStorage.setItem('lt-settings', JSON.stringify(S)); } catch {}
}

// ===== 화면 요소 =====
const $ = id => document.getElementById(id);
const el = {
  feed: $('feed'), hint: $('hint'), hintBtn: $('hintBtn'), hintText: $('hintText'), bar: $('bar'),
  run: $('run'), asr: $('asr'), mode: $('mode'), source: $('source'), their: $('their'), mine: $('mine'),
  swap: $('swap'), smaller: $('smaller'), bigger: $('bigger'), srcToggle: $('srcToggle'),
  clear: $('clear'), full: $('full'), speak: $('speak'), status: $('status'), msg: $('msg'), engine: $('engine'),
};

// sticky: 설정 바가 숨어 있어도 계속 보이게 (모델 내려받는 중 등)
function setStatus(text, isErr = false, sticky = false) {
  el.msg.textContent = text;
  el.status.classList.toggle('err', isErr);
  el.status.classList.toggle('sticky', sticky);
  if (isErr) showUI();
}

function setEngine(text) {
  el.engine.textContent = text ? `번역: ${text}` : '';
}

// ===== 자막 줄 =====
const live = { them: null, me: null }; // 말하는 중인 줄

function sideLangs(side) {
  return side === 'them' ? [S.their, S.mine] : [S.mine, S.their];
}

function newLine(side) {
  const [from, to] = sideLangs(side);
  const node = document.createElement('div');
  node.className = `line ${side} interim`;
  node.innerHTML = '<div class="src"></div><div class="tr"></div>';
  el.feed.appendChild(node);
  while (el.feed.children.length > MAX_LINES) el.feed.firstElementChild.remove();
  renderHint();
  return { side, from, to, node, srcEl: node.firstChild, trEl: node.lastChild, text: '', req: 0, timer: null };
}

function showInterim(side, text) {
  text = text.trim();
  if (!text) return;
  const line = live[side] || (live[side] = newLine(side));
  line.text = text;
  line.srcEl.textContent = text;
  clearTimeout(line.timer);
  line.timer = setTimeout(() => translateLine(line), line.from === line.to ? 0 : INTERIM_DELAY);
  autoscroll();
}

function commit(side, text) {
  text = text.trim();
  const line = live[side];
  live[side] = null;
  if (!text) {
    if (line) line.text ? finalize(line) : line.node.remove();
    return;
  }
  const l = line || newLine(side);
  l.text = text;
  l.srcEl.textContent = text;
  finalize(l);
}

// 인식이 끊겼을 때 말하던 문장을 버리지 않고 확정
function flushInterim(side) {
  const line = live[side];
  if (!line) return;
  live[side] = null;
  line.text ? finalize(line) : line.node.remove();
}

function finalize(line) {
  clearTimeout(line.timer);
  line.node.classList.remove('interim');
  translateLine(line);
  autoscroll();
}

async function translateLine(line) {
  const id = ++line.req;
  const text = line.text;
  try {
    const out = await translate(text, line.from, line.to);
    if (id !== line.req) return; // 더 최신 번역 요청이 있음
    line.trEl.textContent = out;
    line.trEl.classList.remove('fail');
    autoscroll();
  } catch (err) {
    console.warn('translate failed', err);
    if (id !== line.req || line.node.classList.contains('interim')) return;
    if (!line.retried) { // 한 번은 3초 뒤 다시 시도
      line.retried = true;
      setTimeout(() => { if (id === line.req) translateLine(line); }, 3000);
      return;
    }
    line.trEl.textContent = '(번역 실패 — 인터넷 연결 확인)';
    line.trEl.classList.add('fail');
  }
}

let stickToBottom = true;
el.feed.addEventListener('scroll', () => {
  const f = el.feed;
  stickToBottom = f.scrollHeight - f.scrollTop - f.clientHeight < 80;
});

function autoscroll() {
  if (stickToBottom) el.feed.scrollTop = el.feed.scrollHeight;
}
window.addEventListener('resize', autoscroll);

// ===== 번역: 크롬 내장(기기 내) → 안 되면 무료 온라인 =====
const onDevice = new Map(); // 'en>ko' → { value: Translator|null, settled }

function track(promise) {
  const entry = { value: null, settled: false };
  promise.then(v => { entry.value = v; entry.settled = true; });
  return entry;
}

function languagePairs() {
  return [[S.their, S.mine], [S.mine, S.their]].filter(([a, b]) => a !== b);
}

// 시작 버튼 클릭(사용자 동작) 안에서 호출해야 번역 모델 다운로드가 허용됨
function prepareTranslators() {
  if (!('Translator' in self)) return;
  for (const [from, to] of languagePairs()) {
    const key = `${from}>${to}`;
    const entry = onDevice.get(key);
    if (entry && (!entry.settled || entry.value)) continue; // 준비 중이거나 이미 있음
    let p;
    try {
      p = Translator.create({
        sourceLanguage: from,
        targetLanguage: to,
        monitor(m) {
          m.addEventListener('downloadprogress', e => {
            // 이미 받아 둔 경우에도 0%·100% 신호가 오므로 실제로 받는 중일 때만 표시
            if (e.loaded > 0 && e.loaded < 1) setStatus(`번역 모델 내려받는 중 ${Math.round(e.loaded * 100)}% (그동안은 온라인 번역)`);
          });
        },
      });
    } catch (err) {
      p = Promise.reject(err);
    }
    onDevice.set(key, track(p.catch(err => { console.warn('on-device translator', key, err); return null; })));
  }
}

// 준비된 기기 내 번역기만 돌려줌. 없으면 백그라운드로 확인만 하고 null
function readyOnDevice(from, to) {
  if (!('Translator' in self)) return null;
  const key = `${from}>${to}`;
  const entry = onDevice.get(key);
  if (entry) return entry.value;
  onDevice.set(key, track((async () => {
    const a = await Translator.availability({ sourceLanguage: from, targetLanguage: to });
    return a === 'available' ? Translator.create({ sourceLanguage: from, targetLanguage: to }) : null;
  })().catch(() => null)));
  return null;
}

async function translate(text, from, to) {
  if (from === to) return text;
  const t = readyOnDevice(from, to);
  if (t) {
    try {
      const out = await t.translate(text);
      setEngine('기기 내');
      return out;
    } catch (err) {
      console.warn('on-device translate failed, using online', err);
    }
  }
  const out = await translateOnline(text, from, to);
  setEngine('온라인');
  return out;
}

async function translateOnline(text, from, to) {
  return (await translateOnlineRaw(text, from, to)).text;
}

// 무료 온라인 번역: 여러 곳을 차례로 시도하고, 막힌 곳(429 '요청 너무 많음' 등)은 잠시 건너뜀
const PROVIDERS = [
  {
    name: 'google',
    url: (q, sl, tl) => `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${sl}&tl=${tl}&q=${q}`,
    parse: d => (Array.isArray(d[0]) ? { text: d[0][0], src: d[0][1] } : { text: d[0] }),
  },
  {
    name: 'google-gtx',
    url: (q, sl, tl) => `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=${sl}&tl=${tl}&q=${q}`,
    parse: d => ({ text: (d[0] || []).map(seg => seg[0]).join(''), src: d[2] }),
  },
  {
    name: 'mymemory',
    noAuto: true,
    url: (q, sl, tl) => `https://api.mymemory.translated.net/get?q=${q}&langpair=${sl}|${tl}`,
    parse: d => {
      if (d.responseStatus !== 200) throw new Error(d.responseDetails || 'mymemory');
      return { text: d.responseData.translatedText };
    },
  },
];
const providerDownUntil = {};

// from에 'auto'를 주면 src에 감지된 언어가 옴
async function translateOnlineRaw(text, from, to) {
  const sl = from === 'auto' ? 'auto' : (LANG[from].web || from);
  const tl = LANG[to].web || to;
  const q = encodeURIComponent(text.slice(0, 1500));
  const usable = PROVIDERS.filter(p => !(sl === 'auto' && p.noAuto));
  const ready = usable.filter(p => !(providerDownUntil[p.name] > Date.now()));
  let lastErr = null;
  for (const p of ready.length ? ready : usable) { // 전부 쉬는 중이면 그래도 다 시도
    try {
      const res = await fetch(p.url(q, encodeURIComponent(sl), encodeURIComponent(tl)));
      if (!res.ok) throw Object.assign(new Error(`${p.name} HTTP ${res.status}`), { status: res.status });
      const r = p.parse(await res.json());
      if (!r.text) throw new Error(`${p.name}: 빈 결과`);
      return { text: r.text, src: String(r.src || '').split('-')[0] };
    } catch (err) {
      lastErr = err;
      // 429: 30분, 다른 오류: 2분, 연결 끊김: 15초 쉬기
      const pause = err.status === 429 ? 30 * 60000 : err.status ? 2 * 60000 : 15000;
      providerDownUntil[p.name] = Date.now() + pause;
      console.warn('translation provider failed', p.name, err.message);
    }
  }
  throw lastErr || new Error('번역 서비스에 연결할 수 없어요');
}

// ===== 음성인식 =====
class Listener {
  constructor(side, lang, audioTrack = null) {
    this.side = side;
    this.lang = lang;
    this.track = audioTrack;
    this.active = false;
    this.rec = null;
    this.timer = null;
    this.backoff = 0;
    this.waiters = [];
    this.everStarted = false; // 한 번이라도 듣기 시작했으면 권한은 있는 것
    this.waitingTap = false;  // 아이폰: 다시 시작하려면 탭이 필요해서 멈춘 상태
    this.full = '';           // 사파리: 지금 세션에서 들은 전체 글자
    this.cut = 0;             // 사파리: 그중 이미 자막으로 확정한 위치
    this.pause = null;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.waitingTap = false;
    if (!this.rec) this.spawn(); // 끝나는 중인 세션이 있으면 onend에서 다시 시작
  }

  // graceful: 말하던 문장을 확정하고 멈춤. 완전히 끝나면 resolve
  stop(graceful = true) {
    this.active = false;
    clearTimeout(this.timer);
    const rec = this.rec;
    if (!rec) return Promise.resolve();
    return new Promise(resolve => {
      const t = setTimeout(resolve, 1500);
      this.waiters.push(() => { clearTimeout(t); resolve(); });
      try { graceful ? rec.stop() : rec.abort(); } catch { resolve(); }
    });
  }

  // 화자/언어 전환: 지금 세션을 확정하고 새 설정으로 다시 시작
  switchTo(side, lang) {
    const oldSide = this.side;
    this.side = side;
    this.lang = lang;
    if (WEBKIT_SPEECH && this.rec) {
      // 사파리는 탭 밖에서 다시 시작하면 막힐 수 있음 → 지금(탭 안에서) 바로 새로 시작
      const old = this.rec;
      this.rec = null;
      old.onend = old.onresult = old.onerror = null;
      clearTimeout(this.pause);
      flushInterim(oldSide);
      this.waiters.splice(0).forEach(fn => fn());
      try { old.abort(); } catch {}
      if (this.active) this.spawn();
      return;
    }
    if (this.rec) {
      try { this.rec.stop(); } catch {}
    } else if (this.active) {
      clearTimeout(this.timer);
      this.spawn();
    }
  }

  spawn() {
    clearTimeout(this.timer);
    const side = this.side;
    const lang = this.lang;
    const rec = new SR();
    rec.lang = LANG[lang].stt;
    // 안드로이드는 문장마다 끊고 다시 시작하는 쪽이 안정적. 아이폰은 다시 시작이 막힐 수 있어 계속 듣기
    rec.continuous = !IS_ANDROID;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let startedAt = 0;
    let heard = false;
    this.full = '';
    this.cut = 0;
    clearTimeout(this.pause);

    // 아이폰: 시작 신호가 안 오면(다시 시작이 조용히 막힘) 탭해서 계속 듣기로 전환
    const watchdog = WEBKIT_SPEECH ? setTimeout(() => {
      if (this.rec !== rec || startedAt) return;
      this.rec = null;
      try { rec.abort(); } catch {}
      requestTap(this);
    }, 4000) : null;

    rec.onstart = () => {
      startedAt = Date.now();
      this.everStarted = true;
      clearTimeout(watchdog);
      if (el.status.classList.contains('err')) setStatus(listeningText());
      renderHint();
    };
    rec.onsoundstart = () => renderHint('소리 감지됨…');
    rec.onresult = e => {
      heard = true;
      this.backoff = 0;
      if (WEBKIT_SPEECH) return this.webkitResult(e, side);
      let fin = '';
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (fin) commit(side, fin);
      if (interim) showInterim(side, interim);
    };
    rec.onerror = e => onRecError(this, e.error, lang);
    rec.onend = () => {
      clearTimeout(watchdog);
      if (this.rec !== rec) return;
      this.rec = null;
      clearTimeout(this.pause);
      flushInterim(side);
      this.waiters.splice(0).forEach(fn => fn());
      if (!this.active) return;
      if (!heard && Date.now() - startedAt < 1500) noteConflict();
      this.timer = setTimeout(() => { if (this.active && !this.rec) this.spawn(); }, this.backoff || 100);
    };

    this.rec = rec;
    try {
      this.track ? rec.start(this.track) : rec.start();
    } catch (err) {
      console.warn('recognition start failed', err);
      clearTimeout(watchdog);
      this.rec = null;
      if (this.track && this.track.readyState !== 'live') return;
      if (WEBKIT_SPEECH) { requestTap(this); return; }
      this.timer = setTimeout(() => { if (this.active && !this.rec) this.spawn(); }, 1000);
    }
  }

  // 사파리: 결과가 한 줄로 계속 이어 붙음 → 새로 붙은 부분만 자막으로, 잠깐 조용하면 확정
  webkitResult(e, side) {
    let full = '';
    for (let i = 0; i < e.results.length; i++) full += e.results[i][0].transcript;
    this.full = full;
    if (full.length < this.cut / 2) this.cut = 0; // 사파리가 결과를 새로 시작한 경우
    clearTimeout(this.pause);
    const fresh = full.slice(this.cut).trim();
    if (!fresh) return;
    showInterim(side, fresh);
    this.pause = setTimeout(() => {
      const text = this.full.slice(this.cut).trim();
      this.cut = this.full.length;
      if (text) commit(side, text);
    }, PAUSE_MS);
  }
}

function onRecError(listener, code, lang) {
  switch (code) {
    case 'no-speech':
      return; // 조용했을 뿐 → onend에서 다시 시작
    case 'aborted':
      if (listener.active) noteConflict();
      return;
    case 'not-allowed':
    case 'service-not-allowed':
      if (WEBKIT_SPEECH && listener.everStarted && !IOS_NOT_SAFARI) {
        requestTap(listener); // 권한은 있음 → 사파리가 탭 없이 다시 시작하는 걸 막은 것
        return;
      }
      listener.active = false;
      setStatus(permissionHelp(listener, code), true);
      break;
    case 'audio-capture':
      listener.active = false;
      setStatus('마이크를 찾을 수 없어요. 마이크 연결을 확인해 주세요.', true);
      break;
    case 'language-not-supported':
      listener.active = false;
      setStatus(`${LANG[lang].name} 음성인식은 이 브라우저에서 지원되지 않아요.`, true);
      break;
    case 'network':
      listener.backoff = Math.min(5000, (listener.backoff || 500) * 2);
      setStatus('음성인식 서버 연결이 불안정해요 — 다시 연결하는 중…', true);
      return;
    default:
      listener.backoff = 1000;
      setStatus(`음성인식 오류: ${code} — 다시 시도하는 중…`, true);
      return;
  }
  if (app.running && !app.listeners.some(l => l.active)) stopApp(false);
}

function permissionHelp(listener, code) {
  if (listener.track) return 'PC 소리 인식이 막혔어요. 크롬을 최신으로 업데이트해 주세요.';
  if (IOS_NOT_SAFARI) return '아이폰 크롬·앱 안 브라우저에서는 "언어 고정" 엔진이 안 돼요. 엔진을 "자동 감지"로 바꾸거나 사파리로 열어 주세요.';
  if (IS_IOS) {
    return code === 'service-not-allowed'
      ? '아이폰 설정 > 일반 > 키보드 > "받아쓰기 활성화"를 켠 뒤 다시 시작해 주세요.'
      : '마이크·음성 인식이 거부됐어요. 설정 > 앱 > Safari > 마이크를 "허용"으로 바꾸고 새로고침해 주세요.';
  }
  return '마이크 권한이 거부됐어요. 주소창 왼쪽 아이콘에서 마이크를 허용한 뒤 다시 시작해 주세요.';
}

// 아이폰: 사파리가 탭 없이 다시 듣기를 막으면, 화면을 한 번 탭해서 이어 듣기
function requestTap(listener) {
  listener.active = false;
  listener.waitingTap = true;
  if (!app.running) return;
  flushInterim(listener.side);
  app.needsTap = true;
  renderUI();
}

function resumeFromTap() {
  if (!app.running || !app.needsTap) return;
  app.needsTap = false;
  auto.ctx?.resume().catch(() => {});
  for (const l of app.listeners) if (l.waitingTap) l.start(); // 탭 안에서 바로 시작
  renderUI();
}

// ===== 실행 상태 =====
const app = {
  running: false,
  starting: false,
  engine: '',      // 실행 중인 엔진: 'auto'(Whisper) 또는 'chrome'
  listeners: [],
  stream: null,
  ptt: false,      // 통화 모드에서 인식기 2개 동시 실행이 안 될 때: 누르고 있는 동안 내 말
  pttDown: false,
  talkSide: 'them',
  wakeLock: null,
  needsTap: false, // 아이폰: 탭해서 계속 듣기 대기
};

const conflictTimes = [];

// 통화 모드에서 두 인식기가 서로 끊어내면 → '누르고 말하기' 방식으로 전환
function noteConflict() {
  if (!app.running || S.mode !== 'call' || app.ptt) return;
  const now = Date.now();
  conflictTimes.push(now);
  while (conflictTimes.length && now - conflictTimes[0] > 8000) conflictTimes.shift();
  if (conflictTimes.length >= 3) enterPtt();
}

function enterPtt() {
  app.ptt = true;
  conflictTimes.length = 0;
  const [them, me] = app.listeners;
  me.stop(false);
  them.start();
  setStatus('이 크롬은 두 소리를 동시에 못 받아요 → Space(또는 아래 버튼)를 누르고 있는 동안 내 말을 받아요.');
  showUI();
  renderUI();
}

async function pttDown() {
  if (!app.ptt || app.pttDown) return;
  app.pttDown = true;
  renderUI();
  const [them, me] = app.listeners;
  await them.stop(true);
  if (app.running && app.pttDown) me.start();
  else if (app.running) them.start();
}

async function pttUp() {
  if (!app.ptt || !app.pttDown) return;
  app.pttDown = false;
  renderUI();
  const [them, me] = app.listeners;
  await me.stop(true);
  if (app.running && !app.pttDown) them.start();
}

function switchSpeaker() {
  if (!app.running || app.engine !== 'chrome' || S.mode !== 'talk') return;
  app.talkSide = app.talkSide === 'them' ? 'me' : 'them';
  app.listeners[0].switchTo(app.talkSide, app.talkSide === 'them' ? S.their : S.mine);
  setStatus(listeningText());
  renderUI();
}

function listeningText() {
  if (app.engine === 'auto') {
    const hw = asr.ready ? ` · ${asr.device === 'webgpu' ? 'GPU' : 'CPU'}` : '';
    return `듣는 중 · 자동 감지 (${LANG[S.their].name} ⇄ ${LANG[S.mine].name})${hw}`;
  }
  if (S.mode === 'talk') {
    const lang = app.talkSide === 'them' ? S.their : S.mine;
    return `듣는 중 · ${app.talkSide === 'them' ? '상대' : '나'} (${LANG[lang].name})`;
  }
  if (S.mode === 'listen') return `듣는 중 · ${LANG[S.their].name} → ${LANG[S.mine].name}`;
  return `듣는 중 · 상대 ${LANG[S.their].name} ⇄ 나 ${LANG[S.mine].name}`;
}

async function startApp() {
  if (app.running || app.starting) return;
  if (S.engine !== 'chrome') return startAuto();
  if (!SR) {
    setStatus('이 브라우저는 크롬 음성인식을 지원하지 않아요. 엔진을 "자동 감지"로 바꿔 주세요.', true);
    return;
  }
  prepareTranslators(); // 클릭 직후(사용자 동작 안)에 호출
  const needPc = S.mode === 'call' || (S.mode === 'listen' && S.source === 'pc');
  app.starting = true;
  app.engine = 'chrome';
  try {
    let audioTrack = null;
    if (needPc) audioTrack = await capturePcAudio(true);
    if (S.mode === 'call') {
      app.listeners = [new Listener('them', S.their, audioTrack), new Listener('me', S.mine)];
    } else if (S.mode === 'listen') {
      app.listeners = [new Listener('them', S.their, audioTrack)];
    } else {
      app.talkSide = 'them';
      app.listeners = [new Listener('them', S.their)];
    }
    app.running = true;
    app.ptt = false;
    app.pttDown = false;
    app.needsTap = false;
    conflictTimes.length = 0;
    app.listeners[0].start();
    if (app.listeners[1]) setTimeout(() => { if (app.running && !app.ptt) app.listeners[1].start(); }, 600);
    keepAwake();
    setStatus(listeningText());
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    app.starting = false;
    renderUI();
  }
}

async function stopApp(resetStatus = true) {
  if (!app.running) return;
  app.running = false;
  app.ptt = false;
  app.pttDown = false;
  app.needsTap = false;
  const listeners = app.listeners;
  app.listeners = [];
  if (resetStatus) setStatus('멈춤');
  renderUI();
  cleanupAuto(); // 말하던 문장은 마저 받아 적음
  await Promise.all(listeners.map(l => l.stop(true)));
  if (app.stream) {
    app.stream.getTracks().forEach(t => t.stop());
    app.stream = null;
  }
  flushInterim('them');
  flushInterim('me');
  releaseWakeLock();
}

function toggleRun() {
  app.running ? stopApp() : startApp();
}

// needTrackInput: 크롬 음성인식에 PC 소리를 넣는 경우 (최신 크롬 필요)
async function capturePcAudio(needTrackInput) {
  if (!CAN_CAPTURE_PC) throw new Error('이 기기에서는 PC 소리를 받을 수 없어요. 소리 입력을 마이크로 바꿔 주세요.');
  if (needTrackInput && !TRACK_INPUT_OK) throw new Error('PC 소리 인식은 최신 크롬이 필요해요. 크롬을 업데이트해 주세요.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
    });
  } catch (err) {
    throw new Error(err.name === 'NotAllowedError' ? 'PC 소리 공유가 취소됐어요.' : `PC 소리를 가져오지 못했어요: ${err.message}`);
  }
  const audio = stream.getAudioTracks()[0];
  if (!audio) {
    stream.getTracks().forEach(t => t.stop());
    throw new Error("소리가 공유되지 않았어요. 공유 창에서 '시스템 오디오 공유'(탭이면 '탭 오디오도 공유')를 켜고 다시 시작해 주세요.");
  }
  app.stream = stream;
  audio.addEventListener('ended', () => {
    if (!app.running) return;
    stopApp(false);
    setStatus('PC 소리 공유가 끝나서 멈췄어요.', true);
  });
  return audio;
}

async function keepAwake() {
  try { app.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}

function releaseWakeLock() {
  try { app.wakeLock?.release(); } catch {}
  app.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (app.running && document.visibilityState === 'visible') keepAwake();
});

// ===== 자동 감지 엔진: 소리 → 말 끊김마다 자르기 → Whisper(언어 자동) → 번역 =====
const RATE = 16000;      // Whisper 입력
const FRAME = 320;       // 20ms
const PREROLL = 15;      // 말 시작 직전 0.3초도 포함
const END_SILENCE = 25;  // 0.5초 조용하면 문장 끝
const PARTIAL_MIN = 40;  // 0.8초 이상 말하면 말하는 중에도 받아 적어 보여줌
const PARTIAL_GAP = 600; // 그 간격(ms)
const MAX_FRAMES = 600;  // 12초가 넘으면 조용한 곳에서 자름
const MIN_VOICED = 12;   // 0.24초보다 짧은 소리는 무시

const WORKLET_SRC = `class C extends AudioWorkletProcessor {
  constructor() { super(); this.b = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.b[this.n++] = ch[i];
      if (this.n === 2048) { this.port.postMessage(this.b.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('lt-capture', C);`;

// 소리 크기로 말 시작/끝을 찾아 문장 단위 오디오(16kHz)를 만듦
class Segmenter {
  constructor(ctx, audioTrack, handlers) {
    this.ctx = ctx;
    this.track = audioTrack;
    this.h = handlers;
    this.ratio = ctx.sampleRate / RATE;
    this.left = new Float32Array(0);
    this.t = 0;
    this.buf = [];
    this.noise = 0;
    this.run = 0;
    this.pre = [];
    this.speaking = false;
    this.frames = [];
    this.levels = [];
    this.silent = 0;
    this.voiced = 0;
    this.line = null;
  }

  async start() {
    if (!this.ctx.ltWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }));
      this.ctx.ltWorklet = this.ctx.audioWorklet.addModule(url);
    }
    await this.ctx.ltWorklet;
    this.src = this.ctx.createMediaStreamSource(new MediaStream([this.track]));
    this.node = new AudioWorkletNode(this.ctx, 'lt-capture', { channelCount: 1, channelCountMode: 'explicit' });
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.node.port.onmessage = e => this.feed(e.data);
    this.src.connect(this.node).connect(this.mute).connect(this.ctx.destination);
  }

  stop() {
    if (this.node) this.node.port.onmessage = null;
    try { this.src?.disconnect(); this.node?.disconnect(); this.mute?.disconnect(); } catch {}
    if (this.speaking) this.finish();
  }

  // 기기 샘플레이트 → 16kHz (구간 평균)
  feed(chunk) {
    const r = this.ratio;
    let buf = chunk;
    if (this.left.length) {
      buf = new Float32Array(this.left.length + chunk.length);
      buf.set(this.left);
      buf.set(chunk, this.left.length);
    }
    let t = this.t;
    while (t + r <= buf.length) {
      const a = Math.floor(t);
      const b = Math.max(a + 1, Math.floor(t + r));
      let s = 0;
      for (let i = a; i < b; i++) s += buf[i];
      this.buf.push(s / (b - a));
      t += r;
    }
    const keep = Math.floor(t);
    this.left = buf.slice(keep);
    this.t = t - keep;
    while (this.buf.length >= FRAME) this.frame(Float32Array.from(this.buf.splice(0, FRAME)));
  }

  frame(f) {
    let e = 0;
    for (let i = 0; i < f.length; i++) e += f[i] * f[i];
    const level = Math.sqrt(e / f.length);
    if (!this.noise) this.noise = Math.max(level, 1e-4);
    if (!this.speaking) {
      // 주변 소음 크기를 계속 따라감 (조용해지면 빠르게, 시끄러워지면 천천히)
      this.noise = level < this.noise ? this.noise * 0.9 + level * 0.1 : this.noise * 0.998 + level * 0.002;
    }
    const voiced = level > Math.max(this.noise * 3, 0.004);
    if (!this.speaking) {
      this.pre.push([f, level]);
      if (this.pre.length > PREROLL) this.pre.shift();
      this.run = voiced ? this.run + 1 : 0;
      if (this.run < 3) return;
      this.speaking = true;
      this.frames = this.pre.map(p => p[0]);
      this.levels = this.pre.map(p => p[1]);
      this.pre = [];
      this.silent = 0;
      this.voiced = this.run;
      this.run = 0;
      this.h.onStart(this);
      return;
    }
    this.frames.push(f);
    this.levels.push(level);
    if (voiced) { this.silent = 0; this.voiced++; } else this.silent++;
    if (this.silent >= END_SILENCE) this.finish();
    else if (this.frames.length >= MAX_FRAMES) this.cut();
    else this.h.onFrame(this);
  }

  finish() {
    this.speaking = false;
    const frames = this.frames.slice(0, Math.max(0, this.frames.length - this.silent + 10));
    const voiced = this.voiced;
    this.frames = [];
    this.levels = [];
    this.silent = 0;
    this.voiced = 0;
    if (voiced < MIN_VOICED) this.h.onDrop(this);
    else this.h.onSegment(this, joinFrames(frames));
  }

  // 너무 길게 이어지는 말: 마지막 3초 중 가장 조용한 곳에서 자르고 계속 들음
  cut() {
    const n = this.frames.length;
    let at = n - 1;
    for (let i = n - 150; i < n; i++) if (this.levels[i] < this.levels[at]) at = i;
    const head = this.frames.splice(0, at + 1);
    this.levels.splice(0, at + 1);
    this.voiced = this.frames.length;
    this.silent = 0;
    this.h.onSegment(this, joinFrames(head));
    this.h.onStart(this);
  }
}

function joinFrames(frames) {
  const out = new Float32Array(frames.length * FRAME);
  frames.forEach((f, i) => out.set(f, i * FRAME));
  return out;
}

// Whisper 실행기: 기본은 백그라운드 워커, 워커에서 GPU를 못 쓰는 브라우저는 페이지에서 실행
const asr = {
  worker: null,
  page: null,
  pageQueue: Promise.resolve(),
  loading: null,
  requested: '',
  ready: false,
  device: '',
  jobs: new Map(),
  nextId: 1,
  onProgress: null,

  load(model) {
    if (this.loading && this.requested === model) return this.loading;
    this.reset();
    this.requested = model;
    this.loading = new Promise((resolve, reject) => {
      const loadInPage = async () => {
        const { loadASR } = await import('./whisper-core.js');
        this.page = await loadASR({ model, onProgress: (p, total) => this.onProgress?.(p, total) });
        this.device = this.page.device;
        this.ready = true;
      };
      let w;
      try {
        w = new Worker('whisper-worker.js', { type: 'module' });
      } catch {
        loadInPage().then(resolve, reject);
        return;
      }
      this.worker = w;
      w.onmessage = ({ data }) => {
        if (data.type === 'caps') {
          if (!data.gpu && navigator.gpu) {
            w.terminate();
            this.worker = null;
            loadInPage().then(resolve, reject);
          } else {
            w.postMessage({ type: 'load', model });
          }
        } else if (data.type === 'progress') {
          this.onProgress?.(data.p, data.total);
        } else if (data.type === 'ready') {
          this.device = data.device;
          this.ready = true;
          resolve();
        } else if (data.type === 'result') {
          this.jobs.get(data.id)?.resolve(data);
          this.jobs.delete(data.id);
        } else if (data.type === 'error') {
          const job = this.jobs.get(data.id);
          if (job) { job.reject(new Error(data.message)); this.jobs.delete(data.id); }
          else if (!this.ready) reject(new Error(data.message));
        }
      };
      w.onerror = e => { if (!this.ready) reject(new Error(e.message || '음성 모델을 불러오지 못했어요')); };
    });
    this.loading.catch(() => this.reset());
    return this.loading;
  },

  reset() {
    this.worker?.terminate();
    this.jobs.forEach(j => j.reject(new Error('음성 모델이 바뀌었어요')));
    Object.assign(this, { worker: null, page: null, loading: null, requested: '', ready: false, device: '', jobs: new Map() });
  },

  // langs: 후보 언어 (상대 언어, 내 언어) — 이 중 어느 언어인지 소리로 판별해서 받아 적음
  async transcribe(audio, langs) {
    await this.loading;
    if (this.page) {
      const run = this.pageQueue.catch(() => {}).then(() => this.page.transcribe(audio, langs));
      this.pageQueue = run;
      return run;
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'transcribe', id, audio, langs }, [audio.buffer]);
    });
  },
};

const auto = { ctx: null, segs: [], mic: null, busy: 0, progress: '', partials: true };

// 받아 적기 순서: 끝난 문장이 먼저, 말하는 중 미리보기는 남는 시간에. 같은 소리의 오래된 미리보기는 버림
const sched = {
  queue: [],
  running: false,
  run(audio, langs, partialKey = null) {
    return new Promise((resolve, reject) => {
      if (partialKey) {
        this.queue = this.queue.filter(j => {
          if (j.key !== partialKey) return true;
          j.resolve(null);
          return false;
        });
      }
      this.queue.push({ audio, langs, key: partialKey, resolve, reject });
      this.pump();
    });
  },
  async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      let i = this.queue.findIndex(j => !j.key);
      if (i < 0) i = 0;
      const job = this.queue.splice(i, 1)[0];
      const t0 = performance.now();
      try {
        const r = await asr.transcribe(job.audio, job.langs);
        job.resolve({ ...r, ms: performance.now() - t0 });
      } catch (err) {
        job.reject(err);
      }
    }
    this.running = false;
  },
};

const autoHandlers = {
  onStart(seg) {
    if (!seg.line) seg.line = pendingLine();
  },
  // 말하는 중: 지금까지 들은 소리를 주기적으로 받아 적어 미리 보여줌
  onFrame(seg) {
    if (!auto.partials || !asr.ready || seg.partialBusy || !seg.line) return;
    if (seg.frames.length < PARTIAL_MIN || Date.now() - (seg.partialAt || 0) < PARTIAL_GAP) return;
    if (seg.silent > 0) return; // 말이 멈칫할 때 시작하면 문장 끝 받아 적기가 그만큼 늦어짐
    const line = seg.line;
    seg.partialBusy = true;
    sched.run(joinFrames(seg.frames), [S.their, S.mine], seg)
      .then(r => {
        if (!r) return;
        if (r.ms > 2000) auto.partials = false; // 기기가 느리면 미리보기 끄고 문장 끝에만 받아 적음
        showPartial(line, r);
      })
      .catch(() => {})
      .finally(() => {
        seg.partialBusy = false;
        seg.partialAt = Date.now();
      });
  },
  onDrop(seg) {
    if (seg.line) {
      seg.line.closed = true;
      seg.line.node.remove();
    }
    seg.line = null;
    renderHint();
  },
  onSegment(seg, audio) {
    const line = seg.line || pendingLine();
    line.closed = true; // 이후 도착하는 미리보기는 무시
    seg.line = null;
    auto.busy++;
    sched.run(audio, [S.their, S.mine])
      .then(r => autoResult(line, r))
      .catch(err => {
        console.warn('asr failed', err);
        line.node.remove();
        setStatus(`음성 인식 오류: ${err.message}`, true);
      })
      .finally(() => {
        auto.busy--;
        if (auto.busy > 3) setStatus('자막이 밀리고 있어요 — 기기가 느리면 엔진을 "자동 감지 · 빠름"으로 바꿔 보세요.', false, true);
        renderHint();
      });
  },
};

// 말소리가 들리면 먼저 '…' 줄을 띄우고, 받아 적기가 끝나면 채움
function pendingLine() {
  const line = newLine('them');
  line.node.className = 'line pending interim';
  line.trEl.textContent = '…';
  autoscroll();
  return line;
}

function showPartial(line, { text, language }) {
  if (line.closed) return;
  text = cleanTranscript(text);
  if (!text) return;
  const side = language === S.mine && S.their !== S.mine ? 'me' : 'them';
  line.node.className = `line pending interim ${side}`;
  line.srcEl.textContent = text;
  // 기기 안 번역(PC 크롬)이 있으면 말하는 중에도 번역. 온라인 번역은 너무 자주 부르면 막혀서 문장 끝에만
  const [from, to] = sideLangs(side);
  const t = from !== to && readyOnDevice(from, to);
  if (t) t.translate(text).then(out => { if (!line.closed) line.trEl.textContent = out; }).catch(() => {});
  autoscroll();
}

async function autoResult(line, { text, language }) {
  text = cleanTranscript(text);
  if (!text) {
    line.node.remove();
    return;
  }
  const side = await detectSide(text, language);
  const [from, to] = sideLangs(side);
  Object.assign(line, { side, from, to, text });
  line.node.className = `line ${side}`;
  line.srcEl.textContent = text;
  line.trEl.textContent = '';
  translateLine(line);
  autoscroll();
}

// Whisper가 조용한 소리에서 지어내는 흔한 문구·효과음 표시는 버림
const JUNK = [
  /시청해\s*주셔서\s*감사합니다/, /구독(과|이나)?\s*좋아요/, /MBC\s*뉴스/, /자막\s*(제공|by)/i,
  /thanks? (you )?for watching/i, /please subscribe/i, /^(you|bye)\.?$/i,
];

function cleanTranscript(t) {
  t = (t || '')
    .replace(/[[(（【][^\])）】]*[\])）】]/g, '')
    .replace(/[♪♫]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t || /^[\s.,!?…·-]+$/.test(t)) return '';
  if (JUNK.some(re => re.test(t))) return '';
  return t;
}

// 말한 언어가 '상대 언어'인지 '내 언어'인지 판단 → 번역 방향 결정
const SCRIPTS = {
  ko: /[ᄀ-ᇿ㄰-㆏가-힯]/g,
  ja: /[぀-ヿ]/g,
  zh: /[一-鿿]/g,
  th: /[฀-๿]/g,
  ru: /[Ѐ-ӿ]/g,
};
const LATIN = /[a-zÀ-ɏ]/gi;

async function detectSide(text, whisperLang) {
  const a = S.their;
  const b = S.mine;
  // 0) Whisper가 소리로 판별한 언어 (가장 정확)
  if (whisperLang === b && a !== b) return 'me';
  if (whisperLang === a) return 'them';
  // 1) 일본어 가나가 있으면 일본어 (한자만으로는 중국어와 구분 안 됨)
  if ((a === 'ja' || b === 'ja') && /[぀-ヿ]/.test(text)) return b === 'ja' ? 'me' : 'them';
  // 2) 글자 종류로 구분 (한글 ↔ 영어처럼 문자가 다른 경우)
  const ra = SCRIPTS[a] || LATIN;
  const rb = SCRIPTS[b] || LATIN;
  if (ra !== rb) {
    const ca = (text.match(ra) || []).length;
    const cb = (text.match(rb) || []).length;
    if (ca !== cb) return cb > ca ? 'me' : 'them';
  }
  // 3) 브라우저 언어 감지 → 온라인 감지
  return (await detectLanguage(text)) === b ? 'me' : 'them';
}

let languageDetector = null;
async function detectLanguage(text) {
  try {
    if ('LanguageDetector' in self) {
      languageDetector ||= LanguageDetector.create().catch(() => null);
      const d = await languageDetector;
      const top = d && (await d.detect(text))[0];
      if (top && top.confidence > 0.5) return top.detectedLanguage.split('-')[0];
    }
  } catch {}
  try { return (await translateOnlineRaw(text, 'auto', S.mine)).src; } catch { return ''; }
}

// 받아 둔 모델이 있는지 (transformers.js가 쓰는 브라우저 캐시 확인)
async function modelCached(model) {
  try {
    const cache = await caches.open('transformers-cache');
    return !!(await cache.match(`https://huggingface.co/${model}/resolve/main/onnx/decoder_model_merged_quantized.onnx`));
  } catch {
    return false;
  }
}

// 받아 둔 모델이면 페이지를 열자마자 미리 불러와서 시작 버튼을 누르면 바로 들음
function preloadModel() {
  const model = WHISPER_MODEL[S.engine];
  if (!model || asr.requested === model) return;
  modelCached(model).then(hit => { if (hit && WHISPER_MODEL[S.engine] === model) loadModel(model); });
}

async function loadModel(model) {
  if (asr.requested === model && asr.loading) return; // 이미 준비됐거나 준비 중
  const cached = await modelCached(model);
  if (asr.requested === model && asr.loading) return;
  auto.progress = cached ? '음성 모델 불러오는 중…' : '음성 모델 내려받는 중…';
  asr.onProgress = cached ? null : (p, total) => {
    auto.progress = `음성 모델 내려받는 중 ${Math.round(p * 100)}% (${Math.round(total / 1048576)}MB, 처음 한 번만)`;
    setStatus(auto.progress, false, true);
    renderHint();
  };
  setStatus(auto.progress, false, true);
  renderHint();
  try {
    await asr.load(model);
    auto.progress = '';
    setStatus(app.running ? listeningText() : '음성 모델 준비됨 — ▶ 시작을 누르면 바로 들어요');
    if (!cached) navigator.storage?.persist?.().catch(() => {}); // 브라우저가 모델을 지우지 않게 요청
  } catch (err) {
    auto.progress = '';
    setStatus(`음성 모델을 불러오지 못했어요: ${err.message}`, true);
  }
  renderHint();
}

function micDeniedText() {
  if (IS_IOS) return '마이크가 거부됐어요. 설정 > 앱 > Safari(또는 크롬) > 마이크를 "허용"으로 바꾸고 새로고침해 주세요.';
  return '마이크 권한이 거부됐어요. 주소창 왼쪽 아이콘에서 마이크를 허용한 뒤 다시 시작해 주세요.';
}

async function startAuto() {
  if (!window.AudioWorkletNode || !navigator.mediaDevices?.getUserMedia) {
    setStatus('이 브라우저는 너무 오래돼서 자동 감지를 쓸 수 없어요. 최신 크롬·사파리로 열어 주세요.', true);
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx(); // 탭(클릭) 안에서 만들어야 아이폰에서 소리가 들어옴
  ctx.resume().catch(() => {});
  prepareTranslators();
  app.starting = true;
  app.engine = 'auto';
  auto.ctx = ctx;
  renderUI();
  try {
    const tracks = [];
    if (S.mode === 'call' || (S.mode === 'listen' && S.source === 'pc')) tracks.push(await capturePcAudio(false));
    if (S.mode !== 'listen' || S.source === 'mic') {
      try {
        auto.mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        throw new Error(err.name === 'NotAllowedError' ? micDeniedText() : `마이크를 열지 못했어요: ${err.message}`);
      }
      tracks.push(auto.mic.getAudioTracks()[0]);
    }
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    loadModel(WHISPER_MODEL[S.engine]); // 내려받는 동안에도 듣기 시작 → 준비되면 차례로 받아 적음
    auto.partials = true;
    auto.segs = tracks.map(t => new Segmenter(ctx, t, autoHandlers));
    await Promise.all(auto.segs.map(s => s.start()));
    ctx.onstatechange = () => {
      if (app.running && app.engine === 'auto' && ctx.state !== 'running' && ctx.state !== 'closed') {
        app.needsTap = true;
        renderUI();
      }
    };
    app.running = true;
    app.needsTap = ctx.state !== 'running';
    keepAwake();
    if (!auto.progress) setStatus(listeningText());
  } catch (err) {
    cleanupAuto();
    if (app.stream) {
      app.stream.getTracks().forEach(t => t.stop());
      app.stream = null;
    }
    setStatus(err.message, true);
  } finally {
    app.starting = false;
    renderUI();
  }
}

function cleanupAuto() {
  auto.segs.forEach(s => s.stop());
  auto.segs = [];
  auto.mic?.getTracks().forEach(t => t.stop());
  auto.mic = null;
  if (auto.ctx) {
    auto.ctx.onstatechange = null;
    auto.ctx.close().catch(() => {});
    auto.ctx = null;
  }
}

// ===== 설정 바 =====
function fillSelects() {
  el.asr.innerHTML = '';
  for (const [id, label] of Object.entries(ENGINES)) el.asr.add(new Option(label, id));
  el.mode.innerHTML = '';
  for (const [id, label] of Object.entries(MODES)) {
    const o = new Option(label, id);
    if (id === 'call' && !CAN_CAPTURE_PC) { o.disabled = true; o.textContent += ' — PC 전용'; }
    el.mode.add(o);
  }
  if (!CAN_CAPTURE_PC) el.source.querySelector('[value="pc"]').disabled = true;
  for (const sel of [el.their, el.mine]) {
    sel.innerHTML = '';
    LANGS.forEach(l => sel.add(new Option(l.name, l.id)));
  }
}

function renderUI() {
  const r = app.running || app.starting;
  document.body.classList.toggle('running', app.running);
  document.body.classList.toggle('no-src', !S.showSrc);
  document.documentElement.style.setProperty('--fs', `${S.fontSize}px`);
  el.run.textContent = app.running ? '■ 정지' : '▶ 시작';
  el.asr.value = S.engine;
  el.asr.disabled = r;
  el.mode.value = S.mode;
  el.mode.disabled = r;
  el.source.value = S.source;
  el.source.hidden = S.mode !== 'listen';
  el.source.disabled = r;
  el.their.value = S.their;
  el.mine.value = S.mine;
  el.srcToggle.classList.toggle('on', S.showSrc);
  renderHint();

  let speak = '';
  let speakSide = '';
  if (app.running && app.engine === 'chrome' && S.mode === 'talk') {
    speakSide = app.talkSide;
    const lang = app.talkSide === 'them' ? S.their : S.mine;
    speak = `🎙 ${app.talkSide === 'them' ? '상대' : '나'} · ${LANG[lang].name}  ⇄`;
  } else if (app.running && app.ptt) {
    speakSide = app.pttDown ? 'me' : '';
    speak = app.pttDown ? '🎙 내 말 듣는 중…' : '누르고 있는 동안 내 말 (Space)';
  }
  el.speak.hidden = !speak;
  el.speak.textContent = speak;
  el.speak.classList.toggle('me', speakSide === 'me');
  el.speak.classList.toggle('down', app.pttDown);
  document.body.classList.toggle('has-speak', !!speak);
  if (!app.running) showUI(true);
  autoscroll();
}

// 가운데 안내: 시작 전엔 시작 버튼, 듣는 중엔 상태, 아이폰이 멈추면 '탭해서 계속 듣기'
function renderHint(extra = '') {
  const empty = !el.feed.children.length;
  el.hint.hidden = !(empty || app.needsTap);
  el.hint.classList.toggle('overlay', app.needsTap && !empty);
  if (el.hint.hidden) return;
  if (app.needsTap) {
    el.hintBtn.hidden = false;
    el.hintBtn.textContent = '▶ 탭해서 계속 듣기';
    el.hintText.textContent = '아이폰은 듣기가 끊기면 한 번 탭해야 이어서 들어요.';
    return;
  }
  if (app.running && app.engine === 'auto') {
    el.hintBtn.hidden = true;
    el.hintText.textContent = `🎙 ${listeningText()}\n${auto.progress || '아무 언어로나 말해 보세요 — 말이 끝나면 자막이 떠요'}`;
    return;
  }
  if (app.running) {
    const lang = S.mode === 'talk' && app.talkSide === 'me' ? S.mine : S.their;
    el.hintBtn.hidden = true;
    el.hintText.textContent = `🎙 ${listeningText()}${extra ? ` · ${extra}` : ''}\n` +
      (S.mode === 'call' ? '두 사람 말이 들리면 자막이 떠요' : `${LANG[lang].name} 말이 들리면 자막이 떠요`);
    return;
  }
  el.hintBtn.hidden = false;
  el.hintBtn.textContent = '▶ 시작';
  if (S.engine !== 'chrome') {
    const pair = `${LANG[S.their].name} / ${LANG[S.mine].name}`;
    el.hintText.textContent = {
      call: `상대 소리(PC)와 내 마이크를 함께 듣고, 말한 언어(${pair})를 자동으로 알아내 번역해요. 시작하면 뜨는 공유 창에서 통화 창(또는 전체 화면)과 '오디오 공유'를 켜세요.`,
      listen: `${S.source === 'pc' ? 'PC에서 나는 소리' : '마이크로 들리는 말'}을 듣고, 말한 언어(${pair})를 자동으로 알아내 번역해요.`,
      talk: `마이크로 듣고, 누가 무슨 언어(${pair})로 말하든 자동으로 알아내 번역해요.`,
    }[S.mode] + `\n처음 한 번은 음성 모델을 내려받아요 (${S.engine === 'auto-small' ? '약 320MB' : '약 90MB'}).`;
    return;
  }
  el.hintText.textContent = {
    call: "상대 소리(PC)와 내 마이크를 함께 받아 적어요. 시작하면 뜨는 공유 창에서 통화 창(또는 전체 화면)을 고르고 '오디오 공유'를 켜세요. 헤드폰을 쓰면 더 정확해요.",
    listen: S.source === 'pc'
      ? `PC에서 나는 ${LANG[S.their].name} 소리를 받아 적어 ${LANG[S.mine].name}로 번역해요.`
      : `마이크로 들리는 ${LANG[S.their].name} 말을 받아 적어 ${LANG[S.mine].name}로 번역해요.`,
    talk: '마이크 하나로 번갈아 말해요. 아래 버튼(또는 Space)으로 말하는 사람을 바꿔요.',
  }[S.mode] + (IOS_NOT_SAFARI ? '\n\n⚠ 아이폰 크롬·앱 안 브라우저에서는 "언어 고정" 엔진이 안 돼요. "자동 감지"를 쓰거나 사파리로 열어 주세요.' : '');
}

function onLangChange() {
  saveSettings();
  prepareTranslators();
  for (const l of app.listeners) {
    const lang = l.side === 'them' ? S.their : S.mine;
    if (l.lang !== lang) l.switchTo(l.side, lang);
  }
  if (app.running) setStatus(listeningText());
  renderUI();
}

function setFont(delta) {
  S.fontSize = Math.max(14, Math.min(96, S.fontSize + delta));
  saveSettings();
  renderUI();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

let uiTimer = null;
let uiHold = false;
function showUI(stay = false) {
  document.body.classList.add('ui');
  clearTimeout(uiTimer);
  if (app.running && !stay && !uiHold) {
    uiTimer = setTimeout(() => document.body.classList.remove('ui'), 3000);
  }
}

el.run.addEventListener('click', toggleRun);
el.asr.addEventListener('change', () => {
  S.engine = el.asr.value;
  saveSettings();
  if (S.engine === 'chrome' && !SR) setStatus('이 브라우저는 크롬 음성인식을 지원하지 않아요. "자동 감지"를 써 주세요.', true);
  preloadModel();
  renderUI();
});
el.mode.addEventListener('change', () => { S.mode = el.mode.value; saveSettings(); renderUI(); });
el.source.addEventListener('change', () => { S.source = el.source.value; saveSettings(); renderUI(); });
el.their.addEventListener('change', () => { S.their = el.their.value; onLangChange(); });
el.mine.addEventListener('change', () => { S.mine = el.mine.value; onLangChange(); });
el.swap.addEventListener('click', () => { [S.their, S.mine] = [S.mine, S.their]; onLangChange(); });
el.smaller.addEventListener('click', () => setFont(-2));
el.bigger.addEventListener('click', () => setFont(+2));
el.srcToggle.addEventListener('click', () => { S.showSrc = !S.showSrc; saveSettings(); renderUI(); });
el.clear.addEventListener('click', () => {
  el.feed.innerHTML = '';
  live.them = null;
  live.me = null;
  renderHint();
});
el.hintBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (app.needsTap) resumeFromTap();
  else if (!app.running) startApp();
});
// 아이폰: 멈췄을 때 화면 아무 데나 탭해도 이어 듣기
document.addEventListener('click', () => { if (app.needsTap) resumeFromTap(); });
el.full.addEventListener('click', toggleFullscreen);

// 클릭 후 포커스가 남으면 Space가 버튼을 또 누르므로 해제
el.bar.addEventListener('click', e => { if (e.target.closest('button')) e.target.closest('button').blur(); });
el.bar.addEventListener('change', e => e.target.blur());
el.bar.addEventListener('pointerenter', () => { uiHold = true; showUI(); });
el.bar.addEventListener('pointerleave', () => { uiHold = false; showUI(); });
el.bar.addEventListener('focusin', () => { uiHold = true; showUI(); });
el.bar.addEventListener('focusout', () => { uiHold = false; showUI(); });

// 화자 전환 / 누르고 말하기 버튼
el.speak.addEventListener('click', () => { if (S.mode === 'talk') switchSpeaker(); });
el.speak.addEventListener('pointerdown', e => { if (app.ptt) { e.preventDefault(); pttDown(); } });
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.speak.addEventListener(ev, () => { if (app.ptt) pttUp(); });

document.addEventListener('mousemove', () => showUI());
document.addEventListener('touchstart', () => showUI(), { passive: true });

// 단축키 (한글 입력 상태에서도 동작하도록 e.code 사용)
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest && e.target.closest('select, input, textarea')) return;
  switch (e.code) {
    case 'KeyS': toggleRun(); break;
    case 'KeyF': toggleFullscreen(); break;
    case 'Equal': case 'NumpadAdd': setFont(+2); break;
    case 'Minus': case 'NumpadSubtract': setFont(-2); break;
    case 'Space':
      e.preventDefault();
      if (e.repeat) return;
      if (S.mode === 'talk') switchSpeaker();
      else if (app.ptt) pttDown();
      return;
    default: return;
  }
  showUI();
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space') { e.preventDefault(); if (app.ptt) pttUp(); }
});

// ===== 데모 (?demo=1): 예문을 인식 결과처럼 흘려보내 화면·번역 확인 =====
const DEMO_SCRIPT = [
  ['them', "Hi everyone, thanks for joining today's meeting."],
  ['me', '안녕하세요, 초대해 주셔서 감사합니다.'],
  ['them', "Let's start with a quick update on the project timeline."],
  ['me', '네, 지난주에 첫 번째 테스트를 끝냈습니다.'],
  ['them', 'Great. Do you think we can ship the beta by the end of this month?'],
  ['me', '아마 가능할 것 같은데, 결과를 한 번 더 확인해 보겠습니다.'],
];

async function runDemo() {
  S.their = 'en';
  S.mine = 'ko';
  renderUI();
  setStatus('데모 재생 중');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (const [side, text] of DEMO_SCRIPT) {
    const words = text.split(' ');
    for (let i = 1; i <= words.length; i++) {
      showInterim(side, words.slice(0, i).join(' '));
      await sleep(140);
    }
    commit(side, text);
    await sleep(900);
  }
  setStatus('데모 끝 — 실제로 쓰려면 ▶ 시작');
}

// ===== 시작 =====
fillSelects();
renderUI();
if (!SR && S.engine === 'chrome') setStatus('이 브라우저는 크롬 음성인식을 지원하지 않아요. "자동 감지"를 써 주세요.', true);
setEngine('Translator' in self ? '기기 내 (첫 시작 때 준비)' : '온라인');
if (DEMO) runDemo();
else preloadModel();
