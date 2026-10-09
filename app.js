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
const DEFAULTS = { mode: 'call', source: 'mic', their: 'en', mine: 'ko', fontSize: IS_MOBILE ? 24 : 36, showSrc: true };
const S = loadSettings();

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('lt-settings') || '{}') || {}; } catch {}
  const s = { ...DEFAULTS, ...saved };
  if (!LANG[s.their]) s.their = DEFAULTS.their;
  if (!LANG[s.mine]) s.mine = DEFAULTS.mine;
  if (!MODES[s.mode]) s.mode = DEFAULTS.mode;
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
  run: $('run'), mode: $('mode'), source: $('source'), their: $('their'), mine: $('mine'),
  swap: $('swap'), smaller: $('smaller'), bigger: $('bigger'), srcToggle: $('srcToggle'),
  clear: $('clear'), full: $('full'), speak: $('speak'), status: $('status'), msg: $('msg'), engine: $('engine'),
};

function setStatus(text, isErr = false) {
  el.msg.textContent = text;
  el.status.classList.toggle('err', isErr);
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
            setStatus(`번역 모델 내려받는 중 ${Math.round(e.loaded * 100)}% (그동안은 온라인 번역)`);
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
  const sl = LANG[from].web || from;
  const tl = LANG[to].web || to;
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t' +
    `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text.slice(0, 1500))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data[0] || []).map(seg => seg[0]).join('');
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
  if (IOS_NOT_SAFARI) return '아이폰은 사파리에서만 음성인식이 돼요. 이 주소를 사파리로 열어 주세요.';
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
  for (const l of app.listeners) if (l.waitingTap) l.start(); // 탭 안에서 바로 시작
  renderUI();
}

// ===== 실행 상태 =====
const app = {
  running: false,
  starting: false,
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
  if (!app.running || S.mode !== 'talk') return;
  app.talkSide = app.talkSide === 'them' ? 'me' : 'them';
  app.listeners[0].switchTo(app.talkSide, app.talkSide === 'them' ? S.their : S.mine);
  setStatus(listeningText());
  renderUI();
}

function listeningText() {
  if (S.mode === 'talk') {
    const lang = app.talkSide === 'them' ? S.their : S.mine;
    return `듣는 중 · ${app.talkSide === 'them' ? '상대' : '나'} (${LANG[lang].name})`;
  }
  if (S.mode === 'listen') return `듣는 중 · ${LANG[S.their].name} → ${LANG[S.mine].name}`;
  return `듣는 중 · 상대 ${LANG[S.their].name} ⇄ 나 ${LANG[S.mine].name}`;
}

async function startApp() {
  if (app.running || app.starting) return;
  if (!SR) {
    setStatus('이 브라우저는 음성인식을 지원하지 않아요. PC·안드로이드는 크롬, 아이폰은 사파리로 열어 주세요.', true);
    return;
  }
  prepareTranslators(); // 클릭 직후(사용자 동작 안)에 호출
  const needPc = S.mode === 'call' || (S.mode === 'listen' && S.source === 'pc');
  app.starting = true;
  try {
    let audioTrack = null;
    if (needPc) audioTrack = await capturePcAudio();
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

async function capturePcAudio() {
  if (!CAN_CAPTURE_PC) throw new Error('이 기기에서는 PC 소리를 받을 수 없어요. 소리 입력을 마이크로 바꿔 주세요.');
  if (!TRACK_INPUT_OK) throw new Error('PC 소리 인식은 최신 크롬이 필요해요. 크롬을 업데이트해 주세요.');
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

// ===== 설정 바 =====
function fillSelects() {
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
  if (app.running && S.mode === 'talk') {
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
  if (app.running) {
    const lang = S.mode === 'talk' && app.talkSide === 'me' ? S.mine : S.their;
    el.hintBtn.hidden = true;
    el.hintText.textContent = `🎙 ${listeningText()}${extra ? ` · ${extra}` : ''}\n` +
      (S.mode === 'call' ? '두 사람 말이 들리면 자막이 떠요' : `${LANG[lang].name} 말이 들리면 자막이 떠요`);
    return;
  }
  el.hintBtn.hidden = false;
  el.hintBtn.textContent = '▶ 시작';
  el.hintText.textContent = {
    call: "상대 소리(PC)와 내 마이크를 함께 받아 적어요. 시작하면 뜨는 공유 창에서 통화 창(또는 전체 화면)을 고르고 '오디오 공유'를 켜세요. 헤드폰을 쓰면 더 정확해요.",
    listen: S.source === 'pc'
      ? `PC에서 나는 ${LANG[S.their].name} 소리를 받아 적어 ${LANG[S.mine].name}로 번역해요.`
      : `마이크로 들리는 ${LANG[S.their].name} 말을 받아 적어 ${LANG[S.mine].name}로 번역해요.`,
    talk: '마이크 하나로 번갈아 말해요. 아래 버튼(또는 Space)으로 말하는 사람을 바꿔요.',
  }[S.mode] + (IOS_NOT_SAFARI ? '\n\n⚠ 아이폰은 사파리에서만 음성인식이 돼요. 이 주소를 사파리로 열어 주세요.' : '');
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
if (!SR) setStatus('이 브라우저는 음성인식을 지원하지 않아요. PC·안드로이드는 크롬, 아이폰은 사파리로 열어 주세요.', true);
setEngine('Translator' in self ? '기기 내 (첫 시작 때 준비)' : '온라인');
if (DEMO) runDemo();
