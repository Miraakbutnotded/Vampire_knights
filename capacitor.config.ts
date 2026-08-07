import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.stimilon.vampireknights',
  appName: 'Vampire Knights',
  webDir: 'dist',
  // Matches the body background in src/ui/style.css so the letterbox and any
  // pre-paint flash are the same black as the game's own frame.
  backgroundColor: '#05060a',
  // Forward the page's console into the native log. Without it a device
  // failure is a black box: the WebView has no inspector attached in the
  // field, and this session lost half a day to exactly that silence.
  loggingBehavior: 'debug',
  ios: {
    // The canvas letterboxes itself; WKWebView must never add its own insets.
    contentInset: 'never',
  },
};

export default config;
