# Cutie Cam

Android app that hides your face behind a cute cartoon girl while you record vlog videos.
The girl copies your blinks, talking, smiles and head tilts live. Includes a tunable funny voice.
Videos are saved as vertical 9:16 MP4 (ready for Instagram Reels) to Gallery › Movies › CutieCam.

## Build the APK (Android Studio)

1. Android Studio › **Open** › select this `CutieCam` folder. Wait for "Gradle sync" to finish.
   If Studio offers to upgrade the Android Gradle Plugin, accepting is fine.
2. Menu **Build › Build App Bundle(s) / APK(s) › Build APK(s)**.
   The first build downloads the face tracker (about 25 MB) into
   `app/src/main/assets/www/mediapipe/`. This needs internet once; the app itself works offline.
3. Click **locate** in the popup. The file is `app/build/outputs/apk/debug/app-debug.apk`.

## Install on her phone

- Send `app-debug.apk` to the phone (USB cable, Google Drive, or WhatsApp to herself as a *document*).
- Tap it. Android asks to allow "Install unknown apps" for that app once; allow it, then Install.
- Or with the phone plugged in and USB debugging on: press the green ▶ Run button in Android Studio.

Needs Android 10 or newer. For MP4 recording, keep **Android System WebView** updated from the Play Store.

## Using it

- **Start camera**, allow Camera and Microphone.
- **AI cartoon** (default): an AI model (AnimeGANv2 "face paint", runs on the phone) redraws her face
  as a cartoon of herself. **HD on**: after recording, the clip is redrawn in high quality
  (takes a few minutes; the plain clip only lives in memory and is deleted). **HD off**: saved right away.
- **Toon face**: her real face is painted over as a cartoon that follows her exact face shape:
  big anime eyes on her eyes, a mouth drawn from her lips, brows on her brows, skin matched to her tone.
  The whole picture gets a cartoon filter so everything blends.
- **Girl mask**: the chibi girl head placed over the face instead.
- **Show my room**: real background, face covered. If the face is lost, the whole picture blurs.
- **Hide everything**: no camera picture at all, the girl in a pastel scene.
- **Mic button**: voice presets (Normal, Chipmunk, Cartoon, Monster, Robot, Echo) and sliders for
  Pitch, Robot, Echo and Real voice mix. "Test voice" records 4 seconds and plays it back.
  "Hear myself live" needs earphones.
- **Red button**: record. Tap again to stop, then **Save to Gallery** or **Share to Instagram**.
- **Camera button (top right)**: back camera for scenery (no face filter on the back camera).

## Where things are

| File | What it does |
| --- | --- |
| `app/src/main/assets/www/facepaint.js` | AI face-paint model in TensorFlow.js |
| `app/src/main/assets/www/aicartoon.js` | Head crop, AI cartoon, blending back into the frame |
| `app/src/main/assets/www/hd.js` | HD conversion after recording (WebCodecs + mp4box + mp4-muxer) |
| `app/src/main/assets/www/toonface.js` | Toon face painted onto the face mesh |
| `app/src/main/assets/www/toon.js` | Cartoon (cel-shading) filter for the camera picture, WebGL |
| `app/src/main/assets/www/girl.js` | Draws the chibi girl (colours are in `LOOK` at the top) |
| `app/src/main/assets/www/app.js` | Camera, face tracking, blur safety, recording, saving |
| `app/src/main/assets/www/voice.js` | Voice presets and the audio chain |
| `app/src/main/assets/www/voice-worklet.js` | Pitch shift and robot effect |
| `app/src/main/java/.../MainActivity.java` | Android shell: permissions, Gallery saving, sharing |

Tip: to try changes quickly on a computer, run `python -m http.server` inside `app/src/main/assets/www`
(after one Android build, so the `mediapipe` folder exists) and open `http://localhost:8000` in Chrome.

## Credits

- AI cartoon model: AnimeGANv2 face paint v2 from [bryandlee/animegan2-pytorch](https://github.com/bryandlee/animegan2-pytorch)
  (personal use). Regenerate with the "Prepare AI model" workflow.
- TensorFlow.js (Apache-2.0), mp4box.js (BSD-3), mp4-muxer (MIT), MediaPipe (Apache-2.0).
