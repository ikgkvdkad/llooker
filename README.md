# Camera Photo Capture

A web application that allows users to capture photos and get AI-powered descriptions using OpenAI's GPT-4o-mini vision model.

## Features

- Dual camera interface (back and front camera)
- Photo capture from live video stream
- Image upload support
- AI-powered person descriptions (non-identifying)
- Selection box for targeting specific subjects
- Pan, zoom, and pinch-to-zoom controls
- Modern, responsive UI

## Project Structure

The project has been refactored into a modular architecture:

```
llooker/
├── index.html              # Main HTML (clean, ~70 lines)
├── css/
│   └── styles.css          # All application styles
├── js/
│   ├── config.js           # Configuration constants
│   ├── dom.js              # DOM element references
│   ├── state.js            # Application state management
│   ├── utils.js            # Utility functions
│   ├── photo.js            # Photo capture & display
│   ├── selection.js        # Selection box interactions
│   ├── camera.js           # Camera lifecycle (⚠️ incomplete)
│   ├── zoom.js             # Zoom & transform (⚠️ incomplete)
│   ├── interactions.js     # Touch/pointer handlers (⚠️ incomplete)
│   ├── description-api.js  # AI API communication (⚠️ incomplete)
│   ├── upload.js           # File upload handling
│   ├── ui.js               # UI helpers
│   └── main.js             # Application initialization
├── netlify/
│   └── functions/
│       └── describe.js     # Serverless AI description function
├── netlify.toml
├── vercel.json
├── mephoto.jpg             # Sample image
├── youphoto.jpg            # Sample image
└── index.html.backup       # Original monolithic file (backup)
```

## ✅ Status: Fully Refactored and Functional

The application has been successfully refactored from a monolithic 2,984-line HTML file into a clean modular architecture. All functionality has been extracted and is now fully operational:

- ✅ `js/camera.js` - Complete camera lifecycle management
- ✅ `js/zoom.js` - Full zoom/transform implementation
- ✅ `js/interactions.js` - All pointer/touch event handlers
- ✅ `js/description-api.js` - Complete AI API integration
- ✅ `js/upload.js` - Full file upload and resubmit handling
- ✅ All other modules complete and functional

The original code is preserved in `index.html.backup` for reference.

## Serverless Vision Description

The Netlify function at `netlify/functions/describe.js` sends captured images to OpenAI's `gpt-4o-mini` vision model and returns detailed, non-identifying descriptions focusing on:

- Basic physical attributes (age range, build, posture, skin tone, hairstyle)
- Clothing & style details (layers, colors, textures, accessories)
- Additional context (lighting, mood, distinctive features)

### Environment Variables

- `OPENAI_API_KEY`: OpenAI API key with access to `gpt-4o-mini`
  - Set in Netlify: Site settings → Environment variables
  - Or in your local testing environment

If the key is missing, the function returns a 500 error.

### Firestore Configuration

The `describe` Netlify function persists successful descriptions to Firestore. Provide credentials in **one** of the following ways:

1. **Environment variables** (preferred for production)
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY` (use literal `\n` sequences; they are normalized by the function)
2. **Service account file** (convenient for local development)
   - Create `netlify/firebase-service-account.json` containing the standard Firebase Admin SDK key.
   - The repository includes a placeholder file for this controlled exercise. Replace it with your own credentials and **never commit real secrets**.

Set `FIREBASE_DESCRIPTIONS_COLLECTION` to override the storage collection; the default is `portraitDescriptions`.

If neither the environment variables nor the JSON file is present, the function logs a clear error and returns a 500 response.

## Deployment

This is a static HTML application backed by a Netlify function.

### Quick Deploy Options

#### 1. Netlify (Recommended)
- Connect the repository to Netlify for automated builds
- Set the `OPENAI_API_KEY` environment variable
- Deploy

#### 2. Vercel
```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel
```

#### 3. GitHub Pages
1. Push this repository to GitHub
2. Go to Settings → Pages
3. Select the branch and deploy

**Note:** GitHub Pages won't support the serverless function. You'll need to deploy the function separately.

#### 4. Any Static Host
- Upload all files to any web server
- Ensure HTTPS is enabled (required for camera access)
- The serverless function will need separate hosting

## Local Testing

For local testing, you can use a simple HTTP server:

```bash
# Python 3
python -m http.server 8000

# Node.js (http-server)
npx http-server

# PHP
php -S localhost:8000
```

Then open `http://localhost:8000` in your browser. Camera access works on `localhost` even without HTTPS.

**Note:** The AI description feature requires the Netlify function to be running. For local testing of that feature, use:

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Run local dev server
netlify dev
```

## Browser Compatibility

- Chrome / Edge (recommended)
- Firefox
- Safari
- Opera

Any modern browser with MediaDevices API support will work.

## Requirements

- HTTPS connection (required for camera access, except localhost)
- User must grant camera permissions
- A working camera device
- OpenAI API key (for description feature)

## Development

This project uses ES6 modules with no build step required. Modern browsers natively support ES module imports.

To complete the refactoring, extract the remaining functionality from `index.html.backup` into the placeholder modules. Each incomplete module has TODO comments with specific line number references.

## License

See the original repository for license information.
