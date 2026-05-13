const fs = require('fs');
const path = require('path');
const logger = require('./utils/logger');

let admin = null;
try {
  admin = require('firebase-admin');
} catch (error) {
  logger.warn('firebase-admin is not installed; Firebase push notifications are disabled until the dependency is added');
}

let initialized = false;

const getServiceAccountPath = () => {
  const configuredPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (configuredPath) {
    return path.isAbsolute(configuredPath)
      ? configuredPath
      : path.join(process.cwd(), configuredPath);
  }

  return path.join(process.cwd(), 'config', 'firebase-service-account.json');
};

const loadServiceAccount = () => {
  const serviceAccountPath = getServiceAccountPath();

  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(
      `Firebase service account file not found at ${serviceAccountPath}`
    );
  }

  const raw = fs.readFileSync(serviceAccountPath, 'utf8');
  return JSON.parse(raw);
};

const initializeFirebaseAdmin = () => {
  if (!admin) {
    return null;
  }

  if (initialized || admin.apps.length > 0) {
    initialized = true;
    return admin;
  }

  if (String(process.env.FIREBASE_MESSAGING_ENABLED || 'true').toLowerCase() === 'false') {
    logger.info('Firebase messaging is disabled by FIREBASE_MESSAGING_ENABLED=false');
    return null;
  }

  const serviceAccount = loadServiceAccount();
  const projectId = process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id;
  const storageBucket =
    process.env.FIREBASE_STORAGE_BUCKET ||
    (projectId ? `${projectId}.firebasestorage.app` : undefined);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId,
    ...(storageBucket ? { storageBucket } : {}),
  });

  initialized = true;
  logger.info('Firebase Admin SDK initialized for messaging');

  return admin;
};

const toFcmData = (data = {}) => {
  const result = {};
  Object.entries(data || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }
    result[key] = typeof value === 'string' ? value : JSON.stringify(value);
  });
  return result;
};

const sendPushNotification = async ({
  token,
  tokens,
  title,
  body,
  data = {},
  androidChannelId = 'cerca_notifications',
  imageUrl,
} = {}) => {
  try {
    if (!admin) {
      return { success: false, skipped: true, reason: 'firebase-admin dependency is not installed' };
    }

    if (!token && (!Array.isArray(tokens) || tokens.length === 0)) {
      return { success: false, skipped: true, reason: 'No FCM token provided' };
    }

    const firebaseAdmin = initializeFirebaseAdmin();
    if (!firebaseAdmin) {
      return { success: false, skipped: true, reason: 'Firebase messaging is disabled' };
    }

    const messaging = firebaseAdmin.messaging();
    const message = {
      notification: {
        title,
        body,
        ...(imageUrl ? { imageUrl } : {}),
      },
      data: toFcmData(data),
      android: {
        priority: 'high',
        notification: {
          channelId: androidChannelId,
          sound: 'default',
        },
      },
      apns: {
        payload: {
          aps: {
            sound: 'default',
          },
        },
      },
    };

    if (Array.isArray(tokens) && tokens.length > 0) {
      const response = await messaging.sendEachForMulticast({
        ...message,
        tokens,
      });
      return {
        success: true,
        mode: 'multicast',
        successCount: response.successCount,
        failureCount: response.failureCount,
        responses: response.responses,
      };
    }

    const response = await messaging.send({
      ...message,
      token,
    });

    return { success: true, mode: 'single', messageId: response };
  } catch (error) {
    logger.error('Error sending Firebase push notification:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  admin,
  initializeFirebaseAdmin,
  sendPushNotification,
};
