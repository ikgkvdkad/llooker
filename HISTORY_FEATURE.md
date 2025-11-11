# History Navigation Feature

## Overview
Added navigation buttons (< and >) to browse through previously saved descriptions with timestamps and geolocation data.

## What Was Implemented

### ✅ Backend (Netlify Functions)

#### 1. **`get-descriptions.js`** - NEW
- Retrieves descriptions from PostgreSQL database
- Supports filtering by role (you/me) and status
- Returns paginated results with metadata
- Includes timestamp, location, image data, and description text

### ✅ Frontend

#### 2. **UI Updates** (`index.html`)
- Added `<` (previous) button before camera/upload buttons
- Added `>` (next) button after camera/upload buttons
- Buttons for both "You" and "Me" sides
- Buttons are disabled by default until history is loaded

#### 3. **Styles** (`css/styles.css`)
- Added `.history-nav-button` styles
- Disabled state styling (opacity 0.3)
- Hover and active states
- Size: 40x40px with 20px font size

#### 4. **DOM References** (`js/dom.js`)
- Added button references:
  - `youPrevButton`, `youNextButton`
  - `mePrevButton`, `meNextButton`

#### 5. **State Management** (`js/state.js`)
- Added `historyState` object for tracking:
  - Loaded descriptions array
  - Current index (-1 = live view, 0+ = history)
  - Loading state
  - Total count

#### 6. **History Module** (`js/history.js`) - NEW
- **`fetchDescriptions(side, options)`** - Fetches from database
- **`navigatePrevious(side)`** - Go to older description
- **`navigateNext(side)`** - Go to newer description (or back to live)
- **`displayHistoryItem(side)`** - Shows photo + description with metadata
- **`formatTimestamp(timestamp)`** - Displays relative time ("5 min ago", "Yesterday")
- **`formatLocation(location)`** - Formats coordinates with accuracy
- **`addToHistory(side, description)`** - Adds new description to cache
- **`initHistoryNavigation()`** - Wires up button event listeners
- **`updateNavigationButtons(side)`** - Enables/disables buttons based on state

#### 7. **Description API** (`js/description-api.js`)
- Imports `addToHistory`
- Calls `addToHistory()` after successful description API response
- Passes description, timestamp, location, and image data

#### 8. **Main Initialization** (`js/main.js`)
- Imports and calls `initHistoryNavigation()` on app startup

## Features

### Time Display
- **Just now** - Less than 1 minute ago
- **X min ago** - Less than 1 hour
- **X hours ago** - Less than 24 hours
- **Yesterday** - 1 day ago
- **X days ago** - Less than 7 days
- **Full date** - Older than 7 days (e.g., "Nov 11, 2025 2:34 PM")

### Location Display
- Shows coordinates with accuracy: `40.712776, -74.005974 (±12m)`
- Handles missing/unavailable location gracefully
- Shows error message if geolocation failed

### Navigation Behavior
- **Previous (<)**: Navigate to older description
  - Disabled when at oldest item
  - Loads history from database on first use
- **Next (>)**: Navigate to newer description
  - Returns to "live view" when reaching the latest
  - Disabled when already at live view
- **History Indicator**: Shows `[History: 2 of 15]` in status text

### Data Storage
Every successful description saves to PostgreSQL:
- ✅ Description text
- ✅ Timestamp (`capturedAt` and `createdAt`)
- ✅ Geolocation (coordinates, accuracy, altitude, heading, speed)
- ✅ Image data (base64 data URL)
- ✅ Role (you/me)
- ✅ Status (ok/unclear)
- ✅ Viewport metadata
- ✅ OpenAI request ID

## Usage

1. Capture photos and get descriptions as normal
2. Click **<** to view previous descriptions (older)
3. Click **>** to view next descriptions (newer)
4. When at newest, **>** returns you to live camera view
5. Status shows timestamp, location (if available), and history position

## Database Schema

Table: `portrait_descriptions`
- `id` - Auto-increment primary key
- `created_at` - When saved to DB
- `captured_at` - When photo was taken
- `role` - 'you' or 'me'
- `status` - 'ok' or 'unclear'
- `description` - AI-generated description text
- `image_data_url` - Base64 encoded image
- `location` - JSONB with coordinates and metadata
- `viewport` - JSONB with zoom/transform state
- `openai_request_id` - OpenAI request tracking
- `model` - AI model used (gpt-4o-mini)
- Additional metadata fields

## API Endpoints

### GET `/.netlify/functions/get-descriptions`
Query parameters:
- `role` - Filter by 'you' or 'me' (optional)
- `status` - Filter by status (default: 'ok')
- `limit` - Max results (default: 50)
- `offset` - Pagination offset (default: 0)

Response:
```json
{
  "descriptions": [
    {
      "id": 123,
      "createdAt": "2025-11-11T14:30:00Z",
      "capturedAt": "2025-11-11T14:29:45Z",
      "role": "you",
      "status": "ok",
      "description": "Basics: ...",
      "imageDataUrl": "data:image/png;base64,...",
      "location": {
        "status": "ok",
        "coordinates": { "latitude": 40.7128, "longitude": -74.0060 },
        "accuracy": 12
      }
    }
  ],
  "pagination": {
    "total": 150,
    "limit": 50,
    "offset": 0,
    "hasMore": true
  }
}
```

## Next Steps / Deployment

1. **Commit all changes**:
   ```bash
   git add .
   git commit -m "Add history navigation with timestamps and geolocation"
   git push
   ```

2. **Wait for Netlify deploy** - Functions will be automatically deployed

3. **Test the feature**:
   - Capture a few photos
   - Click < and > buttons
   - Verify timestamps and locations display correctly
   - Check that history persists across page reloads

## Notes

- History is fetched on-demand (when first clicking < button)
- History is cached in memory during session
- Fresh descriptions are automatically added to the front of history
- Location data only available for camera photos (not uploads without EXIF GPS)

