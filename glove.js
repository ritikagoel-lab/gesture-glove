'use strict';

const byId = (id) => document.getElementById(id);
const canvas = byId('hand');
const ctx = canvas.getContext('2d');
const connectButton = byId('connect');
const neutralButton = byId('neutral');
const demoButton = byId('demo');
const forceMeter = byId('force-meter');
const forceReading = byId('force-reading');
const ForceAdcMax = 4095;
let forceSample = null;
const PinchOn = 80;
const PinchOff = 50;
const HardPinchOn = 1200;
const HardPinchOff = 1000;
let pinchState = 'released';
let pinchBlend = 0;
let latestSample = null;
const motionArrows = ['x', 'y', 'z'].map((axis) => byId('motion-' + axis));

const identity = [1, 0, 0, 0];
const rad = Math.PI / 180;
const norm = (v) => Math.hypot(...v);
function unit(v) {
  const length = norm(v);
  return v.map((n) => n / length);
}
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cross = ([a, b, c], [x, y, z]) => [b*z-c*y, c*x-a*z, a*y-b*x];
const conjugate = ([w, x, y, z]) => [w, -x, -y, -z];
function multiply([w, x, y, z], [a, b, c, d]) {
  return [w*a-x*b-y*c-z*d, w*b+x*a+y*d-z*c,
          w*c-x*d+y*a+z*b, w*d+x*c-y*b+z*a];
}
const rotate = (q, v) => multiply(multiply(q, [0, ...v]), conjugate(q)).slice(1);

function fromTo(a, b) {
  const similarity = dot(a, b);
  if (similarity < -0.99999) {
    const axis = unit(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    return [0, ...axis];
  }
  return unit([1 + similarity, ...cross(a, b)]);
}

function axisRotation(axis, angle) {
  const half = angle / 2;
  return [Math.cos(half), ...axis.map((v) => v * Math.sin(half))];
}

function angles([w, x, y, z]) {
  return [
    Math.atan2(2*(w*x+y*z), 1-2*(x*x+y*y)),
    Math.asin(Math.max(-1, Math.min(1, 2*(w*y-z*x)))),
    Math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z)),
  ].map((value) => value / rad);
}

let pose = identity;
// pose maps chip coordinates into the reference frame. The neutral mount maps
// the same chip coordinates into the hand model's axes at rest.
let neutralMount = identity;
let gravityReference = [0, 0, 1];
const motion = Array.from({ length: 3 }, () => ({ filtered: 0, direction: 0, quiet: 0, held: 0 }));
let calibrated = false;
let gyroBias = [0, 0, 0];
let lastTimestamp = null;
let lastSampleTime = -Infinity;
let hasSample = false;
let calibration = null;
let demo = false;
let port = null;
let reader = null;
let streaming = false;
let pending = false;
let lastReadoutTime = 0;
let lastFrameTime = null;
const displayOffset = [0, 0, 0];

function status(message, kind = '') {
  byId('status').className = `status ${kind}`;
  const label = byId('status-text');
  if (label.textContent !== message) label.textContent = message;
}

function resetTracking() {
  forceSample = null;
  pinchState = 'released';
  pinchBlend = 0;
  latestSample = null;
  byId('sample-json').textContent = 'Waiting for sensor data';
  showForce(null);
  pose = identity;
  neutralMount = identity;
  displayOffset.fill(0);
  gravityReference = [0, 0, 1];
  resetMotion();
  calibrated = false;
  gyroBias = [0, 0, 0];
  lastTimestamp = null;
  lastSampleTime = -Infinity;
  lastReadoutTime = -Infinity;
  hasSample = false;
  calibration = null;
  neutralButton.disabled = true;
  neutralButton.textContent = 'Set neutral';
  for (const id of ['angles', 'accel', 'gyro', 'raw-accel', 'raw-gyro']) byId(id).value = '—';
}

function resetMotion() {
  for (const axis of motion) Object.assign(axis, { filtered: 0, direction: 0, quiet: 0, held: 0 });
  showMotion([0, 0, 0]);
}

function newCalibration() {
  return { count: 0, gyroSum: [0, 0, 0], accelSum: [0, 0, 0] };
}

function setNeutral(accel, gyro) {
  // With the component side facing the viewer, chip +Z points out of
  // the board. Project gravity onto the board to find screen-up even
  // when the board is leaning slightly back or forward.
  const [x, y] = accel;
  neutralMount = axisRotation([0, 0, 1], Math.PI / 2 - Math.atan2(y, x));
  pose = neutralMount;
  gravityReference = rotate(neutralMount, accel);
  gyroBias = gyro;
  lastReadoutTime = -Infinity;
  calibrated = true;
  displayOffset.fill(0);
  resetMotion();
}

function updateMotion(linearAccel, dt) {
  if (!calibrated || dt <= 0 || dt >= 0.2) return;
  motion.forEach((axis, i) => {
    axis.filtered += (linearAccel[i] - axis.filtered) * (1 - Math.exp(-dt / 0.04));
    const magnitude = Math.abs(axis.filtered);
    if (!axis.direction) {
      if (magnitude >= 0.06) {
        axis.direction = Math.sign(axis.filtered);
        axis.quiet = 0;
        axis.held = 0;
      }
      return;
    }

    // Keep the first direction through the opposite acceleration when braking.
    axis.held += dt;
    axis.quiet = magnitude <= 0.035 ? axis.quiet + dt : 0;
    if (axis.held >= 0.38 && axis.quiet >= 0.20) axis.direction = 0;
  });
}

function showMotion(values) {
  const labels = [['Left', 'Right'], ['Down', 'Up'], ['Away', 'Toward']];
  const glyphs = [['←', '→'], ['↓', '↑'], ['⊗', '⊙']];
  motionArrows.forEach((arrow, i) => {
    const value = values[i];
    const active = Math.abs(value) >= 0.035;
    const direction = value > 0 ? 1 : 0;
    arrow.querySelector('.motion-glyph').textContent = active ? glyphs[i][direction] : '·';
    arrow.querySelector('.motion-direction').textContent = active ? labels[i][direction] : '—';
    arrow.classList.toggle('active', active);
  });
}

function updateReadouts(accel, gyro, orientation) {
  byId('angles').value = orientation.map((v) => `${v.toFixed(0)}°`).join(' / ');
  byId('accel').value = accel.map((v) => v.toFixed(2)).join(' / ');
  byId('gyro').value = gyro.map((v) => v.toFixed(1)).join(' / ');
  if (calibrated) showMotion(motion.map((axis) => axis.direction));
}

function updatePinch(value) {
  if (value === null) {
    pinchState = 'released';
  } else if (value >= HardPinchOn || (pinchState === 'hard' && value >= HardPinchOff)) {
    pinchState = 'hard';
  } else if (value >= PinchOn || (pinchState !== 'released' && value >= PinchOff)) {
    pinchState = 'light';
  } else {
    pinchState = 'released';
  }
}

function showForce(value, message = 'Waiting for sensor data') {
  updatePinch(value);
  byId('pinch-state').value = value === null ? '—' :
    { released: 'Released', light: 'Light pinch', hard: 'Hard pinch' }[pinchState];
  byId('pinch-state').dataset.state = pinchState;
  forceMeter.hidden = value === null;
  forceReading.value = value === null ? message : `${Math.round(value)} / ${ForceAdcMax}`;
  forceMeter.value = value ?? 0;
}

function processLine(line) {
  if (line.startsWith('ERR,')) {
    status(line.slice(4), 'error');
    return;
  }
  // Accept the combined JSON stream and the earlier CSV firmware.
  if (line.startsWith('{')) {
    let sample;
    try { sample = JSON.parse(line); } catch { return; }
    if (sample?.type !== 'sample' || !Array.isArray(sample.imu?.accel_mg) ||
        !Array.isArray(sample.imu?.gyro_mdps) || sample.imu.accel_mg.length !== 3 ||
        sample.imu.gyro_mdps.length !== 3) return;
    const values = [sample.timestamp_us, ...sample.imu.accel_mg,
      ...sample.imu.gyro_mdps, sample.force?.adc];
    if (!values.every(Number.isSafeInteger)) return;
    line = ['IMU', ...values].join(',');
  }
  const fields = line.split(',');
  if ((fields.length !== 8 && fields.length !== 9) || fields[0] !== 'IMU' || fields.slice(1).some((field) => !/^-?\d+$/.test(field))) return;
  const [timestamp, ax, ay, az, gx, gy, gz, force] = fields.slice(1).map(Number);
  if (timestamp < 0 || timestamp > 0xffffffff ||
      [ax, ay, az].some((v) => Math.abs(v) > 2100) ||
      [gx, gy, gz].some((v) => Math.abs(v) > 290000)) return;

  const accel = [ax, ay, az].map((v) => v / 1000);
  const gyro = [gx, gy, gz].map((v) => v / 1000);
  const up = unit(gravityReference);
  const gravity = norm(accel);
  const now = performance.now();
  if (lastTimestamp === null && gravity > 0.2) pose = fromTo(unit(accel), up);
  const dt = lastTimestamp === null ? 0 : ((timestamp - lastTimestamp) >>> 0) / 1e6;
  lastTimestamp = timestamp;

  if (force === undefined || force < 0 || force > ForceAdcMax) {
    forceSample = null;
  } else {
    const blend = dt > 0 && dt < 0.2 ? 1 - Math.exp(-dt / 0.055) : 1;
    forceSample = forceSample === null ? force : forceSample + blend * (force - forceSample);
  }
  updatePinch(forceSample);
  latestSample = {
    type: 'sample',
    timestamp_us: timestamp,
    imu: { accel_mg: [ax, ay, az], gyro_mdps: [gx, gy, gz] },
    force: { adc: force !== undefined && force >= 0 && force <= ForceAdcMax ? force : null,
      filtered_adc: forceSample === null ? null : Math.round(forceSample), pinch: pinchState },
  };

  const correctedGyro = () => gyro.map((v, i) => v - gyroBias[i]);
  if (dt > 0 && dt < 0.2) {
    // The accelerometer corrects tilt only, with less weight during linear motion.
    const confidence = Math.max(0, 1 - Math.abs(gravity - 1) / 0.20);
    const correction = confidence > 0 ? cross(unit(accel), rotate(conjugate(pose), up)) : [0, 0, 0];
    const rate = correctedGyro().map((v, i) => v * rad + 2.4 * confidence * correction[i]);
    const speed = norm(rate);
    if (speed > 0) pose = unit(multiply(pose, axisRotation(unit(rate), speed * dt)));
  }

  let message = calibrated ? 'Live from XIAO' : 'Live from XIAO · Set neutral to align the hand';
  if (calibration) {
    const upright = Math.hypot(ax, ay) >= 550;
    const steady = norm(gyro) <= 8 && Math.abs(gravity - 1) <= 0.12 &&
      (calibration.count === 0 || dot(unit(accel), unit(calibration.accelSum)) >= 0.9986);
    if (!upright || !steady) {
      calibration = newCalibration();
      message = upright ? 'Hold the board still to set neutral…' :
        'Hold the board upright, component side facing you and USB on the left.';
    } else {
      calibration.count++;
      gyro.forEach((v, i) => { calibration.gyroSum[i] += v; });
      accel.forEach((v, i) => { calibration.accelSum[i] += v; });
      message = 'Setting neutral…';
      if (calibration.count >= 50) {
        const average = (sum) => sum.map((value) => value / calibration.count);
        setNeutral(average(calibration.accelSum), average(calibration.gyroSum));
        calibration = null;
        message = 'Live from XIAO';
      }
    }
  }

  const linearAccel = rotate(pose, accel).map((v, i) => v - gravityReference[i]);
  if (!calibration) updateMotion(linearAccel, dt);

  lastSampleTime = now;
  hasSample = true;
  neutralButton.disabled = false;
  neutralButton.textContent = calibration ? 'Cancel neutral' : 'Set neutral';
  status(message, 'live');
  if (now - lastReadoutTime >= 80) {
    const orientation = multiply(pose, conjugate(neutralMount));
    updateReadouts(linearAccel, rotate(pose, correctedGyro()), angles(orientation));
    showForce(forceSample, force === undefined ? 'Flash the thumb-sensor firmware' : 'Invalid ADC reading');
    byId('sample-json').textContent = JSON.stringify(latestSample, null, 2);
    byId('raw-accel').value = accel.map((v) => v.toFixed(2)).join(' / ');
    byId('raw-gyro').value = gyro.map((v) => v.toFixed(1)).join(' / ');
    lastReadoutTime = now;
  }
}

function syncButtons() {
  connectButton.textContent = port ? 'Disconnect' : 'Connect XIAO';
  connectButton.disabled = pending;
  demoButton.textContent = demo ? 'Stop demo' : 'Try demo';
  demoButton.disabled = Boolean(port) || pending;
}

async function connect() {
  if (port) {
    streaming = false;
    await reader?.cancel().catch(() => {});
    return;
  }
  if (!navigator.serial) {
    status('Open this page in desktop Chrome or Edge from localhost to use USB serial.', 'error');
    return;
  }

  pending = true;
  syncButtons();
  try {
    const selected = await navigator.serial.requestPort();
    await selected.open({ baudRate: 115200 });
    port = selected;
  } catch (error) {
    status(error.name === 'NotFoundError' ? 'No serial port selected.' :
      'Could not open the port. Close any serial monitor and try again.', 'error');
    return;
  } finally {
    pending = false;
    syncButtons();
  }

  demo = false;
  syncButtons();
  resetTracking();
  streaming = true;
  lastSampleTime = performance.now();
  status('Connected. Waiting for IMU data…');
  const decoder = new TextDecoder();
  let partial = '';
  let reason = 'Disconnected';
  try {
    reader = port.readable.getReader();
    while (streaming) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (partial + decoder.decode(value, { stream: true })).split('\n');
      partial = lines.pop();
      if (partial.length > 512) partial = '';
      lines.forEach((line) => processLine(line.trim()));
    }
  } catch {
    reason = 'Serial connection lost. Reconnect the XIAO to continue.';
  } finally {
    reader?.releaseLock();
    reader = null;
    await port.close().catch(() => {});
    port = null;
    streaming = false;
    resetTracking();
    syncButtons();
    status(reason);
  }
}

connectButton.addEventListener('click', connect);
neutralButton.addEventListener('click', () => {
  calibration = calibration ? null : newCalibration();
  neutralButton.textContent = calibration ? 'Cancel neutral' : 'Set neutral';
  status(calibration ? 'Hold the board still to set neutral…' :
    calibrated ? 'Live from XIAO' : 'Live from XIAO · Set neutral to align the hand', 'live');
});
demoButton.addEventListener('click', () => {
  demo = !demo;
  resetTracking();
  syncButtons();
  status(demo ? 'Demo motion' : 'Waiting for the XIAO', demo ? 'live' : '');
});

// A beveled left-hand model viewed from the back. +Y points toward the fingers.
const glove = [];
function beveledShape(outline, height, color) {
  const ring = (scale, z) => {
    const center = outline.reduce(([x, y], [u, v]) => [x+u/outline.length, y+v/outline.length], [0, 0]);
    return outline.map(([x, y]) => [center[0]+(x-center[0])*scale, center[1]+(y-center[1])*scale, z]);
  };
  const rings = [ring(.85, -height), ring(1, -height*.44), ring(1, height*.48), ring(.82, height)];
  glove.push({ vertices: rings[0], color, shade:.61 }, { vertices:rings[3], color, shade:1 });
  for (let r=0; r<rings.length-1; r++) {
    for (let i=0; i<outline.length; i++) {
      const j = (i+1)%outline.length;
      glove.push({ vertices:[rings[r][i], rings[r][j], rings[r+1][j], rings[r+1][i]],
        color, shade:[.68, .78, .89][r] + .05*Math.sin(i*1.9) });
    }
  }
}
const fabric = [86, 139, 179];
const cuff = [55, 88, 118];
beveledShape([[-.53,-1.55],[.59,-1.55],[.62,-.87],[-.59,-.87]], .19, cuff);
beveledShape([[-.56,-1.08],[.55,-1.08],[.77,-.62],[.91,.03],[.79,.62],[.53,.79],[-.52,.75],[-.78,.49],[-.79,-.22]], .25, fabric);
const thumbStart = glove.length;
beveledShape([[.58,-.65],[.93,-.54],[1.48,-.18],[1.61,.09],[1.43,.27],[1.12,.18],[.77,-.08]], .16, fabric);
const indexStart = glove.length;
beveledShape([[.39,.53],[.78,.43],[.92,1.93],[.83,2.16],[.65,2.2],[.52,2.06]], .15, fabric);
for (const face of glove.slice(thumbStart, indexStart)) face.finger = 'thumb';
for (const face of glove.slice(indexStart)) face.finger = 'index';
beveledShape([[-.04,.58],[.35,.58],[.42,2.43],[.30,2.66],[.11,2.66],[-.03,2.5]], .16, fabric);
beveledShape([[-.45,.51],[-.09,.58],[-.13,2.26],[-.25,2.43],[-.43,2.39],[-.51,2.24]], .15, fabric);
beveledShape([[-.75,.36],[-.49,.50],[-.57,1.69],[-.68,1.87],[-.86,1.82],[-.95,1.64]], .13, fabric);
// The mount, solderless breadboard, and XIAO share the hand's coordinates.
function plate(x, y, width, height, z, color, shade = 1) {
  return { vertices: [[x, y, z], [x+width, y, z], [x+width, y+height, z], [x, y+height, z]], color, shade };
}

function block(x, y, width, height, bottom, top, color) {
  const face = plate(x, y, width, height, top, color);
  const base = plate(x, y, width, height, bottom, color).vertices;
  glove.push(face);
  for (let i = 0; i < 4; i++) {
    const next = (i + 1) % 4;
    glove.push({
      vertices: [base[i], base[next], face.vertices[next], face.vertices[i]],
      color, shade: [0.62, 0.73, 0.84, 0.58][i],
    });
  }
}

const navy = [19, 33, 49];
const blue = [56, 145, 241];
const cyan = [99, 226, 255];
const ivory = [207, 217, 220];
const gold = [194, 154, 84];
const metal = [167, 188, 203];

glove.push(plate(-.54, -.57, 1.13, 1.12, .253, [22, 35, 49]));
glove.push(plate(-.49, -1.4, .98, .08, .192, blue));
glove.push(plate(-.49, -1.26, .98, .026, .192, [102, 158, 200]));
for (const [x, y, width, z] of [[-.74, 1.44, .16, .132], [-.39, 1.94, .17, .152], [.08, 2.12, .19, .162], [.60, 1.67, .17, .152]]) {
  glove.push(plate(x, y, width, .19, z, [53, 93, 128]));
  glove.push(plate(x+.02, y+.16, width-.04, .022, z+.002, blue));
  if (x > .5) {
    glove[glove.length - 1].finger = 'index';
    glove[glove.length - 2].finger = 'index';
  }
}

// The dark lip under the raised breadboard casts a short shadow across the glove.
glove.push(plate(-.55, -.51, 1.12, .93, .256, [10, 20, 32]));
block(-.61, -.42, 1.17, .86, .262, .337, ivory);
glove.push(plate(-.56, -.385, 1.06, .022, .339, [204, 93, 106]));
glove.push(plate(-.56, .385, 1.06, .022, .339, [66, 137, 200]));
glove.push(plate(-.56, -.026, 1.06, .052, .34, [167, 183, 195]));
for (let row = 0; row < 6; row++) {
  const y = [-.32, -.23, -.14, .12, .21, .30][row];
  for (let column = 0; column < 12; column++) {
    glove.push(plate(-.54 + column * .088, y, .028, .028, .342, [68, 89, 108]));
  }
}

// Turn the XIAO a quarter turn so its USB-C port faces the wrist.
const xiaoStart = glove.length;
glove.push(plate(-.37, -.282, .74, .52, .344, [129, 148, 166]));
block(-.40, -.236, .72, .48, .35, .424, navy);
for (let pin = 0; pin < 7; pin++) {
  for (const y of [-.218, .19]) {
    glove.push(plate(-.33 + pin * .095, y, .052, .031, .427, gold));
  }
}
block(-.19, -.108, .27, .222, .425, .471, [76, 96, 120]);
glove.push(plate(-.164, .069, .22, .019, .473, [118, 143, 170]));
block(-.47, -.086, .205, .182, .397, .476, metal);
glove.push(plate(-.472, -.075, .027, .16, .479, [65, 88, 112]));
glove.push(plate(.176, .052, .088, .088, .426, [38, 105, 183]));
glove.push(plate(.2, .075, .041, .041, .429, cyan));
for (const face of glove.slice(xiaoStart)) {
  face.vertices = face.vertices.map(([x, y, z]) => [-y - .04, x + .04, z]);
}


// Raised contact pads follow the two fingertips as they close.
for (const [finger, x, y, z] of [['thumb', 1.48, .08, .164], ['index', .73, 2.04, .154]]) {
  const vertices = Array.from({ length: 16 }, (_, i) => {
    const angle = i * Math.PI / 8;
    return [x + .14 * Math.cos(angle), y + .14 * Math.sin(angle), z];
  });
  glove.push({ vertices, color: [95, 183, 225], shade: 1, finger, contact: true });
}

function pinchVertex([x, y, z], finger) {
  if (finger === 'thumb') {
    const bend = Math.max(0, Math.min(1, (x - .75) / .73)) * pinchBlend;
    return [x - .25 * bend, y + .86 * bend, z];
  }
  if (finger === 'index') {
    const bend = Math.max(0, Math.min(1, (y - .53) / 1.51)) * pinchBlend;
    return [x + .30 * bend, y - .90 * bend, z];
  }
  return [x, y, z];
}

function draw(q, [xOffset, yOffset, zOffset] = [0, 0, 0]) {
  const { width, height } = canvas.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#84bcce20';
  ctx.lineWidth = 1;
  for (const radius of [.22, .37]) {
    ctx.beginPath();
    ctx.arc(width/2, height/2, Math.min(width, height)*radius, 0, 2*Math.PI);
    ctx.stroke();
  }
  const centerX = width / 2 + xOffset * Math.min(24, width * 0.06);
  const centerY = height / 2 - yOffset * Math.min(16, height * 0.045);
  const scale = Math.min(height / 5.4, width / 5.1) * (1 + 0.08 * zOffset);
  const projected = glove.map(({ vertices, color, shade, finger, contact }) => {
    if (contact && pinchState !== 'released') {
      color = pinchState === 'hard' ? [255, 83, 83] : [86, 239, 143];
    }
    const points = vertices.map((vertex) => {
      const [x, y, z] = pinchVertex(vertex, finger);
      return rotate(q, [x, y - .49, z]);
    });
    const depth = points.reduce((sum, point) => sum + point[2]/points.length, 0);
    return { points, depth, color, shade };
  }).sort((a, b) => a.depth - b.depth);
  for (const { points, color, shade } of projected) {
    ctx.beginPath();
    points.forEach(([x,y,z], i) => {
      const k = scale * 8 / (8-z);
      const point = [centerX+x*k, centerY-y*k];
      if (i === 0) ctx.moveTo(...point);
      else ctx.lineTo(...point);
    });
    ctx.closePath();
    ctx.fillStyle = `rgb(${color.map((v) => Math.round(v*shade)).join(',')})`;
    ctx.fill();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.stroke();
  }
}

function animate(now) {
  const elapsed = lastFrameTime === null ? 0 : Math.min(now - lastFrameTime, 50);
  lastFrameTime = now;
  let orientation;
  let directions;
  if (demo) {
    const t = now / 1000;
    orientation = multiply(axisRotation([0,1,0], Math.sin(t*.8)*.66),
                               axisRotation([1,0,0], Math.cos(t)*.51));
    directions = [Math.sin(t * 1.2), Math.cos(t * 1.4), Math.sin(t * 0.7)].map(Math.sign);
    if (now - lastReadoutTime >= 80) {
      showMotion(directions);
      showForce(2200 * Math.pow((1 + Math.sin(t * 2)) / 2, 2));
      lastReadoutTime = now;
    }
    byId('angles').value = angles(orientation).map((v) => `${v.toFixed(0)}°`).join(' / ');
  } else {
    orientation = multiply(pose, conjugate(neutralMount));
    if (port && now - lastSampleTime > (hasSample ? 1500 : 4000)) {
      neutralButton.disabled = true;
      forceSample = null;
      showForce(null, 'Sensor stream paused');
      resetMotion();
      if (!byId('status').classList.contains('error')) {
        status(hasSample ? 'IMU stream paused. Check the USB connection.' :
          'No IMU data. Check that the Gesture Glove firmware is flashed.', 'error');
      }
    }
    directions = motion.map((axis) => calibration ? 0 : axis.direction);
  }

  // Each latched gesture sets a target in [-1, 1]. Ease toward it in the
  // animation loop so sensor noise never moves the model directly.
  directions.forEach((direction, i) => {
    const blend = 1 - Math.exp(-elapsed / (direction ? 140 : 280));
    displayOffset[i] += (direction - displayOffset[i]) * blend;
  });
  const pinchTarget = pinchState === 'released' ? 0 : 1;
  pinchBlend += (pinchTarget - pinchBlend) * (1 - Math.exp(-elapsed / 120));
  draw(orientation, displayOffset);
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);
