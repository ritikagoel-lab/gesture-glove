'use strict';

const arena = byId('berries');
const paint = arena.getContext('2d');
const startGameButton = byId('start-game');
const previewGameButton = byId('preview-game');
const gameMessage = byId('game-message');

let settings;
let board = [];
let target = [1, 1];
let score = 0;
let lives = 3;
let remaining = 60;
let playing = false;
let previewMode = false;
let controlTimestamp = null;
const aimAxes = Array.from({length: 2}, () => ({ filtered: 0, angle: 0 }));

function resetAim() {
  controlTimestamp = latestSample?.timestamp_us ?? null;
  for (const axis of aimAxes) Object.assign(axis, { filtered: 0, angle: 0 });
}

function aimFromSample() {
  const timestamp = latestSample.timestamp_us;
  const dt = controlTimestamp === null ? 0.02 : ((timestamp-controlTimestamp) >>> 0) / 1e6;
  controlTimestamp = timestamp;
  if (dt <= 0 || dt >= .2) return;
  const gyro = latestSample.imu.gyro_mdps.map((value,i)=>value/1000-gyroBias[i]);
  const rate = rotate(pose, gyro);
  // In the viewer frame, clockwise Z tilts fingers right. Negative X
  // turns the outward-facing breadboard upward.
  const controls = [-rate[2], -rate[0]];
  const step = controls.map((value,i)=>{
    const axis = aimAxes[i];
    axis.filtered += (value-axis.filtered)*(1-Math.exp(-dt/.035));
    if (Math.abs(axis.filtered) < settings.controls.deadzoneDps) {
      axis.angle = 0;
      return 0;
    }
    if (Math.sign(axis.angle) !== Math.sign(axis.filtered)) axis.angle = 0;
    axis.angle += axis.filtered*dt;
    if (Math.abs(axis.angle) < settings.controls.degreesPerCell) return 0;
    const direction = Math.sign(axis.angle);
    axis.angle -= direction*settings.controls.degreesPerCell;
    return direction;
  });
  moveTarget(step[0],step[1]);
  const labels = ['Left','Center','Right'];
  const rows = ['Top','Middle','Bottom'];
  const active = Math.abs(controls[0]) > Math.abs(controls[1]) ? 0 : 1;
  const direction = Math.abs(aimAxes[active].filtered) < settings.controls.deadzoneDps
    ? 'Steady' : active === 0 ? (controls[0]>0?'Tilting right':'Tilting left') :
      controls[1]>0?'Tilting up':'Tilting down';
  byId('aim-feedback').value = rows[target[1]]+' '+labels[target[0]]+' · '+direction;
}
let previousPinch = false;
let processedTimestamp = null;
let lastGameFrame = null;
let spawnTimer = 0;
let effect = null;
let paused = false;

function feedback(message) {
  if (gameMessage.textContent !== message) gameMessage.textContent = message;
}

function sensorReady(now) {
  return Boolean(port && calibrated && !calibration && latestSample &&
    latestSample.force.adc !== null && now - lastSampleTime < 750 && !demo);
}

function moveTarget(dx, dy) {
  const limit = settings.gridSize - 1;
  target[0] = Math.max(0, Math.min(limit, target[0] + dx));
  target[1] = Math.max(0, Math.min(limit, target[1] - dy));
}

function squish() {
  const index = target[1] * settings.gridSize + target[0];
  const berry = board[index];
  if (!berry) {
    feedback('Empty space. Move the target to a moldy berry.');
    return;
  }
  if (!berry.moldy) {
    feedback('That berry is fresh. Keep it and look for brown berries with white mold.');
    return;
  }
  score += settings.pointsPerSquish;
  board[index] = null;
  effect = { index, age: 0 };
  feedback('Squished! +'+settings.pointsPerSquish+' points. Keep the fresh strawberries growing.');
}

function spawnBerry() {
  // With a full board, a healthy berry may turn moldy.
  const empty = board.flatMap((berry, index) => berry ? [] : [index]);
  const moldy = Math.random() < settings.moldProbability;
  if (!empty.length) {
    const healthy = board.flatMap((berry, index) => !berry.moldy ? [index] : []);
    if (moldy && healthy.length) {
      const index = healthy[Math.floor(Math.random() * healthy.length)];
      board[index] = { moldy: true, age: 0 };
    }
    return;
  }
  const index = empty[Math.floor(Math.random() * empty.length)];
  board[index] = { moldy, age: 0 };
}

function startGame(preview) {
  if (!settings || (!preview && !sensorReady(performance.now()))) return;
  previewMode = preview;
  playing = true;
  paused = false;
  score = 0;
  lives = settings.lives;
  remaining = settings.roundSeconds;
  target = [Math.floor(settings.gridSize / 2), Math.floor(settings.gridSize / 2)];
  board = Array(settings.gridSize ** 2).fill(null);
  effect = null;
  spawnTimer = 0;
  processedTimestamp = latestSample?.timestamp_us ?? null;
  resetAim();
  previousPinch = (forceSample ?? 0) >= settings.pinchThresholdAdc;
  byId('preview-controls').hidden = !preview;
  startGameButton.textContent = 'Restart game';
  previewGameButton.textContent = 'Restart preview';
  spawnBerry();
  feedback(preview ? 'Keyboard preview. Arrow keys aim and Space squishes.' :
    'Tilt your wrist to aim. Pinch when the gold target is on a moldy berry.');
  arena.focus();
}

function processGlove() {
  if (!latestSample || latestSample.timestamp_us === processedTimestamp) return;
  processedTimestamp = latestSample.timestamp_us;
  aimFromSample();
  const force = forceSample ?? 0;
  const pinched = previousPinch
    ? force >= settings.releaseThresholdAdc
    : force >= settings.pinchThresholdAdc;
  if (pinched && !previousPinch) squish();
  previousPinch = pinched;
}

function finishGame(message) {
  playing = false;
  board.fill(null);
  effect = null;
  resetAim();
  feedback(message + ' Score ' + score + '. Start another round to play again.');
}

function advanceGame(seconds) {
  remaining = Math.max(0, remaining - seconds);
  spawnTimer += seconds * 1000;
  for (let index = 0; index < board.length; index++) {
    const berry = board[index];
    if (!berry) continue;
    berry.age += seconds * 1000;
    if (berry.moldy && berry.age >= settings.moldLifetimeMs) {
      board[index] = null;
      lives--;
      feedback('A moldy berry got away. Move to the next one and pinch.');
    }
  }
  if (lives <= 0) {
    lives = 0;
    finishGame('The mold took over.');
    return;
  }
  if (remaining <= 0) {
    finishGame('Patch protected!');
    return;
  }
  if (spawnTimer >= settings.spawnEveryMs) {
    spawnTimer %= settings.spawnEveryMs;
    spawnBerry();
  }
}

function strawberry(x, y, radius, berry) {
  const pop = Math.min(1, berry.age / 220);
  paint.save();
  paint.translate(x, y);
  paint.scale(.65 + pop * .35, .65 + pop * .35);
  paint.shadowColor = '#061c22';
  paint.shadowBlur = radius * .25;
  paint.shadowOffsetY = radius * .12;
  const color = paint.createLinearGradient(-radius, -radius, radius, radius);
  color.addColorStop(0, berry.moldy ? '#b18c5d' : '#ff6f77');
  color.addColorStop(1, berry.moldy ? '#513c2d' : '#b41439');
  paint.fillStyle = color;
  paint.beginPath();
  paint.moveTo(0, radius);
  paint.bezierCurveTo(-radius*.45, radius*.8, -radius*1.15, -radius*.1, -radius*.85, -radius*.6);
  paint.bezierCurveTo(-radius*.6, -radius*1.02, -radius*.23, -radius*.9, 0, -radius*.68);
  paint.bezierCurveTo(radius*.4, -radius, radius*.9, -radius*.88, radius*.92, -radius*.35);
  paint.bezierCurveTo(radius*.98, radius*.18, radius*.3, radius*.87, 0, radius);
  paint.fill();
  paint.shadowBlur = 0;
  paint.shadowOffsetY = 0;
  for (let row = 0; row < 4; row++) {
    for (let column = -1; column <= 1; column++) {
      const sx = column * radius * (.39 - row*.055) + (row % 2 ? radius*.08 : 0);
      const sy = -radius*.35 + row * radius*.29;
      paint.fillStyle = berry.moldy ? '#3a3326' : '#ffe7a6';
      paint.beginPath();
      paint.ellipse(sx, sy, radius*.035, radius*.065, .3, 0, Math.PI*2);
      paint.fill();
    }
  }
  paint.fillStyle = berry.moldy ? '#64724a' : '#65bf76';
  for (let leaf = -2; leaf <= 2; leaf++) {
    paint.save();
    paint.translate(0, -radius*.65);
    paint.rotate(leaf*.52);
    paint.beginPath();
    paint.ellipse(0, -radius*.17, radius*.12, radius*.4, 0, 0, Math.PI*2);
    paint.fill();
    paint.restore();
  }
  if (berry.moldy) {
    for (const [mx, my, size] of [[-.42,-.25,.30],[.34,.04,.24],[-.08,.52,.22]]) {
      paint.fillStyle = '#e8eee1';
      paint.beginPath();
      paint.arc(mx*radius, my*radius, radius*size, 0, Math.PI*2);
      paint.fill();
      for (let fleck = 0; fleck < 9; fleck++) {
        const angle = fleck * 2.4;
        paint.fillStyle = fleck % 2 ? '#bec5b6' : '#ffffff';
        paint.beginPath();
        paint.arc((mx+Math.cos(angle)*size*.7)*radius,
          (my+Math.sin(angle)*size*.7)*radius, radius*.045, 0, Math.PI*2);
        paint.fill();
      }
    }
    const fraction = Math.max(0, 1 - berry.age/settings.moldLifetimeMs);
    paint.strokeStyle = '#f4c78c';
    paint.lineWidth = 3;
    paint.beginPath();
    paint.arc(0, 0, radius*1.24, -Math.PI/2, -Math.PI/2+fraction*Math.PI*2);
    paint.stroke();
  }
  paint.restore();
}

function renderBoard() {
  const width = arena.clientWidth;
  const height = arena.clientHeight;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  if (arena.width !== Math.round(width*ratio) || arena.height !== Math.round(height*ratio)) {
    arena.width = Math.round(width*ratio);
    arena.height = Math.round(height*ratio);
  }
  paint.setTransform(ratio,0,0,ratio,0,0);
  paint.clearRect(0,0,width,height);
  const size = settings?.gridSize ?? 3;
  const step = Math.min(width/(size+.45),height/(size+.45));
  const startX = width/2 - step*(size-1)/2;
  const startY = height/2 - step*(size-1)/2;
  for (let row=0; row<size; row++) {
    for (let column=0; column<size; column++) {
      const index = row*size+column;
      const x = startX + column*step;
      const y = startY + row*step;
      paint.fillStyle = '#071e2060';
      paint.beginPath();
      paint.ellipse(x,y,step*.41,step*.40,0,0,Math.PI*2);
      paint.fill();
      if (board[index]) strawberry(x,y,step*.25,board[index]);
      if (effect?.index === index) {
        paint.globalAlpha = Math.max(0,1-effect.age/.65);
        paint.fillStyle = '#d8bd94';
        paint.beginPath();
        paint.ellipse(x,y+step*.12,step*.29,step*.10,0,0,Math.PI*2);
        paint.fill();
        paint.globalAlpha = 1;
      }
      if (playing && target[0] === column && target[1] === row) {
        paint.strokeStyle = '#ffdb79';
        paint.lineWidth = 4;
        paint.beginPath();
        paint.arc(x,y,step*.41,0,Math.PI*2);
        paint.stroke();
      }
    }
  }
}

function gameFrame(now) {
  const seconds = lastGameFrame === null ? 0 : Math.min(.05,(now-lastGameFrame)/1000);
  lastGameFrame = now;
  startGameButton.disabled = !settings || !sensorReady(now);
  if (playing && settings) {
    const ready = previewMode || sensorReady(now);
    if (!ready) {
      paused = true;
      resetAim();
      previousPinch = (forceSample ?? 0) >= settings.pinchThresholdAdc;
      feedback('Paused. Connect the glove, set neutral, and resume the live sensor stream.');
    } else {
      if (paused) {
        paused = false;
        processedTimestamp = latestSample?.timestamp_us ?? null;
        resetAim();
        previousPinch = (forceSample ?? 0) >= settings.pinchThresholdAdc;
        feedback('Back in the patch. Aim and pinch the moldy berries.');
      }
      if (!previewMode) processGlove();
      advanceGame(seconds);
    }
  }
  if (effect) {
    effect.age += seconds;
    if (effect.age > .65) effect = null;
  }
  byId('score').value = score;
  byId('lives').value = lives;
  byId('time-left').value = Math.ceil(remaining);
  renderBoard();
  requestAnimationFrame(gameFrame);
}

startGameButton.addEventListener('click', () => startGame(false));
previewGameButton.addEventListener('click', () => startGame(true));
arena.addEventListener('keydown', (event) => {
  if (!playing || !previewMode || event.repeat) return;
  const moves = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,1], ArrowDown:[0,-1] };
  if (moves[event.key]) {
    event.preventDefault();
    moveTarget(...moves[event.key]);
  } else if (event.code === 'Space') {
    event.preventDefault();
    squish();
  }
});

async function loadGame() {
  try {
    const response = await fetch('strawberry-game.json', { cache:'no-store' });
    if (!response.ok) throw new Error('Settings unavailable');
    const config = await response.json();
    if (config.gridSize !== 3 || config.healthyLifetimeMs !== null ||
        ![config.roundSeconds,config.spawnEveryMs,config.moldLifetimeMs,config.pointsPerSquish]
          .every((value)=>Number.isFinite(value) && value > 0) ||
        ![config.controls?.deadzoneDps,config.controls?.degreesPerCell]
          .every(value=>Number.isFinite(value) && value>0) ||
        !Number.isInteger(config.lives) || config.lives < 1 ||
        !Number.isFinite(config.moldProbability) || config.moldProbability < 0 || config.moldProbability > 1 ||
        !(config.releaseThresholdAdc >= 0 && config.pinchThresholdAdc > config.releaseThresholdAdc &&
          config.pinchThresholdAdc <= 4095)) throw new Error('Invalid settings');
    settings = config;
    lives = config.lives;
    remaining = config.roundSeconds;
    board = Array(config.gridSize**2).fill(null);
    byId('game-rules').textContent = config.roundSeconds+' seconds per round · +'+
      config.pointsPerSquish+' points per moldy berry · '+(config.moldLifetimeMs/1000)+
      ' seconds to squish each one · '+config.lives+' misses ends the round. Fresh berries score 0 and stay.';
    feedback('Connect your glove, set neutral, then Start game. Keyboard preview is available.');
  } catch {
    previewGameButton.disabled = true;
    feedback('Could not load strawberry-game.json. Open this game through the local server.');
  }
}
loadGame();
requestAnimationFrame(gameFrame);
