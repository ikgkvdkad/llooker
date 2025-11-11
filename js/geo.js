// Geolocation helper utilities

let cachedPosition = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 minute cache

function isCacheValid() {
    if (!cachedPosition) return false;
    return (Date.now() - cachedAt) <= CACHE_TTL_MS;
}

function normalizePosition(position) {
    if (!position) return null;
    const { coords, timestamp } = position;
    if (!coords) return null;
    return {
        status: 'ok',
        coords: {
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy: coords.accuracy ?? null,
            altitude: coords.altitude ?? null,
            altitudeAccuracy: coords.altitudeAccuracy ?? null,
            heading: coords.heading ?? null,
            speed: coords.speed ?? null
        },
        timestamp: timestamp || Date.now()
    };
}

function geolocationNotSupported() {
    return {
        status: 'unsupported',
        coords: null,
        timestamp: Date.now(),
        error: 'Geolocation API not supported in this browser.'
    };
}

function wrapError(status, message) {
    return {
        status,
        coords: null,
        timestamp: Date.now(),
        error: message
    };
}

export async function requestCurrentLocation(options = {}) {
    if (isCacheValid()) {
        return { ...cachedPosition, status: cachedPosition.status || 'ok' };
    }

    if (!('geolocation' in navigator)) {
        const result = geolocationNotSupported();
        cachedPosition = result;
        cachedAt = Date.now();
        return result;
    }

    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const normalized = normalizePosition(position);
                cachedPosition = normalized;
                cachedAt = Date.now();
                resolve(normalized);
            },
            (error) => {
                let status = 'error';
                switch (error.code) {
                    case error.PERMISSION_DENIED:
                        status = 'denied';
                        break;
                    case error.POSITION_UNAVAILABLE:
                        status = 'unavailable';
                        break;
                    case error.TIMEOUT:
                        status = 'timeout';
                        break;
                    default:
                        status = 'error';
                }
                const result = wrapError(status, error.message || 'Failed to obtain geolocation.');
                cachedPosition = result;
                cachedAt = Date.now();
                resolve(result);
            },
            {
                enableHighAccuracy: options.enableHighAccuracy ?? true,
                timeout: options.timeout ?? 10000,
                maximumAge: options.maximumAge ?? 0
            }
        );
    });
}
