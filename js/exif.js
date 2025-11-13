// Minimal EXIF parser for extracting GPS metadata from JPEG data URLs

const JPEG_SOI = 0xffd8;
const TIFF_TAG_GPS_POINTER = 0x8825;

const GPS_TAGS = {
    LATITUDE_REF: 0x0001,
    LATITUDE: 0x0002,
    LONGITUDE_REF: 0x0003,
    LONGITUDE: 0x0004,
    ALTITUDE_REF: 0x0005,
    ALTITUDE: 0x0006,
    TIMESTAMP: 0x0007,
    DATESTAMP: 0x001d
};

const TYPE_SIZES = {
    1: 1,  // BYTE
    2: 1,  // ASCII
    3: 2,  // SHORT
    4: 4,  // LONG
    5: 8,  // RATIONAL
    7: 1,  // UNDEFINED
    9: 4,  // SLONG
    10: 8  // SRATIONAL
};

function binaryStringToArrayBuffer(binary) {
    const length = binary.length;
    const buffer = new ArrayBuffer(length);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < length; i += 1) {
        view[i] = binary.charCodeAt(i);
    }
    return buffer;
}

function readAscii(dataView, offset, length) {
    let result = '';
    for (let i = 0; i < length; i += 1) {
        const code = dataView.getUint8(offset + i);
        if (code === 0) break;
        result += String.fromCharCode(code);
    }
    return result;
}

function readRationalArray(dataView, offset, count, littleEndian) {
    const values = [];
    for (let i = 0; i < count; i += 1) {
        const numerator = dataView.getUint32(offset + (8 * i), littleEndian);
        const denominator = dataView.getUint32(offset + (8 * i) + 4, littleEndian);
        if (denominator === 0) {
            values.push(null);
        } else {
            values.push(numerator / denominator);
        }
    }
    return values;
}

function convertDmsToDecimal(values, ref) {
    if (!Array.isArray(values) || values.length < 3) {
        return null;
    }
    const [degrees, minutes, seconds] = values;
    if (![degrees, minutes, seconds].every(value => typeof value === 'number' && Number.isFinite(value))) {
        return null;
    }
    const sign = (ref === 'S' || ref === 'W') ? -1 : 1;
    const decimal = degrees + (minutes / 60) + (seconds / 3600);
    if (!Number.isFinite(decimal)) {
        return null;
    }
    return decimal * sign;
}

function readValueOffset(entryOffset, count, type, littleEndian, tiffStart, dataView) {
    const typeSize = TYPE_SIZES[type];
    if (!typeSize) {
        return null;
    }
    const valueSize = typeSize * count;
    if (valueSize <= 4) {
        return entryOffset + 8;
    }
    const rawOffset = dataView.getUint32(entryOffset + 8, littleEndian);
    return tiffStart + rawOffset;
}

function parseGpsIfd(dataView, gpsOffset, tiffStart, littleEndian) {
    const start = tiffStart + gpsOffset;
    if (start + 2 > dataView.byteLength) {
        return null;
    }

    const entryCount = dataView.getUint16(start, littleEndian);
    let latitudeRef = null;
    let latitudeValues = null;
    let longitudeRef = null;
    let longitudeValues = null;
    let altitudeRef = null;
    let altitudeValue = null;
    let timeStampValues = null;
    let dateStamp = null;

    for (let i = 0; i < entryCount; i += 1) {
        const entryOffset = start + 2 + (i * 12);
        if (entryOffset + 12 > dataView.byteLength) {
            break;
        }

        const tag = dataView.getUint16(entryOffset, littleEndian);
        const type = dataView.getUint16(entryOffset + 2, littleEndian);
        const count = dataView.getUint32(entryOffset + 4, littleEndian);
        const valueOffset = readValueOffset(entryOffset, count, type, littleEndian, tiffStart, dataView);

        if (valueOffset === null || valueOffset < 0 || valueOffset > dataView.byteLength) {
            continue;
        }

        switch (tag) {
            case GPS_TAGS.LATITUDE_REF:
                latitudeRef = readAscii(dataView, valueOffset, Math.max(1, count));
                break;
            case GPS_TAGS.LATITUDE:
                if (type === 5 && count >= 3) {
                    latitudeValues = readRationalArray(dataView, valueOffset, 3, littleEndian);
                }
                break;
            case GPS_TAGS.LONGITUDE_REF:
                longitudeRef = readAscii(dataView, valueOffset, Math.max(1, count));
                break;
            case GPS_TAGS.LONGITUDE:
                if (type === 5 && count >= 3) {
                    longitudeValues = readRationalArray(dataView, valueOffset, 3, littleEndian);
                }
                break;
            case GPS_TAGS.ALTITUDE_REF:
                altitudeRef = dataView.getUint8(valueOffset);
                break;
            case GPS_TAGS.ALTITUDE:
                if (type === 5 && count >= 1) {
                    const [altitudeNumerator] = readRationalArray(dataView, valueOffset, 1, littleEndian);
                    altitudeValue = altitudeNumerator ?? null;
                }
                break;
            case GPS_TAGS.TIMESTAMP:
                if (type === 5 && count >= 3) {
                    timeStampValues = readRationalArray(dataView, valueOffset, 3, littleEndian);
                }
                break;
            case GPS_TAGS.DATESTAMP:
                dateStamp = readAscii(dataView, valueOffset, count);
                break;
            default:
                break;
        }
    }

    const latitude = convertDmsToDecimal(latitudeValues, latitudeRef);
    const longitude = convertDmsToDecimal(longitudeValues, longitudeRef);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return null;
    }

    let altitude = null;
    if (typeof altitudeValue === 'number' && Number.isFinite(altitudeValue)) {
        altitude = altitudeValue;
        if (altitudeRef === 1) {
            altitude = -altitude;
        }
    }

    let timestampIso = null;
    if (typeof dateStamp === 'string' && Array.isArray(timeStampValues)) {
        const dateParts = dateStamp.split(':').map(part => parseInt(part, 10));
        if (dateParts.length === 3 && dateParts.every(part => Number.isFinite(part))) {
            const [year, month, day] = dateParts;
            const [hoursRaw, minutesRaw, secondsRaw] = timeStampValues;
            if ([hoursRaw, minutesRaw, secondsRaw].every(value => typeof value === 'number' && Number.isFinite(value))) {
                const hours = Math.floor(hoursRaw);
                const minutes = Math.floor(minutesRaw);
                const secondsWhole = Math.floor(secondsRaw);
                const secondsFraction = secondsRaw - secondsWhole;
                const milliseconds = Math.round(secondsFraction * 1000);

                const date = new Date(Date.UTC(
                    year,
                    Math.max(0, month - 1),
                    day,
                    hours,
                    minutes,
                    secondsWhole,
                    milliseconds
                ));

                if (!Number.isNaN(date.getTime())) {
                    timestampIso = date.toISOString();
                }
            }
        }
    }

    return {
        status: 'ok',
        timestamp: timestampIso || Date.now(),
        coords: {
            latitude,
            longitude,
            accuracy: null,
            altitude: altitude ?? null,
            altitudeAccuracy: null,
            heading: null,
            speed: null
        },
        source: 'exif'
    };
}

function parseExifGps(dataView, start, length) {
    if (length < 6) {
        return null;
    }
    const identifier = readAscii(dataView, start, 6);
    if (identifier !== 'Exif\u0000\u0000') {
        return null;
    }

    const tiffStart = start + 6;
    if (tiffStart + 8 > dataView.byteLength) {
        return null;
    }

    const byteOrderMarker = dataView.getUint16(tiffStart, false);
    let littleEndian;
    if (byteOrderMarker === 0x4949) {
        littleEndian = true;
    } else if (byteOrderMarker === 0x4d4d) {
        littleEndian = false;
    } else {
        return null;
    }

    const magic = dataView.getUint16(tiffStart + 2, littleEndian);
    if (magic !== 0x002a) {
        return null;
    }

    const ifdOffset = dataView.getUint32(tiffStart + 4, littleEndian);
    const firstIfdPointer = tiffStart + ifdOffset;
    if (firstIfdPointer + 2 > dataView.byteLength) {
        return null;
    }

    const entryCount = dataView.getUint16(firstIfdPointer, littleEndian);
    for (let i = 0; i < entryCount; i += 1) {
        const entryOffset = firstIfdPointer + 2 + (i * 12);
        if (entryOffset + 12 > dataView.byteLength) {
            break;
        }
        const tag = dataView.getUint16(entryOffset, littleEndian);
        if (tag === TIFF_TAG_GPS_POINTER) {
            const type = dataView.getUint16(entryOffset + 2, littleEndian);
            const count = dataView.getUint32(entryOffset + 4, littleEndian);
            if (type !== 4 || count !== 1) {
                continue;
            }
            const gpsOffset = dataView.getUint32(entryOffset + 8, littleEndian);
            return parseGpsIfd(dataView, gpsOffset, tiffStart, littleEndian);
        }
    }

    return null;
}

export function extractGpsLocationFromDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') {
        return null;
    }

    const headerEnd = dataUrl.indexOf(',');
    if (headerEnd === -1) {
        return null;
    }

    const mimeSegment = dataUrl.slice(0, headerEnd).toLowerCase();
    if (!mimeSegment.includes('image/jpeg') && !mimeSegment.includes('image/jpg')) {
        return null;
    }

    const base64 = dataUrl.slice(headerEnd + 1);
    let binary;
    try {
        binary = atob(base64);
    } catch (error) {
        console.warn('EXIF GPS extraction failed: unable to decode base64.', error);
        return null;
    }

    const buffer = binaryStringToArrayBuffer(binary);
    const dataView = new DataView(buffer);

    if (dataView.byteLength < 4 || dataView.getUint16(0, false) !== JPEG_SOI) {
        return null;
    }

    let offset = 2;
    while (offset + 4 <= dataView.byteLength) {
        if (dataView.getUint8(offset) !== 0xff) {
            break;
        }
        const marker = dataView.getUint8(offset + 1);
        offset += 2;

        if (marker === 0xda || marker === 0xd9) {
            break; // Start of Scan or End of Image
        }

        if (offset + 2 > dataView.byteLength) {
            break;
        }
        const segmentLength = dataView.getUint16(offset, false);
        if (segmentLength < 2) {
            break;
        }

        if (marker === 0xe1) {
            return parseExifGps(dataView, offset + 2, segmentLength - 2);
        }

        offset += segmentLength;
    }

    return null;
}

