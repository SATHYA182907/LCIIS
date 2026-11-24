import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import type {
  Patient,
  LaboratoryResult,
  LiveVitals,
  Alert,
  AlertPriority,
  InventoryItem,
  StockMovement,
  DeviceRecord,
  AuditLog,
  NurseObservation,
  DoctorRemark,
  MedicationRecord,
  InterventionRecord,
  RiskAssessment,
  TrendResult,
  UserProfile,
  UserAccountStatus
} from '../types';
import {
  DEMO_USERS,
  INITIAL_LAB_RESULTS,
  INITIAL_INVENTORY,
  INITIAL_DEVICES,
  INITIAL_REMARKS,
  INITIAL_MEDICATIONS,
  INITIAL_INTERVENTIONS,
  INITIAL_AUDIT_LOGS,
  INITIAL_DEMO_PATIENT
} from '../lib/seedData';

import { isFirebaseConfigured, rtdb, ensureFirebaseAuth } from '../lib/firebase';
import { alarmAudio } from '../services/alarmAudioService';
import {
  subscribeToPatients,
  subscribeToLiveVitals,
  subscribeToAlerts,
  subscribeToUsers,
  saveUserToDB,
  createPatient as firebaseCreatePatient,
  updatePatientInDB,
  deletePatientFromDB,
  updateUserInDB,
  deleteUserFromDB,
  updateLiveVitals as firebaseUpdateLiveVitals,
  acknowledgeAlert as firebaseAcknowledgeAlert,
  resolveAlert as firebaseResolveAlert,
  clearAllAlertsFromDB as firebaseClearAllAlertsFromDB,
  updateDeviceStatus as firebaseUpdateDeviceStatus,
  seedInitialDatabaseIfEmpty,
  ensureMockPatientsExist,
  triggerNurseWatchAlert,
  purgeUnlinkedVitalsFromRTDB,
  createAlert,
  getOscillatedHumanVitals
} from '../services/firebaseService';

import { TrendAnalysisEngine } from '../services/trendService';
import { AnomalyEngine, type AnomalyDetectionResult } from '../services/anomalyService';
import { RiskAggregator } from '../services/riskService';
import { ExplanationEngine } from '../services/explanationService';
import { AuditService } from '../services/auditService';

interface RealtimeContextType {
  users: UserProfile[];
  patients: Patient[];
  selectedPatientId: string;
  setSelectedPatientId: (id: string) => void;
  getPatientById: (id: string) => Patient | undefined;
  
  labResults: LaboratoryResult[];
  liveVitalsMap: Record<string, LiveVitals>;
  alerts: Alert[];
  inventory: InventoryItem[];
  stockMovements: StockMovement[];
  devices: DeviceRecord[];
  auditLogs: AuditLog[];
  nurseObservations: NurseObservation[];
  doctorRemarks: DoctorRemark[];
  medications: MedicationRecord[];
  interventions: InterventionRecord[];

  // Firebase status
  isFirebaseConnected: boolean;
  firebaseError: string | null;
  isLoadingFirebase: boolean;
  retryFirebaseConnection: () => Promise<void>;

  // Dynamic Calculators & Readers
  getPatientTrends: (patientId: string) => TrendResult[];
  getPatientRiskAssessment: (patientId: string) => RiskAssessment;
  getPatientExplanation: (patientId: string) => ReturnType<typeof ExplanationEngine.generateExplanation>;

  // Clinical & Operations Mutations
  addUser: (user: Omit<UserProfile, 'id' | 'createdAt'>) => void;
  updateUser: (userId: string, updates: Partial<UserProfile>) => Promise<void>;
  updateUserStatus: (userId: string, status: UserAccountStatus, reason?: string) => void;
  approveUser: (userId: string, adminName?: string) => void;
  rejectUser: (userId: string) => void;
  removeUser: (userId: string) => Promise<void>;
  bulkRemoveUsers: (userIds: string[]) => Promise<void>;
  bulkUpdateUsers: (userIds: string[], updates: Partial<UserProfile>) => Promise<void>;
  addPatient: (patient: Partial<Patient>) => Promise<Patient>;
  updatePatient: (patientId: string, updates: Partial<Patient>) => Promise<void>;
  removePatient: (patientId: string) => Promise<void>;
  bulkRemovePatients: (patientIds: string[]) => Promise<void>;
  bulkUpdatePatients: (patientIds: string[], updates: Partial<Patient>) => Promise<void>;
  addLaboratoryResult: (result: Omit<LaboratoryResult, 'id' | 'createdAt'>) => void;
  updateLiveVitals: (patientId: string, vitals: any) => Promise<void>;
  acknowledgeAlert: (alertId: string, doctorName: string) => Promise<void>;
  resolveAlert: (alertId: string, doctorName?: string) => Promise<void>;
  clearAllAlerts: () => Promise<void>;
  overrideAlert: (alertId: string, doctorName: string, reason: string) => void;
  addNurseObservation: (observation: Omit<NurseObservation, 'id' | 'timestamp'>) => void;
  addDoctorRemark: (remark: Omit<DoctorRemark, 'id' | 'timestamp'>) => void;
  addMedication: (med: Omit<MedicationRecord, 'id'>) => void;
  addIntervention: (intervention: Omit<InterventionRecord, 'id' | 'timestamp'>) => void;
  processStockMovement: (itemId: string, qty: number, type: StockMovement['type'], performedBy: string, reason: string) => void;
  updateDeviceStatus: (deviceId: string, status: DeviceRecord['connectionStatus']) => void;
  triggerWatchAlert: (patientId: string, alertType?: 'SOS' | 'CRITICAL' | 'ALERT' | 'NORMAL') => Promise<void>;
}

const RealtimeContext = createContext<RealtimeContextType | undefined>(undefined);

export const RealtimeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [users, setUsers] = useState<UserProfile[]>(DEMO_USERS);
  const [patients, setPatients] = useState<Patient[]>([INITIAL_DEMO_PATIENT]);
  const [selectedPatientId, setSelectedPatientId] = useState<string>('LCIIS-P-000001');
  const [labResults, setLabResults] = useState<LaboratoryResult[]>(INITIAL_LAB_RESULTS);
  const [liveVitalsMap, setLiveVitalsMap] = useState<Record<string, LiveVitals>>({});
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>(INITIAL_INVENTORY);
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);
  const [devices, setDevices] = useState<DeviceRecord[]>(INITIAL_DEVICES);
  const [auditLogs] = useState<AuditLog[]>(INITIAL_AUDIT_LOGS);
  
  const [nurseObservations, setNurseObservations] = useState<NurseObservation[]>([]);
  const [doctorRemarks, setDoctorRemarks] = useState<DoctorRemark[]>(INITIAL_REMARKS);
  const [medications, setMedications] = useState<MedicationRecord[]>(INITIAL_MEDICATIONS);
  const [interventions, setInterventions] = useState<InterventionRecord[]>(INITIAL_INTERVENTIONS);

  const [isFirebaseConnected, setIsFirebaseConnected] = useState<boolean>(false);
  const [firebaseError, setFirebaseError] = useState<string | null>(null);
  const [isLoadingFirebase, setIsLoadingFirebase] = useState<boolean>(true);
  const [retryKey, setRetryKey] = useState<number>(0);

  const retryFirebaseConnection = useCallback(async () => {
    setIsLoadingFirebase(true);
    setFirebaseError(null);
    setRetryKey((prev) => prev + 1);
  }, []);

  // Initialize Audit Log Service
  useEffect(() => {
    AuditService.initialize(auditLogs);
  }, []);

  // Sync Users from localStorage and cross-tab/window events
  useEffect(() => {
    const handleSync = () => {
      const saved = localStorage.getItem('lciis_all_users');
      if (saved) {
        try {
          const parsed: UserProfile[] = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setUsers((prev) => {
              const map = new Map<string, UserProfile>();
              DEMO_USERS.forEach((u) => map.set(u.email.toLowerCase(), u));
              prev.forEach((u) => map.set(u.email.toLowerCase(), u));
              parsed.forEach((u) => map.set(u.email.toLowerCase(), { ...map.get(u.email.toLowerCase()), ...u }));
              return Array.from(map.values());
            });
          }
        } catch (e) { /* ignore */ }
      }
    };

    handleSync();
    window.addEventListener('storage', handleSync);
    window.addEventListener('lciis-users-updated', handleSync);
    return () => {
      window.removeEventListener('storage', handleSync);
      window.removeEventListener('lciis-users-updated', handleSync);
    };
  }, []);

  // Connect Firebase Realtime Database Listeners
  useEffect(() => {
    if (!isFirebaseConfigured() || !rtdb) {
      setIsLoadingFirebase(false);
      setFirebaseError('Firebase is not configured. Add environment variables to .env.');
      return;
    }

    let unsubPatients: (() => void) | undefined;
    let unsubVitals: (() => void) | undefined;
    let unsubAlerts: (() => void) | undefined;
    let unsubUsers: (() => void) | undefined;

    const setupFirebaseSync = async () => {
      try {
        setIsLoadingFirebase(true);
        setFirebaseError(null);

        // Ensure Firebase Auth session is active before RTDB operations
        try {
          await ensureFirebaseAuth();
        } catch (authErr) {
          console.warn('Firebase Auth initialization warning:', authErr);
        }

        // Attempt seeding initial database if empty - wrapped safely so rules restrictions do not block subscriptions
        try {
          await seedInitialDatabaseIfEmpty();
          await ensureMockPatientsExist();
          await purgeUnlinkedVitalsFromRTDB();
        } catch (seedErr) {
          console.warn('Firebase RTDB seeding notice (security rules may restrict write):', seedErr);
        }

        // 1. Subscribe to Patients
        unsubPatients = subscribeToPatients(
          (remotePatients) => {
            if (remotePatients && remotePatients.length > 0) {
              setPatients(remotePatients);
              setSelectedPatientId((curr) => {
                const exists = remotePatients.some((p) => p.id === curr || p.hospitalId === curr);
                return exists ? curr : (remotePatients[0].id || remotePatients[0].hospitalId);
              });
            } else {
              setPatients([INITIAL_DEMO_PATIENT]);
            }
            setIsFirebaseConnected(true);
            setFirebaseError(null);
            setIsLoadingFirebase(false);
          },
          (err) => {
            console.error('Patients subscription failed:', err);
            setPatients((curr) => (curr && curr.length > 0 ? curr : [INITIAL_DEMO_PATIENT]));
            setFirebaseError('Database access error: Check Firebase Realtime Database Security Rules.');
            setIsFirebaseConnected(false);
            setIsLoadingFirebase(false);
          }
        );

        // 2. Subscribe to Live Vitals
        unsubVitals = subscribeToLiveVitals(
          (vitalsMap) => {
            if (vitalsMap && Object.keys(vitalsMap).length > 0) {
              setLiveVitalsMap(vitalsMap);
            }
          },
          (err) => {
            console.error('Live vitals subscription failed:', err);
          }
        );

        // 3. Subscribe to Alerts
        let lastSosToastTime = 0;
        unsubAlerts = subscribeToAlerts(
          (remoteAlerts) => {
            setAlerts(remoteAlerts || []);
            const now = Date.now();
            // Real-time freshness: only trigger siren and popup toast if the alert occurred in the last 45 seconds
            // or if the live hardware stream currently has an active SOS flag
            const activeSos = (remoteAlerts || []).find((a) => {
              if (a.status !== 'NEW') return false;
              const isSosOrFall = a.summary.includes('SOS') || a.summary.includes('FALL') || a.type === 'RAPID DETERIORATION';
              if (!isSosOrFall) return false;
              const alertTs = new Date(a.createdAt).getTime();
              return (now - alertTs < 45000);
            });

            if (activeSos) {
              alarmAudio.startAlarm();
              if (now - lastSosToastTime > 6000) {
                lastSosToastTime = now;
                toast.error('🚨 BEDSIDE EMERGENCY SOS BUTTON PRESSED!', {
                  description: `${activeSos.summary} - Location: ${activeSos.ward} (${activeSos.bed}) - Patient: ${activeSos.patientId}`,
                  duration: 10000
                });
              }
            } else {
              alarmAudio.stopAlarm();
            }
          },
          (err) => {
            console.error('Alerts subscription failed:', err);
          }
        );

        // 4. Subscribe to Users
        unsubUsers = subscribeToUsers(
          (remoteUsers) => {
            if (remoteUsers.length > 0) {
              setUsers((prev) => {
                const map = new Map<string, UserProfile>();
                DEMO_USERS.forEach((u) => map.set(u.email.toLowerCase(), u));
                prev.forEach((u) => map.set(u.email.toLowerCase(), u));
                remoteUsers.forEach((u) => map.set(u.email.toLowerCase(), { ...map.get(u.email.toLowerCase()), ...u }));
                const merged = Array.from(map.values());
                localStorage.setItem('lciis_all_users', JSON.stringify(merged));
                return merged;
              });
            }
          },
          (err) => console.warn('Users subscription notice:', err)
        );
      } catch (err: any) {
        console.error('Failed to setup Firebase RTDB sync:', err);
        setFirebaseError(err.message || 'Firebase initialization failed.');
        setIsLoadingFirebase(false);
      }
    };

    setupFirebaseSync();

    return () => {
      if (unsubPatients) unsubPatients();
      if (unsubVitals) unsubVitals();
      if (unsubAlerts) unsubAlerts();
      if (unsubUsers) unsubUsers();
    };
  }, [retryKey]);

  // Real-time continuous human vital oscillation engine for patient LCIIS-P-000001 (Eleanor Vance)
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const timeStr = new Date(now).toISOString();
      const mock = getOscillatedHumanVitals(now);

      setLiveVitalsMap((prev) => {
        const p1 = prev['LCIIS-P-000001'];
        const updated: LiveVitals = {
          ...(p1 || {}),
          deviceId: p1?.deviceId || 'ESP32-ICU-001',
          fingerDetected: true,
          heartRateValid: true,
          sos: p1?.sos || false,
          fall: p1?.fall || false,
          alert: p1?.alert || false,
          accel: p1?.accel,
          gyro: p1?.gyro,
          heartRate: {
            value: mock.heartRate,
            unit: 'bpm',
            timestamp: timeStr,
            source: 'LIVE_SENSOR',
            quality: 'GOOD'
          },
          spo2: {
            value: mock.spo2,
            unit: '%',
            timestamp: timeStr,
            source: 'LIVE_SENSOR',
            quality: 'GOOD'
          },
          bloodPressure: {
            systolic: {
              value: p1?.bloodPressure?.systolic?.value ?? mock.systolic,
              unit: 'mmHg',
              timestamp: timeStr,
              source: 'LIVE_SENSOR',
              quality: 'GOOD'
            },
            diastolic: {
              value: p1?.bloodPressure?.diastolic?.value ?? mock.diastolic,
              unit: 'mmHg',
              timestamp: timeStr,
              source: 'LIVE_SENSOR',
              quality: 'GOOD'
            }
          },
          respiratoryRate: {
            value: p1?.respiratoryRate?.value ?? mock.respiratoryRate,
            unit: 'bpm',
            timestamp: timeStr,
            source: 'LIVE_SENSOR',
            quality: 'GOOD'
          },
          temperature: p1?.temperature?.value ? p1.temperature : {
            value: mock.temperature,
            unit: '°C',
            timestamp: timeStr,
            source: 'LIVE_SENSOR',
            quality: 'GOOD'
          },
          lastUpdated: timeStr
        };

        return {
          ...prev,
          'LCIIS-P-000001': updated,
          'P12345': updated
        };
      });
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const getPatientById = useCallback((id: string) => {
    if (!id) return undefined;
    return patients.find(
      (p) =>
        p.id === id ||
        p.hospitalId === id ||
        (id === 'P12345' && (p.id === 'LCIIS-P-000001' || p.hospitalId === 'LCIIS-P-000001')) ||
        ((p.id === 'P12345' || p.hospitalId === 'LCIIS-P-000001') && (id === 'LCIIS-P-000001' || id === 'P12345'))
    );
  }, [patients]);

  // Dynamic Trend Analysis Calculation for a patient
  const getPatientTrends = useCallback((patientId: string): TrendResult[] => {
    const patientLabs = labResults.filter((l) => l.patientId === patientId || (patientId === 'P12345' && l.patientId === 'P12345'));
    
    const labGroups: Record<string, LaboratoryResult[]> = {};
    patientLabs.forEach((l) => {
      if (!labGroups[l.testName]) labGroups[l.testName] = [];
      labGroups[l.testName].push(l);
    });

    const trends: TrendResult[] = [];

    if (labGroups['Creatinine']) {
      const dataPoints = labGroups['Creatinine'].map((l) => ({ timestamp: l.sampleCollectedAt, value: l.value }));
      trends.push(
        TrendAnalysisEngine.analyzeTimeSeries('Creatinine', dataPoints, { low: 0.6, high: 1.2 }, false)
      );
    }

    if (labGroups['CRP (C-Reactive Protein)'] || labGroups['CRP']) {
      const group = labGroups['CRP (C-Reactive Protein)'] || labGroups['CRP'];
      const dataPoints = group.map((l) => ({ timestamp: l.sampleCollectedAt, value: l.value }));
      trends.push(
        TrendAnalysisEngine.analyzeTimeSeries('CRP', dataPoints, { low: 0, high: 10 }, false)
      );
    }

    return trends;
  }, [labResults]);

  // Dynamic Risk Assessment Calculation for a patient
  const getPatientRiskAssessment = useCallback((patientId: string): RiskAssessment => {
    const patient = getPatientById(patientId) || INITIAL_DEMO_PATIENT;
    const vitals = liveVitalsMap[patientId] || {};
    const trends = getPatientTrends(patientId);
    const labList = labResults.filter((l) => l.patientId === patientId);

    const anomalies: AnomalyDetectionResult[] = [];
    trends.forEach((t) => {
      const pts = labList
        .filter((l) => l.testName === t.parameterName || (t.parameterName === 'CRP' && l.testName.includes('CRP')))
        .map((l) => ({ timestamp: l.sampleCollectedAt, value: l.value }));
      
      const anomaly = AnomalyEngine.detectAnomaly(t.parameterName, pts, t.referenceRange);
      if (anomaly.isAnomaly) anomalies.push(anomaly);
    });

    return RiskAggregator.calculateRisk({
      patient,
      labResults: labList,
      vitals,
      trends,
      anomalies,
    });
  }, [getPatientById, liveVitalsMap, getPatientTrends, labResults]);

  const getPatientExplanation = useCallback((patientId: string) => {
    const patient = getPatientById(patientId) || INITIAL_DEMO_PATIENT;
    const risk = getPatientRiskAssessment(patientId);
    const trends = getPatientTrends(patientId);
    const vitals = liveVitalsMap[patientId] || {};
    const labs = labResults.filter((l) => l.patientId === patientId);

    return ExplanationEngine.generateExplanation(patient, risk, trends, vitals, labs);
  }, [getPatientById, getPatientRiskAssessment, getPatientTrends, liveVitalsMap, labResults]);

  // Actions
  const addUser = useCallback((newUser: Omit<UserProfile, 'id' | 'createdAt'>) => {
    const fullUser: UserProfile = {
      ...newUser,
      id: newUser.email ? `user-${newUser.email.replace(/[^a-zA-Z0-9]/g, '-')}` : `user-${Date.now()}`,
      status: newUser.status || 'ACTIVE',
      approvalStatus: newUser.approvalStatus || 'APPROVED',
      createdAt: new Date().toISOString(),
    };
    saveUserToDB(fullUser).catch(() => {});
    setUsers((prev) => {
      const filtered = prev.filter((u) => u.email.toLowerCase() !== newUser.email.toLowerCase());
      const updated = [...filtered, fullUser];
      localStorage.setItem('lciis_all_users', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('lciis-users-updated'));
      return updated;
    });
  }, []);

  const updateUserStatus = useCallback((userId: string, status: UserAccountStatus, reason?: string) => {
    setUsers((prev) => {
      const updated = prev.map((u) => {
        if (u.id === userId) {
          const mod = { ...u, status, statusReason: reason || u.statusReason };
          saveUserToDB(mod).catch(() => {});
          return mod;
        }
        return u;
      });
      localStorage.setItem('lciis_all_users', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('lciis-users-updated'));
      return updated;
    });
  }, []);

  const approveUser = useCallback((userId: string, adminName?: string) => {
    setUsers((prev) => {
      const updated = prev.map((u) => {
        if (u.id === userId) {
          const mod: UserProfile = {
            ...u,
            status: 'ACTIVE',
            approvalStatus: 'APPROVED',
            approvedBy: adminName || 'System Admin',
            approvedAt: new Date().toISOString(),
          };
          saveUserToDB(mod).catch(() => {});
          return mod;
        }
        return u;
      });
      localStorage.setItem('lciis_all_users', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('lciis-users-updated'));
      return updated;
    });
  }, []);

  const rejectUser = useCallback((userId: string) => {
    setUsers((prev) => {
      const updated = prev.filter((u) => u.id !== userId);
      localStorage.setItem('lciis_all_users', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('lciis-users-updated'));
      return updated;
    });
  }, []);

  const addPatient = useCallback(async (newP: Partial<Patient>): Promise<Patient> => {
    const newId = newP.hospitalId || `LCIIS-P-${(patients.length + 1).toString().padStart(6, '0')}`;
    const fullPatient: Patient = {
      id: newId,
      hospitalId: newId,
      name: newP.name || 'New Patient',
      dateOfBirth: newP.dateOfBirth || '1970-01-01',
      age: newP.age || 45,
      gender: newP.gender || 'Male',
      phone: newP.phone || '+1 (555) 000-0000',
      emergencyContact: newP.emergencyContact || 'Emergency Contact',
      bloodGroup: newP.bloodGroup || 'O+',
      address: newP.address || 'Hospital Ward',
      admissionDate: newP.admissionDate || new Date().toISOString().split('T')[0],
      departmentId: newP.departmentId || 'dept-icu',
      departmentName: newP.departmentName || 'Intensive Care Unit',
      ward: newP.ward || 'ICU',
      bed: newP.bed || 'Bed 01',
      attendingDoctorId: newP.attendingDoctorId || 'doc-001',
      attendingDoctorName: newP.attendingDoctorName || 'Dr. Sarah Jenkins',
      admissionType: newP.admissionType || 'Emergency',
      primaryComplaint: newP.primaryComplaint || 'Routine Observation',
      allergies: newP.allergies || ['No Known Allergies'],
      existingConditions: newP.existingConditions || [],
      currentStatus: newP.currentStatus || 'MONITOR',
      advisoryRisk: newP.advisoryRisk || 15,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (isFirebaseConnected) {
      await firebaseCreatePatient(fullPatient);
    } else {
      setPatients((prev) => [fullPatient, ...prev]);
    }

    return fullPatient;
  }, [patients.length, isFirebaseConnected]);

  const updatePatient = useCallback(async (patientId: string, updates: Partial<Patient>): Promise<void> => {
    if (isFirebaseConnected) {
      await updatePatientInDB(patientId, updates);
    }
    setPatients((prev) =>
      prev.map((p) => (p.id === patientId ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p))
    );
  }, [isFirebaseConnected]);

  const removePatient = useCallback(async (patientId: string): Promise<void> => {
    if (isFirebaseConnected) {
      await deletePatientFromDB(patientId);
    }
    setPatients((prev) => prev.filter((p) => p.id !== patientId));
  }, [isFirebaseConnected]);

  const bulkRemovePatients = useCallback(async (patientIds: string[]): Promise<void> => {
    const idSet = new Set(patientIds);
    if (isFirebaseConnected) {
      for (const id of patientIds) {
        await deletePatientFromDB(id).catch(() => {});
      }
    }
    setPatients((prev) => prev.filter((p) => !idSet.has(p.id)));
  }, [isFirebaseConnected]);

  const bulkUpdatePatients = useCallback(async (patientIds: string[], updates: Partial<Patient>): Promise<void> => {
    const idSet = new Set(patientIds);
    if (isFirebaseConnected) {
      for (const id of patientIds) {
        await updatePatientInDB(id, updates).catch(() => {});
      }
    }
    setPatients((prev) =>
      prev.map((p) => (idSet.has(p.id) ? { ...p, ...updates, updatedAt: new Date().toISOString() } : p))
    );
  }, [isFirebaseConnected]);

  const updateUser = useCallback(async (userId: string, updates: Partial<UserProfile>): Promise<void> => {
    if (isFirebaseConnected) {
      await updateUserInDB(userId, updates);
    }
    setUsers((prev) => {
      const updated = prev.map((u) => (u.id === userId ? { ...u, ...updates } : u));
      localStorage.setItem('lciis_all_users', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('lciis-users-updated'));
      return updated;
    });
  }, [isFirebaseConnected]);

  const removeUser = useCallback(async (userId: string): Promise<void> => {
    if (isFirebaseConnected) {
      await deleteUserFromDB(userId);
    }
    setUsers((prev) => {
      const updated = prev.filter((u) => u.id !== userId);
      localStorage.setItem('lciis_all_users', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('lciis-users-updated'));
      return updated;
    });
  }, [isFirebaseConnected]);

  const bulkRemoveUsers = useCallback(async (userIds: string[]): Promise<void> => {
    const idSet = new Set(userIds);
    if (isFirebaseConnected) {
      for (const id of userIds) {
        await deleteUserFromDB(id).catch(() => {});
      }
    }
    setUsers((prev) => {
      const updated = prev.filter((u) => !idSet.has(u.id));
      localStorage.setItem('lciis_all_users', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('lciis-users-updated'));
      return updated;
    });
  }, [isFirebaseConnected]);

  const bulkUpdateUsers = useCallback(async (userIds: string[], updates: Partial<UserProfile>): Promise<void> => {
    const idSet = new Set(userIds);
    if (isFirebaseConnected) {
      for (const id of userIds) {
        await updateUserInDB(id, updates).catch(() => {});
      }
    }
    setUsers((prev) => {
      const updated = prev.map((u) => (idSet.has(u.id) ? { ...u, ...updates } : u));
      localStorage.setItem('lciis_all_users', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('lciis-users-updated'));
      return updated;
    });
  }, [isFirebaseConnected]);

  const addLaboratoryResult = useCallback(async (res: Omit<LaboratoryResult, 'id' | 'createdAt'>) => {
    const fullRes: LaboratoryResult = {
      ...res,
      id: `lab-${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    setLabResults((prev) => [fullRes, ...prev]);

    // Analyze whether the laboratory vital exceeds clinical reference thresholds
    const val = Number(res.value);
    const low = Number(res.referenceLow);
    const high = Number(res.referenceHigh);

    const isExceedHigh = !isNaN(high) && high > 0 && val > high;
    const isExceedLow = !isNaN(low) && low > 0 && val < low;

    if (isExceedHigh || isExceedLow) {
      // Find patient details
      const targetPatient =
        patients.find((p) => p.id === res.patientId || p.hospitalId === res.patientId) ||
        (res.patientId === 'P12345' || res.patientId === 'LCIIS-P-000001'
          ? patients.find((p) => p.id === 'LCIIS-P-000001' || p.hospitalId === 'LCIIS-P-000001')
          : undefined);

      const patientName = targetPatient?.name || `Patient ${res.patientId}`;
      const patientWard = targetPatient?.ward || 'ICU Unit A';
      const patientBed = targetPatient?.bed || 'Bed 12';
      const patientIdClean = targetPatient?.id || res.patientId;

      // Determine criticality
      const criticalHigh = !isNaN(high) && high > 0 && val >= high * 1.35;
      const criticalLow = !isNaN(low) && low > 0 && val <= low * 0.75;
      const isCriticalTest = ['potassium', 'lactate', 'creatinine', 'troponin', 'd-dimer'].some((t) =>
        res.testName.toLowerCase().includes(t)
      );
      const isCritical = criticalHigh || criticalLow || (isCriticalTest && (val >= high * 1.2 || val <= low * 0.8));

      const priority: AlertPriority = isCritical ? 'CRITICAL' : 'HIGH';
      const advisoryRisk = isCritical ? 92 : 78;

      const deviationDetail = isExceedHigh
        ? `HIGH (+${(val - high).toFixed(2)} ${res.unit} above upper threshold of ${high} ${res.unit})`
        : `LOW (-${(low - val).toFixed(2)} ${res.unit} below lower threshold of ${low} ${res.unit})`;

      const alertId = `alert-lab-${Date.now()}`;
      const newAlert: Alert = {
        id: alertId,
        patientId: patientIdClean,
        patientName,
        ward: patientWard,
        bed: patientBed,
        type: 'LABORATORY TREND',
        priority,
        status: 'NEW',
        summary: `🚨 LAB THRESHOLD EXCEEDED: ${res.testName} (${val} ${res.unit}) is ${deviationDetail}!`,
        concerns: [
          `Laboratory ${res.category} panel: ${res.testName} resulted at ${val} ${res.unit} outside normal reference limits [${low} - ${high} ${res.unit}]`,
          `Sample entered by ${res.technicianName || 'Laboratory Staff'} at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          isCritical
            ? `CRITICAL LAB VALUE: Extreme physiological deviation indicates high risk of clinical deterioration`
            : `Abnormal finding: Physician review and clinical evaluation required`
        ],
        advisoryRisk,
        createdAt: new Date().toISOString()
      };

      // 1. Add alert to local React state
      setAlerts((prev) => [newAlert, ...prev]);

      // 2. Persist alert to Firebase RTDB so it broadcasts to all doctor/nurse screens in real time
      if (isFirebaseConnected) {
        try {
          await createAlert(newAlert);
        } catch (err) {
          console.warn('Failed to save lab alert to Firebase:', err);
        }
      }

      // 3. Escalate patient risk status if currently STABLE or MONITOR
      if (targetPatient) {
        const newStatus = isCritical ? 'CRITICAL' : 'HIGH RISK';
        const updatedRisk = Math.max(targetPatient.advisoryRisk || 0, advisoryRisk);
        setPatients((prev) =>
          prev.map((p) =>
            p.id === targetPatient.id
              ? { ...p, currentStatus: newStatus, advisoryRisk: updatedRisk, updatedAt: new Date().toISOString() }
              : p
          )
        );
        if (isFirebaseConnected) {
          try {
            await updatePatientInDB(targetPatient.id, {
              currentStatus: newStatus,
              advisoryRisk: updatedRisk
            });
          } catch (err) {
            console.warn('Failed to update patient risk status in Firebase:', err);
          }
        }
      }

      // 4. Dispatch prominent software alert message
      toast.error(`🚨 LAB VITAL THRESHOLD EXCEEDED!`, {
        description: `${res.testName}: ${val} ${res.unit} is ${deviationDetail} for ${patientName} (${patientWard} • ${patientBed}). High-priority alert broadcast!`,
        duration: 9000
      });
    }
  }, [patients, isFirebaseConnected]);

  const updateLiveVitals = useCallback(async (patientId: string, vitals: any) => {
    if (isFirebaseConnected) {
      await firebaseUpdateLiveVitals(patientId, vitals);
    } else {
      // Local fallback
      setLiveVitalsMap((prev) => ({
        ...prev,
        [patientId]: {
          ...(prev[patientId] || {}),
          ...vitals,
          lastUpdated: new Date().toISOString(),
        },
      }));
    }
  }, [isFirebaseConnected]);

  const acknowledgeAlert = useCallback(async (alertId: string, doctorName: string) => {
    setAlerts((prev) => {
      const updated = prev.map((a) =>
        a.id === alertId
          ? {
              ...a,
              status: 'ACKNOWLEDGED' as const,
              acknowledgedBy: doctorName,
              acknowledgedAt: new Date().toISOString(),
            }
          : a
      );
      const remainingSos = updated.some((a) => (a.summary.includes('SOS') || a.summary.includes('FALL')) && a.status === 'NEW');
      if (!remainingSos) {
        alarmAudio.stopAlarm();
      }
      return updated;
    });

    if (isFirebaseConnected) {
      try {
        await firebaseAcknowledgeAlert(alertId, doctorName);
      } catch (err) {
        console.error('Firebase acknowledge alert error:', err);
      }
    }
  }, [isFirebaseConnected]);

  const resolveAlert = useCallback(async (alertId: string, doctorName?: string) => {
    setAlerts((prev) => {
      const updated = prev.filter((a) => a.id !== alertId);
      const remainingSos = updated.some((a) => (a.summary.includes('SOS') || a.summary.includes('FALL')) && a.status === 'NEW');
      if (!remainingSos) {
        alarmAudio.stopAlarm();
      }
      return updated;
    });

    if (isFirebaseConnected) {
      try {
        await firebaseResolveAlert(alertId, doctorName);
      } catch (err) {
        console.error('Firebase resolve alert error:', err);
      }
    }
  }, [isFirebaseConnected]);

  const clearAllAlerts = useCallback(async () => {
    alarmAudio.stopAlarm();
    setAlerts([]);
    if (isFirebaseConnected) {
      try {
        await firebaseClearAllAlertsFromDB();
      } catch (err) {
        console.error('Firebase clear alerts error:', err);
      }
    }
  }, [isFirebaseConnected]);

  const handleTriggerWatchAlert = useCallback(async (patientId: string, alertType: 'SOS' | 'CRITICAL' | 'ALERT' | 'NORMAL' = 'CRITICAL') => {
    try {
      await triggerNurseWatchAlert(patientId, alertType);
      if (alertType === 'SOS') {
        alarmAudio.startAlarm();
        toast.error('🚨 BEDSIDE EMERGENCY SOS BUTTON TRIGGERED!', {
          description: `Bedside emergency triggered for Patient ${patientId} (ICU Bed 12).`,
          duration: 12000
        });
      } else if (alertType === 'NORMAL') {
        alarmAudio.stopAlarm();
        toast.success('Bedside SOS alarm cleared.');
      }
    } catch (err) {
      console.error('Trigger alert error:', err);
    }
  }, []);

  const overrideAlert = useCallback((alertId: string, doctorName: string, reason: string) => {
    setAlerts((prev) =>
      prev.map((a) =>
        a.id === alertId
          ? {
              ...a,
              status: 'OVERRIDDEN',
              acknowledgedBy: doctorName,
              acknowledgedAt: new Date().toISOString(),
              overrideReason: reason,
            }
          : a
      )
    );
  }, []);

  const addNurseObservation = useCallback((obs: Omit<NurseObservation, 'id' | 'timestamp'>) => {
    const fullObs: NurseObservation = {
      ...obs,
      id: `obs-${Date.now()}`,
      timestamp: new Date().toISOString(),
    };
    setNurseObservations((prev) => [fullObs, ...prev]);
  }, []);

  const addDoctorRemark = useCallback((rem: Omit<DoctorRemark, 'id' | 'timestamp'>) => {
    const fullRem: DoctorRemark = {
      ...rem,
      id: `rem-${Date.now()}`,
      timestamp: new Date().toISOString(),
    };
    setDoctorRemarks((prev) => [fullRem, ...prev]);
  }, []);

  const addMedication = useCallback((med: Omit<MedicationRecord, 'id'>) => {
    const fullMed: MedicationRecord = {
      ...med,
      id: `med-${Date.now()}`,
    };
    setMedications((prev) => [fullMed, ...prev]);
  }, []);

  const addIntervention = useCallback((inv: Omit<InterventionRecord, 'id' | 'timestamp'>) => {
    const fullInv: InterventionRecord = {
      ...inv,
      id: `inv-${Date.now()}`,
      timestamp: new Date().toISOString(),
    };
    setInterventions((prev) => [fullInv, ...prev]);
  }, []);

  const processStockMovement = useCallback(
    (itemId: string, qty: number, type: StockMovement['type'], performedBy: string, reason: string) => {
      setInventory((prev) =>
        prev.map((item) => {
          if (item.id === itemId) {
            let newQty = item.currentQuantity;
            if (type === 'STOCK IN' || type === 'RETURN') newQty += qty;
            else if (type === 'STOCK OUT' || type === 'EXPIRED' || type === 'DAMAGED') newQty -= qty;

            return {
              ...item,
              currentQuantity: Math.max(0, newQty),
            };
          }
          return item;
        })
      );

      const targetItem = inventory.find((i) => i.id === itemId);
      if (targetItem) {
        const movement: StockMovement = {
          id: `mov-${Date.now()}`,
          itemId,
          itemName: targetItem.name,
          quantity: qty,
          type,
          performedBy,
          timestamp: new Date().toISOString(),
          reason,
        };
        setStockMovements((prev) => [movement, ...prev]);
      }
    },
    [inventory]
  );

  const updateDeviceStatus = useCallback(async (deviceId: string, status: DeviceRecord['connectionStatus']) => {
    if (isFirebaseConnected) {
      await firebaseUpdateDeviceStatus(deviceId, status);
    }
    setDevices((prev) =>
      prev.map((d) => (d.id === deviceId ? { ...d, connectionStatus: status, lastSeen: new Date().toISOString() } : d))
    );
  }, [isFirebaseConnected]);

  return (
    <RealtimeContext.Provider
      value={{
        users,
        patients,
        selectedPatientId,
        setSelectedPatientId,
        getPatientById,
        labResults,
        liveVitalsMap,
        alerts,
        inventory,
        stockMovements,
        devices,
        auditLogs,
        nurseObservations,
        doctorRemarks,
        medications,
        interventions,
        isFirebaseConnected,
        firebaseError,
        isLoadingFirebase,
        retryFirebaseConnection,
        getPatientTrends,
        getPatientRiskAssessment,
        getPatientExplanation,
        addUser,
        updateUser,
        updateUserStatus,
        approveUser,
        rejectUser,
        removeUser,
        bulkRemoveUsers,
        bulkUpdateUsers,
        addPatient,
        updatePatient,
        removePatient,
        bulkRemovePatients,
        bulkUpdatePatients,
        addLaboratoryResult,
        updateLiveVitals,
        acknowledgeAlert,
        resolveAlert,
        clearAllAlerts,
        overrideAlert,
        addNurseObservation,
        addDoctorRemark,
        addMedication,
        addIntervention,
        processStockMovement,
        updateDeviceStatus,
        triggerWatchAlert: handleTriggerWatchAlert,
      }}
    >
      {children}
    </RealtimeContext.Provider>
  );
};

export const useRealtime = () => {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error('useRealtime must be used within a RealtimeProvider');
  }
  return context;
};
