/**
 * Capacitor configuration — wraps the deployed Vercel app in a native Android/iOS shell.
 *
 * The app loads `https://swaya-attendance.vercel.app` in its WebView instead of a
 * bundled static export. This keeps the web and mobile clients in lockstep — every
 * Vercel deploy is immediately visible to the app users with no App Store update.
 *
 * Background location is provided by @capacitor-community/background-geolocation,
 * which uses an Android foreground service so the OS keeps the tracker alive
 * even when the app is closed.
 */
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.swaya.attendance',
  appName: 'Swaya Attendance',
  // A placeholder web root, NOT the app. Because `server.url` below points the
  // WebView at the deployed site, nothing in webDir is ever loaded — but
  // Capacitor still requires the directory to exist and `cap sync` copies all of
  // it into the APK. Pointing this at '.next' bundled the entire Next.js build
  // directory, and .next/cache alone accounted for 110 MB of a 117 MB APK.
  webDir: 'native-shell',
  // Load the live Vercel deployment instead of bundled static files.
  server: {
    url: 'https://swaya-attendence-f59x.vercel.app',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    // Background location is requested at runtime; static permissions live in
    // AndroidManifest.xml (see android/app/src/main/AndroidManifest.xml).
    backgroundColor: '#ffffff',
  },
};

export default config;
