# History Navigation Feature

## Overview
Added navigation buttons (< and >) to browse through previously saved AI analyses with timestamps, geolocation metadata, and discriminators.

## What Was Implemented

### ✅ Backend (Netlify Functions)

#### 1. **`get-analyses.js`** - NEW
- Retrieves structured analyses from PostgreSQL
- Supports filtering by role (you/me) and status
- Returns paginated results with metadata and discriminators
- Includes timestamp, location, and cropped viewport imagery

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
  - Loaded analyses array
  - Current index (-1 = live view, 0+ = history)
  - Loading state
  - Total count

#### 6. **History Module** (`js/history.js`)
- **`fetchAnalyses(side, options)`** - Fetches from database
- **`navigatePrevious(side)`** - Go to older analysis
- **`navigateNext(side)`** - Go to newer analysis (or back to live)
- **`displayHistoryItem(side)`** - Shows cropped photo + formatted analysis summary
- **`formatTimestamp(timestamp)`** - Displays relative time ("5 min ago", "Yesterday")
- **`formatLocation(location)`** - Formats coordinates with accuracy
- **`addToHistory(side, analysisRecord)`** - Adds new analysis to cache
- **`initHistoryNavigation()`** - Wires up button event listeners
- **`updateNavigationButtons(side)`** - Enables/disables buttons based on state

#### 7. **Analysis API** (`js/analysis-api.js`)
- Imports `addToHistory`
- Calls `addToHistory()` after successful analysis response
- Passes analysis JSON, discriminators, timestamps, location, and image data

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
- **Previous (<)**: Navigate to older analysis
  - Disabled when at oldest item
  - Loads history from database on first use
- **Next (>)**: Navigate to newer analysis
  - Returns to "live view" when reaching the latest
  - Disabled when already at live view
- **History Indicator**: Shows `[History: 2 of 15]` in status text

### Data Storage
Every successful analysis saves to PostgreSQL:
- ✅ Structured analysis JSON (subject, clothing, accessories, environment, tags)
- ✅ Discriminators (hair/face/top/bottom/footwear/accessories/carried)
- ✅ Timestamp (`capturedAt` and `createdAt`)
- ✅ Geolocation (coordinates, accuracy, altitude, heading, speed)
- ✅ Image data (base64 data URL)
- ✅ Role (you/me)
- ✅ Status (ok/unclear/error)
- ✅ Viewport metadata and request diagnostics
- ✅ OpenAI request ID & model

## Usage

1. Capture photos and request an analysis.
2. Click **<** to view previous analyses (older).
3. Click **>** to view newer analyses.
4. When at the newest record, **>** returns you to live camera view.
5. Status shows timestamp, location (if available), and history position.

## Database Schema

Table: `portrait_analyses`
- `id` - Auto-increment primary key
- `created_at` - When saved to DB
- `captured_at` - When photo was taken
- `role` - 'you' or 'me'
- `status` - 'ok', 'unclear', or 'error'
- `analysis` - AI-generated structured metadata (JSONB)
- `discriminators` - Key-value map for quick filtering (JSONB)
- `image_data_url` - Base64 encoded image
- `location` - JSONB with coordinates and metadata
- `viewport` - JSONB with zoom/transform state
- `openai_request_id` - OpenAI request tracking
- `model` - AI model used (gpt-4o-mini)
- `request_meta` - Additional diagnostics

## API Endpoints

### GET `/.netlify/functions/get-analyses`
Query parameters:
- `role` - Filter by 'you' or 'me' (optional)
- `status` - Filter by status (default: 'ok')
- `limit` - Max results (default: 50)
- `offset` - Pagination offset (default: 0)

Response:
```json
{
  "analyses": [
    {
      "id": 123,
      "createdAt": "2025-11-11T14:30:00Z",
      "capturedAt": "2025-11-11T14:29:45Z",
      "role": "you",
      "status": "ok",
      "analysis": { "subject": { "gender": "female", "ageRange": "25-30" } },
      "discriminators": { "hair": "long-brown", "top": "navy-blazer+white-shirt" },
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

## Notes

- History is fetched on-demand (when first clicking the `<` button).
- History is cached in memory during the session.
- Fresh analyses are automatically added to the front of history.
- Location data is only available when geolocation succeeds during capture.
- Analyses use cropped viewport images, ensuring the displayed content matches what was evaluated.

