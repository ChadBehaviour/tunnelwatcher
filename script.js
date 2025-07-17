// Service Worker Registration
async function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            const registration = await navigator.serviceWorker.register('/sw.js', {
                scope: '/'
            });
            
            console.log('Service Worker registered successfully:', registration);
            
            // Listen for messages from service worker
            navigator.serviceWorker.addEventListener('message', (event) => {
                const { type, data } = event.data;
                
                if (type === 'STATUS_UPDATE' && window.tunnelMonitor) {
                    console.log('Received status update from service worker:', data);
                    // Update UI with background status changes
                    Object.keys(data).forEach(tunnelKey => {
                        if (window.tunnelMonitor.lastStatuses[tunnelKey] !== data[tunnelKey]) {
                            window.tunnelMonitor.lastStatuses[tunnelKey] = data[tunnelKey];
                            // Trigger UI update
                            window.tunnelMonitor.checkTunnelStatus(tunnelKey);
                        }
                    });
                }
            });
            
            // Start background monitoring when service worker is ready
            if (registration.active) {
                registration.active.postMessage({ type: 'START_MONITORING' });
            } else if (registration.installing) {
                registration.installing.addEventListener('statechange', (e) => {
                    if (e.target.state === 'activated') {
                        registration.active.postMessage({ type: 'START_MONITORING' });
                    }
                });
            }
            
            return registration;
        } catch (error) {
            console.error('Service Worker registration failed:', error);
        }
    } else {
        console.warn('Service Workers not supported in this browser');
    }
}

// PWA Install functionality
let deferredPrompt;
const installButton = document.getElementById('installPWA');

window.addEventListener('beforeinstallprompt', (e) => {
    console.log('PWA install prompt available');
    e.preventDefault();
    deferredPrompt = e;
    installButton.style.display = 'flex';
});

installButton?.addEventListener('click', async () => {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        console.log(`PWA install outcome: ${outcome}`);
        deferredPrompt = null;
        installButton.style.display = 'none';
    }
});

window.addEventListener('appinstalled', () => {
    console.log('PWA was installed');
    installButton.style.display = 'none';
});

class TunnelMonitor {
    constructor() {
        this.tunnels = {
            roermond: {
                name: 'Roermond',
                rwsId: 'RWS01_MONIBAS_0021hrr0312ra',
                coordinates: { lat: 51.1942, lon: 5.9877 },
                searchTerms: ['roermond', 'a73', 'tunnel roermond', 'roermond tunnel']
            },
            swalmen: {
                name: 'Swalmen', 
                rwsId: 'RWS01_MONIBAS_0021hrr0313ra',
                coordinates: { lat: 51.2286, lon: 6.0394 },
                searchTerms: ['swalmen', 'a73', 'tunnel swalmen', 'swalmen tunnel']
            }
        };
        
        this.isMonitoring = false;
        this.notificationsEnabled = false;
        this.checkInterval = 60000; // 1 minute default
        this.intervalId = null;
        this.lastStatuses = {};
        this.closureHistory = {};
        this.statistics = {};
        this.serviceWorkerRegistration = null;
        
        // RWS API configuration
        this.rwsApiBase = 'https://www.rwsverkeersinfo.nl/files/';
        this.corsProxies = [
            'https://api.allorigins.win/raw?url=',
            'https://cors-anywhere.herokuapp.com/',
            'https://api.codetabs.com/v1/proxy?quest='
        ];
        this.currentProxyIndex = 0;
        
        this.initializeElements();
        this.bindEvents();
        this.checkNotificationPermission();
        this.loadHistoricalData();
        this.showLoading();
        
        // Initialize service worker first, then start monitoring
        this.initializeServiceWorker().then(() => {
            setTimeout(() => {
                this.hideLoading();
                this.startMonitoring();
                this.updateSystemTimestamp();
            }, 1000);
        });
    }

    async initializeServiceWorker() {
        try {
            this.serviceWorkerRegistration = await registerServiceWorker();
            if (this.serviceWorkerRegistration) {
                console.log('Service Worker integration enabled');
                
                // Send settings to service worker
                if (this.serviceWorkerRegistration.active) {
                    this.serviceWorkerRegistration.active.postMessage({
                        type: 'UPDATE_SETTINGS',
                        data: {
                            checkInterval: this.checkInterval,
                            notificationsEnabled: this.notificationsEnabled
                        }
                    });
                }
            }
        } catch (error) {
            console.error('Failed to initialize service worker:', error);
        }
    }

    initializeElements() {
        // Control elements
        this.toggleNotificationsBtn = document.getElementById('toggleNotifications');
        this.refreshAllBtn = document.getElementById('refreshAll');
        this.checkIntervalSelect = document.getElementById('checkInterval');
        
        // Modal elements
        this.notificationModal = document.getElementById('notificationModal');
        this.closeModalBtn = document.getElementById('closeModal');
        this.modalOkBtn = document.getElementById('modalOkBtn');
        this.modalTitle = document.getElementById('modalTitle');
        this.modalMessage = document.getElementById('modalMessage');
        this.modalDetails = document.getElementById('modalDetails');
        this.alertIcon = document.getElementById('alertIcon');
        
        // Loading overlay
        this.loadingOverlay = document.getElementById('loadingOverlay');
        
        // Statistics elements
        this.totalClosuresEl = document.getElementById('total-closures');
        this.avgClosureTimeEl = document.getElementById('avg-closure-time');
        this.uptimePercentageEl = document.getElementById('uptime-percentage');
        this.lastIncidentEl = document.getElementById('last-incident');
        this.systemLastUpdateEl = document.getElementById('system-last-update');
        
        // Initialize tunnel elements
        this.tunnelElements = {};
        Object.keys(this.tunnels).forEach(tunnelKey => {
            this.tunnelElements[tunnelKey] = {
                statusBadge: document.getElementById(`${tunnelKey}-status-badge`),
                indicator: document.getElementById(`${tunnelKey}-indicator`),
                statusIcon: document.getElementById(`${tunnelKey}-status-icon`),
                statusText: document.getElementById(`${tunnelKey}-status-text`),
                lastUpdate: document.getElementById(`${tunnelKey}-last-update`),
                lastClosure: document.getElementById(`${tunnelKey}-last-closure`),
                closureReason: document.getElementById(`${tunnelKey}-closure-reason`),
                closureDuration: document.getElementById(`${tunnelKey}-closure-duration`)
            };
            
            // Initialize last status
            this.lastStatuses[tunnelKey] = null;
        });
    }

    bindEvents() {
        this.toggleNotificationsBtn?.addEventListener('click', () => this.toggleNotifications());
        this.refreshAllBtn?.addEventListener('click', () => this.refreshAllTunnels());
        this.checkIntervalSelect?.addEventListener('change', (e) => this.updateCheckInterval(e.target.value));
        
                // Modal events
        this.closeModalBtn?.addEventListener('click', () => this.hideModal());
        this.modalOkBtn?.addEventListener('click', () => this.hideModal());
        
        // Close modal when clicking outside
        this.notificationModal?.addEventListener('click', (e) => {
            if (e.target === this.notificationModal) {
                this.hideModal();
            }
        });
        
        // Keyboard events
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.notificationModal?.classList.contains('show')) {
                this.hideModal();
            }
        });
    }

    async checkNotificationPermission() {
        if ('Notification' in window) {
            const permission = await Notification.requestPermission();
            this.notificationsEnabled = permission === 'granted';
            this.updateNotificationButton();
        } else {
            console.warn('This browser does not support notifications');
            this.toggleNotificationsBtn.style.display = 'none';
        }
    }

    async toggleNotifications() {
        if (!('Notification' in window)) {
            this.showModal('Not Supported', 'Your browser does not support notifications.', 'warning');
            return;
        }

        if (this.notificationsEnabled) {
            this.notificationsEnabled = false;
            this.updateNotificationButton();
            this.showModal('Notifications Disabled', 'You will no longer receive tunnel status notifications.', 'info');
        } else {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                this.notificationsEnabled = true;
                this.updateNotificationButton();
                this.showModal('Notifications Enabled', 'You will now receive notifications when tunnel status changes.', 'success');
                
                // Test notification
                setTimeout(() => {
                    this.testNotification();
                }, 2000);
            } else {
                this.showModal('Permission Denied', 'Please enable notifications in your browser settings to receive alerts.', 'warning');
            }
        }
        
        // Update service worker settings
        if (this.serviceWorkerRegistration?.active) {
            this.serviceWorkerRegistration.active.postMessage({
                type: 'UPDATE_SETTINGS',
                data: { notificationsEnabled: this.notificationsEnabled }
            });
        }
    }

    updateNotificationButton() {
        if (this.toggleNotificationsBtn) {
            const icon = this.toggleNotificationsBtn.querySelector('i');
            const text = this.toggleNotificationsBtn.querySelector('span') || this.toggleNotificationsBtn;
            
            if (this.notificationsEnabled) {
                icon.className = 'fas fa-bell';
                text.textContent = text === this.toggleNotificationsBtn ? 
                    '🔔 Notifications On' : 'Notifications On';
                this.toggleNotificationsBtn.className = 'btn btn-success';
            } else {
                icon.className = 'fas fa-bell-slash';
                text.textContent = text === this.toggleNotificationsBtn ? 
                    '🔕 Enable Notifications' : 'Enable Notifications';
                this.toggleNotificationsBtn.className = 'btn btn-primary';
            }
        }
    }

    updateCheckInterval(newInterval) {
        this.checkInterval = parseInt(newInterval);
        console.log(`Check interval updated to ${this.checkInterval}ms`);
        
        if (this.isMonitoring) {
            this.stopMonitoring();
            this.startMonitoring();
        }
        
        // Update service worker settings
        if (this.serviceWorkerRegistration?.active) {
            this.serviceWorkerRegistration.active.postMessage({
                type: 'UPDATE_SETTINGS',
                data: { checkInterval: this.checkInterval }
            });
        }
    }

    startMonitoring() {
        if (this.isMonitoring) return;
        
        this.isMonitoring = true;
        console.log('Starting tunnel monitoring...');
        
        // Initial check
        this.checkAllTunnels();
        
        // Set up interval
        this.intervalId = setInterval(() => {
            this.checkAllTunnels();
        }, this.checkInterval);
        
        // Update UI
        if (this.refreshAllBtn) {
            this.refreshAllBtn.innerHTML = '<i class="fas fa-pause"></i> Monitoring...';
            this.refreshAllBtn.className = 'btn btn-success pulse';
        }
    }

    stopMonitoring() {
        if (!this.isMonitoring) return;
        
        this.isMonitoring = false;
        console.log('Stopping tunnel monitoring...');
        
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        
        // Update UI
        if (this.refreshAllBtn) {
            this.refreshAllBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh All';
            this.refreshAllBtn.className = 'btn btn-success';
            this.refreshAllBtn.classList.remove('pulse');
        }
        
        // Notify service worker
        if (this.serviceWorkerRegistration?.active) {
            this.serviceWorkerRegistration.active.postMessage({ type: 'STOP_MONITORING' });
        }
    }

    async refreshAllTunnels() {
        if (this.isMonitoring) {
            this.stopMonitoring();
        } else {
            this.startMonitoring();
        }
    }

    async checkAllTunnels() {
        console.log('Checking all tunnels...');
        this.updateSystemTimestamp();
        
        const promises = Object.keys(this.tunnels).map(tunnelKey => 
            this.checkTunnelStatus(tunnelKey)
        );
        
        try {
            await Promise.allSettled(promises);
            this.updateStatistics();
            this.saveHistoricalData();
        } catch (error) {
            console.error('Error checking tunnels:', error);
        }
    }

    async checkTunnelStatus(tunnelKey) {
        const tunnel = this.tunnels[tunnelKey];
        if (!tunnel) return;
        
        console.log(`Checking ${tunnel.name} tunnel...`);
        
        try {
            // Try multiple data sources
            const dataSources = [
                'incidents/incidents.xml',
                'roadworks/roadworks.xml', 
                'trafficspeed/trafficspeed.xml'
            ];
            
            let finalStatus = {
                status: 'open',
                reason: 'No incidents detected',
                timestamp: new Date()
            };
            
            for (const endpoint of dataSources) {
                try {
                    const data = await this.fetchRWSData(endpoint);
                    const status = await this.parseDataForTunnel(data, tunnel, endpoint);
                    
                    // Prioritize closed/restricted status over open
                    if (status.status !== 'unknown' && 
                        (status.status === 'closed' || status.status === 'restricted' || 
                         finalStatus.status === 'open')) {
                        finalStatus = status;
                        if (status.status === 'closed') break; // Closed is highest priority
                    }
                } catch (error) {
                    console.warn(`Failed to fetch ${endpoint} for ${tunnelKey}:`, error);
                    continue;
                }
            }
            
            // Update UI and check for status changes
            this.updateTunnelUI(tunnelKey, finalStatus);
            this.checkStatusChange(tunnelKey, finalStatus);
            
        } catch (error) {
            console.error(`Error checking ${tunnelKey}:`, error);
            this.updateTunnelUI(tunnelKey, {
                status: 'unknown',
                reason: 'Connection error',
                timestamp: new Date()
            });
        }
    }

    async fetchRWSData(endpoint) {
        const url = `${this.rwsApiBase}${endpoint}`;
        let lastError;
        
        // Try direct fetch first
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/xml, text/xml, */*',
                    'Cache-Control': 'no-cache'
                },
                mode: 'cors'
            });
            
            if (response.ok) {
                const data = await response.text();
                console.log(`Successfully fetched ${endpoint} directly`);
                return data;
            }
        } catch (error) {
            console.warn(`Direct fetch failed for ${endpoint}:`, error);
            lastError = error;
        }
        
        // Try with CORS proxies
        for (let i = 0; i < this.corsProxies.length; i++) {
            const proxyIndex = (this.currentProxyIndex + i) % this.corsProxies.length;
            const proxy = this.corsProxies[proxyIndex];
            
            try {
                console.log(`Trying proxy ${proxyIndex + 1} for ${endpoint}...`);
                const response = await fetch(`${proxy}${encodeURIComponent(url)}`, {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/xml, text/xml, */*'
                    }
                });
                
                if (response.ok) {
                    const data = await response.text();
                    this.currentProxyIndex = proxyIndex; // Remember working proxy
                    console.log(`Successfully fetched ${endpoint} via proxy ${proxyIndex + 1}`);
                    return data;
                }
            } catch (error) {
                console.warn(`Proxy ${proxyIndex + 1} failed for ${endpoint}:`, error);
                lastError = error;
                continue;
            }
        }
        
        throw lastError || new Error(`All fetch attempts failed for ${endpoint}`);
    }

    async parseDataForTunnel(xmlString, tunnel, endpoint) {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(xmlString, 'text/xml');
            
            // Check for XML parsing errors
            const parserError = xmlDoc.querySelector('parsererror');
            if (parserError) {
                throw new Error('XML parsing failed');
            }
            
            if (endpoint.includes('incidents')) {
                return this.parseIncidents(xmlDoc, tunnel);
            } else if (endpoint.includes('roadworks')) {
                return this.parseRoadworks(xmlDoc, tunnel);
            } else if (endpoint.includes('trafficspeed')) {
                return this.parseTrafficSpeed(xmlDoc, tunnel);
            }
            
            return { status: 'unknown' };
        } catch (error) {
            console.error(`Error parsing XML for ${endpoint}:`, error);
            return { status: 'unknown' };
        }
    }

    parseIncidents(xmlDoc, tunnel) {
        const incidents = xmlDoc.querySelectorAll('incident, Incident, INCIDENT');
        console.log(`Found ${incidents.length} incidents`);
        
        for (const incident of incidents) {
            const location = this.getTextContent(incident, 'location, Location, LOCATION');
            const description = this.getTextContent(incident, 'description, Description, DESCRIPTION');
            const severity = this.getTextContent(incident, 'severity, Severity, SEVERITY');
            const startTime = this.getTextContent(incident, 'startTime, StartTime, STARTTIME');
            
            if (this.isRelatedToTunnel(location, description, tunnel)) {
                console.log(`Found incident for ${tunnel.name}:`, { location, description, severity });
                
                const isClosed = severity && (
                    severity.toLowerCase().includes('closure') ||
                    severity.toLowerCase().includes('closed') ||
                    severity.toLowerCase().includes('blocked') ||
                    description.toLowerCase().includes('gesloten') ||
                    description.toLowerCase().includes('afgesloten')
                );
                
                return {
                    status: isClosed ? 'closed' : 'restricted',
                    reason: description || severity || 'Traffic incident',
                    duration: this.extractDuration(description),
                    timestamp: startTime ? new Date(startTime) : new Date()
                };
            }
        }
        
        return { status: 'unknown' };
    }

    parseRoadworks(xmlDoc, tunnel) {
        const roadworks = xmlDoc.querySelectorAll('roadwork, Roadwork, ROADWORK, situation, Situation, SITUATION');
        console.log(`Found ${roadworks.length} roadworks`);
        
        for (const roadwork of roadworks) {
            const location = this.getTextContent(roadwork, 'location, Location, LOCATION');
            const description = this.getTextContent(roadwork, 'description, Description, DESCRIPTION');
            const impact = this.getTextContent(roadwork, 'impact, Impact, IMPACT');
            const startTime = this.getTextContent(roadwork, 'startTime, StartTime, STARTTIME');
            
            if (this.isRelatedToTunnel(location, description, tunnel)) {
                console.log(`Found roadwork for ${tunnel.name}:`, { location, description, impact });
                
                const isClosed = (impact && impact.toLowerCase().includes('closure')) ||
                    description.toLowerCase().includes('gesloten') ||
                    description.toLowerCase().includes('afgesloten');
                
                return {
                    status: isClosed ? 'closed' : 'maintenance',
                    reason: description || impact || 'Scheduled maintenance',
                    duration: this.extractDuration(description),
                    timestamp: startTime ? new Date(startTime) : new Date()
                };
            }
        }
        
        return { status: 'unknown' };
    }

    parseTrafficSpeed(xmlDoc, tunnel) {
        const measurements = xmlDoc.querySelectorAll('measurement, Measurement, MEASUREMENT, siteMeasurements, SiteMeasurements, SITEMEASUREMENTS');
        console.log(`Found ${measurements.length} traffic measurements`);
        
        for (const measurement of measurements) {
            const location = this.getTextContent(measurement, 'location, Location, LOCATION');
            const speedText = this.getTextContent(measurement, 'speed, Speed, SPEED, averageVehicleSpeed, AverageVehicleSpeed, AVERAGEVEHICLESPEED');
            const speed = parseFloat(speedText) || 0;
            
            if (this.isRelatedToTunnel(location, '', tunnel)) {
                console.log(`Found speed data for ${tunnel.name}:`, { location, speed });
                
                if (speed === 0) {
                    return {
                        status: 'closed',
                        reason: 'No traffic detected',
                        timestamp: new Date()
                    };
                } else if (speed < 20) {
                    return {
                        status: 'restricted',
                        reason: `Slow traffic (${speed} km/h)`,
                        timestamp: new Date()
                    };
                } else {
                    return {
                        status: 'open',
                        reason: `Normal traffic (${speed} km/h)`,
                        timestamp: new Date()
                    };
                }
            }
        }
        
        return { status: 'unknown' };
    }

    getTextContent(element, selectors) {
        const selectorList = selectors.split(', ');
        for (const selector of selectorList) {
            const found = element.querySelector(selector);
            if (found && found.textContent) {
                return found.textContent.trim();
            }
        }
        return '';
    }

    isRelatedToTunnel(location, description, tunnel) {
        const searchText = `${location} ${description}`.toLowerCase();
        
        // Check if any search terms match
        const hasSearchTerm = tunnel.searchTerms.some(term => 
            searchText.includes(term.toLowerCase())
        );
        
        // Check for general tunnel keywords
        const hasTunnelKeyword = searchText.includes('tunnel') || 
                                 searchText.includes('onderdoorgang') ||
                                 searchText.includes('viaduct');
        
        // Check for road number (A73)
        const hasRoadNumber = searchText.includes('a73') || searchText.includes('a 73');
        
        return hasSearchTerm || (hasTunnelKeyword && hasRoadNumber);
    }

    extractDuration(text) {
        if (!text) return null;
        
        const durationMatch = text.match(/(\d+(?:\.\d+)?)\s*(uur|hour|minuten|minutes|min|h)/i);
        if (durationMatch) {
            const value = parseFloat(durationMatch[1]);
            const unit = durationMatch[2].toLowerCase();
            
            if (unit.includes('uur') || unit.includes('hour') || unit === 'h') {
                return `${value}h`;
            } else {
                return `${value}m`;
            }
        }
        
        return null;
    }

    updateTunnelUI(tunnelKey, statusData) {
        const elements = this.tunnelElements[tunnelKey];
        if (!elements) return;
        
        const { status, reason, duration, timestamp } = statusData;
        
        // Update status badge
        const statusText = status.charAt(0).toUpperCase() + status.slice(1);
        elements.statusBadge.className = `status-badge ${status}`;
        elements.statusBadge.innerHTML = `
            ${this.getStatusIcon(status)}
            <span class="status-text">${statusText}</span>
        `;
        
        // Update status indicator
        elements.indicator.className = `status-indicator ${status}`;
        elements.statusIcon.className = `status-icon ${this.getStatusIconClass(status)}`;
        elements.statusText.textContent = reason || `Status: ${statusText}`;
        
        // Update details
        elements.lastUpdate.textContent = this.formatDate(timestamp || new Date());
        elements.closureReason.textContent = reason || 'Normal operation';
        elements.closureDuration.textContent = duration || '-';
        
        // Update last closure if status is closed
        if (status === 'closed') {
            elements.lastClosure.textContent = this.formatDate(timestamp || new Date());
        }
        
        console.log(`Updated UI for ${tunnelKey}:`, statusData);
    }

    getStatusIcon(status) {
        switch (status) {
            case 'open': return '<i class="fas fa-check-circle"></i>';
            case 'closed': return '<i class="fas fa-times-circle"></i>';
            case 'maintenance': return '<i class="fas fa-tools"></i>';
            case 'restricted': return '<i class="fas fa-exclamation-triangle"></i>';
            default: return '<i class="fas fa-question"></i>';
        }
    }

    getStatusIconClass(status) {
        switch (status) {
            case 'open': return 'fas fa-check-circle';
            case 'closed': return 'fas fa-times-circle';
            case 'maintenance': return 'fas fa-tools';
            case 'restricted': return 'fas fa-exclamation-triangle';
            default: return 'fas fa-question';
        }
    }

    checkStatusChange(tunnelKey, currentStatusData) {
        const previousStatus = this.lastStatuses[tunnelKey];
        const currentStatus = currentStatusData.status;
        
        if (previousStatus && previousStatus !== currentStatus) {
            console.log(`Status change detected for ${tunnelKey}: ${previousStatus} → ${currentStatus}`);
            
            // Record closure history
            this.recordClosure(tunnelKey, currentStatusData);
            
            // Send notification
            if (this.notificationsEnabled) {
                this.sendNotification(tunnelKey, currentStatusData);
            }
        }
        
        this.lastStatuses[tunnelKey] = currentStatus;
    }

    recordClosure(tunnelKey, statusData) {
        if (!this.closureHistory[tunnelKey]) {
            this.closureHistory[tunnelKey] = [];
        }
        
        const closureRecord = {
            status: statusData.status,
            reason: statusData.reason,
            duration: statusData.duration,
            timestamp: statusData.timestamp || new Date()
        };
        
        this.closureHistory[tunnelKey].unshift(closureRecord);
        
        // Keep only last 50 records per tunnel
        if (this.closureHistory[tunnelKey].length > 50) {
            this.closureHistory[tunnelKey] = this.closureHistory[tunnelKey].slice(0, 50);
        }
    }

    updateStatistics() {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        let totalClosures = 0;
        let totalDuration = 0;
        let closureCount = 0;
        let lastIncident = null;
        
        Object.keys(this.closureHistory).forEach(tunnelKey => {
            const history = this.closureHistory[tunnelKey] || [];
            
            history.forEach(record => {
                const recordDate = new Date(record.timestamp);
                recordDate.setHours(0, 0, 0, 0);
                
                if (recordDate.getTime() === today.getTime()) {
                    if (record.status === 'closed') {
                        totalClosures++;
                        
                        if (record.duration) {
                            const minutes = this.parseDuration(record.duration);
                            if (minutes > 0) {
                                totalDuration += minutes;
                                closureCount++;
                            }
                        }
                    }
                }
                
                if (!lastIncident || record.timestamp > lastIncident.timestamp) {
                    if (record.status === 'closed' || record.status === 'restricted') {
                        lastIncident = record;
                    }
                }
            });
        });
        
        // Update statistics UI
        if (this.totalClosuresEl) {
            this.totalClosuresEl.textContent = totalClosures;
        }
        
        if (this.avgClosureTimeEl) {
            const avgTime = closureCount > 0 ? Math.round(totalDuration / closureCount) : 0;
            this.avgClosureTimeEl.textContent = avgTime > 0 ? `${avgTime}m` : '0m';
        }
        
        if (this.uptimePercentageEl) {
            // Calculate uptime based on total closure time vs 24 hours
            const totalMinutesInDay = 24 * 60;
            const uptimePercentage = Math.max(0, Math.round(((totalMinutesInDay - totalDuration) / totalMinutesInDay) * 100));
            this.uptimePercentageEl.textContent = `${uptimePercentage}%`;
        }
        
        if (this.lastIncidentEl) {
            this.lastIncidentEl.textContent = lastIncident ? 
                this.formatDate(lastIncident.timestamp) : 'None today';
        }
        
        // Store statistics
        this.statistics = {
            totalClosures,
            avgClosureTime: closureCount > 0 ? Math.round(totalDuration / closureCount) : 0,
            uptimePercentage: Math.max(0, Math.round(((24 * 60 - totalDuration) / (24 * 60)) * 100)),
            lastIncident: lastIncident ? lastIncident.timestamp : null,
            lastUpdate: new Date()
        };
    }

    updateSystemTimestamp() {
        if (this.systemLastUpdateEl) {
            this.systemLastUpdateEl.textContent = new Date().toLocaleString();
        }
    }

    sendNotification(tunnelKey, data) {
        const tunnel = this.tunnels[tunnelKey];
        if (!tunnel) return;
        
        let title, message, type;
        
        switch (data.status) {
            case 'closed':
                title = `🚫 ${tunnel.name} Tunnel CLOSED!`;
                message = `The ${tunnel.name} tunnel is now closed. Consider alternative routes.`;
                type = 'danger';
                break;
            case 'open':
                title = `✅ ${tunnel.name} Tunnel Open`;
                message = `The ${tunnel.name} tunnel is now open for traffic.`;
                type = 'success';
                break;
            case 'maintenance':
                title = `🔧 ${tunnel.name} Tunnel Maintenance`;
                message = `The ${tunnel.name} tunnel is under maintenance.`;
                type = 'warning';
                break;
            case 'restricted':
                title = `⚠️ ${tunnel.name} Tunnel Restricted`;
                message = `Traffic restrictions on ${tunnel.name} tunnel.`;
                type = 'warning';
                break;
            default:
                return;
        }
        
        // Browser notification
        if ('Notification' in window && Notification.permission === 'granted') {
            try {
                const notification = new Notification(title, {
                    body: message + (data.reason ? `\nReason: ${data.reason}` : ''),
                    icon: `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🚇</text></svg>`,
                    badge: `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🚇</text></svg>`,
                    requireInteraction: data.status === 'closed',
                    tag: `tunnel-${tunnelKey}`,
                    timestamp: Date.now()
                });
                
                // Auto-close non-critical notifications
                if (data.status !== 'closed') {
                    setTimeout(() => {
                        try {
                            notification.close();
                        } catch (e) {
                            // Ignore errors when closing notifications
                        }
                    }, 10000);
                }
                
                // Handle notification click
                notification.onclick = () => {
                    window.focus();
                    notification.close();
                    // Scroll to the specific tunnel card
                    const tunnelCard = document.getElementById(`${tunnelKey}-card`);
                    if (tunnelCard) {
                        tunnelCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                };
                
            } catch (error) {
                console.error('Error creating browser notification:', error);
            }
        }
        
        // Custom modal notification
        const details = data.reason ? 
            `Reason: ${data.reason}${data.duration ? `\nDuration: ${data.duration}` : ''}` : '';
        
        this.showModal(title, message, type, details);
    }

    showModal(title, message, type = 'warning', details = '') {
        this.modalTitle.textContent = title;
        this.modalMessage.textContent = message;
        this.modalDetails.textContent = details;
        this.modalDetails.style.display = details ? 'block' : 'none';
        
        // Update modal styling based on type
        this.alertIcon.className = `alert-icon ${type}`;
        const iconElement = this.alertIcon.querySelector('i');
        
        switch (type) {
            case 'success':
                iconElement.className = 'fas fa-check-circle';
                break;
            case 'danger':
                iconElement.className = 'fas fa-exclamation-triangle';
                break;
            case 'warning':
                iconElement.className = 'fas fa-exclamation-circle';
                break;
            default:
                iconElement.className = 'fas fa-info-circle';
        }
        
        this.notificationModal.classList.add('show');
        
        // Auto-hide non-critical modals
        if (type !== 'danger') {
            this.modalTimeout = setTimeout(() => {
                if (this.notificationModal.classList.contains('show')) {
                    this.hideModal();
                }
            }, 8000);
        }
    }

    hideModal() {
        this.notificationModal.classList.remove('show');
        if (this.modalTimeout) {
            clearTimeout(this.modalTimeout);
            this.modalTimeout = null;
        }
    }

    showLoading() {
        if (this.loadingOverlay) {
            this.loadingOverlay.style.display = 'flex';
        }
    }

    hideLoading() {
        if (this.loadingOverlay) {
            this.loadingOverlay.style.display = 'none';
        }
    }

    loadHistoricalData() {
        try {
            const savedHistory = localStorage.getItem('tunnelClosureHistory');
            const savedStats = localStorage.getItem('tunnelStatistics');
            
            if (savedHistory) {
                const parsed = JSON.parse(savedHistory);
                Object.keys(parsed).forEach(tunnel => {
                    parsed[tunnel] = parsed[tunnel].map(closure => ({
                        ...closure,
                        timestamp: new Date(closure.timestamp)
                    }));
                });
                this.closureHistory = parsed;
                console.log('Loaded historical closure data');
            }
            
            if (savedStats) {
                this.statistics = JSON.parse(savedStats);
                console.log('Loaded historical statistics');
            }
        } catch (error) {
            console.error('Error loading historical data:', error);
            this.closureHistory = {};
            this.statistics = {};
        }
    }

    saveHistoricalData() {
        try {
            localStorage.setItem('tunnelClosureHistory', JSON.stringify(this.closureHistory));
            localStorage.setItem('tunnelStatistics', JSON.stringify(this.statistics));
        } catch (error) {
            console.error('Error saving historical data:', error);
            // If localStorage is full, try to clear old data
            try {
                Object.keys(this.closureHistory).forEach(tunnel => {
                    if (this.closureHistory[tunnel].length > 20) {
                        this.closureHistory[tunnel] = this.closureHistory[tunnel].slice(-20);
                    }
                });
                localStorage.setItem('tunnelClosureHistory', JSON.stringify(this.closureHistory));
            } catch (retryError) {
                console.error('Failed to save even after cleanup:', retryError);
            }
        }
    }

    formatDate(date) {
        try {
            if (!date || isNaN(date.getTime())) {
                return 'Unknown';
            }
            
            const now = new Date();
            const diffTime = Math.abs(now - date);
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            const diffHours = Math.floor(diffTime / (1000 * 60 * 60));
            const diffMinutes = Math.floor(diffTime / (1000 * 60));
            
                        if (diffMinutes < 1) {
                return 'Just now';
            } else if (diffMinutes < 60) {
                return `${diffMinutes} minute${diffMinutes > 1 ? 's' : ''} ago`;
            } else if (diffHours < 24) {
                return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
            } else if (diffDays === 0) {
                return `Today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            } else if (diffDays === 1) {
                return `Yesterday at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
            } else if (diffDays < 7) {
                return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
            } else {
                return date.toLocaleDateString();
            }
        } catch (error) {
            console.error('Error formatting date:', error);
            return 'Unknown';
        }
    }

    parseDuration(durationString) {
        if (!durationString) return 0;
        
        const match = durationString.match(/(\d+(?:\.\d+)?)\s*([hm])/i);
        if (match) {
            const value = parseFloat(match[1]);
            const unit = match[2].toLowerCase();
            
            if (unit === 'h') {
                return value * 60; // Convert hours to minutes
            } else {
                return value; // Already in minutes
            }
        }
        
        return 0;
    }

    testNotification() {
        if (this.notificationsEnabled && 'Notification' in window) {
            try {
                const notification = new Notification('🚇 Tunnel Monitor Test', {
                    body: 'Notifications are working correctly! You will receive alerts when tunnel status changes.',
                    icon: `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🚇</text></svg>`,
                    tag: 'test-notification'
                });
                
                setTimeout(() => {
                    try {
                        notification.close();
                    } catch (e) {
                        // Ignore errors when closing notifications
                    }
                }, 5000);
                
            } catch (error) {
                console.error('Error creating test notification:', error);
            }
        }
    }

    // Cleanup method
    destroy() {
        this.stopMonitoring();
        
        if (this.modalTimeout) {
            clearTimeout(this.modalTimeout);
        }
        
        // Save final state
        this.saveHistoricalData();
        
        console.log('Tunnel monitor destroyed');
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('Initializing Tunnel Monitor...');
    
    // Make tunnelMonitor globally accessible for service worker communication
    window.tunnelMonitor = new TunnelMonitor();
    
    // Handle page visibility changes
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            console.log('Page hidden - monitoring continues in background');
        } else {
            console.log('Page visible - refreshing data');
            if (window.tunnelMonitor) {
                window.tunnelMonitor.checkAllTunnels();
            }
        }
    });
    
    // Handle online/offline events
    window.addEventListener('online', () => {
        console.log('Connection restored');
        if (window.tunnelMonitor && !window.tunnelMonitor.isMonitoring) {
            window.tunnelMonitor.startMonitoring();
        }
        window.tunnelMonitor?.showModal(
            'Connection Restored', 
            'Internet connection is back. Monitoring resumed.', 
            'success'
        );
    });
    
    window.addEventListener('offline', () => {
        console.log('Connection lost');
        window.tunnelMonitor?.showModal(
            'Connection Lost', 
            'No internet connection. Monitoring will resume when connection is restored.', 
            'warning'
        );
    });
    
    // Handle page unload
    window.addEventListener('beforeunload', () => {
        if (window.tunnelMonitor) {
            window.tunnelMonitor.destroy();
        }
    });
    
    // Handle errors
    window.addEventListener('error', (event) => {
        console.error('Global error:', event.error);
        
        // Show user-friendly error message for critical errors
        if (event.error && event.error.message && window.tunnelMonitor) {
            window.tunnelMonitor.showModal(
                'Application Error',
                'An unexpected error occurred. The page will be refreshed automatically.',
                'danger'
            );
            
            // Auto-refresh after 5 seconds
            setTimeout(() => {
                window.location.reload();
            }, 5000);
        }
    });
    
    // Handle unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
        console.error('Unhandled promise rejection:', event.reason);
        
        // Prevent the default browser behavior
        event.preventDefault();
        
        // Show user-friendly error message
        if (window.tunnelMonitor) {
            window.tunnelMonitor.showModal(
                'Network Error',
                'Failed to fetch tunnel data. Retrying automatically...',
                'warning'
            );
        }
    });
});

// Export for potential module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TunnelMonitor;
}


