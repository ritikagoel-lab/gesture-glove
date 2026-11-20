# Gesture Glove

The XIAO nRF52840 Sense Plus sends wrist motion and the thumb sensor reading over USB. The laptop rotates a 3D model of the left hand and displays the thumb pressure signal.

## Wire the thumb sensor

Connect **3V3 → FSR → A0/D0 → 10 kΩ → GND**. The free FSR tab and one resistor lead share the A0/D0 row. The other FSR tab goes to 3V3, and the other resistor lead goes to GND. The FSR tabs are interchangeable. Use the labels printed on the XIAO to identify the pins.

The thumb meter shows relative pressure as a lightly smoothed 12-bit ADC reading. It should read near zero when released and rise when you press the pad. The counts depend on your sensor and mounting. Measuring force in newtons would require calibration.

## Upload with PlatformIO

Disconnect the browser viewer and close any serial monitor. Keep the XIAO plugged in normally. In Terminal run:

```bash
cd gesture-glove
PIO="$HOME/.platformio/penv/bin/pio"
"$PIO" run -e gesture_glove -t upload --upload-port /dev/cu.usbmodem101
```

PlatformIO triggers the USB bootloader automatically using a 1200-baud serial touch. This normally avoids pressing RESET or copying UF2 manually. If your port changes, list devices with `"$PIO" device list` and use the XIAO's current port. Manual double-reset remains the recovery method if the current application cannot respond to the serial reset.

The firmware source is `src/main.cpp` in this directory. A regular PlatformIO build writes the serial-upload image to `.pio/build/gesture_glove/firmware.zip`. The separately supplied `gesture-glove.uf2` can also be copied to the XIAO-SENSE bootloader drive.

## Power LED and force test

The onboard green LED flashes for 100 ms every second while the firmware runs, including while waiting to retry the IMU.

Open the serial monitor after uploading:

```bash
"$PIO" device monitor --port /dev/cu.usbmodem101 --baud 115200
```

Release the thumb pad, then type **f** (press Enter if your terminal buffers input). This records an unpressed baseline, pauses the combined IMU/force JSON stream, and prints a force report every 500 ms. Pinch and release the pad several times.

```text
FORCE,raw=1250 min=0 max=1250 delta=1250 response=PINCH
```

- **raw** is the latest A0 reading from 0 to 4095.
- **min/max** retain the range seen during this test, including a quick pinch between reports.
- **delta** is the current reading minus the baseline captured when you enabled the test.
- **PINCH** means the reading is at least 80 counts above that baseline. This initial response threshold can be adjusted in the source as `ForceResponseThreshold`.

Type **f** again to stop the test and resume viewer data. Type **?** for command help. Exit the monitor with **Ctrl+C** before reconnecting the browser.

A low reading while released is expected. A reading that rises on pinch and falls on release verifies the sensor response. A constant low reading can also result from an open connection or inadequate pressure, so the report cannot certify wiring continuity on its own.

## Open the hand viewer

1. In Terminal, run the following from this project directory.

   ```bash
   python3 -m http.server 8765 --bind 127.0.0.1
   ```

2. Open [http://localhost:8765](http://localhost:8765) in desktop Chrome or Edge. **Try demo** previews the left hand without the board.
3. Mount the XIAO flat on the back of your left hand, with the component side facing out. Keep the board aligned with your hand and give the USB cable some slack.
4. Click **Connect XIAO** and select its USB serial port. Hold the board upright with the component side facing you and the USB cable on the left. Click **Set neutral** and stay still for about a second while the viewer estimates gyro bias and records your reference pose.
5. Tilt or turn your wrist. The viewer uses **+X right, +Y up, +Z toward you** at neutral. The angular-rate readout uses these fixed axes and subtracts the gyro bias. Rotation about gravity can drift, so you can set neutral again as needed. After setting neutral, slide the XIAO briefly sideways, up, or toward you while keeping its angle steady. The hand rotates and glides a short distance in the direction shown by the arrows, then eases back to neutral. The display limits are ±24 px left/right, ±16 px up/down (less on small canvases), and ±8% scale for depth. The Z symbols represent an arrow pointing out of the screen (⊙) or into it (⊗).

## Inspect the stream

Close the viewer connection before opening the serial monitor. Use `pio device monitor --port /dev/cu.usbmodem101 --baud 115200`. The XIAO streams about 50 JSON samples per second. Each line includes both the IMU and force sensor:

```json
{"type":"sample","timestamp_us":20000,"imu":{"accel_mg":[-16,50,1058],"gyro_mdps":[2135,-3403,1820]},"force":{"adc":1813}}
```

The viewer displays the parsed sample under **Live sensor JSON**, adding filtered ADC counts and a **released**, **light**, or **hard** pinch state. Older CSV firmware is also accepted.

## Pinch animation

Pinching closes the thumb and index fingertip pads. A light pinch colors the pads green. A hard pinch colors them red. Release opens the fingers. **Try demo** previews both states.

The initial thresholds in `glove.js` are **80 counts** for light and **1200 counts** for hard, chosen from the observed released values near 0–10 and pinch readings around 889–1835. Light releases below 50 and hard returns to light below 1000. The display uses a short smoothing filter. These relative thresholds can be adjusted for your sensor and mounting.

The FSR detects pressure at the thumb. The animation assumes the index finger is applying that pressure.

The timestamp wraps at 32 bits. Acceleration is in milligravity and gyro measurements are in millidegrees per second. The IMU has three physical axes. It reports acceleration along each one and angular rate about each one. Its X and Y axes lie in the board plane and +Z points out of the component side. The signed X/Y mapping depends on the package orientation on the PCB. Expand **Raw chip axes** to see the original channels. To check the mapping, hold one board edge up at a time while keeping the board vertical. The channel closest to +1 g points up. Lay the board flat with the components up to check Z. [ST datasheet, Figure 1](https://www.st.com/resource/en/datasheet/lsm6ds3tr-c.pdf#page=18)

The direction indicators use the first gravity-compensated acceleration in each gesture. They hold that direction through braking and reset after a short pause. The arrows share the hand’s neutral axes, with right toward the visible thumb. They indicate the start of a short gesture. Finger articulation and absolute position would need additional sensing.

The viewer also accepts older eight-field IMU lines and prompts for the updated firmware in the pressure panel. The serial force test pauses the combined JSON stream. Type **f** again to resume it before using the viewer.

## Strawberry Patrol

Open **http://localhost:8766/strawberry-game.html** in desktop Chrome or Edge. Start its server from this folder with:

```bash
python3 -m http.server 8766 --bind 127.0.0.1
```

Connect the XIAO, set neutral, then click **Start game**. Close the serial connection in other viewer tabs first. The existing combined IMU/force firmware works with this game. Exit serial force-test mode with **f** before connecting.

Angular rate drives aiming. Tilt the fingers left/right to move sideways. Rotate so the breadboard faces more upward/downward to move up/down. Each 8 degrees of rotation above a 6°/s noise threshold moves one cell. Hold steady to stop. Adjust controls.degreesPerCell and controls.deadzoneDps in the game JSON to change sensitivity. A target readout shows the current space. Release and pause between movements. A new pinch while targeting a moldy brown strawberry with white spots squishes it for 10 points. Healthy red berries stay. On a full board, healthy berries can turn moldy to keep play going. A moldy berry that lasts 7 seconds costs a life. The initial round is 60 seconds with 3 lives. Missing 3 moldy berries ends the round early, even if time remains. Healthy berries score 0. The rules appear above the board. All berries and squish effects clear when the game ends.

**Keyboard preview** plays without a glove. Use arrow keys and Space. For glove play, select **Start game** again.

The separate **strawberry-game.json** controls spawn timing, mold probability, time limits, points, lives, and pinch/release ADC thresholds. Reload the page after editing. Both light and hard pinches squish berries. The game pauses its timers when live sensor data stops or neutral calibration is running.
