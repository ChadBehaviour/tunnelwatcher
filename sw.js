const CACHE_NAME = 'tunnel-monitor-v1.2';
const urlsToCache = [
  '/',
  '/index.html',
  '/script.js',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'
];

// Install event
self.addEventListener('install', (event) => {
  console.log('Service Worker installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        return self.skipWaiting();
      })
  );
});

// Activate event
self.addEventListener('activate', (event) => {
  console.log('Service Worker activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Fetch event
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Return cached version or fetch from network
        return response || fetch(event.request).catch(() => {
          // If both cache and network fail, return offline page
          if (event.request.destination === 'document') {
            return caches.match('/');
          }
        });
      })
  );
});

// Background sync for tunnel monitoring
let monitoringInterval;
let isMonitoring = false;
let settings = {
  checkInterval: 60000,
  notificationsEnabled: false
};

// Listen for messages from main thread
self.addEventListener('message', (event) => {
  const { type, data } = event.data;
  
  switch (type) {
    case 'START_MONITORING':
      startBackgroundMonitoring();
      break;
    case 'STOP_MONITORING':
      stopBackgroundMonitoring();
      break;
    case 'UPDATE_SETTINGS':
      settings = { ...settings, ...data };
      if (isMonitoring) {
        stopBackgroundMonitoring();
        startBackgroundMonitoring();
      }
      break;
  }
});

function startBackgroundMonitoring() {
  if (isMonitoring) return;
  
  console.log('Starting background monitoring...');
  isMonitoring = true;
  
  monitoringInterval = setInterval(async () => {
    try {
      await checkTunnelStatuses();
    } catch (error) {
      console.error('Background monitoring error:', error);
    }
  }, settings.checkInterval);
}

function stopBackgroundMonitoring() {
  if (!isMonitoring) return;
  
  console.log('Stopping background monitoring...');
  isMonitoring = false;
  
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
}

async function checkTunnelStatuses() {
  // This would contain the same tunnel checking logic as the main app
  // For now, we'll send a message to the main thread to handle it
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({
      type: 'BACKGROUND_CHECK_REQUEST'
    });
  });
}

// Push notification event
self.addEventListener('push', (event) => {
  console.log('Push notification received:', event);
  
  const options = {
    body: event.data ? event.data.text() : 'Tunnel status update',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    vibrate: [200, 100, 200],
    requireInteraction: true,
    actions: [
      {
        action: 'view',
        title: 'View Details',
        icon: '/icons/icon-72x72.png'
      },
      {
        action: 'dismiss',
        title: 'Dismiss'
      }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification('Tunnel Monitor', options)
  );
});

// Notification click event
self.addEventListener('notificationclick', (event) => {
  console.log('Notification clicked:', event);
  
  event.notification.close();
  
  if (event.action === 'view') {
    event.waitUntil(
      clients.openWindow('/')
    );
  }
});
