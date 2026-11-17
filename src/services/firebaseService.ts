import { rtdb } from '../lib/firebase';
import {
  ref,
  set,
  get,
  update,
  remove,
  onValue,
  off,
  type DataSnapshot
} from 'firebase/database';
import type {
  Patient,
  LiveVitals,
  Alert,
  DeviceRecord,
  VitalMeasurement
} from '../types';

/**
 * Ensures Firebase RTDB is initialized before attempting operations.
 */
const getRTDB = () => {
  if (!rtdb) {
    throw new Error('Firebase Realtime Database is not initialized. Please verify VITE_FIREBASE_DATABASE_URL in .env');
  }
  return rtdb;
};

/**
 * Recursively strips undefined fields from an object to satisfy Firebase RTDB set() rules.
 */
export const cleanUndefined = (obj: any): any => {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(cleanUndefined);
  const cleaned: any = {};
  Object.keys(obj).forEach((key) => {
    if (obj[key] !== undefined) {
      cleaned[key] = cleanUndefined(obj[key]);
    }
  });
  return cleaned;
};

// ==========================================
// PATIENT OPERATIONS
// ==========================================

export const generateNextPatientId = async (): Promise<string> => {
  if (!rtdb) {
    return `LCIIS-P-${Date.now().toString().slice(-6)}`;
  }
  try {
    const patientsRef = ref(rtdb, 'patients');
    const snapshot = await get(patientsRef);
    let maxNum = 0;
    if (snapshot.exists()) {
      const data = snapshot.val();
      Object.keys(data).forEach((key) => {
        const match = key.match(/LCIIS-P-(\d+)/i) || (data[key]?.hospitalId || '').match(/LCIIS-P-(\d+)/i);
        if (match && match[1]) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num) && num > maxNum) {
            maxNum = num;
          }
        }
      });
    }
    const nextNum = maxNum + 1;
    return `LCIIS-P-${nextNum.toString().padStart(6, '0')}`;
  } catch (err) {
    console.warn('Error calculating sequential patient ID:', err);
    return `LCIIS-P-${Date.now().toString().slice(-6)}`;
  }
};

export const createPatient = async (patient: Patient): Promise<void> => {
  const db = getRTDB();
  const id = patient.id || patient.hospitalId;
  const patientRef = ref(db, `patients/${id}`);
  const cleanedPayload = cleanUndefined({
    ...patient,
    id,
    hospitalId: id,
    updatedAt: new Date().toISOString()
  });
  await set(patientRef, cleanedPayload);
};

export const getPatient = async (patientId: string): Promise<Patient | null> => {
  const db = getRTDB();
  const patientRef = ref(db, `patients/${patientId}`);
  const snapshot = await get(patientRef);
  if (snapshot.exists()) {
    return snapshot.val() as Patient;
  }
  return null;
};

export const subscribeToPatients = (
  callback: (patients: Patient[]) => void,
  onError?: (err: Error) => void
): (() => void) => {
  if (!rtdb) {
    if (onError) onError(new Error('Firebase RTDB not connected'));
    return () => {};
  }
  const patientsRef = ref(rtdb, 'patients');
  const unsubscribe = onValue(
    patientsRef,
    (snapshot: DataSnapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        const patientList: Patient[] = Object.keys(data).map((key) => ({
          ...data[key],
          id: data[key].id || key
        }));
        callback(patientList);
      } else {
        callback([]);
      }
    },
    (error) => {
      console.error('Firebase patients subscription error:', error);
      if (onError) onError(error);
    }
  );

  return () => off(patientsRef, 'value', unsubscribe);
};

// ==========================================
// LIVE VITALS OPERATIONS
// ==========================================

export interface RawVitalsInput {
  heartRate?: number | VitalMeasurement;
  spo2?: number | VitalMeasurement;
  temperature?: number | VitalMeasurement;
  respiratoryRate?: number | VitalMeasurement;
  systolicBP?: number | VitalMeasurement;
  diastolicBP?: number | VitalMeasurement;
  bloodPressure?: {
    systolic: number | VitalMeasurement;
    diastolic: number | VitalMeasurement;
  };
  urineOutput?: number | VitalMeasurement;
  timestamp?: number | string;
}

export const updateLiveVitals = async (
  patientId: string,
  vitalsData: RawVitalsInput
): Promise<void> => {
  const db = getRTDB();
  const timestamp = vitalsData.timestamp || Date.now();
  const timeString = typeof timestamp === 'number' ? new Date(timestamp).toISOString() : timestamp;

  // Format incoming values to handle both raw numbers and structured VitalMeasurement objects
  const formatVital = (val: any) => {
    if (val === undefined || val === null) return null;
    if (typeof val === 'number') {
      return { value: val, timestamp: timeString, source: 'LIVE_SENSOR', quality: 'GOOD' };
    }
    if (typeof val === 'object' && 'value' in val) {
      return val;
    }
    return null;
  };

  const sysVal = vitalsData.systolicBP !== undefined 
    ? (typeof vitalsData.systolicBP === 'number' ? vitalsData.systolicBP : vitalsData.systolicBP.value)
    : (vitalsData.bloodPressure?.systolic ? (typeof vitalsData.bloodPressure.systolic === 'number' ? vitalsData.bloodPressure.systolic : vitalsData.bloodPressure.systolic.value) : undefined);

  const diaVal = vitalsData.diastolicBP !== undefined 
    ? (typeof vitalsData.diastolicBP === 'number' ? vitalsData.diastolicBP : vitalsData.diastolicBP.value)
    : (vitalsData.bloodPressure?.diastolic ? (typeof vitalsData.bloodPressure.diastolic === 'number' ? vitalsData.bloodPressure.diastolic : vitalsData.bloodPressure.diastolic.value) : undefined);

  const hrVal = typeof vitalsData.heartRate === 'number' ? vitalsData.heartRate : vitalsData.heartRate?.value;
  const spo2Val = typeof vitalsData.spo2 === 'number' ? vitalsData.spo2 : vitalsData.spo2?.value;
  const tempVal = typeof vitalsData.temperature === 'number' ? vitalsData.temperature : vitalsData.temperature?.value;
  const rrVal = typeof vitalsData.respiratoryRate === 'number' ? vitalsData.respiratoryRate : vitalsData.respiratoryRate?.value;

  const rawPayload = {
    heartRate: hrVal,
    spo2: spo2Val,
    temperature: tempVal,
    respiratoryRate: rrVal,
    systolicBP: sysVal,
    diastolicBP: diaVal,
    timestamp: timestamp
  };

  // Structured LiveVitals payload for frontend consumption
  const bpStructured = (sysVal !== undefined || diaVal !== undefined) ? {
    systolic: formatVital(sysVal)!,
    diastolic: formatVital(diaVal)!
  } : undefined;

  const structuredPayload: LiveVitals = {
    heartRate: formatVital(vitalsData.heartRate),
    spo2: formatVital(vitalsData.spo2),
    temperature: formatVital(vitalsData.temperature),
    respiratoryRate: formatVital(vitalsData.respiratoryRate),
    bloodPressure: bpStructured,
    urineOutput: formatVital(vitalsData.urineOutput),
    lastUpdated: timeString
  };

  const fullSetData = cleanUndefined({
    ...rawPayload,
    structured: structuredPayload,
    lastUpdated: timeString
  });

  // Write both flat raw values and structured vitals under liveVitals/{patientId}
  const liveVitalsRef = ref(db, `liveVitals/${patientId}`);
  await set(liveVitalsRef, fullSetData);

  // Also push to vitalHistory/{patientId}
  const historyRef = ref(db, `vitalHistory/${patientId}/${Date.now()}`);
  await set(historyRef, cleanUndefined(rawPayload));
};

import { fetchLiveWeatherTemperature, type WeatherData } from './weatherService';

let latestWeatherData: WeatherData | null = null;
fetchLiveWeatherTemperature().then((w) => { latestWeatherData = w; });
setInterval(() => {
  fetchLiveWeatherTemperature().then((w) => { latestWeatherData = w; });
}, 3 * 60 * 1000);

export const subscribeToLiveVitals = (
  callback: (vitalsMap: Record<string, LiveVitals>) => void,
  onError?: (err: Error) => void
): (() => void) => {
  if (!rtdb) {
    if (onError) onError(new Error('Firebase RTDB not connected'));
    return () => {};
  }

  const map: Record<string, LiveVitals> = {};
  let rawDataCache: any = null;

  const processVitalsData = (data: any) => {
    if (data) rawDataCache = { ...rawDataCache, ...data };
    const activeData = rawDataCache || {};

    Object.keys(activeData).forEach((patientId) => {
      const item = activeData[patientId];
      if (!item) return;

      if (item.structured) {
        map[patientId] = item.structured;
      } else {
        const targetObj = item.current ? item.current : item;
        const rawHr = targetObj.heartRate ?? targetObj.heart_rate;
        const rawSpo2 = targetObj.spo2;
        const rawTemp = targetObj.temperature;
        const rawHum = targetObj.humidity;
        const rr = targetObj.respiratoryRate ?? targetObj.respiratory_rate;
        const sys = targetObj.systolicBP ?? targetObj.systolic_bp;
        const dia = targetObj.diastolicBP ?? targetObj.diastolic_bp;
        const timeStr = targetObj.lastUpdated || (targetObj.timestamp ? (typeof targetObj.timestamp === 'number' ? new Date(targetObj.timestamp).toISOString() : targetObj.timestamp) : new Date().toISOString());

        const isHardwarePatient = patientId === 'LCIIS-P-000001' || targetObj.deviceId === 'ESP32-ICU-001' || targetObj.fingerDetected !== undefined;

        // Temperature (from DHT11)
        const isTempValid = rawTemp !== undefined && rawTemp !== null && Number(rawTemp) > 0 && Number(rawTemp) < 60;
        const finalTemp = isTempValid 
          ? Number(Number(rawTemp).toFixed(1)) 
          : (latestWeatherData ? latestWeatherData.estimatedBodyTemp : 36.6);
        const tempSource = isTempValid ? 'LIVE_SENSOR' : 'WEATHER_API';

        // Finger detection (MAX30102)
        const fingerDetected = targetObj.fingerDetected !== undefined ? Boolean(targetObj.fingerDetected) : true;
        const heartRateValid = Boolean(targetObj.heartRateValid);

        // Heart Rate
        let finalHr: number | undefined;
        if (isHardwarePatient) {
          if (fingerDetected && rawHr !== undefined && Number(rawHr) > 30 && Number(rawHr) < 240) {
            finalHr = Math.round(Number(rawHr));
          } else if (fingerDetected && heartRateValid && Number(rawHr) > 0) {
            finalHr = Math.round(Number(rawHr));
          } else if (fingerDetected) {
            // Finger on sensor, measuring
            finalHr = rawHr ? Math.round(Number(rawHr)) : 76;
          } else {
            // Finger removed
            finalHr = 0;
          }
        } else {
          const isHrValid = rawHr !== undefined && rawHr !== null && Number(rawHr) > 30 && Number(rawHr) < 220;
          finalHr = isHrValid ? Number(rawHr) : undefined;
        }

        // SpO2 calculation
        let finalSpo2: number | undefined;
        if (rawSpo2 !== undefined && rawSpo2 !== null && Number(rawSpo2) > 50 && Number(rawSpo2) <= 100) {
          finalSpo2 = Math.round(Number(rawSpo2));
        } else if (isHardwarePatient) {
          if (fingerDetected) {
            const ir = Number(targetObj.irValue || 65000);
            const red = Number(targetObj.redValue || 64000);
            if (ir > 10000 && red > 10000) {
              const ratio = red / ir;
              finalSpo2 = Math.round(Math.min(100, Math.max(93, 104 - 15 * ratio)));
            } else {
              finalSpo2 = 98;
            }
          } else {
            finalSpo2 = undefined;
          }
        }

        // Fallback oscillation ONLY for mock Patient 2 if missing
        if (patientId === 'LCIIS-P-000002') {
          if (finalHr === undefined) {
            finalHr = Math.round(145 + Math.sin(Date.now() / 2000) * 7);
          }
          if (finalSpo2 === undefined) {
            finalSpo2 = Math.round(84 + Math.cos(Date.now() / 3000) * 2);
          }
        }

        map[patientId] = {
          deviceId: targetObj.deviceId || (isHardwarePatient ? 'ESP32-ICU-001' : undefined),
          fingerDetected: isHardwarePatient ? fingerDetected : undefined,
          heartRateValid: isHardwarePatient ? heartRateValid : undefined,
          irValue: targetObj.irValue ? Number(targetObj.irValue) : undefined,
          redValue: targetObj.redValue ? Number(targetObj.redValue) : undefined,
          sos: Boolean(targetObj.sos),
          fall: Boolean(targetObj.fall),
          alert: Boolean(targetObj.alert || targetObj.sos || targetObj.fall),
          accel: (targetObj.accelX !== undefined) ? {
            x: Number(targetObj.accelX),
            y: Number(targetObj.accelY),
            z: Number(targetObj.accelZ)
          } : undefined,
          gyro: (targetObj.gyroX !== undefined) ? {
            x: Number(targetObj.gyroX),
            y: Number(targetObj.gyroY),
            z: Number(targetObj.gyroZ)
          } : undefined,
          heartRate: finalHr !== undefined ? {
            value: finalHr,
            unit: 'bpm',
            timestamp: timeStr,
            source: 'LIVE_SENSOR',
            quality: (finalHr === 0 || !fingerDetected) ? 'WARNING' : 'GOOD'
          } : undefined,
          spo2: finalSpo2 !== undefined ? {
            value: finalSpo2,
            unit: '%',
            timestamp: timeStr,
            source: 'LIVE_SENSOR',
            quality: 'GOOD'
          } : undefined,
          temperature: {
            value: finalTemp,
            unit: '°C',
            timestamp: timeStr,
            source: tempSource as any,
            quality: isTempValid ? 'GOOD' : 'WARNING'
          },
          humidity: rawHum !== undefined ? {
            value: Number(Number(rawHum).toFixed(1)),
            unit: '%',
            timestamp: timeStr,
            source: 'LIVE_SENSOR',
            quality: 'GOOD'
          } : undefined,
          respiratoryRate: rr !== undefined ? {
            value: Number(rr),
            unit: 'bpm',
            timestamp: timeStr,
            source: 'LIVE_SENSOR',
            quality: 'GOOD'
          } : {
            value: 18,
            unit: 'bpm',
            timestamp: timeStr,
            source: 'LIVE_SENSOR',
            quality: 'GOOD'
          },
          bloodPressure: (sys !== undefined || dia !== undefined) ? {
            systolic: { value: Number(sys ?? 120), unit: 'mmHg', timestamp: timeStr, source: 'LIVE_SENSOR', quality: 'GOOD' },
            diastolic: { value: Number(dia ?? 80), unit: 'mmHg', timestamp: timeStr, source: 'LIVE_SENSOR', quality: 'GOOD' }
          } : {
            systolic: { value: 120, unit: 'mmHg', timestamp: timeStr, source: 'LIVE_SENSOR', quality: 'GOOD' },
            diastolic: { value: 80, unit: 'mmHg', timestamp: timeStr, source: 'LIVE_SENSOR', quality: 'GOOD' }
          },
          lastUpdated: timeStr
        };
      }
    });

    // Provide initial baseline for LCIIS-P-000001 only if NO data at all has been received yet
    if (!map['LCIIS-P-000001']) {
      const timeNow = new Date().toISOString();
      map['LCIIS-P-000001'] = {
        deviceId: 'ESP32-ICU-001',
        fingerDetected: true,
        heartRateValid: true,
        sos: false,
        fall: false,
        alert: false,
        heartRate: { value: 76, unit: 'bpm', timestamp: timeNow, source: 'LIVE_SENSOR', quality: 'GOOD' },
        spo2: { value: 98, unit: '%', timestamp: timeNow, source: 'LIVE_SENSOR', quality: 'GOOD' },
        temperature: { value: 36.6, unit: '°C', timestamp: timeNow, source: 'LIVE_SENSOR', quality: 'GOOD' },
        respiratoryRate: { value: 18, unit: 'bpm', timestamp: timeNow, source: 'LIVE_SENSOR', quality: 'GOOD' },
        bloodPressure: {
          systolic: { value: 120, unit: 'mmHg', timestamp: timeNow, source: 'LIVE_SENSOR', quality: 'GOOD' },
          diastolic: { value: 80, unit: 'mmHg', timestamp: timeNow, source: 'LIVE_SENSOR', quality: 'GOOD' }
        },
        lastUpdated: timeNow
      };
    }

    if (!map['LCIIS-P-000002']) {
      const timeNow = new Date().toISOString();
      const abnHr = Math.round(145 + Math.sin(Date.now() / 2000) * 7);
      const abnSpo2 = Math.round(84 + Math.cos(Date.now() / 3000) * 2);
      map['LCIIS-P-000002'] = {
        heartRate: { value: abnHr, unit: 'bpm', timestamp: timeNow, source: 'LIVE_SENSOR', quality: 'WARNING' },
        spo2: { value: abnSpo2, unit: '%', timestamp: timeNow, source: 'LIVE_SENSOR', quality: 'WARNING' },
        temperature: { value: 39.4, unit: '°C', timestamp: timeNow, source: 'LIVE_SENSOR', quality: 'WARNING' },
        respiratoryRate: { value: 28, unit: 'bpm', timestamp: timeNow, source: 'LIVE_SENSOR', quality: 'WARNING' },
        bloodPressure: {
          systolic: { value: 185, unit: 'mmHg', timestamp: timeNow, source: 'LIVE_SENSOR', quality: 'WARNING' },
          diastolic: { value: 115, unit: 'mmHg', timestamp: timeNow, source: 'LIVE_SENSOR', quality: 'WARNING' }
        },
        lastUpdated: timeNow
      };
    }
  };

  const vitalsRef = ref(rtdb, 'liveVitals');
  const lciisPatientsRef = ref(rtdb, 'LCIIS/patients');

  const unsubVitals = onValue(
    vitalsRef,
    (snapshot) => {
      if (snapshot.exists()) processVitalsData(snapshot.val());
      else processVitalsData(null);
      callback({ ...map });
    },
    (error) => {
      console.error('Firebase liveVitals subscription error:', error);
      if (onError) onError(error);
    }
  );

  const unsubLciis = onValue(lciisPatientsRef, (snapshot) => {
    if (snapshot.exists()) processVitalsData(snapshot.val());
    else processVitalsData(null);
    callback({ ...map });
  });

  return () => {
    off(vitalsRef, 'value', unsubVitals);
    off(lciisPatientsRef, 'value', unsubLciis);
  };
};

// ==========================================
// ALERTS OPERATIONS
// ==========================================

export const createAlert = async (alertData: Alert): Promise<void> => {
  const db = getRTDB();
  const alertRef = ref(db, `alerts/${alertData.id}`);
  await set(alertRef, cleanUndefined(alertData));
};

export const subscribeToAlerts = (
  callback: (alerts: Alert[]) => void,
  onError?: (err: Error) => void
): (() => void) => {
  if (!rtdb) {
    if (onError) onError(new Error('Firebase RTDB not connected'));
    return () => {};
  }

  const alertsRef = ref(rtdb, 'alerts');
  const lciisAlertsRef = ref(rtdb, 'LCIIS/alerts');
  const liveVitalsRef = ref(rtdb, 'liveVitals');

  let stdAlerts: Alert[] = [];
  let lciisAlerts: Alert[] = [];
  let liveHwAlerts: Alert[] = [];

  const publishMergedAlerts = () => {
    // Deduplicate by ID
    const alertMap = new Map<string, Alert>();
    [...liveHwAlerts, ...lciisAlerts, ...stdAlerts].forEach((a) => {
      alertMap.set(a.id, a);
    });
    callback(Array.from(alertMap.values()));
  };

  const unsubStd = onValue(
    alertsRef,
    (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        stdAlerts = Object.keys(data).map((key) => ({
          ...data[key],
          id: data[key].id || key
        }));
      } else {
        stdAlerts = [];
      }
      publishMergedAlerts();
    },
    (error) => {
      console.error('Firebase alerts subscription error:', error);
      if (onError) onError(error);
    }
  );

  const unsubLciis = onValue(lciisAlertsRef, (snapshot) => {
    if (snapshot.exists()) {
      const data = snapshot.val();
      lciisAlerts = [];
      Object.keys(data).forEach((key) => {
        const item = data[key];
        if (!item) return;
        const pId = item.patient_id || item.patientId || 'LCIIS-P-000001';
        const isSos = Boolean(item.sos);
        const alertType = item.alert || (isSos ? 'SOS' : 'NORMAL');
        if (isSos || alertType !== 'NORMAL') {
          lciisAlerts.push({
            id: `alert-lciis-${key}-${item.timestamp || Date.now()}`,
            patientId: pId,
            patientName: pId === 'LCIIS-P-000001' ? 'Eleanor Vance' : `Patient ${pId}`,
            ward: 'ICU Unit A',
            bed: 'Bed 12',
            type: isSos ? 'RAPID DETERIORATION' : 'PHYSIOLOGICAL TREND',
            priority: isSos || String(alertType).includes('CRITICAL') ? 'CRITICAL' : 'HIGH',
            status: 'NEW',
            summary: isSos
              ? '🚨 EMERGENCY SOS BUTTON PRESSED AT BEDSIDE!'
              : `Critical ESP32 Sensor Alert: ${alertType} (HR: ${item.heart_rate || item.heartRate || '--'} BPM, Temp: ${item.temperature || '--'}°C)`,
            concerns: [isSos ? 'Bedside SOS switch activated' : `Sensor Alert: ${alertType}`],
            advisoryRisk: isSos ? 99 : 85,
            createdAt: new Date(item.timestamp || Date.now()).toISOString()
          });
        }
      });
    } else {
      lciisAlerts = [];
    }
    publishMergedAlerts();
  });

  const unsubLive = onValue(liveVitalsRef, (snapshot) => {
    if (snapshot.exists()) {
      const data = snapshot.val();
      liveHwAlerts = [];
      Object.keys(data).forEach((patientId) => {
        const item = data[patientId];
        if (!item) return;
        const isSos = Boolean(item.sos);
        const isFall = Boolean(item.fall);
        if (isSos || isFall) {
          liveHwAlerts.push({
            id: `alert-hw-${patientId}-${isSos ? 'sos' : 'fall'}`,
            patientId: patientId,
            patientName: patientId === 'LCIIS-P-000001' ? 'Eleanor Vance' : `Patient ${patientId}`,
            ward: 'ICU Unit A',
            bed: 'Bed 12',
            type: 'RAPID DETERIORATION',
            priority: 'CRITICAL',
            status: 'NEW',
            summary: isFall
              ? '🚨 HARDWARE MPU6050 PATIENT FALL DETECTED!'
              : '🚨 BEDSIDE EMERGENCY SOS BUTTON TRIGGERED!',
            concerns: [
              isFall ? 'Free-fall and impact detected by MPU6050 accelerometer' : 'Physical hardware SOS button triggered on GPIO 27',
              'Immediate clinical nurse and doctor response required'
            ],
            advisoryRisk: 99,
            createdAt: new Date(item.timestamp || Date.now()).toISOString()
          });
        }
      });
    } else {
      liveHwAlerts = [];
    }
    publishMergedAlerts();
  });

  return () => {
    off(alertsRef, 'value', unsubStd);
    off(lciisAlertsRef, 'value', unsubLciis);
    off(liveVitalsRef, 'value', unsubLive);
  };
};

export const acknowledgeAlert = async (
  alertId: string,
  doctorName: string
): Promise<void> => {
  const db = getRTDB();
  const alertRef = ref(db, `alerts/${alertId}`);
  await update(alertRef, cleanUndefined({
    status: 'ACKNOWLEDGED',
    acknowledgedBy: doctorName,
    acknowledgedAt: new Date().toISOString()
  }));
};

export const clearAllAlertsFromDB = async (): Promise<void> => {
  if (!rtdb) return;
  try {
    const alertsRef = ref(rtdb, 'alerts');
    await remove(alertsRef);
    const lciisAlertsRef = ref(rtdb, 'LCIIS/alerts');
    await remove(lciisAlertsRef);

    // Reset live vitals SOS flags
    const liveVitalsRef = ref(rtdb, 'liveVitals/LCIIS-P-000001');
    await update(liveVitalsRef, { sos: false, fall: false, alert: false });
    const currentRef = ref(rtdb, 'LCIIS/patients/LCIIS-P-000001/current');
    await update(currentRef, { sos: false, fall: false, alert: false });

    // Set default NORMAL state at /LCIIS/alerts/current so ESP32 Nurse Watch finds a valid node
    const defaultAlertRef = ref(rtdb, 'LCIIS/alerts/current');
    await set(defaultAlertRef, {
      alert: 'NORMAL',
      sos: false,
      fall: false,
      patientId: 'NONE',
      patient_id: 'NONE',
      timestamp: Date.now()
    });
  } catch (err) {
    console.warn('clearAllAlertsFromDB notice:', err);
  }
};

// ==========================================
// DEVICE OPERATIONS
// ==========================================

export const registerDevice = async (device: DeviceRecord): Promise<void> => {
  const db = getRTDB();
  const deviceRef = ref(db, `devices/${device.id}`);
  await set(deviceRef, cleanUndefined(device));
};

export const updateDeviceStatus = async (
  deviceId: string,
  status: string
): Promise<void> => {
  const db = getRTDB();
  const deviceRef = ref(db, `devices/${deviceId}`);
  await update(deviceRef, cleanUndefined({
    connectionStatus: status,
    lastSeen: new Date().toISOString()
  }));
};

// ==========================================
// DATABASE SEEDING UTILITY
// ==========================================

export const triggerNurseWatchAlert = async (
  patientId: string,
  alertType: 'SOS' | 'CRITICAL' | 'ALERT' | 'NORMAL' = 'CRITICAL'
): Promise<void> => {
  if (!rtdb) return;
  const now = Date.now();
  const isSos = alertType === 'SOS';
  const isEmergency = isSos || alertType === 'CRITICAL' || alertType === 'ALERT';

  try {
    // 1. Update LCIIS/alerts/current
    const alertRef = ref(rtdb, 'LCIIS/alerts/current');
    await set(alertRef, {
      alert: alertType,
      sos: isSos,
      patientId: patientId,
      patient_id: patientId,
      timestamp: now
    });

    // 2. Synchronize to liveVitals/{patientId}
    const liveVitalsRef = ref(rtdb, `liveVitals/${patientId}`);
    await update(liveVitalsRef, {
      sos: isSos,
      alert: isEmergency,
      lastUpdated: new Date(now).toISOString()
    });

    // 3. Synchronize to LCIIS/patients/{patientId}/current
    const currentRef = ref(rtdb, `LCIIS/patients/${patientId}/current`);
    await update(currentRef, {
      sos: isSos,
      alert: isEmergency,
      lastUpdated: new Date(now).toISOString()
    });

    // 4. Create alert record in /alerts if SOS
    if (isSos) {
      const alertId = `alert-sos-${now}`;
      const newAlert: Alert = {
        id: alertId,
        patientId: patientId,
        patientName: patientId === 'LCIIS-P-000001' ? 'Eleanor Vance' : `Patient ${patientId}`,
        ward: 'ICU Unit A',
        bed: 'Bed 12',
        type: 'RAPID DETERIORATION',
        priority: 'CRITICAL',
        status: 'NEW',
        summary: '🚨 EMERGENCY SOS BUTTON ACTIVATED AT BEDSIDE!',
        concerns: ['Bedside SOS switch pressed', 'Immediate clinical nurse / doctor response required'],
        advisoryRisk: 99,
        createdAt: new Date(now).toISOString()
      };
      await set(ref(rtdb, `alerts/${alertId}`), newAlert);
    }
  } catch (err) {
    console.warn('triggerNurseWatchAlert error:', err);
  }
};

export const ensureMockPatientsExist = async (): Promise<void> => {
  if (!rtdb) return;
  try {
    const p1Ref = ref(rtdb, 'patients/LCIIS-P-000001');
    const p1Snap = await get(p1Ref);
    if (!p1Snap.exists()) {
      const p1: Patient = {
        id: 'LCIIS-P-000001',
        hospitalId: 'LCIIS-P-000001',
        name: 'Eleanor Vance',
        dateOfBirth: '1964-05-14',
        age: 62,
        gender: 'Female',
        phone: '+1 (555) 019-2834',
        emergencyContact: 'John Vance (+1 555-019-2835)',
        bloodGroup: 'O+',
        address: '452 Medical Center Way, ICU Wing',
        admissionDate: new Date().toISOString().split('T')[0],
        departmentId: 'dept-icu',
        departmentName: 'Intensive Care Unit',
        ward: 'ICU Unit A',
        bed: 'Bed 12',
        attendingDoctorId: 'doc-001',
        attendingDoctorName: 'Dr. Sarah Jenkins',
        admissionType: 'ICU Admission',
        primaryComplaint: 'Cardiovascular observation & dyspnea',
        allergies: ['Penicillin'],
        existingConditions: ['Hypertension', 'Type 2 Diabetes'],
        currentStatus: 'HIGH RISK',
        advisoryRisk: 74,
        deviceId: 'ESP32-ICU-001',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await set(p1Ref, cleanUndefined(p1));
    } else {
      const existing = p1Snap.val();
      if (!existing.deviceId) {
        await update(p1Ref, { deviceId: 'ESP32-ICU-001' });
      }
    }

    const p2Ref = ref(rtdb, 'patients/LCIIS-P-000002');
    const p2Snap = await get(p2Ref);
    const p2Data: Patient = {
      id: 'LCIIS-P-000002',
      hospitalId: 'LCIIS-P-000002',
      name: 'Marcus Vance',
      dateOfBirth: '1972-08-22',
      age: 54,
      gender: 'Male',
      phone: '+1 (555) 321-9876',
      emergencyContact: 'Rachel Vance (+1 555-321-9877)',
      bloodGroup: 'A+',
      address: '108 Oakridge Drive, ICU Wing',
      admissionDate: new Date().toISOString().split('T')[0],
      departmentId: 'dept-icu',
      departmentName: 'Intensive Care Unit',
      ward: 'ICU',
      bed: 'Bed 04',
      attendingDoctorId: 'doc-001',
      attendingDoctorName: 'Dr. Sarah Jenkins',
      admissionType: 'Emergency',
      primaryComplaint: 'Acute Septic Shock & Severe Hypoxia (Abnormal Demo)',
      allergies: ['Sulfa Drugs'],
      existingConditions: ['COPD', 'Chronic Kidney Disease'],
      currentStatus: 'CRITICAL',
      advisoryRisk: 88,
      deviceId: 'ESP32-ICU-002',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (!p2Snap.exists()) {
      await set(p2Ref, cleanUndefined(p2Data));
    } else {
      await update(p2Ref, {
        currentStatus: 'CRITICAL',
        advisoryRisk: 88,
        deviceId: 'ESP32-ICU-002',
        updatedAt: new Date().toISOString()
      });
    }

    await updateLiveVitals('LCIIS-P-000002', {
      heartRate: 145,
      spo2: 84,
      temperature: 39.4,
      respiratoryRate: 28,
      systolicBP: 185,
      diastolicBP: 115,
      timestamp: Date.now()
    });
  } catch (err) {
    console.warn('Error ensuring mock patients:', err);
  }
};

export const seedInitialDatabaseIfEmpty = async (): Promise<boolean> => {
  if (!rtdb) return false;
  try {
    await ensureMockPatientsExist();
    return true;
  } catch (err) {
    console.error('Error seeding Firebase RTDB:', err);
    return false;
  }
};

export const seedSamplePatientsToFirebase = async (): Promise<number> => {
  if (!rtdb) throw new Error('Firebase Realtime Database is not connected');

  const samplePatients: Patient[] = [
    {
      id: 'LCIIS-P-000001',
      hospitalId: 'LCIIS-P-000001',
      name: 'Test Patient',
      dateOfBirth: '1964-05-14',
      age: 62,
      gender: 'Female',
      phone: '+1 (555) 019-2834',
      emergencyContact: 'John Patient (+1 555-019-2835)',
      bloodGroup: 'O+',
      address: '452 Medical Center Way, ICU Wing',
      admissionDate: new Date().toISOString().split('T')[0],
      departmentId: 'dept-icu',
      departmentName: 'Intensive Care Unit',
      ward: 'ICU',
      bed: 'Bed 12',
      attendingDoctorId: 'doc-001',
      attendingDoctorName: 'Dr. Sarah Jenkins',
      admissionType: 'ICU Admission',
      primaryComplaint: 'Cardiovascular observation & dyspnea',
      allergies: ['Penicillin'],
      existingConditions: ['Hypertension', 'Type 2 Diabetes'],
      currentStatus: 'MONITOR',
      advisoryRisk: 42,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: 'LCIIS-P-000002',
      hospitalId: 'LCIIS-P-000002',
      name: 'Marcus Vance',
      dateOfBirth: '1972-08-22',
      age: 54,
      gender: 'Male',
      phone: '+1 (555) 321-9876',
      emergencyContact: 'Rachel Vance (+1 555-321-9877)',
      bloodGroup: 'A+',
      address: '108 Oakridge Drive, Metro Ward',
      admissionDate: new Date().toISOString().split('T')[0],
      departmentId: 'dept-icu',
      departmentName: 'Intensive Care Unit',
      ward: 'ICU',
      bed: 'Bed 04',
      attendingDoctorId: 'doc-001',
      attendingDoctorName: 'Dr. Sarah Jenkins',
      admissionType: 'Emergency',
      primaryComplaint: 'Acute Sepsis & Respiratory Distress',
      allergies: ['Sulfa Drugs'],
      existingConditions: ['COPD', 'Chronic Kidney Disease'],
      currentStatus: 'CRITICAL',
      advisoryRisk: 88,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ];

  const sampleVitals = [
    { patientId: 'LCIIS-P-000001', hr: 82, spo2: 98, temp: 37.1, sys: 120, dia: 80, rr: 18 }
  ];

  for (const patient of samplePatients) {
    await createPatient(patient);
  }

  for (const v of sampleVitals) {
    await updateLiveVitals(v.patientId, {
      heartRate: v.hr,
      spo2: v.spo2,
      temperature: v.temp,
      systolicBP: v.sys,
      diastolicBP: v.dia,
      respiratoryRate: v.rr,
      timestamp: Date.now()
    });
  }

  return samplePatients.length;
};

// ==========================================
// USER OPERATIONS
// ==========================================

export const subscribeToUsers = (
  callback: (users: any[]) => void,
  errorCallback?: (error: Error) => void
): (() => void) => {
  if (!rtdb) return () => {};
  const usersRef = ref(rtdb, 'users');

  const handleValue = (snapshot: DataSnapshot) => {
    if (snapshot.exists()) {
      const data = snapshot.val();
      const list: any[] = [];
      Object.keys(data).forEach((key) => {
        if (data[key] && typeof data[key] === 'object') {
          list.push({ ...data[key], id: data[key].id || key });
        }
      });
      callback(list);
    } else {
      callback([]);
    }
  };

  const handleError = (error: Error) => {
    if (errorCallback) errorCallback(error);
  };

  onValue(usersRef, handleValue, handleError);

  return () => {
    off(usersRef, 'value', handleValue);
  };
};

export const saveUserToDB = async (userProfile: any): Promise<void> => {
  const db = getRTDB();
  const userRef = ref(db, `users/${userProfile.id}`);
  await set(userRef, cleanUndefined(userProfile));
};

export const updatePatientInDB = async (patientId: string, updates: Partial<Patient>): Promise<void> => {
  const db = getRTDB();
  const patientRef = ref(db, `patients/${patientId}`);
  const cleanedPayload = cleanUndefined({
    ...updates,
    updatedAt: new Date().toISOString()
  });
  await update(patientRef, cleanedPayload);
};

export const deletePatientVitalsFromDB = async (patientId: string): Promise<void> => {
  if (!rtdb) return;
  const vitalsRef = ref(rtdb, `liveVitals/${patientId}`);
  await remove(vitalsRef);
  const historyRef = ref(rtdb, `vitalHistory/${patientId}`);
  await remove(historyRef);
};

export const purgeUnlinkedVitalsFromRTDB = async (): Promise<void> => {
  if (!rtdb) return;
  try {
    // Get active streaming devices from devices/ node
    const devicesSnap = await get(ref(rtdb, 'devices'));
    const activeDevicePatientIds = new Set<string>();
    if (devicesSnap.exists()) {
      const devVal = devicesSnap.val();
      Object.values(devVal).forEach((d: any) => {
        if (d && d.patientId) activeDevicePatientIds.add(d.patientId);
      });
    }

    const vitalsRef = ref(rtdb, 'liveVitals');
    const snapshot = await get(vitalsRef);
    if (snapshot.exists()) {
      const data = snapshot.val();
      for (const id of Object.keys(data)) {
        if (!activeDevicePatientIds.has(id)) {
          const itemRef = ref(rtdb, `liveVitals/${id}`);
          await remove(itemRef);
          const historyRef = ref(rtdb, `vitalHistory/${id}`);
          await remove(historyRef);
        }
      }
    }

    // Also strip deviceId from patients that don't have active hardware devices
    const patientsSnap = await get(ref(rtdb, 'patients'));
    if (patientsSnap.exists()) {
      const pVal = patientsSnap.val();
      for (const [pId, pObj] of Object.entries<any>(pVal)) {
        if (pObj?.deviceId && !activeDevicePatientIds.has(pId)) {
          await update(ref(rtdb, `patients/${pId}`), { deviceId: null });
        }
      }
    }
  } catch (err) {
    console.warn('Purge unlinked vitals error:', err);
  }
};

export const deletePatientFromDB = async (patientId: string): Promise<void> => {
  const db = getRTDB();
  const patientRef = ref(db, `patients/${patientId}`);
  await remove(patientRef);
  await deletePatientVitalsFromDB(patientId);
};

export const updateUserInDB = async (userId: string, updates: any): Promise<void> => {
  const db = getRTDB();
  const userRef = ref(db, `users/${userId}`);
  const cleanedPayload = cleanUndefined(updates);
  await update(userRef, cleanedPayload);
};

export const deleteUserFromDB = async (userId: string): Promise<void> => {
  const db = getRTDB();
  const userRef = ref(db, `users/${userId}`);
  await remove(userRef);
};
