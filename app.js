const app = document.querySelector('.app-shell');
const layer = document.querySelector('[data-sheet-layer]');
const sheet = document.querySelector('[data-sheet]');
const backdrop = document.querySelector('[data-backdrop]');
const closeButton = document.querySelector('[data-close]');
const actionButton = document.querySelector('[data-action]');
const replayButton = document.querySelector('[data-replay]');
const dragZone = document.querySelector('[data-drag-zone]');
const sparkles = [...document.querySelectorAll('.sparkle')];
const parallaxLayer = document.querySelector('.ghost-title');
const savingElement = document.querySelector('[data-saving]');
const odometerSettleTrack = document.querySelector('.digit-track--hundreds');
const odometerTickTrack = document.querySelector('.digit-track--tens');
const fallbackAudio = Object.fromEntries(
  [...document.querySelectorAll('[data-sfx]')].map((element) => [element.dataset.sfx, element]),
);

let startY = 0;
let currentY = 0;
let startTime = 0;
let dragging = false;
let closeTimer;
let amountRevealChimeTimer;
let savingsStartTimer;
let savingsSettleTimer;
let sheetExpandTimer;
let sequenceCompleteTimer;
let odometerTickTimer;
let odometerTickFrame;
let savingsSequenceStartedAt = 0;
let amountRevealSoundPlayed = false;
let savingsSettleSoundPlayed = false;
let lastSheetHapticAt = 0;
let lastDigitHapticAt = 0;
const twinkleTimers = new Set();
const twinkleAnimations = new Set();
const activeTwinkleAnimations = new Map();
let twinkleState = [];
let brightStarIndices = [];
let dimStarIndex = 0;

const AudioContextClass = window.AudioContext || window.webkitAudioContext;
let audioContext;
let audioMaster;
let audioCompressor;
let audioArmed = false;
let fallbackAudioReady = false;
let fallbackAudioPrimed = false;
let activeChimeOscillators = [];
let activeTickOscillators = [];

const HAPTIC_TIMING = Object.freeze({
  mediumPulseMs: 35,
  duplicateGuardMs: 500,
  digitPulseMs: 8,
  digitPulseGuardMs: 42,
});

function hapticsCanPlay() {
  if (app.dataset.haptics === 'off') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  if (typeof navigator.vibrate !== 'function') return false;
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return false;
  return true;
}

function triggerSheetOpenHaptic() {
  if (!hapticsCanPlay()) return false;

  const now = performance.now();
  if (now - lastSheetHapticAt < HAPTIC_TIMING.duplicateGuardMs) return false;
  lastSheetHapticAt = now;
  return navigator.vibrate(HAPTIC_TIMING.mediumPulseMs);
}

function triggerOdometerHaptic() {
  if (!hapticsCanPlay()) return false;

  const now = performance.now();
  if (now - lastDigitHapticAt < HAPTIC_TIMING.digitPulseGuardMs) return false;
  lastDigitHapticAt = now;
  return navigator.vibrate(HAPTIC_TIMING.digitPulseMs);
}

function appIsMuted() {
  return app.dataset.muted === 'true' || document.documentElement.dataset.muted === 'true';
}

function stopOscillators(oscillators) {
  oscillators.forEach((oscillator) => {
    try { oscillator.stop(); } catch (_) { /* The voice has already ended. */ }
  });
}

function stopAudioVoices() {
  stopOscillators(activeChimeOscillators);
  activeChimeOscillators = [];
  stopOscillators(activeTickOscillators);
  activeTickOscillators = [];
  Object.values(fallbackAudio).forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function wavDataUri(kind) {
  const sampleRate = 22050;
  const duration = kind === 'tick' ? .06 : (kind === 'settled' ? .72 : .6);
  const sampleCount = Math.ceil(sampleRate * duration);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const profile = kind === 'tick'
    ? [[470, .7, 28], [1180, .2, 52]]
    : kind === 'settled'
      ? [[261.63, .27, 5.2], [659.25, .4, 4.8], [987.77, .18, 5.8]]
      : [[220, .28, 6], [523.25, .4, 5.5], [783.99, .15, 6.4]];

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeAscii(view, 8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, sampleCount * 2, true);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const attack = Math.min(time / (kind === 'tick' ? .0015 : .012), 1);
    const sample = profile.reduce((sum, [frequency, amplitude, decay]) => {
      const pitchDrop = kind === 'tick' ? Math.exp(-time * 7) : 1;
      return sum + Math.sin(2 * Math.PI * frequency * pitchDrop * time) * amplitude * Math.exp(-time * decay);
    }, 0) * attack;
    const softened = Math.tanh(sample * 1.15) * .58;
    view.setInt16(44 + index * 2, Math.round(softened * 32767), true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function ensureFallbackAudio() {
  if (fallbackAudioReady) return;
  Object.entries(fallbackAudio).forEach(([kind, audio]) => {
    if (!audio.getAttribute('src')) audio.src = wavDataUri(kind);
    audio.volume = kind === 'tick' ? .2 : (kind === 'settled' ? .3 : .27);
    audio.playbackRate = Number(audio.dataset.playbackRate || 1);
    audio.preservesPitch = false;
    audio.webkitPreservesPitch = false;
    audio.load();
  });
  fallbackAudioReady = true;
}

function playFallback(kind) {
  const audio = fallbackAudio[kind];
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
  audio.playbackRate = Number(audio.dataset.playbackRate || 1);
  audio.play().catch(() => {});
}

function ensureAudioContext() {
  if (!AudioContextClass || audioContext) return;
  audioContext = new AudioContextClass();
  audioMaster = audioContext.createGain();
  audioCompressor = audioContext.createDynamicsCompressor();
  audioMaster.gain.value = .74;
  audioCompressor.threshold.value = -24;
  audioCompressor.knee.value = 18;
  audioCompressor.ratio.value = 3;
  audioCompressor.attack.value = .004;
  audioCompressor.release.value = .16;
  audioMaster.connect(audioCompressor);
  audioCompressor.connect(audioContext.destination);
}

function primeAudioContext() {
  ensureFallbackAudio();
  if (!fallbackAudioPrimed) {
    fallbackAudioPrimed = true;
    Object.values(fallbackAudio).forEach((audio) => {
      audio.muted = true;
      const priming = audio.play();
      if (priming) priming.then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = false;
      }).catch(() => { audio.muted = false; });
    });
  }
  if (!audioContext || !audioMaster) return;
  const silentOscillator = audioContext.createOscillator();
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  silentOscillator.connect(silentGain);
  silentGain.connect(audioMaster);
  silentOscillator.start();
  silentOscillator.stop(audioContext.currentTime + .01);
}

function audioCanPlay() {
  return audioArmed && !appIsMuted() && (
    audioContext?.state === 'running' || fallbackAudioReady
  );
}

function unlockAudio() {
  audioArmed = true;
  ensureAudioContext();
  primeAudioContext();
  if (!audioContext) return;
  audioContext.resume().then(() => {
    const elapsed = performance.now() - savingsSequenceStartedAt;
    const rollStart = SAVINGS_TIMING.rollAtMs;
    if (savingsSequenceStartedAt && elapsed >= rollStart && elapsed < SAVINGS_TIMING.settleAtMs) {
      startOdometerTicks();
    }
  }).catch(() => {});
}

function createTone({
  frequency,
  gain,
  duration,
  delay = 0,
  type = 'sine',
  endFrequency,
  attack = .012,
  filterFrequency = 2600,
}) {
  const oscillator = audioContext.createOscillator();
  const envelope = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();
  const start = audioContext.currentTime + delay;
  const end = start + duration;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, end);
  filter.type = 'lowpass';
  filter.frequency.value = filterFrequency;
  filter.Q.value = .55;
  envelope.gain.setValueAtTime(.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + attack);
  envelope.gain.exponentialRampToValueAtTime(.0001, end);
  oscillator.connect(filter);
  filter.connect(envelope);
  envelope.connect(audioMaster);
  oscillator.start(start);
  oscillator.stop(end + .02);
  return oscillator;
}

function playChime(kind) {
  if (!audioCanPlay()) return;
  stopAudioVoices();
  if (kind === 'settled' || fallbackAudio.reveal.getAttribute('src')) {
    playFallback(kind === 'settled' ? 'settled' : 'reveal');
    return;
  }
  if (!audioContext) return;
  const settled = kind === 'settled';
  activeChimeOscillators = settled
    ? [
      // Compact dark-glass resolve: rewarding without a bright notification ding.
      createTone({ frequency: 261.63, endFrequency: 246.94, gain: .03, duration: .34, type: 'triangle', filterFrequency: 1250 }),
      createTone({ frequency: 659.25, gain: .032, duration: .58, delay: .035, filterFrequency: 2300 }),
      createTone({ frequency: 987.77, gain: .015, duration: .7, delay: .09, filterFrequency: 3200 }),
    ]
    : [
      // Restrained opening cue with a warm body and small metallic highlight.
      createTone({ frequency: 220, endFrequency: 207.65, gain: .026, duration: .28, type: 'triangle', filterFrequency: 1100 }),
      createTone({ frequency: 523.25, gain: .028, duration: .48, delay: .028, filterFrequency: 2100 }),
      createTone({ frequency: 783.99, gain: .012, duration: .58, delay: .075, filterFrequency: 3000 }),
    ];
}

function playOdometerTick() {
  if (!audioCanPlay()) return;
  if (!audioContext || audioContext.state !== 'running') {
    fallbackAudio.tick.pause();
    fallbackAudio.tick.currentTime = 0;
    playFallback('tick');
    return;
  }
  stopOscillators(activeTickOscillators);
  activeTickOscillators = [
    createTone({
      frequency: 470,
      endFrequency: 315,
      gain: .017,
      duration: .034,
      attack: .002,
      type: 'triangle',
      filterFrequency: 1450,
    }),
    createTone({
      frequency: 1180,
      endFrequency: 820,
      gain: .005,
      duration: .021,
      attack: .0015,
      type: 'square',
      filterFrequency: 1750,
    }),
  ];
}

function reelTranslateY(element) {
  const transform = getComputedStyle(element).transform;
  if (!transform || transform === 'none') return 0;
  const values = transform.match(/matrix(?:3d)?\(([^)]+)\)/)?.[1].split(',').map(Number);
  return values ? (values.length === 16 ? values[13] : values[5]) : 0;
}

function stopOdometerTicks() {
  window.clearTimeout(odometerTickTimer);
  window.cancelAnimationFrame(odometerTickFrame);
  odometerTickTimer = undefined;
  odometerTickFrame = undefined;
  stopOscillators(activeTickOscillators);
  activeTickOscillators = [];
  if (fallbackAudio.tick) {
    fallbackAudio.tick.pause();
    fallbackAudio.tick.currentTime = 0;
  }
}

function startOdometerTicks() {
  stopOdometerTicks();
  if (!audioCanPlay() && !hapticsCanPlay()) return;
  let lastDigit = Math.round(Math.abs(reelTranslateY(odometerTickTrack)) / 48);

  const followReel = () => {
    const currentDigit = Math.round(Math.abs(reelTranslateY(odometerTickTrack)) / 48);
    if (currentDigit > lastDigit) {
      playOdometerTick();
      triggerOdometerHaptic();
      lastDigit = currentDigit;
    }
    if (currentDigit < 10 && app.classList.contains('is-savings-animating')) {
      odometerTickFrame = window.requestAnimationFrame(followReel);
    }
  };

  odometerTickFrame = window.requestAnimationFrame(followReel);
}

const TWINKLE_ENTRANCE_END_MS = [2430, 2490, 2550];

function randomBetween(minimum, maximum) {
  return minimum + Math.random() * (maximum - minimum);
}

function stopTwinkles() {
  twinkleTimers.forEach((timer) => window.clearTimeout(timer));
  twinkleTimers.clear();
  twinkleAnimations.forEach((animation) => animation.cancel());
  twinkleAnimations.clear();
  activeTwinkleAnimations.clear();
}

function animateTwinkle(star, keyframes, duration, delay = 0) {
  const previous = activeTwinkleAnimations.get(star);
  if (previous) {
    previous.cancel();
    twinkleAnimations.delete(previous);
  }
  const animation = star.animate(keyframes, {
    duration,
    delay,
    easing: 'cubic-bezier(.37, 0, .2, 1)',
    fill: 'forwards',
  });
  activeTwinkleAnimations.set(star, animation);
  twinkleAnimations.add(animation);
  return animation;
}

function runTwinkleCycle() {
  if (!app.classList.contains('is-open')) return;

  const outgoingIndex = brightStarIndices[Math.random() < .5 ? 0 : 1];
  const keeperIndex = brightStarIndices.find((index) => index !== outgoingIndex);
  const incomingIndex = dimStarIndex;
  const outgoingDuration = randomBetween(1200, 1900);
  const incomingDelay = randomBetween(120, 420);
  const incomingDuration = randomBetween(950, 1650);
  const keeperDuration = randomBetween(1400, 2200);
  const nextState = [...twinkleState];

  nextState[outgoingIndex] = {
    opacity: randomBetween(.15, .3),
    scale: randomBetween(.75, .88),
  };
  nextState[incomingIndex] = {
    opacity: randomBetween(.82, 1),
    scale: randomBetween(1.03, 1.15),
  };
  nextState[keeperIndex] = {
    opacity: randomBetween(.52, .78),
    scale: randomBetween(.92, 1.06),
  };

  animateTwinkle(sparkles[outgoingIndex], [
    { opacity: twinkleState[outgoingIndex].opacity, transform: `scale(${twinkleState[outgoingIndex].scale})` },
    { opacity: Math.max(.35, twinkleState[outgoingIndex].opacity * .68), transform: `scale(${randomBetween(.86, .96)})`, offset: .42 },
    { opacity: nextState[outgoingIndex].opacity, transform: `scale(${nextState[outgoingIndex].scale})` },
  ], outgoingDuration);

  animateTwinkle(sparkles[incomingIndex], [
    { opacity: twinkleState[incomingIndex].opacity, transform: `scale(${twinkleState[incomingIndex].scale})` },
    { opacity: nextState[incomingIndex].opacity * .72, transform: `scale(${randomBetween(.9, 1.02)})`, offset: .62 },
    { opacity: nextState[incomingIndex].opacity, transform: `scale(${nextState[incomingIndex].scale})` },
  ], incomingDuration, incomingDelay);

  animateTwinkle(sparkles[keeperIndex], [
    { opacity: twinkleState[keeperIndex].opacity, transform: `scale(${twinkleState[keeperIndex].scale})` },
    { opacity: randomBetween(.58, .82), transform: `scale(${randomBetween(.95, 1.08)})`, offset: randomBetween(.38, .62) },
    { opacity: nextState[keeperIndex].opacity, transform: `scale(${nextState[keeperIndex].scale})` },
  ], keeperDuration);

  twinkleState = nextState;
  brightStarIndices = [keeperIndex, incomingIndex];
  dimStarIndex = outgoingIndex;

  const cycleDuration = Math.max(outgoingDuration, incomingDelay + incomingDuration, keeperDuration);
  const timer = window.setTimeout(() => {
    twinkleTimers.delete(timer);
    runTwinkleCycle();
  }, cycleDuration + randomBetween(650, 1450));
  twinkleTimers.add(timer);
}

function startTwinkles() {
  stopTwinkles();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const indices = sparkles.map((_, index) => index).sort(() => Math.random() - .5);
  brightStarIndices = indices.slice(0, 2);
  dimStarIndex = indices[2];
  twinkleState = sparkles.map((star, index) => {
    const brightPosition = brightStarIndices.indexOf(index);
    const state = brightPosition === 0
      ? { opacity: randomBetween(.82, .96), scale: randomBetween(1.02, 1.1) }
      : brightPosition === 1
        ? { opacity: randomBetween(.5, .72), scale: randomBetween(.9, 1.02) }
        : { opacity: randomBetween(.15, .26), scale: randomBetween(.75, .86) };
    star.style.setProperty('--sparkle-entry-opacity', state.opacity);
    star.style.setProperty('--sparkle-entry-scale', state.scale);
    return state;
  });

  const timer = window.setTimeout(() => {
    twinkleTimers.delete(timer);
    runTwinkleCycle();
  }, Math.max(...TWINKLE_ENTRANCE_END_MS) + 120);
  twinkleTimers.add(timer);
}

const SAVINGS_TIMING = Object.freeze({
  parallaxCompleteAtMs: 2470,
  firstSoundGapMs: 300,
  entranceDelayMs: 2600,
  rollAtMs: 2710,
  settleAtMs: 3850,
  sheetExpandAtMs: 4100,
  completeAtMs: 7600,
});

function playAmountRevealSound() {
  if (amountRevealSoundPlayed) return;
  amountRevealSoundPlayed = true;
  window.clearTimeout(amountRevealChimeTimer);
  parallaxLayer.removeEventListener('animationend', onParallaxAnimationEnd);
  playChime('reveal');
}

function onParallaxAnimationEnd(event) {
  if (event.animationName !== 'parallax-rise') return;
  parallaxLayer.removeEventListener('animationend', onParallaxAnimationEnd);
  window.clearTimeout(amountRevealChimeTimer);
  amountRevealChimeTimer = window.setTimeout(
    playAmountRevealSound,
    SAVINGS_TIMING.firstSoundGapMs,
  );
}

function startTickSoundOnRoll(event) {
  if (event.animationName !== 'roll-zero') return;
  window.clearTimeout(odometerTickTimer);
  odometerTickTrack.removeEventListener('animationstart', startTickSoundOnRoll);
  startOdometerTicks();
}

function startTickSoundFallback() {
  odometerTickTrack.removeEventListener('animationstart', startTickSoundOnRoll);
  startOdometerTicks();
}

function completeSavingsSettle() {
  if (savingsSettleSoundPlayed) return;
  savingsSettleSoundPlayed = true;
  window.clearTimeout(savingsSettleTimer);
  odometerSettleTrack.removeEventListener('animationend', onOdometerAnimationEnd);
  stopOdometerTicks();
  savingElement.setAttribute('aria-label', '₹800');
  playChime('settled');
}

function onOdometerAnimationEnd(event) {
  if (event.animationName === 'roll-hundreds') completeSavingsSettle();
}

function removeSoundSyncListeners() {
  parallaxLayer.removeEventListener('animationend', onParallaxAnimationEnd);
  odometerTickTrack.removeEventListener('animationstart', startTickSoundOnRoll);
  odometerSettleTrack.removeEventListener('animationend', onOdometerAnimationEnd);
}

function startSavingsAnimation() {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const delay = (milliseconds) => reduceMotion ? 0 : milliseconds;
  savingsSequenceStartedAt = performance.now();
  savingsSettleSoundPlayed = false;
  odometerTickTrack.addEventListener('animationstart', startTickSoundOnRoll);
  odometerSettleTrack.addEventListener('animationend', onOdometerAnimationEnd);
  app.classList.add('is-savings-animating');
  odometerTickTimer = window.setTimeout(startTickSoundFallback, delay(SAVINGS_TIMING.rollAtMs + 80));
  savingsSettleTimer = window.setTimeout(completeSavingsSettle, delay(SAVINGS_TIMING.settleAtMs + 120));
  sheetExpandTimer = window.setTimeout(() => {
    app.classList.add('is-tooltip-revealed');
  }, delay(SAVINGS_TIMING.sheetExpandAtMs));
  sequenceCompleteTimer = window.setTimeout(() => {
    app.classList.add('is-sequence-complete');
  }, delay(SAVINGS_TIMING.completeAtMs));
}

function openSheet() {
  triggerSheetOpenHaptic();
  removeSoundSyncListeners();
  stopTwinkles();
  stopOdometerTicks();
  stopAudioVoices();
  savingsSequenceStartedAt = 0;
  window.clearTimeout(closeTimer);
  window.clearTimeout(amountRevealChimeTimer);
  window.clearTimeout(savingsStartTimer);
  window.clearTimeout(savingsSettleTimer);
  window.clearTimeout(sheetExpandTimer);
  window.clearTimeout(sequenceCompleteTimer);
  amountRevealSoundPlayed = false;
  savingsSettleSoundPlayed = false;
  app.classList.remove('is-savings-animating', 'is-tooltip-revealed', 'is-sequence-complete');
  savingElement.setAttribute('aria-label', '₹300');
  app.classList.add('is-dimming');
  layer.style.removeProperty('--sheet-offset');
  layer.classList.remove('is-dragging', 'is-settling');
  app.classList.remove('is-closing', 'is-closed');
  // Force a new animation timeline when replayed.
  void sheet.offsetWidth;
  parallaxLayer.addEventListener('animationend', onParallaxAnimationEnd);
  app.classList.add('is-open');
  startTwinkles();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  amountRevealChimeTimer = window.setTimeout(
    playAmountRevealSound,
    reduceMotion
      ? 0
      : SAVINGS_TIMING.parallaxCompleteAtMs + SAVINGS_TIMING.firstSoundGapMs + 120,
  );
  savingsStartTimer = window.setTimeout(startSavingsAnimation, reduceMotion ? 0 : SAVINGS_TIMING.entranceDelayMs);
  closeButton.focus({ preventScroll: true });
}

function closeSheet() {
  if (!app.classList.contains('is-open')) return;
  app.classList.remove('is-open');
  app.classList.add('is-closing');
  stopTwinkles();
  stopOdometerTicks();
  stopAudioVoices();
  removeSoundSyncListeners();
  savingsSequenceStartedAt = 0;
  window.clearTimeout(amountRevealChimeTimer);
  window.clearTimeout(savingsStartTimer);
  window.clearTimeout(savingsSettleTimer);
  window.clearTimeout(sheetExpandTimer);
  window.clearTimeout(sequenceCompleteTimer);
  layer.classList.remove('is-dragging', 'is-settling');
  closeTimer = window.setTimeout(() => {
    app.classList.remove('is-closing', 'is-dimming');
    app.classList.add('is-closed');
    layer.style.removeProperty('--sheet-offset');
    replayButton.focus({ preventScroll: true });
  }, 440);
}

function onPointerDown(event) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (event.target.closest('button')) return;
  dragging = true;
  startY = event.clientY;
  currentY = 0;
  startTime = performance.now();
  layer.classList.remove('is-settling');
  layer.classList.add('is-dragging');
  sheet.setPointerCapture(event.pointerId);
}

function onPointerMove(event) {
  if (!dragging) return;
  currentY = Math.max(0, event.clientY - startY);
  layer.style.setProperty('--sheet-offset', `${currentY}px`);
  const progress = Math.min(currentY / 320, 1);
  backdrop.style.opacity = String(1 - progress * .82);
}

function onPointerUp(event) {
  if (!dragging) return;
  dragging = false;
  const elapsed = Math.max(performance.now() - startTime, 1);
  const velocity = currentY / elapsed;
  sheet.releasePointerCapture(event.pointerId);
  backdrop.style.removeProperty('opacity');

  if (currentY > 110 || velocity > .75) {
    closeSheet();
    return;
  }

  layer.classList.remove('is-dragging');
  layer.classList.add('is-settling');
  layer.style.setProperty('--sheet-offset', '0px');
  window.setTimeout(() => layer.classList.remove('is-settling'), 430);
}

closeButton.addEventListener('click', closeSheet);
actionButton.addEventListener('click', closeSheet);
backdrop.addEventListener('click', closeSheet);
replayButton.addEventListener('click', () => {
  // Trigger within the tap's user-activation window; openSheet is delayed for dimming.
  triggerSheetOpenHaptic();
  app.classList.add('is-dimming');
  window.setTimeout(openSheet, 240);
});
sheet.addEventListener('pointerdown', onPointerDown);
sheet.addEventListener('pointermove', onPointerMove);
sheet.addEventListener('pointerup', onPointerUp);
sheet.addEventListener('pointercancel', onPointerUp);

document.addEventListener('pointerdown', unlockAudio, { capture: true });
document.addEventListener('touchend', unlockAudio, { capture: true });
document.addEventListener('click', unlockAudio, { capture: true });
document.addEventListener('keydown', unlockAudio, { capture: true });

const muteObserver = new MutationObserver(() => {
  if (appIsMuted()) {
    stopOdometerTicks();
    stopAudioVoices();
  }
});
muteObserver.observe(app, { attributes: true, attributeFilter: ['data-muted'] });
muteObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-muted'] });

app.addEventListener('mutechange', (event) => {
  if (typeof event.detail?.muted === 'boolean') {
    app.dataset.muted = String(event.detail.muted);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopOdometerTicks();
    stopAudioVoices();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSheet();
});

window.addEventListener('load', () => {
  window.setTimeout(() => app.classList.add('is-dimming'), 80);
  window.setTimeout(openSheet, 420);
});
