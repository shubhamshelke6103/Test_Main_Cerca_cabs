// Shared Ride Tracking Page JavaScript
// Handles Google Maps, API calls, and Socket.IO real-time updates

(function() {
    'use strict';

    // Configuration
    const API_BASE_URL = window.location.origin;
    const SOCKET_URL = window.location.origin;
    const GOOGLE_MAPS_API_KEY = 'AIzaSyDQq0QpnwQKzDR99ObP1frWj_uRTQ54pbo';

    // State
    let map;
    let shareToken;
    let socket;
    let rideData = null;
    let pickupMarker = null;
    let dropoffMarker = null;
    let driverMarker = null;
    let routePolyline = null;

    // DOM Elements
    const loadingContainer = document.getElementById('loadingContainer');
    const errorContainer = document.getElementById('errorContainer');
    const mainContent = document.getElementById('mainContent');
    const errorMessage = document.getElementById('errorMessage');
    const retryButton = document.getElementById('retryButton');
    const mapContainer = document.getElementById('mapContainer');

    // Initialize
    function init() {
        // Get token from URL path (format: /shared-ride/{token})
        const pathParts = window.location.pathname.split('/');
        const tokenIndex = pathParts.indexOf('shared-ride');
        
        if (tokenIndex !== -1 && pathParts[tokenIndex + 1]) {
            shareToken = pathParts[tokenIndex + 1];
        } else {
            // Fallback: try query parameter (for backward compatibility)
            const urlParams = new URLSearchParams(window.location.search);
            shareToken = urlParams.get('token');
        }

        if (!shareToken) {
            showError('Invalid share link. No token provided.');
            return;
        }

        // Fetch ride data
        fetchRideData();
    }

    // Fetch ride data from API
    async function fetchRideData() {
        try {
            showLoading();
            const response = await fetch(`${API_BASE_URL}/api/rides/shared/${shareToken}`);
            const result = await response.json();

            if (!response.ok || !result.success) {
                throw new Error(result.message || 'Failed to fetch ride data');
            }

            rideData = result.data;
            displayRideData();
            initializeMap();
            connectSocket();
            hideLoading();
        } catch (error) {
            console.error('Error fetching ride data:', error);
            showError(error.message || 'Failed to load ride information');
        }
    }

    // Display ride data in UI
    function displayRideData() {
        if (!rideData) return;

        // Update status
        updateStatus(rideData.status);

        // Update route addresses
        document.getElementById('pickupAddress').textContent = rideData.pickupAddress || '-';
        document.getElementById('dropoffAddress').textContent = rideData.dropoffAddress || '-';

        // Update ride details
        document.getElementById('distance').textContent = rideData.distanceInKm 
            ? `${rideData.distanceInKm} km` 
            : '-';
        document.getElementById('fare').textContent = rideData.fare 
            ? `₹${rideData.fare}` 
            : '-';
        
        if (rideData.estimatedDuration) {
            document.getElementById('duration').textContent = `${rideData.estimatedDuration} minutes`;
            document.getElementById('durationItem').style.display = 'flex';
        }

        // Update driver info if available
        if (rideData.driver) {
            document.getElementById('driverCard').style.display = 'block';
            document.getElementById('driverName').textContent = rideData.driver.name || '-';
            document.getElementById('driverRating').textContent = rideData.driver.rating || '-';
            
            // Driver initials for avatar
            const driverName = rideData.driver.name || 'D';
            const initials = driverName.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);
            document.getElementById('driverInitials').textContent = initials;

            // Vehicle info
            if (rideData.driver.vehicleInfo) {
                document.getElementById('vehicleInfo').style.display = 'flex';
                const vehicle = rideData.driver.vehicleInfo;
                const vehicleDetails = `${vehicle.color || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim();
                document.getElementById('vehicleDetails').textContent = vehicleDetails || '-';
                document.getElementById('licensePlate').textContent = vehicle.licensePlate || '-';
            }
        }

        // Show ETA if available
        if (rideData.estimatedArrivalTime) {
            const eta = new Date(rideData.estimatedArrivalTime);
            const now = new Date();
            const minutes = Math.ceil((eta - now) / 60000);
            if (minutes > 0) {
                document.getElementById('etaInfo').style.display = 'flex';
                document.getElementById('etaValue').textContent = `${minutes} min`;
            }
        }
    }

    // Update status display
    function updateStatus(status) {
        const statusText = document.getElementById('statusText');
        const statusValue = document.getElementById('statusValue');
        const statusBadge = document.getElementById('statusBadge');
        const statusLabel = document.getElementById('statusLabel');

        const statusMap = {
            'requested': { text: 'Ride Requested', label: 'Waiting for driver' },
            'accepted': { text: 'Driver Assigned', label: 'Driver on the way' },
            'arrived': { text: 'Driver Arrived', label: 'Driver has arrived' },
            'in_progress': { text: 'Ride in Progress', label: 'On the way' },
            'completed': { text: 'Ride Completed', label: 'Ride completed' },
            'cancelled': { text: 'Ride Cancelled', label: 'Ride cancelled' }
        };

        const statusInfo = statusMap[status] || { text: status, label: status };
        statusText.textContent = statusInfo.text;
        statusValue.textContent = statusInfo.text;
        statusLabel.textContent = statusInfo.label;

        // Update badge class
        statusBadge.className = 'status-badge ' + (status || 'requested');
    }

    // Initialize Google Maps
    function initializeMap() {
        if (!rideData || !rideData.pickupLocation) {
            console.error('Ride data or pickup location missing');
            return;
        }

        const pickupCoords = {
            lat: rideData.pickupLocation.coordinates[1],
            lng: rideData.pickupLocation.coordinates[0]
        };

        // Create map
        map = new google.maps.Map(mapContainer, {
            center: pickupCoords,
            zoom: 14,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: true
        });

        // Add pickup marker
        pickupMarker = new google.maps.Marker({
            position: pickupCoords,
            map: map,
            title: 'Pickup Location',
            label: {
                text: 'P',
                color: 'white',
                fontWeight: 'bold'
            },
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                scale: 10,
                fillColor: '#22C55E',
                fillOpacity: 1,
                strokeColor: 'white',
                strokeWeight: 2
            }
        });

        // Add dropoff marker if available
        if (rideData.dropoffLocation) {
            const dropoffCoords = {
                lat: rideData.dropoffLocation.coordinates[1],
                lng: rideData.dropoffLocation.coordinates[0]
            };

            dropoffMarker = new google.maps.Marker({
                position: dropoffCoords,
                map: map,
                title: 'Destination',
                label: {
                    text: 'D',
                    color: 'white',
                    fontWeight: 'bold'
                },
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 10,
                    fillColor: '#c5000f',
                    fillOpacity: 1,
                    strokeColor: 'white',
                    strokeWeight: 2
                }
            });

            // Fit bounds to show both markers
            const bounds = new google.maps.LatLngBounds();
            bounds.extend(pickupCoords);
            bounds.extend(dropoffCoords);
            map.fitBounds(bounds);
        }

        // Add driver marker if location available
        if (rideData.driver && rideData.driver.location) {
            updateDriverLocation(rideData.driver.location);
        }
    }

    // Update driver location on map
    function updateDriverLocation(location) {
        if (!location || !location.coordinates) return;

        const driverCoords = {
            lat: location.coordinates[1],
            lng: location.coordinates[0]
        };

        if (driverMarker) {
            driverMarker.setPosition(driverCoords);
        } else {
            driverMarker = new google.maps.Marker({
                position: driverCoords,
                map: map,
                title: 'Driver',
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 8,
                    fillColor: '#333652',
                    fillOpacity: 1,
                    strokeColor: 'white',
                    strokeWeight: 2
                },
                animation: google.maps.Animation.DROP
            });
        }

        // Center map on driver if ride is in progress
        if (rideData.status === 'in_progress' || rideData.status === 'accepted') {
            map.setCenter(driverCoords);
            map.setZoom(15);
        }
    }

    // Connect to Socket.IO for real-time updates
    function connectSocket() {
        try {
            socket = io(SOCKET_URL, {
                transports: ['websocket', 'polling']
            });

            socket.on('connect', () => {
                console.log('Socket connected');
                socket.emit('joinSharedRide', { shareToken: shareToken });
            });

            socket.on('sharedRideJoined', (data) => {
                console.log('Joined shared ride room:', data);
            });

            socket.on('sharedRideError', (data) => {
                console.error('Shared ride error:', data);
            });

            // Listen for location updates
            socket.on('rideLocationUpdate', (data) => {
                console.log('Location update received:', data);
                if (data.driverLocation) {
                    updateDriverLocation(data.driverLocation);
                }
            });

            // Listen for status updates
            socket.on('rideStatusUpdate', (data) => {
                console.log('Status update received:', data);
                if (data.status) {
                    rideData.status = data.status;
                    updateStatus(data.status);
                }
            });

            socket.on('rideCompleted', (data) => {
                console.log('Ride completed:', data);
                updateStatus('completed');
                showError('This ride has ended', false);
            });

            socket.on('rideCancelled', (data) => {
                console.log('Ride cancelled:', data);
                updateStatus('cancelled');
                showError('This ride has been cancelled', false);
            });

            socket.on('disconnect', () => {
                console.log('Socket disconnected');
            });

            socket.on('error', (error) => {
                console.error('Socket error:', error);
            });
        } catch (error) {
            console.error('Error connecting to socket:', error);
            // Continue without real-time updates
        }
    }

    // Show loading state
    function showLoading() {
        loadingContainer.style.display = 'flex';
        errorContainer.style.display = 'none';
        mainContent.style.display = 'none';
    }

    // Hide loading state
    function hideLoading() {
        loadingContainer.style.display = 'none';
        mainContent.style.display = 'block';
    }

    // Show error state
    function showError(message, showRetry = true) {
        loadingContainer.style.display = 'none';
        mainContent.style.display = 'none';
        errorContainer.style.display = 'block';
        errorMessage.textContent = message;
        retryButton.style.display = showRetry ? 'block' : 'none';
    }

    // Retry button handler
    retryButton.addEventListener('click', () => {
        fetchRideData();
    });

    // Initialize on page load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (socket) {
            socket.disconnect();
        }
    });
})();

