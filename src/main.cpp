#include <Arduino.h>
#include <Adafruit_TinyUSB.h>
#include <nrf.h>
#include <nrf_gpio.h>
#include <cstdio>
#include <initializer_list>

namespace {
constexpr uint32_t ImuPower = 40;  // P1.08
constexpr uint32_t ImuSda = 7;     // P0.07
constexpr uint32_t ImuScl = 27;    // P0.27
constexpr uint32_t TransferTimeoutUs = 2500;
constexpr uint32_t SamplePeriodUs = 20000;
constexpr uint8_t ForceSensorPin = A0;
constexpr uint8_t ForceAdcBits = 12;
constexpr uint16_t ForceResponseThreshold = 80;
bool forceTest = false;
uint16_t forceBaseline = 0;
uint16_t forceMinimum = 4095;
uint16_t forceMaximum = 0;
uint16_t forceLatest = 0;
uint32_t lastForceSampleMs = 0;
uint32_t lastForceReportMs = 0;

void serviceHeartbeat() {
    // The onboard RGB LEDs are active-low.
    digitalWrite(LED_GREEN, millis() % 1000 < 100 ? LOW : HIGH);
}

void serviceForceTest() {
    while (Serial.available()) {
        const char command = Serial.read();
        if (command == 'f' || command == 'F') {
            forceTest = !forceTest;
            forceBaseline = analogRead(ForceSensorPin);
            forceMinimum = forceBaseline;
            forceMaximum = forceBaseline;
            lastForceReportMs = millis();
            Serial.println(forceTest
                ? "FORCE,test=on pin=A0 release_then_pinch report_ms=500 stream=paused"
                : "FORCE,test=off stream=resumed");
            Serial.print("FORCE,baseline=");
            Serial.println(forceBaseline);
        } else if (command == '?') {
            Serial.println("HELP,f toggles force test; release sensor before enabling; ? shows help");
        }
    }

    const uint32_t now = millis();
    if (!forceTest || now - lastForceSampleMs < 20) return;
    lastForceSampleMs = now;
    forceLatest = analogRead(ForceSensorPin);
    forceMinimum = min(forceMinimum, forceLatest);
    forceMaximum = max(forceMaximum, forceLatest);
    if (Serial && now - lastForceReportMs >= 500) {
        const int delta = static_cast<int>(forceLatest) - forceBaseline;
        char line[160];
        snprintf(line, sizeof(line),
                 "FORCE,raw=%u min=%u max=%u delta=%d response=%s",
                 forceLatest, forceMinimum, forceMaximum, delta,
                 delta >= ForceResponseThreshold ? "PINCH" : "released_or_no_change");
        Serial.println(line);
        lastForceReportMs = now;
    }
}

NRF_TWIM_Type *bus = NRF_TWIM0;
uint8_t imuAddress = 0x6A;
// EasyDMA buffers must be in RAM and stay valid through the STOP event.
uint8_t tx[2];
uint8_t rx[12];

void configureBus() {
    bus->ENABLE = 0;
    for (uint32_t pin : {ImuSda, ImuScl}) {
        nrf_gpio_cfg(pin, NRF_GPIO_PIN_DIR_INPUT, NRF_GPIO_PIN_INPUT_CONNECT,
                     NRF_GPIO_PIN_PULLUP, NRF_GPIO_PIN_S0D1, NRF_GPIO_PIN_NOSENSE);
    }
    bus->PSEL.SDA = ImuSda;
    bus->PSEL.SCL = ImuScl;
    bus->FREQUENCY = TWIM_FREQUENCY_FREQUENCY_K100;
    bus->ENABLE = TWIM_ENABLE_ENABLE_Enabled;
}

bool transfer(bool read, size_t size) {
    bus->EVENTS_STOPPED = 0;
    bus->EVENTS_ERROR = 0;
    bus->ERRORSRC = bus->ERRORSRC;
    if (read) {
        bus->RXD.PTR = reinterpret_cast<uint32_t>(rx);
        bus->RXD.MAXCNT = size;
        bus->SHORTS = TWIM_SHORTS_LASTRX_STOP_Msk;
        bus->TASKS_STARTRX = 1;
    } else {
        bus->TXD.PTR = reinterpret_cast<uint32_t>(tx);
        bus->TXD.MAXCNT = size;
        bus->SHORTS = TWIM_SHORTS_LASTTX_STOP_Msk;
        bus->TASKS_STARTTX = 1;
    }

    const uint32_t start = micros();
    while (!bus->EVENTS_STOPPED && !bus->EVENTS_ERROR &&
           micros() - start < TransferTimeoutUs) {
    }
    const bool ok = bus->EVENTS_STOPPED && !bus->EVENTS_ERROR;
    bus->SHORTS = 0;
    if (!ok) {
        bus->TASKS_STOP = 1;
        const uint32_t stopStart = micros();
        while (!bus->EVENTS_STOPPED && micros() - stopStart < TransferTimeoutUs) {
        }
        configureBus();
    }
    return ok;
}

bool readRegisters(uint8_t reg, size_t size) {
    bus->ADDRESS = imuAddress;
    tx[0] = reg;
    return transfer(false, 1) && transfer(true, size);
}

bool writeRegister(uint8_t reg, uint8_t value) {
    bus->ADDRESS = imuAddress;
    tx[0] = reg;
    tx[1] = value;
    return transfer(false, 2);
}

bool beginImu() {
    nrf_gpio_cfg(ImuPower, NRF_GPIO_PIN_DIR_OUTPUT, NRF_GPIO_PIN_INPUT_CONNECT,
                 NRF_GPIO_PIN_NOPULL, NRF_GPIO_PIN_H0H1, NRF_GPIO_PIN_NOSENSE);
    for (auto *candidate : {NRF_TWIM0, NRF_TWIM1}) {
        bus = candidate;
        configureBus();
        for (uint8_t level : {HIGH, LOW}) {
            nrf_gpio_pin_write(ImuPower, level);
            delay(50);
            for (uint8_t address : {0x6A, 0x6B}) {
                imuAddress = address;
                if (readRegisters(0x0F, 1) && rx[0] == 0x6A &&
                    writeRegister(0x12, 0x44) &&  // Block data update, auto-increment.
                    writeRegister(0x10, 0x40) &&  // Accelerometer, 104 Hz, ±2 g.
                    writeRegister(0x11, 0x40)) {  // Gyroscope, 104 Hz, ±250 dps.
                    return true;
                }
            }
        }
        bus->ENABLE = 0;
    }
    return false;
}

int16_t axis(size_t offset) {
    return static_cast<int16_t>(rx[offset] | (static_cast<uint16_t>(rx[offset + 1]) << 8));
}

void sendSample(uint32_t timestamp) {
    // Integer units keep CSV compact. Output registers store gyro before acceleration.
    // The divider voltage rises as the thumb sensor is pressed.
    const unsigned force = analogRead(ForceSensorPin);
    char line[240];
    const int length = snprintf(line, sizeof(line),
        "{\"type\":\"sample\",\"timestamp_us\":%lu,"
        "\"imu\":{\"accel_mg\":[%ld,%ld,%ld],\"gyro_mdps\":[%ld,%ld,%ld]},"
        "\"force\":{\"adc\":%u}}\n",
        static_cast<unsigned long>(timestamp),
        static_cast<long>(axis(6)) * 61 / 1000,
        static_cast<long>(axis(8)) * 61 / 1000,
        static_cast<long>(axis(10)) * 61 / 1000,
        static_cast<long>(axis(0)) * 875 / 100,
        static_cast<long>(axis(2)) * 875 / 100,
        static_cast<long>(axis(4)) * 875 / 100,
        force);
    if (!forceTest && length > 0 && static_cast<size_t>(length) < sizeof(line) && Serial) {
        Serial.write(reinterpret_cast<const uint8_t *>(line), length);
    }
}
}

void setup() {
    pinMode(LED_GREEN, OUTPUT);
    digitalWrite(LED_GREEN, LOW);
    pinMode(ForceSensorPin, INPUT);
    analogReadResolution(ForceAdcBits);
    Serial.begin(115200);
}

void loop() {
    serviceHeartbeat();
    serviceForceTest();
    static bool imuReady = false;
    static uint32_t nextImuRetryMs = 0;
    static uint32_t nextSampleUs = 0;
    static uint8_t consecutiveErrors = 0;
    if (!imuReady) {
        if (static_cast<int32_t>(millis() - nextImuRetryMs) < 0) {
            delay(1);
            return;
        }
        imuReady = beginImu();
        if (!imuReady) {
            if (Serial) Serial.println("ERR,IMU not detected; retrying");
            nextImuRetryMs = millis() + 1000;
        }
        nextSampleUs = micros();
        consecutiveErrors = 0;
        return;
    }

    const uint32_t now = micros();
    if (static_cast<int32_t>(now - nextSampleUs) < 0) {
        delay(1);
        return;
    }
    nextSampleUs = now + SamplePeriodUs;
    if (readRegisters(0x22, sizeof(rx))) {
        consecutiveErrors = 0;
        sendSample(now);
    } else if (++consecutiveErrors >= 5) {
        if (Serial) Serial.println("ERR,IMU read failed; reconnecting to sensor");
        imuReady = false;
    }
}
